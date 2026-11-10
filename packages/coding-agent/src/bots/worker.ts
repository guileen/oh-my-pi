import * as path from "node:path";
import { addDecimalCost, logger, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { daemonClientForProject } from "../launch/client";
import {
	createBotRuntime,
	type BotContinuation,
	type BotRuntime,
	type BotRuntimeCallbacks,
	type BotRuntimeEvent,
} from "./agent-runtime";
import { normalizeBotReply } from "./input";
import { BOT_ID_ENV, BOT_ROOT_ENV } from "./protocol";
import { BotStore } from "./store";
import {
	BotError,
	type BotActivation,
	type BotCommand,
	type BotFailure,
	type BotJob,
	type JobProjection,
	type QueuedInput,
	type Receipt,
	type StoredRequest,
} from "./types";

interface RuntimeFactory {
	(
		job: BotJob,
		callbacks: BotRuntimeCallbacks,
		options?: { session_dir?: string; owner_epoch?: string; session_owner_id?: string | null },
	): Promise<BotRuntime>;
}
interface JobOwner {
	job_id: string;
	runtime?: BotRuntime;
	activation?: Promise<void>;
	initializing?: Promise<BotRuntime>;
	activation_ref: string | null;
	continuations: Array<{
		continuation: BotContinuation;
		activation: BotActivation;
		resolve(): void;
		reject(error: unknown): void;
		signal?: AbortSignal;
	}>;
	continuationPermits: Map<string, Promise<void>>;
	execution_id: string | null;
	request_id: string | null;
	started_at: number;
	sampled_at: number;
	blocked: boolean;
	execution_failed: boolean;
	spans: Map<string, { started_at: string; parent_span_id: string | null; kind: string; label: string }>;
	outputs: Map<
		string,
		{ text: string; final: boolean; revision: number; emitted_revision: number; emitted_at: number }
	>;
}

function failure(error: unknown, code = "internal_error"): BotFailure {
	return error instanceof BotError
		? { code: error.code, message: error.message, retryable: error.retryable, details: error.details }
		: { code, message: error instanceof Error ? error.message : String(error), retryable: false };
}

/** A single process owns each Bot. SQLite is the durable mailbox, not an in-memory RPC queue. */
export class BotWorker {
	readonly #store: BotStore;
	readonly #botId: string;
	readonly #factory: RuntimeFactory;
	readonly #scoped: boolean;
	#jobId: string | undefined;
	readonly #owners = new Map<string, JobOwner>();
	readonly #ownerId = crypto.randomUUID();
	#closed = false;
	#claimed = false;
	#ownerEpoch = "0";
	#lastHeartbeat = 0;
	#heartbeatTimer: NodeJS.Timeout | undefined;
	#leaseLost = false;
	#closeRetry: NodeJS.Timeout | undefined;
	#closing: Promise<void> | undefined;

	constructor(
		store: BotStore,
		botId: string,
		factory: RuntimeFactory = createBotRuntime,
		options?: { scoped?: boolean },
	) {
		this.#store = store;
		this.#botId = botId;
		this.#factory = factory;
		this.#scoped = options?.scoped === true;
	}

	#jobs(): BotJob[] {
		if (!this.#scoped)
			return this.#store.jobs(this.#botId).filter(job => !this.#store.isGraphHosted(this.#botId, job.job_id));
		return this.#jobId === undefined ? [] : [this.#store.getJob(this.#botId, this.#jobId)];
	}

	/** Admit a hosted submit while this scoped worker holds the Bot lease. */
	admitGraph(command: BotCommand): Receipt {
		if (!this.#scoped || !this.#claimed || this.#closed || this.#jobId !== undefined || this.#leaseLost)
			throw new BotError("invalid_state", "Worker cannot admit a Graph Job");
		return this.#store.admitGraph(this.#botId, command, this.#ownerId, this.#ownerEpoch);
	}

	/** Admit a control only for the exact hosted Job bound to this lease. */
	admitGraphControl(command: BotCommand): Receipt {
		if (!this.#scoped || !this.#claimed || this.#closed || !this.#jobId || this.#leaseLost)
			throw new BotError("invalid_state", "Worker has no bound Graph Job");
		return this.#store.admitGraphControl(this.#botId, this.#jobId, command, this.#ownerId, this.#ownerEpoch);
	}

	hasLease(): boolean {
		return this.#claimed && !this.#closed && !this.#leaseLost && this.#hasLease();
	}

	/** Bind only after claiming the Bot lease, before admitting work to an execution loop. */
	bindJob(jobId: string): void {
		if (!this.#scoped || !this.#claimed || this.#closed || this.#jobId !== undefined || this.#leaseLost)
			throw new BotError("invalid_state", "Worker cannot bind a Job");
		this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
		const job = this.#store.getJob(this.#botId, jobId);
		if (!this.#store.isGraphHosted(this.#botId, jobId))
			throw new BotError("invalid_state", "Job is not Graph-hosted");
		this.#jobId = jobId;
		this.#recover(job);
	}

	/** Retry cleanup without dispatching queued work or finalizing the receipt on uncertainty. */
	async recoverGraphJob(requestId: string, assertHost: () => void): Promise<void> {
		if (!this.#scoped || !this.#claimed || this.#closed || !this.#jobId || this.#leaseLost)
			throw new BotError("invalid_state", "Worker has no bound Graph Job");
		this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
		const job = this.#store.getJob(this.#botId, this.#jobId);
		if (job.ownership.state !== "uncertain" && job.ownership.state !== "none")
			throw new BotError("invalid_state", "Graph recovery requires inactive or uncertain ownership");
		await this.#cleanupHosted(job, assertHost);
		assertHost();
		this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
		this.#store.finishCancellation(this.#botId, this.#jobId, requestId, this.#ownerId, this.#ownerEpoch, "stop");
	}

	#recover(job: BotJob): void {
		if (job.ownership.state === "none" && !["running", "waiting_input"].includes(job.state)) return;
		if (job.ownership.state !== "uncertain")
			this.#store.interruptOwnership(this.#botId, job.job_id, {
				code: "worker_lost",
				message: "Prior execution ended without confirmed cleanup; resume explicitly",
				retryable: false,
			});
		if (job.ownership.activation_ref) {
			const claim = this.#store.activation(job.ownership.activation_ref);
			if (claim.request_id && this.#store.request(this.#botId, claim.request_id).outcome === "pending")
				this.#store.finishRequest(this.#botId, claim.request_id, "rejected", {
					code: "worker_lost",
					message: "Claimed operation lost its runtime owner",
					retryable: false,
				});
		}
	}

	/** Reconcile crashed hosted work without constructing a model or an AgentSession. */
	async #cleanupHosted(job: BotJob, assertHost?: () => void): Promise<void> {
		assertHost?.();
		const services = job.owned_services ?? [];
		const unresolved = job.launch_intents.filter(intent => !intent.disposition?.final);
		if (!job.session_owner_id) {
			if (services.length || unresolved.length || job.pending_background_count || job.pending_delivery_count)
				throw new BotError("cleanup_failed", "Prior Bot work has no recoverable owner");
			return;
		}
		let uncertain = !!job.pending_delivery_count;
		if (!job.owner_epoch || !/^(0|[1-9]\d*)$/.test(job.owner_epoch))
			throw new BotError("cleanup_failed", "Prior Bot owner epoch is unavailable");
		const throughEpoch = job.owner_epoch;
		const client = await daemonClientForProject(job.cwd);
		this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
		assertHost?.();
		try {
			const fence = await client.request({
				op: "fence_owner",
				session_owner_id: job.session_owner_id,
				through_epoch: throughEpoch,
			});
			this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
			if (fence.op !== "fence_owner" || BigInt(fence.fenced_through_epoch) < BigInt(throughEpoch)) uncertain = true;
		} catch {
			this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
			assertHost?.();
			uncertain = true;
		}
		for (const intent of unresolved) {
			assertHost?.();
			if (
				intent.session_owner_id !== job.session_owner_id ||
				!/^(0|[1-9]\d*)$/.test(intent.owner_epoch) ||
				BigInt(intent.owner_epoch) > BigInt(throughEpoch)
			) {
				uncertain = true;
				continue;
			}
			try {
				const result = await client.request({
					op: "reconcile_launch",
					launch_intent_id: intent.launch_intent_id,
					session_owner_id: intent.session_owner_id,
					owner_epoch: intent.owner_epoch,
					mode: "cancel",
				});
				this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
				if (result.op !== "reconcile_launch" || !result.disposition.final) uncertain = true;
				else {
					assertHost?.();
					this.#store.updateLaunchIntent(this.#botId, job.job_id, intent.launch_intent_id, result.disposition);
				}
			} catch {
				this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
				assertHost?.();
				uncertain = true;
			}
		}
		assertHost?.();
		const listing = await client.request({ op: "list" });
		this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
		if (listing.op !== "list") throw new BotError("cleanup_failed", "Could not establish Bot service state");
		const owned = listing.daemons.filter(daemon => daemon.owner === job.session_owner_id);
		const observed = services.filter(service =>
			owned.some(daemon => daemon.id === service.id && (daemon.startedAt ?? null) === service.started_at),
		).length;
		if (observed !== services.length || job.pending_background_count > observed) uncertain = true;
		for (const daemon of owned) {
			assertHost?.();
			if (daemon.state === "exited" || daemon.state === "failed") continue;
			if (daemon.startedAt == null) {
				uncertain = true;
				continue;
			}
			try {
				const result = await client.request({
					op: "stop_owned",
					name: daemon.name,
					id: daemon.id,
					generation: String(daemon.startedAt),
					session_owner_id: job.session_owner_id,
					through_epoch: throughEpoch,
					timeoutMs: 5_000,
				});
				this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
				if (
					result.op !== "stop_owned" ||
					result.daemon.id !== daemon.id ||
					result.daemon.startedAt !== daemon.startedAt ||
					!["exited", "failed"].includes(result.daemon.state)
				)
					uncertain = true;
			} catch {
				this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
				uncertain = true;
			}
		}
		if (uncertain) throw new BotError("cleanup_failed", "Prior Bot work remains uncertain");
	}

	claim(ownsLock = false): boolean {
		if (!this.#store.claimWorker(this.#botId, this.#ownerId, process.pid, 15_000, ownsLock)) {
			if (this.#scoped) this.#store.requestGraphHandoff(this.#botId);
			return false;
		}
		this.#claimed = true;
		this.#ownerEpoch = this.#store.workerLease(this.#botId)!.owner_epoch;
		if (this.#scoped) this.#store.clearGraphHandoff(this.#botId);
		if (!this.#scoped) for (const job of this.#store.jobs(this.#botId)) this.#recover(job);
		this.#heartbeatTimer = setInterval(() => {
			try {
				this.#leaseLost ||= !this.#store.heartbeatWorker(this.#botId, this.#ownerId);
			} catch (error) {
				this.#leaseLost = true;
				logger.error("Bot worker heartbeat failed", { error: String(error), bot_id: this.#botId });
			}
		}, 3_000);
		return true;
	}

	/** Durable queued requests can wait, but live or uncertain ordinary ownership cannot be preempted. */
	shouldYieldToGraph(): boolean {
		if (
			this.#scoped ||
			!this.#claimed ||
			this.#closed ||
			this.#leaseLost ||
			!this.#store.hasGraphHandoff(this.#botId)
		)
			return false;
		this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
		if (
			this.#jobs().some(
				job =>
					job.ownership.state !== "none" ||
					job.execution_id !== null ||
					job.pending_background_count > 0 ||
					job.pending_delivery_count > 0 ||
					job.state === "waiting_input" ||
					job.phase === "cancelling" ||
					job.launch_intents.some(intent => !intent.disposition?.final),
			)
		)
			return false;
		for (const owner of this.#owners.values()) {
			const state = owner.runtime?.state();
			if (
				owner.initializing ||
				owner.activation ||
				owner.execution_id ||
				owner.continuations.length ||
				state?.is_streaming ||
				state?.waiting_input_count ||
				state?.pending_background_count ||
				state?.pending_delivery_count
			)
				return false;
		}
		return true;
	}

	async tick(): Promise<void> {
		if (this.#closed || !this.#claimed) return;
		if (this.#scoped && this.#jobId === undefined) return;
		if (this.#leaseLost) throw new Error("Bot worker lease was lost");
		this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
		if (Date.now() - this.#lastHeartbeat >= 3_000) {
			if (!this.#store.heartbeatWorker(this.#botId, this.#ownerId)) throw new Error("Bot worker lease was lost");
			this.#lastHeartbeat = Date.now();
			this.#store.publishWorker(this.#botId, this.#ownerId);
		}
		const requests = this.#store
			.pendingRequests(this.#botId)
			.filter(request =>
				this.#scoped
					? request.receipt.job_id === this.#jobId
					: !request.receipt.job_id || !this.#store.isGraphHosted(this.#botId, request.receipt.job_id),
			);
		// Cancellation outranks maintenance and pending conversational input.
		requests.sort((left, right) => this.#priority(left) - this.#priority(right));
		for (const request of requests) {
			if (this.#store.request(this.#botId, request.request_id).outcome !== "pending") continue;
			try {
				await this.#apply(request);
			} catch (error) {
				this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
				this.#store.finishRequest(this.#botId, request.request_id, "rejected", failure(error));
				if (request.receipt.job_id && ["compact", "set-model"].includes(request.command.command)) {
					const job = this.#store.getJob(this.#botId, request.receipt.job_id);
					this.#store.updateJob(this.#botId, job.job_id, {
						model: { ...job.model, pending: null },
						...(job.phase === "compacting" ? { phase: "none", activity: null } : {}),
					});
				}
			}
		}
		for (const owner of this.#owners.values()) {
			this.#flushOutputs(owner);
			this.#refresh(owner);
		}
		this.#grantContinuations();
		if (this.#occupied()) {
			for (const job of this.#jobs()) {
				if (job.state === "queued" && job.wait?.kind !== "capacity") {
					this.#store.updateJob(this.#botId, job.job_id, {
						wait: {
							kind: "capacity",
							message: "Waiting for Bot execution capacity",
							request_id: null,
							retry_at: null,
						},
					});
				}
			}
			return;
		}
		for (const job of this.#jobs()) {
			if (["paused", "stopped", "interrupted", "failed"].includes(job.state)) continue;
			const input = job.state === "waiting_input" ? job.inputs.find(item => item.reply_to) : job.inputs[0];
			if (!input || this.#store.request(this.#botId, input.request_id).outcome !== "applied") continue;
			if (
				!input.reply_to &&
				this.#store
					.pendingRequests(this.#botId)
					.some(
						request =>
							request.receipt.job_id === job.job_id &&
							["compact", "set-model"].includes(request.command.command),
					)
			)
				continue;
			const next = this.#store.claimInput(
				this.#botId,
				job.job_id,
				input.request_id,
				this.#ownerId,
				this.#ownerEpoch,
			);
			if (next) {
				this.#activate(job, next.input, next.activation);
				// Let an already-ready factory dispatch, without waiting for slow initialization.
				await Bun.sleep(0);
				break;
			}
		}
	}

	/** Suspend only the live runtime owned by this worker; the runtime uses the normal continuation gate. */
	waitForGraphConsultation(jobId: string, conversationId: string, messageId: string): Promise<string> {
		const owner = this.#owners.get(jobId);
		if ((this.#scoped && jobId !== this.#jobId) || !owner || !this.#isOwner(owner))
			throw new BotError("invalid_state", "Job runtime is not owned by this worker");
		if (!owner.runtime?.waitForGraphConsultation)
			throw new BotError("invalid_state", "Graph consultation boundary is unavailable");
		return owner.runtime.waitForGraphConsultation(conversationId, messageId);
	}

	#priority(request: StoredRequest): number {
		return request.command.command === "stop" || request.command.command === "interrupt"
			? 0
			: request.command.reply_to
				? 1
				: ["compact", "set-model"].includes(request.command.command)
					? 2
					: 3;
	}

	#occupied(except?: JobOwner): boolean {
		for (const owner of this.#owners.values()) {
			if (owner.blocked) continue;
			if (owner === except) continue;
			if (owner.execution_id) return true;
			if (owner.initializing || (owner.activation && !owner.runtime)) return true;
			const state = owner.runtime?.state();
			if (
				state &&
				(state.pending_background_count > 0 ||
					(state.pending_delivery_count > 0 && owner.continuations.length === 0) ||
					(state.waiting_input_count === 0 &&
						owner.continuations.length === 0 &&
						(owner.activation || state.is_streaming)))
			)
				return true;
		}
		return this.#store.hasUncertainOwnership(this.#botId);
	}
	#hasLease(): boolean {
		try {
			this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
			return true;
		} catch {
			return false;
		}
	}
	#isOwner(owner: JobOwner): boolean {
		if (this.#closed || this.#leaseLost || owner.blocked || this.#owners.get(owner.job_id) !== owner) return false;
		try {
			this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
			return true;
		} catch {
			return false;
		}
	}
	#assertOwner(owner: JobOwner): void {
		if (!this.#isOwner(owner)) throw new BotError("invalid_state", "Runtime ownership has been cancelled or fenced");
		if (this.#store.hasPendingCancellation(this.#botId, owner.job_id))
			throw new BotError("invalid_state", "Cancellation is pending");
	}
	#continuation(owner: JobOwner, continuation: BotContinuation, signal?: AbortSignal): Promise<void> {
		try {
			this.#assertOwner(owner);
			if (signal?.aborted) throw new BotError("invalid_state", "Continuation was cancelled");
			if (continuation.origin === "reply" && owner.execution_id) return Promise.resolve();
			const existingPermit = owner.continuationPermits.get(continuation.continuation_id);
			if (existingPermit) return existingPermit;
			if (
				continuation.input_request_id &&
				continuation.origin !== "background" &&
				continuation.origin !== "reply" &&
				!this.#store.reserveCompletion(
					this.#botId,
					owner.job_id,
					continuation.input_request_id,
					continuation.origin,
				)
			)
				throw new BotError("input_request_closed", "Another completion owns this question");
			const activation = this.#store.claimContinuation(
				this.#botId,
				owner.job_id,
				this.#ownerId,
				this.#ownerEpoch,
				owner.activation_ref,
				continuation.request_id ?? null,
				{ ...continuation, owner_epoch: this.#ownerEpoch, parent_activation_ref: owner.activation_ref },
			);
			this.#store.updateActivation(activation.activation_ref, { stage: "waiting_input" });
			const deferred = Promise.withResolvers<void>();
			owner.continuationPermits.set(continuation.continuation_id, deferred.promise);
			const pending = { continuation, activation, resolve: deferred.resolve, reject: deferred.reject, signal };
			owner.continuations.push(pending);
			if (signal)
				signal.addEventListener(
					"abort",
					() => {
						const index = owner.continuations.indexOf(pending);
						if (index < 0) return;
						owner.continuations.splice(index, 1);
						this.#store.updateActivation(activation.activation_ref, { stage: "closed" });
						deferred.reject(new BotError("invalid_state", "Continuation was cancelled"));
					},
					{ once: true },
				);
			this.#grantContinuations();
			return deferred.promise;
		} catch (error) {
			return Promise.reject(error);
		}
	}
	#grantContinuations(): void {
		for (const owner of this.#owners.values()) {
			if (
				!owner.continuations.length ||
				owner.execution_id ||
				!this.#isOwner(owner) ||
				this.#occupied(owner) ||
				this.#store.hasPendingCancellation(this.#botId, owner.job_id)
			)
				continue;
			const pending = owner.continuations.shift()!;
			if (pending.signal?.aborted) {
				pending.reject(new BotError("invalid_state", "Continuation was cancelled"));
				continue;
			}
			owner.activation_ref = pending.activation.activation_ref;
			owner.request_id = pending.continuation.request_id ?? null;
			this.#startExecution(owner, pending.continuation.origin === "background" ? "background" : "resume");
			pending.resolve();
			return;
		}
	}

	async #apply(request: StoredRequest): Promise<void> {
		const command = request.command;
		if (command.all) {
			const children = this.#store.request(this.#botId, request.request_id).children ?? [];
			if (children.some(child => child.outcome === "pending")) return;
			const rejected = children.filter(child => child.outcome === "rejected");
			this.#store.finishRequest(
				this.#botId,
				request.request_id,
				rejected.length ? "rejected" : "applied",
				rejected.length
					? {
							code: "cleanup_failed",
							message: "Some Jobs could not be stopped",
							retryable: true,
							details: { failed_job_ids: rejected.map(child => child.receipt.job_id) },
						}
					: undefined,
			);
			return;
		}
		const jobId = request.receipt.job_id;
		if (!jobId) throw new BotError("unknown_job", "A Job is required");
		const job = this.#store.getJob(this.#botId, jobId);
		let owner = this.#owners.get(jobId);
		switch (command.command) {
			case "submit":
			case "send":
			case "steer": {
				if (command.reply_to) {
					const question = job.input_requests.find(
						item =>
							item.input_request_id === command.reply_to &&
							(item.status === "open" || item.reply_request_id === request.request_id),
					);
					const liveQuestion = owner?.runtime
						?.state()
						.waiting_input_requests.find(item => item.input_request_id === command.reply_to);
					if (!question || !liveQuestion) {
						if (question)
							this.#store.cancelInputRequest(
								this.#botId,
								jobId,
								command.reply_to,
								"runtime_not_live",
								request.request_id,
							);
						throw new BotError("input_request_closed", "The input request is no longer open");
					}
					normalizeBotReply(liveQuestion, command.input);
				}
				const input: QueuedInput = {
					request_id: request.request_id,
					input: command.input ?? "",
					steer: command.command === "steer",
					reply_to: command.reply_to,
				};
				this.#store.enqueueInput(this.#botId, jobId, input);
				if (["idle", "queued"].includes(job.state))
					this.#store.updateJob(this.#botId, jobId, { state: "queued", phase: "queued", settled: false });
				this.#store.finishRequest(this.#botId, request.request_id, "applied");
				if (
					command.command === "steer" &&
					owner?.runtime &&
					!owner.blocked &&
					owner.runtime.state().is_streaming &&
					!input.reply_to
				) {
					const claim = this.#store.claimInput(
						this.#botId,
						jobId,
						input.request_id,
						this.#ownerId,
						this.#ownerEpoch,
						true,
					);
					if (claim) {
						try {
							await owner.runtime.steer(input.input);
							this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
							this.#store.updateActivation(claim.activation.activation_ref, { stage: "closed" });
						} catch (error) {
							if (this.#hasLease()) this.#store.interruptOwnership(this.#botId, jobId, failure(error));
							throw error;
						}
					}
				}
				return;
			}
			case "stop":
			case "interrupt": {
				for (const pending of this.#store.pendingRequests(this.#botId)) {
					if (pending.receipt.job_id === jobId && ["compact", "set-model"].includes(pending.command.command)) {
						this.#store.finishRequest(this.#botId, pending.request_id, "cancelled");
					}
				}
				this.#store.updateJob(this.#botId, jobId, {
					phase: "cancelling",
					state: "running",
					wait: null,
					settled: false,
					model: { ...job.model, pending: null },
				});
				const recoverHosted =
					this.#scoped && command.command === "stop" && !owner && job.ownership.state === "uncertain";
				if (
					!recoverHosted &&
					!owner &&
					(job.ownership.state !== "none" ||
						job.session_owner_id ||
						job.pending_background_count ||
						job.pending_delivery_count)
				)
					owner = await this.#runtime(job);
				if (owner) {
					this.#yieldExecution(owner, "cancelled");
					owner.blocked = true;
					for (const pending of owner.continuations.splice(0)) {
						this.#store.updateActivation(pending.activation.activation_ref, {
							stage: "closed",
							error: { code: "cancelled", message: "Continuation cancelled", retryable: false },
						});
						pending.reject(new BotError("invalid_state", "Continuation cancelled"));
					}
				}
				try {
					if (recoverHosted) await this.#cleanupHosted(job);
					if (owner?.initializing) await owner.initializing;
					if (command.command === "stop") await owner?.runtime?.stop();
					else await owner?.runtime?.abort();
					await owner?.activation;
					if (owner) owner.activation = undefined;
					if (command.command === "stop" && owner?.runtime) {
						await owner.runtime.dispose();
						this.#owners.delete(jobId);
					}
				} catch (error) {
					if (this.#hasLease())
						this.#store.interruptOwnership(this.#botId, jobId, failure(error, "cleanup_failed"));
					throw new BotError("cleanup_failed", "Owned work did not confirm cleanup", undefined, true);
				}
				this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
				try {
					this.#store.finishCancellation(
						this.#botId,
						jobId,
						request.request_id,
						this.#ownerId,
						this.#ownerEpoch,
						command.command,
					);
				} catch (error) {
					this.#store.interruptOwnership(this.#botId, jobId, failure(error, "cleanup_failed"));
					throw error;
				}
				return;
			}
			case "resume": {
				if (!["paused", "stopped", "interrupted", "failed", "idle"].includes(job.state))
					throw new BotError("invalid_state", "Job is not resumable in its current state");
				if (job.ownership.state === "uncertain" && (owner || job.session_owner_id)) {
					owner ??= await this.#runtime(job);
					try {
						await owner.runtime!.abort();
						await owner.activation;
						owner.activation = undefined;
						this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
						const state = owner.runtime!.state();
						this.#store.updateRuntimeState(
							this.#botId,
							jobId,
							{
								pending_background_count: state.pending_background_count,
								pending_delivery_count: state.pending_delivery_count,
							},
							state.owned_services,
						);
					} catch (error) {
						if (this.#hasLease())
							this.#store.interruptOwnership(this.#botId, jobId, failure(error, "cleanup_failed"));
						throw error;
					}
				}
				const reconciled = this.#store.getJob(this.#botId, jobId);
				if (
					reconciled.pending_background_count > 0 ||
					reconciled.pending_delivery_count > 0 ||
					reconciled.launch_intents.some(intent => !intent.disposition?.final)
				) {
					throw new BotError(
						"cleanup_failed",
						"Lost background ownership must be resolved before this Job can resume",
					);
				}
				if (owner) {
					owner.blocked = false;
					owner.execution_failed = false;
				}
				this.#store.closeInputRequests(this.#botId, jobId, request.request_id);
				this.#store.closeOwnership(this.#botId, jobId);
				// Never repeat an uncertain previous tool; resume only queued user input.
				this.#store.updateJob(this.#botId, jobId, {
					state: this.#store.getJob(this.#botId, jobId).inputs.length ? "queued" : "idle",
					phase: this.#store.getJob(this.#botId, jobId).inputs.length ? "queued" : "none",
					settled: this.#store.getJob(this.#botId, jobId).inputs.length === 0,
					error: null,
					wait: null,
				});
				this.#store.finishRequest(this.#botId, request.request_id, "applied");
				return;
			}
			case "compact":
			case "set-model": {
				const state = owner?.runtime?.state();
				if (
					this.#occupied(owner) ||
					(owner &&
						(owner.initializing ||
							owner.activation ||
							(state?.waiting_input_count ?? 0) > 0 ||
							(state?.pending_delivery_count ?? 0) > 0 ||
							owner.continuations.length > 0 ||
							state?.is_streaming ||
							(state?.pending_background_count ?? 0) > 0))
				) {
					if (command.command === "set-model" && job.model.pending !== command.model)
						this.#store.updateJob(this.#botId, jobId, {
							model: { ...job.model, pending: command.model ?? null },
						});
					return;
				}
				const claim = this.#store.claimContinuation(
					this.#botId,
					jobId,
					this.#ownerId,
					this.#ownerEpoch,
					job.ownership.activation_ref,
					request.request_id,
					command,
				);
				if (owner) owner.activation_ref = claim.activation_ref;
				owner ??= await this.#runtime(this.#store.getJob(this.#botId, jobId), request.request_id);
				if (command.command === "compact") {
					this.#store.updateJob(this.#botId, jobId, {
						phase: "compacting",
						activity: { kind: "control", label: "Compacting context", span_id: null },
					});
					await owner.runtime!.compact();
					this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
					this.#store.updateJob(this.#botId, jobId, { phase: "none", activity: null });
				} else {
					await owner.runtime!.setModel(command.model!);
					this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
					this.#store.setJobModel(this.#botId, jobId, owner.runtime!.state().model);
				}
				this.#store.finishRequest(this.#botId, request.request_id, "applied");
				this.#refresh(owner);
				return;
			}
		}
	}

	async #runtime(job: BotJob, requestId?: string): Promise<JobOwner> {
		let owner = this.#owners.get(job.job_id);
		if (owner?.runtime) return owner;
		if (owner?.initializing) {
			await owner.initializing;
			return owner;
		}
		owner ??= {
			job_id: job.job_id,
			execution_id: null,
			activation_ref: job.ownership.activation_ref,
			continuations: [],
			continuationPermits: new Map(),
			request_id: null,
			started_at: 0,
			sampled_at: 0,
			blocked: ["paused", "stopped", "interrupted", "failed"].includes(job.state),
			execution_failed: false,
			spans: new Map(),
			outputs: new Map(),
		};
		this.#owners.set(job.job_id, owner);
		const context = owner;
		if (requestId && this.#store.getJob(this.#botId, job.job_id).ownership.state === "none") {
			const activation = this.#store.claimContinuation(
				this.#botId,
				job.job_id,
				this.#ownerId,
				this.#ownerEpoch,
				null,
				requestId,
				undefined,
			);
			context.activation_ref = activation.activation_ref;
		}
		try {
			context.initializing = this.#factory(
				this.#store.getJob(this.#botId, job.job_id),
				{
					assertDispatch: () => {
						this.#assertOwner(context);
						const current = this.#store.getJob(this.#botId, job.job_id);
						if (
							current.ownership.state !== "active" ||
							!context.activation_ref ||
							(current.ownership.activation_ref !== context.activation_ref &&
								!context.continuations.some(
									pending => pending.activation.activation_ref === current.ownership.activation_ref,
								))
						)
							throw new BotError("invalid_state", "Activation ownership has been fenced");
						const claim = this.#store.activation(context.activation_ref);
						if (
							claim.owner_id !== this.#ownerId ||
							claim.owner_epoch !== this.#ownerEpoch ||
							["interrupted", "closed"].includes(claim.stage)
						)
							throw new BotError("invalid_state", "Activation dispatch has been fenced");
					},
					onEvent: event => this.#event(context, event),
					onContinuation: (continuation, signal) => this.#continuation(context, continuation, signal),
					onSessionOwner: (sessionOwnerId, epoch) => {
						this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
						this.#store.setSessionOwner(this.#botId, job.job_id, sessionOwnerId, epoch ?? this.#ownerEpoch);
					},
					onLaunchIntent: async intent => {
						this.#assertOwner(context);
						this.#store.recordLaunchIntent(this.#botId, job.job_id, intent);
					},
					onLaunchDisposition: (intentId, disposition, cleanup) => {
						// A fenced former owner may finish broker cleanup but must not write
						// its observation into the successor's durable state.
						if (cleanup && !this.#hasLease()) return;
						this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
						if (this.#owners.get(job.job_id) !== context)
							throw new BotError("invalid_state", "Runtime ownership was replaced");
						this.#store.updateLaunchIntent(this.#botId, job.job_id, intentId, disposition);
					},
				},
				{
					session_dir: path.join(this.#store.root, "sessions"),
					owner_epoch: this.#ownerEpoch,
					session_owner_id: job.session_owner_id,
				},
			);
			context.runtime = await context.initializing;
			context.initializing = undefined;
			this.#store.assertWorker(this.#botId, this.#ownerId, this.#ownerEpoch);
			const state = context.runtime.state();
			if (state.session_file) this.#store.setSessionFile(this.#botId, job.job_id, state.session_file);
			return context;
		} catch (error) {
			context.initializing = undefined;
			if (context.runtime) {
				let cleanupError: unknown;
				let cleanupFailed = false;
				try {
					await context.runtime.stop();
					await context.runtime.dispose();
				} catch (stopError) {
					cleanupFailed = true;
					cleanupError = stopError;
				}
				if (cleanupFailed) {
					// Keep the runtime reachable for explicit recovery or worker shutdown.
					context.blocked = true;
					if (this.#hasLease())
						this.#store.interruptOwnership(this.#botId, job.job_id, failure(cleanupError, "cleanup_failed"));
					throw error;
				}
				context.runtime = undefined;
			}
			if (requestId && this.#hasLease()) {
				try {
					this.#store.closeOwnership(this.#botId, job.job_id, failure(error));
					this.#store.updateJob(this.#botId, job.job_id, {
						state: "failed",
						phase: "none",
						settled: true,
						error: failure(error),
					});
				} catch (cleanupError) {
					this.#store.interruptOwnership(this.#botId, job.job_id, failure(cleanupError, "cleanup_failed"));
				}
			}
			this.#owners.delete(job.job_id);
			throw error;
		}
	}

	#activate(job: BotJob, input: QueuedInput, activation: BotActivation): void {
		let context = this.#owners.get(job.job_id);
		if (!context) {
			context = {
				job_id: job.job_id,
				activation_ref: activation.activation_ref,
				continuations: [],
				continuationPermits: new Map(),
				execution_id: null,
				request_id: input.request_id,
				started_at: 0,
				sampled_at: 0,
				blocked: false,
				execution_failed: false,
				spans: new Map(),
				outputs: new Map(),
			};
			this.#owners.set(job.job_id, context);
		}
		const owner = context;
		owner.activation_ref = activation.activation_ref;
		owner.request_id = input.request_id;
		owner.blocked = false;
		owner.activation = this.#runActivation(job, input, owner);
	}
	async #runActivation(job: BotJob, input: QueuedInput, owner: JobOwner): Promise<void> {
		try {
			await this.#runtime(job);
			this.#assertOwner(owner);
		} catch (error) {
			if (owner.blocked) return;
			if (!this.#hasLease()) return;
			if (this.#store.hasPendingCancellation(this.#botId, job.job_id)) return;
			this.#store.updateActivation(owner.activation_ref!, { stage: "closed", error: failure(error) });
			try {
				this.#store.closeOwnership(this.#botId, job.job_id, failure(error));
				this.#store.updateJob(this.#botId, job.job_id, {
					state: "failed",
					phase: "none",
					settled: true,
					error: failure(error),
				});
			} catch (cleanupError) {
				this.#store.interruptOwnership(this.#botId, job.job_id, failure(cleanupError, "cleanup_failed"));
			}
			owner.activation = undefined;
			return;
		}
		this.#startExecution(owner, input.reply_to ? "resume" : job.output_ref ? "send" : "submit");
		this.#store.recordMessage(this.#botId, job.job_id, {
			role: "user",
			content: input.input,
			request_id: input.request_id,
		});
		const context = owner;
		const execute = async (): Promise<void> => {
			try {
				if (input.reply_to) {
					await context.runtime!.reply(input.reply_to, input.input);
					if (!this.#isOwner(context)) return;
					this.#store.resolveInputRequest(this.#botId, job.job_id, input.reply_to, input.request_id);
				} else await context.runtime!.prompt(input.input);
			} catch (error) {
				if (this.#isOwner(context) && !this.#store.hasPendingCancellation(this.#botId, job.job_id)) {
					try {
						this.#store.closeOwnership(this.#botId, job.job_id, failure(error));
					} catch (cleanupError) {
						this.#store.interruptOwnership(this.#botId, job.job_id, failure(cleanupError, "cleanup_failed"));
						return;
					}
					this.#yieldExecution(context, "error");
					this.#store.updateJob(this.#botId, job.job_id, {
						state: "failed",
						phase: "none",
						settled: true,
						error: failure(error),
					});
				}
			} finally {
				context.activation = undefined;
				this.#flushOutputs(context, true);
				this.#refresh(context);
			}
		};
		await execute();
	}

	#startExecution(owner: JobOwner, trigger: "submit" | "send" | "resume" | "background"): void {
		if (owner.execution_id) return;
		owner.execution_failed = false;
		owner.execution_id = crypto.randomUUID();
		owner.started_at = Date.now();
		if (owner.activation_ref)
			this.#store.updateActivation(owner.activation_ref, { stage: "executing", execution_id: owner.execution_id });
		this.#store.updateJob(this.#botId, owner.job_id, {
			state: "running",
			phase: "model",
			execution_id: owner.execution_id,
			settled: false,
			wait: null,
			error: null,
		});
		this.#emit(owner, "execution.started", { trigger });
	}

	#yieldExecution(owner: JobOwner, outcome: "returned" | "cancelled" | "error"): void {
		if (!owner.execution_id) return;
		const state = owner.runtime?.state();
		const job = this.#store.getJob(this.#botId, owner.job_id);
		const settled =
			!!state &&
			!state.is_streaming &&
			state.pending_background_count === 0 &&
			state.pending_delivery_count === 0 &&
			state.waiting_input_count === 0 &&
			job.inputs.length === 0 &&
			job.ownership.state === "none";
		this.#emit(owner, "execution.yielded", { outcome, output_ref: job.output_ref, settled });
		owner.execution_id = null;
		owner.started_at = 0;
		this.#store.updateJob(this.#botId, owner.job_id, { execution_id: null });
	}

	#emit(owner: JobOwner, type: string, data: unknown): void {
		this.#store.emit(this.#botId, type, data, {
			job_id: owner.job_id,
			execution_id: owner.execution_id ?? undefined,
			request_id: owner.request_id ?? undefined,
		});
	}

	#event(owner: JobOwner, event: BotRuntimeEvent): void {
		if (!this.#isOwner(owner)) return;
		if (this.#store.hasPendingCancellation(this.#botId, owner.job_id)) return;
		switch (event.type) {
			case "execution_start":
				if (!owner.blocked) this.#startExecution(owner, "background");
				break;
			case "execution_end":
				owner.execution_failed = event.outcome === "error";
				this.#flushOutputs(owner, true);
				this.#yieldExecution(owner, event.outcome);
				break;
			case "output": {
				const previous = owner.outputs.get(event.message_id);
				owner.outputs.set(event.message_id, {
					text: event.text,
					final: event.final,
					revision: (previous?.revision ?? 0) + 1,
					emitted_revision: previous?.emitted_revision ?? 0,
					emitted_at: previous?.emitted_at ?? 0,
				});
				this.#flushOutputs(owner, event.final);
				break;
			}
			case "span_start": {
				const span = {
					started_at: event.started_at ?? new Date().toISOString(),
					parent_span_id: event.parent_span_id ?? null,
					kind: event.kind,
					label: event.label,
				};
				owner.spans.set(event.span_id, span);
				this.#emit(owner, "span.started", {
					...span,
					span_id: event.span_id,
					ended_at: null,
					outcome: null,
					detail_ref:
						event.detail === undefined ? null : this.#store.putRef(this.#botId, owner.job_id, event.detail),
				});
				if (!owner.blocked)
					this.#store.updateJob(this.#botId, owner.job_id, {
						phase: event.kind === "compaction" ? "compacting" : event.kind,
						wait: null,
						activity: {
							kind: event.kind === "compaction" ? "control" : event.kind,
							label: event.label,
							span_id: event.span_id,
						},
					});
				break;
			}
			case "span_end": {
				const span = owner.spans.get(event.span_id);
				owner.spans.delete(event.span_id);
				this.#emit(owner, "span.finished", {
					span_id: event.span_id,
					parent_span_id: span?.parent_span_id ?? null,
					kind: event.kind,
					label: event.label,
					started_at: span?.started_at ?? new Date().toISOString(),
					ended_at: event.ended_at ?? new Date().toISOString(),
					outcome: event.outcome,
					detail_ref:
						event.detail === undefined ? null : this.#store.putRef(this.#botId, owner.job_id, event.detail),
				});
				break;
			}
			case "usage": {
				const usage = this.#store.getJob(this.#botId, owner.job_id).usage;
				const sum = (old: number | null, value: number | null): number | null =>
					value === null ? old : (old ?? 0) + value;
				const known = [
					event.input_tokens,
					event.output_tokens,
					event.cache_read_tokens,
					event.cache_write_tokens,
					event.cost_usd,
				];
				this.#store.updateJob(this.#botId, owner.job_id, {
					usage: {
						input_tokens: sum(usage.input_tokens, event.input_tokens),
						output_tokens: sum(usage.output_tokens, event.output_tokens),
						cache_read_tokens: sum(usage.cache_read_tokens, event.cache_read_tokens),
						cache_write_tokens: sum(usage.cache_write_tokens, event.cache_write_tokens),
						cost_usd: addDecimalCost(usage.cost_usd, event.cost_usd),
						completeness:
							known.every(value => value !== null) &&
							(usage.measured_at === null || usage.completeness === "complete")
								? "complete"
								: known.every(value => value === null) && usage.completeness === "unknown"
									? "unknown"
									: "partial",
						measured_at: new Date().toISOString(),
					},
				});
				break;
			}
			case "input_required": {
				this.#store.registerInputRequest(this.#botId, owner.job_id, event);
				if (owner.activation_ref) this.#store.updateActivation(owner.activation_ref, { stage: "waiting_input" });
				this.#yieldExecution(owner, "returned");
				this.#store.updateJob(this.#botId, owner.job_id, {
					state: "waiting_input",
					phase: "input",
					settled: false,
					wait: {
						kind: event.kind === "approval" ? "approval" : "input",
						message: "Waiting for a targeted response",
						request_id: event.input_request_id,
						retry_at: null,
					},
				});
				break;
			}
			case "input_resolved":
				this.#store.resolveInputRequest(this.#botId, owner.job_id, event.input_request_id);
				break;
			case "artifact": {
				const ref = this.#store.putRef(this.#botId, owner.job_id, event.content, event.media_type);
				const id = crypto.randomUUID();
				this.#emit(owner, "artifact.published", {
					artifact_id: id,
					name: event.name,
					media_type: event.media_type,
					size_bytes: typeof event.content === "string" ? Buffer.byteLength(event.content) : null,
					content_ref: ref,
					producer_span_id: event.producer_span_id ?? null,
				});
				const job = this.#store.getJob(this.#botId, owner.job_id);
				this.#store.updateJob(this.#botId, owner.job_id, { artifact_ids: [...job.artifact_ids, id] });
				break;
			}
			case "retry":
				if (!owner.blocked)
					this.#store.updateJob(this.#botId, owner.job_id, {
						phase: "retry_wait",
						wait: {
							kind: "retry",
							message: "Provider retry pending",
							request_id: owner.request_id,
							retry_at: new Date(Date.now() + event.delay_ms).toISOString(),
						},
					});
				break;
			case "notice":
				this.#emit(owner, "runtime.notice", { level: event.level, message: event.message });
				break;
			case "error":
				if (!owner.blocked) this.#store.updateJob(this.#botId, owner.job_id, { error: failure(event.error) });
				break;
			case "state":
				break;
		}
	}

	#flushOutputs(owner: JobOwner, force = false): void {
		if (!this.#isOwner(owner)) return;
		for (const [messageId, output] of owner.outputs) {
			if (output.revision === output.emitted_revision || (!force && Date.now() - output.emitted_at < 250)) continue;
			const ref = this.#store.putRef(this.#botId, owner.job_id, output.text, "text/markdown");
			this.#emit(owner, "output.updated", {
				message_id: messageId,
				revision: String(output.revision),
				preview: this.#store.preview(output.text),
				content_ref: ref,
				final: output.final,
			});
			output.emitted_at = Date.now();
			output.emitted_revision = output.revision;
			if (output.final) {
				this.#store.recordMessage(this.#botId, owner.job_id, {
					role: "assistant",
					content: output.text,
					message_id: messageId,
				});
				this.#store.updateJob(this.#botId, owner.job_id, { output_ref: ref });
				owner.outputs.delete(messageId);
			}
		}
	}

	#refresh(owner: JobOwner): void {
		const runtime = owner.runtime;
		if (!this.#isOwner(owner)) return;
		if (this.#store.hasPendingCancellation(this.#botId, owner.job_id)) return;
		if (owner.blocked && this.#store.getJob(this.#botId, owner.job_id).ownership.state === "uncertain") return;
		if (!runtime) return;
		const state = runtime.state();
		const job = this.#store.getJob(this.#botId, owner.job_id);
		const patch: Partial<JobProjection> = {};
		if (job.model.current !== state.model) patch.model = { ...job.model, current: state.model };
		if (Date.now() - owner.sampled_at >= 250) {
			if (JSON.stringify(job.context) !== JSON.stringify(state.context)) patch.context = state.context;
			if (JSON.stringify(job.progress) !== JSON.stringify(state.progress)) patch.progress = state.progress;
			if (patch.context !== undefined || patch.progress !== undefined) owner.sampled_at = Date.now();
		}
		if (job.pending_background_count !== state.pending_background_count)
			patch.pending_background_count = state.pending_background_count;
		if (job.pending_delivery_count !== state.pending_delivery_count)
			patch.pending_delivery_count = state.pending_delivery_count;
		if (!owner.blocked && job.state !== "failed") {
			if (state.waiting_input_count > 0) {
				if (job.state !== "waiting_input")
					Object.assign(patch, { state: "waiting_input", phase: "input", settled: false });
			} else if (state.is_streaming || owner.activation) {
				if (job.state !== "running") Object.assign(patch, { state: "running", settled: false });
			} else if (state.pending_background_count || state.pending_delivery_count) {
				if (job.phase !== "background")
					Object.assign(patch, { state: "running", phase: "background", settled: false, wait: null });
			} else if (owner.execution_failed) {
				try {
					this.#store.closeOwnership(this.#botId, owner.job_id);
				} catch (error) {
					this.#store.interruptOwnership(this.#botId, owner.job_id, failure(error, "cleanup_failed"));
					owner.blocked = true;
					return;
				}
				Object.assign(patch, { state: "failed", phase: "none", settled: true, activity: null, wait: null });
			} else if (job.inputs.length) {
				try {
					this.#store.closeOwnership(this.#botId, owner.job_id);
				} catch (error) {
					this.#store.interruptOwnership(this.#botId, owner.job_id, failure(error, "cleanup_failed"));
					owner.blocked = true;
					return;
				}
				if (job.state !== "queued")
					Object.assign(patch, { state: "queued", phase: "queued", settled: false, activity: null, wait: null });
			} else if (!job.settled || job.state !== "idle") {
				try {
					this.#store.closeOwnership(this.#botId, owner.job_id);
				} catch (error) {
					this.#store.interruptOwnership(this.#botId, owner.job_id, failure(error, "cleanup_failed"));
					owner.blocked = true;
					return;
				}
				Object.assign(patch, { state: "idle", phase: "none", settled: true, activity: null, wait: null });
			}
		}
		if (
			Object.keys(patch).length ||
			(state.owned_services !== undefined &&
				JSON.stringify(job.owned_services ?? []) !== JSON.stringify(state.owned_services))
		) {
			this.#store.updateRuntimeState(this.#botId, owner.job_id, patch, state.owned_services);
		}
	}

	close(): Promise<void> {
		if (!this.#closing) {
			this.#closing = this.#close().finally(() => {
				this.#closing = undefined;
			});
		}
		return this.#closing;
	}

	async #close(): Promise<void> {
		this.#closed = true;
		let cleanupFailed = false;
		for (const owner of this.#owners.values()) {
			owner.blocked = true;
			for (const pending of owner.continuations.splice(0)) {
				if (this.#hasLease())
					this.#store.updateActivation(pending.activation.activation_ref, {
						stage: "interrupted",
						recovery: "inspection_required",
						error: { code: "worker_stopped", message: "Continuation owner stopped", retryable: false },
					});
				pending.reject(new BotError("invalid_state", "Worker stopped"));
			}
			const previous = this.#store.getJob(this.#botId, owner.job_id);
			try {
				if (owner.initializing) owner.runtime ??= await owner.initializing;
				await owner.runtime?.stop();
				await owner.runtime?.dispose();
				owner.runtime = undefined;
			} catch (error) {
				cleanupFailed = true;
				logger.error("Bot worker cleanup failed", { error: String(error), job_id: owner.job_id });
			}
			if (this.#hasLease() && (cleanupFailed || ["running", "waiting_input"].includes(previous.state))) {
				this.#store.interruptOwnership(this.#botId, owner.job_id, {
					code: "worker_stopped",
					message: "Worker stopped; inspect the last execution before resuming",
					retryable: false,
				});
			}
		}
		if (cleanupFailed) {
			if (!this.#closeRetry) {
				this.#closeRetry = setInterval(() => {
					void this.close().catch(error =>
						logger.error("Bot worker cleanup retry failed", { error: String(error), bot_id: this.#botId }),
					);
				}, 30_000);
				this.#closeRetry.unref();
			}
			throw new BotError("cleanup_failed", "Owned work did not confirm cleanup", undefined, true);
		}
		clearInterval(this.#closeRetry);
		this.#closeRetry = undefined;
		clearInterval(this.#heartbeatTimer);
		if (this.#claimed) this.#store.releaseWorker(this.#botId, this.#ownerId);
	}
}

export async function startBotWorkerFromEnvironment(): Promise<void> {
	const root = process.env[BOT_ROOT_ENV];
	const botId = process.env[BOT_ID_ENV];
	if (!root || !botId) throw new Error("Bot worker requires its profile-local root and Bot identity");
	let lock = tryAcquireFileLock(path.join(root, `${botId}.worker`));
	if (!lock) return;
	const store = new BotStore(root);
	let worker: BotWorker | undefined;
	const abort = new AbortController();
	const stop = (): void => abort.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		while (!abort.signal.aborted) {
			worker = new BotWorker(store, botId);
			while (!abort.signal.aborted && !worker.claim(true)) await Bun.sleep(100);
			while (!abort.signal.aborted && !worker.shouldYieldToGraph()) {
				await worker.tick();
				await Bun.sleep(100);
			}
			await worker.close();
			worker = undefined;
			if (abort.signal.aborted) break;
			lock?.release();
			lock = null;
			while (!abort.signal.aborted && store.hasGraphHandoff(botId)) await Bun.sleep(100);
			while (!abort.signal.aborted && !lock) {
				lock = tryAcquireFileLock(path.join(root, `${botId}.worker`));
				if (!lock) await Bun.sleep(100);
			}
		}
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		await worker?.close();
		store.close();
		lock?.release();
	}
}

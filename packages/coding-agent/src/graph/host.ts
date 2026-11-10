import type { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import { prompt } from "@oh-my-pi/pi-utils";
import type { BotRuntimeCallbacks, BotRuntimeOptions } from "../bots/agent-runtime";
import { validateGraphContext, type BotStore } from "../bots/store";
import type { BotJob } from "../bots/types";
import type { GraphCompletionCandidate } from "../tools/graph-complete";
import type { ChildExecutionRecord, ChildExecutionRecovery, ChildIdentity, ChildIsolation } from "./child-execution";
import type { ChildOutputBindings } from "./child-outputs";
import type { ConsultationIdentity, ConsultationMessage, GraphConsultationStore } from "./consultation";
import consultationInput from "./consultation-input.md" with { type: "text" };
import botContext from "./bot-context.md" with { type: "text" };
import { createGraphBotRuntime, type GraphBotAssignment } from "./executors/bot";
import { GraphBotLeaseUnavailable, GraphBotRecovery, GraphBotWorker } from "./executors/bot-worker";
import { prepareGraphBot } from "./executors/bot";
import type { PreparedArtifactRegistration } from "./artifacts";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import type {
	ProgramAccept,
	ProgramExecutionRequest,
	ProgramResult,
	TrustedProgramExecutor,
} from "./executors/program";
import type { QueueIntegration } from "./executors/queue-integration";
import { queueRecordMatchesExecution, type QueueExecutionRequest, type QueueRecord } from "./executors/queue";
import type {
	GraphAttemptCompletion,
	GraphDispatchIntent,
	GraphChildDispatchPolicy,
	GraphFinalReviewPolicy,
	GraphRunRecord,
	GraphRunStore,
	GraphSerialChildAggregation,
	GraphSerialChildSettlement,
	GraphSerialChildWriterAdmission,
	GraphSerialChildWriterRequest,
} from "./store";

type HostStore = Pick<
	GraphRunStore,
	| "claimHost"
	| "assertHostOwner"
	| "getRun"
	| "listHostRuns"
	| "listHostIntents"
	| "claimDispatch"
	| "observeDispatch"
	| "schedule"
	| "completeAttempt"
	| "createHumanQuestion"
> &
	Partial<
		Pick<
			GraphRunStore,
			| "getSnapshot"
			| "getFrozenDefinition"
			| "getFrozenCommunicationInstructions"
			| "getScheduleState"
			| "getDispatchIntents"
			| "submitBotCompletion"
			| "getBotCompletion"
			| "waitForConsultation"
			| "resumeConsultation"
			| "startConsultationInvocation"
			| "recoverChildExecutions"
			| "createChildExecutionFromArtifact"
			| "listSerialChildExecutions"
			| "aggregateSerialChildExecution"
			| "settleSerialChildExecution"
			| "finishConsultationInvocation"
			| "confirmBotRecovery"
			| "recordBotUsage"
			| "prepareBotHandoff"
			| "confirmBotHandoff"
		>
	>;
type ProgramExecutor = Pick<TrustedProgramExecutor, "accept" | "query" | "cancel"> &
	Partial<Pick<TrustedProgramExecutor, "verifyRegistration">>;

function consultationReference(
	value: unknown,
): { conversation_id: string; message_id: string; member_id: string } | null {
	if (!value || typeof value !== "object" || !("consultation" in value)) return null;
	const ref = value.consultation;
	if (
		!ref ||
		typeof ref !== "object" ||
		!("conversation_id" in ref) ||
		!("message_id" in ref) ||
		!("member_id" in ref) ||
		typeof ref.conversation_id !== "string" ||
		typeof ref.message_id !== "string" ||
		typeof ref.member_id !== "string"
	)
		return null;
	return { conversation_id: ref.conversation_id, message_id: ref.message_id, member_id: ref.member_id };
}

export interface GraphBotLaunch {
	job: BotJob;
	member_id: string;
	/** The host installs completion and consultation capabilities; resolvers cannot supply them. */
	assignment: Omit<GraphBotAssignment, "tools">;
	input: string;
	/** Opt in to the host's authorized consultation service for this attempt. */
	consultation?: boolean;
	callbacks: BotRuntimeCallbacks;
	options?: Omit<BotRuntimeOptions, "graph" | "model" | "modelRegistry">;
}

/** All callbacks are trusted host configuration, never supplied by graph content. */
export interface GraphHostBotOptions {
	/** Return null for non-Bot nodes; resolve exclusively from the frozen snapshot. */
	resolve(intent: GraphDispatchIntent): Promise<GraphBotLaunch | null>;
	/** Durable Bot mailbox; Graph never invokes an unmanaged runtime. */
	store?: BotStore;
	/** Trusted runtime factory; defaults to the Graph-capability runtime. */
	createRuntime?: typeof createGraphBotRuntime;
	authorize(db: Database, identity: ConsultationIdentity): boolean;
	prepareArtifacts?(
		intent: GraphDispatchIntent,
		candidate: GraphCompletionCandidate,
	): Promise<PreparedArtifactRegistration>;
	/** Authenticate and durably reserve this exact reply; replay must never redeliver it. */
	admitReply?(
		intent: GraphDispatchIntent,
		reply: { request_key: string; input_request_id: string; input: string },
	): Promise<"accepted" | "replay" | "rejected">;
}

/** Queue providers and all authorization/result mapping are installed by the trusted host. */
export interface GraphHostQueueOptions {
	integration: QueueIntegration;
	resolve(intent: GraphDispatchIntent): Promise<QueueExecutionRequest>;
	authorize(intent: GraphDispatchIntent): Promise<boolean>;
	verifyResult(intent: GraphDispatchIntent, record: QueueRecord): Promise<GraphAttemptCompletion>;
	prepareArtifacts?(intent: GraphDispatchIntent, record: QueueRecord): Promise<PreparedArtifactRegistration>;
}

/** An explicit trusted serial executor. No callback or proof comes from Graph prose. */
export interface GraphHostChildOptions {
	admission: GraphChildDispatchPolicy;
	recovery: ChildExecutionRecovery;
	/** Resolve only the exact frozen planner input; no arbitrary child source/path. */
	resolve(intent: GraphDispatchIntent): Promise<{
		input: string;
		principal: string;
		isolation: Extract<ChildIsolation, { mode: "serial" }>;
		output_bindings: ChildOutputBindings;
		stopped: Pick<GraphSerialChildWriterRequest, "if_parent_revision" | "termination_ref" | "observed">;
	}>;
	/** Independently establish child quiescence and, for success, integration.
	 * null retains ownership without claiming the child or parent is finished. */
	observe(
		record: ChildExecutionRecord,
		parent: ChildIdentity,
		admission: GraphSerialChildWriterAdmission,
	): Promise<
		| { type: "integrate"; request: GraphSerialChildAggregation }
		| { type: "settle"; request: GraphSerialChildSettlement }
		| null
	>;
	verifyIntegration(db: Database, proof: GraphSerialChildAggregation & { outputs: Record<string, GraphRef> }): boolean;
}

/** The resolver and result verifier are trusted host configuration, not Graph-authored code. */
export interface GraphHostOptions {
	store: HostStore;
	program: ProgramExecutor;
	bot?: GraphHostBotOptions;
	consultation?: GraphConsultationStore;
	queue?: GraphHostQueueOptions;
	child?: GraphHostChildOptions;
	/** Optional trusted recovery adapter. It does not authorize new subgraph dispatch. */
	childRecovery?: ChildExecutionRecovery;
	/** Trusted synchronous final-review authority, consulted inside the routing transaction. */
	finalReview?: GraphFinalReviewPolicy;
	/** Trusted resolver returns a question only for a human node in the frozen snapshot. */
	resolveHuman?(intent: GraphDispatchIntent): Promise<{ principal: string; questionRef: GraphRef } | null>;
	/** Resolve the frozen definition, input versions and authorization into a program envelope. */
	resolveProgram(intent: GraphDispatchIntent): Promise<ProgramExecutionRequest>;
	/** Validate outcomes and execution metadata against the frozen request. */
	verifyProgramResult(intent: GraphDispatchIntent, result: ProgramResult): Promise<GraphAttemptCompletion>;
	/** Verify published files against trusted provenance before the store commits them with the result. */
	prepareProgramArtifacts?(intent: GraphDispatchIntent, result: ProgramResult): Promise<PreparedArtifactRegistration>;
}

/** Single-owner dispatch pump. The embedding worker owns its lifetime and calls tick repeatedly. */
export class GraphHost {
	readonly #store: HostStore;
	readonly #program: ProgramExecutor;
	readonly #options: GraphHostOptions;
	readonly #childRecovery: ChildExecutionRecovery | undefined;
	readonly #active = new Map<string, { intent: GraphDispatchIntent; executionRef: string }>();
	readonly #queues = new Map<string, GraphDispatchIntent>();
	readonly #waitingBots = new Map<string, { intent: GraphDispatchIntent; launch: GraphBotLaunch }>();
	readonly #botRecoveries = new Map<
		string,
		{ intent: GraphDispatchIntent; retryAt: number; worker?: GraphBotRecovery; runtime?: GraphBotWorker }
	>();
	readonly #bots = new Map<
		string,
		{
			intent: GraphDispatchIntent;
			runtime: GraphBotWorker;
			identity: ConsultationIdentity;
			settled: boolean;
			error?: unknown;
			continuing?: boolean;
			initialMessage?: ConsultationMessage;
		}
	>();
	#owner: { owner_id: string; epoch: string } | null = null;
	#tick: Promise<void> | null = null;
	#recovered = false;
	#nextRun = 0;
	#consultFirst = true;
	#stopping = false;
	#shutdown: Promise<void> | null = null;

	constructor(options: GraphHostOptions) {
		if (options.child && options.childRecovery && options.child.recovery !== options.childRecovery)
			throw new Error("Child execution and recovery must share the same trusted adapter");
		this.#childRecovery = options.child?.recovery ?? options.childRecovery;
		this.#options = options;
		this.#store = options.store;
		this.#program = options.program;
	}

	/** Claim once; the store retains its OS lock until it is closed. */
	start(): boolean {
		if (this.#stopping) return false;
		this.#owner ??= this.#store.claimHost();
		return this.#owner !== null;
	}

	/** Fence new work, settle the current pump and retain uncertain effects for reconciliation. */
	shutdown(): Promise<void> {
		if (this.#shutdown) return this.#shutdown;
		this.#stopping = true;
		this.#shutdown = this.#shutdownWork().catch(error => {
			this.#shutdown = null;
			throw error;
		});
		return this.#shutdown;
	}

	async #shutdownWork(): Promise<void> {
		try {
			await this.#tick;
		} catch {
			/* active effects are reconciled below */
		}
		const owner = this.#owner;
		if (!owner) return;
		const failures: unknown[] = [];
		for (const [id, active] of this.#active) {
			try {
				this.#program.cancel(active.executionRef);
			} catch (error) {
				failures.push(error);
			}
			try {
				if (
					!this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", {
						reason: "Host stopped before program execution was reconciled",
					})
				)
					throw new Error("Could not record program shutdown uncertainty");
			} catch (error) {
				failures.push(error);
			}
		}
		this.#active.clear();
		for (const [id] of this.#waitingBots) {
			if (
				!this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", {
					reason: "Host stopped while waiting for Bot ownership",
				})
			)
				failures.push(new Error("Could not record Bot dispatch shutdown"));
		}
		this.#waitingBots.clear();
		for (const [id, recovery] of this.#botRecoveries) {
			try {
				await recovery.runtime?.dispose();
				recovery.runtime = undefined;
				await recovery.worker?.dispose();
				this.#botRecoveries.delete(id);
			} catch (error) {
				failures.push(error);
			}
		}
		for (const [id, active] of this.#bots) {
			if (active.initialMessage)
				this.#options.consultation?.settleDelivery(active.identity, active.initialMessage.message_id, "unknown");
			try {
				await active.runtime.dispose();
				this.#bots.delete(id);
			} catch (error) {
				failures.push(error);
			}
			try {
				if (
					!this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", {
						reason: "Host stopped before Bot execution was reconciled",
					})
				)
					throw new Error("Could not record Bot shutdown uncertainty");
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length) throw new AggregateError(failures, "Graph host shutdown could not be confirmed");
	}

	/** Resume only a live, retained runtime after trusted durable admission. No original prompt is replayed. */
	async replyBot(
		intentId: string,
		reply: { request_key: string; input_request_id: string; input: string },
	): Promise<"accepted" | "replay" | "rejected"> {
		reply = { ...reply };
		const active = this.#bots.get(intentId);
		const admit = this.#options.bot?.admitReply;
		if (this.#stopping || !active || !admit || active.continuing || !reply.request_key || !reply.input_request_id)
			return "rejected";
		const request = active.runtime
			.state()
			.waiting_input_requests.find(item => item.input_request_id === reply.input_request_id);
		if (request?.prompt && typeof request.prompt === "object" && "graph_consultation" in request.prompt)
			return "rejected";
		this.#assertBotAttempt(active.intent);
		active.continuing = true;
		try {
			const result = await admit(structuredClone(active.intent), { ...reply });
			if (result !== "accepted") return result;
			this.#assertBotAttempt(active.intent);
			active.settled = false;
			try {
				await active.runtime.reply(reply.input_request_id, reply.input, reply.request_key);
			} catch (error) {
				active.error = error;
				throw error;
			} finally {
				active.settled = true;
			}
			return "accepted";
		} catch (error) {
			// The durable reservation or delivery may have committed despite a lost response.
			this.#botRecoveries.set(intentId, {
				intent: { ...active.intent, state: "accepted" },
				retryAt: 0,
				runtime: active.runtime,
			});
			try {
				await active.runtime.dispose();
			} catch {
				/* cleanup remains unconfirmed */
			}
			this.#bots.delete(intentId);
			const owner = this.#owner!;
			this.#store.observeDispatch(owner.owner_id, owner.epoch, intentId, "unknown", { reason: String(error) });
			throw error;
		} finally {
			active.continuing = false;
		}
	}

	/** Serializes overlapping wakeups. Never replays a dispatch with an uncertain side effect. */
	tick(): Promise<void> {
		if (this.#stopping) throw new Error("Graph host is stopping");
		if (!this.#owner) throw new Error("Graph host has not acquired ownership");
		if (this.#tick) return this.#tick;
		const work = this.#runTick();
		this.#tick = work;
		void work
			.finally(() => {
				if (this.#tick === work) this.#tick = null;
			})
			.catch(() => {});
		return work;
	}

	async #runTick(): Promise<void> {
		const owner = this.#owner!;
		try {
			this.#store.assertHostOwner(owner.owner_id, owner.epoch);
		} catch (error) {
			for (const recovery of this.#botRecoveries.values()) {
				await recovery.worker?.dispose();
				recovery.worker = undefined;
			}
			throw error;
		}
		let recoveredChildren: ChildExecutionRecord[] = [];
		const recoveredIdentities = new Map<string, ChildIdentity>();
		let childRecoveryError: Error | undefined;
		if (this.#childRecovery) {
			try {
				const recover = this.#store.recoverChildExecutions;
				if (!recover) throw new Error("Child execution recovery is unavailable");
				const recovery = recover.call(
					this.#store,
					owner.owner_id,
					owner.epoch,
					this.#childRecovery.host,
					(runId, invocationId) => {
						const identity = this.#childRecovery!.resolveIdentity(runId, invocationId);
						if (identity) recoveredIdentities.set(JSON.stringify([runId, invocationId]), identity);
						return identity;
					},
				);
				recoveredChildren = recovery.reconciled;
				if (recovery.unresolved.length)
					throw new Error("Child execution recovery could not authenticate every parent attempt");
			} catch (error) {
				// Block admission, not cancellation/reconciliation of work already owned by this Host.
				childRecoveryError =
					error instanceof Error ? error : new Error("Child execution recovery failed", { cause: error });
			}
		}
		try {
			await this.#collectChildren();
		} catch (error) {
			childRecoveryError ??= error instanceof Error ? error : new Error("Child settlement failed", { cause: error });
		}
		if (!this.#recovered) {
			const runs = new Set([
				...this.#store.listHostIntents().map(intent => intent.run_id),
				...(this.#options.consultation?.activeRunIds() ?? []),
			]);
			for (const runId of runs) this.#options.consultation?.recoverDeliveries(runId);
			// Even a pending intent from an older epoch cannot be authorized under this fence.
			// A submitting/accepted intent may already have produced external effects.
			for (const intent of this.#store.listHostIntents()) {
				const invocation = this.#store
					.getScheduleState?.(intent.run_id)
					?.invocations.find(item => item.id === intent.invocation_id);
				const node = invocation && this.#store.getFrozenDefinition?.(intent.run_id)?.nodes[invocation.node];
				if (node?.kind === "subgraph" && childRecoveryError) continue;
				const childIdentity = recoveredIdentities.get(JSON.stringify([intent.run_id, intent.invocation_id]));
				if (
					node?.kind === "subgraph" &&
					intent.state !== "pending" &&
					childIdentity?.attempt_id === intent.attempt_id &&
					childIdentity.fence === intent.fence &&
					recoveredChildren.some(
						record =>
							record.parent_run_id === intent.run_id &&
							record.parent_invocation_id === intent.invocation_id &&
							(record.state === "running" ||
								(record.state === "held" && this.#store.getRun(record.child_run_id)?.state === "succeeded")),
					)
				)
					continue;
				if (node?.kind === "queue" && this.#options.queue && intent.state !== "pending") {
					const record = await this.#options.queue.integration.adapter.get(intent.request_key);
					if (record && queueRecordMatchesExecution(record, intent, node.executor)) {
						this.#queues.set(intent.id, intent);
						continue;
					}
				}
				if (intent.state !== "pending" && (node?.kind === "bot" || consultationReference(intent.request)))
					this.#botRecoveries.set(intent.id, { intent, retryAt: 0 });
				if (intent.state !== "unknown")
					this.#store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "unknown", {
						reason: "Host restarted before dispatch could be reconciled",
					});
			}
			this.#recovered = true;
		}
		for (const [id, recovery] of this.#botRecoveries) {
			if (Date.now() < recovery.retryAt) continue;
			try {
				await this.#recoverBot(recovery);
				this.#botRecoveries.delete(id);
			} catch (error) {
				if (recovery.worker && !recovery.worker.hasLease()) {
					await recovery.worker.dispose();
					recovery.worker = undefined;
				}
				// Keep the dispatch unknown and retry cleanup, never the original execution.
				recovery.retryAt = error instanceof GraphBotLeaseUnavailable ? 0 : Date.now() + 1000;
			}
		}
		for (const [id, waiting] of this.#waitingBots) {
			const run = this.#store.getRun(waiting.intent.run_id);
			if (run?.state === "held") continue;
			if (run?.state === "cancelling") {
				const service = this.#options.consultation;
				if (service)
					for (const conversation of service.list(waiting.intent.run_id)) service.cancel(conversation.id);
				try {
					// Lease contention is raised before mailbox admission; no Bot execution was started.
					if (!this.#confirmBotStopped(waiting.intent))
						throw new Error("Unadmitted Bot cancellation was not committed");
					this.#waitingBots.delete(id);
				} catch (error) {
					this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", { reason: String(error) });
				}
				continue;
			}
			if (!run || run.state === "cancelled") {
				this.#waitingBots.delete(id);
				continue;
			}
			if (childRecoveryError) continue;
			try {
				await this.#dispatchBot(waiting.intent, waiting.launch);
				this.#waitingBots.delete(id);
			} catch (error) {
				if (error instanceof GraphBotLeaseUnavailable) continue;
				this.#waitingBots.delete(id);
				this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", { reason: String(error) });
			}
		}
		for (const [id, active] of this.#active) {
			const run = this.#store.getRun(active.intent.run_id);
			if (!run || run.state === "cancelling" || run.state === "cancelled") this.#program.cancel(active.executionRef);
			await this.#collect(id, active.intent, active.executionRef);
		}
		for (const [id, active] of this.#bots) {
			const run = this.#store.getRun(active.intent.run_id);
			if (active.error || !run || ["held", "cancelling", "cancelled"].includes(run.state)) {
				await this.#collectBot(id, active);
				continue;
			}
			try {
				await active.runtime.tick();
				const job = active.runtime.job;
				this.#recordBotUsage(active.intent, job);
				active.settled = job.settled;
				if (["failed", "interrupted", "stopped"].includes(job.state)) {
					active.error = new Error(`Bot job ${job.state}`);
					active.settled = true;
					if (active.initialMessage) {
						this.#options.consultation?.settleDelivery(
							active.identity,
							active.initialMessage.message_id,
							"unknown",
						);
						active.initialMessage = undefined;
					}
				}
				if (!active.error && active.initialMessage && (job.settled || job.state === "waiting_input")) {
					if (
						!this.#options.consultation?.settleDelivery(
							active.identity,
							active.initialMessage.message_id,
							"delivered",
						)
					)
						throw new Error("Consultation request receipt could not be committed");
					active.initialMessage = undefined;
				}
			} catch (error) {
				if (active.initialMessage) {
					this.#options.consultation?.settleDelivery(active.identity, active.initialMessage.message_id, "unknown");
					active.initialMessage = undefined;
				}
				active.error = error;
				active.settled = true;
			}
			await this.#collectBot(id, active);
		}
		for (const [id, intent] of this.#queues) await this.#collectQueue(id, intent);
		if (childRecoveryError) {
			await this.#pumpConsultations(false);
			throw childRecoveryError;
		}
		const consultFirst = this.#consultFirst;
		this.#consultFirst = !consultFirst;
		await this.#pumpConsultations(consultFirst);
		const runs = this.#store.listHostRuns();
		if (!runs.length) return;
		const start = this.#nextRun % runs.length;
		this.#nextRun = (start + 1) % runs.length;
		for (let index = 0; index < runs.length; index++) {
			const run: GraphRunRecord = runs[(start + index) % runs.length];
			const scheduled = this.#store.schedule(
				run.id,
				owner.owner_id,
				owner.epoch,
				this.#options.finalReview,
				this.#childRecovery,
				this.#options.child?.admission,
			);
			if (scheduled.intent) await this.#dispatch(scheduled.intent);
		}
		if (!consultFirst) await this.#pumpConsultations(true);
	}

	/** Only retained runtimes may receive replies; admitted-but-unconfirmed deliveries are never replayed. */
	async #pumpConsultations(admitNew: boolean): Promise<void> {
		const service = this.#options.consultation;
		const owner = this.#owner!;
		const resume = this.#store.resumeConsultation;
		const start = this.#store.startConsultationInvocation;
		if (!service || !resume || !start) return;
		const runIds = new Set([
			...this.#store.listHostRuns().map(run => run.id),
			...service.activeRunIds(),
			...[...this.#bots.values()].map(active => active.intent.run_id),
		]);
		for (const runId of runIds) {
			const run = this.#store.getRun(runId);
			if (!run) continue;
			service.expire(runId);
			if (run.state === "cancelling" || run.state === "cancelled") {
				for (const conversation of service.list(runId)) service.cancel(conversation.id);
				continue;
			}
			// A held run may expire consultations, but must not resume a retained Bot.
			if (run.state === "held") continue;
			const pending = service.pendingDeliveries(runId);
			for (const [id, active] of this.#bots) {
				if (active.intent.run_id !== runId || active.continuing) continue;
				const question = active.runtime.state().waiting_input_requests.find(item => {
					const prompt = item.prompt;
					return !!prompt && typeof prompt === "object" && "graph_consultation" in prompt;
				});
				if (!question || !question.prompt || typeof question.prompt !== "object") continue;
				if (!("graph_consultation" in question.prompt)) continue;
				const wait = question.prompt.graph_consultation;
				if (
					!wait ||
					typeof wait !== "object" ||
					!("conversation_id" in wait) ||
					!("message_id" in wait) ||
					typeof wait.conversation_id !== "string" ||
					typeof wait.message_id !== "string"
				)
					continue;
				const conversation = service.get(wait.conversation_id);
				const message = pending.find(
					item =>
						item.conversation_id === wait.conversation_id &&
						item.in_reply_to === wait.message_id &&
						item.recipient_member === active.identity.member_id,
				);
				if (!message && conversation?.state !== "timed_out" && conversation?.state !== "cancelled") continue;
				if (
					!resume.call(
						this.#store,
						owner.owner_id,
						owner.epoch,
						active.identity,
						wait.conversation_id,
						wait.message_id,
					)
				)
					continue;
				let payload: unknown;
				if (message) {
					const reservation = service.reserveDelivery(active.identity, message.message_id);
					if (!reservation.ok || !reservation.value.claimed) {
						this.#botRecoveries.set(id, {
							intent: { ...active.intent, state: "accepted" },
							retryAt: 0,
							runtime: active.runtime,
						});
						this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", {
							reason: "Consultation delivery admission was denied or already reserved",
						});
						try {
							await active.runtime.dispose();
						} finally {
							this.#bots.delete(id);
						}
						continue;
					}
					payload = { ok: true, value: message };
				} else {
					payload = { ok: false, error: conversation?.state === "timed_out" ? "consultation_timeout" : "closed" };
				}
				active.continuing = true;
				active.settled = false;
				void active.runtime
					.reply(
						question.input_request_id,
						JSON.stringify(payload),
						`graph-consultation:${message?.message_id ?? `${wait.conversation_id}:${wait.message_id}:closed`}`,
					)
					.then(() => {
						if (message && !service.settleDelivery(active.identity, message.message_id, "delivered"))
							throw new Error("Consultation delivery receipt could not be committed");
						active.settled = true;
					})
					.catch(error => {
						if (message) service.settleDelivery(active.identity, message.message_id, "unknown");
						active.error = error;
						active.settled = true;
						this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", { reason: String(error) });
					})
					.finally(() => {
						active.continuing = false;
					});
			}
			if (!admitNew) continue;
			for (const message of pending) {
				if (
					message.kind !== "request" ||
					[...this.#bots.values()].some(
						active => active.intent.run_id === runId && active.identity.member_id === message.recipient_member,
					)
				)
					continue;
				const intent = start.call(
					this.#store,
					owner.owner_id,
					owner.epoch,
					runId,
					message.recipient_member,
					message.conversation_id,
					message.message_id,
				);
				if (intent) await this.#dispatch(intent);
			}
		}
	}

	async #collectChildren(): Promise<void> {
		const child = this.#options.child;
		const owner = this.#owner!;
		if (!child) return;
		const list = this.#store.listSerialChildExecutions;
		if (!list) throw new Error("Serial child observation is unavailable");
		for (const entry of list.call(this.#store, owner.owner_id, owner.epoch)) {
			const result = structuredClone(
				await child.observe(
					structuredClone(entry.record),
					structuredClone(entry.parent),
					structuredClone(entry.admission),
				),
			);
			if (!result) continue;
			if (
				canonicalJson(result.request.parent) !== canonicalJson(entry.parent) ||
				canonicalJson(result.request.stopped.identity) !== canonicalJson(entry.admission)
			)
				throw new Error("Child observation does not match its contained execution");
			this.#store.assertHostOwner(owner.owner_id, owner.epoch);
			if (result.type === "integrate") {
				const aggregate = this.#store.aggregateSerialChildExecution;
				if (!aggregate) throw new Error("Serial child integration is unavailable");
				await aggregate.call(this.#store, owner.owner_id, owner.epoch, result.request, (db, proof) =>
					child.verifyIntegration(db, proof),
				);
			} else {
				const settle = this.#store.settleSerialChildExecution;
				if (!settle) throw new Error("Serial child settlement is unavailable");
				settle.call(this.#store, owner.owner_id, owner.epoch, result.request);
			}
		}
	}

	async #dispatch(intent: GraphDispatchIntent): Promise<void> {
		if (this.#stopping) return;
		const owner = this.#owner!;
		const claimed = this.#store.claimDispatch(owner.owner_id, owner.epoch, intent.id, this.#options.child?.admission);
		if (!claimed) return;
		let botLaunch: GraphBotLaunch | null = null;
		try {
			const invocation = this.#store
				.getScheduleState?.(claimed.run_id)
				?.invocations.find(item => item.id === claimed.invocation_id);
			const node = invocation && this.#store.getFrozenDefinition?.(claimed.run_id)?.nodes[invocation.node];
			const consultation = consultationReference(claimed.request);
			if (this.#store.getFrozenDefinition && !node && !consultation)
				throw new Error("Frozen dispatch node is unavailable");
			if (node?.kind === "subgraph") {
				const child = this.#options.child;
				const create = this.#store.createChildExecutionFromArtifact;
				if (!child || !create || !this.#childRecovery)
					throw new Error("Subgraph execution requires an enforcing child executor and verified aggregation");
				const launch = structuredClone(await child.resolve(structuredClone(claimed)));
				this.#store.assertHostOwner(owner.owner_id, owner.epoch);
				if (this.#stopping) throw new Error("Graph host is stopping");
				const created = await create.call(
					this.#store,
					owner.owner_id,
					owner.epoch,
					this.#childRecovery.host,
					{
						run_id: claimed.run_id,
						invocation_id: claimed.invocation_id,
						attempt_id: claimed.attempt_id,
						fence: claimed.fence,
					},
					launch.input,
					launch.principal,
					launch.isolation,
					launch.output_bindings,
					{ policy: child.admission, stopped: launch.stopped },
				);
				if (created.status === "rejected") throw new Error(created.issues.map(issue => issue.message).join("; "));
				return;
			}
			if (consultation) {
				if (
					!invocation?.consultation ||
					canonicalJson(invocation.consultation) !== canonicalJson(consultation) ||
					!this.#options.bot
				)
					throw new Error("Consultation dispatch identity is unavailable");
				const bot = (botLaunch = await this.#options.bot.resolve(structuredClone(claimed)));
				if (!bot) throw new Error("Trusted consultation Bot resolution is unavailable");
				await this.#dispatchBot(claimed, bot);
				return;
			}
			const human = await this.#options.resolveHuman?.(structuredClone(claimed));
			if (human) {
				this.#store.assertHostOwner(owner.owner_id, owner.epoch);
				if (!this.#store.listHostRuns().some(item => item.id === claimed.run_id))
					throw new Error("Run is no longer dispatchable");
				this.#store.createHumanQuestion(
					owner.owner_id,
					owner.epoch,
					human.principal,
					claimed.run_id,
					claimed.invocation_id,
					human.questionRef,
				);
				return;
			}
			if (node && node.kind !== "program") {
				if (node.kind === "queue" && this.#options.queue) {
					await this.#dispatchQueue(claimed, node.executor);
					return;
				}
				if (node.kind !== "bot" || !this.#options.bot) throw new Error(`No trusted executor for ${node.kind}`);
				const bot = (botLaunch = await this.#options.bot.resolve(structuredClone(claimed)));
				if (!bot) throw new Error("Trusted Bot resolution is unavailable");
				await this.#dispatchBot(claimed, bot);
				return;
			}
			const request = structuredClone(await this.#options.resolveProgram(structuredClone(claimed)));
			if (
				request.run_id !== claimed.run_id ||
				request.invocation_id !== claimed.invocation_id ||
				request.attempt_id !== claimed.attempt_id ||
				request.fence !== claimed.fence ||
				request.request_key !== claimed.request_key ||
				(node !== undefined && request.executor !== node.executor)
			)
				throw new Error("Resolved program envelope does not match dispatch identity");
			if (node?.timeout_ms !== undefined)
				request.timeout_ms = Math.min(node.timeout_ms, request.timeout_ms ?? Infinity);
			// Resolving can await; recheck ownership and cancellation immediately before submission.
			this.#store.assertHostOwner(owner.owner_id, owner.epoch);
			const run = this.#store.listHostRuns().find(item => item.id === claimed.run_id);
			if (!run) throw new Error("Run is no longer dispatchable");
			const frozen = this.#store.getSnapshot?.(run.snapshot_ref)?.executors[request.executor];
			if (
				node?.kind !== "program" ||
				!frozen ||
				typeof this.#program.verifyRegistration !== "function" ||
				this.#program.verifyRegistration(request.executor, frozen) !== true
			)
				throw new Error("Frozen program registration is unavailable or has changed");
			if (this.#stopping) throw new Error("Graph host is stopping");
			const accepted: ProgramAccept = await this.#program.accept(request);
			if (accepted.state === "rejected" && !accepted.execution_ref) {
				if (
					!this.#store.completeAttempt(owner.owner_id, owner.epoch, {
						run_id: claimed.run_id,
						invocation_id: claimed.invocation_id,
						attempt_id: claimed.attempt_id,
						fence: claimed.fence,
						state: "failed",
						error: accepted.error ?? "Program execution rejected",
					})
				)
					throw new Error("Program rejection could not be recorded");
				return;
			}
			if (accepted.state !== "accepted" || !accepted.execution_ref)
				throw new Error(accepted.error ?? "Program dispatch was not confirmed");
			this.#active.set(claimed.id, { intent: claimed, executionRef: accepted.execution_ref });
			if (!this.#store.observeDispatch(owner.owner_id, owner.epoch, claimed.id, "accepted", accepted)) {
				this.#program.cancel(accepted.execution_ref);
				throw new Error("Program acceptance could not be recorded");
			}
		} catch (error) {
			if (error instanceof GraphBotLeaseUnavailable && botLaunch) {
				this.#waitingBots.set(claimed.id, { intent: claimed, launch: botLaunch });
				return;
			}
			this.#store.observeDispatch(owner.owner_id, owner.epoch, claimed.id, "unknown", { reason: String(error) });
		}
	}

	#assertQueueAttempt(intent: GraphDispatchIntent, dispatch = false): void {
		if (dispatch && this.#stopping) throw new Error("Graph host is stopping");
		const owner = this.#owner!;
		this.#store.assertHostOwner(owner.owner_id, owner.epoch);
		const run = this.#store.getRun(intent.run_id);
		const invocation = this.#store
			.getScheduleState?.(intent.run_id)
			?.invocations.find(item => item.id === intent.invocation_id);
		const current = this.#store.getDispatchIntents?.(intent.run_id).find(item => item.id === intent.id);
		const node = invocation && this.#store.getFrozenDefinition?.(intent.run_id)?.nodes[invocation.node];
		if (
			!run ||
			!invocation ||
			invocation.superseded ||
			invocation.attempt_id !== intent.attempt_id ||
			!current ||
			current.attempt_id !== intent.attempt_id ||
			current.fence !== intent.fence ||
			current.request_key !== intent.request_key ||
			!["submitting", "accepted", "unknown"].includes(current.state) ||
			node?.kind !== "queue" ||
			(dispatch &&
				(intent.fence !== owner.epoch ||
					invocation.state !== "running" ||
					!["queued", "running"].includes(run.state)))
		)
			throw new Error("Graph queue attempt is no longer authorized");
	}

	async #authorizeQueue(intent: GraphDispatchIntent, dispatch = false): Promise<void> {
		this.#assertQueueAttempt(intent, dispatch);
		if ((await this.#options.queue!.authorize(structuredClone(intent))) !== true)
			throw new Error("Queue authorization denied");
		this.#assertQueueAttempt(intent, dispatch);
	}

	async #dispatchQueue(intent: GraphDispatchIntent, executor: string | undefined): Promise<void> {
		const queue = this.#options.queue!;
		const request = structuredClone(await queue.resolve(structuredClone(intent)));
		if (
			!executor ||
			request.executor !== executor ||
			request.run_id !== intent.run_id ||
			request.invocation_id !== intent.invocation_id ||
			request.attempt_id !== intent.attempt_id ||
			request.fence !== intent.fence ||
			request.request_key !== intent.request_key
		)
			throw new Error("Resolved queue envelope does not match frozen dispatch");
		await this.#authorizeQueue(intent, true);
		const record = await queue.integration.adapter.submit(request);
		this.#queues.set(intent.id, intent);
		const owner = this.#owner!;
		if (
			!this.#store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "accepted", {
				service_id: record.service_id,
				request_key: record.request_key,
			})
		)
			throw new Error("Queue dispatch could not be recorded");
	}

	async #collectQueue(id: string, intent: GraphDispatchIntent): Promise<void> {
		const queue = this.#options.queue!;
		const owner = this.#owner!;
		try {
			await this.#authorizeQueue(intent);
			let record = await queue.integration.adapter.get(intent.request_key);
			const invocation = this.#store
				.getScheduleState?.(intent.run_id)
				?.invocations.find(item => item.id === intent.invocation_id);
			const node = invocation && this.#store.getFrozenDefinition?.(intent.run_id)?.nodes[invocation.node];
			if (!record || node?.kind !== "queue" || !queueRecordMatchesExecution(record, intent, node.executor))
				throw new Error("Queue record does not match dispatch");
			const run = this.#store.getRun(intent.run_id);
			if (!run) throw new Error("Queue run is unavailable");
			if (run.state === "cancelling" || run.state === "cancelled") {
				await this.#authorizeQueue(intent);
				if (!["succeeded", "failed", "cancelled", "cancelling"].includes(record.state))
					record = await queue.integration.adapter.cancel(intent.request_key);
				else if (record.state === "cancelling")
					record = await queue.integration.adapter.reconcile(intent.request_key);
				if (!["succeeded", "failed", "cancelled"].includes(record.state)) return;
			}
			if (!["succeeded", "failed", "cancelled"].includes(record.state)) {
				await this.#authorizeQueue(intent);
				record = await queue.integration.adapter.reconcile(intent.request_key, async () => {
					await this.#authorizeQueue(intent);
					const currentRun = this.#store.getRun(intent.run_id);
					if (!currentRun || !["queued", "running"].includes(currentRun.state))
						throw new Error("Queue retry is no longer authorized");
				});
			}
			if (!["succeeded", "failed", "cancelled"].includes(record.state)) return;
			if (this.#store.getRun(intent.run_id)?.state === "held") return;
			await this.#authorizeQueue(intent);
			const completion = structuredClone(await queue.verifyResult(structuredClone(intent), structuredClone(record)));
			if (
				completion.run_id !== intent.run_id ||
				completion.invocation_id !== intent.invocation_id ||
				completion.attempt_id !== intent.attempt_id ||
				completion.fence !== intent.fence ||
				completion.state !== record.state
			)
				throw new Error("Verified queue completion does not match execution");
			const refs = Object.values(completion.outputs ?? {})
				.map(ref => canonicalJson(ref))
				.sort();
			const reported = record.result_refs.map(ref => canonicalJson(ref)).sort();
			if (canonicalJson(refs) !== canonicalJson(reported))
				throw new Error("Verified queue outputs differ from service result");
			const artifacts = refs.length
				? await queue.prepareArtifacts?.(structuredClone(intent), structuredClone(record))
				: undefined;
			if (refs.length && !artifacts) throw new Error("Queue outputs require verified registration");
			await this.#authorizeQueue(intent);
			if (this.#store.getRun(intent.run_id)?.state === "held") return;
			if (!this.#store.completeAttempt(owner.owner_id, owner.epoch, completion, artifacts))
				throw new Error("Queue completion was not accepted");
			this.#queues.delete(id);
		} catch (error) {
			this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", { reason: String(error) });
			// Retain the durable identity for later authorized reconciliation. Never resubmit here.
		}
	}

	async #recoverBot(recovery: {
		intent: GraphDispatchIntent;
		worker?: GraphBotRecovery;
		runtime?: GraphBotWorker;
	}): Promise<void> {
		await recovery.runtime?.dispose();
		recovery.runtime = undefined;
		const { intent } = recovery;
		const owner = this.#owner!;
		const bot = this.#options.bot;
		if (!bot?.store) throw new Error("Bot recovery store is unavailable");
		const assertHost = () => {
			if (this.#stopping) throw new Error("Graph host is stopping");
			this.#store.assertHostOwner(owner.owner_id, owner.epoch);
		};
		assertHost();
		const launch = await bot.resolve(structuredClone(intent));
		assertHost();
		if (!launch?.job.bot_id) throw new Error("Bot recovery identity is unavailable");
		const hosted = bot.store.graphHostedByKey(launch.job.bot_id, intent.request_key);
		if (!hosted) throw new Error("Bot admission cannot be reconciled without durable identity");
		this.#assertFrozenBotSource(intent, launch.member_id, hosted.job);
		const run = this.#store.getRun(intent.run_id);
		const invocation = this.#store
			.getScheduleState?.(intent.run_id)
			?.invocations.find(item => item.id === intent.invocation_id);
		const definition = this.#store.getFrozenDefinition?.(intent.run_id);
		const node = invocation && definition?.nodes[invocation.node];
		const context = hosted.job.graph_context;
		const observation = intent.observation;
		if (
			!run ||
			!invocation ||
			!context ||
			context.graph_id !== run.graph_id ||
			context.graph_run_id !== intent.run_id ||
			context.invocation_id !== intent.invocation_id ||
			context.node_id !== invocation.node ||
			invocation.attempt_id !== intent.attempt_id ||
			invocation.superseded ||
			(invocation.consultation
				? invocation.consultation.member_id !== launch.member_id ||
					canonicalJson(invocation.consultation) !== canonicalJson(consultationReference(intent.request))
				: node?.kind !== "bot" || node.member !== launch.member_id) ||
			canonicalJson(context) !== canonicalJson(validateGraphContext(launch.job.graph_context)) ||
			(observation &&
				typeof observation === "object" &&
				"job_id" in observation &&
				observation.job_id !== hosted.job.job_id)
		)
			throw new Error("Recovered Bot job does not match the frozen Graph dispatch");
		recovery.worker ??= await GraphBotRecovery.open(bot.store, hosted.job, assertHost);
		await recovery.worker.attempt(assertHost);
		this.#recordBotUsage(intent, bot.store.getJob(hosted.job.bot_id, hosted.job.job_id));
		if (
			!this.#store.confirmBotRecovery?.(owner.owner_id, owner.epoch, intent.id, currentIntent => {
				assertHost();
				if (
					!recovery.worker?.hasLease() ||
					currentIntent.run_id !== intent.run_id ||
					currentIntent.invocation_id !== intent.invocation_id ||
					currentIntent.attempt_id !== intent.attempt_id ||
					currentIntent.request_key !== intent.request_key ||
					currentIntent.fence !== intent.fence
				)
					return null;
				const current = bot.store!.graphHostedByKey(launch.job.bot_id, currentIntent.request_key);
				if (
					!current ||
					current.job.job_id !== hosted.job.job_id ||
					canonicalJson(current.job.graph_context) !== canonicalJson(context) ||
					!current.job.settled ||
					current.job.ownership.state !== "none"
				)
					return null;
				return { bot_id: current.job.bot_id, job_id: current.job.job_id };
			})
		)
			throw new Error("Recovered Bot cleanup could not be committed");
		await recovery.worker.dispose();
		recovery.worker = undefined;
	}

	#assertFrozenBotSource(intent: GraphDispatchIntent, memberId: string, job: BotJob, current = false): void {
		const run = this.#store.getRun(intent.run_id);
		const snapshot = run && this.#store.getSnapshot?.(run.snapshot_ref);
		if (!snapshot) throw new Error("Frozen Graph snapshot is unavailable for Bot source verification");
		if (!snapshot.observation) return;
		const frozen = snapshot.observation.members[memberId];
		const bots = this.#options.bot?.store;
		if (
			!frozen ||
			!bots ||
			frozen.bot.profile_id !== bots.profile_id ||
			frozen.bot.bot_id !== job.bot_id ||
			frozen.config_revision !== job.config_revision ||
			(current && bots.getBot(job.bot_id).config_revision !== frozen.config_revision)
		)
			throw new Error("Bot execution does not match its frozen observation source");
	}

	#assertBotAttempt(intent: GraphDispatchIntent): void {
		if (this.#stopping) throw new Error("Graph host is stopping");
		const owner = this.#owner!;
		this.#store.assertHostOwner(owner.owner_id, owner.epoch);
		if (this.#store.getFrozenDefinition?.(intent.run_id)?.policy?.cost_limit !== undefined)
			throw new Error("Graph monetary ceiling has no trusted cost reservation authority");
		const run = this.#store.getRun(intent.run_id);
		const invocation = this.#store
			.getScheduleState?.(intent.run_id)
			?.invocations.find(item => item.id === intent.invocation_id);
		const current = this.#store.getDispatchIntents?.(intent.run_id).find(item => item.id === intent.id);
		if (
			intent.fence !== owner.epoch ||
			!run ||
			!["queued", "running", "held"].includes(run.state) ||
			!invocation ||
			invocation.superseded ||
			invocation.state !== "running" ||
			invocation.attempt_id !== intent.attempt_id ||
			!current ||
			current.invocation_id !== intent.invocation_id ||
			current.attempt_id !== intent.attempt_id ||
			current.fence !== intent.fence ||
			current.request_key !== intent.request_key ||
			!["submitting", "accepted"].includes(current.state)
		)
			throw new Error("Graph Bot attempt is no longer authorized");
	}

	async #dispatchBot(intent: GraphDispatchIntent, launch: GraphBotLaunch): Promise<void> {
		const owner = this.#owner!;
		const bot = this.#options.bot!;
		const store = this.#store;
		if (
			!store.getSnapshot ||
			!store.getFrozenDefinition ||
			!store.getScheduleState ||
			!store.getDispatchIntents ||
			!store.submitBotCompletion ||
			!store.getBotCompletion
		)
			throw new Error("Durable Bot admission and continuation capabilities are unavailable");
		this.#assertBotAttempt(intent);
		const run = store.getRun(intent.run_id)!;
		const snapshot = store.getSnapshot(run.snapshot_ref);
		const invocation = store
			.getScheduleState(intent.run_id)
			?.invocations.find(item => item.id === intent.invocation_id);
		const context = launch.job.graph_context;
		const frozen = snapshot?.members[launch.member_id];
		const definition = store.getFrozenDefinition(intent.run_id);
		const node = invocation && definition?.nodes[invocation.node];
		const member = definition?.members[launch.member_id];
		const binding = launch.assignment.bindings.filter(item => item.name === launch.assignment.member.model);
		if (
			!snapshot ||
			!invocation ||
			!context ||
			context.graph_id !== run.graph_id ||
			context.graph_run_id !== run.id ||
			context.invocation_id !== intent.invocation_id ||
			context.node_id !== invocation.node ||
			(invocation.consultation
				? invocation.consultation.member_id !== launch.member_id ||
					canonicalJson(invocation.consultation) !== canonicalJson(consultationReference(intent.request))
				: node?.kind !== "bot" || node.member !== launch.member_id) ||
			!member ||
			canonicalJson(member) !== canonicalJson(launch.assignment.member) ||
			!launch.job.job_id ||
			!frozen ||
			binding.length !== 1 ||
			binding[0].provider !== frozen.provider ||
			binding[0].model !== frozen.model ||
			binding[0].revision !== frozen.configuration_revision ||
			launch.assignment.member.base !== frozen.base
		)
			throw new Error("Bot launch does not match the frozen Graph assignment");
		this.#assertFrozenBotSource(intent, launch.member_id, launch.job, true);
		const identity: ConsultationIdentity = {
			run_id: intent.run_id,
			member_id: launch.member_id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
		};
		const consultation = launch.consultation ? this.#options.consultation : undefined;
		const consultationRef = consultationReference(intent.request);
		if (
			(launch.consultation && !consultation) ||
			(consultationRef && (!consultation || consultationRef.member_id !== identity.member_id))
		)
			throw new Error("Consultation recipient capability is unavailable");
		if (
			consultation &&
			(!store.waitForConsultation ||
				!store.resumeConsultation ||
				!store.startConsultationInvocation ||
				!store.finishConsultationInvocation)
		)
			throw new Error("Durable Graph consultation scheduling is unavailable");
		if (!bot.store) throw new Error("Durable Bot admission and continuation capabilities are unavailable");
		const requiresGuidance = definition.communications?.some(grant => grant.from === launch.member_id);
		const communications = requiresGuidance
			? store.getFrozenCommunicationInstructions?.(intent.run_id, launch.member_id)
			: undefined;
		if (requiresGuidance && !communications) throw new Error("Frozen Graph communication guidance is unavailable");
		let runtime: GraphBotWorker | undefined;
		const assignment: GraphBotAssignment = {
			...launch.assignment,
			context: prompt.render(botContext, { context: launch.assignment.context, communications }),
			tools: {
				// Only a live consultation recipient answers one message in place of owning a node.
				// A consult member dispatched as its own node completes that node like any member.
				consultRecipient: launch.consultation === true,
				completion: {
					submit: async input => {
						const candidate = structuredClone(input);
						// The completion key is host-assigned from the authenticated attempt: a model
						// retyping a long opaque identifier only corrupts the idempotency identity.
						candidate.request_key = `complete:${intent.attempt_id}`;
						this.#assertBotAttempt(intent);
						const artifacts = Object.keys(candidate.outputs).length
							? await bot.prepareArtifacts?.(structuredClone(intent), structuredClone(candidate))
							: undefined;
						this.#assertBotAttempt(intent);
						return store.submitBotCompletion!(
							owner.owner_id,
							owner.epoch,
							identity,
							candidate,
							bot.authorize,
							artifacts,
						);
					},
				},
				...(consultation
					? {
							consultation: {
								store: consultation,
								identity: () => {
									this.#assertBotAttempt(intent);
									return identity;
								},
								wait: async (_caller: ConsultationIdentity, conversationId: string, messageId: string) => {
									this.#assertBotAttempt(intent);
									if (
										!store.waitForConsultation!(
											owner.owner_id,
											owner.epoch,
											identity,
											conversationId,
											messageId,
										)
									)
										throw new Error("Graph consultation wait could not be recorded");
									try {
										if (!runtime) throw new Error("Bot consultation boundary is unavailable");
										return JSON.parse(await runtime.waitForGraphConsultation(conversationId, messageId)) as
											| { ok: true; value: ConsultationMessage }
											| { ok: false; error: "consultation_timeout" | "closed" };
									} catch (error) {
										store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "unknown", {
											reason: String(error),
										});
										throw error;
									}
								},
							},
						}
					: {}),
			},
		};
		const assertDispatch = (): void => {
			this.#assertBotAttempt(intent);
			launch.callbacks.assertDispatch?.();
		};
		const resolved = prepareGraphBot(assignment).binding;
		let initialMessage: ConsultationMessage | undefined;
		const prepareInput = (): string => {
			if (!consultationRef)
				return store.prepareBotHandoff?.(owner.owner_id, owner.epoch, intent.id, launch.input) ?? launch.input;
			assertDispatch();
			const admitted = consultation!.reserveDelivery(identity, consultationRef.message_id);
			if (
				!admitted.ok ||
				!admitted.value.claimed ||
				admitted.value.delivery.message.conversation_id !== consultationRef.conversation_id
			)
				throw new Error("Consultation request delivery could not be admitted");
			initialMessage = admitted.value.delivery.message;
			const conversation = consultation!.activate(consultationRef.conversation_id);
			if (conversation?.state !== "active") {
				consultation!.settleDelivery(identity, initialMessage.message_id, "unknown");
				throw new Error("Consultation is no longer active");
			}
			return prompt.render(consultationInput, { ...initialMessage });
		};
		try {
			assertDispatch();
			runtime = await GraphBotWorker.admit(
				bot.store,
				launch.job,
				intent.request_key,
				prepareInput,
				async (job, callbacks, options) => {
					this.#assertFrozenBotSource(intent, launch.member_id, job);
					const created = await (bot.createRuntime ?? createGraphBotRuntime)(
						job,
						{
							...callbacks,
							assertDispatch: () => {
								assertDispatch();
								callbacks.assertDispatch?.();
							},
						},
						assignment,
						{ ...launch.options, ...options },
					);
					return created.runtime;
				},
			);
			assertDispatch();
			if (!store.listHostRuns().some(item => item.id === intent.run_id))
				throw new Error("Run is no longer dispatchable");
			const observation = {
				job_id: runtime.job.job_id,
				bot_id: runtime.job.bot_id,
				session_file: runtime.state().session_file,
				binding: resolved,
			};
			const accepted = store.confirmBotHandoff
				? store.confirmBotHandoff(
						owner.owner_id,
						owner.epoch,
						intent.id,
						bot.store,
						runtime.job.job_id,
						observation,
					)
				: store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "accepted", observation);
			if (!accepted) throw new Error("Bot acceptance could not be recorded");
			this.#bots.set(intent.id, { intent, runtime, identity, settled: false, initialMessage });
		} catch (error) {
			if (!(error instanceof GraphBotLeaseUnavailable))
				this.#botRecoveries.set(intent.id, { intent, retryAt: 0, runtime });
			if (initialMessage) consultation!.settleDelivery(identity, initialMessage.message_id, "unknown");
			try {
				await runtime?.dispose();
			} catch {
				/* Recovery retains responsibility for unconfirmed cleanup. */
			}
			throw error;
		}
	}

	/** Called only after confirmed runtime cleanup, or a lease denial before mailbox admission. */
	#confirmBotStopped(intent: GraphDispatchIntent): boolean {
		const owner = this.#owner!;
		if (consultationReference(intent.request))
			return (
				this.#store.finishConsultationInvocation?.(owner.owner_id, owner.epoch, intent.id, "cancelled") === true
			);
		return this.#store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: intent.run_id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			state: "cancelled",
		});
	}

	#recordBotUsage(intent: GraphDispatchIntent, job: BotJob): void {
		const owner = this.#owner!;
		const bots = this.#options.bot?.store;
		if (bots) this.#store.recordBotUsage?.(owner.owner_id, owner.epoch, intent.id, bots, job.bot_id);
	}

	async #collectBot(
		id: string,
		active: {
			intent: GraphDispatchIntent;
			runtime: GraphBotWorker;
			settled: boolean;
			error?: unknown;
			continuing?: boolean;
		},
	): Promise<void> {
		const owner = this.#owner!;
		const { intent, runtime } = active;
		const run = this.#store.getRun(intent.run_id);
		if (!run || run.state === "cancelling" || run.state === "cancelled") {
			const service = this.#options.consultation;
			if (service) for (const conversation of service.list(intent.run_id)) service.cancel(conversation.id);
			const cleanupErrors: unknown[] = [];
			try {
				await runtime.stop(`graph-stop:${intent.id}`);
			} catch (error) {
				cleanupErrors.push(error);
			} finally {
				try {
					await runtime.dispose();
					this.#recordBotUsage(intent, runtime.job);
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			if (!cleanupErrors.length && run?.state === "cancelling") {
				try {
					if (!this.#confirmBotStopped(intent)) throw new Error("Confirmed Bot stop could not be committed");
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			if (cleanupErrors.length) {
				this.#botRecoveries.set(id, { intent: { ...intent, state: "accepted" }, retryAt: 0, runtime });
				this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", {
					reason: cleanupErrors.map(String).join("; "),
				});
			}
			this.#bots.delete(id);
			return;
		}
		// A hold pauses healthy Bots, but must not strand one whose delivery or execution failed.
		// Wait for the continuation to finish before disposing its runtime.
		if (active.continuing || (run.state === "held" && !active.error) || (!active.settled && !active.error)) return;
		try {
			if (active.error) throw active.error;
			const state = runtime.state();
			if (
				state.is_streaming ||
				state.waiting_input_count ||
				state.pending_background_count ||
				state.pending_delivery_count
			)
				return;
			const ref = consultationReference(intent.request);
			if (ref) {
				const service = this.#options.consultation;
				const conversation = service?.get(ref.conversation_id);
				const messages = service?.messages(ref.conversation_id);
				const last = messages?.[messages.length - 1];
				if (
					conversation?.state !== "answered" ||
					last?.kind !== "final" ||
					last.sender_attempt_id !== intent.attempt_id
				)
					throw new Error("Consultation Bot returned without its final answer");
				await runtime.dispose();
				this.#recordBotUsage(intent, runtime.job);
				if (!this.#store.finishConsultationInvocation?.(owner.owner_id, owner.epoch, id, "succeeded"))
					throw new Error("Consultation completion could not be committed");
				return;
			}
			const stored = this.#store.getBotCompletion?.(intent.attempt_id);
			if (!stored) throw new Error("Bot returned without a Graph completion candidate");
			await runtime.dispose();
			this.#recordBotUsage(intent, runtime.job);
			const registration = Object.keys(stored.candidate.outputs).length
				? await this.#options.bot?.prepareArtifacts?.(structuredClone(intent), structuredClone(stored.candidate))
				: undefined;
			if (Object.keys(stored.candidate.outputs).length && !registration)
				throw new Error("Bot output artifacts require verified registration");
			if (
				!this.#store.completeAttempt(
					owner.owner_id,
					owner.epoch,
					{
						run_id: intent.run_id,
						invocation_id: intent.invocation_id,
						attempt_id: intent.attempt_id,
						fence: intent.fence,
						state: "succeeded",
						outcome: stored.candidate.outcome,
						verdict: stored.candidate.verdict,
						outputs: stored.candidate.outputs,
					},
					registration,
				)
			)
				throw new Error("Bot completion could not be committed");
		} catch (error) {
			this.#botRecoveries.set(id, { intent: { ...intent, state: "accepted" }, retryAt: 0, runtime });
			try {
				await runtime.dispose();
			} catch {
				/* cleanup remains unconfirmed */
			}
			this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", { reason: String(error) });
		} finally {
			this.#bots.delete(id);
		}
	}

	async #collect(id: string, intent: GraphDispatchIntent, executionRef: string): Promise<void> {
		const owner = this.#owner!;
		const observed = this.#program.query(executionRef);
		const result = observed ? structuredClone(observed) : null;
		if (result && (result.state === "accepted" || result.state === "running")) return;
		try {
			if (!result || (result.state !== "succeeded" && result.state !== "failed"))
				throw new Error(result?.error ?? "Program execution cannot be reconciled");
			if (result.attempt_id !== intent.attempt_id || result.fence !== intent.fence)
				throw new Error("Program result identity mismatch");
			const completion = structuredClone(
				await this.#options.verifyProgramResult(structuredClone(intent), structuredClone(result)),
			);
			if (
				completion.run_id !== intent.run_id ||
				completion.invocation_id !== intent.invocation_id ||
				completion.attempt_id !== intent.attempt_id ||
				completion.fence !== intent.fence ||
				completion.state !== result.state
			)
				throw new Error("Verified program completion does not match execution");
			const outputNames = Object.keys(result.outputs).sort();
			if (
				JSON.stringify(outputNames) !== JSON.stringify(Object.keys(completion.outputs ?? {}).sort()) ||
				outputNames.some(
					name =>
						completion.outputs?.[name]?.id !== result.outputs[name].id ||
						completion.outputs?.[name]?.digest !== result.outputs[name].digest,
				)
			)
				throw new Error("Verified completion outputs differ from the execution result");
			const registration = outputNames.length
				? await this.#options.prepareProgramArtifacts?.(structuredClone(intent), structuredClone(result))
				: undefined;
			if (outputNames.length && !registration) throw new Error("Output artifacts require verified registration");
			const protectedCompletion = {
				...completion,
				outputs: Object.fromEntries(
					outputNames.map(name => [
						name,
						{
							id: result.outputs[name].id,
							digest: result.outputs[name].digest,
						},
					]),
				),
			};
			if (!this.#store.completeAttempt(owner.owner_id, owner.epoch, protectedCompletion, registration))
				throw new Error("Program completion was not accepted");
		} catch (error) {
			this.#store.observeDispatch(owner.owner_id, owner.epoch, id, "unknown", { reason: String(error), result });
		} finally {
			this.#active.delete(id);
		}
	}
}

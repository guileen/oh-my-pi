import type { BotRuntime, BotRuntimeCallbacks, BotRuntimeOptions, BotRuntimeState } from "../../bots/agent-runtime";
import type { BotStore } from "../../bots/store";
import type { BotJob } from "../../bots/types";
import { BotWorker } from "../../bots/worker";

/** No mailbox admission occurred; the host may wait for the Bot lease. */
export class GraphBotLeaseUnavailable extends Error {}

/** One fenced worker owns one admitted Graph job; no other Bot jobs are pumped. */
export class GraphBotWorker {
	readonly #worker: BotWorker;
	readonly #store: BotStore;
	readonly #botId: string;
	readonly #jobId: string;
	#closed = false;
	#disposed = false;
	#pending = new Map<string, { resolve(): void; reject(error: unknown): void }>();

	private constructor(store: BotStore, botId: string, jobId: string, worker: BotWorker) {
		this.#store = store;
		this.#botId = botId;
		this.#jobId = jobId;
		this.#worker = worker;
	}

	static async admit(
		store: BotStore,
		template: BotJob,
		key: string,
		input: () => string,
		factory: (
			job: BotJob,
			callbacks: BotRuntimeCallbacks,
			options?: Pick<BotRuntimeOptions, "session_dir" | "owner_epoch" | "session_owner_id">,
		) => Promise<BotRuntime>,
	): Promise<GraphBotWorker> {
		const botId = template.bot_id;
		const worker = new BotWorker(store, botId, factory, { scoped: true });
		if (!worker.claim()) throw new GraphBotLeaseUnavailable("Bot worker ownership is unavailable");
		try {
			const receipt = worker.admitGraph({
				command: "submit",
				key,
				input: input(),
				graph_context: template.graph_context,
			});
			if (!receipt.job_id) throw new Error("Bot admission did not create a job");
			const job = store.getJob(botId, receipt.job_id);
			if (
				job.state !== "queued" ||
				job.ownership.state !== "none" ||
				job.execution_id !== null ||
				store.request(botId, receipt.request_id).outcome !== "pending"
			)
				throw new Error("Bot admission was already consumed");
			worker.bindJob(job.job_id);
			return new GraphBotWorker(store, botId, job.job_id, worker);
		} catch (error) {
			await worker.close();
			throw error;
		}
	}

	get job(): BotJob {
		return this.#store.getJob(this.#botId, this.#jobId);
	}
	state(): BotRuntimeState {
		const job = this.job;
		return {
			pending_background_count: job.pending_background_count,
			pending_delivery_count: job.pending_delivery_count,
			waiting_input_count: job.input_requests.length,
			waiting_input_requests: job.input_requests,
			is_streaming: job.state === "running",
			context: job.context,
			model: job.model.current ?? "",
			progress: job.progress,
			session_file: job.session_file,
		};
	}
	waitForGraphConsultation(conversationId: string, messageId: string): Promise<string> {
		return this.#worker.waitForGraphConsultation(this.#jobId, conversationId, messageId);
	}
	async tick(): Promise<void> {
		try {
			await this.#worker.tick();
		} catch (error) {
			for (const pending of this.#pending.values()) pending.reject(error);
			this.#pending.clear();
			throw error;
		}
		const job = this.job;
		for (const [requestId, pending] of this.#pending) {
			const request = this.#store.request(this.#botId, requestId);
			if (
				request.outcome === "rejected" ||
				request.outcome === "cancelled" ||
				["failed", "interrupted", "stopped"].includes(job.state)
			) {
				this.#pending.delete(requestId);
				pending.reject(new Error("Bot reply was not delivered"));
			} else if (
				request.outcome === "applied" &&
				!job.input_requests.some(item => item.reply_request_id === requestId)
			) {
				this.#pending.delete(requestId);
				pending.resolve();
			}
		}
	}
	reply(inputRequestId: string, input: string, key: string): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Bot worker is closed"));
		const receipt = this.#worker.admitGraphControl({
			command: "send",
			job_id: this.#jobId,
			reply_to: inputRequestId,
			input,
			key,
		});
		if (this.#pending.has(receipt.request_id)) return Promise.reject(new Error("Bot reply is already pending"));
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#pending.set(receipt.request_id, { resolve, reject });
		return promise;
	}
	async stop(key: string): Promise<void> {
		const job = this.job;
		if (!["stopped", "failed", "interrupted"].includes(job.state)) {
			const receipt = this.#worker.admitGraphControl({ command: "stop", job_id: this.#jobId, key });
			await this.#worker.tick();
			if (this.#store.request(this.#botId, receipt.request_id).outcome !== "applied")
				throw new Error("Bot stop could not be confirmed");
		}
		const stopped = this.job;
		if (!stopped.settled || stopped.ownership.state !== "none")
			throw new Error("Bot stop cleanup could not be confirmed");
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#closed = true;
		for (const pending of this.#pending.values())
			pending.reject(new Error("Bot worker closed before reply delivery"));
		this.#pending.clear();
		await this.#worker.close();
		this.#disposed = true;
	}
}

/** Retains one fenced worker and one pending receipt across cleanup retries. */
export class GraphBotRecovery {
	private constructor(
		private readonly store: BotStore,
		private readonly job: BotJob,
		private readonly worker: BotWorker,
	) {}

	static async open(store: BotStore, job: BotJob, assertHost: () => void): Promise<GraphBotRecovery> {
		assertHost();
		const worker = new BotWorker(
			store,
			job.bot_id,
			async () => {
				throw new Error("Graph cleanup cannot create a model runtime");
			},
			{ scoped: true },
		);
		if (!worker.claim()) throw new GraphBotLeaseUnavailable("Bot recovery ownership is unavailable");
		try {
			assertHost();
			worker.bindJob(job.job_id);
			const current = store.getJob(job.bot_id, job.job_id);
			if (current.ownership.state === "none" && !current.settled)
				store.interruptOwnership(job.bot_id, job.job_id, {
					code: "worker_lost",
					message: "Prior execution ended without confirmed cleanup; resume explicitly",
					retryable: false,
				});
			return new GraphBotRecovery(store, job, worker);
		} catch (error) {
			await worker.close();
			throw error;
		}
	}

	async attempt(assertHost: () => void): Promise<void> {
		assertHost();
		const current = this.store.getJob(this.job.bot_id, this.job.job_id);
		if (current.ownership.state === "none" && current.settled) return;
		const key = `graph-recovery-pending:${this.job.job_id}`;
		const prior = this.store.graphControlByKey(this.job.bot_id, this.job.job_id, key);
		if (prior && prior.outcome !== "pending") throw new Error("Graph Bot recovery receipt is already finalized");
		const receipt =
			prior?.receipt ?? this.worker.admitGraphControl({ command: "stop", job_id: this.job.job_id, key });
		assertHost();
		await this.worker.recoverGraphJob(receipt.request_id, assertHost);
		assertHost();
		const recovered = this.store.getJob(this.job.bot_id, this.job.job_id);
		if (
			this.store.request(this.job.bot_id, receipt.request_id).outcome !== "applied" ||
			recovered.state !== "stopped" ||
			!recovered.settled ||
			recovered.ownership.state !== "none"
		)
			throw new Error("Recovered Bot cleanup was not confirmed");
	}

	hasLease(): boolean {
		return this.worker.hasLease();
	}

	async dispose(): Promise<void> {
		await this.worker.close();
	}
}

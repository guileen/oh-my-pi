import * as path from "node:path";
import { isFileLockHeld } from "@oh-my-pi/pi-utils";
import { BotHost } from "./host";
import { BotStore } from "./store";
import {
	BotError,
	type BotCommand,
	type BotDefinition,
	type BotEvent,
	type CreateBotInput,
	type Cursor,
	type EventOptions,
	type Page,
	type Receipt,
	type RefProjection,
	type RequestProjection,
	type Snapshot,
	type SnapshotOptions,
} from "./types";

export interface BotTargetOptions {
	expect_bot_id?: string;
}

export interface BotWatchOptions extends BotTargetOptions {
	job_id?: string;
	since?: Cursor;
	signal?: AbortSignal;
}
export interface BotServiceOptions {
	ensure_worker?: (botId: string) => Promise<void>;
}

/** CLI/read facade. Model and AgentSession dependencies belong only to the worker. */
export class BotService {
	readonly store: BotStore;
	readonly #host: BotHost;
	readonly #ensureWorker: (botId: string) => Promise<void>;

	constructor(root?: string, options: BotServiceOptions = {}) {
		this.store = new BotStore(root);
		this.#host = new BotHost(this.store.root);
		this.#ensureWorker = options.ensure_worker ?? (id => this.#host.ensure(id));
	}

	async create(input: CreateBotInput): Promise<BotDefinition> {
		return this.store.createBot(input);
	}

	list(): BotDefinition[] {
		return this.store.listBots();
	}

	async submit(name: string, command: BotCommand, options: BotTargetOptions = {}): Promise<Receipt> {
		const { bot, receipt } = this.store.withBot(name, options.expect_bot_id, bot => ({
			bot,
			receipt: this.store.admit(bot.bot_id, command),
		}));
		if (this.store.request(bot.bot_id, receipt.request_id).outcome !== "pending") return receipt;
		try {
			await this.#ensureWorker(bot.bot_id);
		} catch {
			this.store.rejectPendingLaunch(bot.bot_id, receipt.request_id, {
				code: "worker_unavailable",
				message: "Unable to launch the managed Bot worker",
				retryable: true,
			});
			// Admission succeeded; its durable outcome carries the launch failure.
		}
		return receipt;
	}

	status(name: string, jobId?: string, options: SnapshotOptions & BotTargetOptions = {}): Snapshot {
		return this.store.withBot(name, options.expect_bot_id, bot => {
			this.#reconcile(bot.bot_id);
			return this.store.snapshot(bot.bot_id, { ...options, job_id: jobId ?? options.job_id });
		});
	}

	request(name: string, requestId: string, options: BotTargetOptions = {}): RequestProjection {
		return this.store.withBot(name, options.expect_bot_id, bot => this.store.request(bot.bot_id, requestId));
	}

	events(name: string, options: EventOptions & BotTargetOptions = {}): Page<BotEvent> {
		return this.store.withBot(name, options.expect_bot_id, bot => this.store.events(bot.bot_id, options));
	}

	messages(
		name: string,
		jobId: string,
		options: { page_token?: string; limit?: number } & BotTargetOptions = {},
	): Page<unknown> {
		return this.store.withBot(name, options.expect_bot_id, bot =>
			this.store.messages(bot.bot_id, jobId, options.page_token, options.limit),
		);
	}

	inspect(
		name: string,
		ref: string,
		options: { page_token?: string; job_id?: string } & BotTargetOptions = {},
	): RefProjection {
		return this.store.withBot(name, options.expect_bot_id, bot =>
			this.store.inspect(bot.bot_id, ref, options.page_token, options.job_id),
		);
	}

	async *watch(name: string, options: BotWatchOptions = {}): AsyncIterable<unknown> {
		// Resolve and validate once under the admission/read lock. Never route an attached
		// viewer through the mutable name again, even when that name is recreated.
		const { bot, pages } = this.store.withBot(name, options.expect_bot_id, bot => {
			this.#reconcile(bot.bot_id);
			if (options.job_id) this.store.getJob(bot.bot_id, options.job_id);
			if (options.since) {
				this.store.events(bot.bot_id, { after: options.since, job_id: options.job_id, limit: 1 });
				return { bot, pages: null };
			}
			return { bot, pages: this.store.snapshotPages(bot.bot_id, options.job_id, 100) };
		});
		let cursor: Cursor;
		if (options.since) {
			cursor = options.since;
		} else if (pages) {
			cursor = pages[0].cursor;
			if (pages.length === 1) yield pages[0];
			else {
				const snapshotId = crypto.randomUUID();
				const envelope = {
					schema_version: 1,
					profile_id: this.store.profile_id,
					snapshot_id: snapshotId,
					cursor,
					capabilities: pages[0].capabilities,
				};
				yield { ...envelope, kind: "snapshot.begin", bot: pages[0].bot, page_count: pages.length };
				for (let page = 0; page < pages.length; page++) {
					yield { ...envelope, kind: "snapshot.page", page: page + 1, jobs: pages[page].jobs };
				}
				yield { ...envelope, kind: "snapshot.end" };
			}
		} else throw new BotError("internal_error", "Watch bootstrap did not produce a snapshot");
		let lastFrame = Date.now();
		const assertConsumerReady = (): void => {
			if (Date.now() - lastFrame > 30_000)
				throw new BotError(
					"slow_consumer",
					"Observation consumer is too slow; reconnect after the last cursor",
					{ cursor, reset_required: false },
					true,
				);
		};
		while (!options.signal?.aborted) {
			this.#reconcile(bot.bot_id);
			const page = this.store.events(bot.bot_id, { after: cursor, job_id: options.job_id, limit: 100 });
			for (const event of page.items) {
				if (options.signal?.aborted) return;
				assertConsumerReady();
				cursor = event.cursor;
				lastFrame = Date.now();
				yield event;
			}
			assertConsumerReady();
			if (page.items.length === 100) continue;
			if (Date.now() - lastFrame >= 5_000) {
				lastFrame = Date.now();
				yield { schema_version: 1, kind: "heartbeat", cursor, observed_at: new Date().toISOString() };
			}
			await Bun.sleep(100);
		}
	}

	#reconcile(botId: string): void {
		const lease = this.store.workerLease(botId);
		if (!lease || Date.parse(lease.expires_at) > Date.now()) return;
		// An expired heartbeat alone is not proof that its owner is dead.
		try {
			process.kill(lease.pid, 0);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
		}
		if (isFileLockHeld(path.join(this.store.root, `${botId}.worker`))) return;
		const worker = this.store.workerSample(botId);
		// Recheck both observed values transactionally: a replacement owner/sample
		// must never be overwritten by an observer of the expired predecessor.
		this.store.reconcileOffline(botId, lease, worker);
	}

	async close(): Promise<void> {
		try {
			await this.#host.close();
		} finally {
			this.store.close();
		}
	}
}

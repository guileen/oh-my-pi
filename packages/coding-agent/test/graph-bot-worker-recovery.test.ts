import { Database } from "bun:sqlite";
import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BotStore } from "../src/bots/store";
import { BotWorker } from "../src/bots/worker";
import { GraphBotRecovery, GraphBotWorker } from "../src/graph/executors/bot-worker";
import * as daemonClient from "../src/launch/client";
import type { DaemonBrokerClient } from "../src/launch/client";
import { GraphHost } from "../src/graph/host";
import { GraphRunStore } from "../src/graph/store";

it("reconciles a lost hosted activation without a default model or replaying its input", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-bot-recovery-"));
	const store = new BotStore(root);
	const bot = store.createBot({ bot_name: "recovery", cwd: root });
	const owner = new BotWorker(store, bot.bot_id, undefined, { scoped: true });
	let recovery: GraphBotRecovery | undefined;
	try {
		expect(owner.claim()).toBe(true);
		const context = {
			graph_id: "graph",
			graph_run_id: "run",
			invocation_id: "invocation",
			node_id: "node",
			attempt: 1,
			upstream: [],
		};
		const receipt = owner.admitGraph({
			command: "submit",
			key: "dispatch",
			input: "must not run",
			graph_context: context,
		});
		owner.bindJob(receipt.job_id!);
		const rejected = owner.admitGraphControl({
			command: "stop",
			job_id: receipt.job_id!,
			key: `graph-recovery:${receipt.job_id!}:0`,
		});
		store.finishRequest(bot.bot_id, rejected.request_id, "rejected", {
			code: "cleanup_failed",
			message: "Temporary cleanup failure",
			retryable: true,
		});
		await owner.close();
		store.interruptOwnership(bot.bot_id, receipt.job_id!, {
			code: "worker_lost",
			message: "Lost activation",
			retryable: false,
		});
		const hosted = store.graphHostedByKey(bot.bot_id, "dispatch")!;
		expect(hosted.job.job_id).toBe(receipt.job_id!);
		recovery = await GraphBotRecovery.open(store, hosted.job, () => {});
		await recovery.attempt(() => {});
		const recovered = store.getJob(bot.bot_id, receipt.job_id!);
		expect(recovered.state).toBe("stopped");
		expect(recovered.execution_id).toBeNull();
		expect(recovered.ownership.state).toBe("none");
	} finally {
		await recovery?.dispose();
		await owner.close();
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("does not treat interrupted unsettled ownership as confirmed stop", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-bot-interrupted-stop-"));
	const store = new BotStore(root);
	const bot = store.createBot({ bot_name: "recovery", cwd: root });
	let worker: GraphBotWorker | undefined;
	let recovery: GraphBotRecovery | undefined;
	try {
		worker = await GraphBotWorker.admit(
			store,
			{
				bot_id: bot.bot_id,
				graph_context: {
					graph_id: "graph",
					graph_run_id: "run",
					invocation_id: "invocation",
					node_id: "node",
					attempt: 1,
					upstream: [],
				},
			} as never,
			"dispatch",
			() => "must not run",
			async () => {
				throw new Error("model must not run");
			},
		);
		const jobId = worker.job.job_id;
		store.interruptOwnership(bot.bot_id, jobId, {
			code: "worker_lost",
			message: "cleanup uncertain",
			retryable: false,
		});
		await expect(worker.stop("stop")).rejects.toThrow("cleanup could not be confirmed");
		await worker.dispose();
		recovery = await GraphBotRecovery.open(store, store.getJob(bot.bot_id, jobId), () => {});
		await recovery.attempt(() => {});
		expect(store.getJob(bot.bot_id, jobId)).toMatchObject({
			state: "stopped",
			settled: true,
			ownership: { state: "none" },
		});
		expect(store.events(bot.bot_id, { limit: 1000 }).items.some(event => event.type === "execution.started")).toBe(
			false,
		);
	} finally {
		await recovery?.dispose();
		await worker?.dispose();
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("retries stable uncertain cleanup without growing receipts or events", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-bot-recovery-evidence-"));
	const store = new BotStore(root);
	const bot = store.createBot({ bot_name: "recovery", cwd: root });
	const owner = new BotWorker(store, bot.bot_id, undefined, { scoped: true });
	let recovery: GraphBotRecovery | undefined;
	try {
		expect(owner.claim()).toBe(true);
		const receipt = owner.admitGraph({
			command: "submit",
			key: "dispatch",
			input: "must not run",
			graph_context: {
				graph_id: "graph",
				graph_run_id: "run",
				invocation_id: "invocation",
				node_id: "node",
				attempt: 1,
				upstream: [],
			},
		});
		owner.bindJob(receipt.job_id!);
		await owner.close();
		store.interruptOwnership(bot.bot_id, receipt.job_id!, {
			code: "worker_lost",
			message: "Lost activation",
			retryable: false,
		});
		store.updateJob(bot.bot_id, receipt.job_id!, { pending_background_count: 1 });
		recovery = await GraphBotRecovery.open(store, store.getJob(bot.bot_id, receipt.job_id!), () => {});
		const admissions = vi.spyOn(store, "admitGraphControl");
		await expect(recovery.attempt(() => {})).rejects.toThrow();
		const eventCount = store.events(bot.bot_id, { limit: 1000 }).items.length;
		for (let attempt = 0; attempt < 10; attempt++) await expect(recovery.attempt(() => {})).rejects.toThrow();
		expect(admissions).toHaveBeenCalledTimes(1);
		expect(store.events(bot.bot_id, { limit: 1000 }).items).toHaveLength(eventCount);
		expect(store.getJob(bot.bot_id, receipt.job_id!).ownership.state).toBe("uncertain");

		// A host restart also reuses the pending receipt rather than creating another one.
		await recovery.dispose();
		recovery = await GraphBotRecovery.open(store, store.getJob(bot.bot_id, receipt.job_id!), () => {});

		store.updateJob(bot.bot_id, receipt.job_id!, { pending_background_count: 0 });
		await recovery.attempt(() => {});
		expect(admissions).toHaveBeenCalledTimes(1);
		const recovered = store.getJob(bot.bot_id, receipt.job_id!);
		expect(recovered.state).toBe("stopped");
		expect(recovered.settled).toBe(true);
		expect(recovered.ownership.state).toBe("none");
	} finally {
		await recovery?.dispose();
		await owner.close();
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

for (const failedOperation of ["connect", "fence_owner", "list", "stop_owned"] as const) {
	it(`retries a transient ${failedOperation} failure with unchanged durable evidence`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-bot-retry-"));
		const store = new BotStore(root);
		const bot = store.createBot({ bot_name: "recovery", cwd: root });
		const owner = new BotWorker(store, bot.bot_id, undefined, { scoped: true });
		let recovery: GraphBotRecovery | undefined;
		let fail = true;
		let stopped = false;
		const calls: string[] = [];
		const daemon = { id: "service", name: "owned", owner: "session", startedAt: 123, state: "running" };
		const broker = {
			request: async (operation: Record<string, unknown>) => {
				calls.push(String(operation.op));
				if (fail && operation.op === failedOperation) throw new Error("temporary broker failure");
				switch (operation.op) {
					case "fence_owner":
						return { op: "fence_owner", fenced_through_epoch: operation.through_epoch };
					case "list":
						return { op: "list", daemons: [{ ...daemon, state: stopped ? "exited" : "running" }] };
					case "stop_owned":
						stopped = true;
						return { op: "stop_owned", daemon: { ...daemon, state: "exited" } };
					default:
						throw new Error("Unexpected broker operation");
				}
			},
		} as unknown as DaemonBrokerClient;
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockImplementation(async () => {
			if (fail && failedOperation === "connect") throw new Error("temporary connection failure");
			return broker;
		});
		try {
			expect(owner.claim()).toBe(true);
			const receipt = owner.admitGraph({
				command: "submit",
				key: "dispatch",
				input: "must not run",
				graph_context: {
					graph_id: "graph",
					graph_run_id: "run",
					invocation_id: "invocation",
					node_id: "node",
					attempt: 1,
					upstream: [],
				},
			});
			const lease = store.workerLease(bot.bot_id)!;
			store.finishRequest(bot.bot_id, receipt.request_id, "applied");
			store.claimInput(bot.bot_id, receipt.job_id!, receipt.request_id, lease.owner_id, lease.owner_epoch);
			store.setSessionOwner(bot.bot_id, receipt.job_id!, "session", lease.owner_epoch);
			store.updateRuntimeState(bot.bot_id, receipt.job_id!, { pending_background_count: 1 }, [
				{ id: daemon.id, name: daemon.name, started_at: daemon.startedAt },
			]);
			await owner.close();
			recovery = await GraphBotRecovery.open(store, store.getJob(bot.bot_id, receipt.job_id!), () => {});
			const admissions = vi.spyOn(store, "admitGraphControl");
			await expect(recovery.attempt(() => {})).rejects.toThrow();
			const before = store.getJob(bot.bot_id, receipt.job_id!);
			const eventCount = store.events(bot.bot_id, { limit: 1000 }).items.length;
			fail = false;
			await recovery.attempt(() => {});
			expect(before.ownership.state).toBe("uncertain");
			expect(admissions).toHaveBeenCalledTimes(1);
			expect(store.getJob(bot.bot_id, receipt.job_id!)).toMatchObject({
				state: "stopped",
				settled: true,
				ownership: { state: "none" },
			});
			expect(store.events(bot.bot_id, { limit: 1000 }).items.length).toBeGreaterThan(eventCount);
			expect(calls.filter(call => call === "list").length).toBeGreaterThan(0);
			expect(store.events(bot.bot_id, { limit: 1000 }).items.some(event => event.type === "execution.started")).toBe(
				false,
			);
		} finally {
			spy.mockRestore();
			await recovery?.dispose();
			await owner.close();
			store.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

for (const scenario of [
	"hold",
	"cancel",
	"cleanup-retry",
	"journal-retry",
	"dispose-retry",
	"identity-mismatch",
] as const) {
	it(`reconciles lost Bot admission without replay: ${scenario}`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-host-recovery-"));
		const graphRoot = path.join(root, "graphs");
		const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
		let graphs = new GraphRunStore(limits, graphRoot);
		const bots = new BotStore(path.join(root, "bots"));
		let host: GraphHost | undefined;
		let journal: Database | undefined;
		try {
			const bot = bots.createBot({ bot_name: "recovery", cwd: root });
			const content = `---
format: omp.graph/v1
name: recovery
members:
  reviewer:
    role: '#role'
    model: binding
    base: isolated
    duty: review
    permissions: {read: [], write: [], execute: []}
nodes:
  review: {kind: bot, member: reviewer, task: '#task', outcomes: [done]}
---
## role
Review.
## task
Inspect.
`;
			const imported = graphs.definitions.mutate({
				version: 1,
				request_key: "import",
				operation: "import",
				target_id: null,
				if_revision: null,
				payload: { content },
			});
			const definition = graphs.definitions.get(imported.target_id!)!;
			const ref = { id: "grant", digest: "sha256:grant" };
			const started = graphs.start(
				{
					version: 1,
					request_key: "start",
					operation: "start",
					target_id: definition.graph_id,
					if_revision: definition.revision,
					payload: { inputs: {}, authorization_ref: ref },
				},
				{
					graph_id: definition.graph_id,
					definition_revision: definition.revision,
					definition_digest: definition.digest,
					authorization_ref: ref,
					inputs: {},
					executors: {},
					members: {
						reviewer: {
							provider: "provider",
							model: "model",
							configuration_revision: "1",
							base: "isolated",
							base_snapshot_ref: ref,
							role_ref: ref,
							skill_refs: [],
							rule_refs: [],
						},
					},
				},
			);
			const owner = graphs.claimHost()!;
			graphs.schedule(started.target_id!, owner.owner_id, owner.epoch);
			const intent = graphs.schedule(started.target_id!, owner.owner_id, owner.epoch).intent!;
			expect(graphs.claimDispatch(owner.owner_id, owner.epoch, intent.id)).not.toBeNull();
			const context = {
				graph_id: definition.graph_id,
				graph_run_id: intent.run_id,
				invocation_id: intent.invocation_id,
				node_id: "review",
				attempt: 1,
				upstream: [],
			};
			const worker = new BotWorker(bots, bot.bot_id, undefined, { scoped: true });
			expect(worker.claim()).toBe(true);
			const receipt = worker.admitGraph({
				command: "submit",
				key: intent.request_key,
				input: "never replay",
				graph_context: context,
			});
			// The durable mailbox normalizes an omitted trace ID to null.
			expect(bots.getJob(bot.bot_id, receipt.job_id!).graph_context?.trace_id).toBeNull();
			worker.bindJob(receipt.job_id!);
			await worker.close();
			graphs.close();
			graphs = new GraphRunStore(limits, graphRoot);
			let resolutions = 0;
			if (scenario !== "hold") {
				graphs.configureLifecycle({ authorize: () => true, verifyResume: () => false });
				expect(
					graphs.mutateLifecycle("owner", {
						version: 1,
						request_key: "cancel",
						operation: "cancel",
						target_id: started.target_id!,
						if_revision: graphs.getRun(started.target_id!)!.revision,
						payload: { reason: "Stop interrupted Bot" },
					}).state,
				).toBe("completed");
			}
			const attempt = GraphBotRecovery.prototype.attempt;
			let cleanups = 0;
			const cleanup = vi
				.spyOn(GraphBotRecovery.prototype, "attempt")
				.mockImplementation(async function (this: GraphBotRecovery, assertHost) {
					if (scenario === "cleanup-retry" && ++cleanups === 1) throw new Error("temporary cleanup failure");
					return attempt.call(this, assertHost);
				});
			if (scenario === "journal-retry") {
				journal = new Database(path.join(graphRoot, "graphs.sqlite"));
				journal.exec(
					"CREATE TRIGGER fail_recovery BEFORE INSERT ON graph_events WHEN json_extract(NEW.data, '$.type')='bot.recovery_confirmed' BEGIN SELECT RAISE(ABORT, 'journal failure'); END",
				);
			}
			const dispose = GraphBotRecovery.prototype.dispose;
			let disposals = 0;
			vi.spyOn(GraphBotRecovery.prototype, "dispose").mockImplementation(async function (this: GraphBotRecovery) {
				if (scenario === "dispose-retry" && ++disposals === 1) throw new Error("temporary lease release failure");
				return dispose.call(this);
			});
			host = new GraphHost({
				store: graphs,
				program: {
					accept: async () => {
						throw new Error("unexpected");
					},
					query: () => null,
					cancel: () => "unknown",
				},
				resolveProgram: async () => {
					throw new Error("unexpected");
				},
				verifyProgramResult: async () => {
					throw new Error("unexpected");
				},
				bot: {
					store: bots,
					authorize: () => true,
					resolve: async () => {
						if (++resolutions === 1) throw new Error("temporary resolver failure");
						return {
							job: {
								bot_id: bot.bot_id,
								graph_context: scenario === "identity-mismatch" ? { ...context, node_id: "other" } : context,
							} as never,
							member_id: "reviewer",
							input: "never replay",
							callbacks: { onEvent() {} },
							assignment: {
								member: graphs.getFrozenDefinition(intent.run_id)!.members.reviewer,
								role: "Review",
								task: "Inspect",
								bindings: [],
								modelRegistry: {} as never,
								baseAvailable: true,
								assertToolCall: () => {},
							},
						};
					},
				},
			});
			expect(host.start()).toBe(true);
			if (scenario === "cancel") {
				expect(() =>
					graphs.confirmBotRecovery(owner.owner_id, owner.epoch, intent.id, () => {
						throw new Error("stale owner must not invoke recovery authority");
					}),
				).toThrow("Graph host ownership is stale");
				const current = graphs.claimHost()!;
				expect(graphs.confirmBotRecovery(current.owner_id, current.epoch, intent.id, () => null)).toBe(false);
				expect(
					graphs.completeAttempt(current.owner_id, current.epoch, {
						run_id: intent.run_id,
						invocation_id: intent.invocation_id,
						attempt_id: intent.attempt_id,
						fence: intent.fence,
						state: "cancelled",
					}),
				).toBe(false);
				expect(graphs.getRun(started.target_id!)?.state).toBe("cancelling");
			}
			await host.tick();
			expect(bots.getJob(bot.bot_id, receipt.job_id!).state).toBe("queued");
			const future = Date.now() + 2000;
			const clock = vi.spyOn(Date, "now").mockReturnValue(future);
			try {
				await host.tick();
			} finally {
				clock.mockRestore();
			}
			if (["cleanup-retry", "journal-retry", "dispose-retry"].includes(scenario)) {
				expect(graphs.getRun(started.target_id!)?.state).toBe(
					scenario === "dispose-retry" ? "cancelled" : "cancelling",
				);
				expect(graphs.getDispatchIntents(started.target_id!)[0].state).toBe(
					scenario === "dispose-retry" ? "finished" : "unknown",
				);
				journal?.exec("DROP TRIGGER fail_recovery");
				const retryClock = vi.spyOn(Date, "now").mockReturnValue(future + 2000);
				try {
					await host.tick();
				} finally {
					retryClock.mockRestore();
				}
			}
			cleanup.mockRestore();
			if (scenario === "identity-mismatch") {
				expect(graphs.getDispatchIntents(started.target_id!)[0].state).toBe("unknown");
				expect(graphs.getRun(started.target_id!)?.state).toBe("cancelling");
				expect(bots.getJob(bot.bot_id, receipt.job_id!).state).toBe("queued");
			} else {
				expect(graphs.getDispatchIntents(started.target_id!)[0].state).toBe("finished");
				expect(graphs.getRun(started.target_id!)?.state).toBe(scenario === "hold" ? "held" : "cancelled");
				expect(graphs.getScheduleState(started.target_id!)?.invocations[0].state).toBe(
					scenario === "hold" ? "failed" : "cancelled",
				);
				const revision = graphs.getRun(started.target_id!)!.revision;
				await host.tick();
				expect(graphs.getRun(started.target_id!)!.revision).toBe(revision);
				const job = bots.getJob(bot.bot_id, receipt.job_id!);
				expect(job.state).toBe("stopped");
				expect(job.execution_id).toBeNull();
				expect(job.ownership.state).toBe("none");
				expect(graphs.getAttemptHistory(started.target_id!).filter(item => item.accepted)).toHaveLength(1);
			}
			expect(bots.events(bot.bot_id, { limit: 1000 }).items.some(event => event.type === "execution.started")).toBe(
				false,
			);
		} finally {
			await host?.shutdown();
			vi.restoreAllMocks();
			bots.close();
			journal?.close();
			graphs.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

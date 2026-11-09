import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BotStore } from "../src/bots/store";
import { BotWorker } from "../src/bots/worker";
import type { ChildExecutionHost, ChildIdentity } from "../src/graph/child-execution";
import type { ChildOutputBindings } from "../src/graph/child-outputs";
import type { ProgramExecutionRequest, ProgramResult } from "../src/graph/executors/program";
import { GraphHost } from "../src/graph/host";
import { GraphRunStore, type GraphDispatchIntent, type GraphSerialChildAggregation } from "../src/graph/store";
import { GraphWireLedger } from "../src/graph/wire-ledger";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const roots: string[] = [];
const stores: GraphRunStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(
	kind: "subgraph" | "program" = "subgraph",
	withBudget = true,
	withOutputs = false,
	observed = false,
	sibling = false,
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-child-safety-"));
	roots.push(root);
	const store = new GraphRunStore(limits, root);
	stores.push(store);
	const member = {
		bot: { id: "bot", digest: "sha256:abc" },
		model: "model",
		base: "omp-default",
		duty: "code-only",
		permissions: { read: ["src"], write: ["src"], execute: [] },
	};
	const graph = {
		format: "omp.graph/v1",
		name: "parent",
		members: { owner: member },
		nodes: {
			build:
				kind === "subgraph"
					? {
							kind: "subgraph",
							task: "#task",
							member: "owner",
							writes: ["src"],
							...(withOutputs ? { outputs: { result: { media_type: "text/markdown", required: true } } } : {}),
							...(withBudget ? { consume: ["quota"] } : {}),
							child_policy: { kinds: ["bot"], max_nodes: 2, max_parallel: 1 },
						}
					: { kind: "program", task: "#task", executor: "test" },
			...(sibling ? { sibling: { kind: "program", executor: "test", task: "#task" } } : {}),
		},
		budgets: { quota: { scope: "run", limit: 1 } },
	};
	const content = `---\n${JSON.stringify(graph)}\n---\n## task\nImplement.\n`;
	const created = store.definitions.mutate({
		version: 1,
		request_key: "graph",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(created.target_id!)!;
	const ref = { id: "ref", digest: "sha256:ref" };
	const started = store.start(
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
			executors: kind === "program" || sibling ? { test: ref } : {},
			members: {
				owner: {
					provider: "provider",
					model: "model",
					configuration_revision: "1",
					base: "omp-default",
					base_snapshot_ref: ref,
					role_ref: ref,
					skill_refs: [],
					rule_refs: [],
				},
			},
			...(observed
				? {
						observation: {
							source_id: "graph-source",
							members: {
								owner: {
									bot: { source_id: "owner-source", profile_id: "profile", bot_id: "bot" },
									config_revision: "2",
									model_binding_ref: { id: "model-binding", digest: "sha256:model-binding" },
								},
							},
						},
					}
				: {}),
		},
	);
	expect(started.state).toBe("accepted");
	const owner = store.claimHost()!;
	return { root, store, owner, runId: started.target_id! };
}

/** A persisted legacy child attempt: new child admission deliberately remains closed. */
function seedParent(root: string, store: GraphRunStore, owner: { owner_id: string; epoch: string }, runId: string) {
	store.schedule(runId, owner.owner_id, owner.epoch);
	const state = store.getScheduleState(runId)!;
	const invocation = state.invocations.find(item => item.node === "build")!;
	invocation.ready ??= {
		type: "ready",
		invocation_id: invocation.id,
		inputs: {},
		upstream_invocation_ids: [],
		upstream_attempt_ids: [],
	};
	invocation.state = "running";
	invocation.attempt_id = "child-parent-attempt";
	state.counters = [{ key: "budget:quota:run:run", consumed: 1, reservations: [invocation.id] }];
	const run = store.getRun(runId)!;
	run.state = "running";
	state.run_state = "running";
	const identity: ChildIdentity = {
		run_id: runId,
		invocation_id: invocation.id,
		attempt_id: invocation.attempt_id,
		fence: owner.epoch,
	};
	const intent: GraphDispatchIntent = {
		id: "child-parent-intent",
		...identity,
		request_key: "child-parent-dispatch",
		state: "submitting",
		request: { node: invocation.node, snapshot_ref: run.snapshot_ref, ...invocation.ready },
		observation: null,
	};
	const db = new Database(path.join(root, "graphs.sqlite"));
	db.transaction(() => {
		db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
		db.query("UPDATE graph_runs SET data=? WHERE id=?").run(JSON.stringify(run), runId);
		db.query("INSERT INTO graph_dispatch_intents VALUES (?,?,?,?)").run(
			intent.id,
			runId,
			intent.request_key,
			JSON.stringify(intent),
		);
	}).immediate();
	db.close();
	return { identity, intent };
}

describe("unsupported child execution fails closed", () => {
	it("holds before reserving budget or issuing a dispatch", () => {
		const { store, owner, runId } = setup();
		store.schedule(runId, owner.owner_id, owner.epoch);
		const result = store.schedule(runId, owner.owner_id, owner.epoch);
		expect(result.run.state).toBe("held");
		expect(result.run.reason).toContain("enforcing child executor");
		expect(result.intent).toBeNull();
		expect(store.getDispatchIntents(runId)).toEqual([]);
		expect(store.getScheduleState(runId)!.counters).toEqual([]);
	});

	it("rejects direct completion of a legacy subgraph dispatch", () => {
		const { root, store, owner, runId } = setup();
		store.schedule(runId, owner.owner_id, owner.epoch);
		const state = store.getScheduleState(runId)!;
		const invocation = state.invocations[0];
		invocation.state = "running";
		invocation.attempt_id = "attempt";
		const run = store.getRun(runId)!;
		run.state = "running";
		const intent: GraphDispatchIntent = {
			id: "intent",
			run_id: runId,
			invocation_id: invocation.id,
			attempt_id: "attempt",
			request_key: "intent-request",
			fence: owner.epoch,
			state: "accepted",
			request: {},
			observation: null,
		};
		const db = new Database(path.join(root, "graphs.sqlite"));
		db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
		db.query("UPDATE graph_runs SET data=? WHERE id=?").run(JSON.stringify(run), runId);
		db.query("INSERT INTO graph_dispatch_intents VALUES (?,?,?,?)").run(
			intent.id,
			runId,
			intent.request_key,
			JSON.stringify(intent),
		);
		db.close();
		expect(
			store.completeAttempt(owner.owner_id, owner.epoch, {
				run_id: runId,
				invocation_id: invocation.id,
				attempt_id: "attempt",
				fence: owner.epoch,
				state: "succeeded",
				outcome: "done",
				outputs: {},
			}),
		).toBe(false);
		expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
		expect(store.getDispatchIntents(runId)[0].state).toBe("accepted");
	});
});

it("still cancels owned program work when unrelated child recovery cannot authenticate", async () => {
	const { root, store, runId } = setup("program");
	let cancellations = 0;
	let result: ProgramResult | null = null;
	let recoveryThrows = false;
	let recoveryError: unknown = new Error("Child resolver unavailable");
	const recoveryHost: ChildExecutionHost = {
		parent: () => null,
		authorizeIsolation: () => false,
		createRun: () => {
			throw new Error("Unexpected creation");
		},
		cancelRun: () => {
			throw new Error("Unexpected cancellation");
		},
		childState: () => "unknown",
		verifyAggregation: () => null,
		completeParent: () => false,
	};
	const graphHost = new GraphHost({
		store,
		childRecovery: {
			host: recoveryHost,
			resolveIdentity: () => {
				if (recoveryThrows) throw recoveryError;
				return null;
			},
		},
		program: {
			verifyRegistration: () => true,
			async accept(request) {
				result = {
					attempt_id: request.attempt_id,
					fence: request.fence,
					state: "running",
					outcome: null,
					verdict: null,
					outputs: {},
					error: null,
					usage: { tokens: null, cost: null, currency: null },
				};
				return { state: "accepted", execution_ref: "owned", error: null };
			},
			query: () => result,
			cancel: () => {
				cancellations++;
				return "unknown";
			},
		},
		async resolveProgram(intent): Promise<ProgramExecutionRequest> {
			const ref = { id: "ref", digest: "sha256:ref" };
			return {
				version: 1,
				run_id: intent.run_id,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				request_key: intent.request_key,
				executor: "test",
				inputs: {},
				task_ref: ref,
				authorization_ref: ref,
				model_binding_ref: null,
				base_snapshot_ref: null,
				duty: "general",
				deadline: null,
				parameters: {},
				outputs: {},
				principal: "owner",
				output_scope: [],
			};
		},
		async verifyProgramResult() {
			throw new Error("Program is still running");
		},
	});
	expect(graphHost.start()).toBe(true);
	await graphHost.tick();
	await graphHost.tick();
	expect(store.getDispatchIntents(runId)[0].state).toBe("accepted");
	const db = new Database(path.join(root, "graphs.sqlite"));
	try {
		const record = {
			parent_run_id: "unrelated",
			parent_invocation_id: "missing",
			child_run_id: "child",
			source: "",
			isolation: { mode: "serial", description: "test" },
			state: "running",
		};
		db.query("INSERT INTO graph_child_executions VALUES (?,?,?,?)").run(
			record.parent_run_id,
			record.parent_invocation_id,
			record.child_run_id,
			JSON.stringify(record),
		);
	} finally {
		db.close();
	}
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	expect(
		store.mutateLifecycle("owner", {
			version: 1,
			request_key: "cancel",
			operation: "cancel",
			target_id: runId,
			if_revision: store.getRun(runId)!.revision,
			payload: { reason: "stop" },
		}).state,
	).toBe("completed");
	await expect(graphHost.tick()).rejects.toThrow("could not authenticate every parent attempt");
	expect(cancellations).toBe(1);
	expect(store.getRun(runId)?.state).toBe("cancelling");
	recoveryThrows = true;
	await expect(graphHost.tick()).rejects.toThrow("Child resolver unavailable");
	expect(cancellations).toBe(2);
	const run = store.getRun(runId)!;
	const snapshot = store.getSnapshot(run.snapshot_ref)!;
	const queued = store.start(
		{
			version: 1,
			request_key: "next-run",
			operation: "start",
			target_id: run.graph_id,
			if_revision: run.definition_revision,
			payload: { inputs: {}, authorization_ref: run.authorization_ref },
		},
		snapshot,
	);
	expect(queued.state).toBe("accepted");
	recoveryError = "";
	await expect(graphHost.tick()).rejects.toThrow("Child execution recovery failed");
	expect(store.getScheduleState(queued.target_id!)!.invocations[0].state).toBe("pending");
});

it("retains authenticated child recovery through scheduling after owner restart", async () => {
	const { root, store, owner, runId } = setup();
	const { identity, intent } = seedParent(root, store, owner, runId);
	intent.state = "accepted";
	const record = {
		parent_run_id: runId,
		parent_invocation_id: identity.invocation_id,
		child_run_id: "legacy-child",
		source: "",
		isolation: { mode: "serial", description: "test recovery only" },
		state: "running",
	};
	const db = new Database(path.join(root, "graphs.sqlite"));
	try {
		db.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?").run(JSON.stringify(intent), intent.id);
		db.query("INSERT INTO graph_child_executions VALUES (?,?,?,?)").run(
			runId,
			identity.invocation_id,
			record.child_run_id,
			JSON.stringify(record),
		);
	} finally {
		db.close();
	}
	store.close();
	const reopened = new GraphRunStore(limits, root);
	stores.push(reopened);
	let isolationAllowed = true;
	let reservation = true;
	let resolvedIdentity = identity;
	let identityAvailable = false;
	const recoveryHost: ChildExecutionHost = {
		parent: () => ({
			state: "active",
			reserved: reservation,
			authority: {
				parent: reopened.getFrozenDefinition(runId)!,
				parentNode: "build",
				limits,
			},
		}),
		authorizeIsolation: () => isolationAllowed,
		createRun: () => {
			throw new Error("Recovery must not create");
		},
		cancelRun: () => {
			throw new Error("Recovery must not cancel");
		},
		childState: () => "running",
		verifyAggregation: () => null,
		completeParent: () => false,
	};
	const recovery = { host: recoveryHost, resolveIdentity: () => (identityAvailable ? resolvedIdentity : null) };
	const graphHost = new GraphHost({
		store: reopened,
		childRecovery: recovery,
		program: {
			async accept() {
				throw new Error("Recovery must not dispatch");
			},
			query: () => null,
			cancel: () => "unknown",
		},
		async resolveProgram() {
			throw new Error("Recovery must not resolve program");
		},
		async verifyProgramResult() {
			throw new Error("Recovery must not produce results");
		},
	});
	expect(graphHost.start()).toBe(true);
	await expect(graphHost.tick()).rejects.toThrow("could not authenticate every parent attempt");
	expect(reopened.getRun(runId)?.state).toBe("running");
	expect(reopened.getDispatchIntents(runId)[0].state).toBe("accepted");
	identityAvailable = true;
	await graphHost.tick();
	expect(reopened.getRun(runId)?.state).toBe("running");
	expect(reopened.getDispatchIntents(runId)[0].state).toBe("accepted");
	const nextOwner = reopened.claimHost()!;
	expect(nextOwner.epoch).not.toBe(identity.fence);
	const writer = new Database(path.join(root, "graphs.sqlite"));
	try {
		for (const denied of ["isolation", "reservation", "identity", "unconfigured", "containment"]) {
			const reset = reopened.getRun(runId)!;
			reset.state = "running";
			writer.query("UPDATE graph_runs SET data=? WHERE id=?").run(JSON.stringify(reset), runId);
			isolationAllowed = denied !== "isolation";
			reservation = denied !== "reservation";
			resolvedIdentity = denied === "identity" ? { ...identity, attempt_id: "different-attempt" } : identity;
			if (denied === "containment") writer.query("DELETE FROM graph_child_executions").run();
			expect(
				reopened.schedule(
					runId,
					nextOwner.owner_id,
					nextOwner.epoch,
					undefined,
					denied === "unconfigured" ? undefined : recovery,
				).run.state,
			).toBe("held");
		}
	} finally {
		writer.close();
	}
});

it("fences coordinator access and retains unresolved recovery records", async () => {
	const { root, store, owner, runId } = setup();
	const identity: ChildIdentity = {
		run_id: runId,
		invocation_id: "invocation",
		attempt_id: "attempt",
		fence: owner.epoch,
	};
	let calls = 0;
	const host: ChildExecutionHost = {
		parent: () => {
			calls++;
			return null;
		},
		authorizeIsolation: () => false,
		createRun: () => {
			throw new Error("Unexpected child creation");
		},
		cancelRun: () => {},
		childState: () => "unknown",
		verifyAggregation: () => null,
		completeParent: () => false,
	};
	const isolation = { mode: "serial" as const, description: "test" };
	expect(() => store.createChildExecution("not-owner", owner.epoch, host, identity, "", isolation)).toThrow();
	expect(calls).toBe(0);
	expect(store.createChildExecution(owner.owner_id, owner.epoch, host, identity, "", isolation).status).toBe(
		"rejected",
	);
	expect(calls).toBe(1);
	const db = new Database(path.join(root, "graphs.sqlite"));
	const record = {
		parent_run_id: runId,
		parent_invocation_id: identity.invocation_id,
		child_run_id: "child",
		source: "",
		isolation,
		state: "running",
	};
	db.query("INSERT INTO graph_child_executions VALUES (?,?,?,?)").run(
		runId,
		identity.invocation_id,
		"child",
		JSON.stringify(record),
	);
	db.close();
	expect(store.recoverChildExecutions(owner.owner_id, owner.epoch, host, () => null).unresolved).toEqual([
		{ run_id: runId, invocation_id: identity.invocation_id },
	]);
	expect(store.reconcileChildExecution(owner.owner_id, owner.epoch, host, identity)).toBeNull();
	const graphHost = new GraphHost({
		store,
		childRecovery: { host, resolveIdentity: () => null },
		program: {
			async accept() {
				throw new Error("Unexpected dispatch");
			},
			query: () => null,
			cancel: () => "unknown",
		},
		async resolveProgram() {
			throw new Error("Unexpected resolution");
		},
		async verifyProgramResult() {
			throw new Error("Unexpected result");
		},
	});
	expect(graphHost.start()).toBe(true);
	await expect(graphHost.tick()).rejects.toThrow("could not authenticate every parent attempt");
	expect(store.getScheduleState(runId)!.counters).toEqual([]);
});

it("rechecks host ownership inside each child recovery transaction", () => {
	const { root, store, owner, runId } = setup();
	const identity: ChildIdentity = {
		run_id: runId,
		invocation_id: "invocation",
		attempt_id: "attempt",
		fence: owner.epoch,
	};
	const isolation = { mode: "serial" as const, description: "test" };
	const record = {
		parent_run_id: runId,
		parent_invocation_id: identity.invocation_id,
		child_run_id: "child",
		source: "",
		isolation,
		state: "running",
	};
	const db = new Database(path.join(root, "graphs.sqlite"));
	db.query("INSERT INTO graph_child_executions VALUES (?,?,?,?)").run(
		runId,
		identity.invocation_id,
		"child",
		JSON.stringify(record),
	);
	let parentCalls = 0;
	const host: ChildExecutionHost = {
		parent: () => {
			parentCalls++;
			return null;
		},
		authorizeIsolation: () => false,
		createRun: () => {
			throw new Error("Unexpected child creation");
		},
		cancelRun: () => {},
		childState: () => "unknown",
		verifyAggregation: () => null,
		completeParent: () => false,
	};
	expect(() =>
		store.recoverChildExecutions(owner.owner_id, owner.epoch, host, () => {
			db.query("UPDATE graph_host_owner SET epoch=? WHERE singleton=1").run("999");
			return identity;
		}),
	).toThrow("Graph host ownership is stale");
	expect(parentCalls).toBe(0);
	expect(db.query("SELECT data FROM graph_child_executions").get()).toEqual({ data: JSON.stringify(record) });
	db.close();
});

describe("store-backed child parent authority", () => {
	it("requires every committed reservation and never reserves during lookup", () => {
		const { root, store, owner, runId } = setup();
		const { identity } = seedParent(root, store, owner, runId);
		const resolve = () => store.resolveChildParent(owner.owner_id, owner.epoch, identity, "dispatch");
		expect(resolve()?.reserved).toBe(true);
		const state = store.getScheduleState(runId)!;
		const original = structuredClone(state.counters);
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			for (const counters of [
				[],
				[{ ...original[0], reservations: ["other-invocation"] }],
				[{ ...original[0], consumed: 0 }],
				[original[0], original[0]],
				[{ ...original[0], consumed: 2, reservations: [identity.invocation_id, "other"] }],
			]) {
				state.counters = counters;
				db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
				expect(resolve()?.reserved).toBe(false);
				expect(store.getScheduleState(runId)!.counters).toEqual(counters);
			}
		} finally {
			db.close();
		}
	});

	it("accepts an empty reservation requirement without inventing a budget", () => {
		const { root, store, owner, runId } = setup("subgraph", false);
		const { identity } = seedParent(root, store, owner, runId);
		const state = store.getScheduleState(runId)!;
		state.counters = [];
		const db = new Database(path.join(root, "graphs.sqlite"));
		db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
		db.close();
		expect(store.resolveChildParent(owner.owner_id, owner.epoch, identity, "dispatch")?.reserved).toBe(true);
		expect(store.getScheduleState(runId)!.counters).toEqual([]);
	});

	it("rejects mismatched attempt, fence, frozen inputs, duplicate dispatch and supersession", () => {
		const { root, store, owner, runId } = setup();
		const { identity, intent } = seedParent(root, store, owner, runId);
		for (const changed of [
			{ ...identity, attempt_id: "other" },
			{ ...identity, fence: "other" },
		]) {
			expect(store.resolveChildParent(owner.owner_id, owner.epoch, changed, "dispatch")).toBeNull();
		}
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			const changed = { ...intent, request: { ...(intent.request as object), inputs: { injected: "text" } } };
			db.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?").run(JSON.stringify(changed), intent.id);
			expect(store.resolveChildParent(owner.owner_id, owner.epoch, identity, "dispatch")).toBeNull();
			db.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?").run(JSON.stringify(intent), intent.id);
			const duplicate = { ...intent, id: "duplicate", request_key: "duplicate" };
			db.query("INSERT INTO graph_dispatch_intents VALUES (?,?,?,?)").run(
				duplicate.id,
				runId,
				duplicate.request_key,
				JSON.stringify(duplicate),
			);
			expect(
				store.resolveChildRecoveryIdentity(owner.owner_id, owner.epoch, runId, identity.invocation_id),
			).toBeNull();
			db.query("DELETE FROM graph_dispatch_intents WHERE id=?").run(duplicate.id);
			const state = store.getScheduleState(runId)!;
			state.invocations[0].superseded = true;
			db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
			expect(store.resolveChildParent(owner.owner_id, owner.epoch, identity, "recovery")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("recovers the old fence without authorizing a new dispatch and cancels on budget revocation", () => {
		const { root, store, owner, runId } = setup();
		const { identity, intent } = seedParent(root, store, owner, runId);
		intent.state = "accepted";
		const db = new Database(path.join(root, "graphs.sqlite"));
		const record = {
			parent_run_id: runId,
			parent_invocation_id: identity.invocation_id,
			child_run_id: "legacy-child",
			source: "",
			isolation: { mode: "serial", description: "recovery fixture" },
			state: "running",
		};
		db.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?").run(JSON.stringify(intent), intent.id);
		db.query("INSERT INTO graph_child_executions VALUES (?,?,?,?)").run(
			runId,
			identity.invocation_id,
			record.child_run_id,
			JSON.stringify(record),
		);
		db.close();
		store.close();
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		const current = reopened.claimHost()!;
		const recoverIdentity = () =>
			reopened.resolveChildRecoveryIdentity(current.owner_id, current.epoch, runId, identity.invocation_id);
		expect(current.epoch).not.toBe(identity.fence);
		expect(recoverIdentity()).toEqual(identity);
		expect(reopened.resolveChildParent(current.owner_id, current.epoch, identity, "dispatch")).toBeNull();
		let cancellations = 0;
		const host: ChildExecutionHost = {
			parent: () => ({
				state: "active",
				reserved: true,
				authority: { parent: reopened.getFrozenDefinition(runId)!, parentNode: "build", limits },
			}),
			authorizeIsolation: () => true,
			createRun: () => {
				throw new Error("Recovery cannot create");
			},
			cancelRun: () => {
				cancellations++;
			},
			childState: () => (cancellations ? "cancelled" : "running"),
			verifyAggregation: () => null,
			completeParent: () => false,
		};
		expect(
			reopened.recoverChildExecutions(current.owner_id, current.epoch, host, recoverIdentity).reconciled[0].state,
		).toBe("running");
		const writer = new Database(path.join(root, "graphs.sqlite"));
		const state = reopened.getScheduleState(runId)!;
		state.counters = [];
		writer.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
		writer.close();
		expect(recoverIdentity()).toEqual(identity);
		expect(
			reopened.recoverChildExecutions(current.owner_id, current.epoch, host, recoverIdentity).reconciled[0].state,
		).toBe("cancelled");
		expect(cancellations).toBe(1);
		expect(() => reopened.resolveChildParent(owner.owner_id, owner.epoch, identity, "recovery")).toThrow(
			"ownership is stale",
		);
	});
});

describe("store-backed inherited child creation", () => {
	function child(store: GraphRunStore, runId: string, inputName?: string, withOutputs = false) {
		const parent = store.getFrozenDefinition(runId)!;
		return `---\n${JSON.stringify({
			format: "omp.graph/v1",
			name: "child",
			members: { owner: parent.members.owner },
			nodes: {
				implement: {
					kind: "bot",
					member: "owner",
					task: "#task",
					writes: ["src"],
					...(withOutputs ? { outputs: { report: { media_type: "text/markdown", required: true } } } : {}),
					...(inputName ? { inputs: { brief: { run_input: inputName } }, required_inputs: ["brief"] } : {}),
				},
			},
		})}\n---\n## task\nImplement.\n`;
	}
	function adapter(store: GraphRunStore, runId: string): Omit<ChildExecutionHost, "createRun"> {
		return {
			parent: () => ({
				state: "active",
				reserved: true,
				authority: { parent: store.getFrozenDefinition(runId)!, parentNode: "build", limits },
			}),
			authorizeIsolation: () => true,
			cancelRun: () => {},
			childState: () => "unknown",
			verifyAggregation: () => null,
			completeParent: () => false,
		};
	}
	function bindInput(
		root: string,
		store: GraphRunStore,
		identity: ChildIdentity,
		intent: GraphDispatchIntent,
		brief = { id: "frozen-brief", digest: "sha256:brief" },
	) {
		const state = store.getScheduleState(identity.run_id)!;
		state.invocations[0].ready!.inputs = {
			brief,
			private: { id: "not-forwarded", digest: "sha256:private" },
			text: "not an artifact",
		};
		intent.request = { ...(intent.request as object), ...state.invocations[0].ready };
		const db = new Database(path.join(root, "graphs.sqlite"));
		db.transaction(() => {
			db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), identity.run_id);
			db.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?").run(JSON.stringify(intent), intent.id);
		}).immediate();
		db.close();
	}

	async function plannedChild(options: { bytes?: Uint8Array; mediaType?: string; onRead?: () => void } = {}) {
		const context = setup("subgraph", true, true);
		const { root, store, owner, runId } = context;
		const { identity, intent } = seedParent(root, store, owner, runId);
		const source = child(store, runId, undefined, true);
		let reading = false;
		const registry = store.configureArtifacts({
			maxBytes: limits.maxBytes * 2,
			authorize: async (principal, action, scope) => {
				if (reading && action === "read") options.onRead?.();
				return scope.includes(principal);
			},
		});
		const publication = {
			media_type: options.mediaType ?? "text/markdown",
			producer_attempt_id: "planner-attempt",
			source_ref: null,
			access_scope: ["alice"],
		};
		const artifact = await registry.store.publish("alice", options.bytes ?? Buffer.from(source), publication);
		await registry.register([{ artifact, expected: publication }]);
		bindInput(root, store, identity, intent, { id: artifact.id, digest: artifact.digest });
		reading = true;
		const host = adapter(store, runId);
		const isolation = { mode: "serial" as const, description: "trusted fixture, not execution proof" };
		const bindings = { result: { node: "implement", output: "report" } };
		const create = (principal = "alice", input = "brief") =>
			store.createChildExecutionFromArtifact(
				owner.owner_id,
				owner.epoch,
				host,
				identity,
				input,
				principal,
				isolation,
				bindings,
			);
		return { ...context, identity, intent, source, registry, artifact, host, create };
	}

	function serialChild(sibling = false) {
		const context = setup("subgraph", true, false, false, sibling);
		const { root, store, owner, runId } = context;
		const { identity } = seedParent(root, store, owner, runId);
		const host = adapter(store, runId);
		const created = store.createInheritedChildExecution(
			owner.owner_id,
			owner.epoch,
			host,
			identity,
			child(store, runId),
			{ mode: "serial", description: "deterministic fixture; no OS isolation" },
		);
		if (created.status === "rejected") throw new Error(`Serial child rejected: ${JSON.stringify(created.issues)}`);
		const childId = created.record.child_run_id;
		const request = {
			parent: identity,
			child_run_id: childId,
			if_parent_revision: store.getRun(runId)!.revision,
			if_child_revision: store.getRun(childId)!.revision,
			termination_ref: { id: "parent-quiescence", digest: `sha256:${"a".repeat(64)}` },
			observed: "Fixture parent has no external processes or remote effects",
		};
		host.childState = () => (["queued", "running"].includes(store.getRun(childId)!.state) ? "running" : "unknown");
		return { ...context, identity, host, childId, request };
	}

	function competingRun(store: GraphRunStore) {
		const ref = { id: "test", digest: "sha256:test" };
		const created = store.definitions.mutate({
			version: 1,
			request_key: "competitor",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: competitor\nmembers: {}\nnodes:\n  work: {kind: program, executor: test, task: '#work'}\n---\n## work\nWork.\n",
			},
		});
		const definition = store.definitions.get(created.target_id!)!;
		const started = store.start(
			{
				version: 1,
				request_key: "start-competitor",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref: ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				inputs: {},
				members: {},
				executors: { test: ref },
				authorization_ref: ref,
			},
		);
		if (started.state !== "accepted") throw new Error("Competitor start rejected");
		return started.target_id!;
	}

	it("lends only the parent's writer scope to a serial child and blocks parent siblings and other Runs", () => {
		const { store, owner, runId, childId, request, identity, host } = serialChild(true);
		const admission = store.admitSerialChildWriter(owner.owner_id, owner.epoch, request);
		const competitor = competingRun(store);
		store.schedule(childId, owner.owner_id, owner.epoch);
		const childIntent = store.schedule(childId, owner.owner_id, owner.epoch).intent!;
		expect(store.claimDispatch(owner.owner_id, owner.epoch, childIntent.id)?.state).toBe("submitting");
		store.schedule(competitor, owner.owner_id, owner.epoch);
		expect(store.schedule(competitor, owner.owner_id, owner.epoch).intent).toBeNull();
		const recovery = {
			host: {
				...host,
				createRun: () => {
					throw new Error("No recovery creation");
				},
			},
			resolveIdentity: () => identity,
		};
		store.schedule(runId, owner.owner_id, owner.epoch, undefined, recovery);
		expect(store.schedule(runId, owner.owner_id, owner.epoch, undefined, recovery).intent).toBeNull();
		expect(store.getScheduleState(runId)!.invocations.find(item => item.node === "sibling")!.state).toBe("ready");
		expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch).map(item => item.run_id)).toEqual([runId]);
		expect(store.getScheduleState(runId)!.counters[0].consumed).toBe(1);
		expect(store.getScheduleState(childId)!.counters).toEqual([]);
		expect(store.admitSerialChildWriter(owner.owner_id, owner.epoch, request)).toEqual(admission);
	});

	it("requires current versions and a reserved parent before a serial child can acquire execution scope", () => {
		const { root, store, owner, runId, childId, request } = serialChild();
		expect(() =>
			store.admitSerialChildWriter(owner.owner_id, owner.epoch, { ...request, if_child_revision: "0" }),
		).toThrow("exact ready child");
		expect(() =>
			store.admitSerialChildWriter(owner.owner_id, owner.epoch, {
				...request,
				termination_ref: { id: "unproved", digest: "invalid" },
			}),
		).toThrow("quiescence");
		const state = store.getScheduleState(runId)!;
		state.counters = [];
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
		} finally {
			db.close();
		}
		expect(() => store.admitSerialChildWriter(owner.owner_id, owner.epoch, request)).toThrow("reserved parent");
		store.schedule(childId, owner.owner_id, owner.epoch);
		expect(store.getRun(childId)!.state).toBe("held");
		expect(store.getDispatchIntents(childId)).toEqual([]);
		expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch)).toEqual([]);
	});

	it("does not lend the scope while a parent sibling still has an unconfirmed execution", () => {
		const { root, store, owner, runId, request } = serialChild(true);
		const state = store.getScheduleState(runId)!;
		const sibling = state.invocations.find(item => item.node === "sibling")!;
		sibling.state = "unknown";
		sibling.attempt_id = "sibling-attempt";
		const intent: GraphDispatchIntent = {
			id: "sibling-intent",
			run_id: runId,
			invocation_id: sibling.id,
			attempt_id: sibling.attempt_id,
			fence: owner.epoch,
			request_key: "sibling-request",
			state: "unknown",
			request: {},
			observation: null,
		};
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
			db.query("INSERT INTO graph_dispatch_intents VALUES (?,?,?,?)").run(
				intent.id,
				runId,
				intent.request_key,
				JSON.stringify(intent),
			);
		} finally {
			db.close();
		}
		expect(() => store.admitSerialChildWriter(owner.owner_id, owner.epoch, request)).toThrow("quiescent family");
		expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch)).toEqual([]);
	});

	it("restores the root reservation after cancellation without completing the parent or admitting another Run", () => {
		const { store, owner, runId, childId, request } = serialChild();
		const admission = store.admitSerialChildWriter(owner.owner_id, owner.epoch, request);
		const stop = () => ({
			identity: admission,
			if_revision: store.getRun(childId)!.revision,
			termination_ref: { id: "child-quiescence", digest: `sha256:${"b".repeat(64)}` },
			observed: "Deterministic fixture has no child effects",
		});
		expect(() => store.releaseSerialChildWriter(owner.owner_id, owner.epoch, stop())).toThrow("not terminal");
		store.schedule(childId, owner.owner_id, owner.epoch);
		const intent = store.schedule(childId, owner.owner_id, owner.epoch).intent!;
		store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
		expect(
			store.completeAttempt(owner.owner_id, owner.epoch, {
				...intent,
				state: "succeeded",
				outcome: "done",
				outputs: {},
			}),
		).toBe(true);
		for (let index = 0; index < 5 && store.getRun(childId)!.state !== "succeeded"; index++)
			store.schedule(childId, owner.owner_id, owner.epoch);
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		store.mutateLifecycle("owner", {
			version: 1,
			request_key: "cancel-parent-before-release",
			operation: "cancel",
			target_id: runId,
			if_revision: store.getRun(runId)!.revision,
			payload: { reason: "Stop instead of integrating" },
		});
		const stopped = stop();
		expect(store.releaseSerialChildWriter(owner.owner_id, owner.epoch, stopped)).toEqual(admission);
		expect(store.releaseSerialChildWriter(owner.owner_id, owner.epoch, stopped)).toEqual(admission);
		expect(store.admitSerialChildWriter(owner.owner_id, owner.epoch, request)).toEqual(admission);
		expect(() =>
			store.releaseSerialChildWriter(owner.owner_id, owner.epoch, { ...stopped, observed: "changed" }),
		).toThrow("conflicts");
		const competitor = competingRun(store);
		store.schedule(competitor, owner.owner_id, owner.epoch);
		expect(store.schedule(competitor, owner.owner_id, owner.epoch).intent).toBeNull();
		expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch).map(item => item.run_id)).toEqual([runId]);
		expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
		expect(store.getScheduleState(runId)!.counters[0].consumed).toBe(1);
	});

	it("keeps a serial child scope fenced and durable across Host replacement", () => {
		const { root, store, owner, runId, childId, request } = serialChild();
		const admission = store.admitSerialChildWriter(owner.owner_id, owner.epoch, request);
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		const current = reopened.claimHost()!;
		expect(() => reopened.admitSerialChildWriter(owner.owner_id, owner.epoch, request)).toThrow("stale");
		expect(reopened.admitSerialChildWriter(current.owner_id, current.epoch, request)).toEqual(admission);
		reopened.schedule(childId, current.owner_id, current.epoch);
		const intent = reopened.schedule(childId, current.owner_id, current.epoch).intent!;
		expect(reopened.claimDispatch(current.owner_id, current.epoch, intent.id)?.state).toBe("submitting");
		expect(reopened.getProfileWriterAdmissions(current.owner_id, current.epoch).map(item => item.run_id)).toEqual([
			runId,
		]);
	});

	it("preserves cancellation committed by a child recovery callback instead of reviving a sibling", () => {
		const { root, store, owner, runId, request, identity } = serialChild(true);
		store.admitSerialChildWriter(owner.owner_id, owner.epoch, request);
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		const current = reopened.claimHost()!;
		reopened.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		let cancelled = false;
		const recovery = {
			host: {
				...adapter(reopened, runId),
				createRun: () => {
					throw new Error("Recovery must not create");
				},
				authorizeIsolation: () => {
					if (!cancelled) {
						cancelled = true;
						expect(
							reopened.mutateLifecycle("owner", {
								version: 1,
								request_key: "cancel-in-recovery",
								operation: "cancel",
								target_id: runId,
								if_revision: reopened.getRun(runId)!.revision,
								payload: { reason: "Cancel during recovery" },
							}).state,
						).toBe("completed");
					}
					return true;
				},
				childState: () => "running" as const,
			},
			resolveIdentity: () => identity,
		};
		const result = reopened.schedule(runId, current.owner_id, current.epoch, undefined, recovery);
		expect(cancelled).toBe(true);
		expect(result.intent).toBeNull();
		expect(result.run.state).toBe("cancelling");
		expect(reopened.getRun(runId)!.state).toBe("cancelling");
		expect(reopened.getScheduleState(runId)!.invocations.find(item => item.node === "sibling")!.state).toBe(
			"cancelled",
		);
	});

	it("creates and replays a child from authorized frozen Markdown with durable plan provenance", async () => {
		const { root, store, owner, runId, source, artifact, create } = await plannedChild();
		await expect(create("mallory")).rejects.toMatchObject({ code: "permission_denied" });
		const created = await create();
		if (created.status === "rejected") throw new Error("Plan rejected");
		const childId = created.record.child_run_id;
		const replay = await create();
		if (replay.status === "rejected") throw new Error("Replay rejected");
		expect(replay.record.child_run_id).toBe(childId);
		expect(store.getSnapshot(store.getRun(childId)!.snapshot_ref)!.definition).toBe(source);
		expect(store.getScheduleState(runId)!.counters[0].consumed).toBe(1);
		expect(store.getDispatchIntents(childId)).toEqual([]);
		expect(store.schedule(childId, owner.owner_id, owner.epoch).run.state).toBe("held");
		store.close();
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		expect(reopened.getSnapshot(reopened.getRun(childId)!.snapshot_ref)!.definition).toBe(source);
		const db = new Database(path.join(root, "graphs.sqlite"), { readonly: true });
		try {
			const row = db.query("SELECT data FROM graph_child_plan_inputs WHERE child_run_id=?").get(childId) as {
				data: string;
			};
			expect(JSON.parse(row.data)).toEqual({ input: "brief", ref: { id: artifact.id, digest: artifact.digest } });
			expect(db.query("SELECT COUNT(*) AS count FROM graph_child_executions").get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it("does not interpret missing or text-valued parent inputs as child plans", async () => {
		const { store, runId, create } = await plannedChild();
		expect((await create("alice", "missing")).status).toBe("rejected");
		expect((await create("alice", "text")).status).toBe("rejected");
		expect(store.listHostRuns().map(run => run.id)).toEqual([runId]);
	});

	it.each([
		{ name: "non-Markdown media", mediaType: "application/octet-stream" },
		{ name: "invalid UTF-8", bytes: new Uint8Array([0xc3, 0x28]) },
		{ name: "oversized source", bytes: new Uint8Array(limits.maxBytes + 1).fill(32) },
		{ name: "malformed Graph", bytes: Buffer.from("---\nformat: omp.graph/v1\n---\n") },
	])("rejects $name without creating a child", async options => {
		const { store, runId, create } = await plannedChild(options);
		expect((await create()).status).toBe("rejected");
		expect(store.listHostRuns().map(run => run.id)).toEqual([runId]);
	});

	it("discards a plan when the parent is cancelled during authorized artifact reading", async () => {
		let cancel = () => {};
		const context = await plannedChild({ onRead: () => cancel() });
		const { store, runId, create } = context;
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		cancel = () => {
			cancel = () => {};
			store.mutateLifecycle("owner", {
				version: 1,
				operation: "cancel",
				request_key: "cancel-plan",
				target_id: runId,
				if_revision: store.getRun(runId)!.revision,
				payload: { reason: "user cancelled" },
			});
		};
		expect((await create()).status).toBe("rejected");
		expect(store.getRun(runId)!.state).toBe("cancelling");
		expect(store.listHostRuns().filter(run => run.id !== runId)).toEqual([]);
	});

	it("does not rebind an existing child to another artifact with identical bytes", async () => {
		const { root, store, identity, intent, source, registry, create } = await plannedChild();
		const original = await create();
		if (original.status === "rejected") throw new Error("Plan rejected");
		const publication = {
			media_type: "text/markdown",
			producer_attempt_id: "another-planner",
			source_ref: null,
			access_scope: ["alice"],
		};
		const replacement = await registry.store.publish("alice", Buffer.from(source), publication);
		await registry.register([{ artifact: replacement, expected: publication }]);
		bindInput(root, store, identity, intent, replacement);
		await expect(create()).rejects.toThrow("different child plan input");
		expect(store.getDispatchIntents(original.record.child_run_id)).toEqual([]);
	});

	it("does not claim an older source-only child as a provenanced plan execution", async () => {
		const { store, owner, identity, host, source, create } = await plannedChild();
		const original = store.createInheritedChildExecution(
			owner.owner_id,
			owner.epoch,
			host,
			identity,
			source,
			{ mode: "serial", description: "trusted fixture, not execution proof" },
			{ result: { node: "implement", output: "report" } },
		);
		if (original.status === "rejected") throw new Error("Source-only child rejected");
		await expect(create()).rejects.toThrow("different child plan input");
		expect(store.getDispatchIntents(original.record.child_run_id)).toEqual([]);
	});

	it("rolls child creation back if its plan becomes unavailable inside a trusted callback", async () => {
		const { root, registry, artifact, host, create } = await plannedChild();
		host.authorizeIsolation = () => {
			registry.markUnavailable(artifact, "missing");
			return true;
		};
		await expect(create()).rejects.toThrow("Child plan changed");
		const db = new Database(path.join(root, "graphs.sqlite"), { readonly: true });
		try {
			expect(db.query("SELECT COUNT(*) AS count FROM graph_runs").get()).toEqual({ count: 1 });
			expect(db.query("SELECT COUNT(*) AS count FROM graph_child_executions").get()).toEqual({ count: 0 });
			expect(db.query("SELECT COUNT(*) AS count FROM graph_child_plan_inputs").get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
		expect(registry.lookup(artifact)!.availability).toBe("available");
	});

	it("charges durable child observations to the parent once and atomically", async () => {
		const { root, store, owner, runId } = setup();
		const { identity } = seedParent(root, store, owner, runId);
		const created = store.createInheritedChildExecution(
			owner.owner_id,
			owner.epoch,
			adapter(store, runId),
			identity,
			child(store, runId),
			{ mode: "serial", description: "historical accounting fixture; no execution isolation claimed" },
		);
		if (created.status === "rejected") throw new Error("Child fixture rejected");
		const childId = created.record.child_run_id;
		const schedule = store.getScheduleState(childId)!;
		const invocation = schedule.invocations[0];
		invocation.state = "running";
		invocation.attempt_id = "child-billed-attempt";
		const dispatch: GraphDispatchIntent = {
			id: "child-billed-intent",
			run_id: childId,
			invocation_id: invocation.id,
			attempt_id: invocation.attempt_id,
			request_key: "child-billed-request",
			fence: owner.epoch,
			state: "accepted",
			request: {},
			observation: null,
		};
		// Historical admission only: new contained-child dispatch remains closed.
		const db = new Database(path.join(root, "graphs.sqlite"));
		const bots = new BotStore(path.join(root, "bots"));
		const bot = bots.createBot({ bot_name: "child-accounting", cwd: root });
		const worker = new BotWorker(bots, bot.bot_id, undefined, { scoped: true });
		try {
			db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(schedule), childId);
			db.query("INSERT INTO graph_dispatch_intents VALUES (?,?,?,?)").run(
				dispatch.id,
				childId,
				dispatch.request_key,
				JSON.stringify(dispatch),
			);
			expect(worker.claim()).toBe(true);
			const receipt = worker.admitGraph({
				command: "submit",
				key: dispatch.request_key,
				input: "accounting only",
				graph_context: {
					graph_id: store.getRun(childId)!.graph_id,
					graph_run_id: childId,
					invocation_id: invocation.id,
					node_id: invocation.node,
					attempt: 1,
					upstream: [],
				},
			});
			const usage = {
				input_tokens: 10,
				output_tokens: 5,
				cache_read_tokens: null,
				cache_write_tokens: null,
				cost_usd: "0.2",
				completeness: "partial" as const,
				measured_at: "2026-11-05T12:00:00.000Z",
			};
			bots.updateJob(bot.bot_id, receipt.job_id!, { usage });
			store.recordBotUsage(owner.owner_id, owner.epoch, dispatch.id, bots, bot.bot_id);
			expect(store.getRun(runId)?.observed_bot_usage).toMatchObject({
				cost_usd: "0.2",
				output_tokens: 5,
				observed_sources: 1,
				completeness: "partial",
			});
			const revision = store.getRun(runId)!.revision;
			store.recordBotUsage(owner.owner_id, owner.epoch, dispatch.id, bots, bot.bot_id);
			expect(store.getRun(runId)!.revision).toBe(revision);
			bots.updateJob(bot.bot_id, receipt.job_id!, { usage: { ...usage, cost_usd: "0.3", output_tokens: 8 } });
			db.exec(`CREATE TRIGGER reject_parent_usage BEFORE UPDATE ON graph_runs
				WHEN NEW.id='${runId}' BEGIN SELECT RAISE(ABORT,'parent observation unavailable'); END`);
			expect(() => store.recordBotUsage(owner.owner_id, owner.epoch, dispatch.id, bots, bot.bot_id)).toThrow(
				"parent observation unavailable",
			);
			expect(store.getRun(childId)?.observed_bot_usage?.cost_usd).toBe("0.2");
			expect(store.getRun(runId)?.observed_bot_usage?.cost_usd).toBe("0.2");
			db.exec("DROP TRIGGER reject_parent_usage");
			store.recordBotUsage(owner.owner_id, owner.epoch, dispatch.id, bots, bot.bot_id);
			expect(store.getRun(runId)?.observed_bot_usage).toMatchObject({
				cost_usd: "0.3",
				output_tokens: 8,
				observed_sources: 1,
			});
			expect(store.getRun(childId)?.observed_bot_usage?.cost_usd).toBe("0.3");
			const reopened = new GraphRunStore(limits, root);
			try {
				expect(reopened.getRun(runId)?.observed_bot_usage?.cost_usd).toBe("0.3");
			} finally {
				reopened.close();
			}
			expect(store.getScheduleState(runId)!.counters[0].consumed).toBe(1);
			expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
		} finally {
			await worker.close();
			bots.close();
			db.close();
		}
	});

	it("persists an idempotent child with exact inherited bindings and only its frozen inputs", () => {
		const { root, store, owner, runId } = setup("subgraph", true, false, true);
		const { identity, intent } = seedParent(root, store, owner, runId);
		bindInput(root, store, identity, intent);
		const source = child(store, runId, "brief");
		const isolation = { mode: "serial" as const, description: "trusted fixture, not a sandbox" };
		const host = adapter(store, runId);
		const result = store.createInheritedChildExecution(
			owner.owner_id,
			owner.epoch,
			host,
			identity,
			source,
			isolation,
		);
		expect(result.status).toBe("created");
		if (result.status === "rejected") throw new Error("Child rejected");
		const childId = result.record.child_run_id;
		const parentSnapshot = store.getSnapshot(store.getRun(runId)!.snapshot_ref)!;
		const replay = store.createInheritedChildExecution(
			owner.owner_id,
			owner.epoch,
			host,
			identity,
			source,
			isolation,
		);
		expect(replay.status).toBe("existing");
		if (replay.status === "rejected") throw new Error("Replay rejected");
		expect(replay.record.child_run_id).toBe(childId);
		store.close();
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		const run = reopened.getRun(childId)!;
		const snapshot = reopened.getSnapshot(run.snapshot_ref)!;
		expect(snapshot.definition).toBe(source);
		expect(snapshot.members).toEqual(parentSnapshot.members);
		expect(snapshot.authorization_ref).toEqual(parentSnapshot.authorization_ref);
		expect(snapshot.inputs).toEqual({ brief: { id: "frozen-brief", digest: "sha256:brief" } });
		expect(snapshot.imports).toBeUndefined();
		const reader = new Database(path.join(root, "graphs.sqlite"), { readonly: true });
		try {
			const records = new GraphWireLedger(reader, { readOnly: true }).snapshot("graph-source").records;
			const parentRecord = records.find(record => record.kind === "run" && record.value.graph_run_id === runId);
			const childRecord = records.find(record => record.kind === "run" && record.value.graph_run_id === childId);
			if (parentRecord?.kind !== "run" || childRecord?.kind !== "run")
				throw new Error("Missing inherited wire Runs");
			expect(parentRecord.value.definition.nodes[0].bot).toBeNull();
			expect(childRecord.value.definition.nodes[0]).toMatchObject({
				node_id: "implement",
				bot: { source_id: "owner-source", profile_id: "profile", bot_id: "bot" },
				config_revision: "2",
			});
		} finally {
			reader.close();
		}
		expect(reopened.getScheduleState(childId)!.run_inputs).toEqual(snapshot.inputs);
		expect(reopened.getScheduleState(childId)!.counters).toEqual([]);
		expect(reopened.getDispatchIntents(childId)).toEqual([]);
		expect(reopened.getScheduleState(runId)!.counters[0].consumed).toBe(1);
		expect(reopened.getScheduleState(childId)!.invocations[0].state).toBe("pending");
		const current = reopened.claimHost()!;
		expect(reopened.schedule(childId, current.owner_id, current.epoch).run.state).toBe("held");
		expect(reopened.getDispatchIntents(childId)).toEqual([]);
		// A legacy pending intent must not bypass the ordinary scanner's child HOLD.
		const state = reopened.getScheduleState(childId)!;
		state.invocations[0].state = "running";
		state.invocations[0].attempt_id = "legacy-child-attempt";
		run.state = "running";
		const pending: GraphDispatchIntent = {
			id: "legacy-child-intent",
			run_id: childId,
			invocation_id: state.invocations[0].id,
			attempt_id: "legacy-child-attempt",
			fence: current.epoch,
			request_key: "legacy-child-intent",
			state: "pending",
			request: {},
			observation: null,
		};
		const db = new Database(path.join(root, "graphs.sqlite"));
		db.transaction(() => {
			db.query("UPDATE graph_runs SET data=? WHERE id=?").run(JSON.stringify(run), childId);
			db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), childId);
			db.query("INSERT INTO graph_dispatch_intents VALUES (?,?,?,?)").run(
				pending.id,
				childId,
				pending.request_key,
				JSON.stringify(pending),
			);
		}).immediate();
		db.close();
		expect(reopened.claimDispatch(current.owner_id, current.epoch, pending.id)).toBeNull();
		expect(reopened.getDispatchIntents(childId)[0].state).toBe("pending");
	});

	it("does not create a child when a requested run input is missing or plain text", () => {
		const { root, store, owner, runId } = setup();
		const { identity, intent } = seedParent(root, store, owner, runId);
		bindInput(root, store, identity, intent);
		for (const key of ["missing", "text"]) {
			expect(() =>
				store.createInheritedChildExecution(
					owner.owner_id,
					owner.epoch,
					adapter(store, runId),
					identity,
					child(store, runId, key),
					{ mode: "serial", description: "fixture" },
				),
			).toThrow("requires a frozen parent artifact");
		}
		const db = new Database(path.join(root, "graphs.sqlite"));
		expect(db.query("SELECT COUNT(*) AS count FROM graph_runs").get()).toEqual({ count: 1 });
		expect(db.query("SELECT COUNT(*) AS count FROM graph_child_executions").get()).toEqual({ count: 0 });
		db.close();
		expect(store.getScheduleState(runId)!.counters[0].consumed).toBe(1);
	});

	it("rejects widened permissions and unenforced isolation before durable creation", () => {
		const { root, store, owner, runId } = setup();
		const { identity } = seedParent(root, store, owner, runId);
		const host = adapter(store, runId);
		const source = child(store, runId);
		expect(
			store.createInheritedChildExecution(
				owner.owner_id,
				owner.epoch,
				host,
				identity,
				source.replaceAll('"src"', '"."'),
				{ mode: "serial", description: "fixture" },
			).status,
		).toBe("rejected");
		host.authorizeIsolation = () => false;
		expect(
			store.createInheritedChildExecution(owner.owner_id, owner.epoch, host, identity, source, {
				mode: "serial",
				description: "fixture",
			}).status,
		).toBe("rejected");
		const db = new Database(path.join(root, "graphs.sqlite"));
		expect(db.query("SELECT COUNT(*) AS count FROM graph_runs").get()).toEqual({ count: 1 });
		db.close();
	});

	it("requires explicit compatible child exports and rolls invalid mappings back", () => {
		const { root, store, owner, runId } = setup("subgraph", true, true);
		const { identity } = seedParent(root, store, owner, runId);
		const source = child(store, runId, undefined, true);
		const host = adapter(store, runId);
		const isolation = { mode: "serial" as const, description: "fixture" };
		const invalidBindings: ChildOutputBindings[] = [
			{},
			{ result: { node: "missing", output: "report" } },
			{ result: { node: "implement", output: "missing" } },
			{ extra: { node: "implement", output: "report" } },
		];
		for (const mapping of invalidBindings) {
			expect(() =>
				store.createInheritedChildExecution(
					owner.owner_id,
					owner.epoch,
					host,
					identity,
					source,
					isolation,
					mapping,
				),
			).toThrow("child output binding");
		}
		expect(() =>
			store.createInheritedChildExecution(
				owner.owner_id,
				owner.epoch,
				host,
				identity,
				source.replace("text/markdown", "video/mp4"),
				isolation,
				{ result: { node: "implement", output: "report" } },
			),
		).toThrow("Incompatible child output binding");
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			expect(db.query("SELECT COUNT(*) AS count FROM graph_runs").get()).toEqual({ count: 1 });
			expect(db.query("SELECT COUNT(*) AS count FROM graph_child_executions").get()).toEqual({ count: 0 });
			expect(db.query("SELECT COUNT(*) AS count FROM graph_child_output_bindings").get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

	it("persists explicit exports and selects only unambiguous confirmed child results after reopen", () => {
		const { root, store, owner, runId } = setup("subgraph", true, true);
		const { identity } = seedParent(root, store, owner, runId);
		const source = child(store, runId, undefined, true);
		const host = adapter(store, runId);
		const isolation = { mode: "serial" as const, description: "fixture" };
		const mapping = { result: { node: "implement", output: "report" } };
		const result = store.createInheritedChildExecution(
			owner.owner_id,
			owner.epoch,
			host,
			identity,
			source,
			isolation,
			mapping,
		);
		if (result.status === "rejected") throw new Error("Child rejected");
		const childId = result.record.child_run_id;
		expect(() =>
			store.createInheritedChildExecution(owner.owner_id, owner.epoch, host, identity, source, isolation, {}),
		).toThrow("different child output bindings");
		expect(store.getChildOutputCandidates(owner.owner_id, owner.epoch, identity)).toBeNull();
		store.close();
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		const current = reopened.claimHost()!;
		const run = reopened.getRun(childId)!;
		const state = reopened.getScheduleState(childId)!;
		run.state = state.run_state = "succeeded";
		const ref = { id: "child-report", digest: "sha256:report" };
		Object.assign(state.invocations[0], {
			state: "succeeded",
			attempt_id: "child-attempt",
			outputs: { report: ref },
			routed: true,
		});
		const db = new Database(path.join(root, "graphs.sqlite"));
		const save = () => {
			db.query("UPDATE graph_runs SET data=? WHERE id=?").run(JSON.stringify(run), childId);
			db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), childId);
		};
		try {
			save();
			expect(reopened.getChildOutputCandidates(current.owner_id, current.epoch, identity)).toEqual({ result: ref });
			// A selected producer cannot be skipped, imported or ambiguous; no guessed replacement.
			state.invocations[0].state = "skipped";
			save();
			expect(reopened.getChildOutputCandidates(current.owner_id, current.epoch, identity)).toBeNull();
			state.invocations[0].state = "succeeded";
			state.invocations[0].origin = "imported";
			save();
			expect(reopened.getChildOutputCandidates(current.owner_id, current.epoch, identity)).toBeNull();
			delete state.invocations[0].origin;
			state.invocations.push({ ...state.invocations[0], id: "duplicate" });
			save();
			expect(reopened.getChildOutputCandidates(current.owner_id, current.epoch, identity)).toBeNull();
			state.invocations.pop();
			state.invocations.push({ ...state.invocations[0], id: "unsettled", node: "other", state: "running" });
			save();
			expect(reopened.getChildOutputCandidates(current.owner_id, current.epoch, identity)).toBeNull();
		} finally {
			db.close();
		}
		expect(reopened.getScheduleState(runId)!.invocations[0].state).toBe("running");
	});

	async function completedOutput(
		options: { producer?: string; mediaType?: string; onRead?: () => void; serial?: boolean } = {},
	) {
		const context = setup("subgraph", true, true);
		const { root, store, owner, runId } = context;
		const { identity } = seedParent(root, store, owner, runId);
		const created = store.createInheritedChildExecution(
			owner.owner_id,
			owner.epoch,
			adapter(store, runId),
			identity,
			child(store, runId, undefined, true),
			{ mode: "serial", description: "trusted historical fixture, not execution proof" },
			{ result: { node: "implement", output: "report" } },
		);
		if (created.status === "rejected") throw new Error("Child rejected");
		const childId = created.record.child_run_id;
		const admission = options.serial
			? store.admitSerialChildWriter(owner.owner_id, owner.epoch, {
					parent: identity,
					child_run_id: childId,
					if_parent_revision: store.getRun(runId)!.revision,
					if_child_revision: store.getRun(childId)!.revision,
					termination_ref: { id: "parent-stopped", digest: `sha256:${"a".repeat(64)}` },
					observed: "Historical fixture parent has no effects",
				})
			: undefined;
		const registry = store.configureArtifacts({
			maxBytes: 4096,
			authorize: async (principal, action, scope) => {
				if (action === "read") options.onRead?.();
				return scope.includes(principal);
			},
		});
		const publication = {
			media_type: options.mediaType ?? "text/markdown",
			producer_attempt_id: options.producer ?? "child-attempt",
			source_ref: null,
			access_scope: ["alice"],
		};
		const artifact = await registry.store.publish("alice", Buffer.from("# Report\nEvidence."), publication);
		await registry.register([{ artifact, expected: publication }]);
		const run = store.getRun(childId)!;
		const state = store.getScheduleState(childId)!;
		run.state = state.run_state = "succeeded";
		Object.assign(state.invocations[0], {
			state: "succeeded",
			attempt_id: "child-attempt",
			outputs: { report: { id: artifact.id, digest: artifact.digest } },
			routed: true,
		});
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			db.transaction(() => {
				db.query("UPDATE graph_runs SET data=? WHERE id=?").run(JSON.stringify(run), childId);
				db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), childId);
			}).immediate();
		} finally {
			db.close();
		}
		const aggregation: GraphSerialChildAggregation = {
			parent: identity,
			principal: "alice",
			outcome: "done",
			stopped: {
				identity: admission ?? { scope_id: "missing", child_run_id: childId },
				if_revision: store.getRun(childId)!.revision,
				termination_ref: { id: "child-stopped", digest: `sha256:${"b".repeat(64)}` },
				observed: "Historical fixture child has no effects",
			},
			integration_ref: { id: "integrated-version", digest: `sha256:${"c".repeat(64)}` },
			observed: "Fixture integration independently inspected",
		};
		return { ...context, identity, childId, registry, artifact, aggregation };
	}

	it("requires serial ownership and independent integration before atomically completing a parent", async () => {
		const missing = await completedOutput();
		expect(
			await missing.store.aggregateSerialChildExecution(
				missing.owner.owner_id,
				missing.owner.epoch,
				missing.aggregation,
				() => {
					throw new Error("No scope, no verifier");
				},
			),
		).toBe(false);
		const { store, owner, runId, aggregation, artifact, root } = await completedOutput({ serial: true });
		const complete = (
			verify: (
				db: Database,
				proof: GraphSerialChildAggregation & { outputs: Record<string, { id: string; digest: string }> },
			) => boolean,
		) => store.aggregateSerialChildExecution(owner.owner_id, owner.epoch, aggregation, verify);
		await expect(
			store.aggregateSerialChildExecution(
				owner.owner_id,
				owner.epoch,
				{ ...aggregation, principal: "mallory" },
				() => true,
			),
		).rejects.toMatchObject({ code: "permission_denied" });
		expect(await complete(() => false)).toBe(false);
		expect(await complete(() => "yes" as unknown as boolean)).toBe(false);
		expect(() => store.releaseSerialChildWriter(owner.owner_id, owner.epoch, aggregation.stopped)).toThrow(
			"atomic aggregation",
		);
		expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
		expect(
			await complete((_db, proof) => {
				proof.parent.invocation_id = "replaced";
				proof.outcome = "rejected";
				proof.outputs.result.id = "wrong";
				return true;
			}),
		).toBe(true);
		expect(store.getScheduleState(runId)!.invocations[0]).toMatchObject({
			state: "succeeded",
			outcome: "done",
			outputs: { result: { id: artifact.id, digest: artifact.digest } },
		});
		expect(store.getScheduleState(runId)!.counters[0].consumed).toBe(1);
		expect(
			await complete(() => {
				throw new Error("Historical application must not reintegrate");
			}),
		).toBe(true);
		expect(
			await store.aggregateSerialChildExecution(
				owner.owner_id,
				owner.epoch,
				{ ...aggregation, outcome: "different" },
				() => true,
			),
		).toBe(false);
		expect(store.getAttemptHistory(runId).filter(item => item.accepted)).toHaveLength(1);
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			const row = db.query("SELECT data FROM graph_child_executions WHERE parent_run_id=?").get(runId) as {
				data: string;
			};
			expect(JSON.parse(row.data).state).toBe("completed");
		} finally {
			db.close();
		}
	});

	it("retains completed serial child ownership across restart while integration is pending", async () => {
		const { root, store, owner, runId, childId, aggregation, artifact } = await completedOutput({ serial: true });
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		reopened.configureArtifacts({
			maxBytes: 4096,
			authorize: async (principal, _action, scope) => scope.includes(principal),
		});
		const current = reopened.claimHost()!;
		const recoveryHost: ChildExecutionHost = {
			parent: (_db, identity) => reopened.resolveChildParent(current.owner_id, current.epoch, identity, "recovery"),
			authorizeIsolation: () => true,
			createRun: () => {
				throw new Error("Recovery must not create");
			},
			cancelRun: () => {
				throw new Error("Completed child must not cancel");
			},
			childState: () => (reopened.getRun(childId)!.state === "succeeded" ? "succeeded" : "unknown"),
			verifyAggregation: () => null,
			completeParent: () => false,
		};
		const host = new GraphHost({
			store: reopened,
			program: {
				accept: async () => {
					throw new Error("No new execution");
				},
				query: () => null,
				cancel: () => "cancelled",
			},
			resolveProgram: async () => {
				throw new Error("No program");
			},
			verifyProgramResult: async () => {
				throw new Error("No result");
			},
			childRecovery: { host: recoveryHost, resolveIdentity: () => aggregation.parent },
		});
		expect(host.start()).toBe(true);
		await host.tick();
		expect(reopened.getRun(runId)!.state).toBe("running");
		expect(reopened.getDispatchIntents(runId)[0].state).toBe("submitting");
		await expect(
			reopened.aggregateSerialChildExecution(owner.owner_id, owner.epoch, aggregation, () => true),
		).rejects.toThrow("stale");
		expect(
			await reopened.aggregateSerialChildExecution(current.owner_id, current.epoch, aggregation, () => true),
		).toBe(true);
		expect(reopened.getScheduleState(runId)!.invocations[0].outputs).toEqual({
			result: { id: artifact.id, digest: artifact.digest },
		});
		expect(reopened.getScheduleState(runId)!.counters[0].consumed).toBe(1);
	});

	it("rolls back writer release and parent completion together when journal persistence fails", async () => {
		const { root, store, owner, runId, aggregation, childId } = await completedOutput({ serial: true });
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			db.exec(`CREATE TRIGGER reject_aggregate BEFORE UPDATE ON graph_runs WHEN NEW.id='${runId}'
				BEGIN SELECT RAISE(ABORT,'parent unavailable'); END`);
			await expect(
				store.aggregateSerialChildExecution(owner.owner_id, owner.epoch, aggregation, () => true),
			).rejects.toThrow("parent unavailable");
			const row = db.query("SELECT receipt FROM graph_serial_child_writers WHERE child_run_id=?").get(childId) as {
				receipt: string | null;
			};
			expect(row.receipt).toBeNull();
			expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
			expect(store.getAttemptHistory(runId).filter(item => item.accepted)).toEqual([]);
			db.exec("DROP TRIGGER reject_aggregate");
			expect(await store.aggregateSerialChildExecution(owner.owner_id, owner.epoch, aggregation, () => true)).toBe(
				true,
			);
		} finally {
			db.close();
		}
	});

	it("does not aggregate if cancellation is persisted while child artifacts are read", async () => {
		let cancel = () => {};
		const { store, owner, runId, aggregation } = await completedOutput({ serial: true, onRead: () => cancel() });
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		cancel = () => {
			cancel = () => {};
			store.mutateLifecycle("alice", {
				version: 1,
				request_key: "cancel-aggregation",
				operation: "cancel",
				target_id: runId,
				if_revision: store.getRun(runId)!.revision,
				payload: { reason: "cancel before integration" },
			});
		};
		expect(
			await store.aggregateSerialChildExecution(owner.owner_id, owner.epoch, aggregation, () => {
				throw new Error("Cancelled parent cannot integrate");
			}),
		).toBe(false);
		expect(store.getRun(runId)!.state).toBe("cancelling");
		expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
	});

	it("verifies exact child artifact bytes and readers without completing the parent", async () => {
		const { root, store, owner, runId, identity, artifact } = await completedOutput();
		const verify = (principal: string) =>
			store.verifyChildOutputCandidates(owner.owner_id, owner.epoch, identity, principal);
		await expect(verify("mallory")).rejects.toMatchObject({ code: "permission_denied" });
		expect(await verify("alice")).toEqual({ result: { id: artifact.id, digest: artifact.digest } });
		expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
		await fs.promises.chmod(path.join(root, "artifacts", artifact.id), 0o600);
		await Bun.write(path.join(root, "artifacts", artifact.id), "# Report\nTampered.");
		await expect(verify("alice")).rejects.toMatchObject({ code: "digest_mismatch" });
		expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
	});

	it("rejects readable child outputs from another attempt or with a different media type", async () => {
		for (const options of [{ producer: "another-attempt" }, { mediaType: "video/mp4" }]) {
			const { store, owner, identity } = await completedOutput(options);
			await expect(
				store.verifyChildOutputCandidates(owner.owner_id, owner.epoch, identity, "alice"),
			).rejects.toThrow("declared producer and media type");
		}
	});

	it("discards verified child candidates if the parent is cancelled during artifact retrieval", async () => {
		let cancel = () => {};
		const { store, owner, identity, runId } = await completedOutput({ onRead: () => cancel() });
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		cancel = () => {
			cancel = () => {};
			store.mutateLifecycle("alice", {
				version: 1,
				request_key: "cancel-during-read",
				operation: "cancel",
				target_id: runId,
				if_revision: store.getRun(runId)!.revision,
				payload: { reason: "cancel while checking outputs" },
			});
		};
		expect(await store.verifyChildOutputCandidates(owner.owner_id, owner.epoch, identity, "alice")).toBeNull();
		expect(store.getRun(runId)!.state).toBe("cancelling");
		expect(store.getScheduleState(runId)!.invocations[0].state).toBe("running");
	});

	it("retains existing child work while the parent is held and cancels only on explicit cancellation", () => {
		const { root, store, owner, runId } = setup();
		const { identity } = seedParent(root, store, owner, runId);
		const host = adapter(store, runId);
		const created = store.createInheritedChildExecution(
			owner.owner_id,
			owner.epoch,
			host,
			identity,
			child(store, runId),
			{ mode: "serial", description: "fixture" },
		);
		if (created.status === "rejected") throw new Error("Child rejected");
		const childId = created.record.child_run_id;
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		let cancellations = 0;
		host.childState = () => (store.getRun(childId)!.state === "cancelled" ? "cancelled" : "running");
		host.cancelRun = () => {
			cancellations++;
			store.mutateLifecycle("owner", {
				version: 1,
				request_key: "cancel-child",
				operation: "cancel",
				target_id: childId,
				if_revision: store.getRun(childId)!.revision,
				payload: { reason: "parent cancelled" },
			});
		};
		store.mutateLifecycle("owner", {
			version: 1,
			request_key: "hold-parent",
			operation: "hold",
			target_id: runId,
			if_revision: store.getRun(runId)!.revision,
			payload: { reason: "review" },
		});
		const recoveryHost: ChildExecutionHost = {
			...host,
			createRun: () => {
				throw new Error("No new child");
			},
		};
		expect(store.reconcileChildExecution(owner.owner_id, owner.epoch, recoveryHost, identity)?.state).toBe("running");
		expect(cancellations).toBe(0);
		expect(store.getRun(childId)!.state).toBe("queued");
		expect(store.getRun(runId)!.state).toBe("held");
		const stateWhileRunning = recoveryHost.childState;
		recoveryHost.childState = () => "succeeded";
		recoveryHost.verifyAggregation = () => {
			throw new Error("A held parent must not aggregate");
		};
		expect(store.reconcileChildExecution(owner.owner_id, owner.epoch, recoveryHost, identity)?.state).toBe("running");
		expect(
			store.createInheritedChildExecution(owner.owner_id, owner.epoch, host, identity, child(store, runId), {
				mode: "serial",
				description: "fixture",
			}).status,
		).toBe("rejected");
		recoveryHost.childState = stateWhileRunning;
		store.mutateLifecycle("owner", {
			version: 1,
			request_key: "cancel-parent",
			operation: "cancel",
			target_id: runId,
			if_revision: store.getRun(runId)!.revision,
			payload: { reason: "user cancelled" },
		});
		expect(store.reconcileChildExecution(owner.owner_id, owner.epoch, recoveryHost, identity)?.state).toBe(
			"cancelled",
		);
		expect(cancellations).toBe(1);
		expect(store.getRun(childId)!.state).toBe("cancelled");
	});
});

import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildExecutionHost } from "../src/graph/child-execution";
import type { ProgramExecutionRequest, ProgramResult } from "../src/graph/executors/program";
import { GraphHost, type GraphHostChildOptions } from "../src/graph/host";
import {
	GraphRunStore,
	type GraphChildDispatchPolicy,
	type GraphDispatchIntent,
	type GraphSerialChildSettlement,
	type GraphStoredInvocation,
} from "../src/graph/store";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const ref = { id: "fixture", digest: `sha256:${"a".repeat(64)}` };
const roots: string[] = [];
const stores: GraphRunStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-parent-dispatch-"));
	roots.push(root);
	let store = new GraphRunStore(limits, root);
	stores.push(store);
	const configureArtifacts = () =>
		store.configureArtifacts({
			maxBytes: limits.maxBytes,
			authorize: async (principal, _action, scope) => scope.includes(principal),
		});
	const artifacts = configureArtifacts();
	const member = {
		bot: ref,
		model: "fixture",
		base: "omp-default",
		duty: "code-only",
		permissions: { read: ["src"], write: ["src"], execute: [] },
	};
	const markdown = (definition: object) => `---\n${JSON.stringify(definition)}\n---\n## task\nDo the approved work.\n`;
	const child = markdown({
		format: "omp.graph/v1",
		name: "child",
		members: {},
		policy: { max_parallel: 1 },
		nodes: { implement: { kind: "program", task: "#task", executor: "test", writes: ["src"] } },
	});
	const publication = {
		media_type: "text/markdown",
		producer_attempt_id: "planner",
		source_ref: null,
		access_scope: ["alice"],
	};
	const plan = await artifacts.store.publish("alice", Buffer.from(child), publication);
	await artifacts.register([{ artifact: plan, expected: publication }]);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content: markdown({
				format: "omp.graph/v1",
				name: "parent",
				members: { coder: member },
				nodes: {
					build: {
						kind: "subgraph",
						task: "#task",
						member: "coder",
						writes: ["src"],
						inputs: { plan: { run_input: "plan" } },
						required_inputs: ["plan"],
						consume: ["quota"],
						child_policy: { kinds: ["program"], max_nodes: 2, max_parallel: 1 },
					},
					deliver: { kind: "program", task: "#task", executor: "test" },
				},
				edges: [{ id: "deliver", from: "build", to: "deliver" }],
				budgets: { quota: { scope: "run", limit: 1 } },
			}),
		},
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const inputs = { plan: { id: plan.id, digest: plan.digest } };
	const started = store.start(
		{
			version: 1,
			request_key: "start",
			operation: "start",
			target_id: definition.graph_id,
			if_revision: definition.revision,
			payload: { inputs, authorization_ref: ref },
		},
		{
			graph_id: definition.graph_id,
			definition_revision: definition.revision,
			definition_digest: definition.digest,
			authorization_ref: ref,
			inputs,
			executors: { test: ref },
			members: {
				coder: {
					provider: "fixture",
					model: "fixture",
					configuration_revision: "1",
					base: "omp-default",
					base_snapshot_ref: ref,
					role_ref: ref,
					skill_refs: [],
					rule_refs: [],
				},
			},
		},
	);
	if (started.state !== "accepted") throw new Error(started.error?.message);
	const runId = started.target_id!;
	const control = {
		authorized: true,
		integration: false,
		stopped: true,
		staleParent: false,
		childResult: "succeeded" as "succeeded" | "failed" | "running",
		onAuthorize: undefined as GraphChildDispatchPolicy["authorize"] | undefined,
	};
	const cancel = (id: string) =>
		store.mutateLifecycle("alice", {
			version: 1,
			operation: "cancel",
			request_key: `cancel:${id}`,
			target_id: id,
			if_revision: store.getRun(id)!.revision,
			payload: { reason: "Fixture operator cancelled" },
		});
	const configureLifecycle = () => store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	configureLifecycle();
	const launches: ProgramExecutionRequest[] = [];
	const executions = new Map<string, ProgramExecutionRequest>();
	let settled: GraphSerialChildSettlement | null = null;
	const makeHost = () => {
		const owner = store.claimHost()!;
		const recoveryHost: ChildExecutionHost = {
			parent: (_db, identity) => {
				const parent = store.resolveChildParent(owner.owner_id, owner.epoch, identity, "recovery");
				return (
					parent && {
						...parent,
						authority: {
							...parent.authority,
							authorizeExecutor: node => node.executor === "test" && !node.parameters,
						},
					}
				);
			},
			authorizeIsolation: (_db, _identity, isolation) => isolation.mode === "serial",
			createRun: () => {
				throw new Error("Only the Store creates inherited Runs");
			},
			cancelRun: (_db, id) => {
				cancel(id);
			},
			childState: (_db, id) => {
				const state = store.getRun(id)!.state;
				return state === "queued" || state === "cancelling" ? "running" : state;
			},
			verifyAggregation: () => null,
			completeParent: () => false,
		};
		const childOptions: GraphHostChildOptions = {
			admission: { authorize: (db, context) => control.onAuthorize?.(db, context) ?? control.authorized },
			recovery: {
				host: recoveryHost,
				resolveIdentity: (run, invocation) =>
					store.resolveChildRecoveryIdentity(owner.owner_id, owner.epoch, run, invocation),
			},
			resolve: async intent => ({
				input: "plan",
				principal: "alice",
				isolation: { mode: "serial", description: "Controlled fixture; no OS sandbox" },
				output_bindings: {},
				stopped: {
					if_parent_revision: control.staleParent ? "0" : store.getRun(intent.run_id)!.revision,
					termination_ref: ref,
					observed: "Fixture parent has no external work",
				},
			}),
			observe: async (record, parent, admission) => {
				const childRun = store.getRun(record.child_run_id)!;
				if (!control.stopped || !["succeeded", "failed", "cancelled"].includes(childRun.state)) return null;
				const stopped = {
					identity: admission,
					if_revision: childRun.revision,
					termination_ref: ref,
					observed: "Fixture child has no external effects",
				};
				if (store.getRun(parent.run_id)!.state === "cancelling" || childRun.state !== "succeeded") {
					settled = { parent, stopped };
					return { type: "settle", request: settled };
				}
				return {
					type: "integrate",
					request: {
						parent,
						stopped,
						principal: "alice",
						outcome: "done",
						integration_ref: ref,
						observed: "Fixture integration checked independently",
					},
				};
			},
			verifyIntegration: () => control.integration,
		};
		const host = new GraphHost({
			store,
			child: childOptions,
			program: {
				verifyRegistration: (_name, binding) => binding.digest === ref.digest,
				accept: async request => {
					launches.push(structuredClone(request));
					executions.set(request.attempt_id, request);
					return { state: "accepted", execution_ref: request.attempt_id, error: null };
				},
				query: id => {
					const request = executions.get(id)!;
					return {
						attempt_id: request.attempt_id,
						fence: request.fence,
						state: request.run_id === runId ? "succeeded" : control.childResult,
						outcome: "done",
						verdict: null,
						outputs: {},
						error: null,
						usage: { tokens: null, cost: null, currency: null },
					} satisfies ProgramResult;
				},
				cancel: () => "unknown",
			},
			resolveProgram: async intent => ({
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
				principal: "alice",
				output_scope: ["alice"],
			}),
			verifyProgramResult: async (intent, result) => ({
				run_id: intent.run_id,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				state: result.state as "succeeded" | "failed",
				outcome: "done",
				outputs: {},
			}),
		});
		if (!host.start()) throw new Error("Fixture could not acquire its Host");
		return { host, owner, childOptions };
	};
	const pump = async (host: GraphHost, count = 16) => {
		for (let index = 0; index < count; index++) await host.tick();
	};
	const reopen = () => {
		store.close();
		stores.splice(stores.indexOf(store), 1);
		store = new GraphRunStore(limits, root);
		stores.push(store);
		configureArtifacts();
		configureLifecycle();
	};
	return {
		root,
		runId,
		control,
		launches,
		cancel,
		makeHost,
		pump,
		reopen,
		get store() {
			return store;
		},
		get settlement() {
			return settled;
		},
	};
}

it("does not consume a subgraph budget when trusted admission returns a non-boolean approval", async () => {
	const f = await fixture();
	f.control.onAuthorize = () => "approved" as unknown as boolean;
	const { host } = f.makeHost();
	await f.pump(host, 3);
	expect(f.store.getRun(f.runId)!.state).toBe("held");
	expect(f.store.getScheduleState(f.runId)!.counters).toEqual([]);
	expect(f.store.getDispatchIntents(f.runId)).toEqual([]);
	expect(f.launches).toEqual([]);
});

it.each([
	{ phase: "reserve", occurrence: 1 },
	{ phase: "dispatch", occurrence: 1 },
	{ phase: "create", occurrence: 1 },
	{ phase: "create", occurrence: 2 },
])("preserves cancellation reentered during $phase authorization #$occurrence", async ({ phase, occurrence }) => {
	const f = await fixture();
	let calls = 0;
	f.control.onAuthorize = (_db, context) => {
		if (context.phase === phase && ++calls === occurrence) f.cancel(f.runId);
		return true;
	};
	const { host, owner } = f.makeHost();
	await f.pump(host, 3);
	expect(["cancelling", "cancelled"]).toContain(f.store.getRun(f.runId)!.state);
	expect(f.store.listSerialChildExecutions(owner.owner_id, owner.epoch)).toEqual([]);
	expect(f.store.listHostRuns().filter(run => run.id !== f.runId)).toEqual([]);
	expect(f.launches).toEqual([]);
});

it("runs an admitted child but prevents parent delivery until trusted integration accepts it", async () => {
	const f = await fixture();
	const { host, owner } = f.makeHost();
	await f.pump(host);
	const entry = f.store.listSerialChildExecutions(owner.owner_id, owner.epoch)[0];
	expect(f.store.getRun(entry.record.child_run_id)!.state).toBe("succeeded");
	expect(f.launches.map(request => request.run_id)).toEqual([entry.record.child_run_id]);
	expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "build")!.state).toBe("running");
	f.control.integration = true;
	await f.pump(host);
	expect(f.store.getRun(f.runId)!.state).toBe("succeeded");
	expect(f.launches.map(request => request.run_id)).toEqual([entry.record.child_run_id, f.runId]);
	expect(f.store.getScheduleState(f.runId)!.counters[0].consumed).toBe(1);
	expect(f.store.getScheduleState(entry.record.child_run_id)!.counters).toEqual([]);
	expect(f.store.getAttemptHistory(f.runId).filter(item => item.accepted)).toHaveLength(2);
	expect(f.store.getProfileWriterAdmissions(owner.owner_id, owner.epoch).map(item => item.run_id)).toEqual([f.runId]);
});

it("rolls creation, provenance and writer lending back when parent stop evidence has a stale revision", async () => {
	const f = await fixture();
	f.control.staleParent = true;
	const { host, owner } = f.makeHost();
	await f.pump(host, 3);
	expect(f.store.getRun(f.runId)!.state).toBe("held");
	expect(f.store.getDispatchIntents(f.runId)[0].state).toBe("unknown");
	expect(f.store.listSerialChildExecutions(owner.owner_id, owner.epoch)).toEqual([]);
	const db = new Database(path.join(f.root, "graphs.sqlite"), { readonly: true });
	try {
		expect(db.query("SELECT COUNT(*) AS n FROM graph_runs").get()).toEqual({ n: 1 });
		expect(db.query("SELECT COUNT(*) AS n FROM graph_child_plan_inputs").get()).toEqual({ n: 0 });
	} finally {
		db.close();
	}
	expect(f.store.getScheduleState(f.runId)!.counters[0].consumed).toBe(1);
	expect(f.launches).toEqual([]);
});

it("recovers an accepted parent and its queued child without buying another implementation attempt", async () => {
	const f = await fixture();
	const first = f.makeHost();
	await f.pump(first.host, 2);
	const childId = f.store.listSerialChildExecutions(first.owner.owner_id, first.owner.epoch)[0].record.child_run_id;
	expect(f.store.getRun(childId)!.state).toBe("queued");
	f.reopen();
	f.control.integration = true;
	const second = f.makeHost();
	await f.pump(second.host);
	expect(f.store.getRun(f.runId)!.state).toBe("succeeded");
	expect(f.launches.map(request => request.run_id)).toEqual([childId, f.runId]);
	expect(f.store.getDispatchIntents(f.runId)).toHaveLength(2);
	expect(f.store.getScheduleState(f.runId)!.counters[0].consumed).toBe(1);
});

it("retains cancelled containment for later stop confirmation and never promotes a late child success", async () => {
	const f = await fixture();
	f.control.stopped = false;
	const { host, owner } = f.makeHost();
	await f.pump(host);
	const entry = f.store.listSerialChildExecutions(owner.owner_id, owner.epoch)[0];
	f.cancel(f.runId);
	await f.pump(host, 2);
	expect(f.store.getRun(f.runId)!.state).toBe("cancelling");
	expect(f.store.listSerialChildExecutions(owner.owner_id, owner.epoch)[0].record.state).toBe("cancelled");
	f.control.stopped = true;
	await f.pump(host, 2);
	expect(f.store.getRun(f.runId)!.state).toBe("cancelled");
	expect(f.store.getRun(entry.record.child_run_id)!.state).toBe("succeeded");
	expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "build")!.state).toBe("cancelled");
	expect(f.launches.map(request => request.run_id)).toEqual([entry.record.child_run_id]);
	const revision = f.store.getRun(f.runId)!.revision;
	expect(f.store.settleSerialChildExecution(owner.owner_id, owner.epoch, f.settlement!)).toBe(true);
	expect(f.store.getRun(f.runId)!.revision).toBe(revision);
	expect(f.store.getProfileWriterAdmissions(owner.owner_id, owner.epoch).map(item => item.run_id)).toEqual([f.runId]);
});

it("settles a failed child only after stop proof and does not dispatch its parent successor", async () => {
	const f = await fixture();
	f.control.childResult = "failed";
	f.control.stopped = false;
	const { host, owner } = f.makeHost();
	await f.pump(host);
	const entry = f.store.listSerialChildExecutions(owner.owner_id, owner.epoch)[0];
	expect(f.store.getRun(entry.record.child_run_id)!.state).toBe("failed");
	expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "build")!.state).toBe("running");
	f.control.stopped = true;
	await f.pump(host);
	expect(f.store.getRun(f.runId)!.state).toBe("failed");
	expect(f.launches.map(request => request.run_id)).toEqual([entry.record.child_run_id]);
	expect(f.store.listSerialChildExecutions(owner.owner_id, owner.epoch)).toEqual([]);
	expect(f.store.getAttemptHistory(f.runId).filter(item => item.accepted)).toHaveLength(1);
});

it("reconciles a failed pre-creation dispatch across restart without replaying work or refunding quota", async () => {
	const f = await fixture();
	f.control.staleParent = true;
	const first = f.makeHost();
	await f.pump(first.host, 3);
	const intent = f.store.getDispatchIntents(f.runId)[0];
	f.reopen();
	const second = f.makeHost();
	const request = {
		parent: {
			run_id: intent.run_id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
		},
		if_revision: f.store.getRun(f.runId)!.revision,
		termination_ref: ref,
		observed: "Trusted fixture confirms no child or external execution was launched",
	};
	expect(
		f.store.reconcileUnstartedChildDispatch(second.owner.owner_id, second.owner.epoch, {
			...request,
			if_revision: "0",
		}),
	).toBe(false);
	expect(f.store.reconcileUnstartedChildDispatch(second.owner.owner_id, second.owner.epoch, request)).toBe(true);
	expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "build")!.state).toBe("failed");
	expect(f.store.reconcileUnstartedChildDispatch(second.owner.owner_id, second.owner.epoch, request)).toBe(true);
	expect(f.store.getAttemptHistory(f.runId).filter(item => item.accepted)).toHaveLength(1);
	expect(f.store.getScheduleState(f.runId)!.counters[0].consumed).toBe(1);
	expect(f.launches).toEqual([]);
	expect(
		f.store.getProfileWriterAdmissions(second.owner.owner_id, second.owner.epoch).map(item => item.run_id),
	).toEqual([f.runId]);
});

it("rechecks trusted policy at dispatch and reports a held Run without starting a child", async () => {
	const f = await fixture();
	f.control.onAuthorize = (_db, context) => context.phase === "reserve";
	const { host, owner } = f.makeHost();
	await f.pump(host, 3);
	expect(f.store.getRun(f.runId)).toMatchObject({
		state: "held",
		reason: "Subgraph dispatch requires current trusted admission",
	});
	expect(f.store.getDispatchIntents(f.runId)[0].state).toBe("pending");
	expect(f.store.listSerialChildExecutions(owner.owner_id, owner.epoch)).toEqual([]);
	expect(f.store.getScheduleState(f.runId)!.counters[0].consumed).toBe(1);
	f.cancel(f.runId);
	expect(f.store.getRun(f.runId)!.state).toBe("cancelled");
	expect(f.launches).toEqual([]);
});

it("does not let admission inspection replace the frozen parent node or plan", async () => {
	const f = await fixture();
	f.control.onAuthorize = (_db, context) => {
		context.invocation.node = "not-the-parent";
		const invocation = context.invocation as GraphStoredInvocation;
		if (invocation.ready) invocation.ready.inputs.plan = { id: "other", digest: ref.digest };
		context.snapshot.definition = "untrusted replacement";
		return true;
	};
	f.control.integration = true;
	const { host } = f.makeHost();
	await f.pump(host);
	expect(f.store.getRun(f.runId)!.state).toBe("succeeded");
	expect(f.launches.map(request => request.executor)).toEqual(["test", "test"]);
	expect(
		f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "build")!.ready!.inputs.plan,
	).not.toEqual({ id: "other", digest: ref.digest });
});

it("continues independent running work after a known failure and only then terminates the Run as failed", async () => {
	const f = await fixture();
	const imported = f.store.definitions.mutate({
		version: 1,
		operation: "import",
		request_key: "independent-definition",
		target_id: null,
		if_revision: null,
		payload: {
			content:
				"---\nformat: omp.graph/v1\nname: independent\nmembers: {}\npolicy: {max_parallel: 2}\nnodes:\n  a: {kind: program, executor: test, task: '#task'}\n  b: {kind: program, executor: test, task: '#task'}\n---\n## task\nWork.\n",
		},
	});
	const definition = f.store.definitions.get(imported.target_id!)!;
	const started = f.store.start(
		{
			version: 1,
			operation: "start",
			request_key: "independent-start",
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
			members: {},
			executors: { test: ref },
		},
	);
	const runId = started.target_id!;
	const owner = f.store.claimHost()!;
	const pending: GraphDispatchIntent[] = [];
	for (let index = 0; index < 4; index++) {
		const intent = f.store.schedule(runId, owner.owner_id, owner.epoch).intent;
		if (intent) {
			f.store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
			pending.push(intent);
		}
	}
	expect(pending).toHaveLength(2);
	const complete = (index: number, state: "succeeded" | "failed") => {
		const intent = pending[index];
		expect(
			f.store.completeAttempt(owner.owner_id, owner.epoch, {
				run_id: runId,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				state,
				...(state === "succeeded" ? { outcome: "done", outputs: {} } : {}),
			}),
		).toBe(true);
	};
	complete(0, "failed");
	f.store.schedule(runId, owner.owner_id, owner.epoch);
	expect(f.store.getRun(runId)!.state).toBe("running");
	complete(1, "succeeded");
	for (let index = 0; index < 3; index++) f.store.schedule(runId, owner.owner_id, owner.epoch);
	expect(f.store.getRun(runId)!.state).toBe("failed");
	expect(
		f.store
			.getScheduleState(runId)!
			.invocations.map(item => item.state)
			.sort(),
	).toEqual(["failed", "succeeded"]);
});

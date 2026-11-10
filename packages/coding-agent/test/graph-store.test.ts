import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { QueueRecord } from "../src/graph/executors/queue";
import {
	GraphRunStore,
	type GraphDispatchIntent,
	type GraphPreparedRun,
	type GraphStartRequest,
	type GraphFinalReviewPolicy,
} from "../src/graph/store";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const roots: string[] = [];
const stores: GraphRunStore[] = [];
function open() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-run-"));
	roots.push(root);
	const store = new GraphRunStore(limits, root);
	stores.push(store);
	return { root, store };
}
const auth = { id: "authorization", digest: "sha256:test" };
function startRequest(graph: string, revision: string, key: string): GraphStartRequest {
	return {
		version: 1,
		request_key: key,
		operation: "start",
		target_id: graph,
		if_revision: revision,
		payload: { inputs: {}, authorization_ref: auth },
	};
}
function prepared(graph: string, revision: string, digest: string): GraphPreparedRun {
	return {
		graph_id: graph,
		definition_revision: revision,
		definition_digest: digest,
		authorization_ref: auth,
		inputs: {},
		members: {},
		executors: {},
	};
}
function preparedProgram(graph: string, revision: string, digest: string): GraphPreparedRun {
	return { ...prepared(graph, revision, digest), executors: { test: { id: "test", digest: "sha256:test" } } };
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Graph durable run admission", () => {
	it("rejects starting an empty draft without creating a Run", () => {
		const { store } = open();
		const created = store.definitions.mutate({
			version: 1,
			request_key: "create",
			operation: "create",
			target_id: null,
			if_revision: null,
			payload: { name: "empty" },
		});
		const snapshot = store.definitions.get(created.target_id!)!;
		const request = startRequest(snapshot.graph_id, snapshot.revision, "start");
		const result = store.start(request, prepared(snapshot.graph_id, snapshot.revision, snapshot.digest));
		expect(result.error?.code).toBe("definition_invalid");
		expect(result.error?.message).toBe("missing_entry");
		expect(store.getRun(result.target_id!)).toBeNull();
		expect(store.definitions.requestGet("start")).toEqual(result);
	});

	it("rejects an invalid definition even when entry nodes are supplied", () => {
		const { store } = open();
		const created = store.definitions.mutate({
			version: 1,
			request_key: "create-entry",
			operation: "create",
			target_id: null,
			if_revision: null,
			payload: { name: "entry" },
		});
		const snapshot = store.definitions.get(created.target_id!)!;
		const request = startRequest(snapshot.graph_id, snapshot.revision, "start-entry");
		const payload = { ...request.payload, entry_nodes: ["spec"] };
		const result = store.start(
			{ ...request, payload },
			prepared(snapshot.graph_id, snapshot.revision, snapshot.digest),
		);
		expect(result.state).toBe("rejected");
		expect(result.error?.code).toBe("definition_invalid");
		expect(store.listHostRuns()).toEqual([]);
	});

	it("persists authorized imported provenance and schedules the remaining entry", () => {
		const { root, store } = open();
		const content = `---
format: omp.graph/v1
name: imports
members: {}
nodes:
  research:
    kind: program
    executor: research
    task: '#task'
    outputs: {report: {media_type: text/plain, required: true}}
  review:
    kind: human
    task: '#task'
    required_gate: true
    required_inputs: [report]
edges:
  - {id: handoff, from: research, to: review, bind: {report: report}}
---
## task
Work.
`;
		const created = store.definitions.mutate({
			version: 1,
			request_key: "import-graph",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const definition = store.definitions.get(created.target_id!)!;
		const report = { id: "report", digest: "sha256:report" };
		const provided = { research: { report } };
		const request = {
			...startRequest(definition.graph_id, definition.revision, "import-run"),
			payload: { inputs: {}, authorization_ref: auth, entry_nodes: ["review"], provided_outputs: provided },
		};
		const frozen = prepared(definition.graph_id, definition.revision, definition.digest);
		frozen.executors.research = { id: "executor", digest: "sha256:executor" };
		const evidence = {
			outputs: provided.research,
			source_ref: { id: "source", digest: "sha256:source" },
			definition_digest: definition.digest,
			authorization_ref: auth,
			run_inputs: {},
			provided_outputs: provided,
		};
		expect(store.start({ ...request, request_key: "missing-evidence" }, frozen).error?.code).toBe("gate_unsatisfied");
		frozen.imports = { research: evidence };
		expect(
			store.start(
				{ ...request, request_key: "wrong-entry", payload: { ...request.payload, entry_nodes: ["research"] } },
				frozen,
			).error?.code,
		).toBe("gate_unsatisfied");
		expect(
			store.start(
				{ ...request, request_key: "stale-evidence" },
				{
					...frozen,
					imports: { research: { ...evidence, definition_digest: "old" } },
				},
			).error?.code,
		).toBe("gate_unsatisfied");
		expect(
			store.start(
				{ ...request, request_key: "unauthorized" },
				{
					...frozen,
					imports: { research: { ...evidence, authorization_ref: { id: "other", digest: "other" } } },
				},
			).error?.code,
		).toBe("gate_unsatisfied");
		const missing = { research: {} };
		expect(
			store.start(
				{
					...request,
					request_key: "missing-output",
					payload: { ...request.payload, provided_outputs: missing },
				},
				{
					...frozen,
					imports: { research: { ...evidence, outputs: {}, provided_outputs: missing } },
				},
			).error?.code,
		).toBe("gate_unsatisfied");
		const started = store.start(request, frozen);
		expect(started.state).toBe("accepted");
		const run = store.getRun(started.target_id!)!;
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		expect(reopened.start(request, frozen)).toEqual(started);
		expect(reopened.getSnapshot(run.snapshot_ref)?.imports?.research).toEqual(evidence);
		const state = reopened.getScheduleState(run.id)!;
		expect(state.invocations.find(item => item.node === "research")).toMatchObject({
			origin: "imported",
			state: "succeeded",
			routed: true,
			outputs: provided.research,
			import_evidence: evidence,
		});
		const owner = store.claimHost()!;
		expect(store.schedule(run.id, owner.owner_id, owner.epoch).action).toMatchObject({
			type: "ready",
			inputs: { report },
		});
	});

	it("refuses to import a required gate despite trusted evidence", () => {
		const { store } = open();
		const content = `---
format: omp.graph/v1
name: gate
members: {}
nodes:
  review: {kind: program, executor: review, task: '#task', required_gate: true, outputs: {report: {media_type: text/plain, required: true}}}
  next: {kind: human, task: '#task', required_inputs: [report]}
edges:
  - {id: handoff, from: review, to: next, bind: {report: report}}
---
## task
Work.
`;
		const created = store.definitions.mutate({
			version: 1,
			request_key: "gate-graph",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const definition = store.definitions.get(created.target_id!)!;
		const outputs = { review: { report: { id: "report", digest: "sha256:report" } } };
		const frozen = prepared(definition.graph_id, definition.revision, definition.digest);
		frozen.executors.review = { id: "executor", digest: "sha256:executor" };
		frozen.imports = {
			review: {
				outputs: outputs.review,
				source_ref: { id: "source", digest: "sha256:source" },
				definition_digest: definition.digest,
				authorization_ref: auth,
				run_inputs: {},
				provided_outputs: outputs,
			},
		};
		const result = store.start(
			{
				...startRequest(definition.graph_id, definition.revision, "gate-run"),
				payload: { inputs: {}, authorization_ref: auth, entry_nodes: ["next"], provided_outputs: outputs },
			},
			frozen,
		);
		expect(result.error?.code).toBe("gate_unsatisfied");
		expect(store.listHostRuns()).toEqual([]);
		expect(store.definitions.requestGet("gate-run")).toEqual(result);
	});

	it("reconciles a lost start receipt and keeps the Run's definition frozen after editing", () => {
		const { root, store } = open();
		const content =
			"---\nformat: omp.graph/v1\nname: human\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n";
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const snapshot = store.definitions.get(imported.target_id!)!;
		const request = startRequest(snapshot.graph_id, snapshot.revision, "start");
		const frozen = prepared(snapshot.graph_id, snapshot.revision, snapshot.digest);
		const started = store.start(request, frozen);
		expect(started.state).toBe("accepted");
		const run = store.getRun(started.target_id!)!;
		expect(run.state).toBe("queued");
		const edit = store.definitions.mutate({
			version: 1,
			request_key: "edit",
			operation: "edit",
			target_id: snapshot.graph_id,
			if_revision: snapshot.revision,
			payload: { content: content + "\nNew prose.\n" },
		});
		expect(edit.state).toBe("completed");
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		expect(reopened.start(request, frozen)).toEqual(started);
		expect(reopened.getSnapshot(run.snapshot_ref)?.definition).toBe(content);
		expect(reopened.start({ ...request, if_revision: edit.revision! }, frozen).error?.code).toBe(
			"idempotency_conflict",
		);
	});

	it("keeps one live host owner and advances the fence after release", () => {
		const { root, store } = open();
		const other = new GraphRunStore(limits, root);
		stores.push(other);
		const first = store.claimHost()!;
		expect(first.epoch).toBe("1");
		expect(other.claimHost()).toBeNull();
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const next = other.claimHost()!;
		expect(next.epoch).toBe("2");
		other.assertHostOwner(next.owner_id, next.epoch);
		expect(() => other.assertHostOwner(first.owner_id, first.epoch)).toThrow("stale");
	});

	it("retains external queue identities across separate store connections", async () => {
		const { root, store } = open();
		const record: QueueRecord = {
			service_id: "queue",
			attempt_id: "attempt",
			fence: "42",
			request_key: "queue-key",
			external_task_id: "external",
			state: "queued",
			result_refs: [],
			observed_at: new Date().toISOString(),
			request: {
				version: 1,
				run_id: "run",
				invocation_id: "invocation",
				attempt_id: "attempt",
				fence: "42",
				request_key: "queue-key",
				executor: "queue",
				inputs: {},
				task_ref: auth,
				authorization_ref: auth,
				model_binding_ref: null,
				base_snapshot_ref: null,
				duty: "general",
				deadline: null,
			},
		};
		await store.transact("queue-key", () => ({ record, value: undefined }));
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		const restored = await reopened.transact("queue-key", current => ({ record: current, value: current }));
		expect(restored).toEqual(record);
		await expect(
			reopened.transact("queue-key", current => ({ record: { ...current!, request_key: "other" }, value: null })),
		).rejects.toThrow("identity");
	});
});

it("commits frozen inputs, reservations and dispatch before accepting only the current completion", () => {
	const { root, store } = open();
	const content = `---
format: omp.graph/v1
name: durable
members: {}
nodes:
  approval:
    kind: program
    executor: test
    task: '#approval'
    inputs: {message: {text: frozen}}
    consume: [quota]
budgets:
  quota: {scope: run, limit: 1}
---
## approval
Decide.
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import-durable",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const started = store.start(
		startRequest(definition.graph_id, definition.revision, "start-durable"),
		preparedProgram(definition.graph_id, definition.revision, definition.digest),
	);
	expect(started.state).toBe("accepted");
	const runId = started.target_id!;
	const owner = store.claimHost()!;
	const initial = store.getScheduleState(runId)!;
	expect(initial.invocations).toHaveLength(1);
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
	const authorized = store.schedule(runId, owner.owner_id, owner.epoch);
	expect(authorized.action?.type).toBe("authorize");
	const intent = authorized.intent!;
	expect(intent.request).toMatchObject({ inputs: { message: "frozen" }, invocation_id: intent.invocation_id });
	expect(store.getScheduleState(runId)?.counters).toEqual([
		{ key: "budget:quota:run:run", consumed: 1, reservations: [intent.invocation_id] },
	]);
	const reopened = new GraphRunStore(limits, root);
	stores.push(reopened);
	expect(reopened.getDispatchIntents(runId)).toEqual([intent]);
	expect(reopened.getScheduleState(runId)).toEqual(store.getScheduleState(runId));
	expect(() => reopened.schedule(runId, owner.owner_id, owner.epoch)).toThrow("stale");
	const completion = {
		run_id: runId,
		invocation_id: intent.invocation_id,
		attempt_id: intent.attempt_id,
		fence: intent.fence,
		state: "succeeded" as const,
		outcome: "done",
	};
	expect(store.completeAttempt(owner.owner_id, owner.epoch, { ...completion, attempt_id: "stale" })).toBe(false);
	expect(store.getScheduleState(runId)?.invocations[0].state).toBe("running");
	expect(store.completeAttempt(owner.owner_id, owner.epoch, completion)).toBe(true);
	expect(store.completeAttempt(owner.owner_id, owner.epoch, completion)).toBe(false);
	expect(store.getAttemptHistory(runId).map(item => item.accepted)).toEqual([false, true, false]);
	expect(store.getDispatchIntents(runId)[0].state).toBe("finished");
	expect(store.schedule(runId, owner.owner_id, owner.epoch).run.state).toBe("succeeded");
});

it("rejects invalid successful results before settling an attempt or releasing downstream work", async () => {
	const { store } = open();
	const content = `---
format: omp.graph/v1
name: validated-completion
members: {}
nodes:
  review:
    kind: program
    executor: test
    task: '#task'
    outcomes: [pass, revise]
    verdicts: [APPROVE, REJECT]
    decisions:
      - {outcome: pass, verdict: APPROVE}
      - {outcome: revise, verdict: REJECT}
    outputs: {report: {media_type: text/markdown, required: true}}
  deliver: {kind: program, executor: test, task: '#task'}
edges:
  - {id: approved, from: review, to: deliver, on: [pass]}
---
## task
Review.
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import-validated",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	if (imported.error) throw new Error(JSON.stringify(imported.error));
	const definition = store.definitions.get(imported.target_id!)!;
	const started = store.start(
		startRequest(definition.graph_id, definition.revision, "start-validated"),
		preparedProgram(definition.graph_id, definition.revision, definition.digest),
	);
	const runId = started.target_id!;
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	const completion = {
		run_id: runId,
		invocation_id: intent.invocation_id,
		attempt_id: intent.attempt_id,
		fence: intent.fence,
		state: "succeeded" as const,
		outcome: "pass",
		verdict: "APPROVE",
	};
	const registry = store.configureArtifacts({ maxBytes: 1024, authorize: async () => true });
	const publication = {
		media_type: "text/markdown",
		producer_attempt_id: intent.attempt_id,
		source_ref: null,
		access_scope: ["reviewer"],
	};
	const report = await registry.store.publish("reviewer", Buffer.from("Evidence-backed approval"), publication);
	const ref = { id: report.id, digest: report.digest };
	const outputs = { report: ref };
	for (const invalid of [
		{ ...completion, outputs: {} },
		{ ...completion, outputs, outcome: undefined },
		{ ...completion, outputs, outcome: "publish" },
		{ ...completion, outputs, verdict: "REJECT" },
		{ ...completion, outputs: { report: { id: "", digest: ref.digest } } },
		{ ...completion, outputs: { ...outputs, secret: ref } },
	]) {
		expect(store.completeAttempt(owner.owner_id, owner.epoch, invalid)).toBe(false);
		expect(store.getScheduleState(runId)!.invocations.find(item => item.id === intent.invocation_id)!.state).toBe(
			"running",
		);
		expect(store.getDispatchIntents(runId)[0].state).toBe("pending");
	}
	expect(store.getAttemptHistory(runId).every(item => !item.accepted)).toBe(true);
	const registration = await registry.prepareRegistration([{ artifact: report, expected: publication }]);
	expect(store.completeAttempt(owner.owner_id, owner.epoch, { ...completion, outputs }, registration)).toBe(true);
	expect(store.getAttemptHistory(runId).at(-1)!.accepted).toBe(true);
	expect(store.getScheduleState(runId)!.invocations.find(item => item.id === intent.invocation_id)).toMatchObject({
		state: "succeeded",
		outputs,
	});
	store.schedule(runId, owner.owner_id, owner.epoch);
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
});

it("persists the submission boundary and holds an uncertain dispatch without resubmitting", () => {
	const { root, store } = open();
	const content =
		"---\nformat: omp.graph/v1\nname: dispatch\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n";
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import-dispatch",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const started = store.start(
		startRequest(definition.graph_id, definition.revision, "start-dispatch"),
		prepared(definition.graph_id, definition.revision, definition.digest),
	);
	const runId = started.target_id!;
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	expect(store.listHostRuns().map(run => run.id)).toContain(runId);
	expect(store.claimDispatch(owner.owner_id, owner.epoch, intent.id)?.state).toBe("submitting");
	expect(store.claimDispatch(owner.owner_id, owner.epoch, intent.id)).toBeNull();
	expect(store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "unknown", { reason: "lost receipt" })).toBe(
		true,
	);
	expect(store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "accepted", {})).toBe(false);
	expect(store.getRun(runId)?.state).toBe("held");
	const reopened = new GraphRunStore(limits, root);
	stores.push(reopened);
	expect(reopened.listHostIntents().find(item => item.id === intent.id)?.state).toBe("unknown");
	expect(reopened.getRun(runId)?.state).toBe("held");
	// An uncertain dispatch is a recovery hold, not an operator pause: a bare resume must
	// name the reconciliation requirement instead of reporting a missing operator pause.
	reopened.configureLifecycle({ authorize: () => true, verifyResume: () => true });
	const refused = reopened.mutateLifecycle("operator", {
		version: 1,
		request_key: "resume-recovery",
		operation: "resume",
		target_id: runId,
		if_revision: reopened.getRun(runId)!.revision,
		payload: { kind: "operator" },
	});
	expect(refused.error?.code).toBe("gate_unsatisfied");
	expect(refused.error?.message).toContain("reconciliation");
	expect(reopened.getRun(runId)?.state).toBe("held");
});

it("does not accept completion from a previous host fence", () => {
	const { root, store } = open();
	const content =
		"---\nformat: omp.graph/v1\nname: fenced\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n";
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import-fenced",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const runId = store.start(
		startRequest(definition.graph_id, definition.revision, "start-fenced"),
		prepared(definition.graph_id, definition.revision, definition.digest),
	).target_id!;
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	store.close();
	stores.splice(stores.indexOf(store), 1);
	const next = new GraphRunStore(limits, root);
	stores.push(next);
	const newOwner = next.claimHost()!;
	expect(
		next.completeAttempt(newOwner.owner_id, newOwner.epoch, {
			run_id: runId,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			state: "succeeded",
			outcome: "done",
		}),
	).toBe(false);
	expect(next.getScheduleState(runId)?.invocations[0].state).toBe("running");
	expect(next.getAttemptHistory(runId)[0].accepted).toBe(false);
	const held = next.schedule(runId, newOwner.owner_id, newOwner.epoch);
	expect(held.action?.type).toBe("hold");
	expect(held.run.state).toBe("held");
});

it("defers a terminal disposition until parallel invocations settle", () => {
	const { store } = open();
	const content = `---
format: omp.graph/v1
name: parallel
members: {}
nodes:
  a: {kind: program, executor: test, task: '#task'}
  b: {kind: program, executor: test, task: '#task'}
policy: {max_parallel: 2}
---
## task
Decide.
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import-parallel",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const result = store.start(
		startRequest(definition.graph_id, definition.revision, "start-parallel"),
		preparedProgram(definition.graph_id, definition.revision, definition.digest),
	);
	expect(result.state).toBe("accepted");
	const runId = result.target_id!;
	const owner = store.claimHost()!;
	const intents: GraphDispatchIntent[] = [];
	for (let i = 0; i < 4; i++) {
		const scheduled = store.schedule(runId, owner.owner_id, owner.epoch);
		if (scheduled.intent) intents.push(scheduled.intent);
	}
	expect(intents).toHaveLength(2);
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: runId,
			invocation_id: intents[0].invocation_id,
			attempt_id: intents[0].attempt_id,
			fence: intents[0].fence,
			state: "succeeded",
			outcome: "done",
		}),
	).toBe(true);
	const first = store.schedule(runId, owner.owner_id, owner.epoch);
	expect(first.action?.type).toBe("routed");
	expect(first.run.state).toBe("running");
	expect(store.getScheduleState(runId)?.invocations.find(item => item.id === intents[0].invocation_id)).toMatchObject({
		routed: true,
		terminal_disposition: "succeed",
	});
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: runId,
			invocation_id: intents[1].invocation_id,
			attempt_id: intents[1].attempt_id,
			fence: intents[1].fence,
			state: "succeeded",
			outcome: "done",
		}),
	).toBe(true);
	expect(store.schedule(runId, owner.owner_id, owner.epoch).run.state).toBe("succeeded");
});

it("holds a restored legacy successful result with a missing outcome", () => {
	const { root, store } = open();
	const content =
		"---\nformat: omp.graph/v1\nname: gate\nmembers: {}\nnodes:\n  approval: {kind: program, executor: test, task: '#approval'}\n---\n## approval\nDecide.\n";
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import-gate",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const runId = store.start(
		startRequest(definition.graph_id, definition.revision, "start-gate"),
		preparedProgram(definition.graph_id, definition.revision, definition.digest),
	).target_id!;
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	const state = store.getScheduleState(runId)!;
	state.invocations.find(item => item.id === intent.invocation_id)!.state = "succeeded";
	const db = new Database(path.join(root, "graphs.sqlite"));
	try {
		db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), runId);
	} finally {
		db.close();
	}
	const held = store.schedule(runId, owner.owner_id, owner.epoch);
	expect(held.action?.type).toBe("hold");
	expect(store.getRun(runId)?.state).toBe("held");
});

it("atomically activates an unambiguous budget route and retains it across reopening", () => {
	const { root, store } = open();
	const content = `---
format: omp.graph/v1
name: budget-route
members: {}
nodes:
  a: {kind: human, task: '#task', consume: [quota], on_budget_exhausted: handler}
  b: {kind: human, task: '#task', consume: [quota], on_budget_exhausted: handler}
  handler: {kind: human, task: '#task'}
budgets:
  quota: {scope: run, limit: 1}
policy: {max_parallel: 2}
---
## task
Decide.
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import-route",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const result = store.start(
		startRequest(definition.graph_id, definition.revision, "start-route"),
		prepared(definition.graph_id, definition.revision, definition.digest),
	);
	expect(result.state).toBe("accepted");
	const runId = result.target_id!;
	const owner = store.claimHost()!;
	const decisions = Array.from({ length: 4 }, () => store.schedule(runId, owner.owner_id, owner.epoch));
	const route = decisions[3].action;
	expect(route?.type).toBe("route");
	const state = store.getScheduleState(runId)!;
	const source = state.invocations.find(item => item.id === route?.invocation_id)!;
	const handler = state.invocations.find(item => item.node === "handler")!;
	expect(source.state).toBe("skipped");
	expect(handler).toMatchObject({
		activated: true,
		activation_source: {
			invocation_id: source.id,
			reason: "budget_exhausted",
		},
	});
	expect(state.counters[0].consumed).toBe(1);
	const reopened = new GraphRunStore(limits, root);
	stores.push(reopened);
	expect(reopened.getScheduleState(runId)).toEqual(state);
	const ready = store.schedule(runId, owner.owner_id, owner.epoch);
	expect(ready.action).toMatchObject({ type: "ready", invocation_id: handler.id });
	const dispatch = store.schedule(runId, owner.owner_id, owner.epoch);
	expect(dispatch.intent?.request).toMatchObject({
		activation_source: {
			invocation_id: source.id,
			reason: "budget_exhausted",
		},
	});
});

it.each(["stage", "cycle"])(
	"delivers a passing last review without waiting for dormant %s final adjudication",
	scope => {
		const { root, store } = open();
		const content = `---
format: omp.graph/v1
name: review-pass
members: {}
nodes:
  edit: {kind: program, executor: test, task: '#task'}
  review: {kind: program, executor: test, task: '#task', outcomes: [pass, revise]}
  final: {kind: program, executor: test, task: '#task', outcomes: [go, hold]}
  deliver: {kind: program, executor: test, task: '#task'}
loops:
  revisions:
    max_reviews: 1
    final_node: final
    retry_target: edit
    final_outcomes: {go: go, hold: hold}
    count_nodes: [review]
    scope: ${scope}
    ${scope === "stage" ? "stage: draft" : "cycle_start: edit\n    reset_from: []"}
edges:
  - {id: forward, from: edit, to: review}
  - {id: back, from: review, to: edit, on: [revise], loop: revisions}
  - {id: ordinary, from: review, to: deliver, on: [pass]}
  - {id: adjudicated, from: final, to: deliver, on: [go]}
---
## task
Work.
`;
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import-pass",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		expect(imported.state).toBe("completed");
		const definition = store.definitions.get(imported.target_id!)!;
		const started = store.start(
			startRequest(definition.graph_id, definition.revision, "start-pass"),
			preparedProgram(definition.graph_id, definition.revision, definition.digest),
		);
		expect(started.state).toBe("accepted");
		const runId = started.target_id!;
		const owner = store.claimHost()!;
		const schedule = () => store.schedule(runId, owner.owner_id, owner.epoch);
		const complete = (intent: GraphDispatchIntent, outcome: string) =>
			store.completeAttempt(owner.owner_id, owner.epoch, {
				run_id: runId,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				state: "succeeded",
				outcome,
			});
		expect(schedule().action?.type).toBe("ready");
		const edit = schedule().intent!;
		expect(complete(edit, "done")).toBe(true);
		expect(schedule().action?.type).toBe("routed");
		expect(schedule().action?.type).toBe("ready");
		const review = schedule().intent!;
		expect(complete(review, "pass")).toBe(true);
		expect(schedule().action?.type).toBe("routed");
		const dormant = store.getScheduleState(runId)!.invocations.find(item => item.node === "final")!;
		expect(dormant).toMatchObject({ state: "pending" });
		expect(dormant.activated).not.toBe(true);
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		expect(reopened.getScheduleState(runId)).toEqual(store.getScheduleState(runId));
		expect(schedule().action).toMatchObject({
			type: "ready",
			upstream_invocation_ids: [review.invocation_id],
			upstream_attempt_ids: [review.attempt_id],
		});
		const delivery = schedule().intent!;
		expect(complete(delivery, "done")).toBe(true);
		expect(schedule().run.state).toBe("succeeded");
		expect(store.getDispatchIntents(runId).some(intent => intent.invocation_id === dormant.id)).toBe(false);
		expect(store.getScheduleState(runId)?.counters.filter(counter => counter.key.startsWith("final:"))).toEqual([]);
	},
);

it.each([1, 3])("persists a bounded rewind or holds unverified final approval at review limit %i", maxReviews => {
	const { root, store } = open();
	const content = `---
format: omp.graph/v1
name: review-loop
members: {}
nodes:
  edit: {kind: program, executor: test, task: '#task'}
  review: {kind: program, executor: test, task: '#task'}
  final: {kind: program, executor: test, task: '#task', outcomes: [go, hold]}
loops:
  revisions:
    max_reviews: ${maxReviews}
    final_node: final
    retry_target: edit
    final_outcomes: {go: go, hold: hold}
    count_nodes: [review]
    scope: stage
    stage: draft
edges:
  - {id: forward, from: edit, to: review}
  - {id: back, from: review, to: edit, loop: revisions}
---
## task
Decide.
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: `import-loop-${maxReviews}`,
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const result = store.start(
		startRequest(definition.graph_id, definition.revision, `start-loop-${maxReviews}`),
		preparedProgram(definition.graph_id, definition.revision, definition.digest),
	);
	expect(result.state).toBe("accepted");
	const runId = result.target_id!;
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const edit = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: runId,
			invocation_id: edit.invocation_id,
			attempt_id: edit.attempt_id,
			fence: edit.fence,
			state: "succeeded",
			outcome: "done",
		}),
	).toBe(true);
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("routed");
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
	const review = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: runId,
			invocation_id: review.invocation_id,
			attempt_id: review.attempt_id,
			fence: review.fence,
			state: "succeeded",
			outcome: "done",
		}),
	).toBe(true);
	const decision = store.schedule(runId, owner.owner_id, owner.epoch);
	if (maxReviews === 3) {
		expect(decision.action?.type).toBe("rewind");
		const current = store.getScheduleState(runId)!;
		const nextEdit = current.invocations.find(item => item.node === "edit" && !item.superseded)!;
		expect(nextEdit.upstream.back).toBe(review.invocation_id);
		expect(current.invocations.find(item => item.id === review.invocation_id)?.superseded).toBe(true);
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		expect(reopened.getScheduleState(runId)).toEqual(current);
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
		const next = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
		expect(next.invocation_id).toBe(nextEdit.id);
		expect(
			store.completeAttempt(owner.owner_id, owner.epoch, {
				run_id: runId,
				invocation_id: next.invocation_id,
				attempt_id: next.attempt_id,
				fence: next.fence,
				state: "succeeded",
				outcome: "done",
			}),
		).toBe(true);
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("routed");
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
		const secondReview = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
		expect(
			store.getScheduleState(runId)?.counters.find(item => item.key === "loop:revisions:stage:draft")?.consumed,
		).toBe(2);
		expect(
			store.completeAttempt(owner.owner_id, owner.epoch, {
				run_id: runId,
				invocation_id: secondReview.invocation_id,
				attempt_id: secondReview.attempt_id,
				fence: secondReview.fence,
				state: "succeeded",
				outcome: "done",
			}),
		).toBe(true);
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("rewind");
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
		const thirdEdit = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
		expect(
			store.completeAttempt(owner.owner_id, owner.epoch, {
				run_id: runId,
				invocation_id: thirdEdit.invocation_id,
				attempt_id: thirdEdit.attempt_id,
				fence: thirdEdit.fence,
				state: "succeeded",
				outcome: "done",
			}),
		).toBe(true);
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("routed");
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
		const thirdReview = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
		expect(
			store.completeAttempt(owner.owner_id, owner.epoch, {
				run_id: runId,
				invocation_id: thirdReview.invocation_id,
				attempt_id: thirdReview.attempt_id,
				fence: thirdReview.fence,
				state: "succeeded",
				outcome: "done",
			}),
		).toBe(true);
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action).toMatchObject({
			type: "route",
			target: "final",
		});
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
		const thirdFinal = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
		expect(store.getScheduleState(runId)?.invocations.find(item => item.id === thirdFinal.invocation_id)?.node).toBe(
			"final",
		);
		return;
	}
	expect(decision.action?.type).toBe("route");
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
	const final = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: runId,
			invocation_id: final.invocation_id,
			attempt_id: final.attempt_id,
			fence: final.fence,
			state: "succeeded",
			outcome: "go",
		}),
	).toBe(true);
	const held = store.schedule(runId, owner.owner_id, owner.epoch);
	expect(held.run.state).toBe("held");
	expect(held.run.reason).toContain("No applicable route");
});

it("persists a non-consuming exhausted-budget branch before dispatching its successor", () => {
	const { root, store } = open();
	const content = `---
format: omp.graph/v1
name: budget-branch
members: {}
nodes:
  consume: {kind: program, executor: test, task: '#task', consume: [quota]}
  check: {kind: program, executor: test, task: '#task'}
  next: {kind: program, executor: test, task: '#task'}
  stop: {kind: program, executor: test, task: '#task'}
budgets: {quota: {scope: run, limit: 1}}
edges:
  - {id: forward, from: consume, to: check}
  - {id: available, from: check, to: next, when_budget: {budget: quota, state: available}}
  - {id: exhausted, from: check, to: stop, when_budget: {budget: quota, state: exhausted}}
---
## task
Decide.
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "budget-import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const run = store.start(
		startRequest(definition.graph_id, definition.revision, "budget-start"),
		preparedProgram(definition.graph_id, definition.revision, definition.digest),
	);
	expect(run.state).toBe("accepted");
	const owner = store.claimHost()!;
	const schedule = () => store.schedule(run.target_id!, owner.owner_id, owner.epoch);
	const finish = (intent: GraphDispatchIntent) =>
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: intent.run_id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			state: "succeeded",
			outcome: "done",
		});
	expect(schedule().action?.type).toBe("ready");
	const consume = schedule().intent!;
	expect(finish(consume)).toBe(true);
	expect(schedule().action?.type).toBe("routed");
	expect(schedule().action?.type).toBe("ready");
	const check = schedule().intent!;
	expect(finish(check)).toBe(true);
	expect(schedule().action).toMatchObject({ type: "routed", suppressed_edges: ["available"] });
	const state = store.getScheduleState(run.target_id!)!;
	expect(state.invocations.find(item => item.id === check.invocation_id)?.suppressed_edges).toEqual(["available"]);
	expect(state.counters.find(item => item.key === "budget:quota:run:run")?.consumed).toBe(1);
	const reopened = new GraphRunStore(limits, root);
	stores.push(reopened);
	expect(reopened.getScheduleState(run.target_id!)).toEqual(state);
	let dispatched: GraphDispatchIntent | null = null;
	for (let i = 0; i < 4 && !dispatched; i++) dispatched = schedule().intent;
	expect(dispatched?.request).toMatchObject({ node: "stop" });
	expect(
		store.getScheduleState(run.target_id!)?.counters.find(item => item.key === "budget:quota:run:run")?.consumed,
	).toBe(1);
});

it("commits authorized human decisions with global request receipts and fenced scheduling", () => {
	const { root, store } = open();
	const content = `---
format: omp.graph/v1
name: human-gate
members: {}
nodes:
  review:
    kind: human
    task: '#question'
    outcomes: [approve, reject]
---
## question
Approve this plan?
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "human-import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const runReceipt = store.start(
		startRequest(definition.graph_id, definition.revision, "human-start"),
		prepared(definition.graph_id, definition.revision, definition.digest),
	);
	const runId = runReceipt.target_id!;
	const owner = store.claimHost()!;
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: runId,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			state: "succeeded",
			outcome: "approve",
		}),
	).toBe(false);
	let allowed = true;
	store.configureHuman(
		(_action, principal, _decision, answer) =>
			allowed && principal === "alice" && (!answer || answer.author_ref.id === principal),
	);
	const question = store.createHumanQuestion(owner.owner_id, owner.epoch, "alice", runId, intent.invocation_id, {
		id: "question",
		digest: "sha256:question",
	});
	expect(store.getScheduleState(runId)?.invocations[0].state).toBe("waiting");
	const answer = {
		request_key: "human-answer",
		principal: "alice",
		run_id: runId,
		invocation_id: intent.invocation_id,
		decision_id: question.id,
		input_digest: question.input_digest,
		if_revision: store.getRun(runId)!.revision,
		outcome: "approve",
		verdict: "approve",
		content_ref: { id: "answer", digest: "sha256:answer" },
		evidence_refs: [],
		reason: "approved",
		author_ref: { id: "alice", digest: "sha256:alice" },
	};
	expect(store.answerHuman({ ...answer, request_key: "human-start" }).error?.code).toBe("idempotency_conflict");
	expect(store.answerHuman({ ...answer, request_key: "stale-human", input_digest: "old" }).error?.code).toBe(
		"input_stale",
	);
	expect(store.answerHuman({ ...answer, request_key: "old-revision", if_revision: "1" }).error?.code).toBe(
		"revision_conflict",
	);
	expect(store.getHumanQuestion("alice", question.id)?.answer).toBeNull();
	const result = store.answerHuman(answer);
	expect(result.state).toBe("completed");
	const evidenceRef = store.getHumanQuestion("alice", question.id)!.evidence_ref!;
	const scope = {
		decision_id: question.id,
		run_id: runId,
		invocation_id: intent.invocation_id,
		input_digest: question.input_digest,
		source_revision: question.source_revision,
		outcome: "approve",
		author_ref: answer.author_ref,
	};
	expect(store.getHumanEvidence("alice", evidenceRef, scope)).toMatchObject({
		decision_id: question.id,
		principal: "alice",
		answer: { outcome: "approve", author_ref: answer.author_ref },
	});
	expect(() => store.getHumanEvidence("alice", evidenceRef, { ...scope, outcome: "reject" })).toThrow();
	expect(() => store.getHumanEvidence("alice", evidenceRef, { ...scope, input_digest: "old" })).toThrow();
	expect(() => store.getHumanEvidence("bob", evidenceRef, scope)).toThrow();
	expect(store.definitions.requestGet(answer.request_key)).toEqual(result);
	expect(store.getScheduleState(runId)?.invocations[0]).toMatchObject({ state: "succeeded", outcome: "approve" });
	expect(store.getDispatchIntents(runId)[0].state).toBe("finished");
	expect(store.answerHuman(answer)).toEqual(result);
	expect(store.answerHuman({ ...answer, reason: "changed" }).error?.code).toBe("idempotency_conflict");
	allowed = false;
	expect(store.answerHuman(answer).error?.code).toBe("permission_denied");
	const reopened = new GraphRunStore(limits, root);
	stores.push(reopened);
	reopened.configureHuman(() => true);
	expect(reopened.answerHuman(answer)).toEqual(result);
	expect(reopened.getHumanEvidence("alice", evidenceRef, scope).answer.outcome).toBe("approve");
	expect(reopened.getHumanQuestion("alice", question.id)?.answer?.outcome).toBe("approve");
});

it("recovers an open human question without treating its accepted intent as an unknown dispatch", () => {
	const { root, store } = open();
	const content = `---
format: omp.graph/v1
name: recovery
members: {}
nodes:
  approval: {kind: human, task: '#question'}
---
## question
Approve?
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "recover-import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const run = store.start(
		startRequest(definition.graph_id, definition.revision, "recover-start"),
		prepared(definition.graph_id, definition.revision, definition.digest),
	);
	const owner = store.claimHost()!;
	store.schedule(run.target_id!, owner.owner_id, owner.epoch);
	const intent = store.schedule(run.target_id!, owner.owner_id, owner.epoch).intent!;
	expect(store.listHostIntents().map(item => item.id)).toContain(intent.id);
	store.configureHuman(() => true);
	const question = store.createHumanQuestion(
		owner.owner_id,
		owner.epoch,
		"alice",
		run.target_id!,
		intent.invocation_id,
		{ id: "question", digest: "sha256:question" },
	);
	expect(store.listHostIntents()).toEqual([]);
	store.close();
	stores.splice(stores.indexOf(store), 1);
	const reopened = new GraphRunStore(limits, root);
	stores.push(reopened);
	reopened.configureHuman(() => true);
	const nextOwner = reopened.claimHost()!;
	expect(reopened.listHostIntents()).toEqual([]);
	expect(reopened.schedule(run.target_id!, nextOwner.owner_id, nextOwner.epoch).run.state).toBe("running");
	const result = reopened.answerHuman({
		request_key: "recover-answer",
		principal: "alice",
		run_id: run.target_id!,
		invocation_id: intent.invocation_id,
		decision_id: question.id,
		input_digest: question.input_digest,
		if_revision: reopened.getRun(run.target_id!)!.revision,
		outcome: "done",
		verdict: "done",
		content_ref: { id: "answer", digest: "sha256:answer" },
		evidence_refs: [],
		reason: "approved",
		author_ref: { id: "alice", digest: "sha256:alice" },
	});
	expect(result.state).toBe("completed");
});

it("records an authenticated Bot candidate idempotently without settling the attempt", () => {
	const { store } = open();
	const content = `---
format: omp.graph/v1
name: bot-completion
members:
  reviewer:
    role: '#role'
    model: model
    base: isolated
    duty: review
    permissions: {read: [], write: [], execute: []}
nodes:
  review:
    kind: bot
    member: reviewer
    task: '#task'
    outcomes: [done]
    verdicts: [PASS]
---
## role
Review.
## task
Inspect.
`;
	const created = store.definitions.mutate({
		version: 1,
		request_key: "bot-graph",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(created.target_id!)!;
	const frozen = prepared(definition.graph_id, definition.revision, definition.digest);
	frozen.members.reviewer = {
		provider: "provider",
		model: "model",
		configuration_revision: "1",
		base: "isolated",
		base_snapshot_ref: auth,
		role_ref: auth,
		skill_refs: [],
		rule_refs: [],
	};
	for (const [name, patch] of [
		["missing-skills", { skill_refs: undefined }],
		["missing-rules", { rule_refs: undefined }],
		["invalid-skill", { skill_refs: [{ id: "skill", digest: "" }] }],
		["invalid-rule", { rule_refs: [{ id: "", digest: "sha256:rule" }] }],
	] as const) {
		const invalid = structuredClone(frozen);
		Object.assign(invalid.members.reviewer, patch);
		const rejected = store.start(startRequest(definition.graph_id, definition.revision, name), invalid);
		expect(rejected.state).toBe("rejected");
		expect(rejected.error?.code).toBe("model_unavailable");
	}
	expect(store.listHostRuns()).toEqual([]);
	const run = store.start(startRequest(definition.graph_id, definition.revision, "bot-start"), frozen);
	expect(run.state).toBe("accepted");
	const owner = store.claimHost()!;
	store.schedule(run.target_id!, owner.owner_id, owner.epoch);
	const intent = store.schedule(run.target_id!, owner.owner_id, owner.epoch).intent!;
	store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "accepted", { job_id: "job" });
	const identity = {
		run_id: intent.run_id,
		member_id: "reviewer",
		invocation_id: intent.invocation_id,
		attempt_id: intent.attempt_id,
		fence: intent.fence,
	};
	const candidate = { request_key: "bot-result", outcome: "done", verdict: "PASS", outputs: {} };
	const submit = (value: typeof candidate, allowed = true) =>
		store.submitBotCompletion(owner.owner_id, owner.epoch, identity, value, () => allowed);
	expect(submit(candidate, false).error?.code).toBe("permission_denied");
	expect(submit(candidate, "false" as unknown as boolean).error?.code).toBe("permission_denied");
	expect(submit({ ...candidate, request_key: "bad-result", verdict: "FAIL" }).state).toBe("rejected");
	const receipt = store.submitBotCompletion(owner.owner_id, owner.epoch, identity, candidate, (_db, checked) => {
		checked.member_id = "changed-by-authorization";
		return true;
	});
	expect(identity.member_id).toBe("reviewer");
	expect(receipt.state).toBe("accepted");
	expect(submit(candidate)).toEqual(receipt);
	expect(submit({ ...candidate, outcome: "other" }).error?.code).toBe("idempotency_conflict");
	expect(store.getBotCompletion(intent.attempt_id)?.candidate).toEqual(candidate);
	expect(store.getScheduleState(intent.run_id)?.invocations[0].state).toBe("running");
	expect(store.getDispatchIntents(intent.run_id)[0].state).toBe("accepted");
});

it.each([
	"valid",
	"no-authority",
	"missing-blocker",
	"stale-input",
	"stale-artifact",
	"invalid-evidence",
	"throwing-authority",
] as const)("atomically gates final GO with trusted evidence: %s", mode => {
	const { root, store } = open();
	const content = `---
format: omp.graph/v1
name: final-gate
members: {}
nodes:
  edit: {kind: program, executor: test, task: '#task'}
  review: {kind: program, executor: test, task: '#task'}
  final: {kind: program, executor: test, task: '#task', outcomes: [go, hold], inputs: {brief: {run_input: brief}, note: {text: frozen}}}
  next: {kind: program, executor: test, task: '#task'}
loops:
  revisions:
    max_reviews: 1
    final_node: final
    retry_target: edit
    final_outcomes: {go: go, hold: hold}
    count_nodes: [review]
    scope: stage
    stage: draft
edges:
  - {id: forward, from: edit, to: review}
  - {id: back, from: review, to: edit, loop: revisions}
  - {id: approved, from: final, to: next, on: [go]}
---
## task
Decide.
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import-gate",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const brief = { id: "brief", digest: "sha256:brief" };
	const request = startRequest(definition.graph_id, definition.revision, "start-gate");
	request.payload.inputs = { brief };
	const frozen = preparedProgram(definition.graph_id, definition.revision, definition.digest);
	frozen.inputs = { brief };
	const started = store.start(request, frozen);
	expect(started.state).toBe("accepted");
	const runId = started.target_id!;
	const owner = store.claimHost()!;
	const schedule = () => store.schedule(runId, owner.owner_id, owner.epoch);
	const complete = (intent: GraphDispatchIntent, outcome: string) =>
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: runId,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			state: "succeeded",
			outcome,
		});
	expect(schedule().action?.type).toBe("ready");
	expect(complete(schedule().intent!, "done")).toBe(true);
	expect(schedule().action?.type).toBe("routed");
	expect(schedule().action?.type).toBe("ready");
	expect(complete(schedule().intent!, "done")).toBe(true);
	expect(schedule().action?.type).toBe("route");
	expect(schedule().action?.type).toBe("ready");
	const final = schedule().intent!;
	expect(complete(final, "go")).toBe(true);
	const inventory = { id: "inventory", digest: "sha256:inventory" };
	const proof = { id: "proof", digest: "sha256:proof" };
	const claims: string[] = [];
	const policy: GraphFinalReviewPolicy = {
		resolve(context) {
			if (mode === "throwing-authority") throw new Error("authority unavailable");
			expect(context.attempt_id).toBe(final.attempt_id);
			expect(context.inputs).toEqual({ brief, note: "frozen" });
			expect(context.binding.artifacts).toEqual({ "input:brief": brief });
			return {
				blocker_ids: ["security"],
				inventory_evidence: inventory,
				submission: {
					...context.binding,
					input_digest: mode === "stale-input" ? "sha256:stale" : context.binding.input_digest,
					artifacts:
						mode === "stale-artifact"
							? { "input:brief": { ...brief, digest: "sha256:old" } }
							: context.binding.artifacts,
					blockers:
						mode === "missing-blocker" ? [] : [{ id: "security", disposition: "cleared", evidence: proof }],
					preferences: [],
				},
			};
		},
		verifyEvidence(claim, context) {
			expect(context.run.id).toBe(runId);
			claims.push(claim.kind);
			return mode !== "invalid-evidence";
		},
	};
	const result = store.schedule(runId, owner.owner_id, owner.epoch, mode === "no-authority" ? undefined : policy);
	const state = store.getScheduleState(runId)!;
	const finalState = state.invocations.find(item => item.id === final.invocation_id)!;
	if (mode === "valid") {
		expect(result.action?.type).toBe("routed");
		expect(claims).toEqual(["inventory", "blocker"]);
		expect(finalState.routed).toBe(true);
		expect(finalState.final_review_evidence).toMatchObject({
			attempt_id: final.attempt_id,
			authority: { blocker_ids: ["security"], artifacts: { "input:brief": brief } },
		});
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		expect(reopened.getScheduleState(runId)).toEqual(state);
		expect(schedule().action?.type).toBe("ready");
	} else {
		expect(result.action?.type).toBe("hold");
		expect(result.run.state).toBe("held");
		expect(finalState.routed).not.toBe(true);
		expect(finalState.final_review_evidence).toBeUndefined();
		expect(state.invocations.find(item => item.node === "next")?.state).toBe("pending");
	}
});

it("persists consultation waits and reacquires the original attempt after independent work", () => {
	const { store } = open();
	const content = `---
format: omp.graph/v1
name: consultation-slots
members:
  requester: {role: '#role', model: model, base: isolated, duty: research, permissions: {read: [], write: [], execute: []}}
  responder: {role: '#role', model: model, base: isolated, duty: review, permissions: {read: [], write: [], execute: []}}
nodes:
  request: {kind: bot, member: requester, task: '#task'}
policy: {max_parallel: 1}
---
## role
Work.
## task
Work.
`;
	const created = store.definitions.mutate({
		version: 1,
		request_key: "consult-graph",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(created.target_id!)!;
	const frozen = prepared(definition.graph_id, definition.revision, definition.digest);
	for (const member of ["requester", "responder"])
		frozen.members[member] = {
			provider: "provider",
			model: "model",
			configuration_revision: "1",
			base: "isolated",
			base_snapshot_ref: auth,
			role_ref: auth,
			skill_refs: [],
			rule_refs: [],
		};
	const run = store.start(startRequest(definition.graph_id, definition.revision, "consult-run"), frozen);
	expect(run.state).toBe("accepted");
	const owner = store.claimHost()!;
	store.schedule(run.target_id!, owner.owner_id, owner.epoch);
	const original = store.schedule(run.target_id!, owner.owner_id, owner.epoch).intent!;
	expect(store.claimDispatch(owner.owner_id, owner.epoch, original.id)).not.toBeNull();
	expect(store.observeDispatch(owner.owner_id, owner.epoch, original.id, "accepted", {})).toBe(true);
	const identity = {
		run_id: original.run_id,
		member_id: "requester",
		invocation_id: original.invocation_id,
		attempt_id: original.attempt_id,
		fence: original.fence,
	};
	const db = new Database(path.join(store.definitions.root, "graphs.sqlite"));
	db.exec(`CREATE TABLE consultation_messages (conversation_id TEXT, message_id TEXT, data TEXT);
		CREATE TABLE consultations (id TEXT, run_id TEXT, state TEXT, data TEXT);
		CREATE TABLE consultation_deliveries (message_id TEXT);`);
	db.query("INSERT INTO consultations VALUES (?,?,?,?)").run(
		"c",
		original.run_id,
		"queued",
		JSON.stringify({ deadline: Date.now() + 60000 }),
	);
	db.query("INSERT INTO consultation_messages VALUES (?,?,?)").run(
		"c",
		"m",
		JSON.stringify({
			sender_member: "requester",
			recipient_member: "responder",
			sender_attempt_id: original.attempt_id,
		}),
	);
	db.close();
	expect(
		store.startConsultationInvocation(owner.owner_id, owner.epoch, original.run_id, "responder", "c", "m"),
	).toBeNull();
	expect(store.waitForConsultation(owner.owner_id, owner.epoch, { ...identity, attempt_id: "wrong" }, "c", "m")).toBe(
		false,
	);
	expect(store.waitForConsultation(owner.owner_id, owner.epoch, identity, "c", "m")).toBe(true);
	const independent = store.startConsultationInvocation(
		owner.owner_id,
		owner.epoch,
		original.run_id,
		"responder",
		"c",
		"m",
	)!;
	expect(independent.attempt_id).not.toBe(original.attempt_id);
	expect(
		store.getScheduleState(original.run_id)!.invocations.find(item => item.id === independent.invocation_id)?.node,
	).toBe("consultation:responder");
	expect(store.resumeConsultation(owner.owner_id, owner.epoch, identity, "c", "m")).toBe(false);
	expect(store.claimDispatch(owner.owner_id, owner.epoch, independent.id)).not.toBeNull();
	expect(store.observeDispatch(owner.owner_id, owner.epoch, independent.id, "accepted", {})).toBe(true);
	expect(store.finishConsultationInvocation(owner.owner_id, owner.epoch, independent.id, "succeeded")).toBe(true);
	expect(store.resumeConsultation(owner.owner_id, owner.epoch, identity, "c", "m")).toBe(true);
	const resumed = store
		.getScheduleState(original.run_id)!
		.invocations.find(item => item.id === original.invocation_id)!;
	expect(resumed.state).toBe("running");
	expect(resumed.attempt_id).toBe(original.attempt_id);
	expect(store.getDispatchIntents(original.run_id).find(item => item.id === original.id)?.state).toBe("accepted");
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: original.run_id,
			invocation_id: original.invocation_id,
			attempt_id: original.attempt_id,
			fence: original.fence,
			state: "succeeded",
			outcome: "done",
			outputs: {},
		}),
	).toBe(true);
	const completed = store
		.getScheduleState(original.run_id)!
		.invocations.find(item => item.id === original.invocation_id)!;
	const secondDb = new Database(path.join(store.definitions.root, "graphs.sqlite"));
	secondDb
		.query("INSERT INTO consultations VALUES (?,?,?,?)")
		.run("c2", original.run_id, "queued", JSON.stringify({ deadline: Date.now() + 60000 }));
	secondDb.query("INSERT INTO consultation_messages VALUES (?,?,?)").run(
		"c2",
		"m2",
		JSON.stringify({
			sender_member: "responder",
			recipient_member: "requester",
			sender_attempt_id: independent.attempt_id,
		}),
	);
	secondDb.close();
	const later = store.startConsultationInvocation(
		owner.owner_id,
		owner.epoch,
		original.run_id,
		"requester",
		"c2",
		"m2",
	)!;
	expect(later.invocation_id).not.toBe(original.invocation_id);
	expect(
		store.getScheduleState(original.run_id)!.invocations.find(item => item.id === original.invocation_id),
	).toEqual(completed);
});

it("persists multi-round consultation handoffs through one compute slot", () => {
	const { store } = open();
	const content = `---
format: omp.graph/v1
name: consultation-rounds
members:
  requester: {role: '#role', model: model, base: isolated, duty: research, permissions: {read: [], write: [], execute: []}}
  responder: {role: '#role', model: model, base: isolated, duty: review, permissions: {read: [], write: [], execute: []}}
nodes:
  request: {kind: bot, member: requester, task: '#task'}
communications:
  - {from: requester, to: responder, when: '#task'}
policy: {max_parallel: 1}
---
## role
Work.
## task
Work.
`;
	const created = store.definitions.mutate({
		version: 1,
		request_key: "rounds-graph",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(created.target_id!)!;
	const frozen = prepared(definition.graph_id, definition.revision, definition.digest);
	for (const member of ["requester", "responder"])
		frozen.members[member] = {
			provider: "provider",
			model: "model",
			configuration_revision: "1",
			base: "isolated",
			base_snapshot_ref: auth,
			role_ref: auth,
			skill_refs: [],
			rule_refs: [],
		};
	const service = store.configureConsultation({
		validate: (_db, identity) => identity.fence === owner.epoch,
		policy: () => ({ max_rounds: 1, timeout_ms: 60000 }),
		artifacts: () => true,
		reserve: () => true,
		delivery: () => true,
		participant: () => true,
	});
	const run = store.start(startRequest(definition.graph_id, definition.revision, "rounds-run"), frozen);
	const owner = store.claimHost()!;
	store.schedule(run.target_id!, owner.owner_id, owner.epoch);
	const original = store.schedule(run.target_id!, owner.owner_id, owner.epoch).intent!;
	expect(store.claimDispatch(owner.owner_id, owner.epoch, original.id)).not.toBeNull();
	expect(store.observeDispatch(owner.owner_id, owner.epoch, original.id, "accepted", {})).toBe(true);
	const requester = {
		run_id: original.run_id,
		member_id: "requester",
		invocation_id: original.invocation_id,
		attempt_id: original.attempt_id,
		fence: owner.epoch,
	};
	const ask = service.ask(requester, { to_member: "responder", text: "Review", request_key: "ask" });
	if (!ask.ok) throw new Error(ask.error);
	const { conversation_id, message_id } = ask.value;
	expect(store.waitForConsultation(owner.owner_id, owner.epoch, requester, conversation_id, message_id)).toBe(true);
	const independent = store.startConsultationInvocation(
		owner.owner_id,
		owner.epoch,
		original.run_id,
		"responder",
		conversation_id,
		message_id,
	)!;
	expect(independent).not.toBeNull();
	const responder = {
		run_id: original.run_id,
		member_id: "responder",
		invocation_id: independent.invocation_id,
		attempt_id: independent.attempt_id,
		fence: owner.epoch,
	};
	expect(store.claimDispatch(owner.owner_id, owner.epoch, independent.id)).not.toBeNull();
	expect(store.observeDispatch(owner.owner_id, owner.epoch, independent.id, "accepted", {})).toBe(true);
	expect(service.reserveDelivery(responder, message_id).ok).toBe(true);
	expect(service.activate(conversation_id)?.state).toBe("active");
	expect(service.settleDelivery(responder, message_id, "delivered")).toBe(true);
	const question = service.question(responder, {
		conversation_id,
		reply_to: message_id,
		text: "Evidence?",
		request_key: "question",
	});
	if (!question.ok) throw new Error(question.error);
	expect(
		store.waitForConsultation(owner.owner_id, owner.epoch, responder, conversation_id, question.value.message_id),
	).toBe(true);
	expect(store.resumeConsultation(owner.owner_id, owner.epoch, requester, conversation_id, message_id)).toBe(true);
	expect(service.reserveDelivery(requester, question.value.message_id).ok).toBe(true);
	expect(service.settleDelivery(requester, question.value.message_id, "delivered")).toBe(true);
	const reply = service.reply(requester, {
		conversation_id,
		reply_to: question.value.message_id,
		text: "Here",
		request_key: "reply",
	});
	if (!reply.ok) throw new Error(reply.error);
	expect(service.get(conversation_id)?.state).toBe("active");
	expect(
		store.waitForConsultation(owner.owner_id, owner.epoch, requester, conversation_id, reply.value.message_id),
	).toBe(true);
	expect(
		store.resumeConsultation(owner.owner_id, owner.epoch, responder, conversation_id, question.value.message_id),
	).toBe(true);
	expect(service.reserveDelivery(responder, reply.value.message_id).ok).toBe(true);
	expect(service.settleDelivery(responder, reply.value.message_id, "delivered")).toBe(true);
	const final = service.finish(responder, { conversation_id, text: "Done", request_key: "final" });
	if (!final.ok) throw new Error(final.error);
	expect(
		store.resumeConsultation(owner.owner_id, owner.epoch, requester, conversation_id, reply.value.message_id),
	).toBe(false);
	expect(store.finishConsultationInvocation(owner.owner_id, owner.epoch, independent.id, "succeeded")).toBe(true);
	expect(
		store.resumeConsultation(owner.owner_id, owner.epoch, requester, conversation_id, reply.value.message_id),
	).toBe(true);
	expect(service.reserveDelivery(requester, final.value.message_id).ok).toBe(true);
	expect(service.settleDelivery(requester, final.value.message_id, "delivered")).toBe(true);
	expect(service.messages(conversation_id).map(message => message.kind)).toEqual([
		"request",
		"question",
		"reply",
		"final",
	]);
	expect(service.get(conversation_id)?.state).toBe("answered");
	expect(
		store.getScheduleState(original.run_id)!.invocations.find(item => item.id === original.invocation_id),
	).toMatchObject({
		state: "running",
		attempt_id: original.attempt_id,
	});

	// Cancel a later consultation while its auxiliary worker is still being admitted.
	const followup = service.ask(requester, { to_member: "responder", text: "Check again", request_key: "followup" });
	if (!followup.ok) throw new Error(followup.error);
	expect(
		store.waitForConsultation(
			owner.owner_id,
			owner.epoch,
			requester,
			followup.value.conversation_id,
			followup.value.message_id,
		),
	).toBe(true);
	const auxiliary = store.startConsultationInvocation(
		owner.owner_id,
		owner.epoch,
		original.run_id,
		"responder",
		followup.value.conversation_id,
		followup.value.message_id,
	)!;
	expect(store.claimDispatch(owner.owner_id, owner.epoch, auxiliary.id)).not.toBeNull();
	expect(store.finishConsultationInvocation(owner.owner_id, owner.epoch, auxiliary.id, "cancelled")).toBe(false);
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	expect(
		store.mutateLifecycle("owner", {
			version: 1,
			operation: "cancel",
			request_key: "cancel-consultation",
			target_id: original.run_id,
			if_revision: store.getRun(original.run_id)!.revision,
			payload: { reason: "stop" },
		}).state,
	).toBe("completed");
	service.cancel(followup.value.conversation_id);
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: original.run_id,
			invocation_id: original.invocation_id,
			attempt_id: original.attempt_id,
			fence: original.fence,
			state: "cancelled",
		}),
	).toBe(true);
	expect(store.getRun(original.run_id)?.state).toBe("cancelling");
	expect(store.finishConsultationInvocation(owner.owner_id, owner.epoch, auxiliary.id, "cancelled")).toBe(true);
	expect(store.getRun(original.run_id)?.state).toBe("cancelled");
	expect(store.getDispatchIntents(original.run_id).every(intent => intent.state === "finished")).toBe(true);
	expect(store.finishConsultationInvocation(owner.owner_id, owner.epoch, auxiliary.id, "cancelled")).toBe(false);
});

describe("Graph monetary limit admission", () => {
	function fixture(costLimit: boolean) {
		const { store, root } = open();
		const content = `---
format: omp.graph/v1
name: limited
members: {}
${costLimit ? "policy: {cost_limit: '1.00', currency: USD}\n" : ""}nodes:
  work: {kind: program, executor: test, task: '#task'}
---
## task
Work.
`;
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const result = store.start(
			startRequest(definition.graph_id, definition.revision, "start"),
			preparedProgram(definition.graph_id, definition.revision, definition.digest),
		);
		return { root, store, result };
	}

	it("refuses a requested monetary ceiling when no cost reservation authority exists", () => {
		const { store, result } = fixture(true);
		expect(result.state).toBe("rejected");
		expect(result.error?.code).toBe("capability_unavailable");
		expect(store.listHostRuns()).toEqual([]);
		expect(store.definitions.requestGet("start")).toEqual(result);
	});

	it("holds restored cost-limited Runs before claiming an existing dispatch", () => {
		const { root, store, result } = fixture(false);
		expect(result.state).toBe("accepted");
		const run = store.getRun(result.target_id!)!;
		const owner = store.claimHost()!;
		let intent: GraphDispatchIntent | null = null;
		for (let step = 0; step < 5 && !intent; step++)
			intent = store.schedule(run.id, owner.owner_id, owner.epoch).intent;
		expect(intent?.state).toBe("pending");
		// Restore a legacy cost-limited snapshot admitted before cost policy enforcement.
		const snapshot = store.getSnapshot(run.snapshot_ref)!;
		snapshot.definition = snapshot.definition.replace(
			"members: {}",
			"members: {}\npolicy: {cost_limit: '1.00', currency: USD}",
		);
		const data = JSON.stringify(snapshot);
		const digest = `sha256:${Bun.SHA256.hash(data, "hex")}`;
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			db.transaction(() => {
				db.query("UPDATE graph_run_snapshots SET digest=?,data=? WHERE id=?").run(
					digest,
					data,
					run.snapshot_ref.id,
				);
				const current = store.getRun(run.id)!;
				current.snapshot_ref.digest = digest;
				db.query("UPDATE graph_runs SET data=? WHERE id=?").run(JSON.stringify(current), current.id);
			}).immediate();
		} finally {
			db.close();
		}
		expect(store.claimDispatch(owner.owner_id, owner.epoch, intent!.id)).toBeNull();
		expect(store.getRun(run.id)?.state).toBe("held");
		expect(store.schedule(run.id, owner.owner_id, owner.epoch).intent).toBeNull();
		expect(store.getDispatchIntents(run.id)[0].state).toBe("pending");
	});
});

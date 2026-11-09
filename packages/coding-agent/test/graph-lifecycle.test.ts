import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphHumanAnswer, GraphHumanDecision } from "../src/graph/human";
import { GraphRunStore, type GraphLifecycleRequest } from "../src/graph/store";

const roots: string[] = [];
const stores: GraphRunStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const ref = { id: "decision", digest: "sha256:decision" };
function setup(kind: "program" | "human" = "program") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-lifecycle-"));
	roots.push(root);
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	stores.push(store);
	const node = kind === "program" ? "kind: program, executor: test" : "kind: human";
	const content = `---\nformat: omp.graph/v1\nname: lifecycle\nmembers: {}\nnodes:\n  work: {${node}, task: '#work'}\n---\n## work\nWork.\n`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const auth = { id: "auth", digest: "sha256:auth" };
	const started = store.start(
		{
			version: 1,
			request_key: "start",
			operation: "start",
			target_id: definition.graph_id,
			if_revision: definition.revision,
			payload: { inputs: {}, authorization_ref: auth },
		},
		{
			graph_id: definition.graph_id,
			definition_revision: definition.revision,
			definition_digest: definition.digest,
			authorization_ref: auth,
			inputs: {},
			members: {},
			executors: { test: auth },
		},
	);
	const id = started.target_id!;
	const owner = store.claimHost()!;
	const control = (key: string, operation: "hold" | "cancel", reason = "requested"): GraphLifecycleRequest => ({
		version: 1,
		request_key: key,
		target_id: id,
		if_revision: store.getRun(id)!.revision,
		operation,
		payload: { reason },
	});
	return { root, store, id, owner, control };
}

function waitForHuman({
	store,
	id,
	owner,
}: {
	store: GraphRunStore;
	id: string;
	owner: { owner_id: string; epoch: string };
}): GraphHumanDecision {
	store.schedule(id, owner.owner_id, owner.epoch);
	const intent = store.schedule(id, owner.owner_id, owner.epoch).intent!;
	return store.createHumanQuestion(owner.owner_id, owner.epoch, "alice", id, intent.invocation_id, {
		id: "question",
		digest: "sha256:question",
	});
}

function answerForHuman(store: GraphRunStore, question: GraphHumanDecision): GraphHumanAnswer {
	return {
		request_key: "answer",
		principal: "alice",
		run_id: question.run_id,
		invocation_id: question.invocation_id,
		decision_id: question.id,
		input_digest: question.input_digest,
		if_revision: store.getRun(question.run_id)!.revision,
		outcome: "done",
		verdict: "done",
		content_ref: { id: "answer", digest: "sha256:answer" },
		evidence_refs: [],
		reason: "approved",
		author_ref: { id: "alice", digest: "sha256:alice" },
	};
}

it("authenticates replays, applies CAS and requires a resolved decision bound to the hold revision", () => {
	const { store, id, owner, control } = setup();
	let decision: { revision: string; reason: string } | null = null;
	store.configureLifecycle({
		authorize: principal => principal === "alice",
		verifyResume: (_principal, request, { run }) =>
			"decision_ref" in request.payload &&
			request.payload.decision_ref.id === ref.id &&
			request.payload.decision_ref.digest === ref.digest &&
			decision?.revision === run.revision &&
			decision?.reason === run.reason,
	});
	const hold = control("hold", "hold", "missing evidence");
	expect(store.mutateLifecycle("mallory", hold).error?.code).toBe("permission_denied");
	const held = store.mutateLifecycle("alice", hold);
	expect(held.state).toBe("completed");
	expect(store.mutateLifecycle("alice", hold)).toEqual(held);
	expect(
		store.mutateLifecycle("alice", { ...hold, operation: "hold", payload: { reason: "different" } }).error?.code,
	).toBe("idempotency_conflict");
	expect(store.mutateLifecycle("alice", { ...hold, request_key: "start" }).error?.code).toBe("idempotency_conflict");
	expect(store.mutateLifecycle("mallory", hold).error?.code).toBe("permission_denied");
	expect(store.schedule(id, owner.owner_id, owner.epoch).action).toBeNull();
	const resume: GraphLifecycleRequest = {
		version: 1,
		request_key: "resume-fail",
		operation: "resume",
		target_id: id,
		if_revision: store.getRun(id)!.revision,
		payload: { decision_ref: ref },
	};
	expect(store.mutateLifecycle("alice", resume).error?.code).toBe("gate_unsatisfied");
	decision = { revision: "0", reason: "missing evidence" };
	expect(store.mutateLifecycle("alice", { ...resume, request_key: "stale-decision" }).error?.code).toBe(
		"gate_unsatisfied",
	);
	decision = { revision: store.getRun(id)!.revision, reason: "missing evidence" };
	expect(store.mutateLifecycle("alice", { ...resume, request_key: "stale-cas", if_revision: "0" }).error?.code).toBe(
		"revision_conflict",
	);
	const approved = { ...resume, request_key: "resume-ok" };
	const result = store.mutateLifecycle("alice", approved);
	expect(result.state).toBe("completed");
	expect(store.getRun(id)?.state).toBe("running");
	expect(store.mutateLifecycle("alice", approved)).toEqual(result);
	expect(store.schedule(id, owner.owner_id, owner.epoch).action?.type).toBe("ready");
});

it("binds operator pauses to the holding principal and keeps decision gates closed to a bare resume", () => {
	const { store, id, control } = setup();
	store.configureLifecycle({
		authorize: (principal: string) => principal === "alice" || principal === "bob",
		verifyResume: (principal, request, { run }) =>
			"kind" in request.payload && run.hold_kind === "operator" && run.held_by === principal,
	});
	const resume = (
		key: string,
		payload: { decision_ref: typeof ref } | { kind: "operator" },
	): GraphLifecycleRequest => ({
		version: 1,
		request_key: key,
		operation: "resume",
		target_id: id,
		if_revision: store.getRun(id)!.revision,
		payload,
	});
	const asRequest = (value: unknown): GraphLifecycleRequest => value as GraphLifecycleRequest;
	expect(
		store.mutateLifecycle(
			"alice",
			asRequest({ ...control("hold-invalid", "hold"), payload: { reason: "bad", kind: "bogus" } }),
		).error?.code,
	).toBe("definition_invalid");
	expect(
		store.mutateLifecycle("alice", asRequest({ ...resume("resume-empty", { kind: "operator" }), payload: {} })).error
			?.code,
	).toBe("definition_invalid");

	const operatorHold: GraphLifecycleRequest = {
		version: 1,
		request_key: "hold-operator",
		operation: "hold",
		target_id: id,
		if_revision: store.getRun(id)!.revision,
		payload: { reason: "focus", kind: "operator" },
	};
	expect(store.mutateLifecycle("alice", operatorHold).state).toBe("completed");
	const held = store.getRun(id)!;
	expect([held.state, held.hold_kind, held.held_by]).toEqual(["held", "operator", "alice"]);

	// Only the principal that paused the Run can lift its own pause, and a decision
	// reference never resolves an operator pause.
	expect(store.mutateLifecycle("bob", resume("resume-other", { kind: "operator" })).error?.code).toBe(
		"gate_unsatisfied",
	);
	expect(store.mutateLifecycle("alice", resume("resume-decision", { decision_ref: ref })).error?.code).toBe(
		"gate_unsatisfied",
	);
	expect(store.getRun(id)?.state).toBe("held");
	const lifted = store.mutateLifecycle("alice", resume("resume-operator", { kind: "operator" }));
	expect(lifted.state).toBe("completed");
	const running = store.getRun(id)!;
	expect([running.state, running.hold_kind, running.held_by]).toEqual(["running", undefined, undefined]);

	// A plain hold defaults to the decision gate; a bare operator resume cannot lift it.
	expect(store.mutateLifecycle("alice", control("hold-gate", "hold", "needs approval")).state).toBe("completed");
	const gate = store.getRun(id)!;
	expect([gate.state, gate.hold_kind, gate.held_by]).toEqual(["held", "gate", "alice"]);
	const refused = store.mutateLifecycle("alice", resume("resume-gate", { kind: "operator" }));
	expect(refused.error?.code).toBe("gate_unsatisfied");
	expect(refused.error?.message).toContain("operator pause");
	expect(store.mutateLifecycle("alice", resume("resume-gate-ref", { decision_ref: ref })).error?.code).toBe(
		"gate_unsatisfied",
	);
	expect(
		store.mutateLifecycle(
			"alice",
			asRequest({ ...resume("resume-gate-kind", { kind: "operator" }), payload: { kind: "gate" } }),
		).error?.code,
	).toBe("definition_invalid");
	expect(store.getRun(id)?.state).toBe("held");
});

for (const phase of ["pending", "ready"] as const) {
	it(`cancels undispatched ${phase} invocations with the Run`, () => {
		const { store, id, owner, control } = setup();
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		if (phase === "ready") store.schedule(id, owner.owner_id, owner.epoch);
		expect(store.mutateLifecycle("alice", control("cancel", "cancel")).state).toBe("completed");
		expect(store.getRun(id)?.state).toBe("cancelled");
		expect(store.getScheduleState(id)?.invocations.map(item => item.state)).toEqual(["cancelled"]);
		expect(store.getDispatchIntents(id)).toEqual([]);
	});
}

it("cancels pending dispatch without submission, but retains submitted work as cancelling and records late results", () => {
	const { store, id, owner, control } = setup();
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	store.schedule(id, owner.owner_id, owner.epoch);
	const intent = store.schedule(id, owner.owner_id, owner.epoch).intent!;
	const cancel = control("cancel", "cancel");
	expect(store.mutateLifecycle("alice", cancel).state).toBe("completed");
	expect(store.getRun(id)?.state).toBe("cancelled");
	expect(store.getDispatchIntents(id)[0].state).toBe("cancelled");
	expect(store.claimDispatch(owner.owner_id, owner.epoch, intent.id)).toBeNull();
	expect(store.schedule(id, owner.owner_id, owner.epoch).action).toBeNull();
});

it("never reports a claimed external attempt stopped and retains its late completion", () => {
	const { store, id, owner, control } = setup();
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	store.schedule(id, owner.owner_id, owner.epoch);
	const intent = store.schedule(id, owner.owner_id, owner.epoch).intent!;
	store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	store.mutateLifecycle("alice", control("cancel", "cancel"));
	expect(store.getRun(id)?.state).toBe("cancelling");
	expect(store.getDispatchIntents(id)[0].state).toBe("submitting");
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			state: "succeeded",
			outcome: "done",
		}),
	).toBe(false);
	expect(store.getAttemptHistory(id)[0]).toMatchObject({ accepted: false, completion: { state: "succeeded" } });
	expect(store.schedule(id, owner.owner_id, owner.epoch).action).toBeNull();
});

it("keeps cancellation pending for consultations and rolls back receipt and state on journal failure", () => {
	const { root, store, id, control } = setup();
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	const db = new Database(path.join(root, "graphs.sqlite"));
	try {
		db.exec(
			"CREATE TABLE consultations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, deadline INTEGER NOT NULL, data TEXT NOT NULL)",
		);
		db.query("INSERT INTO consultations VALUES (?,?,?,?,?)").run("c", id, "queued", 0, "{}");
		db.exec(
			"CREATE TRIGGER fail_lifecycle BEFORE INSERT ON graph_events BEGIN SELECT RAISE(ABORT, 'journal failure'); END",
		);
		const cancel = control("cancel", "cancel");
		expect(() => store.mutateLifecycle("alice", cancel)).toThrow();
		expect(store.getRun(id)?.state).toBe("queued");
		expect(store.definitions.requestGet("cancel")).toBeNull();
		db.exec("DROP TRIGGER fail_lifecycle");
		expect(store.mutateLifecycle("alice", cancel).state).toBe("completed");
		expect(store.getRun(id)?.state).toBe("cancelling");
		const events = db.query("SELECT data FROM graph_events ORDER BY seq").all() as { data: string }[];
		expect(events.map(event => JSON.parse(event.data).type)).toEqual(["run.created", "run.cancel"]);
	} finally {
		db.close();
	}
});

it("cancels an authorized human wait atomically and never accepts a late answer", () => {
	const context = setup("human");
	const { store, id, owner, control } = context;
	store.configureLifecycle({ authorize: principal => principal === "alice", verifyResume: () => false });
	store.configureHuman((_action, principal) => principal === "alice");
	const question = waitForHuman(context);
	const intent = store.getDispatchIntents(id)[0]!;
	const cancel = control("cancel", "cancel");
	expect(store.mutateLifecycle("mallory", cancel).error?.code).toBe("permission_denied");
	expect(
		store.mutateLifecycle("alice", { ...cancel, request_key: "stale-cancel", if_revision: "0" }).error?.code,
	).toBe("revision_conflict");
	expect(store.getRun(id)?.state).toBe("running");
	expect(store.getDispatchIntents(id)[0]).toEqual(intent);
	const result = store.mutateLifecycle("alice", cancel);
	expect(result.state).toBe("completed");
	expect(store.getRun(id)?.state).toBe("cancelled");
	expect(store.getScheduleState(id)?.invocations.find(item => item.id === question.invocation_id)?.state).toBe(
		"cancelled",
	);
	expect(store.getDispatchIntents(id)[0]).toEqual({ ...intent, state: "cancelled" });
	expect(store.getHumanQuestion("alice", question.id)).toEqual(question);
	const lateAnswer = answerForHuman(store, question);
	expect(store.answerHuman({ ...lateAnswer, principal: "mallory" }).error?.code).toBe("permission_denied");
	expect(store.answerHuman(lateAnswer).error?.code).toBe("revision_conflict");
	expect(store.getHumanQuestion("alice", question.id)).toEqual(question);
	expect(store.getRun(id)?.state).toBe("cancelled");
	expect(store.getScheduleState(id)?.invocations.find(item => item.id === question.invocation_id)?.state).toBe(
		"cancelled",
	);
	expect(store.schedule(id, owner.owner_id, owner.epoch).action).toBeNull();
	expect(store.mutateLifecycle("alice", cancel)).toEqual(result);
	expect(store.mutateLifecycle("mallory", cancel).error?.code).toBe("permission_denied");
	expect(() =>
		store.createHumanQuestion(
			owner.owner_id,
			owner.epoch,
			"alice",
			id,
			question.invocation_id,
			question.question_ref,
		),
	).toThrow();
});

it("withdraws a pending human dispatch without leaving a live invocation or creating a question", () => {
	const { store, id, owner, control } = setup("human");
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	store.configureHuman(() => true);
	store.schedule(id, owner.owner_id, owner.epoch);
	const intent = store.schedule(id, owner.owner_id, owner.epoch).intent!;
	expect(store.mutateLifecycle("alice", control("cancel", "cancel")).state).toBe("completed");
	expect(store.getRun(id)?.state).toBe("cancelled");
	expect(store.getDispatchIntents(id)[0].state).toBe("cancelled");
	expect(store.getScheduleState(id)?.invocations.find(item => item.id === intent.invocation_id)?.state).toBe(
		"cancelled",
	);
	expect(store.getHumanQuestion("alice", `human:${intent.invocation_id}`)).toBeNull();
	expect(store.claimDispatch(owner.owner_id, owner.epoch, intent.id)).toBeNull();
	expect(() =>
		store.createHumanQuestion(owner.owner_id, owner.epoch, "alice", id, intent.invocation_id, {
			id: "question",
			digest: "sha256:question",
		}),
	).toThrow();
});

it("rolls back human cancellation fences and its receipt when the journal fails", () => {
	const context = setup("human");
	const { root, store, id, control } = context;
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	store.configureHuman(() => true);
	const question = waitForHuman(context);
	const run = store.getRun(id);
	const schedule = store.getScheduleState(id);
	const intents = store.getDispatchIntents(id);
	const cancel = control("cancel", "cancel");
	const db = new Database(path.join(root, "graphs.sqlite"));
	try {
		db.exec(
			"CREATE TRIGGER fail_human_cancel BEFORE INSERT ON graph_events BEGIN SELECT RAISE(ABORT, 'journal failure'); END",
		);
		expect(() => store.mutateLifecycle("alice", cancel)).toThrow();
		expect(store.getRun(id)).toEqual(run);
		expect(store.getScheduleState(id)).toEqual(schedule);
		expect(store.getDispatchIntents(id)).toEqual(intents);
		expect(store.getHumanQuestion("alice", question.id)).toEqual(question);
		expect(store.definitions.requestGet("cancel")).toBeNull();
		db.exec("DROP TRIGGER fail_human_cancel");
		expect(store.mutateLifecycle("alice", cancel).state).toBe("completed");
		expect(store.getRun(id)?.state).toBe("cancelled");
		expect(store.getScheduleState(id)?.invocations.find(item => item.id === question.invocation_id)?.state).toBe(
			"cancelled",
		);
		expect(store.getDispatchIntents(id)[0].state).toBe("cancelled");
		expect(store.getHumanQuestion("alice", question.id)).toEqual(question);
	} finally {
		db.close();
	}
});

it("preserves a committed human decision and its evidence when the Run is later cancelled", () => {
	const context = setup("human");
	const { store, id, control } = context;
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	store.configureHuman((_action, principal) => principal === "alice");
	const question = waitForHuman(context);
	const answer = answerForHuman(store, question);
	const answered = store.answerHuman(answer);
	expect(answered.state).toBe("completed");
	const decision = store.getHumanQuestion("alice", question.id)!;
	const scope = {
		decision_id: decision.id,
		run_id: id,
		invocation_id: decision.invocation_id,
		input_digest: decision.input_digest,
		source_revision: decision.source_revision,
		author_ref: answer.author_ref,
		outcome: answer.outcome,
	};
	const evidence = store.getHumanEvidence("alice", decision.evidence_ref!, scope);
	const intent = store.getDispatchIntents(id)[0];
	const invocation = store.getScheduleState(id)?.invocations.find(item => item.id === question.invocation_id);
	expect(store.mutateLifecycle("alice", control("cancel", "cancel")).state).toBe("completed");
	expect(store.getRun(id)?.state).toBe("cancelled");
	expect(store.getHumanQuestion("alice", question.id)).toEqual(decision);
	expect(store.getHumanEvidence("alice", decision.evidence_ref!, scope)).toEqual(evidence);
	expect(store.getDispatchIntents(id)[0]).toEqual(intent);
	expect(store.getScheduleState(id)?.invocations.find(item => item.id === question.invocation_id)).toEqual(invocation);
	expect(store.answerHuman(answer)).toEqual(answered);
	expect(store.getRun(id)?.state).toBe("cancelled");
});

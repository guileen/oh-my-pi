import { describe, expect, test } from "bun:test";
import {
	assertGraphWireExecutionReplacement,
	graphWireExecutionRecordKey,
	validateGraphWireExecutionImage,
	validateGraphWireExecutionRecord,
} from "@oh-my-pi/pi-wire/graph/wire-execution-records";
import {
	GraphWireError,
	graphWireExecutionStateSupported,
	type GraphWireExecutionAttempt,
	type GraphWireExecutionImageRecord,
	type GraphWireExecutionInvocation,
	type GraphWireExecutionMember,
	type GraphWireExecutionRecord,
	type GraphWireRun,
} from "@oh-my-pi/pi-wire/graph";

const bot = { source_id: "bot-source", profile_id: "profile", bot_id: "bot" };
const protectedRef = { id: "snapshot", digest: "sha256:frozen" };
const baseRun = (run = "run"): { kind: "run"; value: GraphWireRun } => ({
	kind: "run",
	value: {
		graph_id: "graph",
		graph_run_id: run,
		definition_revision: "1",
		revision: "1",
		created_at: "2026-11-05T00:00:00Z",
		definition: {
			nodes: [
				{ node_id: "program", label: "Program", bot: null, config_revision: null, acceptance_ref: null },
				{ node_id: "bot", label: "Bot", bot, config_revision: "1", acceptance_ref: null },
			],
			edges: [],
		},
	},
});
const executionRun = (run = "run"): Extract<GraphWireExecutionRecord, { kind: "execution_run" }> => ({
	kind: "execution_run",
	value: {
		graph_run_id: run,
		revision: "1",
		state: "running",
		reason: null,
		snapshot_ref: protectedRef,
		budget_refs: [],
		decision_refs: ["protected-decision"],
	},
});
const member = (run = "run", memberId = "member"): { kind: "execution_member"; value: GraphWireExecutionMember } => ({
	kind: "execution_member",
	value: {
		graph_run_id: run,
		member_id: memberId,
		revision: "1",
		label: "Member",
		bot,
		duty: "general",
		model_binding_ref: protectedRef,
		base_snapshot_ref: protectedRef,
		communication_targets: [],
	},
});
const invocation = (run = "run"): { kind: "execution_invocation"; value: GraphWireExecutionInvocation } => ({
	kind: "execution_invocation",
	value: {
		graph_run_id: run,
		node_id: "program",
		invocation_id: "invocation",
		revision: "1",
		member_id: null,
		kind: "program",
		origin: "executed",
		iteration: 0,
		scope_id: "run",
		parent_invocation_id: null,
		state: "running",
		selected_outcome: null,
		input_refs: ["protected-input"],
		upstream_attempt_ids: [],
		wait_reason: null,
		current_attempt_id: "attempt",
	},
});
const attempt = (run = "run"): { kind: "execution_attempt"; value: GraphWireExecutionAttempt } => ({
	kind: "execution_attempt",
	value: {
		graph_run_id: run,
		attempt_id: "attempt",
		invocation_id: "invocation",
		revision: "1",
		number: 1,
		executor_kind: "program",
		state: "running",
		execution_ref: "protected-execution",
		result_ref: null,
		job: null,
	},
});
const conversation = (run = "run"): Extract<GraphWireExecutionRecord, { kind: "execution_conversation" }> => ({
	kind: "execution_conversation",
	value: {
		graph_run_id: run,
		conversation_id: "conversation",
		revision: "1",
		requester_member: "member",
		responder_member: "responder",
		state: "active",
		remaining_rounds: 0,
		deadline: "2026-11-05T01:00:00Z",
		content_ref: "protected-request",
		message_refs: ["protected-message"],
	},
});
const budget = (run = "run"): Extract<GraphWireExecutionRecord, { kind: "execution_budget" }> => ({
	kind: "execution_budget",
	value: { graph_run_id: run, budget_id: "budget", revision: "1", scope_key: "run", limit: 2, consumed: 0 },
});
const image = (): GraphWireExecutionImageRecord[] => [baseRun(), executionRun(), invocation(), attempt()];

function expectCode(action: () => void, code: GraphWireError["code"]): void {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(GraphWireError);
		expect((error as GraphWireError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code}`);
}

describe("Graph execution wire records", () => {
	test("a program attempt with job:null resolves without a fabricated Bot Binding", () => {
		validateGraphWireExecutionImage(image().reverse());
		const fake = attempt();
		fake.value.job = { ...bot, job_id: "invented" };
		expectCode(() => validateGraphWireExecutionRecord(fake), "invalid_input");
	});

	test("members, communication grants, conversations and budget references resolve in the complete image", () => {
		const run = executionRun();
		run.value.budget_refs = ["budget"];
		const requester = member();
		requester.value.communication_targets = ["responder"];
		const records: GraphWireExecutionImageRecord[] = [
			conversation(),
			budget(),
			requester,
			member("run", "responder"),
			run,
			baseRun(),
		];
		validateGraphWireExecutionImage(records);
		expectCode(
			() => validateGraphWireExecutionImage(records.filter(record => record.kind !== "execution_budget")),
			"invalid_input",
		);
	});

	test("a Bot Job must resolve the real frozen Bot identity", () => {
		const call = invocation();
		call.value.node_id = "bot";
		call.value.kind = "bot";
		call.value.member_id = "member";
		const work = attempt();
		work.value.executor_kind = "bot";
		work.value.job = { ...bot, job_id: "job" };
		const records = [baseRun(), executionRun(), member(), call, work];
		validateGraphWireExecutionImage(records);
		work.value.job.bot_id = "same-label-recreated-bot";
		expectCode(() => validateGraphWireExecutionImage(records), "invalid_input");
		work.value.job.bot_id = bot.bot_id;
		const missingIdentity = baseRun();
		missingIdentity.value.definition.nodes[1].bot = null;
		expectCode(() => validateGraphWireExecutionImage([missingIdentity, ...records.slice(1)]), "invalid_input");
	});

	test("cross-Run attempts cannot satisfy invocation current or upstream references", () => {
		const other = invocation("other");
		other.value.current_attempt_id = null;
		const records: GraphWireExecutionImageRecord[] = [
			baseRun(),
			executionRun(),
			invocation(),
			baseRun("other"),
			executionRun("other"),
			other,
			attempt("other"),
		];
		expectCode(() => validateGraphWireExecutionImage(records), "invalid_input");
		const current = invocation();
		current.value.current_attempt_id = null;
		current.value.upstream_attempt_ids = ["attempt"];
		expectCode(
			() =>
				validateGraphWireExecutionImage([
					current,
					...records.filter(
						record => record.kind !== "execution_invocation" || record.value.graph_run_id !== "run",
					),
				]),
			"invalid_input",
		);
	});

	test("cross-Run members, parents, conversations, budgets and communication targets cannot leak into a projection", () => {
		const call = invocation();
		call.value.node_id = "bot";
		call.value.kind = "bot";
		call.value.member_id = "member";
		call.value.current_attempt_id = null;
		expectCode(
			() =>
				validateGraphWireExecutionImage([
					baseRun(),
					executionRun(),
					call,
					baseRun("other"),
					executionRun("other"),
					member("other"),
				]),
			"invalid_input",
		);
		const parent = invocation("other");
		parent.value.invocation_id = "parent";
		parent.value.current_attempt_id = null;
		const child = invocation();
		child.value.current_attempt_id = null;
		child.value.parent_invocation_id = "parent";
		expectCode(
			() =>
				validateGraphWireExecutionImage([
					baseRun(),
					executionRun(),
					child,
					baseRun("other"),
					executionRun("other"),
					parent,
				]),
			"invalid_input",
		);
		expectCode(
			() =>
				validateGraphWireExecutionImage([
					baseRun(),
					executionRun(),
					conversation(),
					baseRun("other"),
					executionRun("other"),
					member("other"),
					member("other", "responder"),
				]),
			"invalid_input",
		);
		const run = executionRun();
		run.value.budget_refs = ["budget"];
		expectCode(
			() =>
				validateGraphWireExecutionImage([baseRun(), run, baseRun("other"), executionRun("other"), budget("other")]),
			"invalid_input",
		);
		const requester = member();
		requester.value.communication_targets = ["responder"];
		expectCode(
			() =>
				validateGraphWireExecutionImage([
					baseRun(),
					executionRun(),
					requester,
					baseRun("other"),
					executionRun("other"),
					member("other", "responder"),
				]),
			"invalid_input",
		);
	});

	test("unknown frozen nodes and missing base Runs reject instead of constructing topology", () => {
		const call = invocation();
		call.value.node_id = "not-frozen";
		expectCode(() => validateGraphWireExecutionImage([baseRun(), executionRun(), call, attempt()]), "invalid_input");
		expectCode(() => validateGraphWireExecutionImage([executionRun(), invocation(), attempt()]), "invalid_input");
	});

	test("malformed required control fields reject, including private Ref objects in string wire fields", () => {
		const invalid: [GraphWireExecutionRecord, string, unknown][] = [
			[executionRun(), "revision", "01"],
			[executionRun(), "reason", undefined],
			[member(), "bot", { bot_id: "only-display-id" }],
			[member(), "duty", "shell-owner"],
			[invocation(), "origin", "replayed"],
			[invocation(), "iteration", -1],
			[invocation(), "state", "future-state"],
			[invocation(), "current_attempt_id", undefined],
			[invocation(), "input_refs", [protectedRef]],
			[attempt(), "execution_ref", protectedRef],
			[attempt(), "number", 0],
			[attempt(), "number", 1.5],
			[attempt(), "state", "pending"],
			[conversation(), "remaining_rounds", -1],
			[conversation(), "deadline", 1_000],
			[conversation(), "deadline", "2026-11-05T01:00:00+01:00"],
			[conversation(), "content_ref", protectedRef],
			[budget(), "consumed", 3],
			[budget(), "limit", 0],
		];
		for (const [record, field, value] of invalid) {
			const malformed = { ...record, value: { ...record.value, [field]: value } };
			expectCode(() => validateGraphWireExecutionRecord(malformed), "invalid_input");
		}
	});

	test("unknown states expose reusable consumer unsupported metadata, but producers cannot publish them", () => {
		expect(graphWireExecutionStateSupported("execution_invocation", "cancelling")).toBe(true);
		expect(graphWireExecutionStateSupported("execution_attempt", "blocked")).toBe(false);
		expect(graphWireExecutionStateSupported("execution_conversation", "future-state")).toBe(false);
		expectCode(
			() =>
				validateGraphWireExecutionRecord({
					...conversation(),
					value: { ...conversation().value, state: "future-state" },
				}),
			"invalid_input",
		);
	});

	test("attempt identity and already bound refs cannot be rewritten by a newer revision", () => {
		const original = attempt();
		const update = attempt();
		update.value.revision = "2";
		update.value.state = "succeeded";
		update.value.result_ref = "protected-result";
		assertGraphWireExecutionReplacement(original, update);
		for (const mutation of [
			{ invocation_id: "other-invocation" },
			{ number: 2 },
			{ executor_kind: "queue" },
			{ execution_ref: "replacement-execution" },
		] as const) {
			expectCode(
				() =>
					assertGraphWireExecutionReplacement(original, {
						...update,
						value: { ...update.value, ...mutation },
					}),
				"binding_conflict",
			);
		}
		const botAttempt = attempt();
		botAttempt.value.executor_kind = "bot";
		botAttempt.value.job = { ...bot, job_id: "original-job" };
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(botAttempt, {
					...botAttempt,
					value: { ...botAttempt.value, revision: "2", job: { ...bot, job_id: "replacement-job" } },
				}),
			"binding_conflict",
		);
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(update, {
					...update,
					value: { ...update.value, revision: "3", result_ref: "replacement-result" },
				}),
			"binding_conflict",
		);
	});

	test("retry creates a separate retained attempt and duplicate attempt numbers reject", () => {
		const retry = attempt();
		retry.value.attempt_id = "retry";
		retry.value.number = 2;
		const call = invocation();
		call.value.current_attempt_id = "retry";
		validateGraphWireExecutionImage([baseRun(), executionRun(), call, attempt(), retry]);
		retry.value.number = 1;
		expectCode(
			() => validateGraphWireExecutionImage([baseRun(), executionRun(), call, attempt(), retry]),
			"binding_conflict",
		);
	});

	test("pending invocations can bind ready inputs, which remain frozen afterwards", () => {
		const pending = invocation();
		pending.value.state = "pending";
		pending.value.current_attempt_id = null;
		pending.value.input_refs = [];
		const ready = {
			...pending,
			value: {
				...pending.value,
				revision: "2",
				state: "ready" as const,
				input_refs: ["frozen-input"],
				upstream_attempt_ids: ["upstream-attempt"],
			},
		};
		assertGraphWireExecutionReplacement(pending, ready);
		assertGraphWireExecutionReplacement(ready, {
			...ready,
			value: { ...ready.value, revision: "3", state: "running", current_attempt_id: "attempt" },
		});
		for (const mutation of [
			{ input_refs: ["replacement-input"] },
			{ upstream_attempt_ids: ["replacement-upstream"] },
		]) {
			expectCode(
				() =>
					assertGraphWireExecutionReplacement(ready, {
						...ready,
						value: { ...ready.value, revision: "3", ...mutation },
					}),
				"binding_conflict",
			);
		}
	});

	test("a ready Bot attempt attaches its real admission Job once without permitting rebinding", () => {
		const ready = attempt();
		ready.value.executor_kind = "bot";
		ready.value.state = "ready";
		ready.value.execution_ref = null;
		const admitted = {
			...ready,
			value: {
				...ready.value,
				revision: "2",
				state: "running" as const,
				execution_ref: "admitted-execution",
				job: { ...bot, job_id: "admitted-job" },
			},
		};
		assertGraphWireExecutionReplacement(ready, admitted);
		for (const job of [
			null,
			{ ...bot, job_id: "replacement-job" },
			{ ...bot, bot_id: "replacement-bot", job_id: "admitted-job" },
		]) {
			expectCode(
				() =>
					assertGraphWireExecutionReplacement(admitted, {
						...admitted,
						value: { ...admitted.value, revision: "3", job },
					}),
				"binding_conflict",
			);
		}
	});

	test("terminal attempts and succeeded invocations never revive; failed invocations require a new ready attempt", () => {
		for (const state of ["succeeded", "failed", "cancelled"] as const) {
			const before = attempt();
			before.value.state = state;
			expectCode(
				() =>
					assertGraphWireExecutionReplacement(before, {
						...before,
						value: { ...before.value, revision: "2", state: "running" },
					}),
				"binding_conflict",
			);
		}
		const succeeded = invocation();
		succeeded.value.state = "succeeded";
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(succeeded, {
					...succeeded,
					value: { ...succeeded.value, revision: "2", state: "ready", current_attempt_id: "retry" },
				}),
			"binding_conflict",
		);
		for (const mutation of [
			{ current_attempt_id: "replacement-attempt" },
			{ selected_outcome: "replacement-outcome" },
		]) {
			expectCode(
				() =>
					assertGraphWireExecutionReplacement(succeeded, {
						...succeeded,
						value: { ...succeeded.value, revision: "2", ...mutation },
					}),
				"binding_conflict",
			);
		}
		const failed = invocation();
		failed.value.state = "failed";
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(failed, {
					...failed,
					value: { ...failed.value, revision: "2", state: "ready" },
				}),
			"binding_conflict",
		);
		const ready = {
			...failed,
			value: { ...failed.value, revision: "2", state: "ready" as const, current_attempt_id: "retry" },
		};
		assertGraphWireExecutionReplacement(failed, ready);
	});

	test("new revisions cannot replenish a fixed budget or consultation round allowance", () => {
		const consumed = budget();
		consumed.value.consumed = 1;
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(consumed, {
					...consumed,
					value: { ...consumed.value, revision: "2", consumed: 0 },
				}),
			"binding_conflict",
		);
		const waiting = conversation();
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(waiting, {
					...waiting,
					value: { ...waiting.value, revision: "2", remaining_rounds: 1 },
				}),
			"binding_conflict",
		);
	});

	test("terminal Runs and closed consultations cannot restart under a newer revision", () => {
		const finished = executionRun();
		finished.value.state = "succeeded";
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(finished, {
					...finished,
					value: { ...finished.value, revision: "2", state: "running" },
				}),
			"binding_conflict",
		);
		const answered = conversation();
		answered.value.state = "answered";
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(answered, {
					...answered,
					value: { ...answered.value, revision: "2", state: "active" },
				}),
			"binding_conflict",
		);
	});

	test("the same Bot Job cannot belong to two retained attempts", () => {
		const call = invocation();
		call.value.node_id = "bot";
		call.value.kind = "bot";
		call.value.member_id = "member";
		const first = attempt();
		first.value.executor_kind = "bot";
		first.value.job = { ...bot, job_id: "job" };
		const retry = { ...first, value: { ...first.value, attempt_id: "retry", number: 2 } };
		expectCode(
			() => validateGraphWireExecutionImage([baseRun(), executionRun(), member(), call, first, retry]),
			"binding_conflict",
		);
		retry.value.job = { ...bot, job_id: "retry-job" };
		validateGraphWireExecutionImage([baseRun(), executionRun(), member(), call, first, retry]);
	});

	test("an imported invocation has no fabricated attempt or Job", () => {
		const imported = invocation();
		imported.value.origin = "imported";
		imported.value.current_attempt_id = null;
		imported.value.state = "succeeded";
		validateGraphWireExecutionImage([baseRun(), executionRun(), imported]);
		expectCode(
			() => validateGraphWireExecutionImage([baseRun(), executionRun(), imported, attempt()]),
			"invalid_input",
		);
		imported.value.current_attempt_id = "attempt";
		expectCode(() => validateGraphWireExecutionRecord(imported), "invalid_input");
	});

	test("additive fields survive and equal-revision differences remain protocol_error", () => {
		const before = {
			...attempt(),
			extra_envelope: "kept",
			value: { ...attempt().value, extra_detail: { version: 1 } },
		};
		validateGraphWireExecutionRecord(before);
		assertGraphWireExecutionReplacement(before, structuredClone(before));
		const changed = { ...before, value: { ...before.value, extra_detail: { version: 2 } } };
		expectCode(() => assertGraphWireExecutionReplacement(before, changed), "protocol_error");
		expectCode(
			() =>
				assertGraphWireExecutionReplacement(attempt(), {
					...attempt(),
					value: { ...attempt().value, state: "succeeded" },
				}),
			"protocol_error",
		);
	});

	test("Run-scoped identities do not collide when member and attempt IDs repeat across Runs", () => {
		expect(graphWireExecutionRecordKey(member())).not.toBe(graphWireExecutionRecordKey(member("other")));
		expect(graphWireExecutionRecordKey(attempt())).not.toBe(graphWireExecutionRecordKey(attempt("other")));
		validateGraphWireExecutionImage([
			...image(),
			baseRun("other"),
			executionRun("other"),
			invocation("other"),
			attempt("other"),
		]);
	});
});

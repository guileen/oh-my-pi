import { describe, expect, it } from "bun:test";
import type { GraphDefinition, GraphNode } from "../src/graph/contracts";
import { prepareGraphRewind } from "../src/graph/rewind";
import { planGraphSchedule, type SchedulerInvocation, type SchedulerState } from "../src/graph/scheduler";

const task: GraphNode = { kind: "human", task: "#task" };
const definition = (
	nodes: GraphDefinition["nodes"],
	edges: NonNullable<GraphDefinition["edges"]> = [],
): GraphDefinition => ({ format: "omp.graph/v1", name: "test", members: {}, nodes, edges });
const invocation = (
	id: string,
	node: string,
	state: SchedulerInvocation["state"],
	more: Partial<SchedulerInvocation> = {},
): SchedulerInvocation => ({ id, node, state, iteration: 1, scope_id: "scope", upstream: {}, ...more });
const run = (invocations: SchedulerInvocation[], more: Partial<SchedulerState> = {}): SchedulerState => ({
	run_state: "running",
	invocations,
	cycles: {},
	counters: [],
	...more,
});
const success = (id: string, node: string, outcome = "done", more: Partial<SchedulerInvocation> = {}) =>
	invocation(id, node, "succeeded", {
		outcome,
		attempt_id: `${id}-attempt`,
		completion_order: "1",
		routed: true,
		...more,
	});

describe("graph scheduler", () => {
	it("rewinds after an independent consultation without superseding its history", () => {
		const graph = definition({ edit: task, review: task, final: task }, [
			{ id: "forward", from: "edit", to: "review" },
			{ id: "back", from: "review", to: "edit", loop: "revision" },
		]);
		graph.loops = {
			revision: {
				max_reviews: 3,
				final_node: "final",
				retry_target: "edit",
				final_outcomes: { go: "go", hold: "hold" },
				count_nodes: ["review"],
				scope: "stage",
				stage: "draft",
			},
		};
		const edit = success("edit-old", "edit");
		const review = success("review-old", "review", "done", { routed: false, upstream: { forward: edit.id } });
		const consultation = success("consultation", "edit", "done", {
			consultation: { conversation_id: "conversation", message_id: "message", member_id: "writer" },
		});
		const final = invocation("final-old", "final", "pending");
		const state = run([edit, review, consultation, final]);
		const action = planGraphSchedule(graph, state).action;
		expect(action?.type).toBe("rewind");
		if (!action || action.type !== "rewind") throw new Error("Expected rewind");
		let sequence = 0;
		const result = prepareGraphRewind(graph, state, action, () => `new-${++sequence}`);
		expect(result.invocations.find(item => item.id === consultation.id)).toEqual(consultation);
		expect(
			result.invocations.find(item => item.node === "edit" && !item.superseded && !item.consultation),
		).toMatchObject({ state: "pending", upstream: { back: review.id } });
		consultation.state = "waiting";
		expect(() => prepareGraphRewind(graph, state, action, () => `other-${++sequence}`)).toThrow(
			"unresolved consultation",
		);
	});

	it("releases a waiting attempt's slot without routing independent consultation work", () => {
		const graph = definition({ requester: task, next: task });
		const ready = invocation("next", "next", "ready");
		const requester = invocation("requester", "requester", "running", { attempt_id: "attempt" });
		expect(planGraphSchedule(graph, run([requester, ready])).action).toBeNull();
		requester.state = "waiting";
		expect(planGraphSchedule(graph, run([requester, ready])).action).toMatchObject({
			type: "authorize",
			invocation_id: "next",
		});
		const consultation = invocation("consultation", "requester", "succeeded", {
			consultation: { conversation_id: "conversation", message_id: "message", member_id: "member" },
		});
		expect(planGraphSchedule(graph, run([consultation])).action).toBeNull();
		consultation.state = "running";
		expect(planGraphSchedule(graph, run([requester, consultation, ready])).action).toBeNull();
		expect(requester.attempt_id).toBe("attempt");
	});

	it("routes exhausted budgets even when all compute slots are occupied", () => {
		const graph = definition({
			active: task,
			blocked: { ...task, consume: ["quota"], on_budget_exhausted: "handler" },
			handler: task,
		});
		graph.budgets = { quota: { scope: "run", limit: 1 } };
		const result = planGraphSchedule(
			graph,
			run([invocation("a", "active", "running"), invocation("b", "blocked", "ready")], {
				counters: [{ key: "budget:quota:run:run", consumed: 1, reservations: ["a"] }],
			}),
		);
		expect(result.action).toMatchObject({ type: "route", invocation_id: "b", target: "handler" });
	});

	it("routes a review revision rather than treating it as approval", () => {
		const graph = definition(
			{
				review: {
					...task,
					outcomes: ["pass", "revise"],
					verdicts: ["approved", "rejected"],
					decisions: [{ verdict: "rejected", outcome: "revise" }],
				},
				revise: task,
				develop: task,
			},
			[
				{ id: "revise", from: "review", to: "revise", on: ["revise"] },
				{ id: "develop", from: "review", to: "develop", on: ["pass"] },
			],
		);
		const review = success("review", "review", "revise", { verdict: "rejected" });
		expect(
			planGraphSchedule(
				graph,
				run([review, invocation("a-develop", "develop", "pending", { upstream: { develop: "review" } })]),
			).action,
		).toMatchObject({ type: "skip", invocation_id: "a-develop" });
		expect(
			planGraphSchedule(
				graph,
				run([review, invocation("a-revise", "revise", "pending", { upstream: { revise: "review" } })]),
			).action,
		).toMatchObject({ type: "ready", invocation_id: "a-revise", upstream_attempt_ids: ["review-attempt"] });
	});

	it("holds missing or conflicting control results", () => {
		const graph = definition({
			review: {
				...task,
				outcomes: ["pass", "revise"],
				verdicts: ["yes", "no"],
				decisions: [{ verdict: "yes", outcome: "pass" }],
			},
		});
		for (const fields of [{ outcome: null }, { outcome: "pass", verdict: "no" }, { outcome: "pass" }]) {
			const result = planGraphSchedule(graph, run([invocation("review", "review", "succeeded", fields)]));
			expect(result.action?.type).toBe("hold");
			expect(result.errors[0]?.code).toBe("gate_unsatisfied");
		}
	});

	it("propagates unselected branches as skips and failed sources as blocks", () => {
		const graph = definition({ source: { ...task, outcomes: ["a", "b"] }, branch: task, join: task }, [
			{ id: "branch", from: "source", to: "branch", on: ["b"], branch_group: "choice" },
			{ id: "join", from: "branch", to: "join" },
		]);
		const source = success("source", "source", "a");
		expect(
			planGraphSchedule(
				graph,
				run([source, invocation("a-branch", "branch", "pending", { upstream: { branch: "source" } })]),
			).action?.type,
		).toBe("skip");
		expect(
			planGraphSchedule(
				graph,
				run([
					invocation("branch", "branch", "skipped"),
					invocation("join", "join", "pending", { upstream: { join: "branch" } }),
				]),
			).action?.type,
		).toBe("skip");
		expect(
			planGraphSchedule(
				graph,
				run([
					invocation("branch", "branch", "failed"),
					invocation("join", "join", "pending", { upstream: { join: "branch" } }),
				]),
			).action?.type,
		).toBe("block");
	});

	it("blocks an any join after every applicable source fails", () => {
		const graph = definition({ a: task, b: task, join: { ...task, join: "any" } }, [
			{ id: "a", from: "a", to: "join" },
			{ id: "b", from: "b", to: "join" },
		]);
		const result = planGraphSchedule(
			graph,
			run([
				invocation("a", "a", "failed"),
				invocation("b", "b", "failed"),
				invocation("join", "join", "pending", { upstream: { a: "a", b: "b" } }),
			]),
		);
		expect(result.action?.type).toBe("block");
	});

	it("pins the first any winner and never mixes a later source", () => {
		const graph = definition(
			{
				a: { ...task, outputs: { file: { media_type: "text/plain", required: true } } },
				b: { ...task, outputs: { file: { media_type: "text/plain", required: true } } },
				join: { ...task, join: "any" },
			},
			[
				{ id: "a", from: "a", to: "join", bind: { input: "file" } },
				{ id: "b", from: "b", to: "join", bind: { input: "file" } },
			],
		);
		const a = success("a", "a", "done", { completion_order: "2", outputs: { file: { id: "a-file", digest: "a" } } });
		const b = success("b", "b", "done", { completion_order: "1", outputs: { file: { id: "b-file", digest: "b" } } });
		const join = invocation("join", "join", "pending", { upstream: { a: "a", b: "b" } });
		expect(planGraphSchedule(graph, run([a, b, join])).action).toMatchObject({
			type: "ready",
			winner_edge: "b",
			upstream_invocation_ids: ["b"],
			inputs: { input: { id: "b-file", digest: "b" } },
		});
		expect(planGraphSchedule(graph, run([a, b, { ...join, winner_edge: "a" }])).action).toMatchObject({
			winner_edge: "a",
			upstream_attempt_ids: ["a-attempt"],
		});
	});

	it("uses the pinned upstream invocation rather than a newer unrelated version", () => {
		const graph = definition(
			{ source: { ...task, outputs: { file: { media_type: "text/plain", required: true } } }, target: task },
			[{ id: "input", from: "source", to: "target", bind: { data: "file" } }],
		);
		const old = success("old", "source", "done", { outputs: { file: { id: "old", digest: "old" } } });
		const fresh = success("fresh", "source", "done", {
			iteration: 2,
			outputs: { file: { id: "fresh", digest: "fresh" } },
		});
		const target = invocation("target", "target", "pending", { upstream: { input: "fresh" }, iteration: 2 });
		expect(planGraphSchedule(graph, run([old, fresh, target])).action).toMatchObject({
			upstream_invocation_ids: ["fresh"],
			inputs: { data: { id: "fresh", digest: "fresh" } },
		});
	});

	it("does not start virtual routes as entries", () => {
		const graph = definition({
			entry: task,
			final: task,
			exhausted: task,
			worker: { ...task, on_budget_exhausted: "exhausted" },
		});
		graph.loops = {
			review: {
				max_reviews: 3,
				final_node: "final",
				retry_target: "entry",
				final_outcomes: { go: "done", hold: "hold" },
				count_nodes: ["entry"],
				scope: "stage",
				stage: "draft",
			},
		};
		expect(
			planGraphSchedule(graph, run([invocation("a", "final", "pending"), invocation("b", "exhausted", "pending")]))
				.action,
		).toBeNull();
	});

	it("does not wait for an unselected final route after the last ordinary review passes", () => {
		const graph = definition(
			{
				edit: task,
				review: {
					...task,
					outcomes: ["pass", "revise"],
					outputs: { report: { media_type: "text/plain", required: true } },
				},
				final: { ...task, outcomes: ["go", "hold"] },
				deliver: task,
			},
			[
				{ id: "review", from: "edit", to: "review" },
				{ id: "retry", from: "review", to: "edit", on: ["revise"], loop: "reviews" },
				{ id: "ordinary", from: "review", to: "deliver", on: ["pass"], bind: { report: "report" } },
				{ id: "adjudicated", from: "final", to: "deliver", on: ["go"] },
			],
		);
		graph.loops = {
			reviews: {
				max_reviews: 1,
				final_node: "final",
				retry_target: "edit",
				final_outcomes: { go: "go", hold: "hold" },
				count_nodes: ["review"],
				scope: "stage",
				stage: "draft",
			},
		};
		const report = { id: "ordinary-report", digest: "sha256:ordinary-report" };
		const review = success("review", "review", "pass", { outputs: { report } });
		const final = invocation("final", "final", "pending");
		const deliver = invocation("a-deliver", "deliver", "pending", {
			upstream: { ordinary: review.id, adjudicated: final.id },
		});
		const state = run([review, final, deliver], {
			counters: [{ key: "loop:reviews:stage:draft", consumed: 1, reservations: [review.id] }],
		});
		expect(planGraphSchedule(graph, state).action).toEqual({
			type: "ready",
			invocation_id: deliver.id,
			inputs: { report },
			upstream_invocation_ids: [review.id],
			upstream_attempt_ids: [review.attempt_id!],
		});
		for (const changed of [
			{ ...review, state: "running" as const },
			{ ...review, routed: false },
		]) {
			expect(planGraphSchedule(graph, { ...state, invocations: [changed, final, deliver] }).action?.type).not.toBe(
				"ready",
			);
		}
		expect(planGraphSchedule(graph, { ...state, invocations: [final, deliver] }).action?.type).toBe("hold");
		expect(
			planGraphSchedule(graph, { ...state, invocations: [review, { ...final, activated: true }, deliver] }).action,
		).toMatchObject({ type: "ready", invocation_id: final.id });
	});

	it("propagates dormant budget routes without skipping a still-possible shared handler", () => {
		const graph = definition(
			{
				first: { ...task, consume: ["quota"], on_budget_exhausted: "handler" },
				second: { ...task, consume: ["quota"], on_budget_exhausted: "handler" },
				handler: { ...task, consume: ["other"], on_budget_exhausted: "fallback" },
				fallback: task,
				deliver: task,
			},
			[
				{ id: "first", from: "first", to: "deliver" },
				{ id: "handler", from: "handler", to: "deliver" },
				{ id: "fallback", from: "fallback", to: "deliver" },
			],
		);
		graph.budgets = { quota: { limit: 2, scope: "run" }, other: { limit: 1, scope: "run" } };
		const first = success("first", "first");
		const second = success("second", "second");
		const handler = invocation("handler", "handler", "pending");
		const fallback = invocation("fallback", "fallback", "pending");
		const deliver = invocation("a-deliver", "deliver", "pending", {
			upstream: { first: first.id, handler: handler.id, fallback: fallback.id },
		});
		expect(planGraphSchedule(graph, run([first, second, handler, fallback, deliver])).action).toMatchObject({
			type: "ready",
			invocation_id: deliver.id,
			upstream_invocation_ids: [first.id],
		});
		expect(
			planGraphSchedule(graph, run([first, { ...second, state: "running" }, handler, fallback, deliver])).action,
		).toBeNull();
	});

	it("binds the persisted final review source and holds invalid or stale identities", () => {
		const graph = definition({
			review: { ...task, outputs: { report: { media_type: "text/plain", required: false } } },
			other: task,
			final: { ...task, required_inputs: ["assessment"] },
		});
		graph.loops = {
			reviews: {
				max_reviews: 1,
				final_node: "final",
				retry_target: "review",
				final_outcomes: { go: "done", hold: "hold" },
				count_nodes: ["review"],
				final_bind: { assessment: "report" },
				scope: "stage",
				stage: "draft",
			},
		};
		const ref = { id: "report", digest: "digest" };
		const source = success("review-source", "review", "done", { outputs: { report: ref } });
		const target = invocation("a-final", "final", "pending", {
			activated: true,
			activation_source: { invocation_id: source.id, attempt_id: source.attempt_id, reason: "loop_exhausted" },
		});
		expect(planGraphSchedule(graph, run([source, target])).action).toMatchObject({
			type: "ready",
			inputs: { assessment: ref },
			upstream_invocation_ids: [source.id],
			upstream_attempt_ids: [source.attempt_id],
		});
		const imported = { ...source, origin: "imported" as const, attempt_id: undefined };
		expect(
			planGraphSchedule(
				graph,
				run([
					imported,
					{
						...target,
						activation_source: {
							invocation_id: imported.id,
							reason: "loop_exhausted",
						},
					},
				]),
			).action,
		).toMatchObject({ type: "ready", upstream_invocation_ids: [source.id], upstream_attempt_ids: [] });
		for (const [candidate, changedTarget] of [
			[source, { ...target, activation_source: undefined }],
			[source, { ...target, activation_source: { invocation_id: "missing", reason: "loop_exhausted" as const } }],
			[
				source,
				{
					...target,
					activation_source: { invocation_id: source.id, attempt_id: "old", reason: "loop_exhausted" as const },
				},
			],
			[
				source,
				{
					...target,
					activation_source: {
						invocation_id: source.id,
						attempt_id: source.attempt_id,
						reason: "budget_exhausted" as const,
					},
				},
			],
			[{ ...source, node: "other" }, target],
			[{ ...source, state: "ready" as const }, target],
			[{ ...source, routed: false }, target],
			[{ ...source, outputs: {} }, target],
		] as const) {
			expect(planGraphSchedule(graph, run([candidate, changedTarget])).action?.type).toBe("hold");
		}
		expect(
			planGraphSchedule(
				graph,
				run([invocation("review-ready", "review", "ready")], {
					counters: [{ key: "loop:reviews:stage:draft", consumed: 1, reservations: ["previous"] }],
				}),
			).action,
		).toMatchObject({ type: "hold", error: { code: "gate_unsatisfied" } });
	});

	it("preserves the ordinary third-review pass and routes the last failure straight to final", () => {
		const graph = definition(
			{
				review: { ...task, outcomes: ["pass", "revise"] },
				revision: task,
				done: task,
				final: { ...task, outcomes: ["go", "hold"] },
			},
			[
				{ id: "pass", from: "review", to: "done", on: ["pass"] },
				{ id: "revise", from: "review", to: "revision", on: ["revise"] },
				{ id: "retry", from: "revision", to: "review", loop: "review-loop" },
			],
		);
		graph.loops = {
			"review-loop": {
				max_reviews: 3,
				final_node: "final",
				retry_target: "review",
				final_outcomes: { go: "go", hold: "hold" },
				count_nodes: ["review"],
				scope: "stage",
				stage: "draft",
			},
		};
		const counter = { key: "loop:review-loop:stage:draft", consumed: 3, reservations: ["r1", "r2", "r3"] };
		const review = invocation("r3", "review", "succeeded", { outcome: "pass" });
		expect(planGraphSchedule(graph, run([review], { counters: [counter] })).action).toEqual({
			type: "routed",
			invocation_id: "r3",
		});
		expect(
			planGraphSchedule(graph, run([{ ...review, outcome: "revise" }], { counters: [counter] })).action,
		).toMatchObject({ type: "route", target: "final", reason: "loop_exhausted" });
		const routedReview = success("r3", "review", "revise", { suppressed_edges: ["revise"] });
		const revision = invocation("revision", "revision", "pending", { upstream: { revise: "r3" } });
		expect(planGraphSchedule(graph, run([routedReview, revision], { counters: [counter] })).action).toMatchObject({
			type: "skip",
			invocation_id: "revision",
		});
		const final = invocation("final", "final", "ready", { activated: true });
		expect(
			planGraphSchedule(
				graph,
				run([final], {
					counters: [{ key: "final:loop:review-loop:stage:draft", consumed: 1, reservations: ["old-final"] }],
				}),
			).action,
		).toMatchObject({ type: "hold" });
	});

	it("reserves budgets once and routes exhaustion before dispatch", () => {
		const graph = definition({ work: { ...task, consume: ["attempts"], on_budget_exhausted: "save" }, save: task });
		graph.budgets = { attempts: { limit: 1, scope: "run" } };
		const work = invocation("work-2", "work", "ready");
		const counter = { key: "budget:attempts:run:run", consumed: 1, reservations: ["work-1"] };
		expect(planGraphSchedule(graph, run([work], { counters: [counter] })).action).toMatchObject({
			type: "route",
			target: "save",
			reason: "budget_exhausted",
		});
		expect(planGraphSchedule(graph, run([{ ...work, id: "work-1" }], { counters: [counter] })).action?.type).toBe(
			"authorize",
		);
	});

	it("freezes non-consuming budget branches for run, stage and cycle scopes", () => {
		const graph = definition({ check: task, proceed: task, stop: task }, [
			{ id: "yes", from: "check", to: "proceed", when_budget: { budget: "quota", state: "available" } },
			{ id: "no", from: "check", to: "stop", when_budget: { budget: "quota", state: "exhausted" } },
		]);
		graph.loops = {
			cycle: {
				max_reviews: 1,
				final_node: "stop",
				retry_target: "check",
				final_outcomes: { go: "done", hold: "hold" },
				count_nodes: [],
				scope: "cycle",
				cycle_start: "check",
				reset_from: [],
			},
		};
		const source = success("check", "check", "done", { routed: false });
		for (const [budget, key, cycles] of [
			[{ limit: 2, scope: "run" as const }, "budget:quota:run:run", {}],
			[{ limit: 2, scope: "stage" as const, stage: "draft" }, "budget:quota:stage:draft", {}],
			[{ limit: 2, scope: "cycle" as const, loop: "cycle" }, "budget:quota:cycle:c1", { cycle: "c1" }],
		] as const) {
			graph.budgets = { quota: budget };
			const counters = [{ key, consumed: 1, reservations: ["previous"] }];
			const state = run([source], { counters, cycles });
			expect(planGraphSchedule(graph, state).action).toEqual({
				type: "routed",
				invocation_id: "check",
				suppressed_edges: ["no"],
			});
			expect(counters).toEqual([{ key, consumed: 1, reservations: ["previous"] }]);
			expect(
				planGraphSchedule(graph, run([source], { counters: [{ key, consumed: 2, reservations: [] }], cycles }))
					.action,
			).toEqual({ type: "routed", invocation_id: "check", suppressed_edges: ["yes"] });
		}
	});

	it("uses the frozen branch at joins after counters change and rejects missing snapshots", () => {
		const graph = definition({ check: task, join: { ...task, join: "any" } }, [
			{ id: "yes", from: "check", to: "join", when_budget: { budget: "quota", state: "available" } },
			{ id: "no", from: "check", to: "join", when_budget: { budget: "quota", state: "exhausted" } },
		]);
		graph.budgets = { quota: { limit: 1, scope: "run" } };
		expect(
			planGraphSchedule(graph, run([success("check", "check", "done", { routed: false })])).action,
		).toMatchObject({ type: "routed", suppressed_edges: ["no"] });
		const source = success("check", "check", "done", { suppressed_edges: ["no"] });
		const join = invocation("a-join", "join", "pending", { upstream: { yes: "check", no: "check" } });
		const state = run([source, join], { counters: [{ key: "budget:quota:run:run", consumed: 1, reservations: [] }] });
		expect(planGraphSchedule(graph, state).action).toMatchObject({ type: "ready", winner_edge: "yes" });
		expect(planGraphSchedule(graph, run([{ ...source, suppressed_edges: undefined }, join])).action?.type).toBe(
			"hold",
		);
	});

	it("holds for missing budget scope or ambiguous counter snapshots", () => {
		const graph = definition({ check: task, next: task }, [
			{ id: "next", from: "check", to: "next", when_budget: { budget: "quota", state: "available" } },
		]);
		const source = success("check", "check", "done", { routed: false });
		expect(planGraphSchedule(graph, run([source])).action?.type).toBe("hold");
		graph.budgets = { quota: { limit: 1, scope: "cycle", loop: "missing" } };
		expect(planGraphSchedule(graph, run([source])).action?.type).toBe("hold");
		graph.loops = {
			missing: {
				max_reviews: 1,
				final_node: "next",
				retry_target: "check",
				final_outcomes: { go: "done", hold: "hold" },
				count_nodes: [],
				scope: "cycle",
				cycle_start: "check",
				reset_from: [],
			},
		};
		expect(planGraphSchedule(graph, run([source])).action?.type).toBe("hold");
		graph.budgets.quota = { limit: 1, scope: "run" };
		const counter = { key: "budget:quota:run:run", consumed: 0, reservations: [] };
		expect(planGraphSchedule(graph, run([source], { counters: [counter, counter] })).action?.type).toBe("hold");
	});

	it("does not send a budget-suppressed retry to a loop final", () => {
		const graph = definition({ review: task, revise: task, stop: task, final: task }, [
			{ id: "retry", from: "review", to: "revise", when_budget: { budget: "quota", state: "available" } },
			{ id: "stop", from: "review", to: "stop", when_budget: { budget: "quota", state: "exhausted" } },
			{ id: "back", from: "revise", to: "review", loop: "loop" },
		]);
		graph.budgets = { quota: { limit: 1, scope: "run" } };
		graph.loops = {
			loop: {
				max_reviews: 1,
				final_node: "final",
				retry_target: "review",
				final_outcomes: { go: "done", hold: "hold" },
				count_nodes: ["review"],
				scope: "stage",
				stage: "draft",
			},
		};
		const review = success("review", "review", "done", { routed: false });
		const counters = [
			{ key: "budget:quota:run:run", consumed: 1, reservations: [] },
			{ key: "loop:loop:stage:draft", consumed: 1, reservations: [] },
		];
		expect(planGraphSchedule(graph, run([review], { counters })).action).toEqual({
			type: "routed",
			invocation_id: "review",
			suppressed_edges: ["retry"],
		});
		counters[0].consumed = 0;
		expect(planGraphSchedule(graph, run([review], { counters })).action).toMatchObject({
			type: "route",
			target: "final",
			suppressed_edges: ["retry", "stop"],
		});
	});

	it("plans a bounded rewind over every path and resets only the declared cycle", () => {
		const graph = definition({ start: task, left: task, right: task, review: task, outside: task, final: task }, [
			{ id: "sl", from: "start", to: "left" },
			{ id: "sr", from: "start", to: "right" },
			{ id: "lr", from: "left", to: "review" },
			{ id: "rr", from: "right", to: "review" },
			{ id: "back", from: "review", to: "start", loop: "revision" },
		]);
		graph.loops = {
			revision: {
				max_reviews: 3,
				final_node: "final",
				retry_target: "start",
				final_outcomes: { go: "done", hold: "hold" },
				count_nodes: [],
				scope: "cycle",
				cycle_start: "start",
				reset_from: ["review"],
			},
		};
		const review = success("review-old", "review", "done", { routed: false, iteration: 2 });
		expect(planGraphSchedule(graph, run([review])).action).toEqual({
			type: "rewind",
			invocation_id: "review-old",
			loop: "revision",
			edge: "back",
			target: "start",
			affected_nodes: ["left", "review", "right", "start"],
			new_cycle: true,
		});
		graph.loops.revision.reset_from = [];
		expect(planGraphSchedule(graph, run([review])).action).toMatchObject({ type: "rewind", new_cycle: false });
		graph.budgets = { quota: { limit: 1, scope: "run" } };
		graph.edges![4].when_budget = { budget: "quota", state: "available" };
		expect(planGraphSchedule(graph, run([review])).action).toMatchObject({ type: "rewind", suppressed_edges: [] });
	});

	it("binds the exact triggering loop version alongside the ordinary any winner", () => {
		const graph = definition(
			{
				external: { ...task, outputs: { file: { media_type: "text/plain", required: false } } },
				start: { ...task, join: "any", required_inputs: ["feedback", "context"] },
				review: { ...task, outputs: { file: { media_type: "text/plain", required: false } } },
			},
			[
				{ id: "context", from: "external", to: "start", bind: { context: "file" } },
				{ id: "forward", from: "start", to: "review" },
				{ id: "back", from: "review", to: "start", loop: "revision", bind: { feedback: "file" } },
			],
		);
		const external = success("external-old", "external", "done", { outputs: { file: { id: "ctx", digest: "c" } } });
		const old = success("review-old", "review", "done", { outputs: { file: { id: "old", digest: "o" } } });
		const fresh = success("review-fresh", "review", "done", {
			iteration: 2,
			outputs: { file: { id: "fresh", digest: "f" } },
		});
		const target = invocation("target", "start", "pending", {
			iteration: 3,
			upstream: { context: external.id, back: fresh.id },
		});
		expect(planGraphSchedule(graph, run([target, old, fresh, external])).action).toMatchObject({
			type: "ready",
			invocation_id: "target",
			winner_edge: "context",
			inputs: { context: { id: "ctx", digest: "c" }, feedback: { id: "fresh", digest: "f" } },
			upstream_invocation_ids: ["external-old", "review-fresh"],
			upstream_attempt_ids: ["external-old-attempt", "review-fresh-attempt"],
		});
		const imported = { ...fresh, origin: "imported" as const, attempt_id: undefined };
		expect(planGraphSchedule(graph, run([target, old, imported, external])).action).toMatchObject({
			type: "ready",
			upstream_invocation_ids: ["external-old", "review-fresh"],
			upstream_attempt_ids: ["external-old-attempt"],
		});
	});

	it("rejects invalid loop sources, missing outputs, and conflicting input bindings", () => {
		const graph = definition(
			{
				start: { ...task, inputs: { feedback: { text: "initial" } } },
				review: { ...task, outputs: { file: { media_type: "text/plain", required: false } } },
			},
			[
				{ id: "forward", from: "start", to: "review" },
				{ id: "back", from: "review", to: "start", loop: "revision", bind: { feedback: "file" } },
			],
		);
		const source = success("source", "review", "done", { outputs: { file: { id: "f", digest: "d" } } });
		const target = invocation("target", "start", "pending", { upstream: { back: "source" } });
		expect(planGraphSchedule(graph, run([source, target])).action).toMatchObject({
			type: "hold",
			error: { message: "Duplicate binding for feedback" },
		});
		graph.nodes.start = task;
		expect(planGraphSchedule(graph, run([{ ...source, outputs: {} }, target])).action).toMatchObject({
			type: "hold",
			error: { message: "Missing upstream output review.file" },
		});
		expect(planGraphSchedule(graph, run([{ ...source, suppressed_edges: ["back"] }, target])).action).toMatchObject({
			type: "hold",
			error: { message: "Loop edge back was not selected" },
		});
		expect(planGraphSchedule(graph, run([{ ...source, attempt_id: undefined }, target])).action).toMatchObject({
			type: "hold",
			error: { message: "Successful upstream lacks versioned identity or completion order" },
		});
	});

	it("does not wait for a loop source on the initial entry", () => {
		const graph = definition({ start: task, review: task }, [
			{ id: "forward", from: "start", to: "review" },
			{ id: "back", from: "review", to: "start", loop: "revision" },
		]);
		expect(planGraphSchedule(graph, run([invocation("start", "start", "pending")])).action).toMatchObject({
			type: "ready",
			invocation_id: "start",
			upstream_invocation_ids: [],
		});
	});
});

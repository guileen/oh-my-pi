import { describe, expect, it } from "bun:test";
import { validateGraphRelations } from "../src/graph/relations";
import { parseGraphSource } from "../src/graph/source";
import type { GraphIssue } from "../src/graph/validation-types";

const limits = { maxBytes: 100_000, maxDepth: 50, maxAliases: 100, maxNodes: 10_000 };
function issues(yaml: string, body = "") {
	return validateGraphRelations(parseGraphSource(`---\n${yaml}\n---\n${body}`, limits));
}
const paths = (items: GraphIssue[]) => items.map(item => item.path);

describe("graph relationship validation", () => {
	it("accepts an empty draft", () => {
		expect(issues("format: omp.graph/v1\nname: draft\nmembers: {}\nnodes: {}")).toEqual([]);
	});

	it("validates final binding declarations, collisions and source ambiguity", () => {
		const yaml = `members: {}
nodes:
  review: {task: '#task', outputs: {report: {}}}
  review-two: {task: '#task', outputs: {report: {}}}
  final: {task: '#task', outcomes: [go, hold]}
loops:
  l: {final_node: final, retry_target: review, final_outcomes: {go: go, hold: hold}, count_nodes: [review, review-two], final_bind: {assessment: report}, scope: stage, stage: draft}`;
		const body = "## task\nTask\n";
		expect(issues(yaml, body)).toEqual([]);
		expect(
			paths(
				issues(
					yaml.replace("review-two: {task: '#task', outputs: {report: {}}}", "review-two: {task: '#task'}"),
					body,
				),
			),
		).toContain("/loops/l/final_bind/assessment");
		expect(
			paths(
				issues(
					yaml.replace(
						"final: {task: '#task', outcomes:",
						"final: {task: '#task', inputs: {assessment: {text: x}}, outcomes:",
					),
					body,
				),
			),
		).toContain("/loops/l/final_bind/assessment");
		expect(
			paths(issues(`${yaml}\nedges: [{id: e, from: review, to: final, bind: {assessment: report}}]`, body)),
		).toContain("/loops/l/final_bind/assessment");
		expect(
			paths(
				issues(
					`${yaml}\n  other: {final_node: final, retry_target: review, final_outcomes: {go: go, hold: hold}, count_nodes: [review], scope: stage, stage: draft}`,
					body,
				),
			),
		).toContain("/loops/l/count_nodes/0");
	});

	it("reports missing members, headings, budgets, outcomes, nodes and outputs at their locations", () => {
		const found = paths(
			issues(
				`members:
  author: {role: '#missing-role', duty: code-only, base: isolated}
nodes:
  a:
    task: '#missing-task'
    member: absent
    consume: [missing-budget]
    outcomes: [ok]
    terminal: {bad: hold}
    decisions: [{verdict: no, outcome: bad}]
  b: {task: '#task'}
edges:
  - {id: e, from: a, to: b, on: [bad], bind: {input: absent}}
  - {id: f, from: missing, to: nowhere}
communications:
  - {from: absent, to: author, when: '#missing-when'}`,
				"## task\nTask\n",
			),
		);
		for (const path of [
			"/members/author/role",
			"/members/author/base",
			"/nodes/a/task",
			"/nodes/a/member",
			"/nodes/a/consume/0",
			"/nodes/a/terminal/bad",
			"/nodes/a/decisions/0/outcome",
			"/edges/0/on/0",
			"/edges/0/bind/input",
			"/edges/1/from",
			"/edges/1/to",
			"/communications/0/from",
			"/communications/0/when",
		])
			expect(found).toContain(path);
	});

	it("rejects implicit cycles and accepts a bounded declared back edge", () => {
		const base = `members: {}
nodes:
  edit: {task: '#task'}
  review: {task: '#task'}
  final: {task: '#task', outcomes: [go, hold]}
loops:
  revisions:
    max_reviews: 3
    final_node: final
    retry_target: edit
    final_outcomes: {go: go, hold: hold}
    count_nodes: [review]
    scope: stage
    stage: draft
edges:
  - {id: forward, from: edit, to: review}
  - {id: back, from: review, to: edit%s}`;
		const body = "## task\nTask\n";
		expect(issues(base.replace("%s", ""), body).some(item => item.message.includes("cycle"))).toBe(true);
		expect(issues(base.replace("%s", ", loop: revisions"), body)).toEqual([]);
	});

	it("checks loop and budget references and cycles through virtual routes", () => {
		const found = paths(
			issues(
				`members: {}
nodes:
  a: {task: '#task', consume: [quota], on_budget_exhausted: b}
  b: {task: '#task', consume: [quota]}
budgets:
  quota: {limit: 2, scope: cycle, loop: missing}
loops:
  loop-one:
    final_node: b
    retry_target: absent
    final_outcomes: {go: missing, hold: done}
    count_nodes: [absent]
    scope: cycle
    cycle_start: absent
    reset_from: [absent]
edges:
  - {id: e, from: b, to: a}`,
				"## task\nTask\n",
			),
		);
		for (const path of [
			"/nodes/a/on_budget_exhausted",
			"/budgets/quota/loop",
			"/loops/loop-one/retry_target",
			"/loops/loop-one/final_outcomes/go",
			"/loops/loop-one/count_nodes/0",
			"/loops/loop-one/cycle_start",
			"/loops/loop-one/reset_from/0",
			"/edges/0",
		])
			expect(found).toContain(path);
	});

	it("allows unbound required inputs in drafts and checks duplicate bindings", () => {
		const yaml = `members: {}
nodes:
  origin: {task: '#task', outcomes: [left, right], outputs: {value: {}}}
  target: {task: '#task', join: any, required_inputs: [value, missing]}
edges:
  - {id: left, from: origin, to: target, on: [left], branch_group: choice, bind: {value: value}}
  - {id: right, from: origin, to: target, on: [right], branch_group: choice, bind: {value: value}}`;
		const body = "## task\nTask\n";
		expect(paths(issues(yaml, body))).toEqual([]);
		expect(paths(issues(yaml.replace("on: [right]", "on: [left]"), body))).toContain("/edges/1/bind/value");
		expect(paths(issues(yaml.replace("join: any", "join: all"), body))).toContain("/edges/1/bind/value");
	});

	it("recognizes opposite tests of the same budget as exclusive and checks references", () => {
		const yaml = `members: {}
nodes:
  source: {task: '#task', outputs: {value: {}}}
  target: {task: '#task', join: any}
budgets: {quota: {scope: run, limit: 1}}
edges:
  - {id: yes, from: source, to: target, branch_group: choice, bind: {value: value}, when_budget: {budget: quota, state: available}}
  - {id: no, from: source, to: target, branch_group: choice, bind: {value: value}, when_budget: {budget: quota, state: exhausted}}`;
		const body = "## task\nTask\n";
		expect(paths(issues(yaml, body))).toEqual([]);
		expect(paths(issues(yaml.replace("state: exhausted", "state: available"), body))).toContain(
			"/edges/1/bind/value",
		);
		expect(
			paths(issues(yaml.replace("budget: quota, state: exhausted", "budget: missing, state: exhausted"), body)),
		).toContain("/edges/1/when_budget/budget");
	});

	it("locates explicit binding conflicts and preserves pointer escaping and array indices", () => {
		const found = paths(
			issues(
				`members: {}
nodes:
  'a/b': {task: '#task', consume: [null, missing], outputs: {out: {}}}
  target: {task: '#task', inputs: {'x~y': {text: existing}}}
edges:
  - {id: e, from: 'a/b', to: target, on: [null, missing], bind: {'x~y': out}}`,
				"## task\nTask\n",
			),
		);
		expect(found).toContain("/nodes/a~1b/consume/1");
		expect(found).toContain("/edges/0/on/1");
		expect(found).toContain("/edges/0/bind/x~0y");
	});

	it("does not allow an unrelated loop declaration to hide an implicit cycle", () => {
		const found = paths(
			issues(
				`members: {}
nodes:
  a: {task: '#task'}
  b: {task: '#task'}
  final: {task: '#task'}
loops:
  review: {retry_target: b, final_node: final, count_nodes: [a], final_outcomes: {go: done, hold: done}, scope: stage, stage: draft}
edges:
  - {id: e, from: a, to: b}
  - {id: f, from: b, to: a, loop: review}`,
				"## task\nTask\n",
			),
		);
		expect(found).toContain("/edges/1/loop");
		expect(found).toContain("/edges/1");
	});

	it("rejects a labeled loop whose return path bypasses the count node", () => {
		const found = paths(
			issues(
				`members: {}
nodes:
  a: {task: '#task'}
  b: {task: '#task'}
  review: {task: '#task'}
  final: {task: '#task', outcomes: [go, hold]}
loops:
  l: {retry_target: a, final_node: final, count_nodes: [review], final_outcomes: {go: go, hold: hold}, scope: stage, stage: draft}
edges:
  - {id: forward, from: a, to: b}
  - {id: back, from: b, to: a, loop: l}`,
				"## task\nTask\n",
			),
		);
		expect(found).toContain("/edges/1/loop");
	});

	it("does not throw on malformed nested structures", () => {
		expect(() =>
			issues("members: {x: []}\nnodes: {x: []}\nedges: [null, 5]\nloops: {x: []}\ncommunications: [null]"),
		).not.toThrow();
	});
});

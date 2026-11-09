import { describe, expect, it } from "bun:test";
import { validateGraphDefinition, validateGraphForStart } from "../src/graph/definition";

const limits = { maxBytes: 16384, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };

describe("Graph definition validation", () => {
	it("accepts an empty draft without fabricating tasks", () => {
		const content = "---\nformat: omp.graph/v1\nname: draft\nmembers: {}\nnodes: {}\n---\n";
		const result = validateGraphDefinition(content, limits);
		expect(result.issues).toEqual([]);
		expect(result.source.source).toBe(content);
		expect(validateGraphForStart(content, limits).issues.map(issue => issue.message)).toEqual(["missing_entry"]);
	});

	it("accepts a valid ordinary entry for start validation", () => {
		const content =
			"---\nformat: omp.graph/v1\nname: work\nmembers: {}\nnodes:\n  task: {kind: human, task: '#task'}\n---\n## task\nDecide.\n";
		expect(validateGraphForStart(content, limits).issues).toEqual([]);
	});

	it("rejects approval bindings for undeclared outcomes or missing required outcomes", () => {
		const content = `---
format: omp.graph/v1
name: approval
members: {}
nodes:
  review:
    kind: human
    task: '#task'
    outcomes: [approve, hold]
    outputs: {plan: {media_type: text/plain, required: true}}
    approved_outputs: {plan: {input: draft, on: [approve, typo]}}
---
## task
Approve?
`;
		const messages = validateGraphDefinition(content, limits).issues.map(issue => issue.message);
		expect(messages).toContain("Unknown outcome 'typo'");
		expect(messages).toContain("Required output must be available for every outcome");
	});

	it("rejects an edge that requests an approval artifact on a non-approving outcome", () => {
		const content = `---
format: omp.graph/v1
name: approval
members: {}
nodes:
  review:
    kind: human
    task: '#task'
    outcomes: [approve, hold]
    outputs: {plan: {media_type: text/plain, required: false}}
    approved_outputs: {plan: {input: draft, on: [approve]}}
  next: {kind: human, task: '#task'}
edges:
  - {id: next, from: review, to: next, on: [approve, hold], bind: {draft: plan}}
---
## task
Approve?
`;
		expect(validateGraphDefinition(content, limits).issues.map(issue => issue.message)).toContain(
			"Human output 'plan' is not available for every routed outcome",
		);
	});

	it("identifies the location of a missing edge target", () => {
		const content = `---
format: omp.graph/v1
name: draft
members: {}
nodes:
  first: {kind: program, executor: test, task: '#task'}
edges:
  - id: missing
    from: first
    to: absent
---
## task
Do the work.
`;
		const issue = validateGraphDefinition(content, limits).issues.find(item => item.path === "/edges/0/to");
		expect(issue?.location).toEqual({ file: "GRAPH.md", path: "/edges/0/to", line: 10, column: 9 });
	});
	it("locates invalid fields under numeric-looking mapping keys", () => {
		const content = `---
format: omp.graph/v1
name: draft
members: {}
nodes:
  "123":
    kind: invalid
    task: '#task'
---
## task
Decide.
`;
		const issue = validateGraphDefinition(content, limits).issues.find(item => item.path === "/nodes/123/kind");
		expect(issue?.location).toEqual({ file: "GRAPH.md", path: "/nodes/123/kind", line: 7, column: 11 });
	});
	it("rejects ambiguous shared final sources even without final bindings", () => {
		const content = `---
format: omp.graph/v1
name: loops
members: {}
nodes:
  review: {kind: human, task: '#task'}
  other-review: {kind: human, task: '#task'}
  final: {kind: human, task: '#task', outcomes: [go, hold]}
  other-final: {kind: human, task: '#task', outcomes: [go, hold]}
loops:
  first: {max_reviews: 1, final_node: final, retry_target: review, final_outcomes: {go: go, hold: hold}, count_nodes: [review], scope: stage, stage: draft}
  second: {max_reviews: 1, final_node: final, retry_target: other-review, final_outcomes: {go: go, hold: hold}, count_nodes: [other-review], scope: stage, stage: draft}
---
## task
Review.
`;
		expect(validateGraphDefinition(content, limits).issues).toEqual([]);
		const ambiguous = content.replace("count_nodes: [other-review]", "count_nodes: [review]");
		const result = validateGraphDefinition(ambiguous, limits);
		expect(result.issues.map(issue => issue.path)).toContain("/loops/second/count_nodes/0");
		expect(result.issues.find(issue => issue.path === "/loops/second/count_nodes/0")?.location.line).toBe(12);
		expect(validateGraphForStart(ambiguous, limits).issues.map(issue => issue.path)).toContain(
			"/loops/second/count_nodes/0",
		);
		expect(
			validateGraphDefinition(
				ambiguous.replace(
					"second: {max_reviews: 1, final_node: final",
					"second: {max_reviews: 1, final_node: other-final",
				),
				limits,
			).issues,
		).toEqual([]);
	});
});

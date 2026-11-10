import { describe, expect, it } from "bun:test";
import { validateGraphForStart } from "../src/graph/definition";

const limits = { maxBytes: 100_000, maxDepth: 50, maxAliases: 100, maxNodes: 10_000 };

// These are isolated C1 validation examples, not runnable versions of the llmwiki workflows.
// In particular they do not represent their entry selection, authorization or full handoffs.
const developmentReview = `---
format: omp.graph/v1
name: development-review-fragment
members:
  author:
    role: '#author-role'
    model: spec-binding
    base: isolated
    duty: spec
    permissions: {read: [], write: [], execute: []}
  reviewer:
    role: '#reviewer-role'
    model: review-binding
    base: isolated
    duty: review
    permissions: {read: [], write: [], execute: []}
  coder:
    role: '#coder-role'
    model: code-binding
    base: omp-default
    duty: code-only
    permissions: {read: [], write: [], execute: []}
nodes:
  spec:
    kind: bot
    member: author
    task: '#spec-task'
    outputs: {document: {media_type: text/plain, required: true}}
  review:
    kind: bot
    member: reviewer
    task: '#review-task'
    required_inputs: [document]
    outcomes: [pass, revise]
  final:
    kind: bot
    member: reviewer
    task: '#final-task'
    outcomes: [go, hold]
    terminal: {hold: hold}
  implement:
    kind: subgraph
    member: coder
    task: '#implement-task'
    child_policy: {kinds: [bot], max_nodes: 8, max_parallel: 1}
    consume: [implementation-attempts]
    on_budget_exhausted: hold
loops:
  reviews:
    max_reviews: 3
    final_node: final
    retry_target: spec
    final_outcomes: {go: go, hold: hold}
    count_nodes: [review]
    scope: cycle
    cycle_start: spec
    reset_from: []
budgets:
  implementation-attempts: {limit: 2, scope: run}
edges:
  - {id: review-spec, from: spec, to: review, bind: {document: document}}
  - {id: revise-spec, from: review, to: spec, on: [revise], loop: reviews}
  - {id: pass, from: review, to: implement, on: [pass]}
  - {id: final-go, from: final, to: implement, on: [go]}
---
## author-role
Write the specification.
## reviewer-role
Independently review the specification.
## coder-role
Implement within the authorized scope.
## spec-task
Produce the current specification.
## review-task
Review the bound specification.
## final-task
Adjudicate the current specification without modifying it.
## implement-task
Create authorized implementation tasks.
`;

const writingReview = `---
format: omp.graph/v1
name: writing-review-fragment
members:
  reviewer:
    role: '#reviewer-role'
    model: review-binding
    base: isolated
    duty: review
    permissions: {read: [], write: [], execute: []}
  writer:
    role: '#writer-role'
    model: writing-binding
    base: isolated
    duty: general
    permissions: {read: [], write: [], execute: []}
nodes:
  review:
    kind: bot
    member: reviewer
    task: '#review-task'
    verdicts: [PASS, CONDITIONAL, FAIL, INSUFFICIENT_EVIDENCE]
    outcomes: [CONTINUE, TARGETED_DESIGN, HOLD]
    decisions:
      - {verdict: PASS, outcome: CONTINUE}
      - {verdict: CONDITIONAL, outcome: CONTINUE}
      - {verdict: FAIL, outcome: TARGETED_DESIGN}
      - {verdict: INSUFFICIENT_EVIDENCE, outcome: HOLD}
    terminal: {CONTINUE: succeed, HOLD: hold}
  revise:
    kind: bot
    member: writer
    task: '#revise-task'
    consume: [revisions]
    on_budget_exhausted: hold
  final:
    kind: bot
    member: reviewer
    task: '#final-task'
    outcomes: [go, hold]
    terminal: {go: succeed, hold: hold}
loops:
  draft-review:
    max_reviews: 3
    final_node: final
    retry_target: review
    final_outcomes: {go: go, hold: hold}
    count_nodes: [review]
    scope: stage
    stage: draft
budgets:
  revisions: {limit: 6, scope: run}
edges:
  - {id: need-revision, from: review, to: revise, on: [TARGETED_DESIGN]}
  - {id: re-review, from: revise, to: review, loop: draft-review}
---
## reviewer-role
Review without rewriting.
## writer-role
Revise only within authorization.
## review-task
Report a verdict and an allowed next action.
## revise-task
Revise the current draft.
## final-task
Adjudicate the current draft without rewriting it.
`;

const issuePaths = (content: string) => validateGraphForStart(content, limits).issues.map(issue => issue.path);

describe("C1 workflow fragment validation", () => {
	it("accepts a bounded review and implementation fragment and rejects broken handoffs", () => {
		expect(issuePaths(developmentReview)).toEqual([]);
		expect(
			issuePaths(developmentReview.replace("bind: {document: document}", "bind: {document: missing}")),
		).toContain("/edges/0/bind/document");
		expect(issuePaths(developmentReview.replace("loop: reviews", "loop: missing"))).toContain("/edges/1/loop");
		expect(issuePaths(developmentReview.replace("base: omp-default", "base: isolated"))).toContain(
			"/members/coder/base",
		);
	});

	it("accepts separate verdicts and actions with stage review and run revision limits", () => {
		expect(issuePaths(writingReview)).toEqual([]);
		expect(
			issuePaths(
				writingReview.replace("verdict: FAIL, outcome: TARGETED_DESIGN", "verdict: FAIL, outcome: UNKNOWN"),
			),
		).toContain("/nodes/review/decisions/2/outcome");
		expect(issuePaths(writingReview.replace("consume: [revisions]", "consume: [missing]"))).toContain(
			"/nodes/revise/consume/0",
		);
		expect(issuePaths(writingReview.replace(", loop: draft-review", ""))).toContain("/edges/1");
	});
});

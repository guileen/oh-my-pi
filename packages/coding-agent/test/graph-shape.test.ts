import { describe, expect, it } from "bun:test";
import { validateGraphShape } from "../src/graph/shape";
import { parseGraphSource } from "../src/graph/source";

const limits = { maxBytes: 100_000, maxDepth: 40, maxAliases: 100, maxNodes: 5000 };
const validate = (metadata: string) => validateGraphShape(parseGraphSource(`---\n${metadata}\n---\n`, limits));
const draft = "format: omp.graph/v1\nname: draft\nmembers: {}\nnodes: {}";
const paths = (metadata: string) => validate(metadata).map(issue => issue.path);

describe("Graph definition shape", () => {
	it("accepts an empty draft without changing the source", () => {
		const source = parseGraphSource(`---\n${draft}\n---\n`, limits);
		const before = source.source;
		expect(validateGraphShape(source)).toEqual([]);
		expect(source.source).toBe(before);
		expect(source.frontmatter.frontmatter).toEqual({ format: "omp.graph/v1", name: "draft", members: {}, nodes: {} });
	});

	it("validates loop final binding as a key-to-key map", () => {
		const base = `${draft}\nloops: {l: {max_reviews: 1, final_node: final, retry_target: review, final_outcomes: {go: go, hold: hold}, count_nodes: [review], scope: stage, stage: draft, final_bind: VALUE}}`;
		expect(paths(base.replace("VALUE", "{assessment: report}"))).toEqual([]);
		expect(paths(base.replace("VALUE", "[]"))).toContain("/loops/l/final_bind");
		expect(paths(base.replace("VALUE", "{Bad: 3}"))).toContain("/loops/l/final_bind/Bad");
	});

	it("accepts all standard object shapes and explicit defaults", () => {
		const metadata = `format: omp.graph/v1
name: complete
members:
  reviewer:
    role: '#role'
    model: user-binding
    base: isolated
    duty: review
    permissions: {read: [artifacts], write: [], execute: []}
    skills: [{id: skill-id, digest: 'sha256:abc'}]
  coder:
    bot: {id: bot-id, digest: 'sha256:def'}
    model: arbitrary-model
    base: omp-default
    duty: code-only
    permissions: {read: [], write: [], execute: []}
nodes:
  review:
    kind: bot
    member: reviewer
    task: '#review'
    inputs: {prompt: {text: ''}, file: {artifact: {id: artifact, digest: hash}}, task: {run_input: task}}
    required_inputs: [prompt]
    outputs: {report: {media_type: text/plain, required: true, schema_ref: {id: schema, digest: hash}}}
    outcomes: [approved, revise]
    join: any
    retry: {max_attempts: 1}
    timeout_ms: 1000
    writes: [report]
    consume: [attempts]
    on_budget_exhausted: hold
    verdicts: [pass, fail]
    terminal: {approved: succeed, revise: hold}
    required_gate: true
    decisions: [{verdict: pass, outcome: approved}]
  command:
    kind: program
    executor: registered
    task: '#command'
    parameters: {message: hello, count: 1, enabled: true, file: {id: file, digest: hash}}
  queued: {kind: queue, executor: registered, task: '#queued'}
  approval: {kind: human, task: '#approval'}
  child:
    kind: subgraph
    member: coder
    task: '#child'
    child_policy: {kinds: [bot, program, queue, human], max_nodes: 32, max_parallel: 1}
edges:
  - {id: next, from: review, to: command, on: [approved], bind: {prompt: report}, branch_group: branch, when_budget: {budget: attempts, state: available}}
communications:
  - {from: reviewer, to: coder, when: '#consult', artifacts: [report], max_rounds: 1, timeout_ms: 1000}
loops:
  reviews: {max_reviews: 3, final_node: approval, retry_target: review, final_outcomes: {go: approved, hold: revise}, count_nodes: [review], scope: cycle, cycle_start: review, reset_from: [command]}
  stage-loop: {max_reviews: 1, final_node: approval, retry_target: review, final_outcomes: {go: yes, hold: no}, count_nodes: [], scope: stage, stage: writing}
budgets:
  attempts: {limit: 2, scope: run}
  cycle-budget: {limit: 1, scope: cycle, loop: reviews}
  stage-budget: {limit: 1, scope: stage, stage: writing}
policy: {max_parallel: 1, max_child_nodes: 32, max_consultation_rounds: 6, consultation_timeout_ms: 600000, cost_limit: '0.50', currency: USD}
extensions: {x-example: {arbitrary: [null, true, 42]}}`;
		expect(validate(metadata)).toEqual([]);
	});

	it("validates budget condition fields and enum", () => {
		const edge = `${draft}\nedges:\n  - {id: e, from: a, to: b, when_budget: {budget: quota, state: wrong, extra: 1}}`;
		expect(paths(edge)).toEqual(expect.arrayContaining(["/edges/0/when_budget/state", "/edges/0/when_budget/extra"]));
		expect(paths(edge.replace("{budget: quota, state: wrong, extra: 1}", "{}"))).toEqual(
			expect.arrayContaining(["/edges/0/when_budget/budget", "/edges/0/when_budget/state"]),
		);
	});

	it("reports missing and unknown fields with escaped JSON pointers", () => {
		expect(paths("format: omp.graph/v1\nname: test\nmembers: {}\nnodes: {}\n'bad/key~': true")).toContain(
			"/bad~1key~0",
		);
		expect(paths("format: omp.graph/v1\nname: test\nmembers: {}\nnodes: {broken: {kind: bot}}")).toEqual(
			expect.arrayContaining(["/nodes/broken/task", "/nodes/broken/member"]),
		);
		expect(paths("format: omp.graph/v1\nname: test\nmembers: {}\nnodes: {}\nextensions: {bad: 1}")).toContain(
			"/extensions/bad",
		);
	});

	it("rejects bad variants, nulls, enums, nested fields and bounds", () => {
		const invalid = `format: omp.graph/v1
name: Wrong_Name
members:
  m: {role: '#role', bot: {id: a, digest: b}, model: null, base: isolated, duty: code-only, permissions: {read: [], write: [], execute: [], extra: true}}
nodes:
  n:
    kind: program
    task: task
    member: m
    executor: ''
    retry: {max_attempts: 0}
    inputs: {x: {text: ok, run_input: x}}
    outputs: {x: {media_type: text/plain, required: null}}
    join: some
    parameters: {bad: [1]}
    child_policy: {kinds: [subgraph], max_nodes: -1, max_parallel: 0}
edges: [{id: e, from: n, to: n, surprise: true}]
communications: [{from: m, to: m, when: '#w', max_rounds: 0}]
loops: {l: {max_reviews: 0, final_node: n, retry_target: n, final_outcomes: {go: yes}, count_nodes: [], scope: cycle}}
budgets: {b: {limit: 0, scope: stage}}
policy: {max_parallel: 0, cost_limit: '1.0'}`;
		expect(paths(invalid)).toEqual(
			expect.arrayContaining([
				"/name",
				"/members/m",
				"/members/m/model",
				"/members/m/base",
				"/members/m/permissions/extra",
				"/nodes/n/task",
				"/nodes/n/member",
				"/nodes/n/executor",
				"/nodes/n/retry/max_attempts",
				"/nodes/n/inputs/x",
				"/nodes/n/outputs/x/required",
				"/nodes/n/join",
				"/nodes/n/parameters/bad",
				"/nodes/n/child_policy",
				"/nodes/n/child_policy/kinds/0",
				"/nodes/n/child_policy/max_nodes",
				"/edges/0/surprise",
				"/communications/0/max_rounds",
				"/loops/l/max_reviews",
				"/loops/l/final_outcomes/hold",
				"/loops/l/cycle_start",
				"/loops/l/reset_from",
				"/budgets/b/limit",
				"/budgets/b/stage",
				"/policy/max_parallel",
				"/policy/currency",
			]),
		);
	});
});

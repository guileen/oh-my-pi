import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLocalDispatchPolicy } from "../src/graph/dispatch";
import { GRAPH_CLI_LIMITS } from "../src/graph/limits";
import { GraphRunStore } from "../src/graph/store";

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SAMPLE = `---
format: omp.graph/v1
name: dispatch-sample
members:
  first: {role: '#role', model: model, base: omp-default, duty: general, permissions: {read: [], write: [], execute: []}}
  second: {role: '#role', model: model, base: omp-default, duty: general, permissions: {read: [], write: [], execute: []}}
nodes:
  one: {kind: bot, member: first, task: '#task', inputs: {brief: {run_input: task}}, required_inputs: [brief], outputs: {draft: {media_type: text/markdown, required: true}}}
  two: {kind: bot, member: second, task: '#task', outputs: {final: {media_type: text/markdown, required: true}}}
edges:
  - {id: next, from: one, to: two, bind: {draft: draft}}
---
## role
Work.
## task
Do it.
`;

interface Fixture {
	root: string;
	cwd: string;
	graphId: string;
	imported: (content: string, key: string) => string;
}

function fixture(): Fixture {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "graph-dispatch-"));
	roots.push(base);
	const root = path.join(base, "profile");
	const cwd = path.join(base, "workspace");
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(cwd, "models.md"), "---\nmodels: {}\n---\n");
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const imported = (content: string, key: string): string => {
		const result = store.definitions.mutate({
			version: 1,
			request_key: key,
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		if (!result.target_id) throw new Error(result.error?.message ?? "import failed");
		return result.target_id;
	};
	const graphId = imported(SAMPLE, "import-sample");
	closers.push(() => store.close());
	return { root, cwd, graphId, imported };
}

const request = (graphId: string, overrides: Record<string, unknown> = {}) => ({
	request_key: "dispatch-1",
	graph_id: graphId,
	title: "Dispatch sample",
	bindings: "models.md",
	inputs: { task: "Write the thing." },
	max_model_calls: 2,
	timeout_ms: 30_000,
	...overrides,
});

/** Test seam standing in for the detached CLI: it reports the Run id the runner prints. */
function spawnReporting(argv: string[][], runId: string | null, exitCode: number | null) {
	return (command: readonly string[], options: { stdout?: number | "inherit" | "ignore" }) => {
		argv.push([...command]);
		if (runId !== null && typeof options.stdout === "number") fs.writeSync(options.stdout, `Run: ${runId}\n`);
		return { exitCode, kill() {} } as unknown as ReturnType<typeof Bun.spawn>;
	};
}

function policyFor(target: Fixture, argv: string[][], runId: string | null = "run-1") {
	return createLocalDispatchPolicy({
		root: target.root,
		cwd: target.cwd,
		command: ["omp"],
		spawn: spawnReporting(argv, runId, null) as unknown as typeof Bun.spawn,
	});
}

async function failureCode(action: Promise<unknown>): Promise<string> {
	try {
		await action;
	} catch (error) {
		return (error as { code?: string }).code ?? "none";
	}
	throw new Error("Expected dispatch to fail");
}

describe("local dispatch policy", () => {
	it("starts a detached Run, forwards the bounds, and cleans staged inputs", async () => {
		const target = fixture();
		const argv: string[][] = [];
		const result = await policyFor(target, argv).dispatch({
			...request(target.graphId),
			report_to: "wherdr:session",
		});
		expect(result.run_id).toBe("run-1");
		expect(result.request_key).toBe("dispatch-1");
		const launched = argv[0]!;
		expect(launched.slice(0, 3)).toEqual(["omp", "graph", "run"]);
		for (const flag of ["--title", "--report-to", "--request-key", "--input", "--max-model-calls"]) {
			expect(launched).toContain(flag);
		}
		expect(launched).toContain("Dispatch sample");
		expect(fs.readFileSync(result.log_path, "utf8")).toContain("Run: run-1");
		expect(fs.readdirSync(path.dirname(result.log_path))).toEqual(["dispatch.log"]);
	});

	it("refuses calls the policy cannot bound", async () => {
		const target = fixture();
		const policy = policyFor(target, []);
		expect(await failureCode(policy.dispatch(request(target.graphId, { max_model_calls: 17 })))).toBe(
			"resource_limit",
		);
		expect(await failureCode(policy.dispatch(request(target.graphId, { timeout_ms: 0 })))).toBe("resource_limit");
		expect(await failureCode(policy.dispatch(request(target.graphId, { bindings: "../outside.md" })))).toBe(
			"permission_denied",
		);
		expect(await failureCode(policy.dispatch(request("missing-graph")))).toBe("definition_invalid");
		expect(await failureCode(policy.dispatch(request(target.graphId, { title: "  " })))).toBe("definition_invalid");
	});

	it("takes the input set from the Graph contract", async () => {
		const target = fixture();
		const argv: string[][] = [];
		const policy = policyFor(target, argv);
		// Unknown names would silently drop the brief, so they fail before a child is spawned.
		expect(await failureCode(policy.dispatch(request(target.graphId, { inputs: { brief: "x" } })))).toBe(
			"definition_invalid",
		);
		expect(argv).toHaveLength(0);
		// A declared-but-absent required input is the same failure.
		expect(await failureCode(policy.dispatch(request(target.graphId, { inputs: {} })))).toBe("definition_invalid");
		expect(argv).toHaveLength(0);
	});

	it("requires a Bot address to name a mailbox", async () => {
		const target = fixture();
		const argv: string[][] = [];
		const policy = policyFor(target, argv);
		// A malformed `bot:` address would be undeliverable, so it fails before a child is spawned.
		for (const report_to of ["bot:Orchestrator", "bot:", "bot:two words"]) {
			expect(await failureCode(policy.dispatch(request(target.graphId, { report_to })))).toBe("definition_invalid");
		}
		expect(argv).toHaveLength(0);
		// A non-`bot:` label stays an opaque observer label.
		const forwarded = await policy.dispatch(request(target.graphId, { report_to: "bot:orchestrator" }));
		expect(forwarded.run_id).toBe("run-1");
		expect(argv[0]).toContain("--report-to");
		expect(argv[0]).toContain("bot:orchestrator");
	});

	it("dispatches a Graph that declares no inputs", async () => {
		const target = fixture();
		// The sample's first node reads a Run input; inlining it removes every declared input.
		const content = SAMPLE.replace(
			"inputs: {brief: {run_input: task}}, required_inputs: [brief], ",
			"inputs: {brief: {text: 'Inline brief.'}}, ",
		).replace("name: dispatch-sample", "name: no-inputs");
		const graphId = target.imported(content, "import-no-inputs");
		const argv: string[][] = [];
		const result = await policyFor(target, argv).dispatch(request(graphId, { inputs: {} }));
		expect(result.run_id).toBe("run-1");
		expect(argv[0]).not.toContain("--input");
	});

	it("refuses a Graph that needs capabilities this runner does not have", async () => {
		const target = fixture();
		const content = fs.readFileSync(
			new URL("../examples/graph/requirement-development/GRAPH.md", import.meta.url),
			"utf8",
		);
		const graphId = target.imported(content, "import-unsupported");
		expect(await failureCode(policyFor(target, []).dispatch(request(graphId)))).toBe("capability_unavailable");
	});

	it("reports a failed launch instead of inventing a Run id", async () => {
		const target = fixture();
		const argv: string[] = [];
		const policy = createLocalDispatchPolicy({
			root: target.root,
			cwd: target.cwd,
			command: ["omp"],
			spawn: ((command: readonly string[], options: { stdout?: number | "inherit" | "ignore" }) => {
				argv.push(...command);
				if (typeof options.stdout === "number") fs.writeSync(options.stdout, "boom: model unavailable\n");
				return { exitCode: 1, kill() {} } as unknown as ReturnType<typeof Bun.spawn>;
			}) as unknown as typeof Bun.spawn,
		});
		expect(await failureCode(policy.dispatch(request(target.graphId)))).toBe("internal_error");
	});
});

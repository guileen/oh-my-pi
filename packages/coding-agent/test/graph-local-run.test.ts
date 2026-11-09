import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import { GraphRunStore, type GraphStartRequest } from "../src/graph/store";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(permissions = "{read: [], write: [], execute: []}", policy = "") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-local-admission-"));
	roots.push(root);
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content: `---
format: omp.graph/v1
name: local-admission
members:
  author:
    role: '#role'
    model: binding
    base: omp-default
    duty: general
    permissions: ${permissions}
nodes:
  first:
    kind: bot
    member: author
    task: '#task'
    outputs: {text: {media_type: text/plain, required: true}}
  second:
    kind: bot
    member: author
    task: '#task'
    required_inputs: [previous]
    outputs: {text: {media_type: text/plain, required: true}}
edges:
  - {id: next, from: first, to: second, bind: {previous: text}}
${policy}
---
## role
Write concise text.
## task
Respond to the supplied task.
`,
		},
	});
	if (imported.error || !imported.target_id) throw new Error(JSON.stringify(imported));
	const graph = imported.target_id;
	store.close();
	const bindings = path.join(root, "models.md");
	await Bun.write(
		bindings,
		"---\nmodels:\n  binding: {provider: unavailable-provider, model: unavailable-model}\n---\n",
	);
	async function run(flags = ["--max-model-calls", "4", "--timeout-ms", "10000"]) {
		let stderr = "";
		const code = await runGraphCommand(["run", graph, "--bindings", bindings, "--request-key", "start", ...flags], {
			root,
			out: () => {},
			err: text => {
				stderr += text;
			},
		});
		const read = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		try {
			expect(read.definitions.requestGetAuthorized("start", () => true)).toBeNull();
		} finally {
			read.close();
		}
		return { code, stderr };
	}
	return { run, root, graph, bindings };
}

it("refuses ambient file and process grants before model resolution or Run creation", async () => {
	const f = await fixture("{read: ['**'], write: ['**'], execute: ['shell']}");
	const result = await f.run();
	expect(result.code).toBe(3);
	expect(result.stderr).toContain("execute grant");
});

it("refuses a monetary ceiling it cannot enforce rather than silently running without it", async () => {
	const f = await fixture(undefined, "policy: {cost_limit: '1', currency: USD}");
	const result = await f.run();
	expect(result.code).toBe(3);
	expect(result.stderr).toContain("monetary");
});

it("requires an explicit call ceiling instead of starting a potentially unbounded Run", async () => {
	const f = await fixture();
	const result = await f.run(["--timeout-ms", "10000"]);
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("--max-model-calls");
});

async function runInputFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-local-input-"));
	roots.push(root);
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content: `---
format: omp.graph/v1
name: local-inputs
members:
  author:
    role: '#role'
    model: binding
    base: omp-default
    duty: general
    permissions: {read: [], write: [], execute: []}
nodes:
  first:
    kind: bot
    member: author
    task: '#task'
    inputs: {brief: {run_input: task}, notes: {run_input: notes}}
    required_inputs: [brief]
    outputs: {text: {media_type: text/plain, required: true}}
  second:
    kind: bot
    member: author
    task: '#task'
    required_inputs: [previous]
    outputs: {text: {media_type: text/plain, required: true}}
edges:
  - {id: next, from: first, to: second, bind: {previous: text}}
---
## role
Write concise text.
## task
Respond to the supplied task.
`,
		},
	});
	if (imported.error || !imported.target_id) throw new Error(JSON.stringify(imported));
	const graph = imported.target_id;
	store.close();
	const bindings = path.join(root, "models.md");
	await Bun.write(
		bindings,
		"---\nmodels:\n  binding: {provider: unavailable-provider, model: unavailable-model}\n---\n",
	);
	const brief = path.join(root, "brief.md");
	await Bun.write(brief, "# Brief\n\nShip the smallest slice.\n");
	const notes = path.join(root, "notes.md");
	await Bun.write(notes, "# Notes\n\nSecond input.\n");
	async function run(flags: string[]) {
		let stderr = "";
		const code = await runGraphCommand(
			[
				"run",
				graph,
				"--bindings",
				bindings,
				"--request-key",
				"start",
				"--max-model-calls",
				"4",
				"--timeout-ms",
				"10000",
				...flags,
			],
			{ root, out: () => {}, err: text => (stderr += text) },
		);
		return { code, stderr };
	}
	return { run, brief, notes, graph, root };
}

it("names the missing run input before any model work", async () => {
	const f = await runInputFixture();
	const result = await f.run([]);
	expect(result.code).toBe(3);
	expect(result.stderr).toContain("--input task=FILE");
});

it("accepts a run input file and proceeds past admission", async () => {
	const f = await runInputFixture();
	const result = await f.run(["--input", `task=${f.brief}`, "--input", `notes=${f.notes}`]);
	expect(result.stderr).not.toContain("--input task=FILE");
	expect(result.stderr).toContain("unavailable");
});

it("rejects an unknown input name before freezing bytes or resolving a model", async () => {
	const f = await runInputFixture();
	const result = await f.run(["--input", `task=${f.brief}`, "--input", `nope=${f.brief}`]);
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("Graph does not accept input: nope");
	expect(result.stderr).toContain("accepts task, notes");
	expect(result.stderr).not.toContain("unavailable");
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
	try {
		const request: GraphStartRequest = {
			version: 1,
			operation: "start",
			request_key: "start",
			target_id: f.graph,
			if_revision: "",
			payload: { inputs: {}, authorization_ref: { id: "", digest: "" } },
		};
		expect(store.getStartReceipt(request)).toBeNull();
	} finally {
		store.close();
	}
});

it("binds multiple declared run inputs", async () => {
	const f = await runInputFixture();
	const result = await f.run(["--input", `task=${f.brief}`, "--input", `notes=${f.notes}`]);
	expect(result.stderr).not.toContain("requires --input");
	expect(result.stderr).toContain("unavailable");
});

it("waits for a live local host and fails without committing a Run when the wait expires", async () => {
	const f = await fixture();
	const hold = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
	try {
		expect(hold.claimHost()).not.toBeNull();
		let stdout = "";
		const started = Date.now();
		const code = await runGraphCommand(
			[
				"run",
				f.graph,
				"--bindings",
				f.bindings,
				"--request-key",
				"wait-for-host",
				"--max-model-calls",
				"4",
				"--timeout-ms",
				"10000",
				"--wait-for-host",
				"600",
			],
			{ root: f.root, out: text => (stdout += text), err: () => {} },
		);
		expect(code).toBe(3);
		expect(stdout).toContain("Waiting for the local Graph host");
		expect(Date.now() - started).toBeGreaterThanOrEqual(500);
		const read = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		try {
			expect(read.definitions.requestGetAuthorized("wait-for-host", () => true)).toBeNull();
		} finally {
			read.close();
		}
	} finally {
		hold.close();
	}
});

it("names the owning graph when a dispatch reuses a key reserved for another graph", async () => {
	const f = await fixture();
	const owner = "00000000-0000-4000-8000-000000000000";
	const db = new Database(path.join(f.root, "graphs.sqlite"));
	try {
		db.query("INSERT INTO graph_requests(request_key,canonical,result) VALUES(?,?,?)").run(
			"collide",
			JSON.stringify({
				version: 1,
				operation: "start",
				request_key: "collide",
				target_id: owner,
				if_revision: "1",
				payload: {},
			}),
			JSON.stringify({ state: "accepted" }),
		);
	} finally {
		db.close();
	}
	let stderr = "";
	const code = await runGraphCommand(
		[
			"run",
			f.graph,
			"--bindings",
			f.bindings,
			"--request-key",
			"collide",
			"--max-model-calls",
			"4",
			"--timeout-ms",
			"10000",
		],
		{ root: f.root, out: () => {}, err: text => (stderr += text) },
	);
	expect(code).toBe(2);
	expect(stderr).toContain(`already belongs to start on graph ${owner}`);
	expect(stderr).not.toContain("permission_denied");
});

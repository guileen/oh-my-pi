import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commands } from "../src/cli-commands";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import { GraphRunStore, type GraphLifecyclePolicy } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-cli-"));
	roots.push(root);
	const files = new Map<string, string>();
	async function run(...args: string[]) {
		let stdout = "";
		let stderr = "";
		const code = await runGraphCommand(args, {
			root,
			readInput: file => {
				const content = files.get(file);
				if (content === undefined) throw new Error("missing");
				return content;
			},
			writeOutput: (file, content) => {
				files.set(file, content);
			},
			out: text => {
				stdout += text;
			},
			err: text => {
				stderr += text;
			},
		});
		return { code, stdout, stderr };
	}
	return { run, files, root };
}

describe("graph CLI", () => {
	it("registers the command and creates a recoverable receipt", async () => {
		expect(commands.some(command => command.name === "graph")).toBe(true);
		const { run } = setup();
		const result = await run("create", "guide");
		expect(result.code).toBe(0);
		const key = /^Request: (.+)$/m.exec(result.stdout)![1];
		const graph = /^Graph: (.+)$/m.exec(result.stdout)![1];
		expect((await run("request", "get", key)).stdout).toContain(`Graph: ${graph}`);
		expect((await run("validate", graph)).stdout).toContain("State: valid");
	});

	it("imports, edits with CAS, exports exact bytes and replays request keys", async () => {
		const { run, files } = setup();
		const content = "---\nformat: omp.graph/v1\nname: guide\nmembers: {}\nnodes: {}\n---\n\nOriginal.\n";
		files.set("-", content);
		const imported = await run("import", "--file", "-", "--request-key", "import-1");
		expect(imported.code).toBe(0);
		const graph = /^Graph: (.+)$/m.exec(imported.stdout)![1];
		expect((await run("import", "--file", "-", "--request-key", "import-1")).stdout).toBe(imported.stdout);
		expect((await run("export", graph, "--output", "out.md")).code).toBe(0);
		expect(files.get("out.md")).toBe(content);
		files.set("edit.md", `${content}\nChanged.\n`);
		expect(
			(await run("edit", graph, "--file", "edit.md", "--if-revision", "1", "--request-key", "edit-1")).code,
		).toBe(0);
		const conflict = await run("edit", graph, "--file", "edit.md", "--if-revision", "1", "--request-key", "edit-2");
		expect(conflict.code).toBe(2);
		expect(conflict.stdout).toContain("revision_conflict");
		expect((await run("request", "get", "edit-2")).stdout).toContain("revision_conflict");
	});

	it("rejects malformed file bytes and oversized input without changing the imported definition", async () => {
		const { root } = setup();
		const content = "---\nformat: omp.graph/v1\nname: unicode\nmembers: {}\nnodes: {}\n---\n方案\r\n";
		const file = path.join(root, "GRAPH.md");
		const limits = { ...GRAPH_CLI_LIMITS, maxBytes: Buffer.byteLength(content, "utf8") };
		let output = "";
		const invoke = (action: string, key: string, graph?: string) => {
			output = "";
			return runGraphCommand(
				[action, ...(graph ? [graph, "--if-revision", "1"] : []), "--file", file, "--request-key", key],
				{
					root,
					limits,
					out: text => {
						output += text;
					},
					err: text => {
						output += text;
					},
				},
			);
		};
		await Bun.write(file, content);
		expect(await invoke("import", "exact-limit")).toBe(0);
		const graph = /^Graph: (.+)$/m.exec(output)![1];
		await Bun.write(file, `${content}x`);
		expect(await invoke("edit", "over-limit", graph)).toBe(3);
		expect(output).toContain("resource_limit");
		await Bun.write(file, Buffer.concat([Buffer.from(content.slice(0, -4)), Buffer.from([0xff])]));
		expect(await invoke("edit", "invalid-utf8", graph)).toBe(2);
		expect(output).toContain("definition_invalid");
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		try {
			expect(store.definitions.get(graph)?.content).toBe(content);
			expect(store.definitions.get(graph)?.revision).toBe("1");
		} finally {
			store.close();
		}
	});

	it("accepts Markdown subobjects and rejects unsupported execution", async () => {
		const { run, files } = setup();
		const created = await run("create", "guide", "--request-key", "create");
		const graph = /^Graph: (.+)$/m.exec(created.stdout)![1];
		files.set("node.md", "---\nkind: human\ntask: '#question'\n---\nWhat next?\n");
		const added = await run(
			"node",
			"add",
			graph,
			"question",
			"--file",
			"node.md",
			"--if-revision",
			"1",
			"--request-key",
			"node",
		);
		expect(added.code).toBe(0);
		expect((await run("export", graph)).stdout).toContain("## question\nWhat next?");
		expect((await run("preview", graph, "--format", "mermaid")).code).toBe(0);
		const start = await run("start", graph);
		expect(start.code).toBe(3);
		expect(start.stderr).toContain("trusted preflight");
	});

	it("requires trusted observation authorization and checks it again during watch", async () => {
		const { root, run } = setup();
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: review\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "private-authorization", digest: "sha256:test" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref,
				inputs: {},
				members: {},
				executors: {},
			},
		);
		expect(started.state).toBe("accepted");
		const runId = started.target_id!;
		store.close();

		const denied = await run("status", runId);
		expect(denied.code).toBe(3);
		expect(denied.stdout).toBe("");
		expect(denied.stderr).toContain("authorization is not configured");
		let stdout = "";
		let stderr = "";
		const output = {
			out: (text: string) => {
				stdout += text;
			},
			err: (text: string) => {
				stderr += text;
			},
		};
		expect(await runGraphCommand(["status", runId], { root, ...output, authorizeRunObservation: () => false })).toBe(
			3,
		);
		expect(stdout).toBe("");
		expect(stderr).toContain("permission_denied");
		stderr = "";
		expect(
			await runGraphCommand(["status", runId], { root, ...output, authorizeRunObservation: id => id === runId }),
		).toBe(0);
		expect(stdout).toContain(`Run: ${runId}`);
		expect(stdout).toContain("State: queued");
		expect(stdout).not.toContain("private-authorization");
		stdout = "";
		let checks = 0;
		expect(
			await runGraphCommand(["watch", runId], { root, ...output, authorizeRunObservation: () => ++checks === 1 }),
		).toBe(3);
		expect(stdout).toContain("State: queued");
		expect(stderr).toContain("permission_denied");
		stdout = "";
		stderr = "";
		checks = 0;
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			const code = await runGraphCommand(["watch", runId], {
				root,
				...output,
				authorizeRunObservation: () => {
					if (++checks === 2) {
						db.transaction(() => {
							const row = db.query("SELECT data FROM graph_runs WHERE id=?").get(runId) as { data: string };
							const record = JSON.parse(row.data);
							record.state = "succeeded";
							record.revision = "2";
							const journal = db.query("SELECT journal_id FROM graph_journals WHERE run_id=?").get(runId) as {
								journal_id: string;
							};
							db.query("UPDATE graph_runs SET revision=?,data=? WHERE id=?").run(
								"2",
								JSON.stringify(record),
								runId,
							);
							db.query("INSERT INTO graph_events VALUES (?,2,?)").run(
								journal.journal_id,
								JSON.stringify({
									type: "run.succeeded",
									run_id: runId,
									revision: "2",
									at: record.updated_at,
									secret: "private",
								}),
							);
							db.query("UPDATE graph_journals SET seq=2 WHERE run_id=?").run(runId);
						})();
					}
					return true;
				},
			});
			expect(code).toBe(0);
			expect(stdout).toContain("Event: run.succeeded");
			expect(stdout).toContain("State: succeeded");
			expect(stdout).not.toContain("private");
			stdout = "";
			const journal = db.query("SELECT journal_id FROM graph_journals WHERE run_id=?").get(runId) as {
				journal_id: string;
			};
			expect(
				await runGraphCommand(["watch", runId, "--since", `${journal.journal_id}:1`], {
					root,
					...output,
					authorizeRunObservation: () => true,
				}),
			).toBe(0);
			expect(stdout).toContain("Event: run.succeeded");
			expect(
				await runGraphCommand(["watch", runId, "--since", "other:2"], {
					root,
					...output,
					authorizeRunObservation: () => true,
				}),
			).not.toBe(0);
		} finally {
			db.close();
		}
	});

	it("authorizes lifecycle changes and replays receipts before revision checks", async () => {
		const { root, run } = setup();
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: review\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "auth", digest: "sha256:test" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref,
				inputs: {},
				members: {},
				executors: {},
			},
		);
		const runId = started.target_id!;
		store.close();
		let stdout = "";
		const policy: GraphLifecyclePolicy = {
			authorize: (principal: string) => principal === "operator",
			verifyResume: (_principal, request) =>
				"decision_ref" in request.payload && request.payload.decision_ref.id === "approved",
		};
		const invoke = (args: string[], principal = "operator") => {
			stdout = "";
			return runGraphCommand(args, {
				root,
				lifecycle: { principal, policy },
				out: text => {
					stdout += text;
				},
				err: () => {},
			});
		};
		const hold = ["hold", runId, "--request-key", "hold-1", "--if-revision", "1"];
		expect(await invoke(hold, "intruder")).toBe(3);
		expect(await invoke(hold)).toBe(0);
		expect(stdout).toContain(`Run: ${runId}`);
		expect((await run("request", "get", "hold-1")).code).toBe(3);
		expect(await invoke(hold)).toBe(0);
		expect(
			await invoke([
				"resume",
				runId,
				"--request-key",
				"resume-denied",
				"--if-revision",
				"2",
				"--decision-ref",
				"other@sha256:test",
			]),
		).toBe(3);
		expect(stdout).toContain("gate_unsatisfied");
		expect(
			await invoke([
				"resume",
				runId,
				"--request-key",
				"resume-ok",
				"--if-revision",
				"2",
				"--decision-ref",
				"approved@sha256:test",
			]),
		).toBe(0);
		const check = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		expect(check.getRun(runId)?.state).toBe("running");
		check.close();
	});

	it("lists definitions and Run indexes, and gates the Run index on host authorization", async () => {
		const { run, files, root } = setup();
		files.set(
			"-",
			"---\nformat: omp.graph/v1\nname: guide\nmembers:\n  writer: {role: '#role', model: m, base: omp-default, duty: general, permissions: {read: [], write: [], execute: []}}\nnodes:\n  write:\n    kind: bot\n    member: writer\n    task: '#task'\n    inputs: {brief: {run_input: task}}\n    outputs: {draft: {media_type: text/markdown, required: true}}\n---\n## role\nWrite.\n\n## task\nWrite.\n",
		);
		const imported = await run("import", "--file", "-", "--request-key", "import-list");
		expect(imported.code).toBe(0);
		const graphId = /^Graph: (.+)$/m.exec(imported.stdout)![1];

		const listed = await run("list", "--format", "json");
		expect(listed.code).toBe(0);
		const catalog = JSON.parse(listed.stdout);
		expect(catalog.format).toBe("omp.graph/catalog/v1");
		expect(catalog.entries[0]).toMatchObject({
			graph_id: graphId,
			name: "guide",
			contract_source: "derived",
			inputs: [{ name: "task" }],
		});

		files.set(
			"-",
			"---\nformat: omp.graph/v1\nname: approval\nmembers: {}\nnodes:\n  decide: {kind: human, task: '#decide'}\n---\n## decide\nDecide.\n",
		);
		const human = await run("import", "--file", "-", "--request-key", "import-index");
		expect(human.code).toBe(0);
		const humanId = /^Graph: (.+)$/m.exec(human.stdout)![1];

		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const definition = store.definitions.get(humanId)!;
		const authorization_ref = { id: "private-authorization", digest: "sha256:test" };
		const started = store.start(
			{
				version: 1,
				request_key: "start-index",
				operation: "start",
				target_id: humanId,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref },
			},
			{
				graph_id: humanId,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref,
				inputs: {},
				members: {},
				executors: {},
			},
		);
		store.close();
		expect(started.state).toBe("accepted");
		const runId = started.target_id!;

		let stdout = "";
		const output = {
			out: (text: string) => {
				stdout += text;
			},
			err: () => {},
		};
		expect(await runGraphCommand(["runs"], { root, ...output })).toBe(3);
		stdout = "";
		expect(
			await runGraphCommand(["runs", "--format", "json"], {
				root,
				...output,
				authorizeRunObservation: id => id === runId,
			}),
		).toBe(0);
		const index = JSON.parse(stdout);
		expect(index.format).toBe("omp.graph/run-index/v1");
		expect(index.runs.map((entry: { run_id: string }) => entry.run_id)).toEqual([runId]);
		expect(index.runs[0].stalled).toBe(false);
		expect(index.runs[0]).not.toHaveProperty("authorization_ref");
	});

	it("separates operator pauses from decision gates for the local profile owner", async () => {
		const { root } = setup();
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: pause\nmembers: {}\nnodes:\n  work: {kind: program, executor: test, task: '#work'}\n---\n## work\nWork.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "auth", digest: "sha256:test" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref,
				inputs: {},
				members: {},
				executors: { test: authorization_ref },
			},
		);
		const runId = started.target_id!;
		store.close();
		let stdout = "";
		const invoke = (args: string[]) => {
			stdout = "";
			return runGraphCommand(args, {
				root,
				allowLocalLifecycle: true,
				out: text => {
					stdout += text;
				},
				err: () => {},
			});
		};
		expect(await invoke(["hold", runId, "--request-key", "pause-1", "--if-revision", "1", "--reason", "focus"])).toBe(
			0,
		);
		expect(stdout).toContain(`Run: ${runId}`);
		const paused = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const held = paused.getRun(runId)!;
		expect([held.state, held.hold_kind, held.held_by]).toEqual(["held", "operator", "local-user"]);
		paused.close();

		expect(await invoke(["resume", runId, "--request-key", "resume-1", "--if-revision", "2"])).toBe(0);
		const resumed = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		expect(resumed.getRun(runId)?.state).toBe("running");
		expect(resumed.getRun(runId)?.hold_kind).toBeUndefined();
		resumed.close();

		expect(
			await invoke([
				"hold",
				runId,
				"--request-key",
				"gate-1",
				"--if-revision",
				"3",
				"--reason",
				"approval",
				"--kind",
				"gate",
			]),
		).toBe(0);
		const gated = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		expect([gated.getRun(runId)?.state, gated.getRun(runId)?.hold_kind]).toEqual(["held", "gate"]);
		gated.close();

		expect(await invoke(["resume", runId, "--request-key", "resume-gate", "--if-revision", "4"])).toBe(3);
		expect(stdout).toContain("gate_unsatisfied");
		expect(
			await invoke([
				"resume",
				runId,
				"--request-key",
				"resume-gate-ref",
				"--if-revision",
				"4",
				"--decision-ref",
				"approved@sha256:test",
			]),
		).toBe(3);
		expect(
			await invoke([
				"resume",
				runId,
				"--request-key",
				"resume-gate-kind",
				"--if-revision",
				"4",
				"--decision-ref",
				"approved@sha256:test",
				"--kind",
				"gate",
			]),
		).toBe(2);
		const stillHeld = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		expect(stillHeld.getRun(runId)?.state).toBe("held");
		stillHeld.close();
	});

	it("fails closed for lifecycle mutations", async () => {
		const { run } = setup();
		for (const action of ["hold", "resume", "cancel"]) {
			const result = await run(action, "run-1", "--request-key", action, "--if-revision", "1");
			expect(result.code).toBe(3);
			expect(result.stderr).toContain("capability_unavailable");
		}
	});
});

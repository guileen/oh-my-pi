import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphRunStore } from "../src/graph/store";
import { SMOKE_TEST_TIMEOUT_MS } from "../src/subprocess/worker-client";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it(
	"projects a frozen Run and its actual scheduler state without protected references",
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-observer-"));
		roots.push(root);
		const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
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
		const runId = started.target_id!;
		store.close();
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		child.stdin.write(JSON.stringify({ run_id: runId }));
		child.stdin.end();
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		const snapshot = JSON.parse(output);
		expect(snapshot.run.id).toBe(runId);
		expect(snapshot.nodes).toEqual([{ id: "approval", kind: "human", member: null }]);
		expect(snapshot.invocations[0]).toMatchObject({ node: "approval", state: "pending" });
		expect(output).not.toContain("private-authorization");
		const history = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		history.stdin.write(JSON.stringify({ run_id: runId, history: { limit: 1 } }));
		history.stdin.end();
		const historyOutput = await new Response(history.stdout).text();
		expect(await history.exited).toBe(0);
		const page = JSON.parse(historyOutput);
		expect(page.views).toHaveLength(1);
		expect(page.views[0].run.id).toBe(runId);
		expect(historyOutput).not.toContain("private-authorization");
		const negotiation = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		negotiation.stdin.write(JSON.stringify({ run_id: runId, extensions: ["graph.execution.v1"] }));
		negotiation.stdin.end();
		const negotiationOutput = await new Response(negotiation.stdout).text();
		expect(await negotiation.exited).toBe(0);
		expect(JSON.parse(negotiationOutput)).toEqual({ extensions: [] });
		const bad = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		bad.stdin.write(JSON.stringify({ run_id: runId, history: { limit: 1, command: "/bin/sh" } }));
		bad.stdin.end();
		expect(await bad.exited).not.toBe(0);
	},
	SMOKE_TEST_TIMEOUT_MS,
);

it(
	"separates evidenced consultation executions and rejects a mismatched message",
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-observer-consult-"));
		roots.push(root);
		const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: review\nmembers:\n  reviewer: {role: '#role', model: model, base: isolated, duty: review, permissions: {read: [], write: [], execute: []}}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## role\nReview.\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const ref = { id: "auth", digest: "sha256:test" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref: ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref: ref,
				inputs: {},
				members: {
					reviewer: {
						provider: "provider",
						model: "model",
						configuration_revision: "1",
						base: "isolated",
						base_snapshot_ref: ref,
						role_ref: ref,
						skill_refs: [],
						rule_refs: [],
					},
				},
				executors: {},
			},
		);
		const runId = started.target_id!;
		const schedule = store.getScheduleState(runId)!;
		schedule.invocations.push({
			id: "consult-inv",
			node: "consultation:reviewer",
			state: "running",
			iteration: 0,
			scope_id: "run",
			upstream: {},
			attempt_id: "attempt",
			consultation: { conversation_id: "conversation", message_id: "message", member_id: "reviewer" },
		});
		store.close();
		const db = new Database(path.join(root, "graphs.sqlite"));
		db.exec(
			"CREATE TABLE consultations (id TEXT PRIMARY KEY, run_id TEXT, data TEXT); CREATE TABLE consultation_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, message_id TEXT, data TEXT);",
		);
		db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(schedule), runId);
		db.query("INSERT INTO consultations VALUES (?,?,?)").run(
			"conversation",
			runId,
			JSON.stringify({ id: "conversation", run_id: runId }),
		);
		db.query("INSERT INTO consultation_messages (conversation_id, message_id, data) VALUES (?,?,?)").run(
			"conversation",
			"message",
			JSON.stringify({ conversation_id: "conversation", message_id: "message", recipient_member: "reviewer" }),
		);
		async function observe() {
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root],
				{
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			child.stdin.write(JSON.stringify({ run_id: runId }));
			child.stdin.end();
			return { output: await new Response(child.stdout).text(), exit: await child.exited };
		}
		const result = await observe();
		expect(result.exit).toBe(0);
		const projection = JSON.parse(result.output);
		expect(projection.nodes.map((item: { id: string }) => item.id)).toEqual(["approval"]);
		expect(projection.invocations.find((item: { id: string }) => item.id === "consult-inv")).toMatchObject({
			kind: "consultation",
			node: null,
			member: "reviewer",
		});
		db.query("UPDATE consultation_messages SET data=? WHERE message_id=?").run(
			JSON.stringify({ conversation_id: "conversation", message_id: "message", recipient_member: "other" }),
			"message",
		);
		const denied = await observe();
		expect(denied.exit).not.toBe(0);
		expect(denied.output).toBe("");
		db.close();
	},
	SMOKE_TEST_TIMEOUT_MS,
);

it(
	"resolves an agent directory to its nested graph data directory and refuses an ambiguous root",
	async () => {
		const agent = fs.mkdtempSync(path.join(os.tmpdir(), "graph-agentdir-"));
		roots.push(agent);
		const graphRoot = path.join(agent, "graphs");
		const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, graphRoot);
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
		const runId = started.target_id!;
		store.close();
		async function observe(root: string) {
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root],
				{
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			child.stdin.write(JSON.stringify({ run_id: runId }));
			child.stdin.end();
			return {
				output: await new Response(child.stdout).text(),
				error: await new Response(child.stderr).text(),
				exit: await child.exited,
			};
		}
		const nested = await observe(agent);
		expect(nested.exit).toBe(0);
		expect(JSON.parse(nested.output).run.id).toBe(runId);
		fs.writeFileSync(path.join(agent, "graphs.sqlite"), "");
		const ambiguous = await observe(agent);
		expect(ambiguous.exit).not.toBe(0);
		expect(ambiguous.output).toBe("");
		expect(ambiguous.error).toContain("ambiguous_root");
		const explicit = await observe(graphRoot);
		expect(explicit.exit).toBe(0);
		expect(JSON.parse(explicit.output).run.id).toBe(runId);
	},
	SMOKE_TEST_TIMEOUT_MS,
);

it(
	"serves a bounded deliverable report and rejects ambiguous requests",
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-observer-report-"));
		roots.push(root);
		const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: report\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\nextensions:\n  x-contract:\n    summary: A readable hand-off.\n    experience: Open the artifact.\n    deliverable:\n      artifacts: [draft]\n      summary: A readable hand-off.\n      experience: Open the artifact.\n    outputs:\n      draft: {node: approval, output: draft, media_type: text/markdown}\n---\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const ref = { id: "private-authorization", digest: "sha256:test" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref: ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref: ref,
				inputs: {},
				members: {},
				executors: {},
			},
		);
		const runId = started.target_id!;
		store.close();
		const observe = async (input: unknown) => {
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root],
				{
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			child.stdin.write(JSON.stringify(input));
			child.stdin.end();
			return { output: await new Response(child.stdout).text(), exit: await child.exited };
		};
		const ok = await observe({ run_id: runId, report: { preview_lines: 2, notification_limit: 3 } });
		expect(ok.exit).toBe(0);
		const report = JSON.parse(ok.output).report;
		expect(report.format).toBe("omp.graph/report/v1");
		expect(report.run_id).toBe(runId);
		expect(report.title).toBe(null);
		expect(report.deliverable).toMatchObject({ summary: "A readable hand-off.", experience: "Open the artifact." });
		expect(report.deliverable.ready).toBe(false);
		expect(report.deliverable.missing).toEqual(["draft"]);
		expect(Array.isArray(report.artifacts)).toBe(true);
		expect(Array.isArray(report.next_actions)).toBe(true);
		expect(ok.output).not.toContain("private-authorization");
		expect((await observe({ run_id: runId, report: { preview_chars: 0 } })).exit).not.toBe(0);
		expect((await observe({ run_id: runId, report: { notification_limit: 51 } })).exit).not.toBe(0);
		expect((await observe({ run_id: runId, report: {}, history: {} })).exit).not.toBe(0);
		expect((await observe({ run_id: runId, report: { command: "/bin/sh" } })).exit).not.toBe(0);
	},
	SMOKE_TEST_TIMEOUT_MS,
);

it(
	"exposes only the newest start descriptor reference and rejects malformed descriptor requests",
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-observer-descriptor-"));
		roots.push(root);
		const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: descriptor\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref: { id: "private-authorization", digest: "sha256:test" } },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref: { id: "private-authorization", digest: "sha256:test" },
				inputs: {},
				members: {},
				executors: {},
			},
		);
		const runId = started.target_id!;
		const descriptors = store.configureStartDescriptors({
			principal: "observer-test",
			maxBytes: 4096,
			authorizeArtifact: async () => true,
			authorizeTarget: async () => true,
		});
		const published = await descriptors.publish({
			request_key: "d1",
			graph_id: definition.graph_id,
			content: JSON.stringify({ title: "first", bindings: "models.md" }),
		});
		store.close();
		const observe = (input: unknown) => {
			const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			child.stdin.write(JSON.stringify(input));
			child.stdin.end();
			return child;
		};
		const ok = observe({ run_id: runId, descriptor: true });
		const okOutput = await new Response(ok.stdout).text();
		expect(await ok.exited).toBe(0);
		expect(JSON.parse(okOutput)).toEqual({
			start_descriptor: {
				id: published.descriptor_ref!.id,
				digest: published.descriptor_ref!.digest,
				created_at: expect.any(String),
			},
		});
		expect(okOutput).not.toContain("private-authorization");
		const bogus = observe({ run_id: runId, descriptor: "yes" });
		expect(await bogus.exited).not.toBe(0);
		const both = observe({ run_id: runId, descriptor: true, history: { limit: 1 } });
		expect(await both.exited).not.toBe(0);
	},
	SMOKE_TEST_TIMEOUT_MS,
);

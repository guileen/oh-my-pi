import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphWireMutation } from "@oh-my-pi/pi-wire/graph";
import { GraphArtifactRegistry, type ArtifactPublication } from "../src/graph/artifacts";
import {
	createGraphWireAuthorWorker,
	parseGraphWireAuthorLauncher,
	type GraphWireAuthorWorker,
} from "../src/graph/author-worker";
import { GRAPH_CLI_LIMITS } from "../src/graph/limits";
import { GraphRunStore } from "../src/graph/store";

const SOURCE = "browser-1";
const roots: string[] = [];
const stores: GraphRunStore[] = [];
const workers: GraphWireAuthorWorker[] = [];
const registries: GraphArtifactRegistry[] = [];

afterEach(() => {
	for (const worker of workers.splice(0)) worker.close();
	for (const registry of registries.splice(0)) registry.close();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const TEXT_GRAPH = `---
format: omp.graph/v1
name: author-worker-fixture
members:
  author:
    role: '#author-role'
    model: author
    base: omp-default
    duty: general
    permissions: {read: [], write: [], execute: []}
  reviewer:
    role: '#reviewer-role'
    model: reviewer
    base: omp-default
    duty: review
    permissions: {read: [], write: [], execute: []}
nodes:
  plan:
    kind: bot
    member: author
    task: '#plan-task'
    inputs:
      task:
        run_input: task
    required_inputs: [task]
    outputs: {plan: {media_type: text/markdown, required: true}}
  review:
    kind: bot
    member: reviewer
    task: '#review-task'
    required_inputs: [plan]
    outputs: {review: {media_type: text/markdown, required: true}}
edges:
  - {id: plan-review, from: plan, to: review, bind: {plan: plan}}
---
## author-role

Write the plan.
## reviewer-role

Review the plan.
## plan-task

Plan the work.
## review-task

Review the work.
`;

const LIFECYCLE_GRAPH = `---
format: omp.graph/v1
name: author-worker-lifecycle
members: {}
nodes:
  work: {kind: program, executor: test, task: '#work'}
---
## work

Work.
`;

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-author-worker-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	fs.mkdirSync(workspace, { recursive: true });
	fs.writeFileSync(path.join(workspace, "models.md"), "author: openai-codex/gpt-6.1-terra\n");
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	stores.push(store);
	const registry = new GraphArtifactRegistry({
		root,
		maxBytes: 1024 * 1024,
		authorize: () => Promise.resolve(true),
	});
	registries.push(registry);
	return { root, workspace, store, registry };
}

const PUBLICATION: ArtifactPublication = {
	media_type: "text/markdown",
	producer_attempt_id: "attempt-1",
	source_ref: null,
	access_scope: [],
};

async function publishArtifact(
	registry: GraphArtifactRegistry,
	content: string,
	mediaType: string,
): Promise<{ id: string; digest: string }> {
	const publication = { ...PUBLICATION, media_type: mediaType };
	const artifact = await registry.store.publish("local-user", Buffer.from(content), publication);
	await registry.register([{ artifact, expected: publication }]);
	return { id: artifact.id, digest: artifact.digest };
}

function workerFor(config: {
	root: string;
	workspace: string;
	spawn?: typeof Bun.spawn;
	command?: readonly string[];
}): GraphWireAuthorWorker {
	const worker = createGraphWireAuthorWorker({
		root: config.root,
		source_id: SOURCE,
		workspace: config.workspace,
		now: () => 1_000_000,
		...(config.spawn ? { spawn: config.spawn } : {}),
		...(config.command ? { command: config.command } : {}),
	});
	workers.push(worker);
	return worker;
}

const mutation = (patch: Partial<GraphWireMutation>): GraphWireMutation => ({
	version: 1,
	request_key: "intent",
	operation: "start",
	target_id: null,
	if_revision: null,
	payload: {},
	...patch,
});

describe("graph wire author worker", () => {
	it("mints an execute-only grant and latches the first author frame", () => {
		const { root, workspace } = setup();
		const worker = workerFor({ root, workspace });
		const before = worker.options.authorize("local-user", SOURCE)!;
		expect(before).toMatchObject({
			mode: "live",
			source_ready: true,
			can_author: false,
			can_execute: true,
			graph_ids: null,
			authorized_at: 999_000,
			expires_at: 1_055_000,
			subscription_id: "local",
			scope_id: "local",
		});
		expect(worker.options.authorize("mallory", SOURCE)).toBeNull();
		expect(worker.options.authorize("local-user", "other-source")).toBeNull();

		worker.options.observeRequest!({
			type: "graph.author",
			subscription_id: "sub-1",
			scope_id: "scope-1",
		});
		expect(worker.options.authorize("local-user", SOURCE)).toMatchObject({
			subscription_id: "sub-1",
			scope_id: "scope-1",
		});
		// Later frames must not retarget an established connection.
		worker.options.observeRequest!({
			type: "graph.author",
			subscription_id: "sub-2",
			scope_id: "scope-2",
		});
		expect(worker.options.authorize("local-user", SOURCE)).toMatchObject({ subscription_id: "sub-1" });
		// Non-author frames never latch.
		const fresh = workerFor({ root, workspace });
		fresh.options.observeRequest!({ type: "graph.definition.get", subscription_id: "sub-9", scope_id: "scope-9" });
		expect(fresh.options.authorize("local-user", SOURCE)).toMatchObject({ subscription_id: "local" });
	});

	it("starts a Run through the local dispatch policy from the descriptor artifact", async () => {
		const { root, workspace, store, registry } = setup();
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content: TEXT_GRAPH },
		});
		const graphId = imported.target_id!;
		const descriptor = await publishArtifact(
			registry,
			JSON.stringify({ title: "Worker run", bindings: "models.md", max_model_calls: 2, timeout_ms: 60_000 }),
			"application/json",
		);
		const input = await publishArtifact(registry, "Ship it.", "text/markdown");

		const argv: string[][] = [];
		const spawn = ((command: readonly string[], options: { stdout?: number | "pipe" }) => {
			argv.push([...command]);
			if (typeof options.stdout === "number") fs.writeSync(options.stdout, "Run: run-1\n");
			return { exitCode: 0, kill() {} };
		}) as unknown as typeof Bun.spawn;
		const worker = workerFor({ root, workspace, spawn, command: ["omp"] });

		const result = await worker.options.execution!.apply(
			"local-user",
			SOURCE,
			"intent-start",
			mutation({
				request_key: "intent-start",
				target_id: graphId,
				payload: {
					authorization_ref: descriptor,
					inputs: { task: input },
				},
			}),
		);
		expect(result).toMatchObject({
			request_key: "intent-start",
			state: "accepted",
			target_id: "run-1",
			revision: null,
			result_ref: null,
			error: null,
		});
		const call = argv[0]!;
		expect(call.slice(0, 4)).toEqual(["omp", "graph", "run", graphId]);
		expect(call).toContain("--bindings");
		expect(call[call.indexOf("--max-model-calls") + 1]).toBe("2");
		expect(call[call.indexOf("--timeout-ms") + 1]).toBe("60000");
		expect(call[call.indexOf("--title") + 1]).toBe("Worker run");
		expect(call[call.indexOf("--input") + 1]).toMatch(/^task=.*task\.md$/);
	});

	it("refuses entry-node selection, resume, and foreign principals", async () => {
		const { root, workspace, store } = setup();
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content: TEXT_GRAPH },
		});
		const graphId = imported.target_id!;
		const worker = workerFor({ root, workspace });
		const execute = worker.options.execution!;

		await expect(
			execute.apply(
				"local-user",
				SOURCE,
				"intent-entry",
				mutation({ target_id: graphId, payload: { entry_nodes: ["plan"] } }),
			),
		).rejects.toMatchObject({ code: "capability_unavailable" });
		await expect(
			execute.apply("local-user", SOURCE, "intent-resume", mutation({ operation: "resume", target_id: graphId })),
		).rejects.toMatchObject({ code: "capability_unavailable" });
		await expect(
			execute.apply("mallory", SOURCE, "intent-foreign", mutation({ target_id: graphId })),
		).rejects.toMatchObject({ code: "scope_denied" });
		expect(execute.reconcile("mallory", SOURCE, "intent-start")).toBeNull();
	});

	it("holds and cancels a real Run, then reconciles the receipt", async () => {
		const { root, workspace, store } = setup();
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content: LIFECYCLE_GRAPH },
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const auth = { id: "auth", digest: "sha256:auth" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref: auth },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref: auth,
				inputs: {},
				members: {},
				executors: { test: auth },
			},
		);
		const runId = started.target_id!;
		const worker = workerFor({ root, workspace });
		const execute = worker.options.execution!;

		const held = await execute.apply(
			"local-user",
			SOURCE,
			"intent-hold",
			mutation({
				request_key: "intent-hold",
				operation: "hold",
				target_id: runId,
				if_revision: store.getRun(runId)!.revision,
				payload: { reason: "operator pause" },
			}),
		);
		expect(held.state).toBe("completed");
		expect(store.getRun(runId)!.state).toBe("held");

		const cancelled = await execute.apply(
			"local-user",
			SOURCE,
			"intent-cancel",
			mutation({
				request_key: "intent-cancel",
				operation: "cancel",
				target_id: runId,
				if_revision: store.getRun(runId)!.revision,
				payload: { reason: "done" },
			}),
		);
		expect(cancelled.state).toBe("completed");
		expect(store.getRun(runId)!.state).toBe("cancelled");

		expect(execute.reconcile("local-user", SOURCE, "intent-hold")).toMatchObject({
			request_key: "intent-hold",
			state: "completed",
			target_id: runId,
		});
		expect(execute.reconcile("local-user", SOURCE, "intent-missing")).toBeNull();
		// A definition intent is not a Run-control receipt.
		expect(execute.reconcile("local-user", SOURCE, "import")).toBeNull();
	});

	it("rejects a malformed launcher configuration", () => {
		expect(parseGraphWireAuthorLauncher(["/root", "source", "/workspace"])).toEqual({
			root: path.resolve("/root"),
			source_id: "source",
			workspace: path.resolve("/workspace"),
		});
		expect(() => parseGraphWireAuthorLauncher(["/root", "source"])).toThrow("Invalid launcher configuration");
		expect(() => parseGraphWireAuthorLauncher(["/root", "source", "/workspace", "extra"])).toThrow(
			"Invalid launcher configuration",
		);
		expect(() => parseGraphWireAuthorLauncher(["--flag", "source", "/workspace"])).toThrow(
			"Invalid launcher configuration",
		);
	});
});

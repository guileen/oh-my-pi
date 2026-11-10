import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_WIRE_EXECUTION_EXTENSION, GRAPH_WIRE_PROTOCOL } from "@oh-my-pi/pi-wire/graph";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { GraphAuthoringService, type GraphOperation } from "../src/graph/authoring";
import {
	GraphWireAuthoringBridge,
	type GraphWireAuthoringFrame,
	type GraphWireAuthoringGrant,
	type GraphWireAuthoringOptions,
	type GraphWireExecutionService,
} from "../src/graph/wire-authoring";
import {
	GRAPH_WIRE_AUTHORING_STDIO_LIMITS,
	serveGraphWireAuthoringStdio,
	type GraphWireAuthoringStdioOptions,
} from "../src/graph/wire-authoring-stdio";

const stores: GraphAuthoringService[] = [];
const roots: string[] = [];
const connections: { abort: AbortController; task: Promise<void> }[] = [];
afterEach(async () => {
	for (const connection of connections.splice(0)) {
		connection.abort.abort();
		await connection.task.catch(() => {});
	}
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup(principal = "alice", enabled = true) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-wire-author-"));
	roots.push(root);
	const store = new GraphAuthoringService(
		{ maxBytes: 200 * 1024, maxDepth: 40, maxAliases: 100, maxNodes: 10000 },
		root,
	);
	stores.push(store);
	let now = 1_000;
	let grant: GraphWireAuthoringGrant | null = {
		generation: "permission-1",
		source_binding: "deployment-1",
		subscription_id: "subscription-1",
		scope_id: "scope-1",
		mode: "live",
		source_ready: true,
		can_author: true,
		can_execute: true,
		graph_ids: null,
		authorized_at: now,
		expires_at: now + 60_000,
	};
	let check = 0;
	let beforeAuthorize: ((count: number) => void) | undefined;
	const options = (identity = principal): GraphWireAuthoringOptions => ({
		principal_id: identity,
		sources: [
			{
				source_id: "graph-source",
				binding: "deployment-1",
				definitions: store,
				capabilities: [GRAPH_WIRE_EXECUTION_EXTENSION],
			},
		],
		extensions: enabled ? [GRAPH_WIRE_EXECUTION_EXTENSION] : [],
		now: () => now,
		authorize: () => {
			beforeAuthorize?.(++check);
			return grant;
		},
	});
	const createBridge = (identity = principal) => new GraphWireAuthoringBridge(options(identity));
	return {
		root,
		store,
		options,
		bridge: createBridge(),
		createBridge,
		get grant(): GraphWireAuthoringGrant {
			return grant!;
		},
		set grant(value: GraphWireAuthoringGrant | null) {
			grant = value;
		},
		advance: (value: number) => {
			now += value;
		},
		onAuthorize: (callback: (count: number) => void) => {
			beforeAuthorize = callback;
		},
	};
}
function create(intent = "create-intent", key = "create-key") {
	return {
		protocol: GRAPH_WIRE_PROTOCOL,
		type: "graph.author" as const,
		message_id: "message-1",
		subscription_id: "subscription-1",
		scope_id: "scope-1",
		intent_id: intent,
		source_id: "graph-source",
		request: {
			version: 1 as const,
			request_key: key,
			operation: "create" as const,
			target_id: null,
			if_revision: null,
			payload: { name: "requirement-development" },
		},
	};
}
function lookup(intent = "create-intent") {
	return { protocol: GRAPH_WIRE_PROTOCOL, type: "request.get", message_id: "lookup-1", intent_id: intent };
}
function read(graphId: string, revision: string | null = null) {
	return {
		protocol: GRAPH_WIRE_PROTOCOL,
		type: "graph.definition.get",
		message_id: "definition-1",
		source_id: "graph-source",
		graph_id: graphId,
		definition_revision: revision,
	};
}
/** Definition and read requests take the synchronous fast path; a Promise here is a defect. */
function sync(bridge: GraphWireAuthoringBridge, request: unknown): GraphWireAuthoringFrame {
	const frame = bridge.handle(request);
	if (frame instanceof Promise) throw new Error("expected a synchronous Graph authoring frame");
	return frame;
}
/** Run control always crosses the serialized queue, so its replies resolve asynchronously. */
function control(
	operation: "start" | "hold" | "resume" | "cancel",
	key = `${operation}-key`,
	intent = `${operation}-intent`,
) {
	const payload =
		operation === "start"
			? { inputs: {}, authorization_ref: { id: "authorization-1", digest: "authorization-digest-1" } }
			: operation === "resume"
				? { decision_ref: { id: "decision-1", digest: "decision-digest-1" } }
				: { reason: `${operation} requested by the operator` };
	return {
		protocol: GRAPH_WIRE_PROTOCOL,
		type: "graph.author" as const,
		message_id: `${intent}-message`,
		subscription_id: "subscription-1",
		scope_id: "scope-1",
		intent_id: intent,
		source_id: "graph-source",
		request: {
			version: 1 as const,
			request_key: key,
			operation,
			target_id: "graph-1",
			if_revision: "1",
			payload,
		},
	};
}
function accepted(key = "start-key"): GraphOperation {
	return {
		request_key: key,
		state: "accepted",
		target_id: "graph-1",
		revision: null,
		result_ref: null,
		error: null,
	};
}
const deferred = () => Promise.withResolvers<void>();

describe("scoped Graph wire authoring", () => {
	it("replays the same business intent after scope rotation without creating a second draft", () => {
		const f = setup();
		const submitted = sync(f.bridge, create());
		if (submitted.type !== "graph.author.result") throw new Error(JSON.stringify(submitted));
		expect(submitted.operation.state).toBe("completed");
		const graphId = submitted.operation.target_id!;
		f.grant = { ...f.grant, generation: "permission-2", subscription_id: "subscription-2", scope_id: "scope-2" };
		const replay = sync(f.bridge, {
			...create(),
			message_id: "message-2",
			subscription_id: "subscription-2",
			scope_id: "scope-2",
		});
		if (replay.type !== "graph.author.result") throw new Error(JSON.stringify(replay));
		expect(replay.operation).toEqual(submitted.operation);
		const definition = sync(f.bridge, read(graphId));
		expect(definition).toMatchObject({
			type: "graph.definition",
			graph_id: graphId,
			definition_revision: "1",
			editable: true,
		});
	});

	it("reconciles an existing intent while source-unready/history but never admits another mutation", () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		f.grant = { ...f.grant, source_ready: false };
		expect(sync(f.bridge, lookup())).toMatchObject({
			type: "operation",
			state: "applied",
			graph_operation: initial.operation,
		});
		expect(sync(f.bridge, create("second", "second"))).toMatchObject({
			type: "error",
			error: { code: "invalid_state", details: { reason: "source_not_ready" } },
		});
		expect(f.store.getIntent("alice", "second")).toBeNull();
		f.grant = { ...f.grant, mode: "history" };
		expect(sync(f.bridge, lookup())).toMatchObject({ type: "operation", graph_operation: initial.operation });
		expect(sync(f.bridge, create("third", "third"))).toMatchObject({
			type: "error",
			error: { details: { reason: "history_read_only" } },
		});
	});

	it("rejects a changed original intent and preserves its first receipt", () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		const changed = create();
		changed.request.payload.name = "another graph";
		expect(sync(f.bridge, changed)).toMatchObject({ type: "error", error: { code: "idempotency_conflict" } });
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		expect(sync(f.bridge, lookup())).toMatchObject({ type: "operation", graph_operation: initial.operation });
	});

	it("recovers the rejected intent, not another mutation that owns its request key", () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		const conflicting = create("conflicting-intent");
		conflicting.request.payload.name = "another-graph";
		const rejected = sync(f.bridge, conflicting);
		if (rejected.type !== "graph.author.result") throw new Error(JSON.stringify(rejected));
		expect(rejected.operation).toMatchObject({
			state: "rejected",
			error: { code: "idempotency_conflict" },
		});
		f.grant = { ...f.grant, mode: "history", source_ready: false };
		expect(sync(f.createBridge(), lookup("conflicting-intent"))).toMatchObject({
			type: "operation",
			state: "rejected",
			graph_operation: rejected.operation,
		});
		expect(sync(f.bridge, lookup())).toMatchObject({ type: "operation", graph_operation: initial.operation });
		expect(f.store.requestGet("create-key")).toEqual(initial.operation);
	});

	it("denies creation from a Graph-limited scope, and unrelated reads and receipt discovery", () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		f.grant = { ...f.grant, graph_ids: [initial.operation.target_id!] };
		expect(sync(f.bridge, read(initial.operation.target_id!))).toMatchObject({ type: "graph.definition" });
		expect(sync(f.bridge, read("unrelated"))).toMatchObject({ type: "error", error: { code: "scope_denied" } });
		expect(sync(f.bridge, create("second", "second"))).toMatchObject({
			type: "error",
			error: { code: "scope_denied" },
		});
		expect(sync(f.createBridge("bob"), lookup())).toMatchObject({
			type: "error",
			error: { code: "unknown_request" },
		});
	});

	it("rolls back when permission changes at the synchronous commit gate", () => {
		const f = setup();
		f.onAuthorize(count => {
			if (count === 2) f.grant = { ...f.grant, generation: "revoked-generation" };
		});
		expect(sync(f.bridge, create())).toMatchObject({ type: "error", error: { code: "scope_denied" } });
		expect(f.store.getIntent("alice", "create-intent")).toBeNull();
		expect(f.store.requestGet("create-key")).toBeNull();
	});

	it("blocks expired, non-author, rebound and unnegotiated sources before mutation", () => {
		const expired = setup();
		expired.advance(60_000);
		expect(sync(expired.bridge, create())).toMatchObject({ type: "error", error: { code: "scope_denied" } });
		const reader = setup();
		reader.grant = { ...reader.grant, can_author: false };
		expect(sync(reader.bridge, create())).toMatchObject({ type: "error", error: { code: "scope_denied" } });
		const rebound = setup();
		rebound.grant = { ...rebound.grant, source_binding: "another-deployment" };
		expect(sync(rebound.bridge, create())).toMatchObject({ type: "error", error: { code: "scope_denied" } });
		const legacy = setup("alice", false);
		expect(sync(legacy.bridge, create())).toMatchObject({
			type: "error",
			error: { code: "capability_unavailable" },
		});
		for (const fixture of [expired, reader, rebound, legacy])
			expect(fixture.store.requestGet("create-key")).toBeNull();
	});

	it("allows protected definition reads without author rights but marks them read-only", () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		f.grant = { ...f.grant, can_author: false, mode: "history", source_ready: false };
		expect(sync(f.bridge, read(initial.operation.target_id!))).toMatchObject({
			type: "graph.definition",
			editable: false,
		});
		expect(sync(f.bridge, lookup())).toMatchObject({ type: "error", error: { code: "scope_denied" } });
	});

	it("returns a located definition rejection and keeps the draft revision unchanged", () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		const original = f.store.get(initial.operation.target_id!)!;
		const invalid = sync(f.bridge, {
			...create("bad-edit", "bad-edit"),
			request: {
				version: 1,
				request_key: "bad-edit",
				operation: "edit",
				target_id: original.graph_id,
				if_revision: original.revision,
				payload: { content: original.content.replace("nodes: {}", "nodes: []") },
			},
		});
		if (invalid.type !== "graph.author.result") throw new Error(JSON.stringify(invalid));
		expect(invalid.operation).toMatchObject({
			state: "rejected",
			error: { code: "definition_invalid", location: { path: "/nodes", line: expect.any(Number) } },
		});
		expect(f.store.get(original.graph_id)).toEqual(original);
		expect(sync(f.bridge, lookup("bad-edit"))).toMatchObject({
			type: "operation",
			state: "rejected",
			graph_operation: invalid.operation,
		});
	});

	it("does not mark an older frozen draft revision editable", () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		const original = f.store.get(initial.operation.target_id!)!;
		const edited = sync(f.bridge, {
			...create("edit", "edit"),
			request: {
				version: 1,
				request_key: "edit",
				operation: "edit",
				target_id: original.graph_id,
				if_revision: original.revision,
				payload: { content: original.content + "\n## Task\n\n中文说明。\n" },
			},
		});
		expect(edited).toMatchObject({ type: "graph.author.result", operation: { state: "completed", revision: "2" } });
		expect(sync(f.bridge, read(original.graph_id, "1"))).toMatchObject({
			type: "graph.definition",
			content: original.content,
			editable: false,
		});
		expect(sync(f.bridge, read(original.graph_id))).toMatchObject({
			type: "graph.definition",
			definition_revision: "2",
			editable: true,
		});
		f.grant = null;
		expect(sync(f.bridge, lookup())).toMatchObject({ type: "error", error: { code: "scope_denied" } });
	});

	it("cannot retarget a retained intent through a second source alias sharing the profile", () => {
		const f = setup();
		const bridge = new GraphWireAuthoringBridge({
			principal_id: "alice",
			sources: ["graph-source", "alias"].map(source_id => ({
				source_id,
				binding: "deployment-1",
				definitions: f.store,
				capabilities: [GRAPH_WIRE_EXECUTION_EXTENSION],
			})),
			extensions: [GRAPH_WIRE_EXECUTION_EXTENSION],
			now: () => 1_000,
			authorize: () => f.grant,
		});
		const first = sync(bridge, create());
		if (first.type !== "graph.author.result") throw new Error(JSON.stringify(first));
		expect(sync(bridge, { ...create(), source_id: "alias" })).toMatchObject({
			type: "error",
			error: { code: "idempotency_conflict" },
		});
		expect(sync(bridge, lookup())).toMatchObject({ type: "operation", graph_operation: first.operation });
	});

	it("rejects a rebound deployment before replay or receipt lookup can target it", () => {
		const f = setup();
		const first = sync(f.bridge, create());
		if (first.type !== "graph.author.result") throw new Error(JSON.stringify(first));
		f.grant = { ...f.grant, source_binding: "deployment-2" };
		const rebound = new GraphWireAuthoringBridge({
			principal_id: "alice",
			sources: [
				{
					source_id: "graph-source",
					binding: "deployment-2",
					definitions: f.store,
					capabilities: [GRAPH_WIRE_EXECUTION_EXTENSION],
				},
			],
			extensions: [GRAPH_WIRE_EXECUTION_EXTENSION],
			now: () => 1_000,
			authorize: () => f.grant,
		});
		expect(sync(rebound, create())).toMatchObject({ type: "error", error: { code: "source_changed" } });
		expect(sync(rebound, lookup())).toMatchObject({ type: "error", error: { code: "source_changed" } });
		expect(f.store.requestGet("create-key")).toEqual(first.operation);
	});
});

/** Host stand-in that records what the bridge admitted, so a test can prove the bridge never
 * decided a transition itself. */
function executor() {
	const applied: GraphOperation[] = [];
	const reconciled: string[] = [];
	let active = 0;
	let maxActive = 0;
	let gate: Promise<void> | null = null;
	let receipt: GraphOperation | null = null;
	const service: GraphWireExecutionService = {
		async apply(_principalId, _sourceId, _intentId, request) {
			active += 1;
			maxActive = Math.max(maxActive, active);
			try {
				if (gate) await gate;
				const operation = accepted(request.request_key);
				applied.push(operation);
				return operation;
			} finally {
				active -= 1;
			}
		},
		reconcile(_principalId, _sourceId, intentId) {
			reconciled.push(intentId);
			return receipt;
		},
	};
	return {
		service,
		applied,
		reconciled,
		get active() {
			return active;
		},
		get maxActive() {
			return maxActive;
		},
		block(next: Promise<void>) {
			gate = next;
		},
		receipt(value: GraphOperation | null) {
			receipt = value;
		},
	};
}
function runBridge(f: ReturnType<typeof setup>, host: ReturnType<typeof executor>): GraphWireAuthoringBridge {
	return new GraphWireAuthoringBridge({ ...f.options(), execution: host.service });
}

describe("trusted Graph Run control", () => {
	it("denies Run control without an execute grant and never asks the host to apply it", async () => {
		const f = setup();
		const host = executor();
		const bridge = runBridge(f, host);
		f.grant = { ...f.grant, can_execute: false };
		expect(await bridge.handle(control("start"))).toMatchObject({
			type: "error",
			error: { code: "scope_denied" },
		});
		expect(host.applied).toEqual([]);
	});

	it("reports capability_unavailable when no host execution service is injected", async () => {
		const f = setup();
		expect(await f.bridge.handle(control("hold"))).toMatchObject({
			type: "error",
			error: { code: "capability_unavailable" },
		});
	});

	it("keeps Run control out of the definition ledger", async () => {
		const f = setup();
		const host = executor();
		const bridge = runBridge(f, host);
		expect(await bridge.handle(control("start"))).toMatchObject({
			type: "graph.author.result",
			intent_id: "start-intent",
			operation: { state: "accepted", target_id: "graph-1" },
			error: null,
		});
		expect(host.applied).toHaveLength(1);
		expect(f.store.getIntent("alice", "start-intent")).toBeNull();
		expect(f.store.requestGet("start-key")).toBeNull();
	});

	it("serializes concurrent Run control across an awaiting host transition", async () => {
		const f = setup();
		const host = executor();
		const bridge = runBridge(f, host);
		const gate = deferred();
		host.block(gate.promise);
		const first = bridge.handle(control("start"));
		const second = bridge.handle(control("hold", "hold-key", "hold-intent"));
		await Bun.sleep(5);
		expect(host.active).toBe(1);
		expect(host.maxActive).toBe(1);
		// The host records `applied` only after its await, so a blocked start proves the second
		// request never entered the service rather than merely finishing first.
		expect(host.applied).toEqual([]);
		gate.resolve();
		const [started, held] = await Promise.all([first, second]);
		expect(started.type).toBe("graph.author.result");
		expect(held.type).toBe("graph.author.result");
		expect(host.applied.map(operation => operation.request_key)).toEqual(["start-key", "hold-key"]);
		expect(host.maxActive).toBe(1);
	});

	it("returns a Run receipt from request.get and then withholds it once execute permission is revoked", async () => {
		const f = setup();
		const host = executor();
		const bridge = runBridge(f, host);
		host.receipt(accepted("start-key"));
		const reply = bridge.handle({
			protocol: GRAPH_WIRE_PROTOCOL,
			type: "request.get",
			message_id: "lookup-run",
			intent_id: "start-intent",
		});
		expect(reply instanceof Promise).toBe(false);
		expect(reply).toMatchObject({
			type: "operation",
			state: "admitted",
			graph_operation: { request_key: "start-key", state: "accepted" },
		});
		expect(host.reconciled).toEqual(["start-intent"]);
		f.grant = { ...f.grant, can_execute: false };
		const revoked = bridge.handle({
			protocol: GRAPH_WIRE_PROTOCOL,
			type: "request.get",
			message_id: "lookup-run-revoked",
			intent_id: "start-intent",
		});
		expect(revoked).toMatchObject({ type: "error", error: { code: "unknown_request" } });
		expect(host.reconciled).toEqual(["start-intent"]);
	});

	it("fences a delivered control frame after the execute grant is revoked", async () => {
		const f = setup();
		const host = executor();
		const bridge = runBridge(f, host);
		const frame = await bridge.handle(control("cancel", "cancel-key", "cancel-intent"));
		expect(frame.type).toBe("graph.author.result");
		expect(() => bridge.assertAuthorizedForDelivery(frame)).not.toThrow();
		f.grant = { ...f.grant, can_execute: false };
		expect(() => bridge.assertAuthorizedForDelivery(frame)).toThrow("scope_denied");
	});
});

const encoder = new TextEncoder();
function stdio(f: { options(): GraphWireAuthoringOptions }, overrides: Partial<GraphWireAuthoringStdioOptions> = {}) {
	let input!: ReadableStreamDefaultController<Uint8Array>;
	const abort = new AbortController();
	const frames: GraphWireAuthoringFrame[] = [];
	let changed = Promise.withResolvers<void>();
	const task = serveGraphWireAuthoringStdio({
		...f.options(),
		input: new ReadableStream<Uint8Array>({
			start(controller) {
				input = controller;
			},
		}),
		output: new WritableStream<Uint8Array>({
			write(bytes) {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				expect(text.endsWith("\n")).toBe(true);
				frames.push(JSON.parse(text));
				changed.resolve();
			},
		}),
		signal: abort.signal,
		writeTimeoutMs: 200,
		...overrides,
	});
	void task.catch(() => {});
	connections.push({ abort, task });
	let index = 0;
	return {
		input,
		abort,
		task,
		frames,
		send(value: unknown) {
			input.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
		},
		async next(): Promise<GraphWireAuthoringFrame> {
			while (index >= frames.length) {
				changed = Promise.withResolvers<void>();
				await withTimeout(changed.promise, 2000, "Missing authoring frame");
			}
			return frames[index++]!;
		},
	};
}

describe("trusted Graph authoring JSONL streams", () => {
	it("preserves split multibyte Markdown larger than the observer request ceiling", async () => {
		const f = setup();
		const t = stdio(f);
		const content =
			"---\r\nformat: omp.graph/v1\r\nname: unicode\r\nmembers: {}\r\nnodes: {}\r\n---\r\n## Task\r\n\uFEFF雪 🦉 **Markdown**\r\n" +
			"x".repeat(70 * 1024);
		const request = {
			...create(),
			request: { ...create().request, operation: "import", payload: { content } },
		};
		const bytes = encoder.encode(`${JSON.stringify(request)}\n`);
		const split = bytes.indexOf(0xe9) + 1;
		expect(split).toBeGreaterThan(0);
		t.input.enqueue(bytes.subarray(0, split));
		t.input.enqueue(bytes.subarray(split, split + 1));
		t.input.enqueue(bytes.subarray(split + 1));
		const authored = await t.next();
		if (authored.type !== "graph.author.result") throw new Error(JSON.stringify(authored));
		expect(authored.operation.state).toBe("completed");
		const graphId = authored.operation.target_id!;
		expect(f.store.get(graphId)?.content).toBe(content);
		t.send(read(graphId));
		expect(await t.next()).toMatchObject({ type: "graph.definition", content, editable: true });
		t.send(lookup());
		expect(await t.next()).toMatchObject({ type: "operation", graph_operation: authored.operation });
		t.input.close();
		await t.task;
	});

	it.each([
		["invalid UTF-8", new Uint8Array([0xc3, 0x28, 10])],
		["invalid JSON", encoder.encode("{\n")],
		["unterminated request", encoder.encode(JSON.stringify(create()))],
	] as const)("closes on %s without a mutation or protected output", async (_name, bytes) => {
		const f = setup();
		const t = stdio(f);
		t.input.enqueue(bytes);
		t.input.close();
		await expect(t.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(t.frames).toEqual([]);
		expect(f.store.getIntent("alice", "create-intent")).toBeNull();
		expect(f.store.requestGet("create-key")).toBeNull();
	});

	it("rejects oversized partial input before parsing and bounds queued frame count", async () => {
		const f = setup();
		const oversized = stdio(f);
		oversized.input.enqueue(new Uint8Array(GRAPH_WIRE_AUTHORING_STDIO_LIMITS.maxRequestBytes + 1));
		await expect(oversized.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(oversized.frames).toEqual([]);
		const queued = stdio(f);
		const line = `${JSON.stringify(create())}\n`;
		queued.input.enqueue(encoder.encode(line.repeat(GRAPH_WIRE_AUTHORING_STDIO_LIMITS.maxPendingRequests + 1)));
		await expect(queued.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(queued.frames).toEqual([]);
		expect(f.store.getIntent("alice", "create-intent")).toBeNull();
		const pending = stdio(f);
		pending.input.enqueue(
			encoder.encode(JSON.stringify("x".repeat(4 * 1024 * 1024)) + "\n" + " ".repeat(4 * 1024 * 1024)),
		);
		await expect(pending.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(pending.frames).toEqual([]);
	});

	it("serializes complete mutation transactions and preserves revision CAS", async () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		const original = f.store.get(initial.operation.target_id!)!;
		const t = stdio(f);
		const edits = ["one", "two"].map(intent => ({
			...create(intent, intent),
			message_id: intent,
			request: {
				version: 1,
				request_key: intent,
				operation: "edit",
				target_id: original.graph_id,
				if_revision: original.revision,
				payload: { content: original.content + `\n## Task\n${intent}\n` },
			},
		}));
		t.input.enqueue(encoder.encode(edits.map(value => JSON.stringify(value)).join("\n") + "\n"));
		expect(await t.next()).toMatchObject({
			type: "graph.author.result",
			intent_id: "one",
			operation: { state: "completed", revision: "2" },
		});
		expect(await t.next()).toMatchObject({
			type: "graph.author.result",
			intent_id: "two",
			operation: { state: "rejected", error: { code: "revision_conflict" } },
		});
		expect(f.store.get(original.graph_id)?.revision).toBe("2");
	});

	it("rechecks authorization after asynchronous writable readiness before releasing protected output", async () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		let checks = 0;
		f.onAuthorize(() => {
			if (++checks === 2)
				queueMicrotask(() => {
					f.grant = null;
				});
		});
		const t = stdio(f);
		t.send(read(initial.operation.target_id!));
		await expect(t.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(t.frames).toEqual([]);
	});

	it("times out bounded writable backpressure without delivering a protected frame", async () => {
		const f = setup();
		let deliveries = 0;
		const output = new WritableStream<Uint8Array>(
			{
				write() {
					deliveries++;
				},
			},
			{ highWaterMark: 0 },
		);
		const t = stdio(f, { output, writeTimeoutMs: 20 });
		t.send(create());
		await expect(t.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(deliveries).toBe(0);
		expect(f.store.requestGet("create-key")).toMatchObject({ state: "completed" });
	});

	it("cancels a stalled sink without draining another queued mutation", async () => {
		const f = setup();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const t = stdio(f, {
			output: new WritableStream<Uint8Array>({
				write() {
					entered.resolve();
					return release.promise;
				},
			}),
		});
		t.send(create());
		await entered.promise;
		t.send(create("never", "never"));
		t.abort.abort();
		await t.task;
		expect(f.store.getIntent("alice", "never")).toBeNull();
		release.resolve();
	});

	it("fences queued mutations when authorization is revoked during a pending write", async () => {
		const f = setup();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const t = stdio(f, {
			output: new WritableStream<Uint8Array>({
				write() {
					entered.resolve();
					return release.promise;
				},
			}),
		});
		t.send(create());
		await entered.promise;
		t.send(create("queued-at-revocation", "queued-at-revocation"));
		f.grant = null;
		release.resolve();
		await expect(t.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(f.store.getIntent("alice", "queued-at-revocation")).toBeNull();
	});

	it("recovers a committed write with a lost response in a new authorized session", async () => {
		const f = setup();
		const committed = Promise.withResolvers<void>();
		f.onAuthorize(count => {
			if (count === 3) {
				committed.resolve();
				f.grant = null;
			}
		});
		const lost = stdio(f);
		lost.send(create());
		await committed.promise;
		const operation = f.store.requestGet("create-key");
		expect(operation).toMatchObject({ state: "completed", revision: "1" });
		expect(await lost.next()).toMatchObject({ type: "error", error: { code: "scope_denied" } });
		await lost.task;
		expect(lost.frames.some(frame => frame.type === "graph.author.result")).toBe(false);
		f.onAuthorize(() => {});
		f.store.close();
		stores.splice(stores.indexOf(f.store), 1);
		const reopened = new GraphAuthoringService(
			{ maxBytes: 200 * 1024, maxDepth: 40, maxAliases: 100, maxNodes: 10000 },
			f.root,
		);
		stores.push(reopened);
		f.grant = {
			generation: "new-session",
			source_binding: "deployment-1",
			subscription_id: "new-subscription",
			scope_id: "new-scope",
			mode: "history",
			source_ready: false,
			can_author: true,
			can_execute: true,
			graph_ids: null,
			authorized_at: 1000,
			expires_at: 61000,
		};
		const options = f.options();
		options.sources = options.sources.map(source => ({ ...source, definitions: reopened }));
		const recovered = stdio(f, options);
		recovered.send(lookup());
		expect(await recovered.next()).toMatchObject({
			type: "operation",
			state: "applied",
			graph_operation: operation,
		});
		expect(reopened.get(operation!.target_id!)?.revision).toBe("1");
	});

	it("captures trusted identity/source configuration and rejects client grant negotiation", async () => {
		const f = setup();
		const options = f.options();
		const extensions = [GRAPH_WIRE_EXECUTION_EXTENSION];
		options.extensions = extensions;
		const t = stdio(f, options);
		options.principal_id = "bob";
		options.sources[0]!.binding = "rebound";
		extensions.length = 0;
		t.send({ ...create(), principal_id: "mallory" });
		expect(await t.next()).toMatchObject({ type: "error", error: { code: "protocol_error" } });
		expect(f.store.getIntent("alice", "create-intent")).toBeNull();
		t.send(create());
		expect(await t.next()).toMatchObject({ type: "graph.author.result", operation: { state: "completed" } });
		expect(f.store.getIntent("alice", "create-intent")).not.toBeNull();
		expect(f.store.getIntent("bob", "create-intent")).toBeNull();
	});

	it("does not drain a complete queued mutation after EOF or a pre-aborted launch", async () => {
		const f = setup();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const eof = stdio(f, {
			output: new WritableStream<Uint8Array>({
				write() {
					entered.resolve();
					return release.promise;
				},
			}),
		});
		eof.send(create());
		await entered.promise;
		eof.send(create("queued-at-eof", "queued-at-eof"));
		eof.input.close();
		await expect(eof.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(f.store.getIntent("alice", "queued-at-eof")).toBeNull();
		release.resolve();
		const abort = new AbortController();
		abort.abort();
		const cancelled = stdio(f, { signal: abort.signal });
		await cancelled.task;
		expect(cancelled.frames).toEqual([]);
	});

	it("does not hide a sink failure racing EOF as a successful shutdown", async () => {
		const f = setup();
		const t = stdio(f, {
			output: new WritableStream<Uint8Array>({
				write() {
					t.input.close();
					throw new Error("Private sink failure must not escape");
				},
			}),
		});
		t.send(create());
		await expect(t.task).rejects.toThrow("Graph wire authoring transport unavailable");
		expect(f.store.requestGet("create-key")).toMatchObject({ state: "completed" });
	});

	it("rejects a stale editable flag and foreign protected frame at the bridge delivery gate", () => {
		const f = setup();
		const initial = sync(f.bridge, create());
		if (initial.type !== "graph.author.result") throw new Error(JSON.stringify(initial));
		const definition = sync(f.bridge, read(initial.operation.target_id!));
		expect(definition.type).toBe("graph.definition");
		f.grant = { ...f.grant, source_ready: false };
		expect(() => f.bridge.assertAuthorizedForDelivery(definition)).toThrow("scope_denied");
		expect(() => f.createBridge().assertAuthorizedForDelivery(initial)).toThrow("scope_denied");
	});
});

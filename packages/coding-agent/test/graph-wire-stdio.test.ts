import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLines, withTimeout } from "@oh-my-pi/pi-utils";
import { GraphRunStore, type GraphPreparedRun } from "../src/graph/store";
import { GraphWireLedger } from "../src/graph/wire-ledger";
import type { GraphWireReadFrame } from "../src/graph/wire-read-bridge";
import { GRAPH_WIRE_EXECUTION_EXTENSION, GraphWireSourceState } from "@oh-my-pi/pi-wire/graph";
import { serveGraphWireStdio, type GraphWireStdioOptions } from "../src/graph/wire-stdio";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const encoder = new TextEncoder();
const protocol = "omp.graph.v1";
const sourceId = "host-source";
const frame = (type: string, rest: Record<string, unknown> = {}) => ({
	protocol,
	type,
	message_id: crypto.randomUUID(),
	...rest,
});
const hello = () => frame("hello", { supported_protocols: [protocol], extensions: ["graph.execution.v1"] });
const subscribe = (runId: string | null, source = sourceId) =>
	frame("subscribe", {
		subscription_id: "sub",
		mode: "live",
		scope: { graph_run_id: runId, source_ids: [source] },
		resume: null,
	});

function fixture(withConsultation = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-wire-stdio-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	cleanups.push(() => store.close());
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "definition",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content: withConsultation
				? `---
format: omp.graph/v1
name: consultation-observation
members:
  researcher: {role: '#role', model: model, base: isolated, duty: research, permissions: {read: [], write: [], execute: []}}
  reviewer: {role: '#role', model: model, base: isolated, duty: review, permissions: {read: [], write: [], execute: []}}
nodes:
  research: {kind: bot, member: researcher, task: '#task'}
  approval: {kind: human, task: '#task'}
edges:
  - {id: handoff, from: research, to: approval}
communications:
  - {from: researcher, to: reviewer, when: '#task', max_rounds: 2}
---
## role
Research.
## task
Decide.
`
				: "---\nformat: omp.graph/v1\nname: observation\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#task'}\n---\n## task\nDecide.\n",
		},
	});
	if (imported.error) throw new Error(imported.error.message);
	const definition = store.definitions.get(imported.target_id!)!;
	const authorization_ref = { id: "private-auth-reference", digest: "sha256:private-auth-reference" };
	const prepared: GraphPreparedRun = {
		graph_id: definition.graph_id,
		definition_revision: definition.revision,
		definition_digest: definition.digest,
		authorization_ref,
		inputs: {},
		members: {},
		executors: {},
		observation: { source_id: sourceId, members: {} },
	};
	if (withConsultation) {
		for (const member of ["researcher", "reviewer"]) {
			prepared.members[member] = {
				provider: "provider",
				model: "model",
				configuration_revision: "1",
				base: "isolated",
				base_snapshot_ref: { id: "base", digest: "sha256:base" },
				role_ref: { id: "role", digest: "sha256:role" },
				skill_refs: [],
				rule_refs: [],
			};
			prepared.observation!.members[member] = {
				bot: { source_id: `${member}-source`, profile_id: "profile", bot_id: `${member}-bot` },
				config_revision: "1",
				model_binding_ref: { id: `${member}-model`, digest: `sha256:${member}-model` },
			};
		}
	}
	const start = (requestKey: string): string => {
		const receipt = store.start(
			{
				version: 1,
				request_key: requestKey,
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref },
			},
			prepared,
		);
		if (receipt.error || !receipt.target_id) throw new Error("Run fixture failed");
		return receipt.target_id;
	};
	const runId = start("allowed");
	const forbiddenId = start("forbidden");
	const db = new Database(path.join(root, "graphs.sqlite"));
	cleanups.push(() => db.close());
	const producer = new GraphWireLedger(db);
	return { root, store, runId, forbiddenId, db, producer };
}

function consultationFixture() {
	const result = fixture(true);
	const service = result.store.configureConsultation({
		validate: () => true,
		policy: () => ({ max_rounds: 2, timeout_ms: 60000 }),
		artifacts: () => true,
		reserve: () => true,
		participant: () => true,
	});
	const ask = (runId: string, text: string) => {
		const asked = service.ask(
			{
				run_id: runId,
				member_id: "researcher",
				invocation_id: `invocation-${runId}`,
				attempt_id: `attempt-${runId}`,
				fence: "trusted-test-host",
			},
			{ to_member: "reviewer", text, request_key: "ask" },
		);
		if (!asked.ok) throw new Error(asked.error);
		return service.messages(asked.value.conversation_id)[0]!;
	};
	const message = ask(result.runId, "Exact **private** request.\n雪 🦉");
	const forbiddenMessage = ask(result.forbiddenId, "Forbidden consultation content");
	return { ...result, message, forbiddenMessage };
}

function transport(root: string, runId: string, overrides: Partial<GraphWireStdioOptions> = {}) {
	let input!: ReadableStreamDefaultController<Uint8Array>;
	const abort = new AbortController();
	const inputStream = new ReadableStream<Uint8Array>({
		start(controller) {
			input = controller;
		},
	});
	const output = new TransformStream<Uint8Array, Uint8Array>();
	const options: GraphWireStdioOptions = {
		root,
		sourceId,
		runIds: [runId],
		input: inputStream,
		output: output.writable,
		signal: abort.signal,
		pollIntervalMs: 20,
		writeTimeoutMs: 200,
		...overrides,
	};
	const task = serveGraphWireStdio(options);
	// Rejections are observed immediately, including malformed-input tests that read the error first.
	void task.catch(() => {});
	const lines = readLines(output.readable);
	cleanups.push(async () => {
		abort.abort();
		await task.catch(() => {});
		await lines.return(undefined);
	});
	const next = async (): Promise<GraphWireReadFrame> => {
		const result = await withTimeout(lines.next(), 2000, "Missing wire frame");
		if (result.done) throw new Error("Source ended before frame");
		return JSON.parse(new TextDecoder().decode(result.value)) as GraphWireReadFrame;
	};
	const send = (value: unknown): void => input.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
	return { input, abort, task, next, send, options };
}

function consumer(runId: string, extensions: string[] = []): GraphWireSourceState {
	return new GraphWireSourceState({
		subscriptionId: "sub",
		mode: "live",
		scope: { graph_run_id: runId, source_ids: [sourceId] },
		extensions,
		limits: { maxRecords: 100, maxPages: 100, maxEvents: 100 },
	});
}
async function ready(
	connection: { next(): Promise<GraphWireReadFrame> },
	state: GraphWireSourceState,
): Promise<GraphWireReadFrame[]> {
	const received: GraphWireReadFrame[] = [];
	for (let count = 0; count < 100; count++) {
		const value = await connection.next();
		received.push(value);
		if ("subscription_id" in value) state.apply(value);
		if (value.type === "heartbeat") return received;
	}
	throw new Error("Source did not become ready");
}

async function reply(
	connection: { next(): Promise<GraphWireReadFrame> },
	messageId: string,
	state?: GraphWireSourceState,
): Promise<GraphWireReadFrame> {
	for (let remaining = 100; remaining > 0; remaining--) {
		const value = await connection.next();
		if (value.in_reply_to === messageId) return value;
		if (state && "subscription_id" in value) state.apply(value);
	}
	throw new Error("Source did not reply");
}

const detail = (runId: string, ref: string, source = sourceId) =>
	frame("graph.artifact.get", { source_id: source, graph_run_id: runId, ref, page_token: null, limit: 100 });

async function expectFailed(task: Promise<void>, timeoutMs: number): Promise<void> {
	expect(
		await withTimeout(
			task.then(
				() => false,
				() => true,
			),
			timeoutMs,
			"Source did not stop",
		),
	).toBe(true);
}

describe("private read-only Graph JSONL source", () => {
	test("incrementally negotiates and delivers a consumable real snapshot before stdin EOF, with no execution extension", async () => {
		const { root, runId, forbiddenId } = fixture();
		const connection = transport(root, runId);
		const bytes = encoder.encode(`${JSON.stringify(hello())}\n`);
		connection.input.enqueue(bytes.subarray(0, 11));
		connection.input.enqueue(bytes.subarray(11));
		expect(await connection.next()).toMatchObject({
			type: "hello",
			capabilities: ["graph.runs.v1", "graph.history.v1"],
			extensions: [],
			sources: [{ source_id: sourceId }],
		});
		connection.send(subscribe(runId));
		const state = consumer(runId);
		const snapshot = await ready(connection, state);
		expect(state.read().sources[0].ready).toBe(true);
		expect(state.read().sources[0].records.map(record => record.value.graph_run_id)).toEqual([runId]);
		expect(JSON.stringify(snapshot)).not.toContain(forbiddenId);
		expect(JSON.stringify(snapshot)).not.toContain("private-auth-reference");
		const request = frame("graph.history.get", {
			subscription_id: "sub",
			scope_id: state.read().scopeId,
			source_id: sourceId,
			graph_run_id: runId,
			view: "state",
			at: null,
			after: null,
			filter: {},
			page_token: null,
			limit: 100,
		});
		connection.send(request);
		let history = await connection.next();
		for (let remaining = 100; history.in_reply_to !== request.message_id && remaining > 0; remaining--) {
			if ("subscription_id" in history) state.apply(history);
			history = await connection.next();
		}
		expect(history).toMatchObject({ type: "graph.history", availability: "available" });
		connection.input.close();
		await withTimeout(connection.task, 500, "EOF did not stop source");
	});

	for (const negotiated of [false, true]) {
		test(`explicit opt-in ${negotiated ? "delivers" : "filters"} real human execution in snapshot and history`, async () => {
			const { root, runId, forbiddenId, store, producer } = fixture();
			const owner = store.claimHost()!;
			store.schedule(runId, owner.owner_id, owner.epoch);
			const ledger = producer.snapshot(sourceId, runId).records;
			expect(ledger).toContainEqual(
				expect.objectContaining({
					kind: "execution_invocation",
					value: expect.objectContaining({ node_id: "approval", current_attempt_id: null }),
				}),
			);
			expect(ledger.some(record => record.kind === "execution_attempt" || record.kind === "binding")).toBe(false);
			const connection = transport(root, runId, { executionRecords: true });
			connection.send(negotiated ? hello() : frame("hello", { supported_protocols: [protocol], extensions: [] }));
			expect(await connection.next()).toMatchObject({
				type: "hello",
				extensions: negotiated ? [GRAPH_WIRE_EXECUTION_EXTENSION] : [],
				sources: [
					{
						source_id: sourceId,
						capabilities: negotiated
							? ["graph.runs.v1", "graph.history.v1", GRAPH_WIRE_EXECUTION_EXTENSION]
							: ["graph.runs.v1", "graph.history.v1"],
					},
				],
			});
			connection.send(subscribe(runId));
			const state = consumer(runId, negotiated ? [GRAPH_WIRE_EXECUTION_EXTENSION] : []);
			const snapshot = await ready(connection, state);
			const expected = negotiated ? ledger : ledger.filter(record => !record.kind.startsWith("execution_"));
			expect(state.read().sources[0].ready).toBe(true);
			expect(state.read().sources[0].records).toEqual(expected);
			expect(JSON.stringify(snapshot)).not.toContain(forbiddenId);
			for (const view of ["state", "events"]) {
				const request = frame("graph.history.get", {
					subscription_id: "sub",
					scope_id: state.read().scopeId,
					source_id: sourceId,
					graph_run_id: runId,
					view,
					at: null,
					after: null,
					filter: {},
					page_token: null,
					limit: 100,
				});
				connection.send(request);
				const history = await reply(connection, request.message_id, state);
				expect(history).toMatchObject({ type: "graph.history", availability: "available", view });
				if (history.type !== "graph.history") throw new Error("Missing history response");
				if (view === "state") expect(history.items).toEqual(expected);
				expect(JSON.stringify(history).includes('"kind":"execution_invocation"')).toBe(negotiated);
				expect(JSON.stringify(history)).not.toContain(forbiddenId);
			}
			expect(store.getDispatchIntents(runId)).toEqual([]);
		});
	}

	test("opted-in stdio reads exact scoped consultation text but never infers artifact or snapshot file grants", async () => {
		const { root, runId, store, message } = consultationFixture();
		const connection = transport(root, runId, { executionRecords: true });
		connection.send(hello());
		await connection.next();
		connection.send(subscribe(runId));
		const state = consumer(runId, [GRAPH_WIRE_EXECUTION_EXTENSION]);
		await ready(connection, state);
		expect(state.read().sources[0].records).toContainEqual(
			expect.objectContaining({
				kind: "execution_conversation",
				value: expect.objectContaining({ content_ref: message.content_ref.id }),
			}),
		);
		const request = detail(runId, message.content_ref.id);
		connection.send(request);
		expect(await reply(connection, request.message_id, state)).toMatchObject({
			type: "graph.artifact",
			graph_run_id: runId,
			ref: message.content_ref.id,
			availability: "available",
			media_type: "text/markdown",
			content: message.text,
		});
		for (const ref of [store.getRun(runId)!.snapshot_ref.id, `file:${root}/graphs.sqlite`]) {
			const protectedRequest = detail(runId, ref);
			connection.send(protectedRequest);
			expect(await reply(connection, protectedRequest.message_id, state)).toMatchObject({
				type: "graph.artifact",
				availability: "unknown",
				content: null,
				media_type: null,
			});
		}
	});

	for (const denied of ["forbidden-run", "foreign-ref", "other-source"] as const) {
		test(`execution detail denies ${denied} without exposing protected content`, async () => {
			const { root, runId, forbiddenId, forbiddenMessage } = consultationFixture();
			const connection = transport(root, runId, { executionRecords: true });
			connection.send(hello());
			await connection.next();
			const request = detail(
				denied === "forbidden-run" ? forbiddenId : runId,
				forbiddenMessage.content_ref.id,
				denied === "other-source" ? "other-source" : sourceId,
			);
			connection.send(request);
			const error = await reply(connection, request.message_id);
			expect(error).toMatchObject({ type: "error", error: { code: "scope_denied", details: null } });
			expect(JSON.stringify(error)).not.toContain(forbiddenMessage.text);
			expect(JSON.stringify(error)).not.toContain(forbiddenMessage.content_ref.id);
			expect(JSON.stringify(error)).not.toContain(forbiddenId);
			await withTimeout(connection.task, 500, "Denied detail did not stop source");
		});
	}

	test("frames cannot enable execution records or consultation details on the default source", async () => {
		const { root, runId, message } = consultationFixture();
		const connection = transport(root, runId);
		connection.send({ ...hello(), executionRecords: true, extensions: [GRAPH_WIRE_EXECUTION_EXTENSION] });
		expect(await connection.next()).toMatchObject({ type: "hello", extensions: [] });
		const request = detail(runId, message.content_ref.id);
		connection.send({ ...request, executionRecords: true });
		expect(await reply(connection, request.message_id)).toMatchObject({
			type: "error",
			error: { code: "capability_unavailable", details: null },
		});
	});

	test("trusted source, Run allowlist and read opt-in are captured before asynchronous authorization", async () => {
		const { root, runId, forbiddenId, forbiddenMessage } = consultationFixture();
		const entered = Promise.withResolvers<void>();
		const authorized = Promise.withResolvers<void>();
		const runIds = [runId];
		const connection = transport(root, runId, {
			runIds,
			executionRecords: true,
			assertAuthorized: async () => {
				entered.resolve();
				await authorized.promise;
			},
		});
		connection.send(hello());
		await withTimeout(entered.promise, 1000, "Authorization did not start");
		runIds.push(forbiddenId);
		connection.options.runIds = [forbiddenId];
		connection.options.sourceId = "other-source";
		connection.options.root = "/untrusted/replacement";
		connection.options.executionRecords = false;
		authorized.resolve();
		expect(await connection.next()).toMatchObject({
			type: "hello",
			extensions: [GRAPH_WIRE_EXECUTION_EXTENSION],
			sources: [{ source_id: sourceId }],
		});
		connection.send(subscribe(runId));
		const state = consumer(runId, [GRAPH_WIRE_EXECUTION_EXTENSION]);
		await ready(connection, state);
		const request = detail(forbiddenId, forbiddenMessage.content_ref.id);
		connection.send(request);
		expect(await reply(connection, request.message_id, state)).toMatchObject({
			type: "error",
			error: { code: "scope_denied", details: null },
		});
	});

	test("trusted revocation withholds pending separately supplied artifact detail", async () => {
		const { root, runId } = fixture();
		const entered = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<{ availability: "available"; media_type: string; content: string }>();
		const delivered: string[] = [];
		const connection = transport(root, runId, {
			executionRecords: true,
			artifactContents: {
				read: async (source, run, ref) => {
					expect([source, run, ref]).toEqual([sourceId, runId, "trusted-artifact"]);
					entered.resolve();
					return pending.promise;
				},
			},
			output: new WritableStream({
				write(bytes) {
					delivered.push(new TextDecoder().decode(bytes));
				},
			}),
		});
		connection.send(hello());
		connection.send(detail(runId, "trusted-artifact"));
		await withTimeout(entered.promise, 1000, "Artifact read did not start");
		connection.abort.abort();
		await withTimeout(connection.task, 500, "Pending detail retained revoked source");
		pending.resolve({ availability: "available", media_type: "text/plain", content: "revoked private content" });
		expect(delivered.join("")).not.toContain('"type":"graph.artifact"');
		expect(delivered.join("")).not.toContain("revoked private content");
	});

	test("revocation after a consultation read withholds text awaiting its post-read authorization", async () => {
		const { root, runId, message } = consultationFixture();
		const helloAuthorized = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const authorized = Promise.withResolvers<void>();
		const delivered: string[] = [];
		let detailChecks = 0;
		let helloWritten = false;
		let checkingDetail = false;
		const connection = transport(root, runId, {
			executionRecords: true,
			assertAuthorized: async () => {
				if (helloWritten && !checkingDetail) helloAuthorized.resolve();
				// Catalog + scope checks precede the synchronous detail read; the next catalog
				// check gates release of the resulting protected text.
				if (checkingDetail && ++detailChecks === 3) {
					entered.resolve();
					await authorized.promise;
				}
			},
			output: new WritableStream({
				write(bytes) {
					const text = new TextDecoder().decode(bytes);
					delivered.push(text);
					if ((JSON.parse(text) as GraphWireReadFrame).type === "hello") helloWritten = true;
				},
			}),
		});
		connection.send(hello());
		await withTimeout(helloAuthorized.promise, 1000, "Hello post-write authorization did not finish");
		checkingDetail = true;
		connection.send(detail(runId, message.content_ref.id));
		await withTimeout(entered.promise, 1000, "Post-read authorization did not start");
		connection.abort.abort();
		await withTimeout(connection.task, 500, "Pending consultation retained revoked source");
		authorized.resolve();
		expect(delivered.join("")).not.toContain('"type":"graph.artifact"');
		expect(delivered.join("")).not.toContain(message.text);
	});

	test("live cadence delivers a committed Host ledger publication to the actual source consumer", async () => {
		const { root, runId, db, producer } = fixture();
		const connection = transport(root, runId);
		connection.send(hello());
		await connection.next();
		connection.send(subscribe(runId));
		const state = consumer(runId);
		await ready(connection, state);
		const record = producer.snapshot(sourceId, runId).records.find(value => value.kind === "run");
		if (!record || record.kind !== "run") throw new Error("No Host Run publication");
		const replacement = {
			...record,
			value: { ...record.value, revision: (BigInt(record.value.revision) + 1n).toString() },
		};
		db.transaction(() => producer.publish(sourceId, [replacement], new Date().toISOString()))();
		const delivered = await ready(connection, state);
		expect(delivered).toContainEqual(expect.objectContaining({ type: "graph.event", replay: false }));
		expect(state.read().sources[0].records[0].value.revision).toBe(replacement.value.revision);
	});

	for (const denied of ["forbidden-run", "roster", "other-source", "run-list"] as const) {
		test(`denies ${denied} without inventory widening or client reconfiguration`, async () => {
			const { root, runId, forbiddenId, store } = fixture();
			const before = store.listHostRuns();
			const connection = transport(root, runId);
			connection.send(hello());
			await connection.next();
			const request =
				denied === "run-list"
					? frame("graph.runs.list", { source_id: sourceId, graph_id: null, page_token: null, limit: 100 })
					: subscribe(
							denied === "roster" ? null : denied === "forbidden-run" ? forbiddenId : runId,
							denied === "other-source" ? "other-source" : sourceId,
						);
			connection.send({ ...request, root: "/client/root", sourceId: "other-source", runIds: [forbiddenId] });
			const error = await connection.next();
			expect(error).toMatchObject({ type: "error", error: { code: "scope_denied", details: null } });
			expect(JSON.stringify(error)).not.toContain(forbiddenId);
			expect(JSON.stringify(error)).not.toContain(root);
			await withTimeout(connection.task, 500, "Denied connection did not close");
			expect(store.listHostRuns()).toEqual(before);
			expect(store.getDispatchIntents(runId)).toEqual([]);
		});
	}

	for (const executionRecords of [false, true]) {
		test(`forged mutations never dispatch or change the real store with execution observation ${executionRecords}`, async () => {
			const { root, runId, store, producer } = fixture();
			const connection = transport(root, runId, { executionRecords });
			connection.send(hello());
			await connection.next();
			const before = producer.snapshot(sourceId);
			for (const type of ["graph.run.start", "graph.author", "graph.execute", "graph.run.cancel"]) {
				const request = frame(type, {
					source_id: sourceId,
					graph_run_id: runId,
					authorization: "forged",
					command: "/bin/sh",
				});
				connection.send(request);
				expect(await reply(connection, request.message_id)).toMatchObject({
					type: "error",
					error: { code: "capability_unavailable" },
				});
			}
			expect(producer.snapshot(sourceId)).toEqual(before);
			expect(store.getDispatchIntents(runId)).toEqual([]);
		});
	}

	for (const invalid of ["oversized", "invalid-utf8", "malformed", "truncated", "pending-overflow"] as const) {
		test(`rejects ${invalid} input with bounded generic failure`, async () => {
			const { root, runId } = fixture();
			const connection = transport(root, runId);
			if (invalid === "oversized") connection.input.enqueue(new Uint8Array(64 * 1024 + 1).fill(65));
			if (invalid === "invalid-utf8") connection.input.enqueue(new Uint8Array([0x22, 0xc3, 0x28, 0x22, 10]));
			if (invalid === "malformed") connection.input.enqueue(encoder.encode(`{"secret":"${root}",broken}\n`));
			if (invalid === "truncated") {
				connection.input.enqueue(encoder.encode(`{"secret":"${root}"`));
				connection.input.close();
			}
			if (invalid === "pending-overflow")
				connection.input.enqueue(encoder.encode(`${JSON.stringify(hello())}\n`.repeat(17)));
			const error = await connection.next();
			expect(error).toMatchObject({
				type: "error",
				in_reply_to: null,
				error: { code: "protocol_error", details: null },
			});
			expect(JSON.stringify(error)).not.toContain(root);
			await expectFailed(connection.task, 500);
		});
	}

	for (const reason of ["EOF", "revocation"] as const) {
		test(`${reason} interrupts an actually blocked writable without waiting for its timeout`, async () => {
			const { root, runId } = fixture();
			const started = Promise.withResolvers<void>();
			const blocked = Promise.withResolvers<void>();
			const output = new WritableStream<Uint8Array>({
				write() {
					started.resolve();
					return blocked.promise;
				},
			});
			const connection = transport(root, runId, { output, writeTimeoutMs: 5000 });
			connection.send(hello());
			await withTimeout(started.promise, 1000, "Output did not start");
			if (reason === "EOF") connection.input.close();
			else connection.abort.abort();
			await withTimeout(connection.task, 500, "Blocked writer retained source");
			blocked.resolve();
		});
		test(`${reason} interrupts an in-flight trusted authorization callback`, async () => {
			const { root, runId } = fixture();
			const started = Promise.withResolvers<void>();
			const blocked = Promise.withResolvers<void>();
			const connection = transport(root, runId, {
				assertAuthorized: () => {
					started.resolve();
					return blocked.promise;
				},
			});
			connection.send(hello());
			await withTimeout(started.promise, 1000, "Authorization did not start");
			if (reason === "EOF") connection.input.close();
			else connection.abort.abort();
			await withTimeout(connection.task, 500, "Authorization retained source");
			blocked.resolve();
		});
	}

	test("a no-consumer writable has a real deadline and only one pending frame", async () => {
		const { root, runId } = fixture();
		let writes = 0;
		const blocked = Promise.withResolvers<void>();
		const output = new WritableStream<Uint8Array>({
			write() {
				writes++;
				return blocked.promise;
			},
		});
		const connection = transport(root, runId, { output, writeTimeoutMs: 30 });
		connection.send(hello());
		await expectFailed(connection.task, 500);
		expect(writes).toBe(1);
		blocked.resolve();
	});

	test("the output ceiling counts UTF-8 bytes, not characters, before writing a snapshot page", async () => {
		const { root, runId, db, producer } = fixture();
		const record = producer.snapshot(sourceId, runId).records.find(value => value.kind === "run");
		if (!record || record.kind !== "run") throw new Error("No Host Run publication");
		const replacement = {
			...record,
			value: { ...record.value, revision: "2", additive_label: "界".repeat(800000) },
		};
		db.transaction(() => producer.publish(sourceId, [replacement], new Date().toISOString()))();
		const connection = transport(root, runId);
		connection.send(hello());
		await connection.next();
		connection.send(subscribe(runId));
		let rejected = false;
		for (let count = 0; count < 20; count++) {
			const value = await connection.next();
			expect(encoder.encode(`${JSON.stringify(value)}\n`).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
			if (value.type === "error") {
				expect(value.error.code).toBe("protocol_error");
				rejected = true;
				break;
			}
		}
		expect(rejected).toBe(true);
		await expectFailed(connection.task, 1000);
	});

	test("live profile permission revocation closes the source without repairing permissions", async () => {
		const { root, runId } = fixture();
		const connection = transport(root, runId);
		connection.send(hello());
		await connection.next();
		connection.send(subscribe(runId));
		await ready(connection, consumer(runId));
		fs.chmodSync(root, 0o755);
		const pending = connection.next();
		await expectFailed(connection.task, 1000);
		expect(await pending).toMatchObject({ type: "error", error: { code: "protocol_error", details: null } });
		expect(fs.statSync(root).mode & 0o777).toBe(0o755);
		fs.chmodSync(root, 0o700);
	});

	for (const executionRecords of [false, true]) {
		test(`the real Bun launcher streams negotiated observation with execution flag ${executionRecords}`, async () => {
			const { root, runId, store, message } = executionRecords
				? consultationFixture()
				: { ...fixture(), message: null };
			const owner = store.claimHost()!;
			store.schedule(runId, owner.owner_id, owner.epoch);
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "../src/graph/wire-observer.ts"),
					...(executionRecords ? ["--execution-records"] : []),
					root,
					sourceId,
					runId,
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			cleanups.push(async () => {
				child.kill();
				await child.exited;
			});
			const lines = readLines(child.stdout);
			const next = async (): Promise<GraphWireReadFrame> => {
				const result = await withTimeout(lines.next(), 5000, "Subprocess emitted no frame");
				if (result.done) throw new Error("Subprocess closed early");
				return JSON.parse(new TextDecoder().decode(result.value)) as GraphWireReadFrame;
			};
			child.stdin.write(`${JSON.stringify(hello())}\n${JSON.stringify(subscribe(runId))}\n`);
			await child.stdin.flush();
			expect(await next()).toMatchObject({
				type: "hello",
				extensions: executionRecords ? [GRAPH_WIRE_EXECUTION_EXTENSION] : [],
			});
			const state = consumer(runId, executionRecords ? [GRAPH_WIRE_EXECUTION_EXTENSION] : []);
			await ready({ next }, state);
			const records = state.read().sources[0].records;
			expect(records.every(record => record.value.graph_run_id === runId)).toBe(true);
			expect(records.some(record => record.kind === "execution_invocation")).toBe(executionRecords);
			expect(records.some(record => record.kind === "execution_attempt" || record.kind === "binding")).toBe(false);
			if (message) {
				const request = detail(runId, message.content_ref.id);
				child.stdin.write(`${JSON.stringify(request)}\n`);
				await child.stdin.flush();
				expect(await reply({ next }, request.message_id, state)).toMatchObject({
					type: "graph.artifact",
					availability: "available",
					content: message.text,
				});
			}
			child.stdin.end();
			expect(await withTimeout(child.exited, 2000, "Subprocess survived stdin EOF")).toBe(0);
			expect(await new Response(child.stderr).text()).toBe("");
			await lines.return(undefined);
		}, 10000);
	}

	for (const flags of [
		["--unknown-private-flag"],
		["--execution-records=true"],
		["--execution-records", "--execution-records"],
		["late"],
	]) {
		test(`the launcher rejects unsupported or misplaced flags ${flags.join(" ")}`, async () => {
			const { root, runId } = fixture();
			const argv =
				flags[0] === "late" ? [root, sourceId, runId, "--execution-records"] : [...flags, root, sourceId, runId];
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "../src/graph/wire-observer.ts"), ...argv],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			cleanups.push(async () => {
				child.kill();
				await child.exited;
			});
			expect(await withTimeout(child.exited, 5000, "Invalid launcher retained source")).toBe(1);
			expect(await new Response(child.stdout).text()).toBe("");
			expect(await new Response(child.stderr).text()).toBe("Graph wire observation unavailable\n");
		}, 10000);
	}
});

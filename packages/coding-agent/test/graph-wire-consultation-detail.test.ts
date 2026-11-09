import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConsultationMessage } from "../src/graph/consultation";
import { GraphRunStore, type GraphPreparedRun, type GraphStartRequest } from "../src/graph/store";
import { GraphWireConsultationDetailReader } from "../src/graph/wire-consultation-detail";
import { GraphWireLedger } from "../src/graph/wire-ledger";
import { GraphWireReadBridge, type GraphWireReadFrame } from "../src/graph/wire-read-bridge";
import { graphWireRecordKey } from "@oh-my-pi/pi-wire/graph/wire-records";
import { GraphWireError, type GraphWireRecord } from "@oh-my-pi/pi-wire/graph";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const ref = (id: string) => ({ id, digest: `sha256:${id}` });
const unknown = { availability: "unknown", media_type: null, content: null } as const;
const missing = { availability: "missing", media_type: null, content: null } as const;

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-consultation-detail-"));
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
			content: `---
format: omp.graph/v1
name: consultation-detail
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
Work.
`,
		},
	});
	if (imported.error) throw new Error(imported.error.message);
	const definition = store.definitions.get(imported.target_id!)!;
	const request: GraphStartRequest = {
		version: 1,
		request_key: "run",
		operation: "start",
		target_id: definition.graph_id,
		if_revision: definition.revision,
		payload: { inputs: {}, authorization_ref: ref("authorization") },
	};
	const member = {
		provider: "provider",
		model: "model",
		configuration_revision: "7",
		base: "isolated" as const,
		base_snapshot_ref: ref("base"),
		role_ref: ref("role"),
		skill_refs: [],
		rule_refs: [],
	};
	const prepared: GraphPreparedRun = {
		graph_id: definition.graph_id,
		definition_revision: definition.revision,
		definition_digest: definition.digest,
		authorization_ref: ref("authorization"),
		inputs: {},
		executors: {},
		members: { researcher: member, reviewer: structuredClone(member) },
		observation: {
			source_id: "graph-source",
			members: {
				researcher: {
					bot: { source_id: "research-source", profile_id: "profile", bot_id: "research-bot" },
					config_revision: "3",
					model_binding_ref: ref("research-model"),
				},
				reviewer: {
					bot: { source_id: "review-source", profile_id: "profile", bot_id: "review-bot" },
					config_revision: "1",
					model_binding_ref: ref("review-model"),
				},
			},
		},
	};
	const filename = path.join(root, "graphs.sqlite");
	const db = new Database(filename);
	cleanups.push(() => db.close());
	const ledger = new GraphWireLedger(db, { readOnly: true });
	const service = store.configureConsultation({
		validate: () => true,
		policy: () => ({ max_rounds: 2, timeout_ms: 60000 }),
		artifacts: () => true,
		reserve: () => true,
		participant: () => true,
	});
	function start(requestKey: string, sourceId = "graph-source", text = "Exact **private** request.\n雪 🦉") {
		const trusted = structuredClone(prepared);
		trusted.observation!.source_id = sourceId;
		const started = store.start({ ...request, request_key: requestKey }, trusted);
		if (started.error) throw new Error(started.error.message);
		const runId = started.target_id!;
		const requester = {
			run_id: runId,
			member_id: "researcher",
			invocation_id: `invocation-${requestKey}`,
			attempt_id: `attempt-${requestKey}`,
			fence: "trusted-test-host",
		};
		const asked = service.ask(requester, { to_member: "reviewer", text, request_key: "ask" });
		if (!asked.ok) throw new Error(asked.error);
		const message = service.messages(asked.value.conversation_id)[0]!;
		return { sourceId, runId, requester, message, text };
	}
	const initial = start("initial");
	return {
		...initial,
		db,
		filename,
		store,
		service,
		ledger,
		start,
		reader: new GraphWireConsultationDetailReader(db),
	};
}

function scopeDenial(action: () => unknown): GraphWireError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(GraphWireError);
		expect((error as GraphWireError).code).toBe("scope_denied");
		return error as GraphWireError;
	}
	throw new Error("Expected scope denial");
}

it("reads exact published request and final message text through real consultation publication", () => {
	const { reader, sourceId, runId, message, text, service, requester, ledger } = fixture();
	const published = ledger.snapshot(sourceId, runId).records.find(record => record.kind === "execution_conversation");
	expect(published).toMatchObject({
		value: { content_ref: message.content_ref.id, message_refs: [message.content_ref.id] },
	});
	expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual({
		availability: "available",
		media_type: "text/markdown",
		content: text,
	});
	service.activate(message.conversation_id);
	const finished = service.finish(
		{ ...requester, member_id: "reviewer", invocation_id: "review-invocation", attempt_id: "review-attempt" },
		{ conversation_id: message.conversation_id, text: "Final **answer**.\n", request_key: "finish" },
	);
	if (!finished.ok) throw new Error(finished.error);
	const finalMessage = service.messages(message.conversation_id).at(-1)!;
	expect(reader.read(sourceId, runId, finalMessage.content_ref.id)).toEqual({
		availability: "available",
		media_type: "text/markdown",
		content: finalMessage.text,
	});
});

it("does not distinguish foreign Run/source references from unpublished consultation references", () => {
	const { reader, sourceId, runId, message, start } = fixture();
	const sameSource = start("second");
	const otherSource = start("foreign", "other-graph-source", "foreign private text");
	const absent = scopeDenial(() => reader.read(sourceId, runId, `${message.content_ref.id}-not-published`));
	for (const foreign of [sameSource, otherSource]) {
		const denied = scopeDenial(() => reader.read(sourceId, runId, foreign.message.content_ref.id));
		expect({ code: denied.code, message: denied.message }).toEqual({ code: absent.code, message: absent.message });
	}
	scopeDenial(() => reader.read(otherSource.sourceId, runId, message.content_ref.id));
	scopeDenial(() => reader.read(sourceId, otherSource.runId, otherSource.message.content_ref.id));
});

it("does not expose protected Run snapshots through the consultation reader", () => {
	const { reader, sourceId, runId, store } = fixture();
	expect(reader.read(sourceId, runId, store.getRun(runId)!.snapshot_ref.id)).toEqual(unknown);
});

it.each(["message", "conversation"] as const)("reports missing when the declared %s is absent", kind => {
	const { db, reader, sourceId, runId, message } = fixture();
	if (kind === "message") db.query("DELETE FROM consultation_messages WHERE message_id=?").run(message.message_id);
	else db.query("DELETE FROM consultations WHERE id=?").run(message.conversation_id);
	expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual(missing);
});

it.each([
	["changed text", (message: ConsultationMessage) => ({ ...message, text: "tampered text" })],
	[
		"wrong ref",
		(message: ConsultationMessage) => ({
			...message,
			content_ref: { ...message.content_ref, id: `${message.content_ref.id}-other` },
		}),
	],
	["wrong conversation", (message: ConsultationMessage) => ({ ...message, conversation_id: "another-conversation" })],
	["wrong message", (message: ConsultationMessage) => ({ ...message, message_id: "another-message" })],
	["wrong sender", (message: ConsultationMessage) => ({ ...message, sender_member: "foreign-member" })],
	["non-text content", (message: ConsultationMessage) => ({ ...message, text: { credentials: "never return" } })],
] as const)("withholds content for %s", (_label, corrupt) => {
	const { db, reader, sourceId, runId, message } = fixture();
	db.query("UPDATE consultation_messages SET data=? WHERE message_id=?").run(
		JSON.stringify(corrupt(message)),
		message.message_id,
	);
	expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual(unknown);
});

it.each(["column", "json"] as const)("rejects a corrupt persisted consultation Run identity in %s", kind => {
	const { db, reader, sourceId, runId, message } = fixture();
	if (kind === "column")
		db.query("UPDATE consultations SET run_id=? WHERE id=?").run("foreign-run", message.conversation_id);
	else
		db.query("UPDATE consultations SET data=json_set(data,'$.run_id',?) WHERE id=?").run(
			"foreign-run",
			message.conversation_id,
		);
	expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual(unknown);
});

it.each(["run", "execution_conversation"] as const)("fails closed for malformed or foreign %s wire data", kind => {
	const { db, reader, sourceId, runId, message, ledger } = fixture();
	const record = ledger.snapshot(sourceId, runId).records.find(record => record.kind === kind)!;
	const key = graphWireRecordKey(record);
	const foreign: GraphWireRecord = structuredClone(record);
	foreign.value.graph_run_id = "foreign-run";
	db.query("UPDATE graph_wire_current SET data=? WHERE source_id=? AND record_key=?").run(
		JSON.stringify(foreign),
		sourceId,
		key,
	);
	expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual(unknown);
	db.query("UPDATE graph_wire_current SET data=? WHERE source_id=? AND record_key=?").run("{not-json", sourceId, key);
	if (kind === "run") expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual(unknown);
	else scopeDenial(() => reader.read(sourceId, runId, message.content_ref.id));
});

it("rejects a valid message placed under a different conversation instead of looking it up by prefix", () => {
	const { db, reader, sourceId, runId, message, start } = fixture();
	const foreign = start("foreign");
	db.query("UPDATE consultation_messages SET conversation_id=? WHERE message_id=?").run(
		foreign.message.conversation_id,
		message.message_id,
	);
	expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual(missing);
});

it("withholds content when the persisted source journal identity is corrupt", () => {
	const { db, reader, sourceId, runId, message } = fixture();
	db.query("UPDATE graph_wire_sources SET journal_id='' WHERE source_id=?").run(sourceId);
	expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual(unknown);
});

it("performs no writes and works on an existing read-only database", () => {
	const { filename, sourceId, runId, message, text } = fixture();
	const readonly = new Database(filename, { readonly: true });
	try {
		const schema = readonly.query("SELECT name,sql FROM sqlite_master ORDER BY name").all();
		const before = readonly.query("SELECT total_changes() AS changes").get();
		const reader = new GraphWireConsultationDetailReader(readonly);
		expect(reader.read(sourceId, runId, message.content_ref.id)).toEqual({
			availability: "available",
			media_type: "text/markdown",
			content: text,
		});
		expect(reader.read(sourceId, runId, "/not-a-content-reader")).toEqual(unknown);
		expect(readonly.query("SELECT total_changes() AS changes").get()).toEqual(before);
		expect(readonly.query("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
	} finally {
		readonly.close();
	}
});

it("never installs schema over an empty read-only database", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-detail-empty-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const filename = path.join(root, "empty.sqlite");
	new Database(filename).close();
	const db = new Database(filename, { readonly: true });
	try {
		const reader = new GraphWireConsultationDetailReader(db);
		expect(reader.read("source", "run", "consultation-message:missing")).toEqual(unknown);
		expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]);
		expect(db.query("SELECT total_changes() AS changes").get()).toEqual({ changes: 0 });
	} finally {
		db.close();
	}
});

it("releases consultation text only after negotiated source support and both authorization checks", async () => {
	const { ledger, reader, sourceId, runId, message, text } = fixture();
	const extension = "graph.execution.v1";
	let enabled = true;
	let revokeAfterRead = false;
	let checks = 0;
	const source = {
		source_id: sourceId,
		kind: "graph" as const,
		profile_id: null,
		bot_id: null,
		capabilities: [extension],
	};
	const bridge = new GraphWireReadBridge(ledger, {
		principal: "viewer",
		catalog: () => (enabled ? { generation: "grant-1", sources: [source] } : null),
		authorize: (_principal, scope) => {
			checks++;
			if (revokeAfterRead && checks % 2 === 0) enabled = false;
			return enabled && scope.graph_run_id === runId ? { generation: "grant-1" } : null;
		},
		maxSubscriptions: 1,
		maxPageTokens: 1,
		pageSize: 10,
		extensions: [extension],
		consultationDetails: reader,
	});
	const collect = async (input: AsyncIterable<GraphWireReadFrame>) => {
		const frames: GraphWireReadFrame[] = [];
		for await (const frame of input) frames.push(frame);
		return frames;
	};
	await collect(
		bridge.handle({
			protocol: "omp.graph.v1",
			type: "hello",
			message_id: "hello",
			supported_protocols: ["omp.graph.v1"],
			extensions: [extension],
		}),
	);
	const request = {
		protocol: "omp.graph.v1",
		type: "graph.artifact.get",
		message_id: "detail",
		source_id: sourceId,
		graph_run_id: runId,
		ref: message.content_ref.id,
		page_token: null,
		limit: 1,
	};
	expect(await collect(bridge.handle(request))).toMatchObject([
		{
			type: "graph.artifact",
			ref: message.content_ref.id,
			availability: "available",
			media_type: "text/markdown",
			content: text,
			next_page_token: null,
		},
	]);
	revokeAfterRead = true;
	const denied = await collect(bridge.handle(request));
	expect(denied).toMatchObject([{ type: "error", error: { code: "scope_denied" } }]);
	expect(JSON.stringify(denied)).not.toContain(text);
});

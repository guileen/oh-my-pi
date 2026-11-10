import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { GraphDefinition } from "../src/graph/contracts";
import { validateGraphDefinition } from "../src/graph/definition";
import { MAX_PULSES, projectGraphPulses } from "../src/graph/observation-pulses";

const LIMITS = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const CONTENT = `---
format: omp.graph/v1
name: handoff
members:
  writer:
    role: '#writer-role'
    model: test
    base: omp-default
    duty: general
    permissions: {read: [], write: [], execute: []}
  reviewer:
    role: '#reviewer-role'
    model: test
    base: omp-default
    duty: review
    permissions: {read: [], write: [], execute: []}
nodes:
  draft: {kind: bot, member: writer, task: '#draft', outputs: {draft: {media_type: text/markdown, required: true}}}
  review: {kind: bot, member: reviewer, task: '#review', required_inputs: [draft]}
edges:
  - {id: handoff, from: draft, to: review}
---
## writer-role
Write.
## reviewer-role
Review.
## draft
Write.
## review
Review.
`;

function definition(): GraphDefinition {
	const validation = validateGraphDefinition(CONTENT, LIMITS);
	if (validation.issues.length) throw new Error(JSON.stringify(validation.issues));
	return validation.source.frontmatter.frontmatter as unknown as GraphDefinition;
}

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function open() {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(`CREATE TABLE graph_bot_handoffs (intent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
		CREATE TABLE consultations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, deadline INTEGER NOT NULL, data TEXT NOT NULL);
		CREATE TABLE consultation_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);`);
	return db;
}

const run = {
	id: "run-1",
	graph_id: "graph-1",
	revision: "1",
	definition_revision: "1",
	state: "running" as const,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
};
const invocation = (node: string, attempt_id: string | undefined, superseded = false) => ({
	id: `inv-${attempt_id ?? node}`,
	node,
	state: "running" as const,
	iteration: 0,
	scope_id: "run",
	attempt_id,
	superseded,
	consultation: undefined,
	outcome: null,
});

function handoff(
	db: Database,
	intent: string,
	rows: { edge: string; from: string; to: string; receipt: boolean; at: string }[],
	runId = "run-1",
) {
	db.query("INSERT INTO graph_bot_handoffs VALUES (?,?,?)").run(
		intent,
		runId,
		JSON.stringify({
			intent_id: intent,
			run_id: runId,
			invocation_id: "inv",
			attempt_id: rows[0].to,
			fence: "f",
			request_key: intent,
			bot_id: "bot",
			input: "",
			handoffs: rows.map(row => ({
				edge_id: row.edge,
				from_binding_id: row.from,
				artifact: { source_id: "s", profile_id: "p", bot_id: "b", artifact_id: row.edge, job_id: "j" },
				reference: row.edge,
			})),
			receipt: rows[0].receipt ? { job_id: "j", bot_id: "bot" } : null,
			occurred_at: rows[0].at,
		}),
	);
}

function message(db: Database, conversation: string, id: string, overrides: Record<string, unknown> = {}) {
	db.query("INSERT INTO consultation_messages (conversation_id, message_id, data) VALUES (?,?,?)").run(
		conversation,
		id,
		JSON.stringify({
			conversation_id: conversation,
			message_id: id,
			in_reply_to: null,
			kind: "question",
			sender_member: "writer",
			recipient_member: "reviewer",
			content_ref: { id: "ref", digest: "sha256:x" },
			text: "private text",
			artifact_refs: [],
			sender_attempt_id: "attempt-draft",
			...overrides,
		}),
	);
}

describe("bounded Graph activity pulses", () => {
	it("projects a delivered handoff between live attempts onto its edge", () => {
		const db = open();
		db.query("INSERT INTO consultations VALUES (?,?,?,?,?)").run("c1", "run-1", "open", 0, "{}");
		handoff(db, "intent-1", [
			{
				edge: "handoff",
				from: "attempt-draft",
				to: "attempt-review",
				receipt: true,
				at: "2026-01-01T00:00:05.000Z",
			},
		]);
		const pulses = projectGraphPulses(db, "run-1", definition(), {
			run,
			invocations: [invocation("draft", "attempt-draft"), invocation("review", "attempt-review")],
		});
		expect(pulses.transfers).toEqual([
			{
				edge_id: "handoff",
				from: "draft",
				to: "review",
				state: "delivered",
				occurred_at: "2026-01-01T00:00:05.000Z",
			},
		]);
		expect(pulses.messages).toEqual([]);
	});

	it("omits pulsing activity once its attempt is superseded or its edge is unknown", () => {
		const db = open();
		handoff(db, "intent-1", [
			{
				edge: "handoff",
				from: "attempt-draft",
				to: "attempt-review",
				receipt: false,
				at: "2026-01-01T00:00:05.000Z",
			},
		]);
		handoff(db, "intent-2", [
			{
				edge: "missing",
				from: "attempt-draft",
				to: "attempt-review",
				receipt: true,
				at: "2026-01-01T00:00:06.000Z",
			},
		]);
		expect(
			projectGraphPulses(db, "run-1", definition(), {
				run,
				invocations: [invocation("draft", "attempt-draft"), invocation("review", "attempt-review", true)],
			}).transfers,
		).toEqual([]);
		expect(
			projectGraphPulses(db, "run-1", definition(), {
				run,
				invocations: [invocation("draft", "attempt-draft"), invocation("review", "attempt-review")],
			}).transfers,
		).toEqual([
			{ edge_id: "handoff", from: "draft", to: "review", state: "unknown", occurred_at: "2026-01-01T00:00:05.000Z" },
		]);
	});

	it("projects consultation activity without text, conversation identity, or superseded senders", () => {
		const db = open();
		db.query("INSERT INTO consultations VALUES (?,?,?,?,?)").run("c1", "run-1", "open", 0, "{}");
		message(db, "c1", "m1", { kind: "request" });
		message(db, "c1", "m2", {
			kind: "reply",
			sender_member: "reviewer",
			recipient_member: "writer",
			sender_attempt_id: "attempt-review",
		});
		message(db, "c1", "m3", { kind: "question", sender_attempt_id: "attempt-gone" });
		message(db, "c1", "m4", { kind: "question", sender_member: "stranger" });
		const pulses = projectGraphPulses(db, "run-1", definition(), {
			run,
			invocations: [invocation("draft", "attempt-draft"), invocation("review", "attempt-review")],
		});
		expect(pulses.messages).toEqual([
			{ from: "writer", to: "reviewer", kind: "request", ordinal: 0 },
			{ from: "reviewer", to: "writer", kind: "reply", ordinal: 1 },
		]);
		expect(JSON.stringify(pulses)).not.toContain("private text");
		expect(JSON.stringify(pulses)).not.toContain("c1");
	});

	it("keeps only the latest bounded tail of activity", () => {
		const db = open();
		for (let index = 0; index <= MAX_PULSES; index++)
			handoff(db, `intent-${index}`, [
				{
					edge: "handoff",
					from: "attempt-draft",
					to: "attempt-review",
					receipt: true,
					at: `2026-01-01T00:00:00.${String(index).padStart(3, "0")}Z`,
				},
			]);
		const pulses = projectGraphPulses(db, "run-1", definition(), {
			run,
			invocations: [invocation("draft", "attempt-draft"), invocation("review", "attempt-review")],
		});
		expect(pulses.transfers).toHaveLength(MAX_PULSES);
		expect(pulses.transfers.at(-1)?.occurred_at).toBe(`2026-01-01T00:00:00.${String(MAX_PULSES).padStart(3, "0")}Z`);
	});

	it("treats a missing activity table as no recorded activity", () => {
		const db = new Database(":memory:");
		databases.push(db);
		expect(
			projectGraphPulses(db, "run-1", definition(), {
				run,
				invocations: [invocation("draft", "attempt-draft")],
			}),
		).toEqual({ transfers: [], messages: [] });
	});

	it("treats an earlier activity table shape as no recorded activity", () => {
		// A foreign or older writer can leave tables without the columns this
		// projection orders by. Observation degrades; it never fails the view.
		const db = new Database(":memory:");
		databases.push(db);
		db.exec(`CREATE TABLE graph_bot_handoffs (intent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
			CREATE TABLE consultations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
			CREATE TABLE consultation_messages (conversation_id TEXT, message_id TEXT, data TEXT);
			INSERT INTO consultations VALUES ('c1','run-1','{}');
			INSERT INTO consultation_messages VALUES ('c1','m1','{"kind":"question","sender_member":"writer","recipient_member":"reviewer","sender_attempt_id":"attempt-draft"}');`);
		expect(
			projectGraphPulses(db, "run-1", definition(), {
				run,
				invocations: [invocation("draft", "attempt-draft")],
			}),
		).toEqual({ transfers: [], messages: [] });
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphWireLedger, GraphWireLedgerError } from "../src/graph/wire-ledger";
import { GraphWireError, type GraphCursor, type GraphWireRecord } from "@oh-my-pi/pi-wire/graph";

const time = "2026-11-05T10:00:00.000Z";
const bot = { source_id: "bot-source", profile_id: "profile", bot_id: "bot" };
const databases = new Set<Database>();
const roots: string[] = [];

function open(filename = ":memory:") {
	const db = new Database(filename);
	databases.add(db);
	const ledger = new GraphWireLedger(db);
	const zero = ledger.registerSource("host");
	return { db, ledger, zero };
}

function publish(db: Database, ledger: GraphWireLedger, records: GraphWireRecord[], sourceId = "host") {
	return db.transaction(() => ledger.publish(sourceId, records, time)).immediate();
}

function run(id = "run"): Extract<GraphWireRecord, { kind: "run" }> {
	return {
		kind: "run",
		value: {
			graph_id: "graph",
			graph_run_id: id,
			definition_revision: "1",
			definition: {
				nodes: ["write", "review"].map(node_id => ({
					node_id,
					label: node_id,
					bot: { ...bot },
					config_revision: "config-1",
					acceptance_ref: null,
				})),
				edges: [{ edge_id: "review-edge", from_node_id: "write", to_node_id: "review", condition_ref: null }],
			},
			revision: "1",
			created_at: time,
		},
	};
}

function binding(id = "binding", runId = "run"): Extract<GraphWireRecord, { kind: "binding" }> {
	return {
		kind: "binding",
		value: {
			binding_id: id,
			graph_run_id: runId,
			node_id: "write",
			invocation_id: "item",
			attempt: 1,
			job: { ...bot, job_id: `job-${id}` },
			config_revision: "config-1",
			revision: "1",
			acceptance: "pending",
			evidence_refs: [],
			reason: null,
		},
	};
}

function expectError(
	action: () => unknown,
	code: GraphWireError["code"],
	availability?: GraphWireLedgerError["availability"],
) {
	let caught: unknown;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(GraphWireError);
	expect((caught as GraphWireError).code).toBe(code);
	if (availability !== undefined) expect((caught as GraphWireLedgerError).availability).toBe(availability);
}

afterEach(() => {
	for (const db of databases) db.close();
	databases.clear();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Graph complete-record wire ledger", () => {
	it("requires explicit source registration and a caller-owned transaction shared with host writes", () => {
		const db = new Database(":memory:");
		databases.add(db);
		const ledger = new GraphWireLedger(db);
		expectError(() => ledger.snapshot("host"), "invalid_cursor");
		expectError(() => ledger.registerSource(""), "invalid_input");
		const zero = ledger.registerSource("host");
		expect(ledger.snapshot("host")).toEqual({ records: [], cursor: zero });
		expectError(() => ledger.publish("host", [run()], time), "invalid_input");
		expectError(() => publish(db, ledger, [run()], "unregistered"), "invalid_cursor");
		db.exec("CREATE TABLE host_facts(value TEXT NOT NULL)");
		expect(() =>
			db.transaction(() => {
				db.query("INSERT INTO host_facts VALUES (?)").run("rolled-back");
				ledger.publish("host", [run()], time);
				throw new Error("host mutation rejected");
			})(),
		).toThrow("host mutation rejected");
		expect(db.query("SELECT * FROM host_facts").all()).toEqual([]);
		expect(ledger.snapshot("host")).toEqual({ records: [], cursor: zero });
		expect(ledger.events("host", { after: zero }).events).toEqual([]);
		const event = db
			.transaction(() => {
				db.query("INSERT INTO host_facts VALUES (?)").run("committed");
				return ledger.publish("host", [run()], time);
			})
			.immediate()!;
		expect(event.cursor.seq).toBe("1");
		expect(db.query("SELECT value FROM host_facts").get()).toEqual({ value: "committed" });
		expect(ledger.snapshot("host").cursor).toEqual(event.cursor);
	});

	it("reads committed Host facts from a read-only connection without creating or publishing history", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-wire-reader-"));
		roots.push(root);
		const filename = path.join(root, "wire.sqlite");
		const host = open(filename);
		const first = publish(host.db, host.ledger, [run()])!;
		const db = new Database(filename, { readonly: true });
		databases.add(db);
		const reader = new GraphWireLedger(db, { readOnly: true });
		expect(reader.snapshot("host", "run").cursor).toEqual(first.cursor);
		const updated = run();
		updated.value.revision = "2";
		const second = publish(host.db, host.ledger, [updated])!;
		expect(reader.events("host", { after: first.cursor }).events).toEqual([second]);
		expect(reader.stateAt("host", "run", first.cursor).records).toEqual([run()]);
		expectError(() => reader.registerSource("foreign"), "scope_denied");
		expectError(() => db.transaction(() => reader.publish("host", [updated], time))(), "scope_denied");
		const empty = new Database(":memory:");
		databases.add(empty);
		expectError(() => new GraphWireLedger(empty, { readOnly: true }), "capability_unavailable", "missing");
		expect(empty.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
	});

	it("persists journal identity, event identity, current records and exact history across reopen", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-wire-ledger-"));
		roots.push(root);
		const filename = path.join(root, "wire.sqlite");
		const first = open(filename);
		const initial = publish(first.db, first.ledger, [binding(), run()])!;
		const accepted = binding();
		accepted.value.revision = "2";
		accepted.value.acceptance = "accepted";
		accepted.value.evidence_refs = ["artifact:accepted"];
		const second = publish(first.db, first.ledger, [accepted])!;
		first.db.close();
		databases.delete(first.db);

		const reopened = open(filename);
		expect(reopened.zero).toEqual(second.cursor);
		expect(new GraphWireLedger(reopened.db).registerSource("host")).toEqual(second.cursor);
		expect(reopened.ledger.events("host", { after: first.zero }).events).toEqual([initial, second]);
		expect(reopened.ledger.stateAt("host", "run", initial.cursor).records).toContainEqual(binding());
		expect(reopened.ledger.stateAt("host", "run", initial.cursor).records).not.toContainEqual(accepted);
		expect(reopened.ledger.snapshot("host").records).toContainEqual(accepted);
		expect(publish(reopened.db, reopened.ledger, [accepted, run()])).toBeNull();
		const later = binding("retry");
		later.value.attempt = 2;
		expect(publish(reopened.db, reopened.ledger, [later])!.cursor).toEqual({ ...first.zero, seq: "3" });
	});

	it("validates final complete images independent of batch order, including dependencies and transfers", () => {
		const { db, ledger } = open();
		const from = binding("from");
		const to = binding("to");
		to.value.node_id = "review";
		const evidence = { source: { ...bot }, job_id: from.value.job.job_id, artifact_id: "artifact", ref: null };
		const transfer: GraphWireRecord = {
			kind: "transfer",
			value: {
				transfer_id: "transfer",
				graph_run_id: "run",
				edge_id: "review-edge",
				from_binding_id: "from",
				to_binding_id: "to",
				artifact: evidence,
				revision: "1",
				state: "pending",
				reason: null,
				occurred_at: time,
			},
		};
		const dependency: GraphWireRecord = {
			kind: "dependency",
			value: {
				dependency_id: "dependency",
				graph_run_id: "run",
				edge_id: "review-edge",
				target_invocation_id: "item",
				target_attempt: 1,
				revision: "1",
				state: "waiting",
				reason: null,
				evidence: [evidence],
			},
		};
		const records = [transfer, dependency, to, from, run()];
		const event = publish(db, ledger, records)!;
		expect(event.records).toEqual(records);
		expect(ledger.snapshot("host").records).toHaveLength(5);
		expect(ledger.stateAt("host", "run", event.cursor).records).toEqual(records);
	});

	it("rejects an entire bad binding batch without consuming a sequence or persisting its Run", () => {
		const { db, ledger, zero } = open();
		const bad = binding();
		bad.value.node_id = "missing-node";
		expectError(() => publish(db, ledger, [run(), bad]), "invalid_input");
		expect(ledger.snapshot("host")).toEqual({ records: [], cursor: zero });
		expect(ledger.events("host", { after: zero }).events).toEqual([]);
		const valid = publish(db, ledger, [binding(), run()])!;
		expect(valid.cursor.seq).toBe("1");

		const orphan = binding("orphan");
		orphan.value.graph_run_id = "unknown-run";
		const change = binding();
		change.value.revision = "2";
		change.value.acceptance = "accepted";
		expectError(() => publish(db, ledger, [change, orphan]), "invalid_input");
		expect(ledger.snapshot("host").cursor).toEqual(valid.cursor);
		expect(ledger.snapshot("host").records).toContainEqual(binding());
	});

	it("rolls back its savepoint if event persistence fails even when the host catches that failure", () => {
		const { db, ledger } = open();
		const initial = publish(db, ledger, [run(), binding()])!;
		db.exec(`CREATE TRIGGER reject_wire_event BEFORE INSERT ON graph_wire_events
			BEGIN SELECT RAISE(ABORT, 'journal write rejected'); END`);
		const changed = binding();
		changed.value.revision = "2";
		changed.value.acceptance = "accepted";
		db.transaction(() => {
			expect(() => ledger.publish("host", [changed], time)).toThrow("journal write rejected");
		})();
		expect(ledger.snapshot("host").cursor).toEqual(initial.cursor);
		expect(ledger.snapshot("host").records).toContainEqual(binding());
		expect(ledger.events("host", { after: initial.cursor }).events).toEqual([]);
	});

	it("ignores duplicate and stale replacements but rejects same-revision conflicting values", () => {
		const { db, ledger, zero } = open();
		const original = binding();
		original.value.revision = "3";
		const initial = publish(db, ledger, [run(), original])!;
		expect(publish(db, ledger, [run(), structuredClone(original)])).toBeNull();
		const older = binding();
		older.value.revision = "2";
		older.value.acceptance = "rejected";
		expect(publish(db, ledger, [older])).toBeNull();
		const staleIdentity = binding();
		staleIdentity.value.revision = "2";
		staleIdentity.value.job.job_id = "stale-job";
		staleIdentity.value.config_revision = "stale-config";
		staleIdentity.value.acceptance = "pending";
		expect(publish(db, ledger, [staleIdentity])).toBeNull();
		expect(ledger.snapshot("host").records).toContainEqual(original);
		expect(publish(db, ledger, [])).toBeNull();
		const conflict = structuredClone(original);
		conflict.value.reason = "different same-revision data";
		expectError(() => publish(db, ledger, [conflict]), "protocol_error");
		expect(ledger.snapshot("host").cursor).toEqual(initial.cursor);
		expect(ledger.events("host", { after: zero }).events).toEqual([initial]);
	});

	it("freezes Run definitions and Binding key, Job, configuration and attempt tuple", () => {
		const { db, ledger } = open();
		const initial = publish(db, ledger, [run(), binding()])!;
		const relabeled = run();
		relabeled.value.revision = "2";
		relabeled.value.definition.nodes[0]!.label = "rewritten history";
		expectError(() => publish(db, ledger, [relabeled]), "binding_conflict");
		const definitionRevision = run();
		definitionRevision.value.revision = "2";
		definitionRevision.value.definition_revision = "2";
		expectError(() => publish(db, ledger, [definitionRevision]), "binding_conflict");
		for (const field of ["job", "config", "node", "run", "invocation", "attempt"]) {
			const changed = binding();
			changed.value.revision = "2";
			if (field === "job") changed.value.job.job_id = "different-job";
			if (field === "config") changed.value.config_revision = "config-2";
			if (field === "node") changed.value.node_id = "review";
			if (field === "run") changed.value.graph_run_id = "different-run";
			if (field === "invocation") changed.value.invocation_id = "different-invocation";
			if (field === "attempt") changed.value.attempt = 2;
			expectError(() => publish(db, ledger, [changed]), "binding_conflict");
		}
		const duplicateTuple = binding("duplicate");
		expectError(() => publish(db, ledger, [duplicateTuple]), "binding_conflict");
		expect(ledger.snapshot("host").cursor).toEqual(initial.cursor);
	});

	it("retains rejected attempts and their Jobs when retry creates a new binding", () => {
		const { db, ledger } = open();
		const initial = publish(db, ledger, [binding(), run()])!;
		const rejected = binding();
		rejected.value.revision = "2";
		rejected.value.acceptance = "rejected";
		rejected.value.reason = "host rejected evidence";
		const retry = binding("retry");
		retry.value.attempt = 2;
		const retried = publish(db, ledger, [rejected, retry])!;
		const now = ledger.snapshot("host", "run");
		expect(now.records).toContainEqual(rejected);
		expect(now.records).toContainEqual(retry);
		expect(now.records.filter(record => record.kind === "binding")).toHaveLength(2);
		const before = ledger.stateAt("host", "run", initial.cursor);
		expect(before.records).toContainEqual(binding());
		expect(before.records).not.toContainEqual(retry);
		expect(ledger.stateAt("host", "run", retried.cursor).records).toContainEqual(rejected);
		expect(ledger.events("host", { after: initial.cursor }).events).toEqual([retried]);
	});

	it("pins a finite watermark and advances filtered gaps only through an explicit ready boundary", () => {
		const { db, ledger, zero } = open();
		publish(db, ledger, [run("a")]);
		publish(db, ledger, [run("b")]);
		publish(db, ledger, [binding("a-binding", "a")]);
		const fourth = publish(db, ledger, [binding("b-binding", "b")])!;
		const firstPage = ledger.events("host", { after: zero, runId: "a", limit: 1 });
		expect(firstPage.events.map(event => event.cursor.seq)).toEqual(["1"]);
		expect(firstPage.watermark).toEqual(fourth.cursor);
		expect(firstPage.next_cursor).toEqual(firstPage.events[0]!.cursor);
		const newer = binding("a-binding", "a");
		newer.value.revision = "2";
		newer.value.acceptance = "accepted";
		const fifth = publish(db, ledger, [newer])!;
		const lastPage = ledger.events("host", {
			after: firstPage.next_cursor!,
			watermark: firstPage.watermark,
			runId: "a",
			limit: 1,
		});
		expect(lastPage.events.map(event => event.cursor.seq)).toEqual(["3"]);
		expect(lastPage.events.flatMap(event => event.records).every(record => record.value.graph_run_id === "a")).toBe(
			true,
		);
		expect(lastPage.next_cursor).toBeNull();
		expect(lastPage.cursor).toEqual(fourth.cursor);
		expect(lastPage.watermark).toEqual(fourth.cursor);
		const filteredEmpty = ledger.events("host", {
			after: lastPage.events[0]!.cursor,
			watermark: fourth.cursor,
			runId: "a",
			limit: 1,
		});
		expect(filteredEmpty.events).toEqual([]);
		expect(filteredEmpty.cursor).toEqual(fourth.cursor);
		expect(ledger.events("host", { after: lastPage.cursor, runId: "a" }).events).toEqual([fifth]);
	});

	it("isolates sources and removes other Runs from mixed-event projections", () => {
		const { db, ledger, zero } = open();
		const otherZero = ledger.registerSource("other-host");
		expect(otherZero.journal_id).not.toBe(zero.journal_id);
		const mixed = publish(db, ledger, [run("a"), run("b"), binding("a-binding", "a"), binding("b-binding", "b")])!;
		const foreign = run("a");
		foreign.value.graph_id = "foreign-graph";
		publish(db, ledger, [foreign], "other-host");
		expect(ledger.snapshot("host", "a").records.every(record => record.value.graph_run_id === "a")).toBe(true);
		expect(ledger.snapshot("other-host").records).toEqual([foreign]);
		const filtered = ledger.events("host", { after: zero, runId: "a" });
		expect(filtered.events).toHaveLength(1);
		expect(filtered.events[0]!.event_id).toBe(mixed.event_id);
		expect(filtered.events[0]!.records).toEqual([run("a"), binding("a-binding", "a")]);
		expectError(() => ledger.events("host", { after: otherZero }), "invalid_cursor");
		expectError(() => ledger.stateAt("other-host", "a", mixed.cursor), "invalid_cursor");
	});

	it("rejects unknown or malformed cursors, missing Runs, invalid values and invalid limits", () => {
		const { db, ledger, zero } = open();
		publish(db, ledger, [run()]);
		for (const cursor of [
			{ ...zero, seq: "2" },
			{ ...zero, seq: "01" },
			{ ...zero, seq: "-1" },
			{ ...zero, seq: "1.0" },
			{ journal_id: "foreign", seq: "0" },
		])
			expectError(() => ledger.events("host", { after: cursor }), "invalid_cursor");
		expectError(() => ledger.events("host", { after: { ...zero, seq: "1" }, watermark: zero }), "invalid_cursor");
		for (const limit of [0, 101, 1.5, Number.NaN])
			expectError(() => ledger.events("host", { after: zero, limit }), "invalid_input");
		expectError(() => ledger.snapshot("host", "missing"), "invalid_input", "missing");
		expectError(() => ledger.stateAt("host", "run", zero), "invalid_input", "missing");
		const invalid = binding();
		invalid.value.attempt = 0;
		expectError(() => publish(db, ledger, [invalid]), "invalid_input");
		expectError(() => db.transaction(() => ledger.publish("host", [], "not-a-time"))(), "invalid_input");
		expectError(() => db.transaction(() => ledger.publish("host", [], "2026-11-05"))(), "invalid_input");
		const nonJson = { ...run(), unsupported_value: undefined };
		expectError(() => publish(db, ledger, [nonJson]), "invalid_input");
	});

	it("fails closed on retained history gaps without backfilling current records into the past", () => {
		const { db, ledger, zero } = open();
		const first = publish(db, ledger, [run()])!;
		const middle = publish(db, ledger, [binding()])!;
		const changed = binding();
		changed.value.revision = "2";
		changed.value.acceptance = "accepted";
		const last = publish(db, ledger, [changed])!;
		db.query("DELETE FROM graph_wire_events WHERE source_id=? AND seq=?").run("host", middle.cursor.seq);
		expect(ledger.snapshot("host").records).toContainEqual(changed);
		expect(ledger.stateAt("host", "run", first.cursor).records).toEqual([run()]);
		expectError(() => ledger.stateAt("host", "run", last.cursor), "cursor_expired", "partial");
		expectError(() => ledger.events("host", { after: zero }), "cursor_expired", "partial");
		expectError(() => ledger.events("host", { after: middle.cursor }), "cursor_expired", "partial");
	});

	it("does not recreate a missing retained baseline when reopening or re-registering a source", () => {
		const { db, ledger, zero } = open();
		const last = publish(db, ledger, [run(), binding()])!;
		db.query("DELETE FROM graph_wire_baselines WHERE source_id=?").run("host");
		const reopened = new GraphWireLedger(db);
		expect(reopened.registerSource("host")).toEqual(last.cursor);
		expectError(() => reopened.stateAt("host", "run", last.cursor), "cursor_expired", "expired");
		expect(reopened.events("host", { after: zero }).events).toEqual([last]);
		expect(reopened.snapshot("host").records).toContainEqual(binding());
	});

	it("orders durable decimal sequences numerically across multiple finite pages", () => {
		const { db, ledger, zero } = open();
		publish(db, ledger, [run(), binding()]);
		for (let revision = 2; revision <= 12; revision++) {
			const replacement = binding();
			replacement.value.revision = String(revision);
			replacement.value.reason = `host decision ${revision}`;
			expect(publish(db, ledger, [replacement])!.cursor.seq).toBe(String(revision));
		}
		const first = ledger.events("host", { after: zero, limit: 9 });
		expect(first.events.map(event => event.cursor.seq)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
		expect(first.watermark.seq).toBe("12");
		const second = ledger.events("host", { after: first.next_cursor!, watermark: first.watermark, limit: 9 });
		expect(second.events.map(event => event.cursor.seq)).toEqual(["10", "11", "12"]);
		expect(second.cursor.seq).toBe("12");
		expect(second.next_cursor).toBeNull();
		const atTen = ledger.stateAt("host", "run", { ...zero, seq: "10" });
		const atTenBinding = atTen.records.find(record => record.kind === "binding");
		expect(atTenBinding?.value.revision).toBe("10");
	});

	it("returns detached records and independent cursors across snapshots, history and subsequent reads", () => {
		const { db, ledger, zero } = open();
		const input = binding();
		const event = publish(db, ledger, [run(), input])!;
		input.value.reason = "caller mutation";
		event.records.length = 0;
		event.cursor.seq = "99";
		const snapshot = ledger.snapshot("host");
		expect(snapshot.records).toContainEqual(binding());
		snapshot.records.length = 0;
		snapshot.cursor.seq = "88";
		const boundary: GraphCursor = { ...zero, seq: "1" };
		const historical = ledger.stateAt("host", "run", boundary);
		historical.records.length = 0;
		historical.cursor.seq = "77";
		const page = ledger.events("host", { after: zero, watermark: boundary });
		page.events[0]!.records.length = 0;
		page.events[0]!.cursor.seq = "66";
		page.cursor.seq = "55";
		expect(page.watermark).toEqual(boundary);
		page.watermark.seq = "44";
		expect(boundary.seq).toBe("1");
		expect(ledger.snapshot("host").cursor.seq).toBe("1");
		expect(ledger.events("host", { after: zero }).events[0]!.records).toContainEqual(binding());
	});
});

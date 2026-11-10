import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	GRAPH_WIRE_EXECUTION_EXTENSION,
	GraphWireError,
	type GraphCursor,
	type GraphWireHistoryEvent,
	type GraphWireRecord,
} from "@oh-my-pi/pi-wire/graph";
import {
	GraphWireHistoryQueries,
	type GraphWireHistoryOptions,
	type GraphWireHistoryResult,
	type GraphWireRunsOptions,
} from "../src/graph/wire-history";
import { GraphWireLedger } from "../src/graph/wire-ledger";

const time = "2026-11-05T10:00:00.000Z";
const bot = { source_id: "bot-source", profile_id: "profile", bot_id: "bot" };
const databases = new Set<Database>();
const query: GraphWireHistoryOptions = {
	view: "events",
	at: null,
	after: null,
	filter: {},
	pageToken: null,
	limit: 1,
	scopeKey: "principal/generation-1/source-host/run-run",
	extensions: [],
};
const inventory: GraphWireRunsOptions = {
	graphId: null,
	pageToken: null,
	limit: 1,
	scopeKey: "principal/generation-1/source-host",
};

function run(id = "run", graphId = "graph"): Extract<GraphWireRecord, { kind: "run" }> {
	return {
		kind: "run",
		value: {
			graph_id: graphId,
			graph_run_id: id,
			definition_revision: "1",
			revision: "1",
			created_at: time,
			definition: {
				nodes: ["write", "review"].map(node_id => ({
					node_id,
					label: node_id,
					bot,
					config_revision: "1",
					acceptance_ref: null,
				})),
				edges: [{ edge_id: "edge", from_node_id: "write", to_node_id: "review", condition_ref: null }],
			},
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
			invocation_id: "invocation",
			attempt: 1,
			job: { ...bot, job_id: `job-${id}` },
			config_revision: "1",
			revision: "1",
			acceptance: "pending",
			evidence_refs: [],
			reason: null,
		},
	};
}
function open(maxTokens = 20, now: () => number = () => 1000) {
	const db = new Database(":memory:");
	databases.add(db);
	const ledger = new GraphWireLedger(db);
	const zero = ledger.registerSource("host");
	const reader = new GraphWireHistoryQueries(new GraphWireLedger(db, { readOnly: true }), { maxTokens, now });
	const publish = (records: GraphWireRecord[]) =>
		db.transaction(() => ledger.publish("host", records, time)).immediate()!;
	return { db, ledger, reader, zero, publish };
}
function code(action: () => unknown, expected: GraphWireError["code"]) {
	let caught: unknown;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(GraphWireError);
	expect((caught as GraphWireError).code).toBe(expected);
}
function unavailable(result: GraphWireHistoryResult, availability: GraphWireHistoryResult["availability"]) {
	expect(result).toMatchObject({
		availability,
		items: [],
		watermark: null,
		next_page_token: null,
		retained: { from: null, through: null },
	});
}

afterEach(() => {
	for (const db of databases) db.close();
	databases.clear();
});

describe("trusted Graph history queries", () => {
	it("captures sorted source inventory, pins it across writes, and filters graph identity", () => {
		const { reader, publish } = open();
		expect(reader.runs("host", inventory).items).toEqual([]);
		const earlier = run("z", "other");
		earlier.value.created_at = "2026-11-04T10:00:00.000Z";
		const firstEvent = publish([run("b"), run("a"), earlier]);
		const first = reader.runs("host", inventory);
		expect(first.items.map(item => item.graph_run_id)).toEqual(["z"]);
		expect(first.watermark).toEqual(firstEvent.cursor);
		expect(first.next_page_token).not.toBeNull();
		publish([run("new")]);
		// Callers cannot mutate the retained inventory through a returned item.
		first.items[0]!.graph_run_id = "forged";
		const second = reader.runs("host", { ...inventory, pageToken: first.next_page_token });
		expect(second.items.map(item => item.graph_run_id)).toEqual(["a"]);
		expect(second.watermark).toEqual(firstEvent.cursor);
		const third = reader.runs("host", { ...inventory, pageToken: second.next_page_token });
		expect(third.items.map(item => item.graph_run_id)).toEqual(["b"]);
		expect(third.next_page_token).toBeNull();
		expect(
			reader.runs("host", { ...inventory, graphId: "graph", limit: 100 }).items.map(item => item.graph_run_id),
		).toEqual(["a", "b", "new"]);
	});

	it("reconstructs old full replacements rather than returning the current accepted Binding", () => {
		const { reader, publish } = open();
		const initial = publish([run(), binding()]);
		const accepted = binding();
		accepted.value.revision = "2";
		accepted.value.acceptance = "accepted";
		accepted.value.evidence_refs = ["artifact:accepted"];
		publish([accepted]);
		const old = reader.history("host", "run", { ...query, view: "state", at: initial.cursor, limit: 100 });
		expect(old.availability).toBe("available");
		expect(old.items).toContainEqual(binding());
		expect(old.items).not.toContainEqual(accepted);
		expect(reader.history("host", "run", { ...query, view: "state", limit: 100 }).items).toContainEqual(accepted);
		expect(old.retained.through).toEqual(initial.cursor);
	});

	it("pins state pagination and event watermark while later Host publications continue", () => {
		const { reader, publish, zero } = open();
		const initial = publish([run(), binding()]);
		const state = reader.history("host", "run", { ...query, view: "state" });
		const changed = binding();
		changed.value.revision = "2";
		changed.value.acceptance = "accepted";
		const update = publish([changed]);
		const events = reader.history("host", "run", query);
		expect(events.availability).toBe("available");
		expect(events.next_page_token).not.toBeNull();
		expect(events.retained).toEqual({ from: zero, through: update.cursor });
		const retry = binding("retry");
		retry.value.attempt = 2;
		publish([retry]);
		const stateRest = reader.history("host", "run", { ...query, view: "state", pageToken: state.next_page_token });
		expect([...state.items, ...stateRest.items]).toContainEqual(binding());
		expect([...state.items, ...stateRest.items]).not.toContainEqual(changed);
		expect(stateRest.watermark).toEqual(initial.cursor);
		const eventsRest = reader.history("host", "run", { ...query, pageToken: events.next_page_token });
		expect(eventsRest.items).toEqual([update]);
		expect(eventsRest.watermark).toEqual(update.cursor);
		expect(eventsRest.next_page_token).toBeNull();
		expect(
			reader.history("host", "run", { ...query, at: update.cursor, after: initial.cursor, limit: 100 }).items,
		).toEqual([update]);
	});

	it("isolates two Runs even when they share a source and one journal event", () => {
		const { reader, publish } = open();
		publish([run(), binding(), run("other"), binding("other-binding", "other")]);
		const otherUpdate = binding("other-binding", "other");
		otherUpdate.value.revision = "2";
		otherUpdate.value.acceptance = "accepted";
		publish([otherUpdate]);
		for (const view of ["events", "state"] as const) {
			const result = reader.history("host", "run", { ...query, view, limit: 100 });
			expect(result.availability).toBe("available");
			const records =
				view === "events"
					? (result.items as GraphWireHistoryEvent[]).flatMap(event => event.records)
					: (result.items as GraphWireRecord[]);
			expect(records.length).toBeGreaterThan(0);
			expect(records.every(record => record.value.graph_run_id === "run")).toBe(true);
		}
	});

	it("resolves dependency target nodes and transfer endpoints without cross-endpoint guesses", () => {
		const { reader, publish } = open();
		const from = binding("from");
		const to = binding("to");
		to.value.node_id = "review";
		to.value.invocation_id = "target";
		to.value.attempt = 2;
		const evidence = { source: bot, job_id: from.value.job.job_id, artifact_id: "artifact", ref: null };
		const dependency: GraphWireRecord = {
			kind: "dependency",
			value: {
				dependency_id: "dependency",
				graph_run_id: "run",
				edge_id: "edge",
				target_invocation_id: "target",
				target_attempt: 2,
				revision: "1",
				state: "waiting",
				reason: null,
				evidence: [],
			},
		};
		const transfer: GraphWireRecord = {
			kind: "transfer",
			value: {
				transfer_id: "transfer",
				graph_run_id: "run",
				edge_id: "edge",
				from_binding_id: "from",
				to_binding_id: "to",
				artifact: evidence,
				revision: "1",
				state: "pending",
				reason: null,
				occurred_at: time,
			},
		};
		publish([run(), from, to, dependency, transfer]);
		for (const view of ["state", "events"] as const) {
			const result = reader.history("host", "run", {
				...query,
				view,
				limit: 100,
				filter: { node_id: "review", invocation_id: "target", attempt: 2 },
			});
			const records =
				view === "state" ? result.items : (result.items as GraphWireHistoryEvent[]).flatMap(event => event.records);
			expect(records).toEqual(expect.arrayContaining([to, dependency, transfer]));
			expect(records).toHaveLength(3);
			const mismatched = reader.history("host", "run", {
				...query,
				view,
				filter: { kind: "transfer", node_id: "write", invocation_id: "target" },
			});
			expect(mismatched.items).toEqual([]);
		}
	});

	it("gates execution records and resolves execution attempt nodes through their invocation", () => {
		const { reader, publish } = open();
		const definition = run();
		definition.value.definition.nodes.push({
			node_id: "program",
			label: "Program",
			bot: null,
			config_revision: null,
			acceptance_ref: null,
		});
		const invocation: GraphWireRecord = {
			kind: "execution_invocation",
			value: {
				graph_run_id: "run",
				node_id: "program",
				invocation_id: "program-call",
				revision: "1",
				member_id: null,
				kind: "program",
				origin: "executed",
				iteration: 0,
				scope_id: "run",
				parent_invocation_id: null,
				state: "running",
				selected_outcome: null,
				input_refs: [],
				upstream_attempt_ids: [],
				wait_reason: null,
				current_attempt_id: "attempt",
			},
		};
		const attempt: GraphWireRecord = {
			kind: "execution_attempt",
			value: {
				graph_run_id: "run",
				attempt_id: "attempt",
				invocation_id: "program-call",
				revision: "1",
				number: 1,
				executor_kind: "program",
				state: "running",
				execution_ref: "protected-execution",
				result_ref: null,
				job: null,
			},
		};
		const executionRun: GraphWireRecord = {
			kind: "execution_run",
			value: {
				graph_run_id: "run",
				revision: "1",
				state: "running",
				reason: null,
				snapshot_ref: { id: "snapshot", digest: "sha256:frozen" },
				budget_refs: [],
				decision_refs: [],
			},
		};
		publish([definition, executionRun, invocation, attempt]);
		const invocationUpdate = structuredClone(invocation);
		invocationUpdate.value.revision = "2";
		publish([invocationUpdate]);
		const legacyPage = reader.history("host", "run", query);
		expect(legacyPage.items).toHaveLength(1);
		expect(legacyPage.next_page_token).toBeNull();
		for (const view of ["events", "state"] as const) {
			const legacy = reader.history("host", "run", { ...query, view, limit: 100 });
			const records =
				view === "events"
					? (legacy.items as GraphWireHistoryEvent[]).flatMap(event => event.records)
					: legacy.items;
			expect(records).toEqual([definition]);
			const extended = reader.history("host", "run", {
				...query,
				view,
				limit: 100,
				extensions: [GRAPH_WIRE_EXECUTION_EXTENSION],
				filter: { kind: "execution_attempt", node_id: "program", invocation_id: "program-call", attempt: 1 },
			});
			expect(
				view === "events"
					? (extended.items as GraphWireHistoryEvent[]).flatMap(event => event.records)
					: extended.items,
			).toEqual([attempt]);
		}
	});

	it("binds every history query field, principal generation, scope and target into opaque tokens", () => {
		const { reader, publish } = open();
		publish([run(), binding(), run("other")]);
		const changed = binding();
		changed.value.revision = "2";
		publish([changed]);
		const first = reader.history("host", "run", query);
		expect(first.next_page_token).not.toBeNull();
		const continuation = { ...query, pageToken: first.next_page_token };
		for (const patch of [
			{ scopeKey: "attacker/generation-1/source-host/run-run" },
			{ scopeKey: "principal/generation-2/source-host/run-run" },
			{ scopeKey: "principal/generation-1/source-host/run-other" },
			{ limit: 2 },
			{ view: "state" as const },
			{ at: first.watermark },
			{ after: first.watermark },
			{ filter: { kind: "binding" } },
			{ extensions: [GRAPH_WIRE_EXECUTION_EXTENSION] },
		])
			code(() => reader.history("host", "run", { ...continuation, ...patch }), "scope_denied");
		code(() => reader.history("host", "other", continuation), "scope_denied");
		code(() => reader.history("other-source", "run", continuation), "scope_denied");
		code(() => reader.history("host", "run", { ...query, pageToken: crypto.randomUUID() }), "cursor_expired");
		expect(reader.history("host", "run", continuation).availability).toBe("available");
		const runs = reader.runs("host", inventory);
		for (const patch of [{ graphId: "graph" }, { limit: 2 }, { scopeKey: "other-principal" }])
			code(() => reader.runs("host", { ...inventory, pageToken: runs.next_page_token, ...patch }), "scope_denied");
	});

	it("expires at 60 seconds without renewal, resists clock rollback and evicts bounded tokens", () => {
		let now = 0;
		const { reader, publish } = open(1, () => now);
		publish([run("a"), run("b"), run("c")]);
		const first = reader.runs("host", inventory);
		now = 30_000;
		const second = reader.runs("host", { ...inventory, pageToken: first.next_page_token });
		code(() => reader.runs("host", { ...inventory, pageToken: first.next_page_token }), "cursor_expired");
		now = 60_000;
		code(() => reader.runs("host", { ...inventory, pageToken: second.next_page_token }), "cursor_expired");
		now = 1;
		code(() => reader.runs("host", { ...inventory, pageToken: second.next_page_token }), "cursor_expired");
		const state = reader.history("host", "a", { ...query, view: "state", limit: 1 });
		expect(state.next_page_token).toBeNull();
	});

	it("expires event and state continuations at their original query deadline", () => {
		let now = 0;
		const { reader, publish } = open(10, () => now);
		publish([run(), binding()]);
		const changed = binding();
		changed.value.revision = "2";
		publish([changed]);
		const events = reader.history("host", "run", query);
		const state = reader.history("host", "run", { ...query, view: "state" });
		expect(events.next_page_token).not.toBeNull();
		expect(state.next_page_token).not.toBeNull();
		now = 59_999;
		expect(reader.history("host", "run", { ...query, pageToken: events.next_page_token }).availability).toBe(
			"available",
		);
		now = 60_000;
		code(() => reader.history("host", "run", { ...query, pageToken: events.next_page_token }), "cursor_expired");
		code(
			() => reader.history("host", "run", { ...query, view: "state", pageToken: state.next_page_token }),
			"cursor_expired",
		);
	});

	it("reports honest unavailable reconstruction and distinguishes unknown Run from invalid source", () => {
		const { db, reader, publish } = open();
		const initial = publish([run(), binding()]);
		const changed = binding();
		changed.value.revision = "2";
		changed.value.acceptance = "accepted";
		publish([changed]);
		unavailable(reader.history("host", "absent", query), "missing");
		unavailable(reader.history("host", "absent", { ...query, view: "state" }), "missing");
		code(() => reader.history("unregistered", "run", query), "invalid_cursor");
		expect(db.query("SELECT 1 FROM graph_wire_sources WHERE source_id='unregistered'").get()).toBeNull();
		db.query("DELETE FROM graph_wire_baselines WHERE source_id=?").run("host");
		unavailable(reader.history("host", "absent", { ...query, view: "state" }), "missing");
		unavailable(reader.history("host", "run", { ...query, view: "state", at: initial.cursor }), "expired");
		// Event evidence is still honest without a reconstruction baseline.
		expect(reader.history("host", "run", { ...query, limit: 100 }).availability).toBe("available");
		const filtered = reader.history("host", "run", {
			...query,
			after: initial.cursor,
			filter: { kind: "binding", node_id: "write" },
			limit: 100,
		});
		expect(filtered.availability).toBe("available");
		expect((filtered.items as GraphWireHistoryEvent[]).flatMap(event => event.records)).toEqual([changed]);
		db.query("DELETE FROM graph_wire_events WHERE source_id=? AND seq=?").run("host", initial.cursor.seq);
		unavailable(reader.history("host", "run", query), "partial");
	});

	it("detects a gap beyond the first page instead of claiming the requested range is available", () => {
		const { db, reader, publish } = open();
		publish([run(), binding()]);
		const changed = binding();
		changed.value.revision = "2";
		const middle = publish([changed]);
		changed.value.revision = "3";
		publish([changed]);
		db.query("DELETE FROM graph_wire_events WHERE source_id=? AND seq=?").run("host", middle.cursor.seq);
		unavailable(reader.history("host", "run", query), "partial");
		unavailable(reader.history("host", "run", { ...query, view: "state" }), "partial");
	});

	it("rejects journal replacement and never writes during successful discovery/history reads", () => {
		const { db, reader, publish } = open();
		publish([run(), binding(), run("other")]);
		const runs = reader.runs("host", inventory);
		const state = reader.history("host", "run", { ...query, view: "state" });
		const changes = db.query("SELECT total_changes() AS count").get();
		reader.runs("host", { ...inventory, pageToken: runs.next_page_token });
		reader.history("host", "run", { ...query, view: "state", pageToken: state.next_page_token });
		expect(db.query("SELECT total_changes() AS count").get()).toEqual(changes);
		db.query("UPDATE graph_wire_sources SET journal_id=? WHERE source_id=?").run(crypto.randomUUID(), "host");
		code(() => reader.runs("host", { ...inventory, pageToken: runs.next_page_token }), "invalid_cursor");
		code(
			() => reader.history("host", "run", { ...query, view: "state", pageToken: state.next_page_token }),
			"invalid_cursor",
		);
	});

	it("rejects malformed options and unsupported filter combinations", () => {
		const { ledger, reader, publish } = open();
		publish([run()]);
		for (const maxTokens of [0, -1, Infinity, NaN, 1.5])
			code(() => new GraphWireHistoryQueries(ledger, { maxTokens }), "invalid_input");
		for (const patch of [
			{ limit: 0 },
			{ limit: 101 },
			{ limit: 1.5 },
			{ scopeKey: "" },
			{ view: "state" as const, after: { journal_id: "journal", seq: "0" } },
			{ filter: { kind: "guessed-kind" } },
			{ filter: { attempt: 1 } },
			{ filter: { invocation_id: "i", attempt: 0 } },
			{ filter: { kind: "run", node_id: "write" } },
			{ filter: { kind: "execution_attempt" } },
			{
				filter: { kind: "execution_invocation", invocation_id: "i", attempt: 1 },
				extensions: [GRAPH_WIRE_EXECUTION_EXTENSION],
			},
			{ at: { journal_id: "journal", seq: "01" } as GraphCursor },
		])
			code(() => reader.history("host", "run", { ...query, ...patch }), "invalid_input");
		code(
			() => new GraphWireHistoryQueries(ledger, { maxTokens: 1, now: () => Infinity }).runs("host", inventory),
			"invalid_input",
		);
	});
});

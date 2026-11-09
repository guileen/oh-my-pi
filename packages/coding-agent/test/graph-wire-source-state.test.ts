import { describe, expect, it } from "bun:test";
import {
	GRAPH_WIRE_PROTOCOL,
	GraphWireError,
	GraphWireSourceState,
	type GraphWireRecord,
	type GraphWireSourceFrame,
	type GraphWireSourceStateOptions,
} from "@oh-my-pi/pi-wire/graph";

const epoch = Date.parse("2026-11-05T00:00:00.000Z");
const at = (offset: number) => new Date(epoch + offset).toISOString();
const position = (seq: string, journal_id = "journal-a") => ({ journal_id, seq });
const source = (source_id = "a") => ({
	source_id,
	kind: "graph" as const,
	profile_id: null,
	bot_id: null,
	capabilities: ["graph.runs.v1"],
});
function run(id = "run-a", revision = "1"): GraphWireRecord {
	return {
		kind: "run",
		value: {
			graph_id: `graph-${id}`,
			graph_run_id: id,
			definition_revision: "1",
			definition: { nodes: [], edges: [] },
			revision,
			created_at: at(0),
		},
	};
}
function frame(type: GraphWireSourceFrame["type"], fields: Record<string, unknown> = {}): GraphWireSourceFrame {
	return {
		protocol: GRAPH_WIRE_PROTOCOL,
		in_reply_to: null,
		subscription_id: "sub",
		type,
		...fields,
	} as GraphWireSourceFrame;
}
function fixture(options: Partial<GraphWireSourceStateOptions> = {}) {
	let now = epoch;
	const state = new GraphWireSourceState({
		subscriptionId: "sub",
		mode: "live",
		scope: { graph_run_id: null, source_ids: ["a"] },
		now: () => now,
		limits: { maxRecords: 10, maxPages: 5, maxEvents: 10 },
		...options,
	});
	return {
		state,
		clock(value: number) {
			now = epoch + value;
		},
		subscribe(scope_id = "scope", sources = [source()], authorized = 0, expires = 60_000) {
			state.apply(
				frame("subscription", {
					scope_id,
					sources,
					mode: options.mode ?? "live",
					authorized_at: at(authorized),
					authorization_expires_at: at(expires),
				}),
			);
		},
		snapshot(records: GraphWireRecord[] = [run()], source_id = "a", seq = "1", journal = "journal-a") {
			const cursor = position(seq, journal);
			state.apply(frame("snapshot.begin", { source_id, snapshot_id: "snapshot", cursor, page_count: 1 }));
			state.apply(frame("snapshot.page", { source_id, snapshot_id: "snapshot", cursor, page: 1, records }));
			state.apply(frame("snapshot.end", { source_id, snapshot_id: "snapshot", cursor }));
		},
		ready(seq = "1", source_id = "a", journal = "journal-a") {
			state.apply(frame("source.ready", { source_id, cursor: position(seq, journal) }));
		},
	};
}
function event(
	event_id: string,
	seq: string,
	records: GraphWireRecord[],
	replay = true,
	source_id = "a",
	journal = "journal-a",
) {
	return frame("graph.event", {
		source_id,
		event_id,
		cursor: position(seq, journal),
		occurred_at: at(0),
		records,
		replay,
	});
}
function rejectsCode(action: () => void, code: GraphWireError["code"]) {
	try {
		action();
		throw new Error("Expected a wire error");
	} catch (error) {
		expect(error).toBeInstanceOf(GraphWireError);
		expect((error as GraphWireError).code).toBe(code);
	}
}

describe("Graph wire source synchronization", () => {
	it("ignores additive frames, renders unknown source/record states unsupported and disables controls", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot();
		f.ready();
		const before = f.state.read();
		f.state.apply({
			protocol: GRAPH_WIRE_PROTOCOL,
			type: "future.frame",
			source_id: "foreign",
		} as unknown as GraphWireSourceFrame);
		expect(f.state.read()).toEqual(before);
		f.state.apply(frame("source.state", { source_id: "a", state: "future-state", reason: null }));
		expect(f.state.read().sources[0].state).toBe("unsupported");
		expect(f.state.controlsEnabled("a")).toBe(false);
		rejectsCode(() => f.ready(), "protocol_error");
		f.snapshot();
		f.ready();
		const future = {
			kind: "dependency",
			value: {
				dependency_id: "dep",
				graph_run_id: "run-a",
				edge_id: "edge",
				target_invocation_id: "invocation",
				target_attempt: 1,
				revision: "1",
				state: "future-state",
				reason: null,
				evidence: [],
			},
		} as unknown as GraphWireRecord;
		f.state.apply(event("future-state", "2", [future], false));
		expect(f.state.read().sources[0].state).toBe("unsupported");
		expect(f.state.read().sources[0].records).toEqual([run()]);
		expect(f.state.controlsEnabled("a")).toBe(false);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("1");
	});

	it("marks transport stale after 15s without erasing a still-authorized committed image", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot();
		f.ready();
		f.clock(15_000);
		expect(f.state.read().transportStale).toBe(true);
		expect(f.state.read().sources[0].controlsEnabled).toBe(false);
		expect(f.state.controlsEnabled("a")).toBe(false);
		expect(f.state.read().sources[0].records).toEqual([run()]);
		f.state.apply(
			frame("heartbeat", {
				observed_at: at(15_000),
				checkpoint: { scope_id: "scope", entries: [{ source_id: "a", cursor: position("10") }] },
			}),
		);
		expect(f.state.read().transportStale).toBe(false);
		expect(f.state.controlsEnabled("a")).toBe(true);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("1");
	});

	it("buffers numbered pages until matching end, retains the old image and never infers ready", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot();
		f.ready();
		const cursor = position("5");
		f.state.apply(frame("snapshot.begin", { source_id: "a", snapshot_id: "next", cursor, page_count: 2 }));
		f.state.apply(
			frame("snapshot.page", { source_id: "a", snapshot_id: "next", cursor, page: 2, records: [run("run-b")] }),
		);
		expect(f.state.read().sources[0].records).toEqual([run()]);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("1");
		expect(f.state.controlsEnabled("a")).toBe(false);
		rejectsCode(
			() => f.state.apply(frame("snapshot.end", { source_id: "a", snapshot_id: "next", cursor })),
			"protocol_error",
		);
		rejectsCode(
			() =>
				f.state.apply(
					frame("snapshot.page", {
						source_id: "a",
						snapshot_id: "next",
						cursor: position("6"),
						page: 1,
						records: [],
					}),
				),
			"protocol_error",
		);
		f.state.apply(
			frame("snapshot.page", { source_id: "a", snapshot_id: "next", cursor, page: 1, records: [run("run-c")] }),
		);
		f.state.apply(frame("snapshot.end", { source_id: "a", snapshot_id: "next", cursor }));
		expect(f.state.read().sources[0].records).toEqual([run("run-c"), run("run-b")]);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("5");
		expect(f.state.controlsEnabled("a")).toBe(false);
		f.state.apply(frame("source.state", { source_id: "a", state: "live", reason: null }));
		expect(f.state.controlsEnabled("a")).toBe(false);
		f.ready("8"); // Filtered journal sequence gaps are a valid ready barrier.
		expect(f.state.controlsEnabled("a")).toBe(true);
	});

	it("commits an empty one-page image but rejects ready or events without a baseline", () => {
		const f = fixture();
		f.subscribe();
		rejectsCode(() => f.ready(), "protocol_error");
		rejectsCode(() => f.state.apply(event("unbased", "2", [run()])), "protocol_error");
		f.snapshot([]);
		expect(f.state.read().sources[0].hasProjection).toBe(true);
		expect(f.state.read().sources[0].records).toEqual([]);
		expect(f.state.controlsEnabled("a")).toBe(false);
		f.ready("100000000000000000000000000000");
		expect(f.state.controlsEnabled("a")).toBe(true);
	});

	it("interleaves independent journals without a global order and resets only one source", () => {
		const f = fixture({ scope: { graph_run_id: null, source_ids: ["a", "b"] } });
		f.subscribe("scope", [source(), source("b")]);
		f.snapshot([run()], "a", "100");
		f.snapshot([run("run-b")], "b", "1", "journal-b");
		f.state.apply(event("b-event", "2", [run("run-b", "2")], true, "b", "journal-b"));
		f.ready("2", "b", "journal-b");
		expect(f.state.controlsEnabled("a")).toBe(false);
		expect(f.state.controlsEnabled("b")).toBe(true);
		f.snapshot([], "a", "0", "reset-journal");
		expect(f.state.read().sources[1].records).toEqual([run("run-b", "2")]);
		expect(f.state.checkpoint()?.entries).toEqual([
			{ source_id: "a", cursor: position("0", "reset-journal") },
			{ source_id: "b", cursor: position("2", "journal-b") },
		]);
	});

	it("replaces prior-epoch revisions only when the new journal snapshot commits", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot([run("run-a", "3")], "a", "10");
		f.ready("10");
		f.snapshot([run()], "a", "11");
		expect(f.state.read().sources[0].records).toEqual([run("run-a", "3")]);
		const cursor = position("1", "replacement-journal");
		f.state.apply(frame("snapshot.begin", { source_id: "a", snapshot_id: "replacement", cursor, page_count: 1 }));
		f.state.apply(
			frame("snapshot.page", {
				source_id: "a",
				snapshot_id: "replacement",
				cursor,
				page: 1,
				records: [run()],
			}),
		);
		expect(f.state.read().sources[0].records).toEqual([run("run-a", "3")]);
		expect(f.state.controlsEnabled("a")).toBe(false);
		expect(f.state.checkpoint()?.entries[0].cursor).toEqual(position("11"));
		f.state.apply(frame("snapshot.end", { source_id: "a", snapshot_id: "replacement", cursor }));
		expect(f.state.read().sources[0].records).toEqual([run()]);
		expect(f.state.checkpoint()?.entries[0].cursor).toEqual(cursor);
		expect(f.state.controlsEnabled("a")).toBe(false);
		f.ready("1", "a", "replacement-journal");
		expect(f.state.controlsEnabled("a")).toBe(true);
	});

	it("deduplicates events, ignores older/equal revisions and rejects conflicting equal values", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot([run("run-a", "3")]);
		const original = event("event-1", "4", [run("run-a", "4")]);
		f.state.apply(original);
		f.state.apply(structuredClone(original));
		f.state.apply(event("old-revision", "8", [run("run-a", "1")]));
		f.state.apply(event("equal-revision", "9", [run("run-a", "4")]));
		expect(f.state.read().sources[0].records).toEqual([run("run-a", "4")]);
		const conflicting = run("run-a", "4");
		if (conflicting.kind !== "run") throw new Error("Invalid test fixture");
		conflicting.value.created_at = at(1);
		rejectsCode(() => f.state.apply(event("conflict", "10", [conflicting])), "protocol_error");
		rejectsCode(() => f.state.apply(event("event-1", "4", [run("run-a", "5")])), "protocol_error");
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("9");
	});

	it("enforces per-source monotonic journals and replay/live barriers", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot();
		rejectsCode(() => f.state.apply(event("live-too-early", "2", [], false)), "protocol_error");
		rejectsCode(() => f.state.apply(event("foreign-journal", "2", [], true, "a", "other")), "invalid_cursor");
		f.state.apply(event("replay", "3", [run("run-a", "2")]));
		rejectsCode(() => f.state.apply(event("out-of-order", "2", [])), "protocol_error");
		f.ready("7");
		rejectsCode(() => f.state.apply(event("late-replay", "8", [])), "protocol_error");
		f.state.apply(event("live", "8", [], false));
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("8");
	});

	it("does not advance saved state from heartbeat and retains only committed data across reconnect", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot();
		f.ready();
		f.state.apply(
			frame("heartbeat", {
				observed_at: at(1),
				checkpoint: { scope_id: "scope", entries: [{ source_id: "a", cursor: position("900") }] },
			}),
		);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("1");
		f.state.apply(
			frame("snapshot.begin", { source_id: "a", snapshot_id: "partial", cursor: position("10"), page_count: 1 }),
		);
		f.state.apply(
			frame("snapshot.page", {
				source_id: "a",
				snapshot_id: "partial",
				cursor: position("10"),
				page: 1,
				records: [run("uncommitted")],
			}),
		);
		f.state.reconnect();
		expect(f.state.read().sources).toEqual([]);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("1");
		expect(f.state.controlsEnabled("a")).toBe(false);
		f.state.apply(
			frame("heartbeat", {
				observed_at: at(2),
				checkpoint: { scope_id: "scope", entries: [{ source_id: "a", cursor: position("999") }] },
			}),
		);
		expect(f.state.controlsEnabled("a")).toBe(false);
		f.state.apply(
			frame("scope.authorized", {
				scope_id: "scope",
				authorized_at: at(0),
				authorization_expires_at: at(60_000),
			}),
		);
		expect(f.state.read().sources[0].records).toEqual([run()]);
		f.state.apply(event("recovered", "5", [run("run-a", "2")]));
		f.ready("9");
		expect(f.state.controlsEnabled("a")).toBe(true);
	});

	it("hides retained protected projections on foreground until authorization is revalidated", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot();
		f.ready();
		f.clock(5_000);
		f.state.reconnect();
		expect(f.state.read().sources).toEqual([]);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("1");
		f.ready();
		expect(f.state.controlsEnabled("a")).toBe(false);
		expect(f.state.read().sources).toEqual([]);
		f.state.apply(
			frame("scope.authorized", {
				scope_id: "scope",
				authorized_at: at(5_000),
				authorization_expires_at: at(65_000),
			}),
		);
		expect(f.state.read().sources[0].records).toEqual([run()]);
		f.ready();
		expect(f.state.controlsEnabled("a")).toBe(true);
	});
});

describe("Graph wire authorization boundaries", () => {
	it("checks expiry on all read paths and never resurrects a terminated scope after clock rollback", () => {
		for (const access of ["read", "checkpoint", "controlsEnabled"] as const) {
			const f = fixture();
			f.subscribe();
			f.snapshot();
			f.ready();
			f.clock(60_000);
			if (access === "controlsEnabled") expect(f.state.controlsEnabled("a")).toBe(false);
			else if (access === "checkpoint") expect(f.state.checkpoint()).toBeNull();
			else expect(f.state.read().sources).toEqual([]);
			expect(f.state.read().invalidated).toEqual({ scope_id: "scope", reason: "expired" });
			f.clock(1);
			rejectsCode(() => f.subscribe("scope", [source()], 0, 60_000), "scope_denied");
			rejectsCode(
				() =>
					f.state.apply(
						frame("scope.authorized", {
							scope_id: "scope",
							authorized_at: at(0),
							authorization_expires_at: at(60_000),
						}),
					),
				"scope_denied",
			);
			expect(f.state.read().sources).toEqual([]);
		}
	});

	it("renews only the active scope, never downgrades a repeated subscription and enforces max 60s", () => {
		const f = fixture();
		rejectsCode(() => f.subscribe("too-long", [source()], 0, 60_001), "protocol_error");
		f.subscribe();
		f.snapshot();
		f.ready();
		f.clock(20_000);
		f.state.apply(
			frame("scope.authorized", {
				scope_id: "scope",
				authorized_at: at(20_000),
				authorization_expires_at: at(80_000),
			}),
		);
		f.subscribe();
		expect(f.state.read().authorizationExpiresAt).toBe(at(80_000));
		expect(f.state.controlsEnabled("a")).toBe(true);
		rejectsCode(
			() =>
				f.state.apply(
					frame("scope.authorized", {
						scope_id: "other",
						authorized_at: at(20_000),
						authorization_expires_at: at(80_000),
					}),
				),
			"scope_denied",
		);
		f.clock(70_000);
		expect(f.state.read().sources[0].records).toEqual([run()]);
		f.clock(10_000);
		f.clock(80_000);
		expect(f.state.read().sources).toEqual([]);
	});

	it("clears revocations and changed scopes, rejecting old, foreign and Bot identities", () => {
		const f = fixture();
		f.subscribe();
		f.snapshot();
		f.state.apply(frame("scope.invalidated", { scope_id: "scope", reason: "revoked" }));
		expect(f.state.read().sources).toEqual([]);
		rejectsCode(() => f.subscribe(), "scope_denied");
		f.subscribe("new-scope");
		f.snapshot();
		f.subscribe("third-scope");
		expect(f.state.read().sources[0].records).toEqual([]);
		expect(f.state.checkpoint()?.entries).toEqual([]);
		rejectsCode(() => f.subscribe("new-scope"), "scope_denied");
		rejectsCode(
			() =>
				f.state.apply(frame("source.ready", { subscription_id: "other", source_id: "a", cursor: position("1") })),
			"scope_denied",
		);
		rejectsCode(
			() =>
				f.state.apply(
					frame("snapshot.begin", {
						source_id: "foreign",
						snapshot_id: "x",
						cursor: position("1"),
						page_count: 1,
					}),
				),
			"scope_denied",
		);
		rejectsCode(() => f.subscribe("fourth", [source("foreign")]), "scope_denied");
		rejectsCode(
			() =>
				f.state.apply(
					frame("subscription", {
						scope_id: "bot-scope",
						mode: "live",
						sources: [{ ...source(), kind: "bot", profile_id: "p", bot_id: "b" }],
						authorized_at: at(0),
						authorization_expires_at: at(60_000),
					}),
				),
			"capability_unavailable",
		);
	});

	it("keeps history finite/read-only and outside live checkpoints", () => {
		const f = fixture({ mode: "history" });
		f.subscribe();
		f.snapshot();
		expect(f.state.read().sources[0].records).toEqual([run()]);
		expect(f.state.checkpoint()).toBeNull();
		expect(f.state.controlsEnabled("a")).toBe(false);
		rejectsCode(() => f.ready(), "protocol_error");
		rejectsCode(() => f.state.apply(event("history-event", "2", [])), "protocol_error");
		rejectsCode(
			() => f.state.apply(frame("source.state", { source_id: "a", state: "live", reason: null })),
			"protocol_error",
		);
		rejectsCode(
			() =>
				f.state.apply(
					frame("subscription", {
						scope_id: "live",
						mode: "live",
						sources: [source()],
						authorized_at: at(0),
						authorization_expires_at: at(60_000),
					}),
				),
			"scope_denied",
		);
		expect(f.state.checkpoint()).toBeNull();
	});

	it("rejects records from outside a Run-limited scope and enforces resource limits without partial commit", () => {
		const f = fixture({
			scope: { graph_run_id: "run-a", source_ids: ["a"] },
			limits: { maxRecords: 1, maxPages: 1, maxEvents: 1 },
		});
		f.subscribe();
		rejectsCode(() => f.snapshot([run("other")]), "scope_denied");
		f.state.reconnect();
		f.subscribe();
		rejectsCode(
			() =>
				f.state.apply(
					frame("snapshot.begin", {
						source_id: "a",
						snapshot_id: "oversized",
						cursor: position("1"),
						page_count: 2,
					}),
				),
			"protocol_error",
		);
		f.snapshot();
		rejectsCode(() => f.state.apply(event("too-many-records", "2", [run(), run()])), "protocol_error");
		f.state.apply(event("first", "3", [run("run-a", "2")]));
		rejectsCode(() => f.state.apply(event("second", "4", [run("run-a", "3")])), "protocol_error");
		expect(f.state.read().sources[0].records).toEqual([run("run-a", "2")]);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("3");
	});

	it("does not leak aliases from subscription, pages, events, options, views or checkpoints", () => {
		const ids = ["a"];
		const f = fixture({ scope: { graph_run_id: null, source_ids: ids } });
		ids[0] = "tampered";
		const membership = [source()];
		f.subscribe("scope", membership);
		membership[0].capabilities.push("tampered");
		const records = [run()];
		f.snapshot(records);
		records[0].value.revision = "999";
		const changed = [run("run-a", "2")];
		f.state.apply(event("event", "2", changed));
		changed[0].value.revision = "888";
		const view = f.state.read();
		view.sources[0].records[0].value.revision = "777";
		view.sources[0].cursor!.seq = "777";
		view.sources[0].source.capabilities.push("leak");
		const checkpoint = f.state.checkpoint()!;
		checkpoint.entries[0].cursor.seq = "666";
		expect(f.state.read().sources[0].records).toEqual([run("run-a", "2")]);
		expect(f.state.read().sources[0].source.capabilities).toEqual(["graph.runs.v1"]);
		expect(f.state.checkpoint()?.entries[0].cursor.seq).toBe("2");
	});
});

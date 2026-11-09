import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphWireLedger } from "../src/graph/wire-ledger";
import { GraphWireReadSession, type GraphWireSessionOptions } from "../src/graph/wire-session";
import { GraphWireSourceState, type GraphWireRecord, type GraphWireSourceFrame } from "@oh-my-pi/pi-wire/graph";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const instant = "2026-11-05T00:00:00.000Z";
const run = (id = "run"): Extract<GraphWireRecord, { kind: "run" }> => ({
	kind: "run",
	value: {
		graph_id: "graph",
		graph_run_id: id,
		definition_revision: "1",
		revision: "1",
		created_at: instant,
		definition: { nodes: [], edges: [] },
	},
});
function fixture(overrides: Partial<GraphWireSessionOptions<string>> = {}) {
	const db = new Database(":memory:");
	databases.push(db);
	const ledger = new GraphWireLedger(db);
	ledger.registerSource("source");
	const publish = (record: GraphWireRecord) => db.transaction(() => ledger.publish("source", [record], instant))();
	const session = new GraphWireReadSession(ledger, {
		principal: "owner",
		subscription_id: "subscription",
		mode: "live",
		scope: { graph_run_id: "run", source_ids: ["source"] },
		sources: [{ source_id: "source", kind: "graph", profile_id: null, bot_id: null, capabilities: [] }],
		authorize: () => ({ generation: "generation" }),
		page_size: 1,
		...overrides,
	});
	return { db, ledger, publish, session };
}
async function collect(frames: AsyncIterable<GraphWireSourceFrame>): Promise<GraphWireSourceFrame[]> {
	const result: GraphWireSourceFrame[] = [];
	for await (const frame of frames) result.push(frame);
	return result;
}

describe("authorized Graph wire source delivery", () => {
	test("a change committed during snapshot delivery replays before the ready watermark", async () => {
		const { publish, session } = fixture();
		publish(run());
		const frames: GraphWireSourceFrame[] = [];
		for await (const frame of session.frames()) {
			frames.push(frame);
			if (frame.type === "snapshot.page") {
				expect(frame.cursor.seq).toBe("1");
				const updated = run();
				updated.value.revision = "2";
				publish(updated);
				publish(run("other-run"));
			}
		}
		const end = frames.find(frame => frame.type === "snapshot.end");
		const ready = frames.find(frame => frame.type === "source.ready");
		expect(end && "cursor" in end && end.cursor.seq).toBe("1");
		expect(ready && "cursor" in ready && ready.cursor.seq).toBe("3");
		expect(frames.filter(frame => frame.type === "graph.event")).toMatchObject([
			{
				cursor: { seq: "2" },
				replay: true,
				records: [{ kind: "run", value: { revision: "2", graph_run_id: "run" } }],
			},
		]);
		expect(session.checkpoint()?.entries[0].cursor.seq).toBe("3");
		expect(frames.at(-1)?.type).toBe("heartbeat");
	});

	test("a slow snapshot renews its lease before later frames without losing the ready barrier", async () => {
		let now = Date.parse(instant);
		const { session, publish } = fixture({ now: () => now });
		publish(run());
		const consumer = new GraphWireSourceState({
			subscriptionId: "subscription",
			mode: "live",
			now: () => now,
			scope: { graph_run_id: "run", source_ids: ["source"] },
			limits: { maxRecords: 10, maxPages: 10, maxEvents: 10 },
		});
		for await (const frame of session.frames()) {
			consumer.apply(frame);
			if (frame.type === "snapshot.page" || frame.type === "snapshot.end") now += 31_000;
		}
		expect(consumer.read().sources[0]?.records[0].value.graph_run_id).toBe("run");
		expect(consumer.controlsEnabled("source")).toBe(true);
		expect(consumer.checkpoint()).toEqual(session.checkpoint());
	});

	test("reconnect cannot import a cursor without this session's committed projection", async () => {
		const { session, publish, ledger } = fixture();
		publish(run());
		const consumer = new GraphWireSourceState({
			subscriptionId: "subscription",
			mode: "live",
			scope: { graph_run_id: "run", source_ids: ["source"] },
			limits: { maxRecords: 10, maxPages: 10, maxEvents: 10 },
		});
		for await (const frame of session.frames()) consumer.apply(frame);
		const checkpoint = consumer.checkpoint()!;
		consumer.reconnect();
		expect(consumer.read().sources).toEqual([]);
		const resumed = await collect(session.frames(checkpoint));
		for (const frame of resumed) consumer.apply(frame);
		expect(resumed.map(frame => frame.type)).toEqual([
			"scope.authorized",
			"source.state",
			"source.ready",
			"heartbeat",
		]);
		expect(consumer.read().sources[0].records[0].value.graph_run_id).toBe("run");
		expect(consumer.controlsEnabled("source")).toBe(true);
		const fresh = new GraphWireReadSession(ledger, {
			principal: "owner",
			subscription_id: "fresh",
			mode: "live",
			scope: { graph_run_id: "run", source_ids: ["source"] },
			sources: [{ source_id: "source", kind: "graph", profile_id: null, bot_id: null, capabilities: [] }],
			authorize: () => ({ generation: "generation" }),
			page_size: 1,
		});
		await expect(collect(fresh.frames(checkpoint))).rejects.toThrow("committed subscription image");
		const reloaded = await collect(fresh.frames());
		expect(reloaded.some(frame => frame.type === "snapshot.page")).toBe(true);
	});

	test("replay recovers a lost frame without letting returned cursors rewrite server progress", async () => {
		const { session, publish } = fixture();
		publish(run());
		await collect(session.frames());
		const checkpoint = session.checkpoint()!;
		const updated = run();
		updated.value.revision = "2";
		publish(updated);
		for await (const frame of session.frames()) {
			if (frame.type === "graph.event") frame.cursor.seq = "9000";
		}
		expect(session.checkpoint()?.entries[0].cursor.seq).toBe("2");
		const replay = await collect(session.frames(checkpoint));
		expect(replay.filter(frame => frame.type === "graph.event")).toMatchObject([
			{ replay: true, cursor: { seq: "2" }, records: [{ value: { revision: "2" } }] },
		]);
	});

	test("a journal reset replaces only its source and keeps unrelated projections live", async () => {
		const sources = ["source", "other"].map(source_id => ({
			source_id,
			kind: "graph" as const,
			profile_id: null,
			bot_id: null,
			capabilities: [],
		}));
		const { db, ledger, session, publish } = fixture({
			scope: { graph_run_id: null, source_ids: ["source", "other"] },
			sources,
		});
		ledger.registerSource("other");
		publish(run());
		const other = run("other-run");
		db.transaction(() => ledger.publish("other", [other], instant))();
		const consumer = new GraphWireSourceState({
			subscriptionId: "subscription",
			mode: "live",
			scope: { graph_run_id: null, source_ids: ["source", "other"] },
			limits: { maxRecords: 10, maxPages: 10, maxEvents: 10 },
		});
		for await (const frame of session.frames()) consumer.apply(frame);
		const updated = run();
		updated.value.revision = "2";
		publish(updated);
		other.value.revision = "2";
		db.transaction(() => ledger.publish("other", [other], instant))();
		db.query("UPDATE graph_wire_sources SET journal_id=? WHERE source_id=?").run("replacement", "source");
		const delivered: GraphWireSourceFrame[] = [];
		for await (const frame of session.frames()) {
			delivered.push(frame);
			consumer.apply(frame);
			if (frame.type === "source.state" && frame.source_id === "source") {
				expect(consumer.controlsEnabled("source")).toBe(false);
				expect(consumer.controlsEnabled("other")).toBe(true);
				expect(consumer.read().sources.find(source => source.source.source_id === "other")?.records).toEqual([
					{ ...other, value: { ...other.value, revision: "1" } },
				]);
			}
		}
		expect(delivered.filter(frame => frame.type === "snapshot.begin").map(frame => frame.source_id)).toEqual([
			"source",
		]);
		expect(delivered.filter(frame => frame.type === "graph.event")).toMatchObject([
			{ source_id: "other", replay: false, records: [{ kind: "run", value: { revision: "2" } }] },
		]);
		expect(consumer.read().sources.map(source => source.records[0].value.revision)).toEqual(["2", "2"]);
		expect(consumer.controlsEnabled("source")).toBe(true);
		expect(consumer.controlsEnabled("other")).toBe(true);
		expect(consumer.checkpoint()).toEqual(session.checkpoint());
	});

	test("a broken replacement boundary fails after one snapshot rather than looping or claiming readiness", async () => {
		const { db, publish, session } = fixture();
		publish(run());
		await collect(session.frames());
		db.query("DELETE FROM graph_wire_events WHERE source_id=?").run("source");
		const delivered: GraphWireSourceFrame[] = [];
		await expect(
			(async () => {
				for await (const frame of session.frames()) delivered.push(frame);
			})(),
		).rejects.toThrow("sequence gap");
		expect(delivered.filter(frame => frame.type === "snapshot.begin")).toHaveLength(1);
		expect(delivered[0]).toMatchObject({ type: "source.state", state: "syncing" });
		expect(delivered.some(frame => frame.type === "source.ready" || frame.type === "heartbeat")).toBe(false);
	});

	test("revocation between snapshot pages and commit emits invalidation, not a ready scope", async () => {
		let authorized = true;
		const { session, publish } = fixture({ authorize: () => (authorized ? { generation: "generation" } : null) });
		publish(run());
		const frames: GraphWireSourceFrame[] = [];
		for await (const frame of session.frames()) {
			frames.push(frame);
			if (frame.type === "snapshot.page") authorized = false;
		}
		expect(frames.at(-1)).toMatchObject({ type: "scope.invalidated", reason: "revoked" });
		expect(frames.some(frame => frame.type === "snapshot.end" || frame.type === "source.ready")).toBe(false);
		expect(session.checkpoint()).toBeNull();
	});

	test("an invalidation wins over a pending authorization recheck", async () => {
		let pending = false;
		const grant = Promise.withResolvers<{ generation: string }>();
		const { session } = fixture({
			scope: { graph_run_id: null, source_ids: ["source"] },
			authorize: () => (pending ? grant.promise : { generation: "generation" }),
		});
		await collect(session.frames());
		pending = true;
		const iterator = session.frames();
		const next = iterator.next();
		session.invalidate("scope_changed");
		grant.resolve({ generation: "generation" });
		expect((await next).value).toMatchObject({ type: "scope.invalidated", reason: "scope_changed" });
		await iterator.return(undefined);
		expect(session.checkpoint()).toBeNull();
	});

	test("renewal rechecks permission and an expired scope cannot silently renew", async () => {
		let now = Date.parse(instant);
		const { session } = fixture({ now: () => now, scope: { graph_run_id: null, source_ids: ["source"] } });
		const initial = await collect(session.frames());
		expect(initial[0]).toMatchObject({
			type: "subscription",
			authorized_at: instant,
			authorization_expires_at: "2026-11-05T00:01:00.000Z",
		});
		now += 30_000;
		const renewed = await collect(session.frames());
		expect(renewed[0]).toMatchObject({
			type: "scope.authorized",
			authorized_at: "2026-11-05T00:00:30.000Z",
			authorization_expires_at: "2026-11-05T00:01:30.000Z",
		});
		now += 60_000;
		expect(session.checkpoint()).toBeNull();
		now = Date.parse(instant) + 1_000;
		expect(session.checkpoint()).toBeNull();
		expect(await collect(session.frames())).toMatchObject([{ type: "scope.invalidated", reason: "expired" }]);
	});

	test("history membership never starts a live watch or advances a checkpoint", async () => {
		const { session, publish } = fixture({ mode: "history" });
		publish(run());
		const frames = await collect(session.frames());
		expect(frames.map(frame => frame.type)).toEqual(["subscription"]);
		expect(frames[0]).toMatchObject({ mode: "history" });
		expect(session.checkpoint()).toBeNull();
	});

	test("authorization callback cannot expand the stored scope through args or receiver", async () => {
		const { session, publish } = fixture({
			authorize: function (principal, scope) {
				expect(principal).toBe("owner");
				expect(this).toBeUndefined();
				scope.graph_run_id = null;
				scope.source_ids.push("unrelated");
				return { generation: "generation" };
			},
		});
		publish(run());
		publish(run("private-run"));
		const frames = await collect(session.frames());
		const pages = frames.filter(frame => frame.type === "snapshot.page");
		expect(
			pages.flatMap(page =>
				page.type === "snapshot.page" ? page.records.map(record => record.value.graph_run_id) : [],
			),
		).toEqual(["run"]);
	});
});

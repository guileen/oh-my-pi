import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphWireLedger } from "../src/graph/wire-ledger";
import { GraphWireReadBridge, type GraphWireReadCatalog, type GraphWireReadFrame } from "../src/graph/wire-read-bridge";
import { GraphWireSourceState, type GraphWireRecord } from "@oh-my-pi/pi-wire/graph";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const instant = "2026-11-05T00:00:00.000Z";
const source = {
	source_id: "source",
	kind: "graph" as const,
	profile_id: null,
	bot_id: null,
	capabilities: ["graph.runs.v1", "graph.history.v1"],
};
const run = (id = "run", revision = "1"): GraphWireRecord => ({
	kind: "run",
	value: {
		graph_id: "graph",
		graph_run_id: id,
		definition_revision: "1",
		revision,
		created_at: instant,
		definition: { nodes: [], edges: [] },
	},
});
const frame = (type: string, rest: Record<string, unknown> = {}) => ({
	protocol: "omp.graph.v1",
	type,
	message_id: crypto.randomUUID(),
	...rest,
});
const hello = () => frame("hello", { supported_protocols: ["omp.graph.v1"] });
const subscribe = (mode: "live" | "history" = "live", runId: string | null = "run") =>
	frame("subscribe", {
		subscription_id: "sub",
		mode,
		scope: { graph_run_id: runId, source_ids: ["source"] },
		resume: null,
	});
async function collect(input: AsyncIterable<GraphWireReadFrame>): Promise<GraphWireReadFrame[]> {
	const result: GraphWireReadFrame[] = [];
	for await (const value of input) result.push(value);
	return result;
}
function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	const ledger = new GraphWireLedger(db);
	ledger.registerSource("source");
	let now = Date.parse(instant),
		authorized = true,
		allowRoster = false,
		generation = "g1";
	let onAuthorize: (() => void | Promise<void>) | undefined;
	const catalog: GraphWireReadCatalog = { generation, sources: [source] };
	const bridge = new GraphWireReadBridge(ledger, {
		principal: "owner",
		catalog: principal => {
			expect(principal).toBe("owner");
			return authorized ? { ...catalog, generation } : null;
		},
		authorize: async (principal, scope) => {
			expect(principal).toBe("owner");
			await onAuthorize?.();
			return authorized && (scope.graph_run_id === "run" || (scope.graph_run_id === null && allowRoster))
				? { generation }
				: null;
		},
		maxSubscriptions: 2,
		maxPageTokens: 8,
		pageSize: 1,
		now: () => now,
	});
	const publish = (value: GraphWireRecord) => db.transaction(() => ledger.publish("source", [value], instant))();
	return {
		db,
		ledger,
		bridge,
		publish,
		revoke: () => {
			authorized = false;
		},
		changeGeneration: () => {
			generation = "g2";
		},
		advance: (ms: number) => {
			now += ms;
		},
		roster: () => {
			allowRoster = true;
		},
		onAuthorize: (callback: () => void | Promise<void>) => {
			onAuthorize = callback;
		},
	};
}

describe("authenticated read-only Graph wire bridge", () => {
	test("requires version negotiation and authorization before disclosing any source or Run", async () => {
		const { bridge, publish, revoke } = fixture();
		publish(run());
		expect(await collect(bridge.handle(subscribe()))).toMatchObject([
			{ type: "error", error: { code: "unsupported_version" } },
		]);
		expect(await collect(bridge.handle({ ...hello(), protocol: "other" }))).toMatchObject([
			{ type: "error", error: { code: "unsupported_version" } },
		]);
		revoke();
		expect(await collect(bridge.handle(hello()))).toMatchObject([{ type: "error", error: { code: "scope_denied" } }]);
	});

	test("delivers actual snapshots, live lifecycle replacements and replay into the source consumer", async () => {
		const { bridge, publish } = fixture();
		publish(run());
		publish(run("private"));
		const negotiated = await collect(bridge.handle(hello()));
		expect(negotiated[0]).toMatchObject({ type: "hello", sources: [source], extensions: [] });
		const consumer = new GraphWireSourceState({
			subscriptionId: "sub",
			mode: "live",
			scope: { graph_run_id: "run", source_ids: ["source"] },
			limits: { maxRecords: 10, maxPages: 10, maxEvents: 10 },
			now: () => Date.parse(instant),
		});
		const initial = await collect(bridge.handle(subscribe()));
		for (const value of initial) if ("subscription_id" in value) consumer.apply(value);
		expect(consumer.read().sources[0].records.map(record => record.value.graph_run_id)).toEqual(["run"]);
		expect(consumer.controlsEnabled("source")).toBe(true);
		const saved = consumer.checkpoint()!;
		publish(run("run", "2"));
		const changes = await collect(bridge.poll());
		for (const value of changes)
			if (value.type === "graph.event" || value.type === "source.ready" || value.type === "heartbeat")
				consumer.apply(value);
		expect(changes).toContainEqual(
			expect.objectContaining({
				type: "graph.event",
				replay: false,
				records: [expect.objectContaining({ value: expect.objectContaining({ revision: "2" }) })],
			}),
		);
		consumer.reconnect();
		const replay = await collect(bridge.handle({ ...subscribe(), resume: saved }));
		for (const value of replay) if ("subscription_id" in value) consumer.apply(value);
		expect(replay).toContainEqual(expect.objectContaining({ type: "graph.event", replay: true }));
		expect(consumer.read().sources[0].records[0].value.revision).toBe("2");
	});

	for (const reset of ["retention gap", "journal replacement"] as const) {
		test(`replaces an expired source image after ${reset} and replays changes before ready`, async () => {
			const f = fixture();
			const initialRevision = reset === "journal replacement" ? "3" : "1";
			const finalRevision = reset === "journal replacement" ? "2" : "3";
			f.publish(run("run", initialRevision));
			await collect(f.bridge.handle(hello()));
			const consumer = new GraphWireSourceState({
				subscriptionId: "sub",
				mode: "live",
				scope: { graph_run_id: "run", source_ids: ["source"] },
				limits: { maxRecords: 10, maxPages: 10, maxEvents: 10 },
				now: () => Date.parse(instant),
			});
			for (const value of await collect(f.bridge.handle(subscribe())))
				if ("subscription_id" in value) consumer.apply(value);
			if (reset === "retention gap") {
				f.publish(run("run", "2"));
				f.publish(run("private"));
				f.db.query("DELETE FROM graph_wire_events WHERE source_id=? AND seq=?").run("source", "1");
			} else {
				f.db.transaction(() => {
					f.db.query("DELETE FROM graph_wire_current WHERE source_id=?").run("source");
					f.db.query("DELETE FROM graph_wire_events WHERE source_id=?").run("source");
					f.db
						.query("UPDATE graph_wire_sources SET journal_id=?,seq='0' WHERE source_id=?")
						.run("replacement", "source");
					f.ledger.publish("source", [run(), run("private")], instant);
				})();
			}
			const delivered: GraphWireReadFrame[] = [];
			for await (const value of f.bridge.poll()) {
				delivered.push(value);
				if ("subscription_id" in value) consumer.apply(value);
				if (value.type === "source.state") {
					expect(value).toMatchObject({ source_id: "source", state: "syncing" });
					expect(consumer.controlsEnabled("source")).toBe(false);
				}
				if (value.type === "snapshot.page") {
					expect(consumer.read().sources[0].records[0].value.revision).toBe(initialRevision);
					expect(value.records.map(record => record.value.graph_run_id)).toEqual(["run"]);
					f.publish(run("run", finalRevision));
				}
			}
			expect(delivered.some(value => value.type === "error")).toBe(false);
			expect(delivered.filter(value => value.type === "snapshot.end")).toHaveLength(1);
			expect(delivered.filter(value => value.type === "graph.event")).toMatchObject([
				{ replay: true, records: [{ kind: "run", value: { graph_run_id: "run", revision: finalRevision } }] },
			]);
			expect(consumer.read().sources[0].records[0].value.revision).toBe(finalRevision);
			expect(consumer.controlsEnabled("source")).toBe(true);
			const heartbeat = delivered.at(-1);
			expect(heartbeat).toMatchObject({ type: "heartbeat" });
			if (heartbeat?.type !== "heartbeat") throw new Error("Missing recovered checkpoint");
			expect(consumer.checkpoint()).toEqual(heartbeat.checkpoint);
			expect(heartbeat.checkpoint.entries[0].cursor).toMatchObject({
				journal_id: reset === "journal replacement" ? "replacement" : expect.any(String),
				seq: reset === "journal replacement" ? "2" : "4",
			});
			expect(await collect(f.bridge.handle(frame("graph.author", { action: "retry" })))).toMatchObject([
				{ type: "error", error: { code: "capability_unavailable" } },
			]);
		});
	}

	test("revocation during a replacement snapshot clears the old image without a ready barrier", async () => {
		const f = fixture();
		f.publish(run());
		await collect(f.bridge.handle(hello()));
		const consumer = new GraphWireSourceState({
			subscriptionId: "sub",
			mode: "live",
			scope: { graph_run_id: "run", source_ids: ["source"] },
			limits: { maxRecords: 10, maxPages: 10, maxEvents: 10 },
			now: () => Date.parse(instant),
		});
		for (const value of await collect(f.bridge.handle(subscribe())))
			if ("subscription_id" in value) consumer.apply(value);
		f.publish(run("run", "2"));
		f.db.query("DELETE FROM graph_wire_events WHERE source_id=? AND seq=?").run("source", "1");
		const delivered: GraphWireReadFrame[] = [];
		for await (const value of f.bridge.poll()) {
			delivered.push(value);
			if ("subscription_id" in value) consumer.apply(value);
			if (value.type === "snapshot.page") f.revoke();
		}
		expect(delivered.at(-1)).toMatchObject({ type: "scope.invalidated", reason: "revoked" });
		expect(delivered.some(value => value.type === "snapshot.end" || value.type === "source.ready")).toBe(false);
		expect(consumer.read().sources).toEqual([]);
		expect(await collect(f.bridge.poll())).toEqual([]);
	});

	test("refuses a fresh connection's checkpoint import and Run scope widening", async () => {
		const first = fixture();
		first.publish(run());
		await collect(first.bridge.handle(hello()));
		const initial = await collect(first.bridge.handle(subscribe()));
		const heartbeat = initial.find(value => value.type === "heartbeat");
		const second = new GraphWireReadBridge(first.ledger, {
			principal: null,
			catalog: () => ({ generation: "g1", sources: [source] }),
			authorize: () => ({ generation: "g1" }),
			maxSubscriptions: 1,
			maxPageTokens: 2,
			pageSize: 10,
		});
		await collect(second.handle(hello()));
		expect(
			await collect(
				second.handle({ ...subscribe(), resume: heartbeat?.type === "heartbeat" ? heartbeat.checkpoint : null }),
			),
		).toMatchObject([{ type: "error", error: { code: "invalid_cursor" } }]);
		const denied = await collect(first.bridge.handle(subscribe("live", null)));
		expect(denied.some(value => value.type === "snapshot.page")).toBe(false);
		expect(denied).toContainEqual(expect.objectContaining({ type: "scope.invalidated" }));
	});

	test("rechecks authority between pages and invalidates without committing an unauthorized image", async () => {
		const f = fixture();
		f.publish(run());
		await collect(f.bridge.handle(hello()));
		const seen: GraphWireReadFrame[] = [];
		for await (const value of f.bridge.handle(subscribe())) {
			seen.push(value);
			if (value.type === "snapshot.page") f.revoke();
		}
		expect(seen.at(-1)).toMatchObject({ type: "scope.invalidated", reason: "revoked" });
		expect(seen.some(value => value.type === "snapshot.end" || value.type === "source.ready")).toBe(false);
		expect(await collect(f.bridge.poll())).toEqual([]);
	});

	test("revocation immediately fences an in-flight awaited authorization even before its frames are sent", async () => {
		const f = fixture();
		f.publish(run());
		await collect(f.bridge.handle(hello()));
		await collect(f.bridge.handle(subscribe()));
		const barrier = Promise.withResolvers<void>();
		let entered = false;
		f.onAuthorize(() => {
			entered = true;
			return barrier.promise;
		});
		const iterator = f.bridge.poll();
		const next = iterator.next();
		while (!entered) await Bun.sleep(0);
		const invalidations = f.bridge.invalidate();
		expect(invalidations).toMatchObject([{ type: "scope.invalidated", reason: "revoked" }]);
		barrier.resolve();
		expect((await next).value).toMatchObject({ type: "scope.invalidated" });
		await iterator.return(undefined);
		expect(await collect(f.bridge.poll())).toEqual([]);
	});

	test("history stays read-only and pinned to the authorized Run rather than today's state", async () => {
		const f = fixture();
		const initial = f.publish(run())!;
		f.publish(run("run", "2"));
		f.publish(run("private"));
		await collect(f.bridge.handle(hello()));
		const membership = await collect(f.bridge.handle(subscribe("history")));
		expect(membership.map(value => value.type)).toEqual(["subscription"]);
		const granted = membership[0];
		if (granted.type !== "subscription") throw new Error("Missing subscription");
		const request = frame("graph.history.get", {
			subscription_id: "sub",
			scope_id: granted.scope_id,
			source_id: "source",
			graph_run_id: "run",
			view: "state",
			at: initial.cursor,
			after: null,
			filter: {},
			page_token: null,
			limit: 10,
		});
		const history = await collect(f.bridge.handle(request));
		expect(history).toMatchObject([
			{
				type: "graph.history",
				availability: "available",
				items: [{ kind: "run", value: { graph_run_id: "run", revision: "1" } }],
			},
		]);
		expect(await collect(f.bridge.poll())).toEqual([]);
		expect(await collect(f.bridge.handle({ ...request, graph_run_id: "private" }))).toContainEqual(
			expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "scope_denied" }) }),
		);
	});

	test("Run discovery requires roster authorization and forged mutations never reach dispatch", async () => {
		const f = fixture();
		f.publish(run());
		f.publish(run("private"));
		await collect(f.bridge.handle(hello()));
		const list = frame("graph.runs.list", { source_id: "source", graph_id: null, page_token: null, limit: 1 });
		f.roster();
		const page = await collect(f.bridge.handle(list));
		expect(page).toMatchObject([
			{ type: "graph.runs", items: [{ graph_run_id: "private" }], next_page_token: expect.any(String) },
		]);
		for (const type of ["command", "graph.command", "graph.author"])
			expect(await collect(f.bridge.handle(frame(type, { action: "stop", all: true })))).toMatchObject([
				{ type: "error", error: { code: "capability_unavailable" } },
			]);
		expect(f.ledger.snapshot("source").records.map(record => record.value.revision)).toEqual(["1", "1"]);
	});

	test("generation changes and expired leases deny history rather than reusing old authorization", async () => {
		for (const change of ["generation", "lease"] as const) {
			const f = fixture();
			f.publish(run());
			await collect(f.bridge.handle(hello()));
			const membership = await collect(f.bridge.handle(subscribe("history")));
			const granted = membership[0];
			if (granted.type !== "subscription") throw new Error("Missing subscription");
			if (change === "generation") f.changeGeneration();
			else f.advance(60_000);
			const output = await collect(
				f.bridge.handle(
					frame("graph.history.get", {
						subscription_id: "sub",
						scope_id: granted.scope_id,
						source_id: "source",
						graph_run_id: "run",
						view: "state",
						at: null,
						after: null,
						filter: {},
						page_token: null,
						limit: 10,
					}),
				),
			);
			expect(output.some(value => value.type === "graph.history")).toBe(false);
			expect(output).toContainEqual(expect.objectContaining({ type: "scope.invalidated" }));
		}
	});

	test("projects source metadata without leaking unrecognized deployment fields", async () => {
		const { ledger } = fixture();
		const configuredSource = { ...source, credentials: "private-deployment-secret", executable: "/private/worker" };
		const bridge = new GraphWireReadBridge(ledger, {
			principal: "owner",
			catalog: () => ({ generation: "g1", sources: [configuredSource] }),
			authorize: () => ({ generation: "g1" }),
			maxSubscriptions: 1,
			maxPageTokens: 1,
			pageSize: 1,
		});
		const output = await collect(bridge.handle(hello()));
		expect(output).toMatchObject([{ type: "hello", sources: [source] }]);
		expect(JSON.stringify(output)).not.toContain(configuredSource.credentials);
		expect(JSON.stringify(output)).not.toContain(configuredSource.executable);
	});

	test("upstream authorization errors cannot disclose protected exception text", async () => {
		const { ledger } = fixture();
		const bridge = new GraphWireReadBridge(ledger, {
			principal: null,
			catalog: () => {
				throw new Error("/secret/profile/token");
			},
			authorize: () => null,
			maxSubscriptions: 1,
			maxPageTokens: 1,
			pageSize: 1,
		});
		const output = await collect(bridge.handle(hello()));
		expect(output).toMatchObject([{ type: "error", error: { code: "scope_denied" } }]);
		expect(JSON.stringify(output)).not.toContain("/secret/profile/token");
	});

	test("awaits protected reads and fences content on immediate transport revocation", async () => {
		const { ledger } = fixture();
		const { promise: started, resolve: beginRead } = Promise.withResolvers<void>();
		const { promise: completed, resolve: completeRead } = Promise.withResolvers<void>();
		let checks = 0;
		const bridge = new GraphWireReadBridge(ledger, {
			principal: "owner",
			catalog: () => ({ generation: "g1", sources: [{ ...source, capabilities: ["graph.execution.v1"] }] }),
			authorize: () => {
				checks++;
				return { generation: "g1" };
			},
			maxSubscriptions: 1,
			maxPageTokens: 1,
			pageSize: 1,
			extensions: ["graph.execution.v1"],
			artifactContents: {
				read: async () => {
					beginRead();
					await completed;
					return { availability: "available", media_type: "text/plain", content: "protected awaited content" };
				},
			},
		});
		await collect(bridge.handle({ ...hello(), extensions: ["graph.execution.v1"] }));
		const pending = collect(
			bridge.handle(
				frame("graph.artifact.get", {
					source_id: "source",
					graph_run_id: "run",
					ref: "registered-artifact",
					page_token: null,
					limit: 1,
				}),
			),
		);
		await started;
		expect(checks).toBe(1);
		bridge.invalidate("revoked");
		completeRead();
		const output = await pending;
		expect(output).toMatchObject([{ type: "error", error: { code: "scope_denied" } }]);
		expect(JSON.stringify(output)).not.toContain("protected awaited content");
	});
});

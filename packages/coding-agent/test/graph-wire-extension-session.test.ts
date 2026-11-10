import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphWireLedger } from "../src/graph/wire-ledger";
import { GraphWireReadSession } from "../src/graph/wire-session";
import {
	GraphWireSourceState,
	type GraphWireExecutionRecord,
	type GraphWireRecord,
	type GraphWireSourceFrame,
} from "@oh-my-pi/pi-wire/graph";

const databases: Database[] = [];
const extension = "graph.execution.v1";
const instant = "2026-11-05T00:00:00.000Z";
const epoch = Date.parse(instant);
function fixture(offered: boolean, supported: boolean) {
	const db = new Database(":memory:");
	databases.push(db);
	const ledger = new GraphWireLedger(db);
	ledger.registerSource("host");
	const run: GraphWireRecord = {
		kind: "run",
		value: {
			graph_id: "graph",
			graph_run_id: "run",
			definition_revision: "1",
			revision: "1",
			created_at: instant,
			definition: { nodes: [], edges: [] },
		},
	};
	const execution: GraphWireExecutionRecord = {
		kind: "execution_run",
		value: {
			graph_run_id: "run",
			revision: "1",
			state: "queued",
			reason: null,
			snapshot_ref: { id: "snapshot", digest: "sha256:fixture" },
			budget_refs: [],
			decision_refs: [],
		},
	};
	const publish = (records: GraphWireRecord[]) => db.transaction(() => ledger.publish("host", records, instant))();
	publish([run, execution]);
	const source = {
		source_id: "host",
		kind: "graph" as const,
		profile_id: null,
		bot_id: null,
		capabilities: supported ? [extension] : [],
	};
	const extensions = offered ? [extension] : [];
	const session = new GraphWireReadSession(ledger, {
		principal: "owner",
		subscription_id: "sub",
		mode: "live",
		scope: { graph_run_id: "run", source_ids: ["host"] },
		sources: [source],
		extensions,
		page_size: 1,
		authorize: () => ({ generation: "authorized" }),
		now: () => epoch,
	});
	const consumer = new GraphWireSourceState({
		subscriptionId: "sub",
		mode: "live",
		scope: { graph_run_id: "run", source_ids: ["host"] },
		extensions,
		limits: { maxRecords: 20, maxPages: 20, maxEvents: 20 },
		now: () => epoch,
	});
	return { ledger, session, consumer, execution, extensions, publish };
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

async function deliver(session: GraphWireReadSession<string>, consumer: GraphWireSourceState) {
	const frames: GraphWireSourceFrame[] = [];
	for await (const frame of session.frames()) {
		consumer.apply(frame);
		frames.push(frame);
	}
	return frames;
}

describe("Graph execution extension disclosure", () => {
	for (const [offered, supported] of [
		[false, true],
		[true, false],
	] as const) {
		test(`filters execution records unless both negotiated and supported (${offered}/${supported})`, async () => {
			const f = fixture(offered, supported);
			await deliver(f.session, f.consumer);
			expect(f.consumer.read().sources[0].records.map(record => record.kind)).toEqual(["run"]);
			const before = f.consumer.checkpoint()!;
			f.execution.value.revision = "2";
			f.execution.value.state = "running";
			const update = f.publish([f.execution])!;
			const frames = await deliver(f.session, f.consumer);
			expect(frames.some(frame => frame.type === "graph.event")).toBe(false);
			expect(f.consumer.checkpoint()?.entries[0].cursor).toEqual(update.cursor);
			expect(f.consumer.checkpoint()?.entries[0].cursor).not.toEqual(before.entries[0].cursor);
		});
	}

	test("negotiated execution replacements use the same snapshot, event and ready barriers", async () => {
		const f = fixture(true, true);
		await deliver(f.session, f.consumer);
		expect(f.consumer.read().sources[0].records).toContainEqual(f.execution);
		f.execution.value.revision = "2";
		f.execution.value.state = "running";
		f.publish([f.execution]);
		const frames = await deliver(f.session, f.consumer);
		expect(frames.filter(frame => frame.type === "graph.event").map(frame => frame.records)).toEqual([[f.execution]]);
		expect(f.consumer.read().sources[0].records).toContainEqual(f.execution);
		expect(f.consumer.checkpoint()).toEqual(f.session.checkpoint());
	});

	test("mutating caller extension options cannot grant new disclosure after session creation", async () => {
		const f = fixture(false, true);
		f.extensions.push(extension);
		await deliver(f.session, f.consumer);
		expect(f.consumer.read().sources[0].records.map(record => record.kind)).toEqual(["run"]);
	});

	test("the consumer rejects unsolicited execution records and marks future execution states unsupported", async () => {
		const legacy = fixture(false, true);
		await deliver(legacy.session, legacy.consumer);
		const event: GraphWireSourceFrame = {
			protocol: "omp.graph.v1",
			type: "graph.event",
			in_reply_to: null,
			subscription_id: "sub",
			source_id: "host",
			event_id: "unsolicited",
			cursor: { ...legacy.consumer.checkpoint()!.entries[0].cursor, seq: "2" },
			occurred_at: instant,
			replay: false,
			records: [legacy.execution],
		};
		expect(() => legacy.consumer.apply(event)).toThrow("negotiated");
		const current = fixture(true, true);
		await deliver(current.session, current.consumer);
		const future = structuredClone(current.execution);
		future.value.revision = "2";
		(future.value as unknown as Record<string, unknown>).state = "future-state";
		current.consumer.apply({ ...event, event_id: "future", records: [future] });
		expect(current.consumer.read().sources[0].state).toBe("unsupported");
		expect(current.consumer.controlsEnabled("host")).toBe(false);
		expect(current.consumer.read().sources[0].records).toContainEqual(current.execution);
	});
});

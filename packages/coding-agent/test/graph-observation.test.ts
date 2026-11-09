import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphObservation, GraphObservationError } from "../src/graph/observation";
import { GraphRunStore } from "../src/graph/store";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-observation-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new GraphRunStore(limits, root);
	cleanups.push(() => store.close());
	const content =
		"---\nformat: omp.graph/v1\nname: human\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n";
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const auth = { id: "private-authorization", digest: "sha256:test" };
	const result = store.start(
		{
			version: 1,
			request_key: "start",
			operation: "start",
			target_id: definition.graph_id,
			if_revision: definition.revision,
			payload: { inputs: {}, authorization_ref: auth },
		},
		{
			graph_id: definition.graph_id,
			definition_revision: definition.revision,
			definition_digest: definition.digest,
			authorization_ref: auth,
			inputs: {},
			members: {},
			executors: {},
		},
	);
	if (result.state !== "accepted" || !result.target_id) throw new Error("Run setup failed");
	const observation = new GraphObservation(store.definitions.root, store.definitions.limits);
	cleanups.push(() => observation.close());
	return { root, store, observation, runId: result.target_id };
}

function expectCode(action: () => unknown, code: GraphObservationError["code"]) {
	try {
		action();
		throw new Error("Expected observation error");
	} catch (error) {
		expect(error).toBeInstanceOf(GraphObservationError);
		expect((error as GraphObservationError).code).toBe(code);
	}
}

describe("Graph durable observation", () => {
	it("returns the committed Run and matching journal cursor without authorization material", () => {
		const { observation, runId } = setup();
		const snapshot = observation.snapshot(runId);
		expect(snapshot.run.id).toBe(runId);
		expect(snapshot.run.state).toBe("queued");
		expect(snapshot.run).not.toHaveProperty("authorization_ref");
		expect(snapshot.cursor.seq).toBe("1");
		const page = observation.events(runId);
		expect(page.events).toHaveLength(1);
		expect(page.events[0]).toEqual({
			cursor: snapshot.cursor,
			data: { type: "run.created", run_id: runId, revision: "1", at: snapshot.run.created_at },
		});
		expect(page.cursor).toEqual(snapshot.cursor);
		expect(page.next_cursor).toBeNull();
		expect(observation.events(runId, { after: snapshot.cursor }).events).toEqual([]);
		expectCode(() => observation.snapshot("missing"), "unknown_run");
	});

	it("paginates in journal order and resumes without skipping later commits", () => {
		const { root, observation, runId } = setup();
		const journal = observation.snapshot(runId).cursor.journal_id;
		const db = new Database(path.join(root, "graphs.sqlite"));
		cleanups.push(() => db.close());
		db.transaction(() => {
			for (let seq = 2; seq <= 4; seq++)
				db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
					journal,
					seq,
					JSON.stringify({ type: "test", seq }),
				);
			db.query("UPDATE graph_journals SET seq=4 WHERE run_id=?").run(runId);
		})();
		const first = observation.events(runId, { limit: 2 });
		expect(first.events.map(event => event.cursor.seq)).toEqual(["1", "2"]);
		expect(first.watermark.seq).toBe("4");
		expect(first.next_cursor).toEqual(first.cursor);
		const second = observation.events(runId, { after: first.next_cursor!, limit: 2 });
		expect(second.events.map(event => event.cursor.seq)).toEqual(["3", "4"]);
		expect(second.next_cursor).toBeNull();
		db.transaction(() => {
			db.query("INSERT INTO graph_events VALUES (?,?,?)").run(journal, 5, JSON.stringify({ type: "later" }));
			db.query("UPDATE graph_journals SET seq=5 WHERE run_id=?").run(runId);
		})();
		expect(observation.events(runId, { after: second.cursor }).events[0].cursor.seq).toBe("5");
	});

	it("orders decimal cursor strings by their integer sequence across pages", () => {
		const { root, observation, runId } = setup();
		const cursor = observation.snapshot(runId).cursor;
		const db = new Database(path.join(root, "graphs.sqlite"));
		cleanups.push(() => db.close());
		db.transaction(() => {
			for (let seq = 2; seq <= 12; seq++)
				db.query("INSERT INTO graph_events VALUES (?,?,?)").run(cursor.journal_id, seq, JSON.stringify({ seq }));
			db.query("UPDATE graph_journals SET seq=12 WHERE run_id=?").run(runId);
		})();
		const first = observation.events(runId, { after: cursor, limit: 8 });
		expect(first.events.map(event => event.cursor.seq)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9"]);
		const second = observation.events(runId, { after: first.cursor, watermark: first.watermark, limit: 8 });
		expect(second.events.map(event => event.cursor.seq)).toEqual(["10", "11", "12"]);
		expect(second.next_cursor).toBeNull();
	});

	it("rejects malformed, foreign and future cursors and invalid limits", () => {
		const { observation, runId } = setup();
		const cursor = observation.snapshot(runId).cursor;
		for (const after of [
			{ ...cursor, journal_id: "foreign" },
			{ ...cursor, seq: "01" },
			{ ...cursor, seq: "2" },
			{ ...cursor, extra: true },
		])
			expectCode(() => observation.events(runId, { after }), "invalid_cursor");
		for (const limit of [0, 101, 1.5]) expectCode(() => observation.events(runId, { limit }), "invalid_input");
		expectCode(() => observation.events("missing"), "unknown_run");
	});

	it("reports retained gaps rather than presenting an incomplete event suffix as complete", () => {
		const { root, observation, runId } = setup();
		const cursor = observation.snapshot(runId).cursor;
		const db = new Database(path.join(root, "graphs.sqlite"));
		cleanups.push(() => db.close());
		db.transaction(() => {
			db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
				cursor.journal_id,
				3,
				JSON.stringify({ type: "third" }),
			);
			db.query("UPDATE graph_journals SET seq=3 WHERE run_id=?").run(runId);
		})();
		expectCode(() => observation.events(runId, { after: cursor }), "cursor_expired");
		db.query("DELETE FROM graph_events WHERE journal_id=?").run(cursor.journal_id);
		expectCode(() => observation.events(runId), "cursor_expired");
		expect(observation.events(runId, { after: { ...cursor, seq: "3" } }).events).toEqual([]);
	});

	it("indexes persisted Runs with their last event and without authorization references", () => {
		const { observation, runId } = setup();
		const runs = observation.listRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0].run.id).toBe(runId);
		expect(runs[0].run.created_at).toBeTruthy();
		expect(runs[0].last_event).not.toBeNull();
		expect("authorization_ref" in runs[0].run).toBe(false);
	});
});

describe("Graph start descriptor observation", () => {
	const policy = {
		principal: "observer-test",
		maxBytes: 4096,
		authorizeArtifact: async () => true,
		authorizeTarget: async () => true,
	};
	const body = (title: string) => JSON.stringify({ title, bindings: "models.md" });

	it("returns the newest published reference for the Run's Graph", async () => {
		const { store, observation, runId } = setup();
		expect(observation.getStartDescriptor(runId)).toBeNull();
		const graphId = observation.snapshot(runId).run.graph_id;
		const descriptors = store.configureStartDescriptors(policy);
		const first = await descriptors.publish({ request_key: "d1", graph_id: graphId, content: body("first") });
		const observed = observation.getStartDescriptor(runId);
		expect(observed).not.toBeNull();
		expect(observed!.id).toBe(first.descriptor_ref!.id);
		expect(observed!.digest).toBe(first.descriptor_ref!.digest);
		expect(Number.isFinite(Date.parse(observed!.created_at))).toBe(true);
		const second = await descriptors.publish({ request_key: "d2", graph_id: graphId, content: body("second") });
		expect(observation.getStartDescriptor(runId)!.id).toBe(second.descriptor_ref!.id);
	});

	it("omits an incomplete row instead of returning a partial reference", async () => {
		const { root, store, observation, runId } = setup();
		const graphId = observation.snapshot(runId).run.graph_id;
		await store.configureStartDescriptors(policy).publish({ request_key: "d1", graph_id: graphId, content: body("first") });
		const db = new Database(path.join(root, "graphs.sqlite"));
		cleanups.push(() => db.close());
		db.query("INSERT INTO graph_start_descriptors VALUES (?,?,?,?,?)").run(
			"incomplete",
			graphId,
			"artifact",
			"",
			"9999-01-01T00:00:00.000Z",
		);
		expect(observation.getStartDescriptor(runId)).toBeNull();
	});

	it("keys the reference by the Run's Graph and rejects unknown Runs", () => {
		const { root, observation, runId } = setup();
		const db = new Database(path.join(root, "graphs.sqlite"));
		cleanups.push(() => db.close());
		db.query("UPDATE graph_runs SET data=json_set(data,'$.graph_id','') WHERE id=?").run(runId);
		expect(observation.getStartDescriptor(runId)).toBeNull();
		expectCode(() => observation.getStartDescriptor("missing"), "unknown_run");
	});
});

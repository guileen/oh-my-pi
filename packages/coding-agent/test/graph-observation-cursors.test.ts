import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphObservation } from "../src/graph/observation";
import { GraphObservationBridge } from "../src/graph/observation-bridge";
import { GraphRunStore } from "../src/graph/store";

it("keeps event, continuation and watermark cursors independently pinned", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-cursors-"));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	let observation: GraphObservation | undefined;
	let db: Database | undefined;
	try {
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: human\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "private-authorization", digest: "sha256:test" };
		const result = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref,
				inputs: {},
				members: {},
				executors: {},
			},
		);
		if (result.state !== "accepted" || !result.target_id) throw new Error("Run setup failed");
		const runId = result.target_id;
		observation = new GraphObservation(store.definitions.root, store.definitions.limits);
		const journal = observation.snapshot(runId).cursor.journal_id;
		db = new Database(path.join(root, "graphs.sqlite"));
		db.query("INSERT INTO graph_events VALUES (?,?,?)").run(journal, 2, JSON.stringify({ type: "second" }));
		db.query("UPDATE graph_journals SET seq=2 WHERE run_id=?").run(runId);

		const watermark = { journal_id: journal, seq: "2" };
		const page = observation.events(runId, { watermark, limit: 1 });
		watermark.seq = "1";
		page.events[0].cursor.seq = "0";
		expect(page.cursor.seq).toBe("1");
		expect(page.next_cursor?.seq).toBe("1");
		expect(page.watermark.seq).toBe("2");
		page.cursor.seq = "0";
		expect(page.next_cursor?.seq).toBe("1");
		const next = observation.events(runId, { after: page.next_cursor!, watermark: page.watermark });
		expect(next.events.map(event => event.cursor.seq)).toEqual(["2"]);
		expect(next.next_cursor).toBeNull();
		const suppliedWatermark = { journal_id: journal, seq: "2" };
		let checks = 0;
		const bridge = new GraphObservationBridge(observation, () => {
			if (++checks === 2) suppliedWatermark.seq = "1";
			return true;
		});
		const bridged = await bridge.events("reader", runId, { watermark: suppliedWatermark, limit: 1 });
		expect(checks).toBe(2);
		expect(bridged.watermark.seq).toBe("2");
		expect(bridged.next_cursor?.seq).toBe("1");
	} finally {
		db?.close();
		observation?.close();
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

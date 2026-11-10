import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphLiveObservation } from "../src/graph/live-observation";
import { GraphObservation } from "../src/graph/observation";
import { GraphObservationBridge, type GraphObservationView } from "../src/graph/observation-bridge";
import { GraphRunStore } from "../src/graph/store";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(authorize: (principal: string, runId: string) => boolean | Promise<boolean> = () => true) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-live-observation-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	cleanups.push(() => store.close());
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content:
				"---\nformat: omp.graph/v1\nname: review\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
		},
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const authorization_ref = { id: "private-authorization", digest: "sha256:test" };
	const started = store.start(
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
	if (started.state !== "accepted" || !started.target_id) throw new Error("Run setup failed");
	const runId = started.target_id;
	const observation = new GraphObservation(store.definitions.root, store.definitions.limits);
	cleanups.push(() => observation.close());
	const db = new Database(path.join(root, "graphs.sqlite"));
	cleanups.push(() => db.close());
	const bridge = new GraphObservationBridge(observation, authorize);
	const live = new GraphLiveObservation(bridge, "viewer", runId);
	function commit(seq: number, factRunId = runId) {
		const cursor = observation.snapshot(runId).cursor;
		db.transaction(() => {
			db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
				cursor.journal_id,
				seq,
				JSON.stringify({
					type: "run.updated",
					run_id: factRunId,
					revision: String(seq),
					at: "2026-01-01T00:00:00.000Z",
				}),
			);
			db.query("UPDATE graph_journals SET seq=? WHERE run_id=?").run(seq, runId);
		})();
	}
	return { store, runId, db, bridge, live, commit };
}

describe("local live Graph projection", () => {
	it("returns authorized replacement views only when committed state advances", async () => {
		const { store, runId, db, live, commit } = setup();
		const first = (await live.poll())!;
		expect(first.cursor.seq).toBe("1");
		expect(first.invocations[0].state).toBe("pending");
		expect(JSON.stringify(first)).not.toContain("private-authorization");
		first.cursor.seq = "999"; // A caller cannot mutate the follower's checkpoint.
		expect(await live.poll()).toBeNull();
		const schedule = store.getScheduleState(runId)!;
		schedule.invocations[0].state = "running";
		db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(schedule), runId);
		commit(2);
		const next = (await live.poll())!;
		expect(next.cursor.seq).toBe("2");
		expect(next.invocations[0].state).toBe("running");
		expect(await live.poll()).toBeNull();
	});

	it("pins a retained view cursor across asynchronous authorization while following", async () => {
		const gate = Promise.withResolvers<boolean>();
		const checking = Promise.withResolvers<void>();
		let suspend = false;
		const { bridge, live, commit } = setup(() => {
			if (suspend) {
				suspend = false;
				checking.resolve();
				return gate.promise;
			}
			return true;
		});
		const readView = bridge.view.bind(bridge);
		let retained: GraphObservationView | undefined;
		bridge.view = async (...args) => {
			const view = await readView(...args);
			retained = view;
			return view;
		};
		await live.poll();
		commit(2);
		const readEvents = bridge.events.bind(bridge);
		bridge.events = (...args) => {
			suspend = true;
			return readEvents(...args);
		};
		const pending = live.poll();
		await checking.promise;
		retained!.cursor.journal_id = "foreign";
		retained!.cursor.seq = "999";
		commit(3);
		gate.resolve(true);
		const next = (await pending)!;
		expect(next.cursor.seq).toBe("2");
		expect(next.cursor.journal_id).not.toBe("foreign");
		expect((await live.poll())!.cursor.seq).toBe("3");
		expect(await live.poll()).toBeNull();
	});

	it("rechecks authorization even when unchanged, and does not advance after denial", async () => {
		let allowed = true;
		const { live, commit } = setup(principal => allowed && principal === "viewer");
		await live.poll();
		allowed = false;
		await expect(live.poll()).rejects.toMatchObject({ code: "scope_denied" });
		commit(2);
		await expect(live.poll()).rejects.toMatchObject({ code: "scope_denied" });
		allowed = true;
		expect((await live.poll())!.cursor.seq).toBe("2");
	});

	it("fails closed on missing or unsupported facts without advancing", async () => {
		const { live, commit, db, runId } = setup();
		const first = (await live.poll())!;
		commit(3);
		await expect(live.poll()).rejects.toMatchObject({ code: "cursor_expired" });
		db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
			first.cursor.journal_id,
			2,
			JSON.stringify({ type: "run.updated", run_id: "other", revision: "2", at: "2026-01-01T00:00:00.000Z" }),
		);
		await expect(live.poll()).rejects.toMatchObject({ code: "unsupported" });
		db.query("UPDATE graph_events SET data=? WHERE journal_id=? AND seq=2").run(
			JSON.stringify({ type: "run.updated", run_id: runId, revision: "2", at: "2026-01-01T00:00:00.000Z" }),
			first.cursor.journal_id,
		);
		expect((await live.poll())!.cursor.seq).toBe("3");
	});

	it("checks every page before advancing across a large journal interval", async () => {
		const { live, commit, db } = setup();
		const first = (await live.poll())!;
		db.transaction(() => {
			for (let seq = 2; seq <= 101; seq++) {
				db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
					first.cursor.journal_id,
					seq,
					JSON.stringify({
						type: "run.updated",
						run_id: first.run.id,
						revision: String(seq),
						at: "2026-01-01T00:00:00.000Z",
					}),
				);
			}
		})();
		commit(102, "other");
		await expect(live.poll()).rejects.toMatchObject({ code: "unsupported" });
		db.query("UPDATE graph_events SET data=? WHERE journal_id=? AND seq=102").run(
			JSON.stringify({ type: "run.updated", run_id: first.run.id, revision: "102", at: "2026-01-01T00:00:00.000Z" }),
			first.cursor.journal_id,
		);
		expect((await live.poll())!.cursor.seq).toBe("102");
	});

	it("rechecks authorization after collecting changed journal pages", async () => {
		let checks = 0;
		let denyLastCheck = false;
		const { live, commit } = setup(() => !(denyLastCheck && ++checks === 4));
		await live.poll();
		commit(2);
		denyLastCheck = true;
		checks = 0;
		await expect(live.poll()).rejects.toMatchObject({ code: "scope_denied" });
		denyLastCheck = false;
		expect((await live.poll())!.cursor.seq).toBe("2");
	});

	it("rejects overlapping polls instead of racing checkpoints", async () => {
		const gate = Promise.withResolvers<boolean>();
		let calls = 0;
		const { live } = setup(() => (++calls === 1 ? gate.promise : true));
		const pending = live.poll();
		await expect(live.poll()).rejects.toMatchObject({ code: "unsupported" });
		gate.resolve(true);
		expect((await pending)!.cursor.seq).toBe("1");
	});
});

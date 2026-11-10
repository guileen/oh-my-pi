import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphObservation } from "../src/graph/observation";
import { GraphObservationBridge } from "../src/graph/observation-bridge";
import { GraphRunStore } from "../src/graph/store";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(
	content = "---\nformat: omp.graph/v1\nname: review\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-bridge-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	cleanups.push(() => store.close());
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
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
	const observation = new GraphObservation(store.definitions.root, store.definitions.limits);
	cleanups.push(() => observation.close());
	return { root, store, observation, runId: result.target_id };
}

describe("authorized Graph observation bridge", () => {
	it("denies disclosure when authorization returns a non-boolean value", async () => {
		const { observation, runId } = setup();
		const bridge = new GraphObservationBridge(observation, () => "false" as unknown as boolean);
		await expect(bridge.snapshot("viewer", runId)).rejects.toMatchObject({ code: "scope_denied" });
	});

	it("serves the typed local view only after Run authorization and never negotiates incomplete wire support", async () => {
		const { observation, runId } = setup();
		let allowed = true;
		const bridge = new GraphObservationBridge(
			observation,
			(principal: string, id) => allowed && principal === "viewer" && id === runId,
		);
		await expect(bridge.view("other", runId)).rejects.toMatchObject({ code: "scope_denied" });
		await expect(bridge.extensions("other", runId, ["graph.execution.v1"])).rejects.toMatchObject({
			code: "scope_denied",
		});
		await expect(bridge.executionRecords("other", runId)).rejects.toMatchObject({ code: "scope_denied" });
		const view = await bridge.view("viewer", runId);
		expect(view.nodes).toEqual([{ id: "approval", kind: "human", member: null }]);
		expect(view.invocations[0]).toMatchObject({ kind: "node", node: "approval", member: null });
		expect(JSON.stringify(view)).not.toContain("private-authorization");
		expect(await bridge.extensions("viewer", runId, ["graph.execution.v1"])).toEqual([]);
		await expect(bridge.executionRecords("viewer", runId)).rejects.toMatchObject({ code: "capability_unavailable" });
		allowed = false;
		await expect(bridge.view("viewer", runId)).rejects.toMatchObject({ code: "scope_denied" });
	});

	it("rechecks authorization before returning the local view", async () => {
		const { observation, runId } = setup();
		let checks = 0;
		const bridge = new GraphObservationBridge(observation, () => ++checks === 1);
		await expect(bridge.view("viewer", runId)).rejects.toMatchObject({ code: "scope_denied" });
		expect(checks).toBe(2);
	});
	it("rechecks authorization before returning journal facts", async () => {
		const { observation, runId } = setup();
		let checks = 0;
		const bridge = new GraphObservationBridge(observation, () => ++checks === 1);
		await expect(bridge.events("viewer", runId)).rejects.toMatchObject({ code: "scope_denied" });
		expect(checks).toBe(2);
	});

	it("replays committed local view replacements at a pinned watermark without exposing private reasons", async () => {
		const { store, observation, runId } = setup();
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		const bridge = new GraphObservationBridge(observation, () => true);
		const initial = await bridge.view("viewer", runId);
		expect(
			store.mutateLifecycle("viewer", {
				version: 1,
				request_key: "hold",
				operation: "hold",
				target_id: runId,
				if_revision: initial.run.revision,
				payload: { reason: "private-reason" },
			}).state,
		).toBe("completed");
		const first = await bridge.viewHistory("viewer", runId, { limit: 1 });
		expect(first.views).toEqual([initial]);
		expect(first.next_cursor).toEqual(initial.cursor);
		const second = await bridge.viewHistory("viewer", runId, {
			after: first.next_cursor!,
			watermark: first.watermark,
			limit: 1,
		});
		expect(second.views[0].run).toMatchObject({ revision: "2", state: "held" });
		expect(second.views[0]).toEqual(await bridge.view("viewer", runId));
		expect(second.next_cursor).toBeNull();
		expect(JSON.stringify(second)).not.toContain("private-reason");
		expect(JSON.stringify(second)).not.toContain("private-authorization");
	});

	it("retains invocation state at each committed journal cursor", async () => {
		const { store, observation, runId } = setup();
		const bridge = new GraphObservationBridge(observation, () => true);
		const owner = store.claimHost()!;
		expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
		const history = await bridge.viewHistory("viewer", runId);
		expect(history.views.map(view => view.invocations[0].state)).toEqual(["pending", "ready"]);
		expect(history.views[1]).toEqual(await bridge.view("viewer", runId));
	});

	it("pins the requested history boundary before awaiting authorization", async () => {
		const { store, observation, runId } = setup();
		const initial = observation.snapshot(runId);
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		store.mutateLifecycle("viewer", {
			version: 1,
			request_key: "hold",
			operation: "hold",
			target_id: runId,
			if_revision: "1",
			payload: { reason: "hold" },
		});
		const permission = Promise.withResolvers<boolean>();
		const bridge = new GraphObservationBridge(observation, () => permission.promise);
		const options = { watermark: { ...initial.cursor }, limit: 1 };
		const pending = bridge.viewHistory("viewer", runId, options);
		options.watermark.seq = "2";
		options.limit = 100;
		permission.resolve(true);
		const page = await pending;
		expect(page.watermark).toEqual(initial.cursor);
		expect(page.views.map(view => view.run.state)).toEqual(["queued"]);
		expect(page.next_cursor).toBeNull();
	});

	it("tells an operator which kind of hold they can lift without leaking the hold reason", async () => {
		const { store, observation, runId } = setup();
		store.configureLifecycle({ authorize: () => true, verifyResume: () => true });
		const bridge = new GraphObservationBridge(observation, () => true);
		expect((await bridge.snapshot("viewer", runId)).run.hold_kind).toBeUndefined();
		expect(
			store.mutateLifecycle("viewer", {
				version: 1,
				request_key: "hold-operator",
				operation: "hold",
				target_id: runId,
				if_revision: "1",
				payload: { reason: "private-reason", kind: "operator" },
			}).state,
		).toBe("completed");
		const summary = (await bridge.snapshot("viewer", runId)).run;
		expect([summary.state, summary.hold_kind]).toEqual(["held", "operator"]);
		expect(JSON.stringify(summary)).not.toContain("private-reason");
	});

	it("distinguishes a completed refusal from execution failure in current and historical views", async () => {
		const { store, observation, runId } = setup(
			"---\nformat: omp.graph/v1\nname: review\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval', outcomes: [approve, revise], terminal: {approve: succeed, revise: hold}}\n---\n## approval\nDecide.\n",
		);
		store.configureHuman((_action, principal) => principal === "viewer");
		const owner = store.claimHost()!;
		store.schedule(runId, owner.owner_id, owner.epoch);
		const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
		const question = store.createHumanQuestion(owner.owner_id, owner.epoch, "viewer", runId, intent.invocation_id, {
			id: "private-question",
			digest: "sha256:question",
		});
		const bridge = new GraphObservationBridge(observation, () => true);
		const waiting = await bridge.view("viewer", runId);
		expect(
			store.answerHuman({
				request_key: "answer",
				principal: "viewer",
				run_id: runId,
				invocation_id: intent.invocation_id,
				decision_id: question.id,
				input_digest: question.input_digest,
				if_revision: waiting.run.revision,
				outcome: "revise",
				verdict: "revise",
				content_ref: { id: "private-answer", digest: "sha256:answer" },
				evidence_refs: [],
				reason: "Needs work",
				author_ref: { id: "viewer", digest: "sha256:viewer" },
			}).state,
		).toBe("completed");
		store.schedule(runId, owner.owner_id, owner.epoch);
		const current = await bridge.view("viewer", runId);
		expect(current.run.state).toBe("held");
		expect(current.invocations[0]).toMatchObject({ state: "succeeded", selected_outcome: "revise" });
		const history = await bridge.viewHistory("viewer", runId);
		expect(history.views.find(view => view.cursor.seq === waiting.cursor.seq)?.invocations[0]).toMatchObject({
			state: "waiting",
			selected_outcome: null,
		});
		expect(history.views.at(-1)).toEqual(current);
		expect(JSON.stringify(history)).not.toContain("private-answer");
		expect(JSON.stringify(history)).not.toContain("private-question");
	});

	it("fails closed on missing replacements, rechecks authorization, and rolls back failed journal writes", async () => {
		const { root, store, observation, runId } = setup();
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		const db = new Database(path.join(root, "graphs.sqlite"));
		cleanups.push(() => db.close());
		db.exec(
			"CREATE TRIGGER fail_observation BEFORE INSERT ON graph_observation_replacements BEGIN SELECT RAISE(ABORT, 'failed'); END",
		);
		expect(() =>
			store.mutateLifecycle("viewer", {
				version: 1,
				request_key: "hold",
				operation: "hold",
				target_id: runId,
				if_revision: "1",
				payload: { reason: "private" },
			}),
		).toThrow();
		expect(store.getRun(runId)).toMatchObject({ revision: "1", state: "queued" });
		db.exec("DROP TRIGGER fail_observation");
		let checks = 0;
		const revoked = new GraphObservationBridge(observation, () => ++checks === 1);
		await expect(revoked.viewHistory("viewer", runId)).rejects.toMatchObject({ code: "scope_denied" });
		db.query("DELETE FROM graph_observation_replacements").run();
		const bridge = new GraphObservationBridge(observation, () => true);
		await expect(bridge.viewHistory("viewer", runId)).rejects.toMatchObject({ code: "capability_unavailable" });
	});

	it("checks the principal before every read and returns only committed allowed fields", async () => {
		const { observation, runId } = setup();
		let allowed = true;
		const bridge = new GraphObservationBridge(
			observation,
			(principal: string, id) => allowed && principal === "viewer" && id === runId,
		);
		await expect(bridge.snapshot("other", runId)).rejects.toMatchObject({ code: "scope_denied" });
		await expect(bridge.snapshot("viewer", "missing")).rejects.toMatchObject({ code: "scope_denied" });
		const snapshot = await bridge.snapshot("viewer", runId);
		expect(snapshot.run).toEqual({
			id: runId,
			graph_id: expect.any(String),
			revision: "1",
			definition_revision: "1",
			state: "queued",
			created_at: expect.any(String),
			updated_at: expect.any(String),
		});
		expect(JSON.stringify(snapshot)).not.toContain("private-authorization");
		const page = await bridge.events("viewer", runId);
		expect(page.events).toEqual([
			{ cursor: snapshot.cursor, type: "run.created", run_id: runId, revision: "1", at: snapshot.run.created_at },
		]);
		expect(page.watermark).toEqual(snapshot.cursor);
		allowed = false;
		await expect(bridge.events("viewer", runId, { after: snapshot.cursor })).rejects.toMatchObject({
			code: "scope_denied",
		});
	});

	it("does not disclose extra journal data and rejects unsupported facts without advancing a cursor", async () => {
		const { root, observation, runId } = setup();
		const bridge = new GraphObservationBridge(observation, () => true);
		const snapshot = await bridge.snapshot("viewer", runId);
		const db = new Database(path.join(root, "graphs.sqlite"));
		cleanups.push(() => db.close());
		db.transaction(() => {
			db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
				snapshot.cursor.journal_id,
				2,
				JSON.stringify({
					type: "run.updated",
					run_id: runId,
					revision: "2",
					at: snapshot.run.updated_at,
					private: "secret",
				}),
			);
			db.query("UPDATE graph_journals SET seq=2 WHERE run_id=?").run(runId);
		})();
		const page = await bridge.events("viewer", runId, { after: snapshot.cursor });
		expect(page.events).toHaveLength(1);
		expect(JSON.stringify(page)).not.toContain("secret");
		db.query("UPDATE graph_events SET data=? WHERE journal_id=? AND seq=2").run(
			JSON.stringify({ type: "run.updated", run_id: "other", revision: "2", at: snapshot.run.updated_at }),
			snapshot.cursor.journal_id,
		);
		await expect(bridge.events("viewer", runId, { after: snapshot.cursor })).rejects.toMatchObject({
			code: "unsupported",
		});
	});
	it("pins replay to a captured watermark while new events arrive", async () => {
		const { root, observation, runId } = setup();
		const bridge = new GraphObservationBridge(observation, () => true);
		const snapshot = await bridge.snapshot("viewer", runId);
		const db = new Database(path.join(root, "graphs.sqlite"));
		cleanups.push(() => db.close());
		db.transaction(() => {
			for (let seq = 2; seq <= 3; seq++) {
				db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
					snapshot.cursor.journal_id,
					seq,
					JSON.stringify({
						type: "run.updated",
						run_id: runId,
						revision: String(seq),
						at: snapshot.run.updated_at,
					}),
				);
			}
			db.query("UPDATE graph_journals SET seq=3 WHERE run_id=?").run(runId);
		})();
		const first = await bridge.events("viewer", runId, { after: snapshot.cursor, limit: 1 });
		expect(first.watermark.seq).toBe("3");
		db.transaction(() => {
			db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
				snapshot.cursor.journal_id,
				4,
				JSON.stringify({ type: "run.updated", run_id: runId, revision: "4", at: snapshot.run.updated_at }),
			);
			db.query("UPDATE graph_journals SET seq=4 WHERE run_id=?").run(runId);
		})();
		const second = await bridge.events("viewer", runId, {
			after: first.cursor,
			watermark: first.watermark,
			limit: 1,
		});
		expect(second.events.map(event => event.cursor.seq)).toEqual(["3"]);
		expect(second.next_cursor).toBeNull();
		expect(second.watermark).toEqual(first.watermark);
		const live = await bridge.events("viewer", runId, { after: second.cursor });
		expect(live.events.map(event => event.cursor.seq)).toEqual(["4"]);
		await expect(
			bridge.events("viewer", runId, { after: live.cursor, watermark: first.watermark }),
		).rejects.toMatchObject({
			code: "invalid_cursor",
		});
		await expect(
			bridge.events("viewer", runId, {
				watermark: { journal_id: "other", seq: "3" },
			}),
		).rejects.toMatchObject({ code: "invalid_cursor" });
	});
});

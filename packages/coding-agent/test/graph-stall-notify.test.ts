import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphLifecycleRequest } from "../src/graph/store";
import { GRAPH_CLI_LIMITS } from "../src/graph/cli";
import { GraphObservation } from "../src/graph/observation";
import { GraphRunStore } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-stall-"));
	roots.push(root);
	return root;
}

function source(threshold?: number) {
	const extensions =
		threshold === undefined ? "" : `extensions:\n  x-contract:\n    stall_threshold_ms: ${threshold}\n`;
	return `---\nformat: omp.graph/v1\nname: stall-demo\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n${extensions}---\n## approval\nDecide.\n`;
}

function start(root: string, threshold?: number) {
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content: source(threshold) },
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
	store.configureLifecycle({ authorize: () => true, verifyResume: () => true });
	return { store, runId: started.target_id! };
}

const control = (
	store: GraphRunStore,
	runId: string,
	key: string,
	operation: "hold" | "cancel",
	payload: { reason: string; kind?: "operator" } = { reason: "requested" },
): GraphLifecycleRequest => ({
	version: 1,
	request_key: key,
	target_id: runId,
	if_revision: store.getRun(runId)!.revision,
	operation,
	payload,
});

describe("stall alarms", () => {
	it("raises one alarm per idle window and stays silent on a repeated sweep", async () => {
		const root = setup();
		const { store, runId } = start(root);
		const run = store.getRun(runId)!;
		const base = Date.parse(run.updated_at);

		expect(await store.emitStallNotifications({ now: base + 30_000, defaultThresholdMs: 60_000 })).toEqual([]);
		const raised = await store.emitStallNotifications({ now: base + 61_000, defaultThresholdMs: 60_000 });
		expect(raised).toEqual([{ run_id: runId, activity_at: run.updated_at, threshold_ms: 60_000 }]);
		expect(await store.emitStallNotifications({ now: base + 300_000, defaultThresholdMs: 60_000 })).toEqual([]);

		// The alarm is observation data: the Run keeps its state and revision.
		expect(store.getRun(runId)).toMatchObject({ state: run.state, revision: run.revision });
		store.close();
	});

	it("re-arms after new liveness and honours a declared threshold over the default", async () => {
		const root = setup();
		const { store, runId } = start(root, 600_000);
		const base = Date.parse(store.getRun(runId)!.updated_at);
		expect(await store.emitStallNotifications({ now: base + 120_000, defaultThresholdMs: 60_000 })).toEqual([]);

		store.recordInvocationActivity(runId, "inv-1", "approval", { turn: true, summary: "model: plan" });
		const resumed = Date.parse(store.getRun(runId)!.updated_at);
		expect(await store.emitStallNotifications({ now: resumed + 300_000, defaultThresholdMs: 60_000 })).toEqual([]);
		const raised = await store.emitStallNotifications({ now: resumed + 601_000, defaultThresholdMs: 60_000 });
		expect(raised).toHaveLength(1);
		expect(raised[0]).toMatchObject({ run_id: runId, threshold_ms: 600_000 });
		store.close();
	});

	it("never alarms a terminal Run", async () => {
		const root = setup();
		const { store, runId } = start(root);
		expect(store.mutateLifecycle("alice", control(store, runId, "cancel", "cancel")).error).toBeNull();
		expect(store.getRun(runId)!.state).toBe("cancelled");
		expect(await store.emitStallNotifications({ now: Date.now() + 3_600_000, defaultThresholdMs: 1 })).toEqual([]);
		store.close();
	});

	it("shares the outbox with transitions without starving a later notification", async () => {
		const root = setup();
		const { store, runId } = start(root);
		const base = Date.parse(store.getRun(runId)!.updated_at);
		await store.emitStallNotifications({ now: base + 61_000, defaultThresholdMs: 60_000 });

		const hold = control(store, runId, "hold", "hold", { reason: "focus", kind: "operator" });
		expect(store.mutateLifecycle("alice", hold).error).toBeNull();
		store.close();

		const observation = new GraphObservation(root, GRAPH_CLI_LIMITS);
		try {
			const page = observation.notifications({ since: 0 });
			const kinds = page.notifications.map(item => item.kind);
			expect(kinds).toEqual(["run.stalled", "run.held"]);
			expect(new Set(page.notifications.map(item => item.sequence)).size).toBe(2);
			expect(page.notifications[0]!.stall).toMatchObject({ threshold_ms: 60_000 });
			expect(page.notifications[1]!.state).toBe("held");
		} finally {
			observation.close();
		}
	});
});

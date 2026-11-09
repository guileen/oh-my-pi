import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphNotificationPage } from "@oh-my-pi/pi-wire/graph";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import { GraphNotificationConsumerCursor } from "../src/graph/notification-consumer";
import { buildRunIndex, GraphObservation, GraphObservationError } from "../src/graph/observation";
import { GraphRunStore } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-heartbeat-"));
	roots.push(root);
	return root;
}

function startRun(root: string) {
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content:
				"---\nformat: omp.graph/v1\nname: heartbeat\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
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
	store.configureLifecycle({ authorize: () => true, verifyResume: () => true });
	return { store, runId: started.target_id! };
}

describe("graph invocation liveness", () => {
	it("surfaces recorded turns and the latest activity label without completing the Run", async () => {
		const root = setup();
		const { store, runId } = startRun(root);
		store.recordInvocationActivity(runId, "inv-1", "approval", { turn: true, summary: "model: plan" });
		store.recordInvocationActivity(runId, "inv-1", "approval", { turn: true, summary: "tool:graph_publish" });
		const before = store.getRun(runId)!;
		expect(before.state).toBe("queued");
		store.close();

		const observation = new GraphObservation(root, GRAPH_CLI_LIMITS);
		try {
			const index = await buildRunIndex(observation, () => true);
			expect(index.runs).toHaveLength(1);
			const [entry] = index.runs;
			expect(entry.state).toBe("queued");
			expect(entry.turn_count).toBe(2);
			expect(entry.activity_summary).toBe("tool:graph_publish");
			expect(Date.parse(entry.last_activity_at)).toBeGreaterThanOrEqual(Date.parse(entry.created_at));
		} finally {
			observation.close();
		}
	});

	it("prints the turn count and activity label in the human runs view", async () => {
		const root = setup();
		const { store, runId } = startRun(root);
		store.recordInvocationActivity(runId, "inv-1", "approval", { turn: true, summary: "model: draft" });
		store.close();

		let stdout = "";
		const io = { out: (text: string) => void (stdout += text), err: () => {} };
		const code = await runGraphCommand(["runs"], { root, ...io, authorizeRunObservation: () => true });
		expect(code).toBe(0);
		expect(stdout).toContain("turns:1");
		expect(stdout).toContain("model: draft");
	});
	it("stalls a Run by its frozen declaration instead of the index default", async () => {
		const root = setup();
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import-threshold",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: stall-threshold\nmembers: {}\nextensions:\n  x-contract:\n    stall_threshold_ms: 60000\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "private-authorization", digest: "sha256:test" };
		const started = store.start(
			{
				version: 1,
				request_key: "start-threshold",
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
		const createdAt = store.getRun(started.target_id!)!.updated_at;
		store.close();

		const observation = new GraphObservation(root, GRAPH_CLI_LIMITS);
		try {
			const early = await buildRunIndex(observation, () => true, { now: Date.parse(createdAt) + 30_000 });
			expect(early.runs[0]!.stall_threshold_ms).toBe(60_000);
			expect(early.runs[0]!.stalled).toBe(false);
			// The declaration wins over a much smaller index default.
			const declared = await buildRunIndex(observation, () => true, {
				now: Date.parse(createdAt) + 30_000,
				stallThresholdMs: 1_000,
			});
			expect(declared.runs[0]!.stalled).toBe(false);
			const late = await buildRunIndex(observation, () => true, { now: Date.parse(createdAt) + 60_001 });
			expect(late.runs[0]!.stalled).toBe(true);
		} finally {
			observation.close();
		}
	});
});

describe("notification consumer cursor", () => {
	it("resumes from its saved position and never rewinds", () => {
		const root = setup();
		const cursor = new GraphNotificationConsumerCursor(root, "orchestrator");
		expect(cursor.read()).toBe(0);
		expect(cursor.advance(5)).toBe(5);
		expect(cursor.advance(3)).toBe(5);
		expect(cursor.read()).toBe(5);
		const file = path.join(root, "consumers", "orchestrator.json");
		expect((JSON.parse(fs.readFileSync(file, "utf8")) as { cursor: number }).cursor).toBe(5);
	});

	it("rejects an unusable name and a corrupt cursor file", () => {
		const root = setup();
		expect(() => new GraphNotificationConsumerCursor(root, "Bad Name")).toThrow(GraphObservationError);
		fs.mkdirSync(path.join(root, "consumers"), { recursive: true });
		fs.writeFileSync(path.join(root, "consumers", "broken.json"), "not json");
		expect(() => new GraphNotificationConsumerCursor(root, "broken").read()).toThrow(GraphObservationError);
	});

	it("serves each notification once per consumer and lets an explicit --since override resume", async () => {
		const root = setup();
		const { store, runId } = startRun(root);
		store.mutateLifecycle("alice", {
			version: 1,
			operation: "hold",
			target_id: runId,
			request_key: "hold-1",
			if_revision: "1",
			payload: { reason: "Pause one" },
		});
		let stdout = "";
		const io = { out: (text: string) => void (stdout += text), err: () => {} };
		const first = await runGraphCommand(["notifications", "--format", "json", "--consumer", "orchestrator"], {
			root,
			...io,
			authorizeRunObservation: () => true,
		});
		expect(first).toBe(0);
		const firstPage = JSON.parse(stdout) as GraphNotificationPage;
		expect(firstPage.notifications).toHaveLength(1);
		expect(firstPage.notifications[0].reason).toBe("Pause one");

		// Same consumer, no new records: the saved cursor suppresses a redelivery.
		stdout = "";
		const empty = await runGraphCommand(["notifications", "--format", "json", "--consumer", "orchestrator"], {
			root,
			...io,
			authorizeRunObservation: () => true,
		});
		expect(empty).toBe(0);
		expect((JSON.parse(stdout) as GraphNotificationPage).notifications).toHaveLength(0);

		// A new transition is delivered to the same consumer.
		store.mutateLifecycle("alice", {
			version: 1,
			operation: "resume",
			target_id: runId,
			request_key: "resume-1",
			if_revision: "2",
			payload: { decision_ref: { id: "decision", digest: "sha256:test" } },
		});
		store.mutateLifecycle("alice", {
			version: 1,
			operation: "hold",
			target_id: runId,
			request_key: "hold-2",
			if_revision: "3",
			payload: { reason: "Pause two" },
		});
		stdout = "";
		const second = await runGraphCommand(["notifications", "--format", "json", "--consumer", "orchestrator"], {
			root,
			...io,
			authorizeRunObservation: () => true,
		});
		expect(second).toBe(0);
		expect((JSON.parse(stdout) as GraphNotificationPage).notifications.map(note => note.reason)).toEqual([
			"Pause two",
		]);

		// An explicit cursor is the caller's decision, not the consumer's.
		stdout = "";
		await runGraphCommand(["notifications", "--format", "json", "--since", "0"], {
			root,
			...io,
			authorizeRunObservation: () => true,
		});
		expect((JSON.parse(stdout) as GraphNotificationPage).notifications.map(note => note.reason)).toEqual([
			"Pause one",
			"Pause two",
		]);
		store.close();
	});

	it("follows within the deadline and exits cleanly when the page is drained", async () => {
		const root = setup();
		const { store, runId } = startRun(root);
		store.mutateLifecycle("alice", {
			version: 1,
			operation: "hold",
			target_id: runId,
			request_key: "hold",
			if_revision: "1",
			payload: { reason: "Follow me" },
		});
		store.close();

		let stdout = "";
		const started = Date.now();
		const code = await runGraphCommand(
			["notifications", "--consumer", "follower", "--follow", "--timeout-ms", "400"],
			{
				root,
				out: (text: string) => void (stdout += text),
				err: () => {},
				authorizeRunObservation: () => true,
			},
		);
		expect(code).toBe(0);
		expect(Date.now() - started).toBeGreaterThanOrEqual(300);
		expect(stdout.match(/run\.held/g)).toHaveLength(1);
	});
});

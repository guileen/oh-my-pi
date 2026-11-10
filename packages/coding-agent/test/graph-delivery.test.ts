import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import { GRAPH_DELIVERY_FORMAT, type GraphDeliveryEnvelope, deliverGraphNotifications } from "../src/graph/delivery";
import { GraphNotificationConsumerCursor } from "../src/graph/notification-consumer";
import { GraphObservation, GraphObservationError } from "../src/graph/observation";
import { GraphRunStore } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-delivery-"));
	roots.push(root);
	return root;
}

/** Start one Run and hold it, so the outbox has exactly one `run.held` record to hand over. */
function startHeldRun(root: string, labels: { title?: string; report_to?: string } = {}) {
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content:
				"---\nformat: omp.graph/v1\nname: delivery\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
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
			...labels,
		},
	);
	store.configureLifecycle({ authorize: () => true, verifyResume: () => true });
	const runId = started.target_id!;
	const held = store.mutateLifecycle("alice", {
		version: 1,
		operation: "hold",
		target_id: runId,
		request_key: "hold-1",
		if_revision: "1",
		payload: { reason: "Await human" },
	});
	expect(held.error).toBeNull();
	store.close();
	return runId;
}

/** Count outbox records visible to an unrestricted observer. */
function outboxSize(root: string): number {
	const observation = new GraphObservation(root, GRAPH_CLI_LIMITS);
	try {
		return observation.notifications().notifications.length;
	} finally {
		observation.close();
	}
}

describe("graph notification delivery", () => {
	it("hands one envelope per authorized record and advances the consumer cursor", async () => {
		const root = setup();
		startHeldRun(root, { title: "delivery task", report_to: "wherdr:session" });
		const envelopes: GraphDeliveryEnvelope[] = [];
		const first = await deliverGraphNotifications({
			root,
			consumer: "orchestrator",
			command: ["unused"],
			authorize: () => true,
			deliver: async envelope => {
				envelopes.push(envelope);
				return { exitCode: 0, timedOut: false };
			},
		});
		expect(first.format).toBe(GRAPH_DELIVERY_FORMAT);
		expect(first.consumer).toBe("orchestrator");
		expect(first.failure).toBeNull();
		expect(first.delivered).toHaveLength(1);
		expect(first.cursor).toBeGreaterThan(0);
		expect(envelopes).toHaveLength(1);
		const envelope = envelopes[0]!;
		expect(envelope.format).toBe(GRAPH_DELIVERY_FORMAT);
		expect(envelope.consumer).toBe("orchestrator");
		expect(Number.isNaN(Date.parse(envelope.delivered_at))).toBe(false);
		expect(envelope.notification.id).toBe(first.delivered[0]!);
		expect(envelope.notification.kind).toBe("run.held");
		expect(envelope.notification.title).toBe("delivery task");
		expect(envelope.notification.report_to).toBe("wherdr:session");

		// The cursor is durable: a second delivery call has nothing left to hand over.
		const again = await deliverGraphNotifications({
			root,
			consumer: "orchestrator",
			command: ["unused"],
			authorize: () => true,
			deliver: async envelope => {
				envelopes.push(envelope);
				return { exitCode: 0, timedOut: false };
			},
		});
		expect(again.delivered).toEqual([]);
		expect(again.cursor).toBe(first.cursor);
		expect(envelopes).toHaveLength(1);
		// Delivery is a read: the record and the Run are untouched.
		expect(outboxSize(root)).toBe(1);
	});

	it("keeps the cursor when the command fails, so a retry redelivers", async () => {
		const root = setup();
		const runId = startHeldRun(root);
		const failed = await deliverGraphNotifications({
			root,
			consumer: "orchestrator",
			command: ["unused"],
			authorize: () => true,
			deliver: async () => ({ exitCode: 1, timedOut: false }),
		});
		expect(failed.delivered).toEqual([]);
		expect(failed.failure?.exit_code).toBe(1);
		expect(failed.failure?.timed_out).toBe(false);
		expect(failed.cursor).toBe(0);
		expect(new GraphNotificationConsumerCursor(root, "orchestrator").read()).toBe(0);

		const delivered: string[] = [];
		const retried = await deliverGraphNotifications({
			root,
			consumer: "orchestrator",
			command: ["unused"],
			authorize: candidate => candidate === runId,
			deliver: async envelope => {
				delivered.push(envelope.notification.id);
				return { exitCode: 0, timedOut: false };
			},
		});
		expect(retried.failure).toBeNull();
		expect(delivered).toHaveLength(1);
		expect(retried.cursor).toBeGreaterThan(0);
		expect(new GraphNotificationConsumerCursor(root, "orchestrator").read()).toBe(retried.cursor);
	});

	it("reports a timed out command as a failure instead of a successful handover", async () => {
		const root = setup();
		startHeldRun(root);
		const result = await deliverGraphNotifications({
			root,
			consumer: "orchestrator",
			command: ["unused"],
			authorize: () => true,
			deliver: async () => ({ exitCode: null, timedOut: true }),
		});
		expect(result.delivered).toEqual([]);
		expect(result.failure?.timed_out).toBe(true);
		expect(result.failure?.exit_code).toBeNull();
		expect(result.cursor).toBe(0);
	});

	it("skips records for Runs the caller may not observe, without running the command", async () => {
		const root = setup();
		startHeldRun(root);
		let calls = 0;
		const result = await deliverGraphNotifications({
			root,
			consumer: "orchestrator",
			command: ["unused"],
			authorize: () => false,
			deliver: async () => {
				calls += 1;
				return { exitCode: 0, timedOut: false };
			},
		});
		expect(result.delivered).toEqual([]);
		expect(result.failure).toBeNull();
		expect(calls).toBe(0);
		expect(outboxSize(root)).toBe(1);
	});

	it("rejects an invalid consumer name and an empty command before reading the outbox", async () => {
		const root = setup();
		startHeldRun(root);
		expect(
			deliverGraphNotifications({ root, consumer: "Bad Name", command: ["x"], authorize: () => true }),
		).rejects.toBeInstanceOf(GraphObservationError);
		expect(
			deliverGraphNotifications({ root, consumer: "orchestrator", command: [], authorize: () => true }),
		).rejects.toBeInstanceOf(GraphObservationError);
	});

	it("serves delivery over the CLI only to an authorized observer", async () => {
		const root = setup();
		startHeldRun(root);
		let stdout = "";
		let stderr = "";
		const io = { out: (text: string) => void (stdout += text), err: (text: string) => void (stderr += text) };

		const denied = await runGraphCommand(
			["deliver", "--consumer", "smoke", "--command", "true", "--format", "json"],
			{ root, ...io },
		);
		expect(denied).toBe(3);
		expect((JSON.parse(stdout) as { error: { code: string } }).error.code).toBe("permission_denied");

		stdout = "";
		stderr = "";
		const code = await runGraphCommand(
			["deliver", "--consumer", "smoke", "--command", "cat >/dev/null", "--format", "json"],
			{ root, ...io, authorizeRunObservation: () => true },
		);
		expect(code).toBe(0);
		const frame = JSON.parse(stdout) as { format: string; delivered: string[]; cursor: number; failure: unknown };
		expect(frame.format).toBe(GRAPH_DELIVERY_FORMAT);
		expect(frame.delivered).toHaveLength(1);
		expect(frame.cursor).toBeGreaterThan(0);
		expect(frame.failure).toBeNull();
		expect(stderr).toBe("");
		expect(new GraphNotificationConsumerCursor(root, "smoke").read()).toBe(frame.cursor);
	});
});

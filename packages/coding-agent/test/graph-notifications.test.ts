import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_NOTIFICATION_FORMAT, type GraphNotificationPage } from "@oh-my-pi/pi-wire/graph";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import { GraphObservation } from "../src/graph/observation";
import { GraphRunStore } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-notify-"));
	roots.push(root);
	return root;
}

function startRun(root: string, labels: { title?: string; report_to?: string } = {}) {
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content:
				"---\nformat: omp.graph/v1\nname: notifications\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
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
	return { store, started };
}

describe("graph notification outbox", () => {
	it("records one held notification with the dispatch labels and nothing for the queued state", () => {
		const root = setup();
		const { store, started } = startRun(root, { title: "review task", report_to: "wherdr:session" });
		expect(started.state).toBe("accepted");
		const runId = started.target_id!;
		const before = store.getRun(runId)!;
		expect(before.state).toBe("queued");
		const held = store.mutateLifecycle("alice", {
			version: 1,
			operation: "hold",
			target_id: runId,
			request_key: "hold-1",
			if_revision: before.revision,
			payload: { reason: "Operator pause" },
		});
		expect(held.error).toBeNull();
		store.close();

		const observation = new GraphObservation(root, GRAPH_CLI_LIMITS);
		try {
			const page = observation.notifications();
			expect(page.notifications).toHaveLength(1);
			const [note] = page.notifications;
			expect(note.format).toBe(GRAPH_NOTIFICATION_FORMAT);
			expect(note.kind).toBe("run.held");
			expect(note.state).toBe("held");
			expect(note.reason).toBe("Operator pause");
			expect(note.title).toBe("review task");
			expect(note.report_to).toBe("wherdr:session");
			expect(note.graph_name).toBe("notifications");
			expect(note.run_id).toBe(runId);
			expect(note.sequence).toBeGreaterThan(0);
			expect(note.last_event).toBe("run.hold");
			expect(page.cursor).toBeGreaterThan(0);
		} finally {
			observation.close();
		}
	});

	it("appends a distinct record per transition and resumes reading from the cursor", () => {
		const root = setup();
		const { store, started } = startRun(root);
		const runId = started.target_id!;
		const first = store.mutateLifecycle("alice", {
			version: 1,
			operation: "hold",
			target_id: runId,
			request_key: "hold-1",
			if_revision: "1",
			payload: { reason: "Pause one" },
		});
		expect(first.error).toBeNull();
		const resumed = store.mutateLifecycle("alice", {
			version: 1,
			operation: "resume",
			target_id: runId,
			request_key: "resume-1",
			if_revision: "2",
			payload: { decision_ref: { id: "decision", digest: "sha256:test" } },
		});
		expect(resumed.error).toBeNull();
		const second = store.mutateLifecycle("alice", {
			version: 1,
			operation: "hold",
			target_id: runId,
			request_key: "hold-2",
			if_revision: "3",
			payload: { reason: "Pause two" },
		});
		expect(second.error).toBeNull();
		store.close();

		const observation = new GraphObservation(root, GRAPH_CLI_LIMITS);
		try {
			const all = observation.notifications();
			expect(all.notifications.map(note => note.reason)).toEqual(["Pause one", "Pause two"]);
			expect(all.notifications[0].sequence).toBeLessThan(all.notifications[1].sequence);
			const after = observation.notifications({ since: all.cursor });
			expect(after.notifications).toHaveLength(0);
			expect(after.cursor).toBe(all.cursor);
			const scoped = observation.notifications({ run_id: "other-run" });
			expect(scoped.notifications).toHaveLength(0);
		} finally {
			observation.close();
		}
	});

	it("serves the versioned page over the CLI only to authorized observers", async () => {
		const root = setup();
		const { store, started } = startRun(root, { title: "cli dispatch", report_to: "omh:inbox" });
		const runId = started.target_id!;
		store.mutateLifecycle("alice", {
			version: 1,
			operation: "hold",
			target_id: runId,
			request_key: "hold",
			if_revision: "1",
			payload: { reason: "Await human" },
		});
		store.close();

		let stdout = "";
		let stderr = "";
		const io = { out: (text: string) => void (stdout += text), err: (text: string) => void (stderr += text) };
		const denied = await runGraphCommand(["notifications", "--format", "json"], { root, ...io });
		expect(denied).toBe(3);
		expect(stderr).toBe("");
		const deniedFrame = JSON.parse(stdout) as { kind: string; error: { code: string; message: string } };
		expect(deniedFrame.kind).toBe("graph.error");
		expect(deniedFrame.error.code).toBe("permission_denied");
		expect(deniedFrame.error.message).toContain("authorization is not configured");

		// Filtering matches `runs`: unauthorized records are omitted, not turned into an error page.
		stdout = "";
		stderr = "";
		const hidden = await runGraphCommand(["notifications", "--format", "json"], {
			root,
			...io,
			authorizeRunObservation: () => false,
		});
		expect(hidden).toBe(0);
		expect((JSON.parse(stdout) as GraphNotificationPage).notifications).toHaveLength(0);

		stdout = "";
		stderr = "";
		const code = await runGraphCommand(["notifications", "--format", "json"], {
			root,
			...io,
			authorizeRunObservation: candidate => candidate === runId,
		});
		expect(code).toBe(0);
		const page = JSON.parse(stdout) as GraphNotificationPage;
		expect(page.format).toBe(GRAPH_NOTIFICATION_FORMAT);
		expect(page.notifications).toHaveLength(1);
		expect(page.notifications[0].title).toBe("cli dispatch");
		expect(page.notifications[0].report_to).toBe("omh:inbox");
	});

	it("exposes the dispatch labels on the Run index and rejects unbounded titles", () => {
		const root = setup();
		const { store, started } = startRun(root, { title: "indexed task", report_to: "wherdr:session" });
		const run = store.getRun(started.target_id!)!;
		expect(run.title).toBe("indexed task");
		expect(run.report_to).toBe("wherdr:session");
		expect(run.graph_name).toBe("notifications");

		const definition = store.definitions.get(run.graph_id)!;
		const rejected = store.start(
			{
				version: 1,
				request_key: "start-long",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref: { id: "auth", digest: "sha256:test" } },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref: { id: "auth", digest: "sha256:test" },
				inputs: {},
				members: {},
				executors: {},
				title: "x".repeat(201),
			},
		);
		expect(rejected.state).toBe("rejected");
		expect(rejected.error?.code).toBe("definition_invalid");
		store.close();
	});
});

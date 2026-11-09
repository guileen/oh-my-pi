import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import type { GraphDeliveryEnvelope } from "../src/graph/delivery";
import { GRAPH_INBOX_FORMAT, GraphLocalInbox } from "../src/graph/inbox";
import { GraphObservationError } from "../src/graph/observation";
import { GraphRunStore } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-inbox-"));
	roots.push(root);
	return root;
}

/** Start one Run and hold it, so the outbox has exactly one `run.held` record to deliver. */
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
				"---\nformat: omp.graph/v1\nname: inbox\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
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

function envelope(consumer: string, id: string): GraphDeliveryEnvelope {
	return {
		format: "omp.graph/delivery/v1",
		consumer,
		delivered_at: new Date().toISOString(),
		notification: {
			id,
			kind: "run.held",
			run_id: "run-1",
			title: `title ${id}`,
		} as GraphDeliveryEnvelope["notification"],
	};
}

describe("graph local inbox", () => {
	it("round-trips envelopes and reports the next line index", () => {
		const root = setup();
		const inbox = new GraphLocalInbox(root, "orchestrator");
		expect(inbox.read()).toMatchObject({ consumer: "orchestrator", cursor: 0, records: [] });

		inbox.append(envelope("orchestrator", "n1"));
		inbox.append(envelope("orchestrator", "n2"));

		const first = inbox.read({ limit: 1 });
		expect(first.format).toBe(GRAPH_INBOX_FORMAT);
		expect(first.records.map(r => r.notification.id)).toEqual(["n1"]);
		expect(first.cursor).toBe(1);

		const second = inbox.read({ since: first.cursor, limit: 1 });
		expect(second.records.map(r => r.notification.id)).toEqual(["n2"]);
		expect(second.cursor).toBe(2);

		// The cursor is a line index, not a delivery acknowledgement: reading again repeats it.
		expect(inbox.read({ since: 1 }).records.map(r => r.notification.id)).toEqual(["n2"]);
		expect(inbox.read({ since: 9 }).cursor).toBe(2);
	});

	it("creates the inbox directory and file with owner-only permissions", () => {
		const root = setup();
		new GraphLocalInbox(root, "orchestrator").append(envelope("orchestrator", "n1"));
		const directory = path.join(root, "inbox");
		const file = path.join(directory, "orchestrator.jsonl");
		expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);

		// An existing file with a stale mode is corrected on the next append.
		fs.chmodSync(file, 0o644);
		new GraphLocalInbox(root, "orchestrator").append(envelope("orchestrator", "n2"));
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it("appends duplicates rather than deduping, matching at-least-once delivery", () => {
		const root = setup();
		const inbox = new GraphLocalInbox(root, "orchestrator");
		inbox.append(envelope("orchestrator", "n1"));
		inbox.append(envelope("orchestrator", "n1"));
		expect(inbox.read().records.map(r => r.notification.id)).toEqual(["n1", "n1"]);
	});

	it("fails at the byte bound instead of dropping a record", () => {
		const root = setup();
		const inbox = new GraphLocalInbox(root, "orchestrator", { maxBytes: 200 });
		const first = envelope("orchestrator", "n1");
		inbox.append(first);
		const error = (() => {
			try {
				inbox.append(envelope("orchestrator", "n2"));
				return null;
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(GraphObservationError);
		expect((error as GraphObservationError).code).toBe("resource_limit");
		// Nothing was dropped or truncated: the first record is still readable.
		expect(inbox.read().records.map(r => r.notification.id)).toEqual(["n1"]);
	});

	it("rejects invalid consumer names and mismatched envelopes", () => {
		const root = setup();
		expect(() => new GraphLocalInbox(root, "Bad Name")).toThrow(GraphObservationError);
		expect(() => new GraphLocalInbox(root, "")).toThrow(GraphObservationError);
		expect(() => new GraphLocalInbox(root, "orchestrator").append(envelope("other", "n1"))).toThrow(
			GraphObservationError,
		);
	});

	it("delivers into the inbox over the CLI and leaves nothing for a second pass", async () => {
		const root = setup();
		startHeldRun(root, { title: "inbox task", report_to: "wherdr:session" });
		let stdout = "";
		const io = { out: (text: string) => void (stdout += text), err: () => {} };

		const code = await runGraphCommand(
			["deliver", "--consumer", "orchestrator", "--builtin", "inbox", "--format", "json"],
			{ root, ...io, authorizeRunObservation: () => true },
		);
		expect(code).toBe(0);
		const frame = JSON.parse(stdout) as { delivered: string[]; cursor: number; failure: unknown };
		expect(frame.delivered).toHaveLength(1);
		expect(frame.cursor).toBeGreaterThan(0);
		expect(frame.failure).toBeNull();

		stdout = "";
		const again = await runGraphCommand(
			["deliver", "--consumer", "orchestrator", "--builtin", "inbox", "--format", "json"],
			{ root, ...io, authorizeRunObservation: () => true },
		);
		expect(again).toBe(0);
		expect((JSON.parse(stdout) as { delivered: string[] }).delivered).toEqual([]);

		stdout = "";
		const read = await runGraphCommand(["inbox", "--consumer", "orchestrator", "--format", "json"], { root, ...io });
		expect(read).toBe(0);
		const page = JSON.parse(stdout) as {
			format: string;
			records: GraphDeliveryEnvelope[];
			cursor: number;
		};
		expect(page.format).toBe(GRAPH_INBOX_FORMAT);
		expect(page.records).toHaveLength(1);
		expect(page.records[0]!.notification.title).toBe("inbox task");
		expect(page.records[0]!.notification.report_to).toBe("wherdr:session");
		expect(page.records[0]!.consumer).toBe("orchestrator");
		expect(page.cursor).toBe(1);

		// Reading the inbox is not observation: it needs no Run authorization.
		stdout = "";
		expect(await runGraphCommand(["inbox", "--consumer", "orchestrator"], { root, ...io })).toBe(0);
		expect(stdout).toContain("records: 1");
	});

	it("requires exactly one of --command or --builtin", async () => {
		const root = setup();
		let stderr = "";
		const io = { out: () => {}, err: (text: string) => void (stderr += text) };
		const authorizeRunObservation = () => true;

		expect(await runGraphCommand(["deliver", "--consumer", "smoke"], { root, ...io, authorizeRunObservation })).toBe(
			2,
		);
		expect(stderr).toContain("exactly one of --command or --builtin");

		stderr = "";
		expect(
			await runGraphCommand(["deliver", "--consumer", "smoke", "--builtin", "inbox", "--command", "true"], {
				root,
				...io,
				authorizeRunObservation,
			}),
		).toBe(2);
		expect(stderr).toContain("exactly one of --command or --builtin");

		stderr = "";
		expect(
			await runGraphCommand(["deliver", "--consumer", "smoke", "--builtin", "slack"], {
				root,
				...io,
				authorizeRunObservation,
			}),
		).toBe(2);
		expect(stderr).toContain("Only --builtin inbox is supported");
	});
});

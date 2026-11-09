import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphArtifact } from "../src/graph/artifacts";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import type { GraphDefinition } from "../src/graph/contracts";
import type { GraphObservation, GraphObservedRun } from "../src/graph/observation";
import { buildGraphReport, GRAPH_REPORT_FORMAT, renderGraphReportText } from "../src/graph/report";
import { GraphRunStore, type GraphScheduleState } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const at = "2026-01-01T00:00:00.000Z";

function definition(
	deliverable: string[],
	outputs: Record<string, { node: string; output: string; media_type?: string }>,
): GraphDefinition {
	return {
		format: "omp.graph/v1",
		name: "deliver",
		members: {},
		nodes: {},
		extensions: {
			"x-contract": {
				summary: "A deliverable graph",
				outputs: Object.fromEntries(
					Object.entries(outputs).map(([name, value]) => [
						name,
						{ ...value, required: true, description: `${name} output` },
					]),
				),
				deliverable: { summary: "Ship it", experience: "Open the page", artifacts: deliverable },
			},
		},
	};
}

function observationDouble(input: {
	run?: Partial<GraphObservedRun>;
	frozen?: GraphDefinition | null;
	schedule?: GraphScheduleState | null;
	notifications?: { kind: string; state: string; occurred_at: string }[];
}): GraphObservation {
	const run = {
		id: "run-1",
		revision: "3",
		created_at: at,
		updated_at: at,
		graph_id: "graph-1",
		definition_revision: "1",
		definition_digest: "sha256:definition",
		snapshot_ref: { id: "snapshot", digest: "sha256:snapshot" },
		state: "succeeded" as const,
		reason: null,
		graph_name: "deliver",
		title: "Ship the guide",
		...input.run,
	};
	const schedule: GraphScheduleState = input.schedule ?? {
		run_state: "succeeded",
		cycles: {},
		counters: [],
		invocations: [],
	};
	const notifications = input.notifications ?? [];
	return {
		snapshot: () => ({ run, cursor: { journal_id: "journal", seq: "1" } }),
		getFrozenDefinition: () => input.frozen ?? null,
		getScheduleState: () => schedule,
		notifications: ({ limit = 5 }: { limit?: number } = {}) => ({
			notifications: notifications.slice(-limit),
			cursor: notifications.length,
		}),
	} as unknown as GraphObservation;
}

function invocation(node: string, outputs: Record<string, { id: string; digest: string }>, superseded = false) {
	return {
		id: `inv-${node}`,
		node,
		iteration: 0,
		scope_id: "root",
		state: "succeeded" as const,
		upstream: {},
		outputs,
		...(superseded ? { superseded: true } : {}),
	};
}

const TEXT_REF = { id: "artifact-spec", digest: "sha256:spec" };
const TEXT_ARTIFACT = {
	id: "artifact-spec",
	digest: "sha256:spec",
	media_type: "text/markdown",
	size_bytes: 21,
	created_at: at,
	availability: "available" as const,
	access_scope: [],
} as unknown as GraphArtifact;

function readText(bytes: string) {
	return async () => ({ artifact: TEXT_ARTIFACT, bytes: new TextEncoder().encode(bytes) });
}

describe("graph report", () => {
	it("separates committed, superseded and absent declared artifacts", async () => {
		const report = await buildGraphReport(
			observationDouble({
				frozen: definition(["spec", "review"], {
					spec: { node: "spec", output: "spec", media_type: "text/markdown" },
					review: { node: "review", output: "review", media_type: "text/markdown" },
				}),
				schedule: {
					run_state: "succeeded",
					cycles: {},
					counters: [],
					invocations: [
						invocation("spec", { spec: TEXT_REF }),
						invocation("review", { review: { id: "artifact-review", digest: "sha256:review" } }, true),
					],
				},
			}),
			"run-1",
			{ readArtifact: readText("## spec") },
		);
		expect(report.format).toBe(GRAPH_REPORT_FORMAT);
		expect(report.deliverable).toEqual({
			ready: false,
			artifacts: ["spec", "review"],
			missing: ["review"],
			summary: "Ship it",
			experience: "Open the page",
		});
		// The superseded artifact must not be presented as the hand-off.
		expect(report.artifacts.map(artifact => artifact.name)).toEqual(["spec"]);
		expect(report.next_actions).toContain("Deliverable incomplete: review.");
	});

	it("bounds the preview by characters and lines and marks truncation", async () => {
		const body = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
		const report = await buildGraphReport(
			observationDouble({
				frozen: definition(["spec"], { spec: { node: "spec", output: "spec", media_type: "text/markdown" } }),
				schedule: {
					run_state: "succeeded",
					cycles: {},
					counters: [],
					invocations: [invocation("spec", { spec: TEXT_REF })],
				},
			}),
			"run-1",
			{ readArtifact: readText(body), previewLines: 3 },
		);
		expect(report.artifacts[0]!.preview).toBe("line 0\nline 1\nline 2");
		expect(report.artifacts[0]!.truncated).toBe(true);
		expect(report.deliverable?.ready).toBe(true);
	});

	it("keeps a metadata-only row when the artifact content cannot be read", async () => {
		const report = await buildGraphReport(
			observationDouble({
				frozen: definition(["spec"], { spec: { node: "spec", output: "spec", media_type: "text/markdown" } }),
				schedule: {
					run_state: "succeeded",
					cycles: {},
					counters: [],
					invocations: [invocation("spec", { spec: TEXT_REF })],
				},
			}),
			"run-1",
			{
				readArtifact: async () => {
					throw Object.assign(new Error("gone"), { code: "missing" });
				},
			},
		);
		expect(report.artifacts[0]).toMatchObject({
			name: "spec",
			digest: "sha256:spec",
			preview: null,
			size_bytes: 0,
			unavailable: "missing",
		});
		expect(report.next_actions).toContain("Some artifact content is unavailable; the list shows metadata only.");
	});

	it("omits the preview for a non-text artifact without treating it as unreadable", async () => {
		const poster = { ...TEXT_ARTIFACT, media_type: "image/png" } as GraphArtifact;
		const report = await buildGraphReport(
			observationDouble({
				frozen: definition(["poster"], { poster: { node: "poster", output: "poster", media_type: "image/png" } }),
				schedule: {
					run_state: "succeeded",
					cycles: {},
					counters: [],
					invocations: [invocation("poster", { poster: { id: "poster", digest: "sha256:poster" } })],
				},
			}),
			"run-1",
			{ readArtifact: async () => ({ artifact: poster, bytes: new Uint8Array([0x89, 0x50]) }) },
		);
		expect(report.artifacts[0]).toMatchObject({
			preview: null,
			unavailable: "not a text artifact",
			media_type: "image/png",
		});
	});

	it("reports held and non-terminal Runs with the action a dispatcher should take", async () => {
		const report = await buildGraphReport(
			observationDouble({
				run: { state: "held", hold_kind: "gate" },
				frozen: definition(["spec"], { spec: { node: "spec", output: "spec" } }),
			}),
			"run-1",
			{ readArtifact: readText("") },
		);
		expect(report.next_actions).toEqual([
			"Run is not terminal; `wait` rather than polling status.",
			"Held (gate); resuming needs its matching authorization.",
			"Deliverable incomplete: spec.",
		]);
	});

	it("includes only the newest notifications, oldest-first", async () => {
		const report = await buildGraphReport(
			observationDouble({
				notifications: [
					{ kind: "run.held", state: "held", occurred_at: at },
					{ kind: "run.stalled", state: "running", occurred_at: at },
					{ kind: "run.succeeded", state: "succeeded", occurred_at: at },
				],
			}),
			"run-1",
			{ readArtifact: readText(""), notificationLimit: 2 },
		);
		expect(report.notifications.map(notification => notification.kind)).toEqual(["run.stalled", "run.succeeded"]);
	});

	it("renders a short human report with the deliverable and the preview", async () => {
		const report = await buildGraphReport(
			observationDouble({
				frozen: definition(["spec"], { spec: { node: "spec", output: "spec", media_type: "text/markdown" } }),
				schedule: {
					run_state: "succeeded",
					cycles: {},
					counters: [],
					invocations: [invocation("spec", { spec: TEXT_REF })],
				},
			}),
			"run-1",
			{ readArtifact: readText("## Scope\nShip it.") },
		);
		const text = renderGraphReportText(report);
		expect(text).toContain("Ship the guide — succeeded");
		expect(text).toContain("Deliverable: ready");
		expect(text).toContain("    ## Scope");
	});

	it("declares no deliverable when the frozen definition is unavailable", async () => {
		const report = await buildGraphReport(observationDouble({ frozen: null }), "run-1", {
			readArtifact: readText(""),
		});
		expect(report.deliverable).toBeNull();
		expect(report.artifacts).toEqual([]);
		expect(renderGraphReportText(report)).toContain("Deliverable: not declared");
	});
});

describe("graph report command", () => {
	function setup() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-report-"));
		roots.push(root);
		return root;
	}

	function startRun(root: string): string {
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		try {
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
			const frozen = store.definitions.get(imported.target_id!)!;
			const authorization_ref = { id: "auth", digest: "sha256:test" };
			const started = store.start(
				{
					version: 1,
					request_key: "start",
					operation: "start",
					target_id: frozen.graph_id,
					if_revision: frozen.revision,
					payload: { inputs: {}, authorization_ref },
				},
				{
					graph_id: frozen.graph_id,
					definition_revision: frozen.revision,
					definition_digest: frozen.digest,
					authorization_ref,
					inputs: {},
					members: {},
					executors: {},
				},
			);
			return started.target_id!;
		} finally {
			store.close();
		}
	}

	it("requires both observation and artifact-read authorization", async () => {
		const root = setup();
		const runId = startRun(root);
		let stderr = "";
		const invoke = (options: Parameters<typeof runGraphCommand>[1]) =>
			runGraphCommand(["report", runId], {
				root,
				out: () => {},
				err: text => {
					stderr += text;
				},
				...options,
			});
		expect(await invoke({})).toBe(3);
		expect(await invoke({ authorizeRunObservation: () => true })).toBe(3);
		expect(stderr).toContain("permission_denied");
		expect(await invoke({ authorizeRunObservation: () => false, readArtifact: readText("") })).toBe(3);
	});

	it("reports a real committed Run as JSON without inventing a deliverable", async () => {
		const root = setup();
		const runId = startRun(root);
		let stdout = "";
		const code = await runGraphCommand(["report", runId, "--format", "json"], {
			root,
			authorizeRunObservation: () => true,
			readArtifact: readText(""),
			out: text => {
				stdout += text;
			},
			err: () => {},
		});
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.format).toBe(GRAPH_REPORT_FORMAT);
		expect(report.run_id).toBe(runId);
		expect(report.deliverable).toBeNull();
		expect(report.state).toBe("queued");
	});

	it("rejects an unknown Run and an out-of-range preview bound", async () => {
		const root = setup();
		startRun(root);
		let stderr = "";
		const invoke = (args: string[]) =>
			runGraphCommand(args, {
				root,
				authorizeRunObservation: () => true,
				readArtifact: readText(""),
				out: () => {},
				err: text => {
					stderr += text;
				},
			});
		expect(await invoke(["report", "missing-run"])).toBe(2);
		expect(stderr).toContain("unknown_run");
		expect(await invoke(["report", "any", "--preview-chars", "9000"])).toBe(2);
		expect(stderr).toContain("preview-chars");
	});
});

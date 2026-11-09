import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import { GRAPH_RUN_NODE_PROGRESS_LIMIT, projectNodeProgress, summarizeNodeProgress } from "../src/graph/observation";
import { GraphRunStore } from "../src/graph/store";
import { GraphReadTool } from "../src/tools/graph";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Invocation = Parameters<typeof projectNodeProgress>[0]["invocations"][number];

function invocation(
	node: string,
	state: Invocation["state"],
	options: { iteration?: number; id?: string; superseded?: boolean; consultation?: boolean } = {},
): Invocation {
	return {
		id: options.id ?? `${node}-${options.iteration ?? 0}`,
		node,
		iteration: options.iteration ?? 0,
		scope_id: "run",
		state,
		upstream: {},
		attempt_id: `${node}-attempt`,
		...(options.superseded ? { superseded: true } : {}),
		...(options.consultation
			? { consultation: { conversation_id: `c-${node}`, message_id: `m-${node}`, member_id: node } }
			: {}),
	};
}

describe("node progress projection", () => {
	it("keeps definition order, reports unstarted nodes as pending, and names one current node", () => {
		const { nodes, omitted } = projectNodeProgress({
			invocations: [
				invocation("plan", "succeeded", { iteration: 1 }),
				invocation("review", "running", { iteration: 1 }),
			],
			order: ["plan", "review", "deliver"],
			runState: "running",
		});
		expect(omitted).toBe(0);
		expect(nodes.map(node => [node.node, node.state])).toEqual([
			["plan", "succeeded"],
			["review", "running"],
			["deliver", "pending"],
		]);
		expect(nodes.filter(node => node.current).map(node => node.node)).toEqual(["review"]);
		expect(summarizeNodeProgress(nodes)).toBe("nodes:1/3  current:review");
	});

	it("prefers an executing node over a waiting one when both are live", () => {
		const { nodes } = projectNodeProgress({
			invocations: [
				invocation("plan", "waiting", { iteration: 1 }),
				invocation("review", "running", { iteration: 1 }),
			],
			order: ["plan", "review"],
			runState: "running",
		});
		expect(nodes.find(node => node.current)?.node).toBe("review");
	});

	it("marks nothing current once the Run is terminal", () => {
		const { nodes } = projectNodeProgress({
			invocations: [invocation("plan", "succeeded", { iteration: 1 })],
			order: ["plan"],
			runState: "failed",
		});
		expect(nodes.some(node => node.current)).toBe(false);
		expect(summarizeNodeProgress(nodes)).toBe("nodes:1/1");
	});

	it("never lets a consultation answer flip a settled declared node back to running", () => {
		const { nodes } = projectNodeProgress({
			invocations: [
				invocation("plan", "succeeded", { iteration: 1 }),
				// The advisor answers after the asking node settled; it must not resurface `plan`.
				invocation("plan", "running", { iteration: 0, id: "consult-plan", consultation: true }),
			],
			order: ["plan"],
			runState: "running",
		});
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ node: "plan", state: "succeeded" });
		expect(nodes[0]!.current).toBeUndefined();
	});

	it("keeps consultation work for a member without a declared node as a separate entry", () => {
		const { nodes } = projectNodeProgress({
			invocations: [
				invocation("plan", "waiting", { iteration: 1 }),
				invocation("consultation:advisor", "running", { consultation: true }),
			],
			order: ["plan"],
			runState: "running",
		});
		expect(nodes.map(node => node.node)).toEqual(["plan", "consultation:advisor"]);
		expect(nodes.find(node => node.current)?.node).toBe("consultation:advisor");
	});

	it("replaces a superseded invocation with its newer generation", () => {
		const { nodes } = projectNodeProgress({
			invocations: [
				invocation("plan", "failed", { iteration: 1, id: "plan-old", superseded: true }),
				invocation("plan", "running", { iteration: 2, id: "plan-new" }),
			],
			order: ["plan"],
			runState: "running",
		});
		expect(nodes[0]).toMatchObject({ node: "plan", state: "running" });
		expect(nodes[0]!.superseded).toBeUndefined();
	});

	it("bounds the projection and reports how many nodes it omitted", () => {
		const order = Array.from({ length: GRAPH_RUN_NODE_PROGRESS_LIMIT + 3 }, (_, index) => `n${index}`);
		const { nodes, omitted } = projectNodeProgress({ invocations: [], order, runState: "queued" });
		expect(nodes).toHaveLength(GRAPH_RUN_NODE_PROGRESS_LIMIT);
		expect(omitted).toBe(3);
	});

	it("carries recorded activity into the node entry", () => {
		const { nodes } = projectNodeProgress({
			invocations: [invocation("plan", "running", { iteration: 1, id: "inv-plan" })],
			activity: [
				{
					run_id: "run",
					invocation_id: "inv-plan",
					node: "plan",
					started_at: "2026-11-01T00:00:00.000Z",
					last_activity_at: "2026-11-01T00:00:05.000Z",
					turns: 3,
					summary: "tool:graph_publish",
				},
			],
			order: ["plan"],
			runState: "running",
		});
		expect(nodes[0]).toMatchObject({
			node: "plan",
			state: "running",
			started_at: "2026-11-01T00:00:00.000Z",
			last_activity_at: "2026-11-01T00:00:05.000Z",
			turns: 3,
			summary: "tool:graph_publish",
			current: true,
		});
	});
});

describe("node progress in CLI and headless read", () => {
	function startAttachedRun() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-node-progress-"));
		roots.push(root);
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: progress\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
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
				title: "progress probe",
			},
		);
		store.close();
		return { root, runId: started.target_id! };
	}

	it("prints the node summary and node lines for runs and status", async () => {
		const { root, runId } = startAttachedRun();
		let stdout = "";
		const io = {
			out: (text: string) => void (stdout += text),
			err: () => {},
			authorizeRunObservation: () => true,
		};
		expect(await runGraphCommand(["runs"], { root, ...io })).toBe(0);
		expect(stdout).toContain("nodes:0/1");

		stdout = "";
		expect(await runGraphCommand(["status", runId], { root, ...io })).toBe(0);
		expect(stdout).toContain("Progress: nodes:0/1\n");
		expect(stdout).toContain("Node: approval  pending");
	});

	it("reports the node summary in the graph_read runs text", async () => {
		const { root, runId } = startAttachedRun();
		const tool = new GraphReadTool({ root, authorizeRun: id => id === runId });
		const result = await tool.execute("runs", { version: 1, operation: "runs" });
		expect(result.details.error).toBeNull();
		expect(result.details.content).toContain("nodes:0/1");
		const [entry] = result.details.records as { nodes?: { node: string; state: string }[] }[];
		expect(entry?.nodes).toEqual([{ node: "approval", state: "pending" }]);
	});

	it("lists the newest Run first, so a dispatcher sees the Run it just started", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-node-progress-"));
		roots.push(root);
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: progress\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "private-authorization", digest: "sha256:test" };
		const startRun = (requestKey: string, title: string): string => {
			const started = store.start(
				{
					version: 1,
					request_key: requestKey,
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
					title,
				},
			);
			if (!started.target_id) throw new Error("Run start failed");
			return started.target_id;
		};
		const first = startRun("start-1", "first");
		const second = startRun("start-2", "second");
		store.close();

		let stdout = "";
		const io = {
			out: (text: string) => void (stdout += text),
			err: () => {},
			authorizeRunObservation: () => true,
		};
		expect(await runGraphCommand(["runs"], { root, ...io })).toBe(0);
		expect(stdout.indexOf(second)).toBeLessThan(stdout.indexOf(first));

		const tool = new GraphReadTool({ root, authorizeRun: () => true });
		const result = await tool.execute("runs", { version: 1, operation: "runs" });
		const records = result.details.records as { run_id: string }[];
		expect(records.map(record => record.run_id)).toEqual([second, first]);
	});
});

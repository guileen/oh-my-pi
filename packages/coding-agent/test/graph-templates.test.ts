import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { validateGraphForStart } from "../src/graph/definition";
import type { GraphDefinition } from "../src/graph/contracts";
import { localRunSupport } from "../src/graph/local-run";
import { planGraphSchedule, type SchedulerInvocation, type SchedulerState } from "../src/graph/scheduler";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 3000 };

function loadTemplate(name: string): GraphDefinition {
	const content = readFileSync(new URL(`../examples/graph/${name}/GRAPH.md`, import.meta.url), "utf8");
	return validateGraphForStart(content, limits).source.frontmatter.frontmatter as unknown as GraphDefinition;
}

function completed(node: string, outcome: string, outputs: SchedulerInvocation["outputs"]): SchedulerInvocation {
	return {
		id: node,
		node,
		state: "succeeded",
		iteration: 1,
		scope_id: "scope",
		upstream: {},
		outcome,
		outputs,
		attempt_id: `${node}-attempt`,
		completion_order: "1",
		routed: false,
	};
}

function schedule(
	definition: GraphDefinition,
	invocation: SchedulerInvocation,
	counters: SchedulerState["counters"] = [],
) {
	return planGraphSchedule(definition, { run_state: "running", invocations: [invocation], cycles: {}, counters });
}

describe("Graph workflow example definitions", () => {
	for (const [name, node] of [
		["requirement-development", "research"],
		["screenwriting", "prepare"],
		["requirement-spec-draft", "frame"],
		["local-code-slice", "implement"],
		["daily-code", "implement"],
	] as const) {
		it(`starts ${name} from the CLI task input instead of holding for an unavailable brief`, () => {
			const graph = loadTemplate(name);
			const state: SchedulerState = {
				run_state: "running",
				invocations: [{ id: "entry", node, state: "pending", iteration: 1, scope_id: "run", upstream: {} }],
				cycles: {},
				counters: [],
				run_inputs: { task: { id: "cli-input", digest: "sha256:brief" } },
			};
			expect(planGraphSchedule(graph, state).action).toMatchObject({
				type: "ready",
				invocation_id: "entry",
			});
			delete state.run_inputs!.task;
			expect(planGraphSchedule(graph, state).action).toMatchObject({
				type: "hold",
				error: { code: "gate_unsatisfied" },
			});
		});
	}

	it("keeps requirement-spec-draft inside the serial local runner contract", () => {
		expect(localRunSupport(loadTemplate("requirement-spec-draft"))).toEqual({ supported: true, reason: null });
	});

	it("admits local-code-slice only because its grants are workspace-relative and named", () => {
		const graph = loadTemplate("local-code-slice");
		expect(localRunSupport(graph)).toEqual({ supported: true, reason: null });
		// The coding member is the one that can touch the workspace; the reporting member cannot.
		expect(graph.members.coder.permissions).toEqual({
			read: ["**"],
			write: ["src/**", "test/**"],
			execute: ["test"],
		});
		expect(graph.members.reporter.permissions).toEqual({ read: [], write: [], execute: [] });
		// A path outside the declared write grants must not be admitted by the same declaration.
		const escaped = structuredClone(graph);
		escaped.members.coder.permissions.write = ["../outside"];
		expect(localRunSupport(escaped)).toMatchObject({ supported: false });
		// An unknown execute grant must not silently become a shell.
		const shell = structuredClone(graph);
		shell.members.coder.permissions.execute = ["rm"];
		expect(localRunSupport(shell)).toMatchObject({ supported: false });
	});

	it("routes daily coding acceptance through bounded rework and never gives coders execute grants", () => {
		const graph = loadTemplate("daily-code");
		expect(graph.members.terra.permissions.execute).toEqual([]);
		expect(graph.members.sol.permissions.execute).toEqual([]);
		expect(graph.nodes.acceptance).toMatchObject({
			kind: "program",
			executor: "daily-code-acceptance",
			outcomes: ["pass", "revise"],
		});
		expect(graph.loops?.rework).toMatchObject({
			max_reviews: 3,
			final_node: "exhausted",
			retry_target: "implement",
			count_nodes: ["acceptance"],
		});
		expect(graph.nodes.exhausted.terminal).toEqual({ stop: "hold", hold: "hold" });
		expect(graph.edges?.filter(edge => edge.from === "exhausted")).toEqual([]);
		const acceptance = completed("acceptance", "revise", {
			evidence: { id: "failed-check", digest: "sha256:failed" },
		});
		expect(schedule(graph, acceptance).action).toMatchObject({
			type: "rewind",
			edge: "acceptance-rework",
			target: "implement",
		});
	});

	it("rejects a daily coding Graph that bypasses acceptance or grants a coder command execution", () => {
		const bypass = loadTemplate("daily-code");
		bypass.edges = bypass.edges?.filter(edge => edge.id !== "review-acceptance");
		expect(localRunSupport(bypass)).toMatchObject({ supported: false });

		const shell = loadTemplate("daily-code");
		shell.members.terra.permissions.execute = ["test"];
		expect(localRunSupport(shell)).toMatchObject({ supported: false });
	});

	it("takes the author task from the Run input instead of a hardcoded brief", () => {
		const graph = loadTemplate("local-text-handoff");
		expect(graph.nodes.plan.inputs).toEqual({ task: { run_input: "task" } });
		expect(localRunSupport(graph)).toEqual({ supported: true, reason: null });
	});

	it("rechecks only completed screenwriting revisions; blocked revisions hold", () => {
		const graph = loadTemplate("screenwriting");
		for (const stage of ["concept", "structure", "script"]) {
			const revision = completed(`${stage}-revise`, "done", {
				revision: { id: "revision-artifact", digest: "digest" },
			});
			expect(schedule(graph, revision).action).toMatchObject({
				type: "rewind",
				edge: `${stage}-recheck`,
				target: `${stage}-review`,
			});
			revision.outcome = "hold";
			expect(schedule(graph, revision).action).toMatchObject({ type: "hold" });
		}
	});

	it("holds protected screenwriting changes without manufacturing an author approval", () => {
		const graph = loadTemplate("screenwriting");
		for (const stage of ["concept", "structure", "script"]) {
			const author = graph.nodes[`${stage}-author`];
			expect(author.kind).toBe("human");
			expect(author.required_inputs).toEqual(["assessment"]);
			expect(author.approved_outputs).toBeUndefined();
			expect(author.outcomes).toEqual(["hold"]);
			expect(graph.edges!.filter(edge => edge.from === `${stage}-author`)).toEqual([]);
			expect(graph.edges!.find(edge => edge.id === `${stage}-to-author`)).toMatchObject({
				from: `${stage}-review`,
				to: `${stage}-author`,
				on: ["author"],
				bind: { assessment: "assessment" },
			});
			expect(schedule(graph, completed(`${stage}-author`, "hold", {})).action).toMatchObject({ type: "hold" });
		}
	});

	it("freezes the development budget branch before routing a corrected specification", () => {
		const graph = loadTemplate("requirement-development");
		const spec = completed("spec", "done", { spec: { id: "corrected-spec", digest: "digest" } });
		expect(schedule(graph, spec).action).toMatchObject({
			type: "routed",
			suppressed_edges: ["spec-exhausted"],
		});
		expect(
			schedule(graph, spec, [{ key: "budget:implementation-attempts:run:run", consumed: 2, reservations: [] }])
				.action,
		).toMatchObject({ type: "routed", suppressed_edges: ["spec-review"] });
	});
});

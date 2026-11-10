import { describe, expect, it } from "bun:test";
import type { GraphDefinition } from "../src/graph/contracts";
import { renderGraphMermaid } from "../src/graph/mermaid";

const member = {
	role: "#role" as const,
	model: "model",
	base: "isolated" as const,
	duty: "general" as const,
	permissions: { read: [], write: [], execute: [] },
};

describe("Graph diagram projection", () => {
	it("distinguishes automatic handoff from directed consultation", () => {
		const definition: GraphDefinition = {
			format: "omp.graph/v1",
			name: "review",
			members: { researcher: member, reviewer: member },
			nodes: {
				research: { kind: "bot", task: "#research", member: "researcher" },
				review: { kind: "bot", task: "#review", member: "reviewer" },
			},
			edges: [{ id: "handoff", from: "research", to: "review", on: ["ready"] }],
			communications: [{ from: "reviewer", to: "researcher", when: "#questions" }],
		};
		const diagram = renderGraphMermaid(definition);
		expect(diagram).toContain('n0 -->|"handoff / ready"| n1');
		expect(diagram).toContain('m1 -. "consult #35;questions" .-> m0');
		expect(diagram).not.toContain('m0 -. "consult');
	});
	it("prevents definition labels from adding graph statements", () => {
		const definition: GraphDefinition = {
			format: "omp.graph/v1",
			name: "untrusted",
			members: {},
			nodes: { 'task"]\nattacker-->victim': { kind: "human", task: "#task" } },
		};
		const diagram = renderGraphMermaid(definition);
		expect(diagram).not.toContain("\nattacker-->victim");
		expect(diagram).toContain("#34;");
	});
});

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildGraphCatalog } from "../src/graph/catalog";
import type { GraphSnapshot } from "../src/graph/authoring";
import { GRAPH_CLI_LIMITS } from "../src/graph/cli";

const EXAMPLES = path.join(import.meta.dir, "..", "examples", "graph");

function snapshot(name: string, graphId = name): GraphSnapshot {
	return {
		graph_id: graphId,
		revision: "rev-1",
		digest: `digest-${name}`,
		content: fs.readFileSync(path.join(EXAMPLES, name, "GRAPH.md"), "utf8"),
	};
}

describe("graph catalog", () => {
	it("reports the declared x-contract and refuses local execution for a graph that needs a richer host", () => {
		const [entry] = buildGraphCatalog([snapshot("requirement-development")], GRAPH_CLI_LIMITS);
		expect(entry.contract_source).toBe("declared");
		expect(entry.name).toBe("requirement-development");
		expect(entry.inputs.map(input => input.name)).toEqual(["task"]);
		expect(entry.inputs[0].media_type).toBe("text/markdown");
		expect(entry.outputs.map(output => output.name)).toEqual(["snapshot", "acceptance"]);
		expect(entry.outputs.find(output => output.name === "acceptance")).toMatchObject({
			node: "accept",
			output: "acceptance",
		});
		expect(entry.report_events).toEqual(["succeeded", "failed", "held", "stalled"]);
		expect(entry.stall_threshold_ms).toBe(300000);
		expect(entry.local_run.supported).toBe(false);
		expect(entry.local_run.reason).toBeTruthy();
	});

	it("surfaces the declared human deliverable so a dispatcher need not read node internals", () => {
		const [entry] = buildGraphCatalog([snapshot("requirement-development")], GRAPH_CLI_LIMITS);
		expect(entry.deliverable).toMatchObject({ artifacts: ["snapshot", "acceptance"] });
		expect(entry.deliverable?.summary).toBeTruthy();
		expect(entry.deliverable?.experience).toBeTruthy();
	});

	it("drops deliverable artifacts that no declared output can produce", () => {
		const content = fs
			.readFileSync(path.join(EXAMPLES, "requirement-spec-draft", "GRAPH.md"), "utf8")
			.replace("artifacts: [spec, review]", "artifacts: [spec, ghost]");
		const [entry] = buildGraphCatalog([{ graph_id: "x", revision: "r", digest: "d", content }], GRAPH_CLI_LIMITS);
		expect(entry.deliverable?.artifacts).toEqual(["spec"]);
	});

	it("derives a contract from node wiring when the author declared none", () => {
		const [entry] = buildGraphCatalog([snapshot("screenwriting")], GRAPH_CLI_LIMITS);
		expect(entry.contract_source).toBe("derived");
		expect(entry.inputs.map(input => input.name)).toEqual(["task"]);
		expect(entry.outputs.map(output => output.name)).toEqual(["delivery"]);
		expect(entry.outputs[0]).toMatchObject({ node: "deliver", output: "delivery" });
		expect(entry.local_run.supported).toBe(false);
		expect(entry.report_events).toEqual([]);
		expect(entry.deliverable).toBeUndefined();
	});

	it("surfaces the author-declared bindings file so a dispatcher need not guess", () => {
		const [entry] = buildGraphCatalog([snapshot("local-text-handoff")], GRAPH_CLI_LIMITS);
		expect(entry.bindings).toBe("packages/coding-agent/examples/graph/local-text-handoff/models.md");
		expect(entry.inputs.map(input => input.name)).toEqual(["task"]);
		expect(entry.inputs[0]?.required).toBe(true);
	});

	it("omits bindings when the author declared none", () => {
		const [entry] = buildGraphCatalog([snapshot("screenwriting")], GRAPH_CLI_LIMITS);
		expect(entry.bindings).toBeUndefined();
	});

	it("keeps an unparsable definition listed with a reason instead of dropping it", () => {
		const [entry] = buildGraphCatalog(
			[
				{
					graph_id: "broken",
					revision: "rev-1",
					digest: "d",
					content: "---\nformat: omp.graph/v1\nformat: x\n---\n",
				},
			],
			GRAPH_CLI_LIMITS,
		);
		expect(entry.graph_id).toBe("broken");
		expect(entry.name).toBe("broken");
		expect(entry.contract_source).toBe("derived");
		expect(entry.local_run.supported).toBe(false);
		expect(entry.local_run.reason).toBeTruthy();
	});

	it("collapses identical imports to one row and records how many it absorbed", () => {
		const source = snapshot("local-text-handoff", "alpha");
		const entries = buildGraphCatalog(
			[source, { ...source, graph_id: "beta" }, { ...source, graph_id: "gamma" }],
			GRAPH_CLI_LIMITS,
		);
		expect(entries.map(entry => entry.graph_id)).toEqual(["alpha"]);
		expect(entries[0].duplicates).toBe(2);
	});

	it("keeps same-named definitions with different content as separate entries", () => {
		const first = snapshot("local-text-handoff", "alpha");
		const second = { ...first, graph_id: "beta", digest: "different-digest" };
		const entries = buildGraphCatalog([first, second], GRAPH_CLI_LIMITS);
		expect(entries.map(entry => entry.graph_id)).toEqual(["alpha", "beta"]);
		expect(entries.some(entry => entry.duplicates !== undefined)).toBe(false);
	});

	it("does not collapse unparsable definitions that fall back to their own id", () => {
		const broken = {
			graph_id: "broken-a",
			revision: "rev-1",
			digest: "same-digest",
			content: "---\nformat: omp.graph/v1\nformat: x\n---\n",
		};
		const entries = buildGraphCatalog([broken, { ...broken, graph_id: "broken-b" }], GRAPH_CLI_LIMITS);
		expect(entries.map(entry => entry.graph_id)).toEqual(["broken-a", "broken-b"]);
	});
});

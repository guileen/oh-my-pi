import { describe, expect, it } from "bun:test";
import type { GraphCatalogContract } from "../src/graph/catalog";
import { resolveDeliverableReadiness } from "../src/graph/observation";
import type { GraphScheduleState } from "../src/graph/store";

function contract(artifacts: string[]): Pick<GraphCatalogContract, "outputs" | "deliverable"> {
	return {
		outputs: [
			{ name: "spec", description: null, media_type: null, required: true, node: "spec", output: "spec" },
			{ name: "review", description: null, media_type: null, required: true, node: "review", output: "review" },
			{ name: "unmapped", description: null, media_type: null, required: true, node: null, output: null },
		],
		deliverable: { summary: null, experience: null, artifacts },
	};
}

function schedule(
	invocations: {
		node: string;
		outputs?: Record<string, { id: string; digest: string }>;
		superseded?: boolean;
	}[],
): GraphScheduleState {
	return {
		run_state: "succeeded",
		cycles: {},
		counters: [],
		invocations: invocations.map((entry, index) => ({
			id: `inv-${index}`,
			node: entry.node,
			iteration: 0,
			scope_id: "root",
			state: "succeeded",
			upstream: {},
			...(entry.outputs ? { outputs: entry.outputs } : {}),
			...(entry.superseded ? { superseded: true } : {}),
		})),
	};
}

describe("deliverable readiness", () => {
	it("reports ready when every declared artifact has a committed output", () => {
		const readiness = resolveDeliverableReadiness(
			contract(["spec", "review"]),
			schedule([
				{ node: "spec", outputs: { spec: { id: "a", digest: "sha256:1" } } },
				{ node: "review", outputs: { review: { id: "b", digest: "sha256:2" } } },
			]),
		);
		expect(readiness).toEqual({ ready: true, artifacts: ["spec", "review"], missing: [] });
	});

	it("keeps a successful Run not-ready while a declared artifact is absent", () => {
		const readiness = resolveDeliverableReadiness(
			contract(["spec", "review"]),
			schedule([{ node: "spec", outputs: { spec: { id: "a", digest: "sha256:1" } } }]),
		);
		expect(readiness).toEqual({ ready: false, artifacts: ["spec", "review"], missing: ["review"] });
	});

	it("ignores outputs from superseded invocations", () => {
		const readiness = resolveDeliverableReadiness(
			contract(["spec"]),
			schedule([{ node: "spec", outputs: { spec: { id: "a", digest: "sha256:1" } }, superseded: true }]),
		);
		expect(readiness?.ready).toBe(false);
		expect(readiness?.missing).toEqual(["spec"]);
	});

	it("treats an artifact whose declared output has no node mapping as missing", () => {
		const readiness = resolveDeliverableReadiness(
			contract(["unmapped"]),
			schedule([{ node: "unmapped", outputs: { unmapped: { id: "a", digest: "sha256:1" } } }]),
		);
		expect(readiness?.ready).toBe(false);
		expect(readiness?.missing).toEqual(["unmapped"]);
	});

	it("omits readiness when the definition declared no deliverable", () => {
		expect(resolveDeliverableReadiness(contract([]), schedule([]))).toBeUndefined();
		const noDeliverable = { ...contract([]), deliverable: null };
		expect(resolveDeliverableReadiness(noDeliverable, schedule([]))).toBeUndefined();
	});
});

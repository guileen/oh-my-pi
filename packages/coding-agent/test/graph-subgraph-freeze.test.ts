import { describe, expect, it } from "bun:test";
import {
	acceptanceApplies,
	freezeIntegration,
	integrationVersion,
	runFrozenAcceptance,
	type AcceptanceHost,
	type IntegrationSnapshot,
} from "../src/graph/subgraph-freeze";

const entry = (path: string, value: string) => ({
	path,
	kind: "file" as const,
	mode: 0o644,
	content: new TextEncoder().encode(value),
});
const snapshot = (): IntegrationSnapshot => ({
	source: [entry("src/a.ts", "code"), entry("test/a.test.ts", "test")],
	specification: [entry("spec.md", "spec")],
	upstream: [entry("guide.md", "guide")],
});
const request = { tester: "tester", command: "bun test", scenario: "acceptance", environment: "isolated" };
const handoff = {
	integrator: "coder",
	sourceRevision: "revision",
	changeRiskMap: { id: "map", digest: `sha256:${"a".repeat(64)}` },
};

function host(capture: () => IntegrationSnapshot): AcceptanceHost {
	return {
		authorize: async () => true,
		sourceIsolation: true,
		isolationDescription: "Host-enforced read-only protected tree",
		capture: async () => capture(),
		run: async () => ({ success: true, observed: "scenario passed" }),
	};
}

describe("frozen integration acceptance", () => {
	it("binds all protected content and allows order-independent capture", () => {
		const first = snapshot();
		const second = snapshot();
		second.source = [...second.source].reverse();
		expect(integrationVersion(first)).toEqual(integrationVersion(second));
		second.source = [entry("src/a.ts", "changed"), entry("test/a.test.ts", "test")];
		expect(integrationVersion(first).source).not.toBe(integrationVersion(second).source);
		expect(() => integrationVersion({ ...first, source: [first.source[0], first.source[0]] })).toThrow();
		expect(() => integrationVersion({ ...first, specification: [] })).toThrow();
	});

	it("requires authorization and an honest isolation guarantee or explicit limitation approval", async () => {
		const current = snapshot();
		const frozen = freezeIntegration(current, handoff);
		const executor = host(() => current);
		let ran = false;
		executor.run = async () => {
			ran = true;
			return { success: true, observed: "passed" };
		};
		executor.sourceIsolation = false;
		executor.isolationDescription = "Unrestricted commands; snapshot comparison only";
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("hold");
		expect(ran).toBe(false);
		executor.authorizeIsolationLimitation = async () => true;
		executor.authorize = async () => false;
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("hold");
		expect(ran).toBe(false);
		executor.authorize = async () => true;
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("passed");
	});

	it("does not run acceptance or report a pass for non-boolean authority and results", async () => {
		const current = snapshot();
		const frozen = freezeIntegration(current, handoff);
		const executor = host(() => current);
		const truthy = "yes" as unknown as boolean;
		let ran = false;
		executor.run = async () => {
			ran = true;
			return { success: truthy, observed: "reported" };
		};
		executor.authorize = async () => truthy;
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("hold");
		expect(ran).toBe(false);
		executor.authorize = async () => true;
		executor.sourceIsolation = truthy;
		executor.authorizeIsolationLimitation = async () => truthy;
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("hold");
		expect(ran).toBe(false);
		executor.sourceIsolation = true;
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("failed");
		expect(ran).toBe(true);
	});

	it("does not let authorization rewrite the frozen version to conceal source drift", async () => {
		const original = snapshot();
		const frozen = freezeIntegration(original, handoff);
		const changed = snapshot();
		changed.source = [entry("src/a.ts", "unapproved code")];
		const executor = host(() => changed);
		let ran = false;
		executor.authorize = async (_request, candidate) => {
			candidate.version.source = integrationVersion(changed).source;
			return true;
		};
		executor.run = async () => {
			ran = true;
			return { success: true, observed: "unapproved code passed" };
		};
		const evidence = await runFrozenAcceptance(frozen, request, executor);
		expect(evidence.status).toBe("hold");
		expect(evidence.version).toEqual(frozen.version);
		expect(ran).toBe(false);
	});

	it("cannot turn a failed executor result into passing evidence during the final capture", async () => {
		const current = snapshot();
		const frozen = freezeIntegration(current, handoff);
		const reported = { success: false, observed: "assertion failed: expected approved" };
		let completed = false;
		const executor = host(() => {
			if (completed) {
				reported.success = true;
				reported.observed = "unrelated later execution passed";
			}
			return current;
		});
		executor.run = async () => {
			completed = true;
			return reported;
		};
		const evidence = await runFrozenAcceptance(frozen, request, executor);
		expect(evidence.status).toBe("failed");
		expect(evidence.observed).toBe("assertion failed: expected approved");
		expect(acceptanceApplies(evidence, frozen.version)).toBe(false);
	});

	it("rejects mutations including test source and checked-in baselines", async () => {
		const current = snapshot();
		const frozen = freezeIntegration(current, handoff);
		const executor = host(() => current);
		executor.run = async () => {
			current.source = [...current.source, entry("test/baseline.json", "changed")];
			return { success: true, observed: "passed" };
		};
		const evidence = await runFrozenAcceptance(frozen, request, executor);
		expect(evidence.status).toBe("hold");
		expect(evidence.reason).toContain("changed during acceptance");
		expect(acceptanceApplies(evidence, frozen.version)).toBe(false);
	});

	it("invalidates old passing evidence on source, spec or upstream changes", async () => {
		const current = snapshot();
		const frozen = freezeIntegration(current, handoff);
		const evidence = await runFrozenAcceptance(
			frozen,
			request,
			host(() => current),
		);
		expect(evidence.status).toBe("passed");
		expect(acceptanceApplies(evidence, frozen.version)).toBe(true);
		for (const category of ["source", "specification", "upstream"] as const) {
			const next = snapshot();
			next[category] = [...next[category], entry("new", "content")];
			expect(acceptanceApplies(evidence, integrationVersion(next))).toBe(false);
		}
	});

	it("does not run on drift and never treats an execution or capture failure as a pass", async () => {
		const current = snapshot();
		const frozen = freezeIntegration(current, handoff);
		const changed = snapshot();
		changed.specification = [entry("spec.md", "new spec")];
		const executor = host(() => changed);
		let ran = false;
		executor.run = async () => {
			ran = true;
			throw new Error("failed");
		};
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("hold");
		expect(ran).toBe(false);
		executor.capture = async () => current;
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("failed");
		executor.capture = async () => {
			throw new Error("unavailable");
		};
		expect((await runFrozenAcceptance(frozen, request, executor)).status).toBe("hold");
	});
});

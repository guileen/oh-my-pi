import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { integrationVersion } from "../src/graph/subgraph-freeze";
import {
	captureLocalIntegration,
	createLocalAcceptanceHost,
	freezeLocalIntegration,
	runLocalFrozenAcceptance,
} from "../src/graph/subgraph-local";

describe("local frozen acceptance", () => {
	it("captures complete protected trees and detects file additions and symlink escapes", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "graph-snapshot-"));
		try {
			await fs.mkdir(path.join(workspace, "source"));
			await fs.mkdir(path.join(workspace, "spec"));
			await fs.writeFile(path.join(workspace, "source", "a"), "source");
			await fs.writeFile(path.join(workspace, "spec", "a"), "spec");
			const scope = {
				workspace,
				source: ["source"],
				specification: ["spec"],
				upstream: [],
				maxFiles: 20,
				maxBytes: 1000,
			};
			const initial = integrationVersion(await captureLocalIntegration(scope));
			await fs.writeFile(path.join(workspace, "source", "baseline"), "new");
			expect(integrationVersion(await captureLocalIntegration(scope)).source).not.toBe(initial.source);
			await fs.symlink(os.tmpdir(), path.join(workspace, "source", "outside"));
			await expect(captureLocalIntegration(scope)).rejects.toThrow("Symlink");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("executes only after limitation approval and rejects test-written source", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "graph-acceptance-"));
		try {
			await fs.mkdir(path.join(workspace, "source"));
			await fs.mkdir(path.join(workspace, "spec"));
			await fs.writeFile(path.join(workspace, "source", "a"), "original");
			await fs.writeFile(path.join(workspace, "spec", "a"), "spec");
			const scope = {
				workspace,
				source: ["source"],
				specification: ["spec"],
				upstream: [],
				maxFiles: 20,
				maxBytes: 1000,
			};
			const frozen = await freezeLocalIntegration(scope, {
				integrator: "coder",
				sourceRevision: "revision",
				changeRiskMap: { id: "map", digest: `sha256:${"a".repeat(64)}` },
			});
			const argv: [string, ...string[]] = [
				process.execPath,
				"-e",
				"require('node:fs').writeFileSync('source/a', 'changed')",
			];
			const request = {
				tester: "tester",
				command: JSON.stringify(argv),
				scenario: "regression",
				environment: "local",
			};
			const options = {
				scope,
				frozen,
				request,
				argv,
				env: { ...process.env } as Record<string, string>,
				timeoutMs: 10000,
				authorize: async () => true,
				authorizeIsolationLimitation: async () => false,
			};
			const adapter = createLocalAcceptanceHost(options);
			expect(await adapter.authorize({ ...request, scenario: "other" }, frozen)).toBe(false);
			expect((await runLocalFrozenAcceptance(options)).status).toBe("hold");
			expect(await fs.readFile(path.join(workspace, "source", "a"), "utf8")).toBe("original");
			options.authorizeIsolationLimitation = async () => true;
			const evidence = await runLocalFrozenAcceptance(options);
			expect(evidence.status).toBe("hold");
			expect(evidence.reason).toContain("changed during acceptance");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("records the approved command even when policy callbacks mutate their arguments", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "graph-acceptance-binding-"));
		try {
			await Bun.write(path.join(workspace, "source"), "original");
			await Bun.write(path.join(workspace, "spec"), "spec");
			const scope = {
				workspace,
				source: ["source"],
				specification: ["spec"],
				upstream: [],
				maxFiles: 10,
				maxBytes: 1000,
			};
			const frozen = await freezeLocalIntegration(scope, {
				integrator: "coder",
				sourceRevision: "revision",
				changeRiskMap: { id: "map", digest: `sha256:${"a".repeat(64)}` },
			});
			const argv: [string, ...string[]] = [
				process.execPath,
				"-e",
				"require('node:fs').writeFileSync('observed', 'approved command ran')",
			];
			const request = {
				tester: "tester",
				command: JSON.stringify(argv),
				scenario: "command binding",
				environment: "local",
			};
			let limitationCommand: string | undefined;
			const evidence = await runLocalFrozenAcceptance({
				scope,
				frozen,
				request,
				argv,
				env: {},
				timeoutMs: 10000,
				authorize: async candidate => {
					candidate.command = "different command";
					candidate.tester = "coder";
					return true;
				},
				authorizeIsolationLimitation: async candidate => {
					limitationCommand = candidate.command;
					candidate.scenario = "different scenario";
					return true;
				},
			});
			expect(await Bun.file(path.join(workspace, "observed")).text()).toBe("approved command ran");
			expect(evidence.status).toBe("passed");
			expect(evidence.request).toEqual(request);
			expect(limitationCommand).toBe(request.command);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
});

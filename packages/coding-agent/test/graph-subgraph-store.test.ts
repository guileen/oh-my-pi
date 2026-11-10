import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphRunStore } from "../src/graph/store";
import type {
	AcceptanceExecutionIdentity,
	AcceptanceExecutionReceipt,
	AcceptanceExecutionStopped,
	AcceptanceHost,
	IntegrationSnapshot,
} from "../src/graph/subgraph-freeze";
import { captureLocalIntegration, createLocalAcceptanceHost } from "../src/graph/subgraph-local";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const roots: string[] = [];
const stores: GraphRunStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-acceptance-"));
	roots.push(root);
	const store = new GraphRunStore(limits, root);
	stores.push(store);
	const content =
		"---\nformat: omp.graph/v1\nname: gate\nmembers: {}\nnodes:\n  approval: {kind: program, executor: test, task: '#approval'}\n---\n## approval\nDecide.\n";
	const graph = store.definitions.mutate({
		version: 1,
		request_key: "graph",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(graph.target_id!)!;
	const authorization_ref = { id: "auth", digest: "sha256:auth" };
	const result = store.start(
		{
			version: 1,
			request_key: "run",
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
			executors: { test: { id: "test", digest: "sha256:test" } },
		},
	);
	const owner = store.claimHost()!;
	return { store, root, owner, runId: result.target_id! };
}
const entry = (path: string, content: string) => ({
	path,
	kind: "file" as const,
	mode: 0o644,
	content: new TextEncoder().encode(content),
});
const snapshot = (): IntegrationSnapshot => ({
	source: [entry("src/a", "code")],
	specification: [entry("spec", "spec")],
	upstream: [],
});
const handoff = {
	integrator: "integrator",
	sourceRevision: "rev",
	changeRiskMap: { id: "risk", digest: `sha256:${"a".repeat(64)}` },
};
const request = { tester: "tester", command: "test", scenario: "acceptance", environment: "isolated" };
function host(current: IntegrationSnapshot): AcceptanceHost {
	return {
		authorize: async () => true,
		sourceIsolation: true,
		isolationDescription: "read only",
		capture: async () => current,
		run: async () => ({ success: true, observed: "passed" }),
	};
}

describe("durable integration acceptance", () => {
	it("persists receipts, invalidates drift and supersedes old frozen versions", async () => {
		const { store, root, owner, runId } = setup();
		const current = snapshot();
		const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
		const result = await store.runIntegrationAcceptance(
			owner.owner_id,
			owner.epoch,
			runId,
			frozen.revision,
			request,
			host(current),
		);
		expect(result.evidence.status).toBe("passed");
		expect(store.getApplicableIntegrationAcceptance(runId, current)).toEqual(result.evidence);
		const changed = snapshot();
		changed.source = [entry("src/a", "new")];
		expect(store.getApplicableIntegrationAcceptance(runId, changed)).toBeNull();
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		expect(reopened.getApplicableIntegrationAcceptance(runId, current)).toEqual(result.evidence);
		store.freezeIntegration(owner.owner_id, owner.epoch, runId, result.revision, changed, handoff);
		expect(store.getApplicableIntegrationAcceptance(runId, current)).toBeNull();
	});

	it("rejects stale revisions and cannot commit a test racing a new freeze", async () => {
		const { store, owner, runId } = setup();
		const current = snapshot();
		const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
		expect(() => store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff)).toThrow();
		const runner = host(current);
		runner.run = async () => {
			store.freezeIntegration(owner.owner_id, owner.epoch, runId, store.getRun(runId)!.revision, current, handoff);
			return { success: true, observed: "passed" };
		};
		await expect(
			store.runIntegrationAcceptance(owner.owner_id, owner.epoch, runId, frozen.revision, request, runner),
		).rejects.toThrow();
		expect(store.getApplicableIntegrationAcceptance(runId, current)).toBeNull();
	});

	it("records a local execution with its actual isolation disclosure", async () => {
		const { store, root, owner, runId } = setup();
		const workspace = path.join(root, "workspace");
		fs.mkdirSync(workspace);
		fs.writeFileSync(path.join(workspace, "source"), "code");
		fs.writeFileSync(path.join(workspace, "spec"), "spec");
		const scope = {
			workspace,
			source: ["source"],
			specification: ["spec"],
			upstream: [],
			maxFiles: 10,
			maxBytes: 1000,
		};
		const current = await captureLocalIntegration(scope);
		const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
		const argv: [string, ...string[]] = [process.execPath, "-e", "process.exit(0)"];
		const localRequest = { ...request, command: JSON.stringify(argv), environment: "local" };
		const executor = createLocalAcceptanceHost({
			scope,
			request: localRequest,
			argv,
			env: {},
			timeoutMs: 10000,
			authorize: async () => true,
			authorizeIsolationLimitation: async () => true,
		});
		const result = await store.runIntegrationAcceptance(
			owner.owner_id,
			owner.epoch,
			runId,
			frozen.revision,
			localRequest,
			executor,
		);
		expect(result.evidence.status).toBe("passed");
		expect(result.evidence.isolation).toContain("No OS sandbox");
		expect(store.getApplicableIntegrationAcceptance(runId, await captureLocalIntegration(scope))).toEqual(
			result.evidence,
		);
	});

	it("does not let earlier passes override a later failed test", async () => {
		const { store, owner, runId } = setup();
		const current = snapshot();
		const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
		const passed = await store.runIntegrationAcceptance(
			owner.owner_id,
			owner.epoch,
			runId,
			frozen.revision,
			request,
			host(current),
		);
		const runner = host(current);
		runner.run = async () => {
			expect(store.getApplicableIntegrationAcceptance(runId, current)).toBeNull();
			return { success: false, observed: "failed" };
		};
		const failed = await store.runIntegrationAcceptance(
			owner.owner_id,
			owner.epoch,
			runId,
			passed.revision,
			request,
			runner,
		);
		expect(failed.evidence.status).toBe("failed");
		expect(store.getApplicableIntegrationAcceptance(runId, current)).toBeNull();
	});

	it("reconciles an unknown execution after restart without replaying validation or reviving cancellation", async () => {
		const { store, root, owner, runId } = setup();
		const current = snapshot();
		const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
		let dispatched: AcceptanceExecutionIdentity | undefined;
		let runs = 0;
		const runner = host(current);
		runner.run = async (_request, identity) => {
			runs++;
			dispatched = structuredClone(identity);
			// Losing this result says nothing about external execution termination.
			throw new Error("transport lost");
		};
		const uncertain = await store.runIntegrationAcceptance(
			owner.owner_id,
			owner.epoch,
			runId,
			frozen.revision,
			request,
			runner,
		);
		expect(uncertain.evidence.status).toBe("hold");
		const [pending] = store.getPendingIntegrationAcceptanceExecutions(owner.owner_id, owner.epoch, runId);
		expect(pending.identity).toEqual(dispatched!);
		expect(pending.identity.freeze_id).toBe(frozen.id);
		expect(pending.state).toBe("unknown");
		expect(pending.request).toEqual(request);
		expect(pending.frozen).toEqual(frozen.frozen);
		await expect(
			store.runIntegrationAcceptance(owner.owner_id, owner.epoch, runId, uncertain.revision, request, runner),
		).rejects.toThrow();
		store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
		store.mutateLifecycle("owner", {
			version: 1,
			request_key: "cancel-recovery",
			operation: "cancel",
			target_id: runId,
			if_revision: store.getRun(runId)!.revision,
			payload: { reason: "stop" },
		});
		expect(store.getRun(runId)?.state).toBe("cancelling");
		store.close();
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		const next = reopened.claimHost()!;
		expect(reopened.getPendingIntegrationAcceptanceExecutions(next.owner_id, next.epoch, runId)).toEqual([pending]);
		expect(reopened.getRun(runId)?.state).toBe("cancelling");
		// This is an explicit trusted embedding observation fixture, not OS proof.
		// An embedding lacking independent, scope-complete stop knowledge MUST NOT submit it.
		const stopped: AcceptanceExecutionStopped = {
			identity: pending.identity,
			termination_ref: { id: "trusted-executor/stop-receipt", digest: `sha256:${"b".repeat(64)}` },
			observed: "Trusted executor reconciled its durable execution binding and confirmed it stopped",
		};
		expect(() => reopened.reconcileIntegrationAcceptanceExecution(owner.owner_id, owner.epoch, stopped)).toThrow();
		expect(() => reopened.getPendingIntegrationAcceptanceExecutions(owner.owner_id, owner.epoch, runId)).toThrow();
		for (const key of ["run_id", "execution_id", "freeze_id"] as const) {
			expect(() =>
				reopened.reconcileIntegrationAcceptanceExecution(next.owner_id, next.epoch, {
					...stopped,
					identity: { ...stopped.identity, [key]: "wrong" },
				}),
			).toThrow();
		}
		expect(() =>
			reopened.reconcileIntegrationAcceptanceExecution(next.owner_id, next.epoch, {
				...stopped,
				termination_ref: { id: "unbound", digest: "not-a-digest" },
			}),
		).toThrow();
		expect(reopened.getPendingIntegrationAcceptanceExecutions(next.owner_id, next.epoch, runId)).toEqual([pending]);
		const result = reopened.reconcileIntegrationAcceptanceExecution(next.owner_id, next.epoch, stopped);
		expect(result.evidence.status).toBe("hold");
		expect(reopened.getRun(runId)?.state).toBe("cancelled");
		expect(reopened.getApplicableIntegrationAcceptance(runId, current)).toBeNull();
		expect(reopened.getPendingIntegrationAcceptanceExecutions(next.owner_id, next.epoch, runId)).toEqual([]);
		const revision = reopened.getRun(runId)!.revision;
		expect(reopened.reconcileIntegrationAcceptanceExecution(next.owner_id, next.epoch, stopped)).toEqual(result);
		expect(() =>
			reopened.reconcileIntegrationAcceptanceExecution(next.owner_id, next.epoch, {
				...stopped,
				observed: "conflicting result",
			}),
		).toThrow();
		expect(reopened.getRun(runId)!.revision).toBe(revision);
		reopened.close();
		const again = new GraphRunStore(limits, root);
		stores.push(again);
		const latest = again.claimHost()!;
		expect(again.reconcileIntegrationAcceptanceExecution(latest.owner_id, latest.epoch, stopped)).toEqual(result);
		expect(again.getRun(runId)!.revision).toBe(revision);
		expect(runs).toBe(1);
	});

	it("retires the exact old-freeze execution after owner loss without blessing the replacement freeze", async () => {
		const { store, root, owner, runId } = setup();
		const current = snapshot();
		const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runner = host(current);
		runner.run = async () => {
			entered.resolve();
			await release.promise;
			return { success: true, observed: "late original result" };
		};
		const acceptance = store
			.runIntegrationAcceptance(owner.owner_id, owner.epoch, runId, frozen.revision, request, runner)
			.then(
				value => ({ value }),
				error => ({ error }),
			);
		await entered.promise;
		const [pending] = store.getPendingIntegrationAcceptanceExecutions(owner.owner_id, owner.epoch, runId);
		const replacement = store.freezeIntegration(
			owner.owner_id,
			owner.epoch,
			runId,
			store.getRun(runId)!.revision,
			current,
			handoff,
		);
		store.close();
		const reopened = new GraphRunStore(limits, root);
		stores.push(reopened);
		const next = reopened.claimHost()!;
		expect(reopened.getPendingIntegrationAcceptanceExecutions(next.owner_id, next.epoch, runId)[0].state).toBe(
			"active",
		);
		const stopped: AcceptanceExecutionStopped = {
			identity: pending.identity,
			termination_ref: { id: "trusted-old-freeze-stop", digest: `sha256:${"d".repeat(64)}` },
			observed: "Trusted embedding confirmed the old execution stopped; its original callback is still delayed",
		};
		let result: AcceptanceExecutionReceipt;
		try {
			expect(() =>
				reopened.reconcileIntegrationAcceptanceExecution(next.owner_id, next.epoch, {
					...stopped,
					identity: { ...pending.identity, freeze_id: replacement.id },
				}),
			).toThrow();
			result = reopened.reconcileIntegrationAcceptanceExecution(next.owner_id, next.epoch, stopped);
		} finally {
			release.resolve();
		}
		expect("error" in (await acceptance)).toBe(true);
		expect(reopened.getRun(runId)?.state).toBe("held");
		expect(reopened.getRun(runId)?.revision).toBe(result.revision);
		expect(reopened.getIntegrationFreeze(runId)?.id).toBe(replacement.id);
		expect(reopened.getApplicableIntegrationAcceptance(runId, current)).toBeNull();
		expect(reopened.reconcileIntegrationAcceptanceExecution(next.owner_id, next.epoch, stopped)).toEqual(result);
	});

	it("does not replace an already committed validation result with a recovery observation", async () => {
		const { store, owner, runId } = setup();
		const current = snapshot();
		const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
		const passed = await store.runIntegrationAcceptance(
			owner.owner_id,
			owner.epoch,
			runId,
			frozen.revision,
			request,
			host(current),
		);
		expect(() =>
			store.reconcileIntegrationAcceptanceExecution(owner.owner_id, owner.epoch, {
				identity: { run_id: runId, execution_id: passed.id, freeze_id: frozen.id },
				termination_ref: { id: "late-stop", digest: `sha256:${"e".repeat(64)}` },
				observed: "Late recovery cannot rewrite a normal committed result",
			}),
		).toThrow();
		expect(store.getRun(runId)?.revision).toBe(passed.revision);
		expect(store.getApplicableIntegrationAcceptance(runId, current)).toEqual(passed.evidence);
	});

	for (const phase of ["preparing", "running"] as const) {
		it(`does not let a late ${phase} callback overwrite a reconciled execution`, async () => {
			const { store, owner, runId } = setup();
			const current = snapshot();
			const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const runner = host(current);
			let runs = 0;
			if (phase === "preparing")
				runner.authorize = async () => {
					entered.resolve();
					await release.promise;
					return true;
				};
			runner.run = async () => {
				runs++;
				entered.resolve();
				await release.promise;
				return { success: true, observed: "late passing result" };
			};
			const acceptance = store.runIntegrationAcceptance(
				owner.owner_id,
				owner.epoch,
				runId,
				frozen.revision,
				request,
				runner,
			);
			await entered.promise;
			const [pending] = store.getPendingIntegrationAcceptanceExecutions(owner.owner_id, owner.epoch, runId);
			const stopped: AcceptanceExecutionStopped = {
				identity: pending.identity,
				termination_ref: { id: "trusted-stop", digest: `sha256:${"c".repeat(64)}` },
				observed: "Trusted embedding confirms the exact pending execution cannot produce further effects",
			};
			let reconciled: AcceptanceExecutionReceipt;
			try {
				reconciled = store.reconcileIntegrationAcceptanceExecution(owner.owner_id, owner.epoch, stopped);
			} finally {
				release.resolve();
			}
			expect(await acceptance).toEqual(reconciled);
			expect(store.getRun(runId)?.state).toBe("held");
			expect(store.getRun(runId)?.revision).toBe(reconciled.revision);
			expect(store.getApplicableIntegrationAcceptance(runId, current)).toBeNull();
			expect(runs).toBe(phase === "preparing" ? 0 : 1);
		});
	}

	for (const phase of ["preparing", "running", "uncertain", "restart"] as const) {
		it(`does not confirm cancellation while acceptance is ${phase}`, async () => {
			const { store, root, owner, runId } = setup();
			const current = snapshot();
			const frozen = store.freezeIntegration(owner.owner_id, owner.epoch, runId, "1", current, handoff);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const runner = host(current);
			let runs = 0;
			if (phase === "preparing")
				runner.authorize = async () => {
					entered.resolve();
					await release.promise;
					return true;
				};
			runner.run = async () => {
				runs++;
				entered.resolve();
				await release.promise;
				if (phase === "uncertain") throw new Error("execution result unavailable");
				return { success: true, observed: "finished after cancel" };
			};
			const acceptance = store.runIntegrationAcceptance(
				owner.owner_id,
				owner.epoch,
				runId,
				frozen.revision,
				request,
				runner,
			);
			// Observe rejection immediately too; the assertion below must not leak a pending promise.
			const result = acceptance.then(
				value => ({ value }),
				error => ({ error }),
			);
			await entered.promise;
			let active = store;
			if (phase === "restart") {
				store.close();
				active = new GraphRunStore(limits, root);
				stores.push(active);
				expect(active.claimHost()).not.toBeNull();
			}
			active.configureLifecycle({ authorize: () => true, verifyResume: () => false });
			try {
				expect(
					active.mutateLifecycle("owner", {
						version: 1,
						request_key: "cancel",
						operation: "cancel",
						target_id: runId,
						if_revision: active.getRun(runId)!.revision,
						payload: { reason: "cancel acceptance" },
					}).state,
				).toBe("completed");
				expect(active.getRun(runId)?.state).toBe("cancelling");
			} finally {
				release.resolve();
				await result;
			}
			expect(active.getRun(runId)?.state).toBe(
				phase === "uncertain" || phase === "restart" ? "cancelling" : "cancelled",
			);
			expect(active.getApplicableIntegrationAcceptance(runId, current)).toBeNull();
			expect(runs).toBe(phase === "preparing" ? 0 : 1);
			if (phase === "running") {
				const recorded = await result;
				expect("value" in recorded && recorded.value.evidence.observed).toBe("finished after cancel");
			}
		});
	}
});

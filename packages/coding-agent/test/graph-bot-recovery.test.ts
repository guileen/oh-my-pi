import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphRunStore, type GraphBotStopped } from "../src/graph/store";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const stores: GraphRunStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function open(root?: string) {
	if (!root) {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-bot-recovery-"));
		roots.push(root);
	}
	const store = new GraphRunStore(limits, root);
	stores.push(store);
	return { store, root };
}
function close(store: GraphRunStore) {
	store.close();
	stores.splice(stores.indexOf(store), 1);
}
function start(store: GraphRunStore, name: string, kind = "bot", grants = "read: [], write: [], execute: []") {
	const imported = store.definitions.mutate({
		version: 1,
		request_key: `import-${name}`,
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content: `---\nformat: omp.graph/v1\nname: ${name}\n${kind === "bot" ? `members:\n  worker: {role: '#work', model: test, base: omp-default, duty: general, permissions: {${grants}}}\n` : "members: {}\n"}nodes:\n  work: {kind: ${kind}, ${kind === "program" ? "executor: test, " : "member: worker, "}task: '#work'}\n---\n## work\nWork.\n`,
		},
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const authorization_ref = { id: "auth", digest: "sha256:auth" };
	return store.start(
		{
			version: 1,
			request_key: `start-${name}`,
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
			members:
				kind === "bot"
					? {
							worker: {
								provider: "test",
								model: "test-model",
								configuration_revision: "1",
								base: "omp-default",
								base_snapshot_ref: authorization_ref,
								role_ref: authorization_ref,
								skill_refs: [],
								rule_refs: [],
							},
						}
					: {},
			executors: kind === "program" ? { test: authorization_ref } : {},
		},
	).target_id!;
}
function dispatch(store: GraphRunStore, runId: string) {
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "unknown", { reason: "lost response" });
	const stopped: GraphBotStopped = {
		identity: {
			run_id: runId,
			intent_id: intent.id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			request_key: intent.request_key,
		},
		if_revision: store.getRun(runId)!.revision,
		termination_ref: { id: "operator-attestation", digest: `sha256:${"b".repeat(64)}` },
		observed: "Operator confirmed no executor process or foreground Graph host remains",
	};
	return { owner, intent, stopped };
}

it("records an unconfirmed Bot attempt as failed and keeps the Run held", () => {
	const { store, root } = open();
	const id = start(store, "lost");
	const { owner, intent, stopped } = dispatch(store, id);
	close(store);
	const reopened = open(root).store;
	const current = reopened.claimHost()!;
	expect(current.epoch).not.toBe(owner.epoch);
	const receipt = reopened.reconcileBotExecution(current.owner_id, current.epoch, stopped);
	expect(receipt.completion).toMatchObject({ state: "failed", attempt_id: intent.attempt_id, fence: intent.fence });
	expect(receipt.completion.outputs).toBeUndefined();
	expect(reopened.getRun(id)!.state).toBe("held");
	expect(reopened.getDispatchIntents(id)[0]).toMatchObject({
		state: "finished",
		observation: { previous: { reason: "lost response" }, recovery: stopped },
	});
	expect(reopened.getScheduleState(id)!.invocations[0].state).toBe("failed");
	expect(reopened.getAttemptHistory(id).map(row => [row.accepted, row.completion.state])).toEqual([[true, "failed"]]);
	expect(reopened.reconcileBotExecution(current.owner_id, current.epoch, stopped)).toEqual(receipt);
	expect(() =>
		reopened.reconcileBotExecution(current.owner_id, current.epoch, { ...stopped, observed: "different" }),
	).toThrow("conflicts");
});

it("rejects stale owners, mismatched identities, stale revisions and program nodes", () => {
	const { store, root } = open();
	const id = start(store, "identity");
	const { owner, stopped } = dispatch(store, id);
	close(store);
	const reopened = open(root).store;
	const current = reopened.claimHost()!;
	expect(() => reopened.reconcileBotExecution(owner.owner_id, owner.epoch, stopped)).toThrow("stale");
	for (const identity of [
		{ ...stopped.identity, run_id: "another-run" },
		{ ...stopped.identity, invocation_id: "another-invocation" },
		{ ...stopped.identity, attempt_id: "another-attempt" },
		{ ...stopped.identity, fence: current.epoch },
		{ ...stopped.identity, request_key: "another-key" },
	]) {
		expect(() => reopened.reconcileBotExecution(current.owner_id, current.epoch, { ...stopped, identity })).toThrow(
			"identity",
		);
	}
	expect(() =>
		reopened.reconcileBotExecution(current.owner_id, current.epoch, { ...stopped, if_revision: "0" }),
	).toThrow("revision");
	expect(() => reopened.reconcileBotExecution(current.owner_id, current.epoch, { ...stopped, observed: " " })).toThrow(
		"observation",
	);
	expect(reopened.getDispatchIntents(id)[0].state).toBe("unknown");
	expect(reopened.getAttemptHistory(id)).toEqual([]);

	// The unresolved Bot intent retains the profile writer scope, so the program case
	// runs in its own profile to reach the node-kind guard rather than the writer wait.
	const other = open().store;
	const program = start(other, "program", "program");
	const programDispatch = dispatch(other, program);
	expect(() =>
		other.reconcileBotExecution(programDispatch.owner.owner_id, programDispatch.owner.epoch, programDispatch.stopped),
	).toThrow("Bot node");
});

it("closes a held Run only after every attempt is settled, then unblocks the profile", () => {
	const { store } = open();
	const id = start(store, "wedge", "bot", "read: [], write: ['artifacts'], execute: []");
	const { owner, stopped } = dispatch(store, id);
	expect(() =>
		store.closeHeldRun(owner.owner_id, owner.epoch, {
			run_id: id,
			if_revision: store.getRun(id)!.revision,
			reason: "close",
		}),
	).toThrow("settled");
	store.reconcileBotExecution(owner.owner_id, owner.epoch, stopped);
	const closed = store.closeHeldRun(owner.owner_id, owner.epoch, {
		run_id: id,
		if_revision: store.getRun(id)!.revision,
		reason: "Recovered after operator attestation",
	});
	expect(closed.state).toBe("cancelled");
	expect(() =>
		store.closeHeldRun(owner.owner_id, owner.epoch, {
			run_id: id,
			if_revision: closed.revision,
			reason: "again",
		}),
	).toThrow("held");
	expect(store.listHostRuns()).toEqual([]);
	expect(store.listHostIntents()).toEqual([]);
	const writers = store.getProfileWriterAdmissions(owner.owner_id, owner.epoch);
	expect(writers.map(row => row.run_id)).toEqual([id]);
	for (const identity of writers)
		store.reconcileProfileWriter(owner.owner_id, owner.epoch, {
			identity,
			if_revision: store.getRun(id)!.revision,
			termination_ref: stopped.termination_ref,
			observed: stopped.observed,
		});
	expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch)).toEqual([]);
	const next = start(store, "next");
	store.schedule(next, owner.owner_id, owner.epoch);
	expect(store.schedule(next, owner.owner_id, owner.epoch).intent?.run_id).toBe(next);
});

it("settles a cancelling Run once the executor's unknown Bot attempt is attested", () => {
	const { store } = open();
	const id = start(store, "abandoned");
	const { owner, stopped } = dispatch(store, id);
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	store.mutateLifecycle("operator", {
		version: 1,
		request_key: "cancel-abandoned",
		operation: "cancel",
		target_id: id,
		if_revision: store.getRun(id)!.revision,
		payload: { reason: "executor disappeared mid-cancel" },
	});
	// Cancellation is recorded but no executor is left to confirm it.
	expect(store.getRun(id)!.state).toBe("cancelling");
	// Attesting the dead attempt is the whole recovery: reconciliation has no effects left to
	// resolve, so it settles the Run itself instead of leaving an operator closure to do it.
	const receipt = store.reconcileBotExecution(owner.owner_id, owner.epoch, {
		...stopped,
		if_revision: store.getRun(id)!.revision,
	});
	expect(receipt.completion.state).toBe("cancelled");
	expect(store.getRun(id)!.state).toBe("cancelled");
	expect(store.getRun(id)!.reason).toBe("executor disappeared mid-cancel");
	expect(store.getDispatchIntents(id).every(intent => intent.state === "finished")).toBe(true);
	expect(store.listHostRuns()).toEqual([]);
	expect(store.listHostIntents()).toEqual([]);
});

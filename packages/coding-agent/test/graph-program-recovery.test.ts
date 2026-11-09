import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphRunStore, type GraphProgramStopped } from "../src/graph/store";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const stores: GraphRunStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function open(root?: string) {
	if (!root) {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-program-recovery-"));
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
function start(store: GraphRunStore, name: string, kind = "program") {
	const imported = store.definitions.mutate({
		version: 1,
		request_key: `import-${name}`,
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content: `---\nformat: omp.graph/v1\nname: ${name}\nmembers: {}\nnodes:\n  work: {kind: ${kind}, ${kind === "program" ? "executor: test, " : ""}task: '#work'}\n---\n## work\nWork.\n`,
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
			members: {},
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
	const stopped: GraphProgramStopped = {
		identity: {
			run_id: runId,
			intent_id: intent.id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			request_key: intent.request_key,
		},
		if_revision: store.getRun(runId)!.revision,
		termination_ref: { id: "independent-stop", digest: `sha256:${"a".repeat(64)}` },
		observed: "Fixture independently confirmed the execution and all its effects stopped",
	};
	return { owner, intent, stopped };
}

it("closes an old-epoch unknown program without accepting stale success or releasing its Run writer", () => {
	const { store, root } = open();
	const id = start(store, "lost");
	const { owner, intent, stopped } = dispatch(store, id);
	close(store);
	const reopened = open(root).store;
	const current = reopened.claimHost()!;
	expect(current.epoch).not.toBe(owner.epoch);
	expect(
		reopened.completeAttempt(current.owner_id, current.epoch, {
			run_id: id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			state: "succeeded",
			outcome: "done",
		}),
	).toBe(false);
	const receipt = reopened.reconcileProgramExecution(current.owner_id, current.epoch, stopped);
	expect(receipt.completion).toMatchObject({ state: "failed", attempt_id: intent.attempt_id, fence: intent.fence });
	expect(receipt.completion.outputs).toBeUndefined();
	expect(reopened.getRun(id)!.state).toBe("held");
	expect(reopened.getDispatchIntents(id)[0]).toMatchObject({
		state: "finished",
		observation: { previous: { reason: "lost response" }, recovery: stopped },
	});
	expect(reopened.getScheduleState(id)!.invocations[0].state).toBe("failed");
	expect(reopened.getAttemptHistory(id).map(row => [row.accepted, row.completion.state])).toEqual([
		[false, "succeeded"],
		[true, "failed"],
	]);
	const second = start(reopened, "waiting");
	reopened.schedule(second, current.owner_id, current.epoch);
	expect(reopened.schedule(second, current.owner_id, current.epoch).intent).toBeNull();
	expect(reopened.getProfileWriterAdmissions(current.owner_id, current.epoch).map(row => row.run_id)).toEqual([id]);
});

it("rejects stale owners, mismatched execution identities, stale revisions and unbound stop facts atomically", () => {
	const { store, root } = open();
	const id = start(store, "identity");
	const { owner, stopped } = dispatch(store, id);
	close(store);
	const reopened = open(root).store;
	const current = reopened.claimHost()!;
	expect(() => reopened.reconcileProgramExecution(owner.owner_id, owner.epoch, stopped)).toThrow("stale");
	for (const identity of [
		{ ...stopped.identity, run_id: "another-run" },
		{ ...stopped.identity, invocation_id: "another-invocation" },
		{ ...stopped.identity, attempt_id: "another-attempt" },
		{ ...stopped.identity, fence: current.epoch },
		{ ...stopped.identity, request_key: "another-key" },
	]) {
		expect(() =>
			reopened.reconcileProgramExecution(current.owner_id, current.epoch, { ...stopped, identity }),
		).toThrow("identity");
	}
	expect(() =>
		reopened.reconcileProgramExecution(current.owner_id, current.epoch, { ...stopped, if_revision: "0" }),
	).toThrow("revision");
	expect(() =>
		reopened.reconcileProgramExecution(current.owner_id, current.epoch, { ...stopped, observed: " " }),
	).toThrow("observation");
	expect(reopened.getRun(id)!.revision).toBe(stopped.if_revision);
	expect(reopened.getDispatchIntents(id)[0].state).toBe("unknown");
	expect(reopened.getAttemptHistory(id)).toEqual([]);
});

it("settles cancellation with a durable replay receipt but leaves whole-Run quiescence separate", () => {
	const { store, root } = open();
	const id = start(store, "cancel");
	const { owner, stopped } = dispatch(store, id);
	store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
	expect(
		store.mutateLifecycle("alice", {
			version: 1,
			operation: "cancel",
			request_key: "cancel",
			target_id: id,
			if_revision: store.getRun(id)!.revision,
			payload: { reason: "requested" },
		}).state,
	).toBe("completed");
	expect(store.getRun(id)!.state).toBe("cancelling");
	stopped.if_revision = store.getRun(id)!.revision;
	const receipt = store.reconcileProgramExecution(owner.owner_id, owner.epoch, stopped);
	expect(receipt.completion.state).toBe("cancelled");
	expect(store.getRun(id)!.state).toBe("cancelled");
	const identity = store.getProfileWriterAdmissions(owner.owner_id, owner.epoch)[0];
	store.reconcileProfileWriter(owner.owner_id, owner.epoch, {
		identity,
		if_revision: store.getRun(id)!.revision,
		termination_ref: stopped.termination_ref,
		observed: "Separate whole-Run quiescence observation",
	});
	const second = start(store, "next");
	store.schedule(second, owner.owner_id, owner.epoch);
	expect(store.schedule(second, owner.owner_id, owner.epoch).intent?.run_id).toBe(second);
	close(store);
	const reopened = open(root).store;
	const current = reopened.claimHost()!;
	expect(reopened.reconcileProgramExecution(current.owner_id, current.epoch, stopped)).toEqual(receipt);
	expect(reopened.getAttemptHistory(id)).toHaveLength(1);
	expect(reopened.getProfileWriterAdmissions(current.owner_id, current.epoch).map(row => row.run_id)).toEqual([
		second,
	]);
	expect(() =>
		reopened.reconcileProgramExecution(current.owner_id, current.epoch, { ...stopped, observed: "different" }),
	).toThrow("conflicts");
});

it("does not use program stop reconciliation to finish a human node", () => {
	const { store } = open();
	const id = start(store, "human", "human");
	const { owner, stopped } = dispatch(store, id);
	expect(() => store.reconcileProgramExecution(owner.owner_id, owner.epoch, stopped)).toThrow("program");
	expect(store.getDispatchIntents(id)[0].state).toBe("unknown");
	expect(store.getAttemptHistory(id)).toEqual([]);
});

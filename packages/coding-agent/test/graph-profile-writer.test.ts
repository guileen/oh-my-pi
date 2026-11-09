import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphRunStore, type GraphDispatchIntent } from "../src/graph/store";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const stores: GraphRunStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function open(root?: string) {
	if (!root) {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-profile-writer-"));
		roots.push(root);
	}
	const store = new GraphRunStore(limits, root);
	stores.push(store);
	return { store, root };
}
function start(store: GraphRunStore, name: string, kind = "program") {
	const graph = store.definitions.mutate({
		version: 1,
		request_key: `import-${name}`,
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content: `---\nformat: omp.graph/v1\nname: ${name}\nmembers: {}\nnodes:\n  work: {kind: ${kind}, ${kind === "program" ? "executor: test, " : ""}task: '#work'}\n---\n## work\nWork.\n`,
		},
	});
	const definition = store.definitions.get(graph.target_id!)!;
	const authorization_ref = { id: "auth", digest: "sha256:auth" };
	const result = store.start(
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
			executors: kind === "program" ? { test: { id: "test", digest: "sha256:test" } } : {},
		},
	);
	expect(result.state).toBe("accepted");
	return result.target_id!;
}

function startText(store: GraphRunStore, name: string, write: string[] = []) {
	const permissions = `{read: [], write: [${write.map(item => `'${item}'`).join(", ")}], execute: []}`;
	const graph = store.definitions.mutate({
		version: 1,
		request_key: `import-${name}`,
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content: `---\nformat: omp.graph/v1\nname: ${name}\nmembers:\n  writer: {model: fixture/model, base: omp-default, duty: general, role: '#writer', permissions: ${permissions}}\nnodes:\n  work: {kind: bot, member: writer, task: '#work'}\n---\n## writer\nWrite.\n## work\nWork.\n`,
		},
	});
	const definition = store.definitions.get(graph.target_id!)!;
	const authorization_ref = { id: `auth-${name}`, digest: `sha256:${"b".repeat(64)}` };
	const result = store.start(
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
			members: {
				writer: {
					provider: "fixture",
					model: "fixture-model",
					configuration_revision: "1",
					base: "omp-default",
					base_snapshot_ref: { id: "base", digest: `sha256:${"c".repeat(64)}` },
					role_ref: { id: "role", digest: `sha256:${"d".repeat(64)}` },
					skill_refs: [],
					rule_refs: [],
				},
			},
			executors: {},
		},
	);
	expect(result.state).toBe("accepted");
	return result.target_id!;
}

function authorize(store: GraphRunStore, runId: string) {
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	expect(intent).not.toBeNull();
	return { owner, intent };
}

function finish(store: GraphRunStore, intent: GraphDispatchIntent) {
	const owner = store.claimHost()!;
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: intent.run_id,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			state: "succeeded",
			outcome: "done",
			outputs: {},
		}),
	).toBe(true);
	for (let index = 0; index < 5 && store.getRun(intent.run_id)!.state === "running"; index++)
		store.schedule(intent.run_id, owner.owner_id, owner.epoch);
	expect(store.getRun(intent.run_id)!.state).toBe("succeeded");
}

function stopped(store: GraphRunStore, runId: string) {
	const owner = store.claimHost()!;
	const identity = store.getProfileWriterAdmissions(owner.owner_id, owner.epoch).find(item => item.run_id === runId)!;
	return {
		identity,
		if_revision: store.getRun(runId)!.revision,
		termination_ref: { id: "trusted-scope-receipt", digest: `sha256:${"a".repeat(64)}` },
		observed: "Fixture execution has no external work or descendants",
	};
}

it("does not authorize a second Run while another Run can still write", () => {
	const { store } = open();
	const a = start(store, "first");
	const b = start(store, "second");
	const owner = store.claimHost()!;
	store.schedule(a, owner.owner_id, owner.epoch);
	const first = store.schedule(a, owner.owner_id, owner.epoch).intent!;
	expect(store.claimDispatch(owner.owner_id, owner.epoch, first.id)?.state).toBe("submitting");
	store.schedule(b, owner.owner_id, owner.epoch);
	expect(store.schedule(b, owner.owner_id, owner.epoch).intent).toBeNull();
	expect(store.getDispatchIntents(b)).toEqual([]);
	expect(store.getScheduleState(b)!.invocations[0].state).toBe("ready");
});

it("retains the admission after completion until exact trusted reconciliation, without replaying release", () => {
	const { store } = open();
	const a = start(store, "completed");
	const b = start(store, "waiting");
	const { owner, intent } = authorize(store, a);
	store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	finish(store, intent);
	store.schedule(b, owner.owner_id, owner.epoch);
	expect(store.schedule(b, owner.owner_id, owner.epoch).intent).toBeNull();
	const proof = stopped(store, a);
	expect(() =>
		store.reconcileProfileWriter(owner.owner_id, owner.epoch, {
			...proof,
			identity: { ...proof.identity, admission_id: "wrong" },
		}),
	).toThrow("identity");
	expect(() =>
		store.reconcileProfileWriter(owner.owner_id, owner.epoch, {
			...proof,
			if_revision: "1",
		}),
	).toThrow("expected revision");
	const receipt = store.reconcileProfileWriter(owner.owner_id, owner.epoch, proof);
	expect(store.schedule(b, owner.owner_id, owner.epoch).intent?.run_id).toBe(b);
	expect(store.reconcileProfileWriter(owner.owner_id, owner.epoch, proof)).toEqual(receipt);
	expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch).map(item => item.run_id)).toEqual([b]);
	expect(() =>
		store.reconcileProfileWriter(owner.owner_id, owner.epoch, {
			...proof,
			observed: "different stop observation",
		}),
	).toThrow("conflicts");
});

it("does not release an unknown or held execution when Host ownership advances", () => {
	const { store, root } = open();
	const a = start(store, "unknown");
	const b = start(store, "after-restart");
	const { owner, intent } = authorize(store, a);
	store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "unknown", { reason: "response lost" });
	const proof = stopped(store, a);
	expect(() => store.reconcileProfileWriter(owner.owner_id, owner.epoch, proof)).toThrow("terminal");
	store.close();
	stores.splice(stores.indexOf(store), 1);
	const reopened = open(root).store;
	const current = reopened.claimHost()!;
	expect(current.epoch).not.toBe(owner.epoch);
	expect(() => reopened.reconcileProfileWriter(owner.owner_id, owner.epoch, proof)).toThrow("stale");
	reopened.schedule(b, current.owner_id, current.epoch);
	expect(reopened.schedule(b, current.owner_id, current.epoch).intent).toBeNull();
	expect(reopened.getDispatchIntents(a)[0].state).toBe("unknown");
	expect(reopened.getProfileWriterAdmissions(current.owner_id, current.epoch)).toEqual([proof.identity]);
});

it("does not block or reserve a writer for human questions in another Run", () => {
	const { store } = open();
	const a = start(store, "writer");
	const human = start(store, "human", "human");
	const { owner } = authorize(store, a);
	const decision = authorize(store, human).intent;
	expect(store.claimDispatch(owner.owner_id, owner.epoch, decision.id)?.state).toBe("submitting");
	expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch).map(item => item.run_id)).toEqual([a]);
});

it("exempts frozen text-only Runs from the profile writer reservation without weakening write-capable serialization", () => {
	const { store } = open();
	const first = startText(store, "text-first");
	const second = startText(store, "text-second");
	const later = startText(store, "text-later");
	const strong = startText(store, "strong-first", ["out/**"]);
	const blocked = startText(store, "strong-second", ["out/**"]);
	const owner = store.claimHost()!;
	store.schedule(first, owner.owner_id, owner.epoch);
	const firstIntent = store.schedule(first, owner.owner_id, owner.epoch).intent!;
	expect(store.claimDispatch(owner.owner_id, owner.epoch, firstIntent.id)?.state).toBe("submitting");
	// A second text-only Run dispatches while the first attempt is still open.
	store.schedule(second, owner.owner_id, owner.epoch);
	expect(store.schedule(second, owner.owner_id, owner.epoch).intent?.run_id).toBe(second);
	// Text-only Runs never reserve the profile writer.
	expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch)).toEqual([]);
	// A write-capable Run still takes and holds the reservation.
	store.schedule(strong, owner.owner_id, owner.epoch);
	const strongIntent = store.schedule(strong, owner.owner_id, owner.epoch).intent!;
	expect(store.claimDispatch(owner.owner_id, owner.epoch, strongIntent.id)?.state).toBe("submitting");
	expect(store.getProfileWriterAdmissions(owner.owner_id, owner.epoch).map(item => item.run_id)).toEqual([strong]);
	// Another write-capable Run waits behind it, while text-only work still proceeds.
	store.schedule(blocked, owner.owner_id, owner.epoch);
	expect(store.schedule(blocked, owner.owner_id, owner.epoch).intent).toBeNull();
	expect(store.getScheduleState(blocked)!.invocations[0].state).toBe("ready");
	store.schedule(later, owner.owner_id, owner.epoch);
	expect(store.schedule(later, owner.owner_id, owner.epoch).intent?.run_id).toBe(later);
});

it("blocks acceptance before its executor is invoked or a receipt is written", async () => {
	const { store } = open();
	const a = start(store, "coding");
	const b = start(store, "testing");
	const { owner } = authorize(store, a);
	const capture = {
		source: [{ path: "source", kind: "file" as const, mode: 0o644, content: new TextEncoder().encode("code") }],
		specification: [{ path: "spec", kind: "file" as const, mode: 0o644, content: new TextEncoder().encode("spec") }],
		upstream: [],
	};
	const freeze = store.freezeIntegration(owner.owner_id, owner.epoch, b, store.getRun(b)!.revision, capture, {
		integrator: "coder",
		sourceRevision: "rev",
		changeRiskMap: { id: "risk", digest: `sha256:${"a".repeat(64)}` },
	});
	let calls = 0;
	await expect(
		store.runIntegrationAcceptance(
			owner.owner_id,
			owner.epoch,
			b,
			freeze.revision,
			{
				tester: "tester",
				command: "check",
				scenario: "acceptance",
				environment: "fixture",
			},
			{
				sourceIsolation: true,
				isolationDescription: "fixture",
				authorize: async () => true,
				capture: async () => capture,
				run: async () => {
					calls++;
					return { success: true, observed: "passed" };
				},
			},
		),
	).rejects.toThrow("profile writer");
	expect(calls).toBe(0);
	expect(store.getRun(b)!.revision).toBe(freeze.revision);
	expect(store.getPendingIntegrationAcceptanceExecutions(owner.owner_id, owner.epoch, b)).toEqual([]);
});

it("migrates legacy terminal attempts conservatively and preserves the release across reopen", () => {
	const { store, root } = open();
	const a = start(store, "legacy");
	const { owner, intent } = authorize(store, a);
	store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	finish(store, intent);
	const db = new Database(path.join(store.definitions.root, "graphs.sqlite"));
	db.exec("DELETE FROM graph_profile_writers; DELETE FROM graph_profile_writer_migrations");
	db.close();
	store.close();
	stores.splice(stores.indexOf(store), 1);
	const migrated = open(root).store;
	const current = migrated.claimHost()!;
	const b = start(migrated, "new-work");
	migrated.schedule(b, current.owner_id, current.epoch);
	expect(migrated.schedule(b, current.owner_id, current.epoch).intent).toBeNull();
	const proof = stopped(migrated, a);
	migrated.reconcileProfileWriter(current.owner_id, current.epoch, proof);
	migrated.close();
	stores.splice(stores.indexOf(migrated), 1);
	const reopened = open(root).store;
	const next = reopened.claimHost()!;
	expect(reopened.schedule(b, next.owner_id, next.epoch).intent?.run_id).toBe(b);
	expect(reopened.reconcileProfileWriter(next.owner_id, next.epoch, proof).identity.run_id).toBe(a);
});

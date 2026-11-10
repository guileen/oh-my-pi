import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConsultationPolicy } from "../src/graph/consultation";
import { GraphRunStore, type GraphPreparedRun } from "../src/graph/store";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(communication: string, policy = "", mutateReservation = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-consultation-policy-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	cleanups.push(() => store.close());
	const content = `---
format: omp.graph/v1
name: consultation-policy
members:
  author: {role: '#role', model: model, base: isolated, duty: research, permissions: {read: [], write: [], execute: []}}
  reviewer: {role: '#role', model: model, base: isolated, duty: review, permissions: {read: [], write: [], execute: []}}
nodes:
  work: {kind: bot, member: author, task: '#task'}
${communication}
${policy}
---
## role
Work.
## task
Review when evidence is unclear.
`;
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	if (imported.error) throw new Error(imported.error.message);
	const snapshot = store.definitions.get(imported.target_id!)!;
	const ref = { id: "trusted", digest: "sha256:trusted" };
	const member = {
		provider: "provider",
		model: "model",
		configuration_revision: "1",
		base: "isolated" as const,
		base_snapshot_ref: ref,
		role_ref: ref,
		skill_refs: [],
		rule_refs: [],
	};
	const prepared: GraphPreparedRun = {
		graph_id: snapshot.graph_id,
		definition_revision: snapshot.revision,
		definition_digest: snapshot.digest,
		authorization_ref: ref,
		inputs: {},
		executors: {},
		members: { author: member, reviewer: structuredClone(member) },
	};
	const started = store.start(
		{
			version: 1,
			request_key: "start",
			operation: "start",
			target_id: snapshot.graph_id,
			if_revision: snapshot.revision,
			payload: { inputs: {}, authorization_ref: ref },
		},
		prepared,
	);
	if (started.error) throw new Error(started.error.message);
	let trustedPolicy: ConsultationPolicy | null = { max_rounds: 99, timeout_ms: 999999 };
	let reservations = 0;
	const service = store.configureConsultation({
		validate: () => true,
		policy: () => trustedPolicy,
		artifacts: () => true,
		reserve: (_db, _identity, _key, policy) => {
			reservations++;
			if (mutateReservation) {
				policy.max_rounds = 999;
				policy.timeout_ms = 999999;
			}
			return true;
		},
	});
	const identity = {
		run_id: started.target_id!,
		member_id: "author",
		invocation_id: "invocation",
		attempt_id: "attempt",
		fence: "test",
	};
	return {
		store,
		service,
		identity,
		snapshot,
		content,
		reservations: () => reservations,
		setPolicy: (value: ConsultationPolicy | null) => {
			trustedPolicy = value;
		},
	};
}

it("denies an unlisted communication before reserving resources even if the deployment policy permits it", () => {
	const f = fixture("");
	expect(f.service.ask(f.identity, { to_member: "reviewer", text: "Review", request_key: "ask" })).toEqual({
		ok: false,
		error: "permission_denied",
	});
	expect(f.reservations()).toBe(0);
	expect(f.service.list(f.identity.run_id)).toEqual([]);
});

it("keeps directed grants and per-edge limits frozen when the draft is edited", () => {
	const f = fixture(
		"communications:\n  - {from: author, to: reviewer, when: '#task', max_rounds: 2, timeout_ms: 5000}",
	);
	const edited = f.store.definitions.mutate({
		version: 1,
		request_key: "edit",
		operation: "edit",
		target_id: f.snapshot.graph_id,
		if_revision: f.snapshot.revision,
		payload: { content: f.content.replace("from: author, to: reviewer", "from: reviewer, to: author") },
	});
	expect(edited.error).toBeNull();
	const before = Date.now();
	const asked = f.service.ask(f.identity, { to_member: "reviewer", text: "Review", request_key: "ask" });
	if (!asked.ok) throw new Error(asked.error);
	const conversation = f.service.get(asked.value.conversation_id)!;
	expect(conversation.remaining_rounds).toBe(2);
	expect(conversation.deadline).toBeGreaterThanOrEqual(before + 5000);
	expect(conversation.deadline).toBeLessThanOrEqual(Date.now() + 5000);
	expect(
		f.service.ask(
			{ ...f.identity, member_id: "reviewer" },
			{
				to_member: "author",
				text: "New request",
				request_key: "reverse",
			},
		),
	).toEqual({ ok: false, error: "permission_denied" });
});

it("uses run policy for omitted edge limits and permits deployment policy to tighten or revoke access", () => {
	const f = fixture(
		"communications:\n  - {from: author, to: reviewer, when: '#task'}",
		"policy: {max_consultation_rounds: 3, consultation_timeout_ms: 7000}",
	);
	const asked = f.service.ask(f.identity, { to_member: "reviewer", text: "Review", request_key: "ask" });
	if (!asked.ok) throw new Error(asked.error);
	expect(f.service.get(asked.value.conversation_id)!.remaining_rounds).toBe(3);
	f.setPolicy(null);
	expect(f.service.ask(f.identity, { to_member: "reviewer", text: "Review", request_key: "ask" })).toEqual({
		ok: false,
		error: "permission_denied",
	});
	f.setPolicy({ max_rounds: 1, timeout_ms: 1000 });
	const tightened = f.service.ask(f.identity, { to_member: "reviewer", text: "Narrow review", request_key: "tight" });
	if (!tightened.ok) throw new Error(tightened.error);
	expect(f.service.get(tightened.value.conversation_id)!.remaining_rounds).toBe(1);
	expect(f.reservations()).toBe(2);
});

it("intersects repeated directed grants instead of letting a broader declaration override a narrow one", () => {
	const f = fixture(`communications:
  - {from: author, to: reviewer, when: '#task', max_rounds: 1, timeout_ms: 9000}
  - {from: author, to: reviewer, when: '#task', max_rounds: 8, timeout_ms: 2000}`);
	const before = Date.now();
	const asked = f.service.ask(f.identity, { to_member: "reviewer", text: "Review", request_key: "ask" });
	if (!asked.ok) throw new Error(asked.error);
	const conversation = f.service.get(asked.value.conversation_id)!;
	expect(conversation.remaining_rounds).toBe(1);
	expect(conversation.deadline).toBeGreaterThanOrEqual(before + 2000);
	expect(conversation.deadline).toBeLessThanOrEqual(Date.now() + 2000);
});

it("does not let resource reservation rewrite the frozen consultation limits", () => {
	const f = fixture(
		"communications:\n  - {from: author, to: reviewer, when: '#task', max_rounds: 2, timeout_ms: 5000}",
		"",
		true,
	);
	const asked = f.service.ask(f.identity, { to_member: "reviewer", text: "Review", request_key: "ask" });
	if (!asked.ok) throw new Error(asked.error);
	const conversation = f.service.get(asked.value.conversation_id)!;
	expect(conversation.remaining_rounds).toBe(2);
	expect(conversation.deadline).toBeLessThanOrEqual(Date.now() + 5000);
});

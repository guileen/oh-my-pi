import { expect, it } from "bun:test";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import {
	screenwritingApprovalQuestionRef,
	type ScreenwritingApprovalProposal,
} from "../src/graph/screenwriting-approval";
import { GraphRunStore } from "../src/graph/store";

async function fixture(unbound = false, task = false, bindTask = true) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-screenwriting-store-"));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	try {
		store.configureHuman((_action, principal) => principal === "alice");
		store.configureLifecycle({ authorize: principal => principal === "alice", verifyResume: () => false });
		const artifacts = store.configureArtifacts({
			maxBytes: 4096,
			authorize: async principal => principal === "alice",
		});
		const publish = async (content: string): Promise<GraphRef> => {
			const expected = {
				media_type: "text/plain",
				producer_attempt_id: "source",
				source_ref: null,
				access_scope: ["alice"],
			};
			const artifact = await artifacts.store.publish("alice", Buffer.from(content), expected);
			await artifacts.register([{ artifact, expected }]);
			return { id: artifact.id, digest: artifact.digest };
		};
		const subject = await publish("A old Z");
		const scope = await publish('{"version":1,"ranges":[{"start":2,"end":5,"max_replacement_bytes":8}]}');
		const inputs = { subject, scope };
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content: `---
format: omp.graph/v1
name: screenwriting
members: {}
nodes:
  approval:
    kind: human
    task: '#approve'
    inputs: {subject: {run_input: subject}, scope: {run_input: scope}}
    required_inputs: [subject, scope]
    outcomes: [approve, hold]
    verdicts: [APPROVE, HOLD]
    decisions: [{verdict: APPROVE, outcome: approve}, {verdict: HOLD, outcome: hold}]
    terminal: {hold: hold}
  next: ${
		task
			? `
    kind: program
    executor: revise
    task: '#next'
    inputs: {${bindTask ? "subject: {run_input: subject}, " : ""}scope: {run_input: scope}}
    required_inputs: [${bindTask ? "subject, " : ""}scope]
    outcomes: [done]
    outputs: {result: {media_type: text/plain, required: true}}`
			: "{kind: human, task: '#next'}"
  }
edges:
  - {id: approved, from: approval, to: next, on: [approve]}
---
## approve
Approve the exact revision scope.
## next
Continue after bounded publication.
`,
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "fixture-authority", digest: "fixture-authority" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs, authorization_ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref,
				inputs,
				members: {},
				executors: task ? { revise: authorization_ref } : {},
			},
		);
		if (started.state !== "accepted") throw new Error(started.error?.message ?? "Run was not accepted");
		const runId = started.target_id!;
		const owner = store.claimHost()!;
		store.schedule(runId, owner.owner_id, owner.epoch);
		store.schedule(runId, owner.owner_id, owner.epoch);
		const invocation = store.getScheduleState(runId)!.invocations.find(item => item.node === "approval")!;
		const proposal: ScreenwritingApprovalProposal = {
			decision_id: `human:${invocation.id}`,
			run_id: runId,
			invocation_id: invocation.id,
			input_digest: `sha256:${Bun.SHA256.hash(canonicalJson(invocation.ready!.inputs), "hex")}`,
			source_revision: definition.digest,
			subject: unbound ? await publish("B old Y") : subject,
			change_scope: scope,
			principal: "alice",
			author_ref: { id: "alice", digest: "author-alice" },
		};
		store.createHumanQuestion(
			owner.owner_id,
			owner.epoch,
			"alice",
			runId,
			invocation.id,
			screenwritingApprovalQuestionRef(proposal),
		);
		const result = store.answerHuman({
			request_key: "answer",
			principal: "alice",
			run_id: runId,
			invocation_id: invocation.id,
			decision_id: proposal.decision_id,
			input_digest: proposal.input_digest,
			if_revision: store.getRun(runId)!.revision,
			outcome: "approve",
			verdict: "APPROVE",
			content_ref: subject,
			evidence_refs: [],
			reason: "Approve these byte ranges",
			author_ref: proposal.author_ref,
		});
		if (result.state !== "completed") throw new Error(result.error?.message ?? "Answer failed");
		const evidence_ref = store.getHumanQuestion("alice", proposal.decision_id)!.evidence_ref!;
		if (task) {
			for (let step = 0; step < 8; step++) {
				const scheduled = store.schedule(runId, owner.owner_id, owner.epoch);
				if (scheduled.intent) {
					if (!store.claimDispatch(owner.owner_id, owner.epoch, scheduled.intent.id))
						throw new Error("Task dispatch was not claimed");
					break;
				}
			}
		}
		const publications = store.configureScreenwritingPublications();
		const issue = () =>
			store.issueScreenwritingPublication(owner.owner_id, owner.epoch, {
				request_key: "issue",
				proposal,
				evidence_ref,
				run_revision: store.getRun(runId)!.revision,
				media_type: "text/plain",
				access_scope: ["alice"],
			});
		return {
			store,
			artifacts,
			publications,
			issue,
			runId,
			owner,
			root,
			async close() {
				store.close();
				await fs.rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		store.close();
		await fs.rm(root, { recursive: true, force: true });
		throw error;
	}
}

it("publishes only approved bounded bytes through the live Store and replays the same result", async () => {
	const f = await fixture();
	try {
		const authority_ref = f.issue();
		const request = {
			request_key: "publish",
			authority_ref,
			patches: [{ range: 0, replacement: Buffer.from("new") }],
		};
		const ref = f.publications.commit(await f.publications.prepare("alice", request));
		expect(new TextDecoder().decode(await f.artifacts.store.read("alice", ref))).toBe("A new Z");
		expect(f.publications.commit(await f.publications.prepare("alice", request))).toEqual(ref);
		expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "next")!.state).toBe("pending");
	} finally {
		await f.close();
	}
});

it("rejects publication after the live Run is held between preparation and commit", async () => {
	const f = await fixture();
	try {
		const authority_ref = f.issue();
		const prepared = await f.publications.prepare("alice", {
			request_key: "publish",
			authority_ref,
			patches: [{ range: 0, replacement: Buffer.from("new") }],
		});
		expect(
			f.store.mutateLifecycle("alice", {
				version: 1,
				request_key: "hold",
				operation: "hold",
				target_id: f.runId,
				if_revision: f.store.getRun(f.runId)!.revision,
				payload: { reason: "Withdraw publication" },
			}).state,
		).toBe("completed");
		expect(() => f.publications.commit(prepared)).toThrow("not currently applicable");
	} finally {
		await f.close();
	}
});

it("does not turn an approved but unbound subject into a live revision authority", async () => {
	const f = await fixture(true);
	try {
		expect(f.issue).toThrow("does not match the approved inputs");
	} finally {
		await f.close();
	}
});

it("atomically settles one approved revision task and reconciles without another completion", async () => {
	const f = await fixture(false, true);
	try {
		const authority_ref = f.issue();
		const prepared = await f.publications.prepare("alice", {
			request_key: "publish-task",
			authority_ref,
			patches: [{ range: 0, replacement: Buffer.from("new") }],
		});
		const intent = f.store.getDispatchIntents(f.runId).find(item => item.state === "submitting")!;
		const target = {
			run_id: f.runId,
			invocation_id: intent.invocation_id,
			attempt_id: intent.attempt_id,
			fence: intent.fence,
			output: "result",
			outcome: "done",
		};
		const apply = (value = target) =>
			f.store.completeScreenwritingPublication(f.owner.owner_id, f.owner.epoch, prepared, value);
		// A failed task transition must roll back registration and authority consumption too.
		expect(() => apply({ ...target, fence: "stale" })).toThrow("not current");
		expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "next")!.state).toBe("running");
		const ref = apply();
		expect(new TextDecoder().decode(await f.artifacts.store.read("alice", ref))).toBe("A new Z");
		expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "next")).toMatchObject({
			state: "succeeded",
			outputs: { result: ref },
		});
		const revision = f.store.getRun(f.runId)!.revision;
		expect(apply()).toEqual(ref);
		expect(f.store.getRun(f.runId)!.revision).toBe(revision);
		expect(() => apply({ ...target, attempt_id: "another-attempt" })).toThrow("different task completion");
	} finally {
		await f.close();
	}
});

it("does not attach an independently committed publication to a task", async () => {
	const f = await fixture(false, true);
	try {
		const prepared = await f.publications.prepare("alice", {
			request_key: "standalone",
			authority_ref: f.issue(),
			patches: [{ range: 0, replacement: Buffer.from("new") }],
		});
		const ref = f.publications.commit(prepared);
		const intent = f.store.getDispatchIntents(f.runId).find(item => item.state === "submitting")!;
		expect(() =>
			f.store.completeScreenwritingPublication(f.owner.owner_id, f.owner.epoch, prepared, {
				run_id: f.runId,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				output: "result",
				outcome: "done",
			}),
		).toThrow("Standalone publication cannot settle a task");
		expect(new TextDecoder().decode(await f.artifacts.store.read("alice", ref))).toBe("A new Z");
		expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "next")!.state).toBe("running");
	} finally {
		await f.close();
	}
});

it("refuses task publication when the approved subject is not a pinned task input", async () => {
	const f = await fixture(false, true, false);
	try {
		const prepared = await f.publications.prepare("alice", {
			request_key: "unbound-task",
			authority_ref: f.issue(),
			patches: [{ range: 0, replacement: Buffer.from("new") }],
		});
		const intent = f.store.getDispatchIntents(f.runId).find(item => item.state === "submitting")!;
		expect(() =>
			f.store.completeScreenwritingPublication(f.owner.owner_id, f.owner.epoch, prepared, {
				run_id: f.runId,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				output: "result",
				outcome: "done",
			}),
		).toThrow("not bound to this approved revision");
		// Rejection must not consume authority or leave a task-completion receipt.
		const ref = f.publications.commit(prepared);
		expect(new TextDecoder().decode(await f.artifacts.store.read("alice", ref))).toBe("A new Z");
		expect(f.store.getScheduleState(f.runId)!.invocations.find(item => item.node === "next")!.state).toBe("running");
	} finally {
		await f.close();
	}
});

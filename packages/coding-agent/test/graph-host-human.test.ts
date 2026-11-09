import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGraphCommand, type GraphAnswerAdmission } from "../src/graph/cli";
import { GraphHost } from "../src/graph/host";
import { GraphRunStore } from "../src/graph/store";

it("holds a human question without invoking a program, then advances after an authorized answer", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-human-host-"));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	try {
		store.configureHuman((_action, principal) => principal === "alice");
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content: `---
format: omp.graph/v1
name: human
members: {}
nodes:
  approval: {kind: human, task: '#question'}
---
## question
Approve?
`,
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const auth = { id: "authorization", digest: "sha256:authorization" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref: auth },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref: auth,
				inputs: {},
				members: {},
				executors: {},
			},
		);
		let submitted = false;
		const host = new GraphHost({
			store,
			program: {
				accept: async () => {
					submitted = true;
					throw new Error("unexpected program");
				},
				query: () => null,
				cancel: () => "unknown",
			},
			resolveHuman: async () => ({ principal: "alice", questionRef: { id: "question", digest: "sha256:question" } }),
			resolveProgram: async () => {
				throw new Error("unexpected program");
			},
			verifyProgramResult: async () => {
				throw new Error("unexpected program");
			},
		});
		expect(host.start()).toBe(true);
		await host.tick();
		await host.tick();
		const runId = started.target_id!;
		const invocation = store.getScheduleState(runId)!.invocations[0];
		expect(invocation.state).toBe("waiting");
		expect(submitted).toBe(false);
		const decision = store.getHumanQuestion("alice", `human:${invocation.id}`)!;
		let reads = 0;
		let output = "";
		const admission: GraphAnswerAdmission = {
			principal: "alice",
			authorizeTarget: (_principal, target) => {
				target.run_id = "redirected";
				target.decision_id = "redirected";
				target.request_key = "redirected";
				return true;
			},
			publishAnswer: async (_principal, input) => ({
				id: "answer",
				digest: `sha256:${Bun.SHA256.hash(input.content, "hex")}`,
			}),
			authorRef: async () => ({ id: "alice", digest: "sha256:alice" }),
			authorize: (_action, principal) => principal === "alice",
		};
		const args = [
			"answer",
			runId,
			"--decision",
			decision.id,
			"--file",
			"-",
			"--if-revision",
			store.getRun(runId)!.revision,
			"--request-key",
			"answer",
		];
		const options = {
			root,
			answer: admission,
			readInput: () => {
				reads++;
				return `---\noutcome: done\ninput_digest: ${decision.input_digest}\n---\napproved`;
			},
			out: (text: string) => {
				output += text;
			},
			err: (text: string) => {
				output += text;
			},
		};
		expect(await runGraphCommand(args, { ...options, answer: { ...admission, authorizeTarget: () => false } })).toBe(
			3,
		);
		expect(reads).toBe(0);
		expect(
			await runGraphCommand(args, {
				...options,
				answer: { ...admission, authorizeTarget: () => "allow" as unknown as boolean },
			}),
		).toBe(3);
		expect(reads).toBe(0);
		const staleArgs = [...args.slice(0, -1), "stale-answer"];
		expect(
			await runGraphCommand(staleArgs, {
				...options,
				readInput: () => "---\noutcome: done\ninput_digest: sha256:stale\n---\napproved",
			}),
		).toBe(2);
		expect(output).toContain("input_stale");
		expect(await runGraphCommand(args, options)).toBe(0);
		expect(await runGraphCommand(args, options)).toBe(0);
		expect(
			await runGraphCommand(args, {
				...options,
				readInput: () => `---\noutcome: done\ninput_digest: ${decision.input_digest}\n---\nchanged`,
			}),
		).toBe(2);
		expect(output).toContain("idempotency_conflict");
		expect(output).toContain("State: completed");
		await host.tick();
		expect(store.getRun(runId)?.state).toBe("succeeded");
	} finally {
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("forwards only the exact authorized human input artifact, not the answer content", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-human-binding-"));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	try {
		store.configureHuman((_action, principal) => principal === "alice");
		const registry = store.configureArtifacts({
			maxBytes: 1024,
			authorize: async principal => principal === "alice",
		});
		const publication = {
			media_type: "text/plain",
			producer_attempt_id: "source",
			source_ref: null,
			access_scope: ["alice"],
		};
		const artifact = await registry.store.publish("alice", Buffer.from("approved plan"), publication);
		await registry.register([{ artifact, expected: publication }]);
		const plan = { id: artifact.id, digest: artifact.digest };
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import-binding",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content: `---
format: omp.graph/v1
name: binding
members: {}
nodes:
  approval:
    kind: human
    task: '#question'
    inputs: {plan: {run_input: plan}}
    required_inputs: [plan]
    outputs: {approved: {media_type: text/plain, required: false}}
    approved_outputs: {approved: {input: plan, on: [done]}}
    outcomes: [done, hold]
    terminal: {hold: hold}
  next:
    kind: human
    task: '#question'
    required_inputs: [plan]
edges:
  - {id: handoff, from: approval, to: next, on: [done], bind: {plan: approved}}
---
## question
Approve?
`,
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const auth = { id: "authorization", digest: "sha256:authorization" };
		const started = store.start(
			{
				version: 1,
				request_key: "start-binding",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: { plan }, authorization_ref: auth },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref: auth,
				inputs: { plan },
				members: {},
				executors: {},
			},
		);
		const host = new GraphHost({
			store,
			program: {
				accept: async () => {
					throw new Error("unexpected program");
				},
				query: () => null,
				cancel: () => "unknown",
			},
			resolveProgram: async () => {
				throw new Error("unexpected program");
			},
			verifyProgramResult: async () => {
				throw new Error("unexpected program");
			},
			resolveHuman: async () => ({ principal: "alice", questionRef: { id: "question", digest: "sha256:question" } }),
		});
		expect(host.start()).toBe(true);
		await host.tick();
		await host.tick();
		const runId = started.target_id!;
		const invocation = store.getScheduleState(runId)!.invocations.find(item => item.node === "approval")!;
		const decision = store.getHumanQuestion("alice", `human:${invocation.id}`)!;
		const answer = {
			request_key: "answer-binding",
			principal: "alice",
			run_id: runId,
			invocation_id: invocation.id,
			decision_id: decision.id,
			input_digest: decision.input_digest,
			if_revision: store.getRun(runId)!.revision,
			outcome: "done",
			verdict: "done",
			content_ref: { id: "answer", digest: "sha256:answer" },
			evidence_refs: [],
			reason: "approved",
			author_ref: { id: "alice", digest: "sha256:alice" },
		};
		expect(store.answerHuman({ ...answer, principal: "mallory" }).error?.code).toBe("permission_denied");
		expect(
			store.answerHuman({ ...answer, request_key: "stale-binding", input_digest: "sha256:stale" }).error?.code,
		).toBe("input_stale");
		expect(store.getHumanQuestion("alice", decision.id)?.answer).toBeNull();
		expect(store.answerHuman(answer).state).toBe("completed");
		expect(store.answerHuman(answer).state).toBe("completed");
		expect(store.getScheduleState(runId)!.invocations.find(item => item.id === invocation.id)?.outputs).toEqual({
			approved: plan,
		});
		await host.tick();
		await host.tick();
		const next = store.getScheduleState(runId)!.invocations.find(item => item.node === "next")!;
		expect(next.ready?.inputs.plan).toEqual(plan);
		const second = store.start(
			{
				version: 1,
				request_key: "start-unavailable",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: { plan }, authorization_ref: auth },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref: auth,
				inputs: { plan },
				members: {},
				executors: {},
			},
		);
		await host.tick();
		await host.tick();
		const secondRun = second.target_id!;
		const secondInvocation = store.getScheduleState(secondRun)!.invocations.find(item => item.node === "approval")!;
		const secondDecision = store.getHumanQuestion("alice", `human:${secondInvocation.id}`)!;
		registry.markUnavailable(plan, "missing");
		const refused = store.answerHuman({
			...answer,
			request_key: "answer-unavailable",
			run_id: secondRun,
			invocation_id: secondInvocation.id,
			decision_id: secondDecision.id,
			input_digest: secondDecision.input_digest,
			if_revision: store.getRun(secondRun)!.revision,
		});
		expect(refused.state).toBe("rejected");
		expect(store.getHumanQuestion("alice", secondDecision.id)?.answer).toBeNull();
		expect(store.getScheduleState(secondRun)!.invocations.find(item => item.id === secondInvocation.id)?.state).toBe(
			"waiting",
		);
		expect(
			store.answerHuman({
				...answer,
				request_key: "answer-hold",
				run_id: secondRun,
				invocation_id: secondInvocation.id,
				decision_id: secondDecision.id,
				input_digest: secondDecision.input_digest,
				if_revision: store.getRun(secondRun)!.revision,
				outcome: "hold",
				verdict: "hold",
			}).state,
		).toBe("completed");
		expect(
			store.getScheduleState(secondRun)!.invocations.find(item => item.id === secondInvocation.id)?.outputs,
		).toEqual({});
		await host.tick();
		expect(store.getScheduleState(secondRun)!.invocations.find(item => item.node === "next")?.state).not.toBe(
			"running",
		);
	} finally {
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

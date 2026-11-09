import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GraphArtifactRegistry } from "../src/graph/artifacts";
import { TrustedProgramExecutor, type ProgramExecutionRequest } from "../src/graph/executors/program";
import { GraphHost } from "../src/graph/host";
import { GraphRunStore, type GraphAttemptCompletion } from "../src/graph/store";

it.each([
	"valid",
	"verifier-failure",
	"preparer-output",
	"retained-completion",
	"verifier-intent",
	"resolver-intent",
	"node-timeout",
	"node-timeout-omitted",
	"resolver-timeout",
] as const)("preserves the program result boundary: %s", async scenario => {
	const nodeTimed = scenario === "node-timeout" || scenario === "node-timeout-omitted";
	const timed = nodeTimed || scenario === "resolver-timeout";
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-host-program-"));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	try {
		const registry = store.configureArtifacts({
			maxBytes: 4096,
			authorize: async (principal, _action, scope) => scope.includes(principal),
		});
		const artifactStore = registry.store;
		const program = new TrustedProgramExecutor(
			{
				writer: {
					executable: process.execPath,
					workspaceRoot: root,
					env: {},
					argv: [
						{ literal: "-e" },
						{
							literal:
								scenario === "verifier-failure"
									? "process.exit(7)"
									: `${timed ? "await Bun.sleep(500);" : ""}require('node:fs').writeFileSync('result.txt','host output')`,
						},
					],
					outputs: { result: { filename: "result.txt", media_type: "text/plain" } },
					outcome: "done",
					timeoutMs: 10000,
				},
			},
			{ store: artifactStore, authorize: async request => request.principal === "alice" },
		);
		const content = `---
format: omp.graph/v1
name: program-smoke
members: {}
nodes:
  write:
    kind: program
    task: '#write'
    executor: writer
${timed ? `    timeout_ms: ${nodeTimed ? 50 : 1000}\n` : ""}    outputs: {result: {media_type: text/plain, required: ${scenario !== "verifier-failure"}}}
---
## write
Write a result.
`;
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const auth = { id: "grant", digest: "sha256:grant" };
		const prepared = {
			graph_id: definition.graph_id,
			definition_revision: definition.revision,
			definition_digest: definition.digest,
			authorization_ref: auth,
			inputs: {},
			members: {},
			executors: { writer: program.registrationRef("writer")! },
		};
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref: auth },
			},
			prepared,
		);
		expect(started.state).toBe("accepted");
		let retained: GraphAttemptCompletion | undefined;
		const host = new GraphHost({
			store,
			program,
			resolveProgram: async intent => {
				const request: ProgramExecutionRequest = {
					version: 1,
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
					request_key: intent.request_key,
					executor: "writer",
					inputs: {},
					task_ref: auth,
					authorization_ref: auth,
					model_binding_ref: null,
					base_snapshot_ref: null,
					duty: "general",
					deadline: null,
					parameters: {},
					outputs: { result: { media_type: "text/plain", required: scenario !== "verifier-failure" } },
					principal: "alice",
					output_scope: ["alice"],
					...(timed && scenario !== "node-timeout-omitted" ? { timeout_ms: nodeTimed ? 1000 : 50 } : {}),
				};
				if (scenario === "resolver-intent") intent.attempt_id = "not-the-authorized-attempt";
				return request;
			},
			verifyProgramResult: async (intent, result) => {
				const identity = {
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
				};
				if (scenario === "verifier-failure") {
					result.state = "succeeded";
					result.outcome = "done";
				}
				if (scenario === "verifier-intent") intent.attempt_id = "not-the-executed-attempt";
				retained = {
					...identity,
					state: result.state === "succeeded" ? "succeeded" : "failed",
					outcome: result.outcome,
					outputs: result.outputs,
				};
				return retained;
			},
			prepareProgramArtifacts: async (intent, result) => {
				if (scenario === "retained-completion") retained!.state = "failed";
				if (scenario === "preparer-output") {
					result.outputs.result = await artifactStore.publish("alice", Buffer.from("substituted output"), {
						media_type: "text/plain",
						producer_attempt_id: intent.attempt_id,
						source_ref: null,
						access_scope: ["alice"],
					});
				}
				return registry.prepareRegistration(
					Object.values(result.outputs).map(artifact => ({
						artifact,
						expected: {
							media_type: "text/plain",
							producer_attempt_id: intent.attempt_id,
							source_ref: null,
							access_scope: ["alice"],
						},
					})),
				);
			},
		});
		expect(host.start()).toBe(true);
		await host.tick();
		await host.tick();
		const observation = store.getDispatchIntents(started.target_id!)[0].observation as { execution_ref: string };
		await program.wait(observation.execution_ref);
		const executed = program.query(observation.execution_ref)!;
		await host.tick();
		if (timed) {
			expect(executed).toMatchObject({ state: "failed", error: "Program timed out", outputs: {} });
			expect(store.getRun(started.target_id!)?.state).toBe("failed");
			return;
		}
		if (scenario === "verifier-failure" || scenario === "preparer-output") {
			expect(store.getRun(started.target_id!)?.state).toBe("held");
			expect(store.getAttemptHistory(started.target_id!).some(item => item.accepted)).toBe(false);
			expect(store.getScheduleState(started.target_id!)!.invocations[0].outputs).toBeUndefined();
			expect(store.getDispatchIntents(started.target_id!)[0]).toMatchObject({
				state: "unknown",
				observation: { result: { state: executed.state, outputs: executed.outputs } },
			});
			return;
		}
		expect(store.getRun(started.target_id!)?.state).toBe("succeeded");
		const output = store.getScheduleState(started.target_id!)!.invocations[0].outputs!.result;
		expect(Buffer.from(await artifactStore.read("alice", output)).toString()).toBe("host output");
		const reopened = new GraphArtifactRegistry({
			root,
			maxBytes: 4096,
			authorize: async (principal, _action, scope) => scope.includes(principal),
		});
		try {
			expect(Buffer.from(await reopened.store.read("alice", output)).toString()).toBe("host output");
		} finally {
			reopened.close();
		}
		expect(store.getAttemptHistory(started.target_id!).filter(item => item.accepted)).toHaveLength(1);
		expect(output).toEqual({ id: executed.outputs.result.id, digest: executed.outputs.result.digest });
	} finally {
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

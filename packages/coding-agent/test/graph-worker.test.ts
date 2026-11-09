import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS } from "../src/graph/cli";
import { GraphRunStore } from "../src/graph/store";
import { runGraphWorker } from "../src/graph/worker";

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-worker-"));
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: {
			content:
				"---\nformat: omp.graph/v1\nname: worker\nmembers: {}\nnodes:\n  work: {kind: program, task: '#work', executor: example}\n---\n## work\nWork.\n",
		},
	});
	const definition = store.definitions.get(imported.target_id!)!;
	const auth = { id: "grant", digest: "sha256:grant" };
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
			executors: { example: { id: "example", digest: "sha256:example" } },
		},
	);
	store.close();
	return { root, run: started.target_id!, auth };
}

it("pumps a trusted host until its verified result is persisted", async () => {
	const f = await fixture();
	const abort = new AbortController();
	let submitted = 0;
	let identity: { attempt_id: string; fence: string } | undefined;
	try {
		await runGraphWorker({
			root: f.root,
			signal: abort.signal,
			intervalMs: 1,
			createHostOptions: () => ({
				program: {
					verifyRegistration: (name, ref) =>
						name === "example" && ref.id === "example" && ref.digest === "sha256:example",
					accept: async request => {
						submitted++;
						identity = { attempt_id: request.attempt_id, fence: request.fence };
						return { state: "accepted", execution_ref: "execution", error: null };
					},
					query: () =>
						identity
							? {
									...identity,
									state: "succeeded",
									outcome: "done",
									verdict: null,
									outputs: {},
									error: null,
									usage: { tokens: null, cost: null, currency: null },
								}
							: null,
					cancel: () => "unknown",
				},
				resolveProgram: async intent => ({
					version: 1,
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
					request_key: intent.request_key,
					executor: "example",
					inputs: {},
					task_ref: f.auth,
					authorization_ref: f.auth,
					model_binding_ref: null,
					base_snapshot_ref: null,
					duty: "general",
					deadline: null,
					parameters: {},
					outputs: {},
					principal: "alice",
					output_scope: [],
				}),
				verifyProgramResult: async (intent, result) => {
					abort.abort();
					return {
						run_id: intent.run_id,
						invocation_id: intent.invocation_id,
						attempt_id: intent.attempt_id,
						fence: intent.fence,
						state: "succeeded",
						outcome: result.outcome,
					};
				},
			}),
		});
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		try {
			expect(submitted).toBe(1);
			expect(store.getRun(f.run)?.state).toBe("succeeded");
		} finally {
			store.close();
		}
	} finally {
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

it("rejects an unconfigured worker without claiming ownership or scheduling work", async () => {
	const f = await fixture();
	try {
		await expect(
			runGraphWorker({ root: f.root, signal: new AbortController().signal, intervalMs: 1 }),
		).rejects.toThrow("Graph worker requires trusted host configuration");
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		try {
			expect(store.getDispatchIntents(f.run)).toEqual([]);
			expect(store.claimHost()).not.toBeNull();
		} finally {
			store.close();
		}
	} finally {
		await fs.rm(f.root, { recursive: true, force: true });
	}
});

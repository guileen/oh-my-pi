import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS, runGraphCommand, type GraphStartAdmission } from "../src/graph/cli";
import { GraphRunStore } from "../src/graph/store";

it("starts from authorized imported results and rejects missing provenance", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-cli-import-"));
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	try {
		const content = `---
format: omp.graph/v1
name: imports
members: {}
nodes:
  research:
    kind: program
    executor: research
    task: '#task'
    outputs: {report: {media_type: text/plain, required: true}}
  review:
    kind: human
    task: '#task'
    required_gate: true
    required_inputs: [report]
edges:
  - {id: handoff, from: research, to: review, bind: {report: report}}
---
## task
Work.
`;
		const created = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const graph = store.definitions.get(created.target_id!)!;
		const auth = { id: "auth", digest: "sha256:auth" };
		let prove = false;
		const admission: GraphStartAdmission = {
			principal: "alice",
			authorizeTarget: () => true,
			authorizeRequest: () => true,
			publishInput: async () => {
				throw new Error("unexpected input");
			},
			resolveAuthorization: async () => auth,
			preflight: async (_principal, request, snapshot) => {
				const provided = request.payload.provided_outputs!;
				return {
					graph_id: snapshot.graph_id,
					definition_revision: snapshot.revision,
					definition_digest: snapshot.digest,
					authorization_ref: auth,
					inputs: {},
					members: {},
					executors: { research: { id: "executor", digest: "sha256:executor" } },
					...(prove
						? {
								imports: {
									research: {
										outputs: provided.research,
										source_ref: { id: "source", digest: "sha256:source" },
										definition_digest: snapshot.digest,
										authorization_ref: auth,
										run_inputs: {},
										provided_outputs: provided,
									},
								},
							}
						: {}),
				};
			},
		};
		const manifest = "---\noutputs:\n  research:\n    report: {id: report, digest: 'sha256:report'}\n---\n";
		let output = "";
		const run = (key: string) =>
			runGraphCommand(
				[
					"start",
					graph.graph_id,
					"--from",
					"review",
					"--provided",
					"-",
					"--if-revision",
					graph.revision,
					"--request-key",
					key,
				],
				{
					root,
					start: admission,
					readInput: () => manifest,
					out: text => {
						output += text;
					},
					err: text => {
						output += text;
					},
				},
			);
		expect(await run("unproven")).toBe(3);
		expect(output).toContain("gate_unsatisfied");
		prove = true;
		output = "";
		expect(await run("proven")).toBe(0);
		const runId = /Run: ([^\n]+)/.exec(output)?.[1];
		expect(runId).toBeDefined();
		const invocations = store.getScheduleState(runId!)!.invocations;
		expect(invocations.find(item => item.node === "research")).toMatchObject({
			origin: "imported",
			state: "succeeded",
			outputs: { report: { id: "report", digest: "sha256:report" } },
		});
	} finally {
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

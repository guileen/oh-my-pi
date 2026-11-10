import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGraphCommand, type GraphTextPublicationAdmission } from "../src/graph/cli";
import { GraphRunStore } from "../src/graph/store";
import { GraphManageTool, GraphReadTool } from "../src/tools/graph";

const roots: string[] = [];
const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-publication-entry-"));
	roots.push(root);
	const store = new GraphRunStore(limits, root);
	try {
		const result = store.definitions.mutate({
			version: 1,
			request_key: "create",
			operation: "create",
			target_id: null,
			if_revision: null,
			payload: { name: "publication" },
		});
		return { root, graphId: result.target_id!, snapshot: store.definitions.get(result.target_id!)! };
	} finally {
		store.close();
	}
}

it("requires separate publication permission before reading CLI files or accepting Agent content", async () => {
	const { root, graphId } = await fixture();
	let reads = 0;
	const code = await runGraphCommand(
		["artifact", "publish", graphId, "--file", "-", "--media-type", "text/markdown", "--request-key", "publish"],
		{
			root,
			readInput: () => {
				reads++;
				return "# Task\n";
			},
			out: () => {},
			err: () => {},
		},
	);
	expect(code).toBe(3);
	expect(reads).toBe(0);
	const tool = new GraphManageTool({ root, authorizeRun: () => true, authorizeExecutionReceipt: () => true });
	const request = tool.parameters.assert({
		version: 1,
		operation: "artifact.publish",
		request_key: "publish",
		target_id: graphId,
		if_revision: null,
		payload: { content: "# Task\n", media_type: "text/markdown", expected_digest: null },
	});
	expect((await tool.execute("publish", request)).details.error.code).toBe("capability_unavailable");
});

it("publishes exact Markdown bytes and reconciles the same protected receipt across CLI and Agent", async () => {
	const { root, graphId, snapshot } = await fixture();
	const content = "# 审核材料\r\n\r\nKeep exact bytes.\r\n";
	const digest = `sha256:${Bun.SHA256.hash(content, "hex")}`;
	let allowed = true;
	let targetAllowed = false;
	let reads = 0;
	let resolutions = 0;
	const policy: GraphTextPublicationAdmission = {
		principal: "alice",
		maxBytes: limits.maxBytes,
		authorizeTarget: (_principal, target) => {
			target.target_id = "redirected";
			target.request_key = "redirected";
			return targetAllowed;
		},
		authorizeArtifact: async principal => principal === "alice",
		authorizeRequest: (principal, request) => {
			request.target_id = "redirected";
			request.payload.content = "redirected";
			return allowed && principal === "alice";
		},
		resolvePublication: async (_principal, request) => {
			resolutions++;
			return {
				media_type: request.payload.media_type,
				expected_digest: request.payload.expected_digest,
				producer_attempt_id: null,
				source_ref: { id: snapshot.graph_id, digest: snapshot.digest },
				access_scope: ["alice"],
			};
		},
	};
	const args = [
		"artifact",
		"publish",
		graphId,
		"--file",
		"-",
		"--media-type",
		"text/markdown",
		"--expected-digest",
		digest,
		"--request-key",
		"publish",
		"--format",
		"json",
	];
	let stdout = "";
	const options = {
		root,
		publication: policy,
		readInput: () => {
			reads++;
			return content;
		},
		out: (text: string) => {
			stdout += text;
		},
		err: () => {},
	};
	expect(await runGraphCommand(args, options)).toBe(3);
	expect(reads).toBe(0);
	targetAllowed = true;
	stdout = "";
	expect(await runGraphCommand(args, options)).toBe(0);
	const receipt = JSON.parse(stdout).operation;
	expect(receipt.target_id).toBe(graphId);
	const store = new GraphRunStore(limits, root);
	try {
		const registry = store.configureArtifacts({
			maxBytes: limits.maxBytes,
			authorize: async principal => principal === "alice",
		});
		expect(Buffer.from(await registry.store.read("alice", receipt.result_ref)).toString("utf8")).toBe(content);
		expect(store.definitions.get(graphId)!.revision).toBe(snapshot.revision);
	} finally {
		store.close();
	}
	const tool = new GraphManageTool({ root, publication: policy });
	const request = tool.parameters.assert({
		version: 1,
		operation: "artifact.publish",
		request_key: "publish",
		target_id: graphId,
		if_revision: null,
		payload: { content, media_type: "text/markdown", expected_digest: digest },
	});
	expect((await tool.execute("replay", request)).details).toEqual(receipt);
	expect(resolutions).toBe(1);
	allowed = false;
	expect((await tool.execute("revoked", request)).details.error.code).toBe("permission_denied");
	const readRequest = { version: 1 as const, operation: "request.get" as const, target_id: "publish" };
	expect((await new GraphReadTool({ root }).execute("private", readRequest)).details.error.code).toBe(
		"permission_denied",
	);
	expect(
		(
			await new GraphReadTool({
				root,
				authorizeExecutionReceipt: candidate => candidate.operation === "artifact.publish",
			}).execute("receipt", readRequest)
		).details.records,
	).toEqual([receipt]);
});

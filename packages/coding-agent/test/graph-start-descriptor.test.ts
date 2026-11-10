import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGraphCommand } from "../src/graph/cli";
import {
	GraphStartDescriptorError,
	type GraphStartDescriptorPolicy,
	parseStartDescriptor,
	START_DESCRIPTOR_MEDIA_TYPE,
	START_DESCRIPTOR_ACCESS_SCOPE,
} from "../src/graph/start-descriptor";
import { GraphRunStore } from "../src/graph/store";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const content =
	"---\nformat: omp.graph/v1\nname: descriptor\nmembers: {}\nnodes:\n  work: {kind: program, executor: test, task: '#work'}\n---\n## work\nWork.\n";
const roots: string[] = [];
const stores: GraphRunStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function digest(value: string): string {
	return `sha256:${new Bun.CryptoHasher("sha256").update(value, "utf8").digest("hex")}`;
}

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-start-descriptor-"));
	roots.push(root);
	const store = new GraphRunStore(limits, root);
	stores.push(store);
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	expect(imported.state).toBe("completed");
	const graphId = imported.target_id!;
	const descriptors = store.configureStartDescriptors(policy());
	return { root, store, graphId, descriptors };
}

function policy(overrides: Partial<GraphStartDescriptorPolicy> = {}): GraphStartDescriptorPolicy {
	return {
		principal: "alice",
		maxBytes: 4096,
		authorizeArtifact: async () => true,
		authorizeTarget: async () => true,
		...overrides,
	};
}

function artifacts(root: string): string[] {
	const dir = path.join(root, "artifacts");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

const parse = (value: unknown) => parseStartDescriptor(Buffer.from(JSON.stringify(value), "utf8"), { maxBytes: 4096 });

describe("start descriptor admission", () => {
	it("rejects unknown fields, non-objects and every unusable value", () => {
		expect(() => parse({ title: "t", bindings: "b", extra: 1 })).toThrow(/Unknown start descriptor field/);
		expect(() => parse({ bindings: "b" })).toThrow(/title/);
		expect(() => parse({ title: "  ", bindings: "b" })).toThrow(/title/);
		expect(() => parse({ title: "a".repeat(201), bindings: "b" })).toThrow(/title/);
		expect(() => parse({ title: "bad\nname", bindings: "b" })).toThrow(/title/);
		expect(() => parse({ title: "t" })).toThrow(/bindings/);
		expect(() => parse({ title: "t", bindings: "" })).toThrow(/bindings/);
		expect(() => parse({ title: "t", bindings: "b", max_model_calls: 0 })).toThrow(/max_model_calls/);
		expect(() => parse({ title: "t", bindings: "b", max_model_calls: 1.5 })).toThrow(/max_model_calls/);
		expect(() => parse({ title: "t", bindings: "b", max_model_calls: "8" })).toThrow(/max_model_calls/);
		expect(() => parse({ title: "t", bindings: "b", timeout_ms: 0 })).toThrow(/timeout_ms/);
		expect(() => parse({ title: "t", bindings: "b", timeout_ms: -1 })).toThrow(/timeout_ms/);
		expect(() => parse({ title: "t", bindings: "b", workspace: 5 })).toThrow(/workspace/);
		expect(() => parse({ title: "t", bindings: "b", report_to: false })).toThrow(/report_to/);
		expect(() => parse([])).toThrow(/must be an object/);
		expect(() => parseStartDescriptor(Buffer.from("nope", "utf8"), { maxBytes: 4096 })).toThrow(/not valid JSON/);
		expect(() => parseStartDescriptor(Buffer.from([0x7b, 0xff, 0x7d]), { maxBytes: 4096 })).toThrow(
			/not valid UTF-8/,
		);
		expect(() => parseStartDescriptor(Buffer.from("{}", "utf8"), { maxBytes: 1 })).toThrow(/size limit/);
	});

	it("applies defaults and preserves explicit limits", () => {
		expect(parse({ title: "t", bindings: "b" })).toEqual({
			title: "t",
			bindings: "b",
			max_model_calls: 16,
			timeout_ms: 600_000,
		});
		expect(
			parse({
				title: "review",
				bindings: "models.md",
				workspace: "/tmp/work",
				report_to: "bot:orchestrator",
				max_model_calls: 8,
				timeout_ms: 1_800_000,
			}),
		).toEqual({
			title: "review",
			bindings: "models.md",
			workspace: "/tmp/work",
			report_to: "bot:orchestrator",
			max_model_calls: 8,
			timeout_ms: 1_800_000,
		});
	});
});

describe("start descriptor publication", () => {
	it("publishes exact bytes, replays the same key and serves the newest reference", async () => {
		const { root, graphId, descriptors } = fixture();
		const body = JSON.stringify({ title: "review", bindings: "models.md" });
		const first = await descriptors.publish({ request_key: "d1", graph_id: graphId, content: body });
		expect(first).toMatchObject({ request_key: "d1", state: "completed", error: null });
		expect(first.descriptor_ref?.digest).toBe(digest(body));
		expect(fs.readFileSync(path.join(root, "artifacts", first.descriptor_ref!.id), "utf8")).toBe(body);

		expect(await descriptors.publish({ request_key: "d1", graph_id: graphId, content: body })).toEqual(first);
		expect(artifacts(root)).toHaveLength(1);

		const got = await descriptors.get(graphId);
		expect(got).toMatchObject({ id: first.descriptor_ref!.id, digest: digest(body) });
		expect(typeof got!.created_at).toBe("string");

		const second = await descriptors.publish({
			request_key: "d2",
			graph_id: graphId,
			content: JSON.stringify({ title: "second", bindings: "models.md" }),
		});
		expect((await descriptors.get(graphId))?.id).toBe(second.descriptor_ref!.id);
	});

	it("rejects a reused key with different content and a mismatched expected digest", async () => {
		const { graphId, descriptors } = fixture();
		const body = JSON.stringify({ title: "review", bindings: "models.md" });
		await descriptors.publish({ request_key: "d1", graph_id: graphId, content: body });
		const conflict = await descriptors.publish({
			request_key: "d1",
			graph_id: graphId,
			content: JSON.stringify({ title: "other", bindings: "models.md" }),
		});
		expect(conflict).toMatchObject({ state: "rejected", error: { code: "idempotency_conflict" } });
		expect(conflict.descriptor_ref).toBeNull();

		expect(
			await descriptors.publish({
				request_key: "d2",
				graph_id: graphId,
				content: body,
				expected_digest: `sha256:${"0".repeat(64)}`,
			}),
		).toMatchObject({ state: "rejected", error: { code: "definition_invalid" } });
		expect(
			await descriptors.publish({
				request_key: "d3",
				graph_id: graphId,
				content: body,
				expected_digest: digest(body),
			}),
		).toMatchObject({ state: "completed" });
	});

	it("refuses an unusable descriptor before writing any history", async () => {
		const { root, graphId, descriptors } = fixture();
		const rejected = await descriptors.publish({
			request_key: "bad",
			graph_id: graphId,
			content: JSON.stringify({ title: "", bindings: "models.md" }),
		});
		expect(rejected).toMatchObject({ state: "rejected", error: { code: "definition_invalid" } });
		expect(await descriptors.get(graphId)).toBeNull();
		expect(artifacts(root)).toHaveLength(0);

		const unknown = await descriptors.publish({
			request_key: "ghost",
			graph_id: "does-not-exist",
			content: JSON.stringify({ title: "t", bindings: "b" }),
		});
		expect(unknown).toMatchObject({ state: "rejected", error: { code: "unknown_reference" } });
		expect(artifacts(root)).toHaveLength(0);

		const invalidRequest = await descriptors.publish({
			request_key: "bad-request",
			graph_id: graphId,
			content: "{}",
			extra: "field",
		} as never);
		expect(invalidRequest).toMatchObject({ state: "rejected", error: { code: "definition_invalid" } });
	});

	it("fails closed when the host policy denies the target or the artifact", async () => {
		// A fresh store per policy: the descriptor policy cannot be reconfigured on the same connection.
		const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "graph-start-descriptor-denied-"));
		roots.push(targetRoot);
		const deniedStore = new GraphRunStore(limits, targetRoot);
		stores.push(deniedStore);
		const imported = deniedStore.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const denied = deniedStore.configureStartDescriptors(policy({ authorizeTarget: async () => false }));
		const rejected = await denied.publish({
			request_key: "d1",
			graph_id: imported.target_id!,
			content: JSON.stringify({ title: "t", bindings: "b" }),
		});
		expect(rejected).toMatchObject({ state: "rejected", error: { code: "permission_denied" } });
		await expect(denied.get(imported.target_id!)).rejects.toBeInstanceOf(GraphStartDescriptorError);
		expect(artifacts(targetRoot)).toHaveLength(0);

		const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "graph-start-descriptor-artifact-"));
		roots.push(artifactRoot);
		const artifactStore = new GraphRunStore(limits, artifactRoot);
		stores.push(artifactStore);
		const otherImport = artifactStore.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const deniedArtifact = artifactStore.configureStartDescriptors(policy({ authorizeArtifact: async () => false }));
		const artifactRejected = await deniedArtifact.publish({
			request_key: "d1",
			graph_id: otherImport.target_id!,
			content: JSON.stringify({ title: "t", bindings: "b" }),
		});
		expect(artifactRejected).toMatchObject({ state: "rejected", error: { code: "permission_denied" } });
		expect(artifacts(artifactRoot)).toHaveLength(0);
		expect(() => artifactStore.configureStartDescriptors(policy())).toThrow(/already configured/);
	});

	it("keeps descriptor artifacts metadata-only and distinct from Run publications", async () => {
		const { graphId, descriptors, root } = fixture();
		const published = await descriptors.publish({
			request_key: "d1",
			graph_id: graphId,
			content: JSON.stringify({ title: "t", bindings: "b" }),
		});
		expect(START_DESCRIPTOR_MEDIA_TYPE).toBe("application/json");
		expect(START_DESCRIPTOR_ACCESS_SCOPE).toBe("graph:start-descriptor");
		expect(artifacts(root)).toEqual([published.descriptor_ref!.id]);
	});
});

describe("start descriptor CLI", () => {
	function setup(descriptor?: GraphStartDescriptorPolicy) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-start-descriptor-cli-"));
		roots.push(root);
		const files = new Map<string, string>();
		async function run(...args: string[]) {
			let stdout = "";
			let stderr = "";
			const code = await runGraphCommand(args, {
				root,
				descriptor,
				readInput: file => {
					const value = files.get(file);
					if (value === undefined) throw new Error("missing");
					return value;
				},
				writeOutput: (file, value) => {
					files.set(file, value);
				},
				out: text => {
					stdout += text;
				},
				err: text => {
					stderr += text;
				},
			});
			return { code, stdout, stderr };
		}
		return { run, files };
	}

	it("publishes and reads a descriptor through the trusted CLI admission", async () => {
		const { run, files } = setup(policy());
		files.set("-", content);
		const imported = await run("import", "--file", "-", "--request-key", "import-1");
		expect(imported.code).toBe(0);
		const graphId = /^Graph: (.+)$/m.exec(imported.stdout)![1];

		expect((await run("descriptor", "get", graphId)).stdout).toBe("Descriptor: none\n");

		const body = JSON.stringify({ title: "review", bindings: "models.md", max_model_calls: 8 });
		files.set("start.json", body);
		const published = await run("descriptor", "publish", graphId, "--file", "start.json", "--request-key", "d1");
		expect(published.code).toBe(0);
		expect(published.stdout).toContain("State: completed");
		const line = /^Descriptor: (\S+@sha256:[0-9a-f]{64})/m.exec(published.stdout)![0];
		expect((await run("descriptor", "get", graphId)).stdout).toContain(line);
		expect((await run("descriptor", "publish", graphId, "--file", "start.json", "--request-key", "d1")).stdout).toBe(
			published.stdout,
		);
		const json = await run("descriptor", "get", graphId, "--format", "json");
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({ kind: "graph.start-descriptor", graph_id: graphId });
	});

	it("fails closed without host admission and rejects unknown graphs", async () => {
		const { run, files } = setup();
		files.set("-", content);
		const graphId = /^Graph: (.+)$/m.exec(
			(await run("import", "--file", "-", "--request-key", "import-1")).stdout,
		)![1];
		const denied = await run("descriptor", "get", graphId);
		expect(denied.code).toBe(3);
		expect(denied.stderr).toContain("capability_unavailable");

		const admitted = setup(policy());
		admitted.files.set("-", content);
		const admittedGraph = /^Graph: (.+)$/m.exec(
			(await admitted.run("import", "--file", "-", "--request-key", "import-1")).stdout,
		)![1];
		admitted.files.set("start.json", JSON.stringify({ title: "t", bindings: "b" }));
		const unknown = await admitted.run(
			"descriptor",
			"publish",
			"missing-graph",
			"--file",
			"start.json",
			"--request-key",
			"d1",
		);
		expect(unknown.code).toBe(2);
		expect(unknown.stdout).toContain("unknown_reference");
		expect(admittedGraph).toBeTruthy();
	});
});

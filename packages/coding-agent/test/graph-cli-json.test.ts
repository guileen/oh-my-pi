import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphOperation } from "../src/graph/authoring";
import { runGraphCommand } from "../src/graph/cli";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Result {
	code: number;
	stdout: Buffer;
	chunks: Buffer[];
	stderr: string;
}

function setup() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graph-cli-json-"));
	roots.push(directory);
	const root = path.join(directory, "profile");
	const files = new Map<string, string>();
	const writes = new Map<string, string>();
	let reads = 0;
	async function run(...args: string[]): Promise<Result> {
		const chunks: Buffer[] = [];
		let stderr = "";
		const code = await runGraphCommand(args, {
			root,
			readInput: file => {
				reads++;
				const content = files.get(file);
				if (content === undefined) throw new Error("missing input");
				return content;
			},
			writeOutput: (file, content) => {
				writes.set(file, content);
			},
			out: text => chunks.push(Buffer.from(text, "utf8")),
			err: text => {
				stderr += text;
			},
		});
		return { code, stdout: Buffer.concat(chunks), chunks, stderr };
	}
	return {
		root,
		files,
		writes,
		run,
		get reads() {
			return reads;
		},
	};
}

function decode(result: Result) {
	expect(result.stderr).toBe("");
	expect(result.chunks).toHaveLength(1);
	const text = result.stdout.toString("utf8");
	expect(text.split("\n")).toHaveLength(2);
	expect(text.endsWith("\n")).toBe(true);
	expect(result.stdout.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
	const value = JSON.parse(text);
	expect(value.schema_version).toBe(1);
	return value;
}
function operation(result: Result): GraphOperation {
	const value = decode(result);
	expect(Object.keys(value).sort()).toEqual(["kind", "operation", "schema_version"]);
	expect(value.kind).toBe("graph.operation");
	expect(Object.keys(value.operation).sort()).toEqual([
		"error",
		"request_key",
		"result_ref",
		"revision",
		"state",
		"target_id",
	]);
	return value.operation;
}
function error(result: Result, code = "definition_invalid") {
	const value = decode(result);
	expect(Object.keys(value).sort()).toEqual(["error", "kind", "schema_version"]);
	expect(value.kind).toBe("graph.error");
	expect(value.error).toEqual({
		code,
		message: expect.any(String),
		location: null,
		retryable: false,
		details: null,
	});
	return value.error;
}

const source =
	'---\r\nformat: omp.graph/v1\r\nname: guide\r\nmembers: {}\r\nnodes: {}\r\n---\r\n\r\n# Guide\r\n\r\nKeep **Markdown**, "quotes", 中文 and \\ paths.';

describe("Graph CLI JSON boundary", () => {
	it("exports exact stored Markdown bytes without adding a final newline", async () => {
		const f = setup();
		const content = source;
		f.files.set("-", content);
		const args = ["import", "--file", "-", "--request-key", "import", "--format=json"];
		const first = await f.run(...args);
		expect(first.code).toBe(0);
		const receipt = operation(first);
		expect(receipt).toEqual({
			request_key: "import",
			state: "completed",
			target_id: expect.any(String),
			revision: "1",
			result_ref: {
				id: `${receipt.target_id}@1`,
				digest: `sha256:${Bun.SHA256.hash(content, "hex")}`,
			},
			error: null,
		});
		expect((await f.run(...args)).stdout).toEqual(first.stdout);
		expect((await f.run("request", "get", "import", "--format", "json")).stdout).toEqual(first.stdout);
		const exported = await f.run("export", receipt.target_id!, "--output=-", "--format=json");
		expect(exported.code).toBe(0);
		const definition = decode(exported);
		expect(definition).toEqual({
			schema_version: 1,
			kind: "graph.definition",
			graph_id: receipt.target_id,
			revision: receipt.revision,
			digest: receipt.result_ref!.digest,
			content,
		});
		expect(Buffer.from(definition.content, "utf8")).toEqual(Buffer.from(content, "utf8"));
		expect(f.writes.size).toBe(0);
	});

	it("preserves replay, CAS rejection and idempotency conflict as operation receipts", async () => {
		const f = setup();
		const created = await f.run("create", "guide", "--format=json");
		expect(created.code).toBe(0);
		const receipt = operation(created);
		expect(operation(await f.run("request", "get", receipt.request_key, "--format=json"))).toEqual(receipt);
		const graph = receipt.target_id!;
		f.files.set("edit.md", `${source}\r\n\r\nEdited.\r\n`);
		const edit = ["edit", graph, "--file", "edit.md", "--if-revision", "1", "--request-key", "edit", "--format=json"];
		const edited = await f.run(...edit);
		expect(edited.code).toBe(0);
		expect(operation(edited).revision).toBe("2");
		expect((await f.run(...edit)).stdout).toEqual(edited.stdout);
		const staleArgs = [...edit];
		staleArgs[7] = "stale";
		const stale = await f.run(...staleArgs);
		expect(stale.code).toBe(2);
		const rejection = operation(stale);
		expect(rejection.error?.code).toBe("revision_conflict");
		expect(rejection.target_id).toBe(graph);
		expect(rejection.error?.details).toEqual({ expected_revision: "1", current_revision: "2" });
		const recovered = await f.run("request", "get", "stale", "--format=json");
		expect(recovered.code).toBe(0);
		expect(recovered.stdout).toEqual(stale.stdout);
		f.files.set("edit.md", `${source}\r\nDifferent retry.\r\n`);
		const collision = await f.run(...edit);
		expect(collision.code).toBe(2);
		expect(operation(collision).error?.code).toBe("idempotency_conflict");
		const exported = decode(await f.run("export", graph, "--output=-", "--format=json"));
		expect(exported.revision).toBe("2");
		expect(exported.content).toBe(`${source}\r\n\r\nEdited.\r\n`);
		expect(exported.digest).toBe(`sha256:${Bun.SHA256.hash(exported.content, "hex")}`);
	});

	it("frames every incremental authoring action without changing Markdown input conventions", async () => {
		const f = setup();
		const created = operation(await f.run("create", "guide", "--request-key", "create", "--format=json"));
		const graph = created.target_id!;
		f.files.set(
			"member.md",
			"---\nrole: '#review-role'\nmodel: review-model\nbase: isolated\nduty: review\npermissions: {read: [], write: [], execute: []}\n---\nReview the plan.\n",
		);
		f.files.set("review.md", "---\nkind: bot\nmember: reviewer\ntask: '#review-task'\n---\nInspect the proposal.\n");
		f.files.set("next.md", "---\nkind: human\ntask: '#next'\n---\nDecide.\n");
		f.files.set("edge.md", "---\nid: review-next\nfrom: review\nto: next\n---\n");
		f.files.set("permit.md", "---\nfrom: reviewer\nto: reviewer\nwhen: '#review-role'\n---\n");
		const changes = [
			{ args: ["member", "add", graph, "reviewer"], file: "member.md" },
			{ args: ["node", "add", graph, "review"], file: "review.md" },
			{ args: ["node", "add", graph, "next"], file: "next.md" },
			{ args: ["connect", graph], file: "edge.md" },
			{ args: ["permit", graph], file: "permit.md" },
		];
		let revision = "1";
		for (const change of changes) {
			const result = await f.run(
				...change.args,
				"--file",
				change.file,
				"--if-revision",
				revision,
				"--request-key",
				change.file,
				"--format=json",
			);
			expect(result.code).toBe(0);
			const receipt = operation(result);
			expect(receipt.error).toBeNull();
			expect(receipt.target_id).toBe(graph);
			expect(receipt.revision).toBe(String(Number(revision) + 1));
			revision = receipt.revision!;
		}
		const validated = await f.run("validate", graph, "--format=json");
		expect(validated.code).toBe(0);
		expect(decode(validated)).toEqual({
			schema_version: 1,
			kind: "graph.validation",
			graph_id: graph,
			revision,
			issues: [],
		});
	});

	it("returns validation issues with a nonzero exit code for an invalid stored definition", async () => {
		const f = setup();
		const created = operation(await f.run("create", "guide", "--format=json"));
		const db = new Database(path.join(f.root, "graphs.sqlite"));
		try {
			db.query("UPDATE graph_snapshots SET content=? WHERE graph_id=?").run(
				source.replace("nodes: {}", "nodes: []"),
				created.target_id,
			);
		} finally {
			db.close();
		}
		const result = await f.run("validate", created.target_id!, "--format=json");
		expect(result.code).toBe(2);
		const validation = decode(result);
		expect(Object.keys(validation).sort()).toEqual(["graph_id", "issues", "kind", "revision", "schema_version"]);
		expect(validation.kind).toBe("graph.validation");
		expect(validation.graph_id).toBe(created.target_id);
		expect(validation.revision).toBe("1");
		expect(validation.issues).toContainEqual(
			expect.objectContaining({ path: "/nodes", message: expect.any(String) }),
		);
	});

	it("keeps invalid mutation receipts distinct from command errors", async () => {
		const f = setup();
		f.files.set("bad.md", "---\nformat: omp.graph/v1\nname: guide\nmembers: {}\nnodes: []\n---\n");
		const result = await f.run("import", "--file", "bad.md", "--request-key", "invalid", "--format=json");
		expect(result.code).toBe(2);
		expect(operation(result).error?.code).toBe("definition_invalid");
		const missing = await f.run("export", "missing", "--output=-", "--format=json");
		expect(missing.code).toBe(2);
		error(missing, "unknown_graph");
	});

	it.each(
		[
			["create", "guide", "--unknown", "value"],
			["create"],
			["import", "--file"],
			["member", "remove", "graph", "reviewer"],
			["request", "list"],
			["unsupported"],
			["create", "guide", "--format=json"],
			["export", "graph", "--output", "out.md"],
			["preview", "graph"],
			["start", "graph", "--input", "secret.md"],
		].map(args => ({ args })),
	)("rejects unsupported or malformed machine arguments before profile or file access: %j", async ({ args }) => {
		const f = setup();
		const result = await f.run(...args, "--format=json");
		expect(result.code).toBe(2);
		error(result);
		expect(f.reads).toBe(0);
		expect(f.writes.size).toBe(0);
		expect(fs.existsSync(f.root)).toBe(false);
	});

	it.each(
		[
			["import", "--file", "secret.md", "--request-key", "import", "--format=mermaid"],
			["preview", "graph", "--format=yaml"],
			["create", "guide", "--format=json", "--format=mermaid"],
			["create", "guide", "--", "--format=json"],
		].map(args => ({ args })),
	)("rejects unsupported or ambiguous formats without selecting JSON: %j", async ({ args }) => {
		const f = setup();
		const result = await f.run(...args);
		expect(result.code).toBe(2);
		expect(result.stdout.byteLength).toBe(0);
		expect(f.reads).toBe(0);
		expect(f.writes.size).toBe(0);
		expect(fs.existsSync(f.root)).toBe(false);
	});

	it("does not expose execution request receipts through machine request.get", async () => {
		const f = setup();
		await f.run("create", "guide", "--request-key", "create", "--format=json");
		const db = new Database(path.join(f.root, "graphs.sqlite"));
		try {
			db.query("INSERT INTO graph_requests VALUES (?,?,?)").run(
				"execution",
				JSON.stringify({ operation: "start" }),
				JSON.stringify({
					request_key: "execution",
					state: "accepted",
					target_id: "private-run",
					revision: "1",
					result_ref: null,
					error: null,
				}),
			);
		} finally {
			db.close();
		}
		const result = await f.run("request", "get", "execution", "--format=json");
		expect(result.code).toBe(3);
		error(result, "permission_denied");
		expect(result.stdout.includes(Buffer.from("private-run"))).toBe(false);
	});

	it("preserves profile authorization before reading machine mutation input", async () => {
		const f = setup();
		fs.symlinkSync(path.dirname(f.root), f.root, "dir");
		const result = await f.run("import", "--file", "secret.md", "--request-key", "import", "--format=json");
		expect(result.code).toBe(3);
		error(result, "permission_denied");
		expect(f.reads).toBe(0);
		expect(f.writes.size).toBe(0);
	});

	it("bounds machine error output without changing its exit code", async () => {
		const f = setup();
		const result = await f.run("create", "guide", `--${"x".repeat(10_000)}=value`, "--format=json");
		expect(result.code).toBe(2);
		error(result);
		expect(result.stdout.byteLength).toBeLessThan(4096);
		expect(fs.existsSync(f.root)).toBe(false);
	});
});

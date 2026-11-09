import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS, runGraphCommand } from "../src/graph/cli";
import { listGraphTemplates, readGraphTemplate } from "../src/graph/templates";
import { GraphManageTool, GraphReadTool } from "../src/tools/graph";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function rootDir(prefix = "graph-templates-") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

function cli(root: string, templateRoot?: string) {
	let stdout = "";
	let stderr = "";
	return {
		output: () => ({ stdout, stderr }),
		async run(...args: string[]) {
			stdout = "";
			stderr = "";
			const code = await runGraphCommand(args, {
				root,
				...(templateRoot ? { templateRoot } : {}),
				readInput: () => {
					throw new Error("no input files are used here");
				},
				out: text => {
					stdout += text;
				},
				err: text => {
					stderr += text;
				},
			});
			return { code, stdout, stderr };
		},
	};
}

describe("bundled Graph templates", () => {
	it("lists every shipped workflow with its declared input and output contract", async () => {
		const root = rootDir();
		const { run } = cli(root);
		const result = await run("templates");
		expect(result.code).toBe(0);
		for (const name of ["requirement-development", "requirement-spec-draft", "screenwriting"]) {
			expect(result.stdout).toContain(`${name}  `);
		}
		// The spec-draft workflow is the one local runner that can execute end to end today.
		expect(result.stdout).toMatch(
			/requirement-spec-draft {2}\S+\n {2}summary:.*in:task {2}out:spec,review .*local:yes/,
		);
		// A Graph that local runs reject stays visible with that reason rather than vanishing.
		expect(result.stdout).toMatch(/requirement-development {2}\S+\n {2}summary:.*local:no/);
	});

	it("reports the same template contract as JSON, including the resolved path", async () => {
		const root = rootDir();
		const result = await cli(root).run("templates", "--format", "json");
		expect(result.code).toBe(0);
		const payload = JSON.parse(result.stdout) as {
			kind: string;
			root: string;
			templates: { template: string; path: string; error: string | null; entry: { inputs: { name: string }[] } }[];
		};
		expect(payload.kind).toBe("graph.templates");
		const draft = payload.templates.find(entry => entry.template === "requirement-spec-draft");
		expect(draft?.error).toBeNull();
		expect(draft?.path.endsWith(path.join("requirement-spec-draft", "GRAPH.md"))).toBe(true);
		expect(draft?.entry.inputs.map(input => input.name)).toEqual(["task"]);
	});

	it("discovers and imports the daily coding Graph contract", async () => {
		const root = rootDir();
		const template = await readGraphTemplate("daily-code", GRAPH_CLI_LIMITS);
		expect(template.error).toBeNull();
		expect(template.entry?.inputs.map(input => input.name)).toEqual(["task"]);
		expect(template.entry?.outputs.map(output => output.name)).toEqual(["report"]);

		const { run } = cli(root);
		const imported = await run("import", "--template", "daily-code", "--request-key", "daily-import");
		expect(imported.code).toBe(0);
		const listed = await run("list");
		expect(listed.stdout).toContain("daily-code");
		expect(listed.stdout).toContain("in:task");
		expect(listed.stdout).toContain("out:report");
	});

	it("keeps an unparseable template listed with its error instead of hiding it", async () => {
		const templateRoot = rootDir("graph-templates-bad-");
		const good = path.join(templateRoot, "usable");
		const bad = path.join(templateRoot, "broken");
		fs.mkdirSync(good, { recursive: true });
		fs.mkdirSync(bad, { recursive: true });
		fs.copyFileSync(
			new URL("../examples/graph/requirement-spec-draft/GRAPH.md", import.meta.url),
			path.join(good, "GRAPH.md"),
		);
		fs.writeFileSync(path.join(bad, "GRAPH.md"), "---\nformat: omp.graph/v1\nname: broken\nnodes: {}\n---\n");

		const listing = await listGraphTemplates(GRAPH_CLI_LIMITS, { root: templateRoot });
		expect(listing.templates.map(entry => entry.template)).toEqual(["broken", "usable"]);
		const broken = listing.templates.find(entry => entry.template === "broken")!;
		expect(broken.error).toBeTruthy();
		expect(broken.entry?.local_run.supported).toBe(false);

		const result = await cli(rootDir()).run("templates", "--format", "json");
		expect(result.code).toBe(0);

		const humanRoot = rootDir();
		const human = await cli(humanRoot, templateRoot).run("templates");
		expect(human.stdout).toContain("broken");
		expect(human.stdout).toContain("invalid:");
		expect(human.stdout).toContain("usable");
	});

	it("imports a template by name and never for a name it cannot resolve", async () => {
		const root = rootDir();
		const { run } = cli(root);
		const imported = await run("import", "--template", "requirement-spec-draft", "--request-key", "import-1");
		expect(imported.code).toBe(0);
		const listed = await run("list");
		expect(listed.stdout).toMatch(/requirement-spec-draft {2}r1 {2}in:task {2}out:spec,review/);
		expect(listed.stdout).toContain("local:yes");

		const unknown = await run("import", "--template", "does-not-exist", "--request-key", "import-2");
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toContain("Unknown Graph template: does-not-exist");

		const traversal = await run("import", "--template", "../secrets", "--request-key", "import-3");
		expect(traversal.code).toBe(2);
		expect(traversal.stderr).toContain("Invalid template name");

		const both = await run(
			"import",
			"--template",
			"requirement-spec-draft",
			"--file",
			"GRAPH.md",
			"--request-key",
			"import-4",
		);
		expect(both.code).toBe(2);
		expect(both.stderr).toContain("--template and --file are mutually exclusive");

		const missing = await run("import", "--request-key", "import-5");
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("import requires --file or --template");
	});

	it("resolves a template path only through the bundled directory", async () => {
		const templateRoot = rootDir("graph-templates-read-");
		fs.mkdirSync(path.join(templateRoot, "usable"), { recursive: true });
		fs.copyFileSync(
			new URL("../examples/graph/requirement-spec-draft/GRAPH.md", import.meta.url),
			path.join(templateRoot, "usable", "GRAPH.md"),
		);
		const entry = await readGraphTemplate("usable", GRAPH_CLI_LIMITS, { root: templateRoot });
		expect(entry.entry?.outputs.map(output => output.name)).toEqual(["spec", "review"]);
		await expect(readGraphTemplate("../usable", GRAPH_CLI_LIMITS, { root: templateRoot })).rejects.toThrow(
			"Invalid template name",
		);
		await expect(readGraphTemplate("absent", GRAPH_CLI_LIMITS, { root: templateRoot })).rejects.toThrow(
			"Unknown Graph template",
		);
	});
});

describe("Graph agent tools discover templates", () => {
	it("reads templates without Run authorization and imports one by name", async () => {
		const root = rootDir();
		const read = new GraphReadTool({ root });
		const readResult = await read.execute("1", { version: 1, operation: "templates" });
		expect(readResult.isError).toBe(false);
		expect(readResult.content[0]?.type === "text" ? readResult.content[0].text : "").toContain(
			"requirement-spec-draft",
		);

		const manage = new GraphManageTool({ root });
		const imported = await manage.execute("2", {
			version: 1,
			request_key: "import-template",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { template: "requirement-spec-draft" },
		});
		expect(imported.isError).toBe(false);
		const receipt = imported.details as { state: string; target_id: string };
		expect(receipt.state).toBe("completed");

		const catalog = await read.execute("3", { version: 1, operation: "catalog" });
		const text = catalog.content[0]?.type === "text" ? catalog.content[0].text : "";
		expect(text).toContain(receipt.target_id);
		expect(text).toContain("Inputs: task");
		expect(text).toContain("Outputs: spec, review");

		const unknown = await manage.execute("4", {
			version: 1,
			request_key: "import-template-missing",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { template: "nope" },
		});
		expect(unknown.isError).toBe(true);
		expect((unknown.details as { error: { code: string } }).error.code).toBe("unknown_reference");
	});
});

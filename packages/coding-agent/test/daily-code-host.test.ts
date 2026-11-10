import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { runBotCommand } from "../src/bots/cli";
import { executeDailyCode } from "../src/bots/daily-code-host";
import { parseDailyExecutionInput, parseDailyReview } from "../src/bots/daily-code-input";
import { GraphReadTool } from "../src/tools/graph";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "daily-code-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace);
	return { root: path.join(root, "state"), workspace: await fs.realpath(workspace) };
}
function raw(workspace: string) {
	return {
		task: "implement a bounded change",
		facts: "preserve existing changes",
		userWords: "original wording\n原话",
		workspace,
		write: ["src/**"],
		checks: ["test"],
		bindings: { terra: { provider: "fixture", model: "coder" }, sol: { provider: "fixture", model: "reviewer" } },
	};
}

it("rejects an unavailable reviewer binding and unknown command fields before model execution", () => {
	const value = raw("/workspace");
	expect(() => parseDailyExecutionInput({ ...value, bindings: { terra: value.bindings.terra } })).toThrow("sol");
	expect(() => parseDailyExecutionInput({ ...value, command: "arbitrary shell" })).toThrow("unknown fields");
	expect(() => parseDailyExecutionInput({ ...value, checks: ["test", "test"] })).toThrow("distinct");
	expect(() => parseDailyExecutionInput({ ...value, reviewer: { model: "terra" } })).toThrow("role model");
});

it("preserves user words and applies an effort-only first-round override without changing the model alias", () => {
	const value = raw("/workspace");
	const parsed = parseDailyExecutionInput({ ...value, coder: { thinking: "max" } });
	expect(parsed.coder).toEqual({ model: "terra", thinking: "max" });
	expect(parsed.userWords).toBe(value.userWords);
	expect(() => parseDailyExecutionInput({ ...value, coder: { thinking: "unsupported" } })).toThrow("thinking");
});

it("refuses ambiguous or empty role reports rather than entering acceptance", () => {
	for (const content of [
		"ready",
		'```json\n{"status":"ready","report":"ok"}\n```',
		'{"status":"ready","report":" "}',
		'{"status":"passed","report":"ok"}',
		'{"status":"ready","report":"ok","command":"test"}',
	]) {
		expect(() => parseDailyReview(content)).toThrow();
	}
});

it("discovers the Bot host through the headless Bot CLI and Graph reader without execution authority", async () => {
	let output = "";
	expect(
		await runBotCommand(["workflows", "--json"], {
			stdout: text => {
				output += text;
			},
		}),
	).toBe(0);
	const listed = JSON.parse(output);
	expect(listed.workflows[0].command).toContain("daily-code");
	const result = await new GraphReadTool().execute("discover", { version: 1, operation: "workflows" });
	expect(result.isError).toBe(false);
	const details = result.details as { records: Array<{ command: string[]; graph: { supported: boolean } }> };
	expect(details.records[0].command).toEqual(listed.workflows[0].command);
	expect(details.records[0].graph.supported).toBe(false);
	const templates = await new GraphReadTool({ templateRoot: "/missing/daily-code-templates" }).execute("templates", {
		version: 1,
		operation: "templates",
	});
	expect(templates.isError).toBe(false);
	expect((templates.details as { workflows: Array<{ command: string[] }> }).workflows[0].command).toEqual(
		listed.workflows[0].command,
	);
});

it("does not even read an input file without explicit workspace-code acceptance", async () => {
	let output = "";
	const code = await runBotCommand(
		["daily-code", "--input", "/missing/input.json", "--request-key", "one", "--json"],
		{
			stdout: text => {
				output += text;
			},
		},
	);
	expect(code).toBe(1);
	expect(JSON.parse(output).reason).toContain("--accept-workspace-code");
});

it("persists a pre-dispatch cancellation and replays the report, never invoking either model", async () => {
	const { root, workspace } = await fixture();
	const input = parseDailyExecutionInput(raw(workspace));
	const controller = new AbortController();
	controller.abort(new Error("cancelled before dispatch"));
	const first = await executeDailyCode(input, "cancelled", { root, signal: controller.signal });
	expect(first.status).toBe("blocked");
	expect(first.reason).toContain("cancelled before dispatch");
	const replay = await executeDailyCode(input, "cancelled", { root });
	expect(replay).toEqual(first);
	await expect(executeDailyCode({ ...input, task: "different" }, "cancelled", { root })).rejects.toThrow("conflicts");
});

it("treats a crashed acceptance invocation as unknown instead of replaying its side effects", async () => {
	const { root, workspace } = await fixture();
	const input = parseDailyExecutionInput(raw(workspace));
	const runDir = path.join(root, Bun.SHA256.hash("crashed", "hex"));
	const evidence = [
		{ implementation: "implemented", review: { status: "ready" as const, report: "directly fixed" }, evidence: [] },
	];
	await Bun.write(
		path.join(runDir, "result.json"),
		JSON.stringify({
			version: 1,
			digest: Bun.SHA256.hash(stableStringifyJson(input), "hex"),
			input,
			phase: "acceptance:test",
			jobs: [],
			rounds: evidence,
		}),
	);
	const result = await executeDailyCode(input, "crashed", { root });
	expect(result.status).toBe("blocked");
	expect(result.reason).toContain("No side effects were replayed");
	expect(result.rounds).toEqual(evidence);
});

it("does not turn a malformed prior journal into a fresh side-effecting run", async () => {
	const { root, workspace } = await fixture();
	const input = parseDailyExecutionInput(raw(workspace));
	const runDir = path.join(root, Bun.SHA256.hash("malformed", "hex"));
	await Bun.write(path.join(runDir, "result.json"), "null");
	const result = await executeDailyCode(input, "malformed", { root });
	expect(result.status).toBe("blocked");
	expect(result.reason).toContain("Malformed daily-code journal");
	expect(await Bun.file(path.join(runDir, "result.json")).text()).toBe("null");
});

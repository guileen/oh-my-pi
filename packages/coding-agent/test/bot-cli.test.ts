import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BotCliOptions, runBotCommand } from "../src/bots/cli";
import { BotStore } from "../src/bots/store";

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

describe("bot CLI", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-cli-"));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function command(argv: string[], options: BotCliOptions = {}): Promise<Result> {
		let stdout = "";
		let stderr = "";
		const code = await runBotCommand(argv, {
			root,
			cwd: root,
			stdin: async () => "",
			stdout: text => {
				stdout += text;
			},
			stderr: text => {
				stderr += text;
			},
			...options,
		});
		return { code, stdout, stderr };
	}

	function seed() {
		const store = new BotStore(root);
		try {
			const bot = store.createBot({ bot_name: "reviewer", cwd: root });
			const receipt = store.admit(bot.bot_id, { command: "submit", input: "Check cancellation", key: "review-1" });
			return { bot, receipt };
		} finally {
			store.close();
		}
	}

	function storedDefinition() {
		const store = new BotStore(root);
		try {
			return store.getBot("reviewer");
		} finally {
			store.close();
		}
	}

	it("creates an empty-capability definition without resolving a model", async () => {
		const created = await command(["create", "reviewer", "--json"]);
		expect(created.code).toBe(0);
		expect(created.stderr).toBe("");
		expect(created.stdout.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(created.stdout)).toMatchObject({
			schema_version: 1,
			kind: "bot",
			bot: {
				bot_name: "reviewer",
				bot_id: expect.any(String),
				config_revision: expect.any(String),
				created_at: expect.any(String),
			},
		});
		expect(JSON.parse(created.stdout).bot).not.toHaveProperty("config");
		const listed = await command(["list", "--json"]);
		expect(JSON.parse(listed.stdout)).toMatchObject({
			schema_version: 1,
			kind: "bots",
			bots: [{ bot_name: "reviewer" }],
		});
		const status = await command(["reviewer", "status", "--json"]);
		expect(JSON.parse(status.stdout)).toMatchObject({
			schema_version: 1,
			kind: "snapshot",
			capabilities: expect.arrayContaining([
				"bot.questions.v1",
				"bot.ownership.v1",
				"bot.identity-guard.v1",
				"bot.scoped-refs.v1",
			]),
			jobs: [],
			next_page_token: null,
		});
	});

	it("reads the explicit prompt file and resolves creation directories", async () => {
		await Bun.write(path.join(root, "prompt.md"), "Review only.\n");
		await fs.mkdir(path.join(root, "project"));
		const result = await command([
			"create",
			"reviewer",
			"--system-prompt",
			"prompt.md",
			"--cwd",
			"project",
			"--model",
			"provider/model",
			"--json",
		]);
		expect(result.code).toBe(0);
		expect(storedDefinition().config).toMatchObject({
			system_prompt: "Review only.\n",
			cwd: path.join(root, "project"),
			model: "provider/model",
		});
		expect(result.stdout).not.toContain("Review only.");
		const listed = await command(["list", "--json"]);
		expect(listed.stdout).not.toContain("Review only.");
	});

	it.each(
		[
			[],
			["create"],
			["list", "extra"],
			["reviewer", "not-a-command"],
			["reviewer", "create", "other"],
			["reviewer", "list"],
			["reviewer", "send"],
			["reviewer", "stop"],
			["reviewer", "interrupt"],
			["reviewer", "set-model", "j1"],
			["reviewer", "stop", "j1", "--all"],
			["reviewer", "stop", "--all", "--if-revision", "1"],
			["reviewer", "status", "--steer"],
			["reviewer", "status", "--profile", "work"],
			["reviewer", "events", "j1", "--limit", "0"],
			["reviewer", "events", "j1", "--limit", "1.5"],
			["reviewer", "events", "j1", "--limit", "9007199254740992"],
			["reviewer", "resume", "j1", "--if-revision", "-1"],
			["reviewer", "compact", "j1", "--mode", "llm"],
			["reviewer", "status", "--json", "--json"],
			["reviewer", "status", "--unknown"],
			["create", "reviewer", "--system-prompt"],
			["create", "reviewer", "--expect-bot-id", "b1"],
			["list", "--expect-bot-id", "b1"],
			["reviewer", "status", "--job", "j1"],
			["reviewer", "status", "--expect-bot-id", ""],
		].map(argv => ({ argv })),
	)("returns one structured nonzero parse error for $argv", async ({ argv }) => {
		const result = await command([...argv, "--json"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(result.stdout)).toEqual({
			schema_version: 1,
			kind: "error",
			request_id: null,
			accepted: false,
			error: { code: "invalid_input", message: expect.any(String), retryable: false, details: null },
		});
	});

	it("rejects ambiguous and empty input before any Job is admitted", async () => {
		seed();
		for (const argv of [
			["reviewer", "submit", "positional"],
			["reviewer", "send", "j1", "positional"],
		]) {
			const result = await command([...argv, "--json"], { stdin: async () => "stdin" });
			expect(result.code).toBe(1);
			expect(JSON.parse(result.stdout).error.code).toBe("invalid_input");
		}
		const empty = await command(["reviewer", "submit", "--json"], { stdin: async () => " \n" });
		expect(JSON.parse(empty.stdout).error.code).toBe("invalid_input");
		const status = await command(["reviewer", "status", "--json"]);
		expect(JSON.parse(status.stdout).jobs).toHaveLength(1);
	});

	it.each(
		[
			["missing", "submit", "text"],
			["missing", "send", "j1", "text", "--steer", "--reply-to", "input1"],
			["missing", "interrupt", "j1", "--if-revision", "1"],
			["missing", "resume", "j1", "--request-key", "retry1"],
			["missing", "compact", "j1", "--mode", "qaonly"],
			["missing", "set-model", "j1", "provider/model"],
			["missing", "stop", "j1"],
			["missing", "stop", "--all"],
		].map(argv => ({ argv })),
	)("routes a valid mutation to real service ownership lookup: $argv", async ({ argv }) => {
		const result = await command([...argv, "--json"]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout).error.code).toBe("unknown_bot");
	});

	it("accepts stdin-only and literal flag-like input without interpreting it as flags", async () => {
		const stdin = await command(["missing", "submit", "--json"], { stdin: async () => "input from pipe" });
		expect(JSON.parse(stdin.stdout).error.code).toBe("unknown_bot");
		const literal = await command(["missing", "submit", "--json", "--", "--not-a-flag"]);
		expect(JSON.parse(literal.stdout).error.code).toBe("unknown_bot");
	});

	it("strictly validates Graph placement files", async () => {
		const context = {
			graph_id: "g",
			graph_run_id: "r",
			node_id: "n",
			invocation_id: "i",
			attempt: 1,
			upstream: [{ edge_id: "e" }],
		};
		for (const invalid of [
			{ ...context, unexpected: true },
			{ ...context, attempt: 0 },
			{ ...context, upstream: [{ edge_id: "" }] },
			null,
		]) {
			await Bun.write(path.join(root, "context.json"), JSON.stringify(invalid));
			const result = await command(["missing", "submit", "input", "--context", "context.json", "--json"]);
			expect(JSON.parse(result.stdout).error.code).toBe("invalid_input");
		}
		await Bun.write(path.join(root, "context.json"), JSON.stringify(context));
		const valid = await command(["missing", "submit", "input", "--context", "context.json", "--json"]);
		expect(JSON.parse(valid.stdout).error.code).toBe("unknown_bot");
	});

	it("returns durable request, detail and event pages through real service reads", async () => {
		const { receipt } = seed();
		const status = JSON.parse((await command(["reviewer", "status", receipt.job_id!, "--json"])).stdout);
		expect(status.jobs).toHaveLength(1);
		expect(status.jobs[0]).toMatchObject({
			job_id: receipt.job_id,
			state: "queued",
			goal_preview: "Check cancellation",
		});
		const request = JSON.parse((await command(["reviewer", "request", receipt.request_id, "--json"])).stdout);
		expect(request).toMatchObject({ schema_version: 1, kind: "request", receipt, outcome: "pending" });
		const messages = JSON.parse(
			(await command(["reviewer", "messages", receipt.job_id!, "--limit", "1", "--json"])).stdout,
		);
		expect(messages).toMatchObject({ items: expect.any(Array), next_page_token: null });
		const first = JSON.parse(
			(await command(["reviewer", "events", receipt.job_id!, "--limit", "1", "--json"])).stdout,
		);
		expect(first.items).toHaveLength(1);
		expect(typeof first.next_page_token).toBe("string");
		const second = JSON.parse(
			(
				await command([
					"reviewer",
					"events",
					receipt.job_id!,
					"--limit",
					"1",
					"--page-token",
					first.next_page_token,
					"--json",
				])
			).stdout,
		);
		expect(second.items[0].event_id).not.toBe(first.items[0].event_id);
		const detail = JSON.parse((await command(["reviewer", "inspect", status.jobs[0].goal_ref, "--json"])).stdout);
		expect(detail).toMatchObject({ availability: "available", content: "Check cancellation", next_page_token: null });
	});

	it("paginates Bot snapshots without implicitly selecting the latest Job", async () => {
		const { bot } = seed();
		const store = new BotStore(root);
		try {
			store.admit(bot.bot_id, { command: "submit", input: "Second assignment" });
		} finally {
			store.close();
		}
		const first = JSON.parse((await command(["reviewer", "status", "--limit", "1", "--json"])).stdout);
		expect(first.jobs).toHaveLength(1);
		expect(first.bot.jobs_total).toBe(2);
		expect(typeof first.next_page_token).toBe("string");
		const second = JSON.parse(
			(await command(["reviewer", "status", "--page-token", first.next_page_token, "--limit", "1", "--json"]))
				.stdout,
		);
		expect(second.jobs).toHaveLength(1);
		expect(second.jobs[0].job_id).not.toBe(first.jobs[0].job_id);
	});

	it.each(
		[
			["submit", "Unintended work"],
			["send", "j1", "Unintended follow-up"],
			["send", "j1", "Unintended steering", "--steer"],
			["status"],
			["watch"],
			["messages", "j1"],
			["events", "j1"],
			["inspect", "ref1", "--job", "j1"],
			["request", "q1"],
			["interrupt", "j1"],
			["resume", "j1"],
			["compact", "j1", "--mode", "qaonly"],
			["set-model", "j1", "provider/model"],
			["stop", "j1"],
			["stop", "--all"],
		].map(argv => ({ argv })),
	)("rejects the wrong immutable identity before named operation $argv", async ({ argv }) => {
		const { bot } = seed();
		const before = JSON.parse((await command(["reviewer", "status", "--json"])).stdout);
		const result = await command(["reviewer", ...argv, "--expect-bot-id", `${bot.bot_id}-foreign`, "--json"]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ kind: "error", error: { code: "unknown_bot" } });
		const after = JSON.parse((await command(["reviewer", "status", "--json"])).stdout);
		expect(after).toEqual(before);
	});

	it("rejects a stale observed identity when the name is recreated before CLI admission", async () => {
		const { bot } = seed();
		const result = await command(["reviewer", "submit", "--expect-bot-id", bot.bot_id, "--json"], {
			stdin: async () => {
				const store = new BotStore(root);
				try {
					store.deleteBot(bot.bot_id);
					store.createBot({ bot_name: "reviewer", cwd: root });
				} finally {
					store.close();
				}
				return "Must not reach either definition";
			},
		});
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout).error.code).toBe("unknown_bot");
		const replacement = JSON.parse((await command(["reviewer", "status", "--json"])).stdout);
		expect(replacement.bot.bot_id).not.toBe(bot.bot_id);
		expect(replacement.jobs).toEqual([]);
		const store = new BotStore(root);
		try {
			expect(store.jobs(bot.bot_id)).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("enforces Bot and Job ownership before returning inspected content", async () => {
		const { bot, receipt } = seed();
		const store = new BotStore(root);
		let ownRef: string;
		let otherJob: string;
		let foreignRef: string;
		let foreignJobId: string;
		try {
			ownRef = store.getJob(bot.bot_id, receipt.job_id!).goal_ref!;
			otherJob = store.admit(bot.bot_id, { command: "submit", input: "Other protected Job" }).job_id!;
			const foreign = store.createBot({ bot_name: "foreign", cwd: root });
			const foreignJob = store.admit(foreign.bot_id, { command: "submit", input: "Foreign protected content" });
			foreignJobId = foreignJob.job_id!;
			foreignRef = store.getJob(foreign.bot_id, foreignJob.job_id!).goal_ref!;
		} finally {
			store.close();
		}
		const allowed = await command([
			"reviewer",
			"inspect",
			ownRef,
			"--job",
			receipt.job_id!,
			"--expect-bot-id",
			bot.bot_id,
			"--json",
		]);
		expect(allowed.code).toBe(0);
		expect(JSON.parse(allowed.stdout).content).toBe("Check cancellation");
		for (const [ref, job] of [
			[ownRef, otherJob],
			[foreignRef, receipt.job_id!],
			[ownRef, foreignJobId],
		]) {
			const denied = await command([
				"reviewer",
				"inspect",
				ref,
				"--job",
				job,
				"--expect-bot-id",
				bot.bot_id,
				"--json",
			]);
			expect(denied.code).toBe(1);
			expect(JSON.parse(denied.stdout).error.code).toBe("permission_denied");
			expect(denied.stdout).not.toContain("protected content");
			expect(denied.stdout).not.toContain("Check cancellation");
		}
	});

	it("rejects detail and snapshot page tokens from another Bot or Job", async () => {
		const { bot, receipt } = seed();
		const store = new BotStore(root);
		let otherJob: string;
		let ownRef: string;
		let otherRef: string;
		try {
			otherJob = store.admit(bot.bot_id, { command: "submit", input: "Second assignment" }).job_id!;
			ownRef = store.putRef(bot.bot_id, receipt.job_id!, "a".repeat(40_000), "text/plain");
			otherRef = store.putRef(bot.bot_id, otherJob, "b".repeat(40_000), "text/plain");
			for (const job of [receipt.job_id!, otherJob]) {
				store.recordMessage(bot.bot_id, job, { message_id: `${job}-1`, content: "first" });
				store.recordMessage(bot.bot_id, job, { message_id: `${job}-2`, content: "second" });
			}
			store.createBot({ bot_name: "foreign", cwd: root });
		} finally {
			store.close();
		}
		for (const action of ["messages", "events"]) {
			const first = JSON.parse(
				(await command(["reviewer", action, receipt.job_id!, "--limit", "1", "--json"])).stdout,
			);
			expect(first.next_page_token).toEqual(expect.any(String));
			const denied = await command(["reviewer", action, otherJob, "--page-token", first.next_page_token, "--json"]);
			expect(denied.code).toBe(1);
			expect(JSON.parse(denied.stdout).error.code).toBe("invalid_cursor");
		}
		const detail = JSON.parse(
			(await command(["reviewer", "inspect", ownRef, "--job", receipt.job_id!, "--json"])).stdout,
		);
		expect(detail.next_page_token).toEqual(expect.any(String));
		const wrongRef = await command([
			"reviewer",
			"inspect",
			otherRef,
			"--job",
			otherJob,
			"--page-token",
			detail.next_page_token,
			"--json",
		]);
		expect(wrongRef.code).toBe(1);
		expect(JSON.parse(wrongRef.stdout).error.code).toBe("invalid_cursor");
		const snapshot = JSON.parse((await command(["reviewer", "status", "--limit", "1", "--json"])).stdout);
		const wrongBot = await command(["foreign", "status", "--page-token", snapshot.next_page_token, "--json"]);
		expect(wrongBot.code).toBe(1);
		expect(JSON.parse(wrongBot.stdout).error.code).toBe("invalid_cursor");
	});

	it("pins an attached CLI watch to its immutable Bot when the name is recreated", async () => {
		const { bot } = seed();
		const controller = new AbortController();
		const frames: Array<{ kind: string; bot_id?: string; bot?: { bot_id: string } }> = [];
		let replacementId: string | undefined;
		const result = await command(["reviewer", "watch", "--expect-bot-id", bot.bot_id, "--json"], {
			signal: controller.signal,
			stdout: text => {
				const frame = JSON.parse(text);
				frames.push(frame);
				if (frame.kind === "snapshot") {
					const store = new BotStore(root);
					try {
						store.deleteBot(bot.bot_id);
						replacementId = store.createBot({ bot_name: "reviewer", cwd: root }).bot_id;
						store.setWorker(replacementId, "unknown");
						store.setWorker(bot.bot_id, "unknown");
					} finally {
						store.close();
					}
				} else controller.abort();
			},
		});
		expect(result.code).toBe(0);
		expect(frames).toHaveLength(2);
		expect(frames[0].bot?.bot_id).toBe(bot.bot_id);
		expect(frames[1].bot_id).toBe(bot.bot_id);
		expect(frames[1].bot_id).not.toBe(replacementId);
	});

	it("returns the addressed Job and request through identity-guarded CLI reads", async () => {
		const { bot, receipt } = seed();
		for (const argv of [
			["status", receipt.job_id!],
			["request", receipt.request_id],
			["messages", receipt.job_id!],
			["events", receipt.job_id!],
		]) {
			const result = await command(["reviewer", ...argv, "--expect-bot-id", bot.bot_id, "--json"]);
			expect(result.code).toBe(0);
			const value = JSON.parse(result.stdout);
			switch (argv[0]) {
				case "status":
					expect(value.bot.bot_id).toBe(bot.bot_id);
					expect(value.jobs.map((job: { job_id: string }) => job.job_id)).toEqual([receipt.job_id]);
					break;
				case "request":
					expect(value.receipt).toEqual(receipt);
					expect(value.outcome).toBe("pending");
					break;
				case "messages":
					expect(value.items).toEqual([]);
					break;
				case "events":
					expect(value.items).toEqual(
						expect.arrayContaining([expect.objectContaining({ bot_id: bot.bot_id, job_id: receipt.job_id })]),
					);
					break;
			}
		}
	});

	it("bootstraps watch as JSONL and aborts the viewer without stopping its Job", async () => {
		const { receipt } = seed();
		const controller = new AbortController();
		const frames: unknown[] = [];
		const result = await command(["reviewer", "watch", receipt.job_id!, "--json"], {
			signal: controller.signal,
			stdout: text => {
				frames.push(JSON.parse(text));
				controller.abort();
			},
		});
		expect(result.code).toBe(0);
		expect(frames[0]).toMatchObject({ schema_version: 1, kind: "snapshot", jobs: [{ job_id: receipt.job_id }] });
		const status = JSON.parse((await command(["reviewer", "status", receipt.job_id!, "--json"])).stdout);
		expect(status.jobs[0].state).toBe("queued");
	});

	it.each([false, true])("accepts watch replay cursor with base64url=%j", async encoded => {
		seed();
		const status = JSON.parse((await command(["reviewer", "status", "--json"])).stdout);
		const cursor = JSON.stringify({ journal_id: status.cursor.journal_id, seq: "0" });
		const since = encoded ? Buffer.from(cursor).toString("base64url") : cursor;
		const controller = new AbortController();
		const frames: Array<{ kind: string; cursor: { seq: string } }> = [];
		const result = await command(["reviewer", "watch", "--since", since, "--json"], {
			signal: controller.signal,
			stdout: text => {
				frames.push(JSON.parse(text));
				controller.abort();
			},
		});
		expect(result.code).toBe(0);
		expect(frames[0].kind).toBe("event");
		expect(BigInt(frames[0].cursor.seq)).toBeGreaterThan(0n);
	});

	it("returns invalid_cursor instead of silently starting a new watch", async () => {
		const result = await command(["reviewer", "watch", "--since", '{"journal_id":"j","seq":1}', "--json"]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout).error.code).toBe("invalid_cursor");
	});

	it("keeps plain diagnostics on stderr and strips terminal control characters", async () => {
		const result = await command(["reviewer", "status", "--hostile\u001b[31m"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("invalid_input");
		expect(result.stderr).not.toContain("\u001b");
	});
});

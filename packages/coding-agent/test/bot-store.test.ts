import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { BotStore, validateGraphContext } from "../src/bots/store";
import {
	BotError,
	type BotCommand,
	type BotErrorCode,
	type BotEvent,
	type Cursor,
	type Receipt,
} from "../src/bots/types";

let temp: TempDir | undefined;
const connections: BotStore[] = [];
function open(root?: string): BotStore {
	temp ??= TempDir.createSync("@omp-bot-store-");
	const store = new BotStore(root ?? path.join(temp.path(), "profile"));
	connections.push(store);
	return store;
}
function errorCode(operation: () => unknown, code: BotErrorCode): BotError {
	try {
		operation();
	} catch (error) {
		expect(error).toBeInstanceOf(BotError);
		if (!(error instanceof BotError)) throw error;
		expect(error.code).toBe(code);
		return error;
	}
	throw new Error(`Expected ${code}`);
}
function submit(store: BotStore, botId: string, input = "Review cancellation", key?: string): Receipt {
	return store.admit(botId, { command: "submit", input, key });
}
function applyInput(store: BotStore, botId: string, receipt: Receipt, input = "Review cancellation"): void {
	store.enqueueInput(botId, receipt.job_id!, { request_id: receipt.request_id, input });
	store.finishRequest(botId, receipt.request_id, "applied");
}
function drainEvents(store: BotStore, botId: string, after?: Cursor): BotEvent[] {
	const events: BotEvent[] = [];
	let page = store.events(botId, { after, limit: 2 });
	events.push(...page.items);
	while (page.next_page_token) {
		page = store.events(botId, { page_token: page.next_page_token, limit: 2 });
		events.push(...page.items);
	}
	return events;
}
async function contender(root: string, botId: string, command: BotCommand): Promise<unknown> {
	const modulePath = new URL("../src/bots/store.ts", import.meta.url).href;
	const script = `import {BotStore} from ${JSON.stringify(modulePath)};
await Bun.stdin.text();
const store = new BotStore(process.env.BOT_TEST_ROOT);
try { console.log(JSON.stringify(store.admit(process.env.BOT_TEST_ID, JSON.parse(process.env.BOT_TEST_COMMAND)))); }
catch(error) { console.log(JSON.stringify(error.toJSON())); }
finally { store.close(); }`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: { ...process.env, BOT_TEST_ROOT: root, BOT_TEST_ID: botId, BOT_TEST_COMMAND: JSON.stringify(command) },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write("start");
	child.stdin.end();
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe("");
	expect(exit).toBe(0);
	return JSON.parse(stdout) as unknown;
}

afterEach(async () => {
	setSystemTime();
	for (const store of connections.splice(0)) store.close();
	if (temp) {
		await temp.remove();
		temp = undefined;
	}
});

describe("Bot durable admission and profile isolation", () => {
	it("simultaneous CLI processes receive one original receipt and create exactly one Job", async () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const command: BotCommand = { command: "submit", input: "Check PR 42", key: "graph-42" };
		const receipts = await Promise.all([
			contender(store.root, bot.bot_id, command),
			contender(store.root, bot.bot_id, command),
		]);
		expect(receipts[0]).toEqual(receipts[1]);
		expect(store.jobs(bot.bot_id)).toHaveLength(1);
		expect(drainEvents(store, bot.bot_id).filter(event => event.type === "request.accepted")).toHaveLength(1);
	});

	it("competing revision-guarded clients cannot both control the same observed revision", async () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		const revision = store.getJob(bot.bot_id, receipt.job_id!).revision;
		const results = (await Promise.all([
			contender(store.root, bot.bot_id, { command: "stop", job_id: receipt.job_id!, if_revision: revision }),
			contender(store.root, bot.bot_id, { command: "interrupt", job_id: receipt.job_id!, if_revision: revision }),
		])) as Array<{ kind: string; error?: { code: string; details: { current_revision: string } } }>;
		expect(results.filter(result => result.kind === "receipt")).toHaveLength(1);
		const conflict = results.find(result => result.kind === "error")!;
		expect(conflict.error?.code).toBe("revision_conflict");
		expect(conflict.error?.details.current_revision).toBe(store.getJob(bot.bot_id, receipt.job_id!).revision);
	});

	it("canonical absent graph defaults replay the original receipt, changed input conflicts after reopening", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const base = { graph_id: "g", graph_run_id: "r", node_id: "n", invocation_id: "i", attempt: 1, upstream: [] };
		const receipt = store.admit(bot.bot_id, { command: "submit", input: "Review", key: "k", graph_context: base });
		const second = open(store.root);
		expect(
			second.admit(bot.bot_id, {
				command: "submit",
				key: "k",
				input: "Review",
				graph_context: { ...base, trace_id: null },
			}),
		).toEqual(receipt);
		errorCode(
			() => second.admit(bot.bot_id, { command: "submit", key: "k", input: "Changed", graph_context: base }),
			"idempotency_conflict",
		);
		expect(second.jobs(bot.bot_id)).toHaveLength(1);
	});

	it("invalid graph placement or empty input leaves neither a Job nor an accepted request", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const cursor = store.snapshot(bot.bot_id).cursor;
		for (const value of [
			{ graph_id: "g" },
			{ graph_id: "g", graph_run_id: "r", node_id: "n", invocation_id: "i", attempt: 0 },
			{ graph_id: "g", graph_run_id: "r", node_id: "n", invocation_id: "i", attempt: 1, unknown: true },
			{
				graph_id: "g",
				graph_run_id: "r",
				node_id: "n",
				invocation_id: "i",
				attempt: 1,
				upstream: [{ edge_id: "e", secret: "x" }],
			},
		])
			errorCode(() => validateGraphContext(value), "invalid_input");
		errorCode(() => store.admit(bot.bot_id, { command: "submit", input: " \n\t " }), "invalid_input");
		expect(store.snapshot(bot.bot_id).jobs).toEqual([]);
		expect(store.events(bot.bot_id, { after: cursor }).items).toEqual([]);
	});

	it("a rejected guard does not reserve its request key and retrying a successful guard returns its receipt", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		const command: BotCommand = { command: "stop", job_id: receipt.job_id!, key: "control", if_revision: "0" };
		errorCode(() => store.admit(bot.bot_id, command), "revision_conflict");
		command.if_revision = store.getJob(bot.bot_id, receipt.job_id!).revision;
		const admitted = store.admit(bot.bot_id, command);
		expect(store.admit(bot.bot_id, command)).toEqual(admitted);
	});

	it("profile and Bot ownership deny foreign Job, request, reference and cursor access", () => {
		const store = open();
		const a = store.createBot({ bot_name: "a" });
		const b = store.createBot({ bot_name: "b" });
		const receipt = submit(store, a.bot_id, "Private goal");
		const job = store.getJob(a.bot_id, receipt.job_id!);
		errorCode(() => store.getJob(b.bot_id, job.job_id), "unknown_job");
		errorCode(() => store.request(b.bot_id, receipt.request_id), "unknown_request");
		expect(store.inspect(b.bot_id, job.goal_ref!).availability).toBe("missing");
		errorCode(() => store.events(b.bot_id, { after: receipt.cursor }), "invalid_cursor");
		const isolated = open(path.join(temp!.path(), "other-profile"));
		isolated.createBot({ bot_name: "a" });
		expect(isolated.profile_id).not.toBe(store.profile_id);
		errorCode(() => isolated.snapshot(a.bot_id), "unknown_bot");
		fs.chmodSync(store.root, 0o755);
		try {
			errorCode(() => store.snapshot(a.bot_id), "permission_denied");
		} finally {
			fs.chmodSync(store.root, 0o700);
		}
	});

	it("pruning a settled Job keeps its request key reserved rather than executing again", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id, "Review cancellation", "retained-key");
		applyInput(store, bot.bot_id, receipt);
		store.consumeInput(bot.bot_id, receipt.job_id!, receipt.request_id);
		store.updateJob(bot.bot_id, receipt.job_id!, { state: "stopped", phase: "none", settled: true });
		store.pruneJob(bot.bot_id, receipt.job_id!);
		errorCode(() => submit(store, bot.bot_id, "Review cancellation", "retained-key"), "request_expired");
		errorCode(() => store.request(bot.bot_id, receipt.request_id), "request_expired");
		expect(store.snapshot(bot.bot_id).jobs).toEqual([]);
	});

	it("recreating a deleted Bot name uses a new identity and a separate idempotency namespace", () => {
		const store = open();
		const old = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, old.bot_id, "Old review", "same-key");
		store.deleteBot(old.bot_id);
		const current = store.createBot({ bot_name: "reviewer" });
		const next = submit(store, current.bot_id, "New review", "same-key");
		expect(next.bot_id).not.toBe(receipt.bot_id);
		expect(next.job_id).not.toBe(receipt.job_id);
		expect(store.getBot("reviewer").bot_id).toBe(current.bot_id);
	});
});

describe("Bot frozen capabilities and durable mailbox", () => {
	it("source skill edits and cwd overrides cannot expand already captured capabilities", async () => {
		const store = open();
		const source = path.join(temp!.path(), "skills");
		const cwd = path.join(temp!.path(), "project");
		fs.mkdirSync(cwd);
		await Bun.write(path.join(source, "review", "SKILL.md"), "Pinned reviewer rules");
		const bot = store.createBot({
			bot_name: "reviewer",
			skills_dirs: [source],
			system_prompt: "Original prompt",
			tools: ["read"],
		});
		await Bun.write(path.join(source, "review", "SKILL.md"), "Changed after definition");
		const original = submit(store, bot.bot_id);
		const override = store.admit(bot.bot_id, { command: "submit", input: "Other review", cwd });
		await Bun.write(path.join(source, "review", "SKILL.md"), "Changed after admission");
		const a = store.getJob(bot.bot_id, original.job_id!);
		const b = store.getJob(bot.bot_id, override.job_id!);
		expect(await Bun.file(path.join(a.config.skills_dirs[0]!, "review", "SKILL.md")).text()).toBe(
			"Pinned reviewer rules",
		);
		expect(await Bun.file(path.join(b.config.skills_dirs[0]!, "review", "SKILL.md")).text()).toBe(
			"Pinned reviewer rules",
		);
		expect(b.config.cwd).toBe(cwd);
		const expansion = { command: "submit", input: "Escalate", tools: ["write"] } as BotCommand;
		errorCode(() => store.admit(bot.bot_id, expansion), "invalid_input");
	});

	it("queue application is idempotent across two worker connections and consumed input never reappears", () => {
		const first = open();
		const bot = first.createBot({ bot_name: "reviewer" });
		const receipt = submit(first, bot.bot_id);
		const second = open(first.root);
		const input = { request_id: receipt.request_id, input: "Review cancellation" };
		expect(second.getJob(bot.bot_id, receipt.job_id!).pending_input_count).toBe(1);
		first.enqueueInput(bot.bot_id, receipt.job_id!, input);
		second.enqueueInput(bot.bot_id, receipt.job_id!, input);
		expect(second.getJob(bot.bot_id, receipt.job_id!).pending_input_count).toBe(1);
		first.finishRequest(bot.bot_id, receipt.request_id, "applied");
		second.claimWorker(bot.bot_id, "mailbox-owner", process.pid);
		const epoch = second.workerLease(bot.bot_id)!.owner_epoch;
		expect(
			second.claimInput(bot.bot_id, receipt.job_id!, receipt.request_id, "mailbox-owner", epoch)?.input.request_id,
		).toBe(receipt.request_id);
		expect(first.claimInput(bot.bot_id, receipt.job_id!, receipt.request_id, "mailbox-owner", epoch)).toBeNull();
		second.enqueueInput(bot.bot_id, receipt.job_id!, input);
		expect(first.getJob(bot.bot_id, receipt.job_id!).pending_input_count).toBe(0);
		const outcomes = drainEvents(first, bot.bot_id).filter(
			event => event.type === "request.finished" && event.request_id === receipt.request_id,
		);
		second.finishRequest(bot.bot_id, receipt.request_id, "cancelled");
		expect(outcomes).toHaveLength(1);
		expect(first.request(bot.bot_id, receipt.request_id).outcome).toBe("applied");
	});

	it("a post-admission input rejection stays queryable and removes only that rejected input from the runnable queue", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const initial = submit(store, bot.bot_id);
		applyInput(store, bot.bot_id, initial);
		const next = store.admit(bot.bot_id, { command: "send", job_id: initial.job_id!, input: "No longer valid" });
		store.finishRequest(bot.bot_id, next.request_id, "rejected", {
			code: "input_request_closed",
			message: "Question is closed",
			retryable: false,
		});
		expect(store.request(bot.bot_id, next.request_id)).toMatchObject({
			outcome: "rejected",
			effective_at: null,
			error: { code: "input_request_closed" },
		});
		store.claimWorker(bot.bot_id, "mailbox-owner", process.pid);
		const epoch = store.workerLease(bot.bot_id)!.owner_epoch;
		expect(
			store.claimInput(bot.bot_id, initial.job_id!, initial.request_id, "mailbox-owner", epoch)?.input.request_id,
		).toBe(initial.request_id);
		expect(store.claimInput(bot.bot_id, initial.job_id!, initial.request_id, "mailbox-owner", epoch)).toBeNull();
		const outcomes = drainEvents(store, bot.bot_id).filter(
			event => event.type === "request.finished" && event.request_id === next.request_id,
		);
		expect(outcomes).toHaveLength(1);
	});

	it("only one reply can reserve an exact input request and stop closes remaining questions", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		store.registerInputRequest(bot.bot_id, receipt.job_id!, {
			input_request_id: "question-1",
			kind: "text",
			prompt: "Which branch?",
		});
		const reply = store.admit(bot.bot_id, {
			command: "send",
			job_id: receipt.job_id!,
			reply_to: "question-1",
			input: "main",
			key: "reply",
		});
		expect(
			store.admit(bot.bot_id, {
				command: "send",
				job_id: receipt.job_id!,
				reply_to: "question-1",
				input: "main",
				key: "reply",
			}),
		).toEqual(reply);
		errorCode(
			() =>
				store.admit(bot.bot_id, {
					command: "send",
					job_id: receipt.job_id!,
					reply_to: "question-1",
					input: "other",
				}),
			"input_request_closed",
		);
		store.resolveInputRequest(bot.bot_id, receipt.job_id!, "question-1", reply.request_id);
		store.registerInputRequest(bot.bot_id, receipt.job_id!, {
			input_request_id: "question-2",
			kind: "approval",
			prompt: "Deploy?",
		});
		store.closeInputRequests(bot.bot_id, receipt.job_id!, "stop-request");
		errorCode(
			() =>
				store.admit(bot.bot_id, { command: "send", job_id: receipt.job_id!, reply_to: "question-2", input: "yes" }),
			"input_request_closed",
		);
	});

	it("invalid form replies leave the durable question open and stop discards only targeted replies", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const submitted = submit(store, bot.bot_id);
		store.registerInputRequest(bot.bot_id, submitted.job_id!, {
			input_request_id: "form",
			kind: "text",
			prompt: {
				questions: [
					{ id: "branch", question: "Branch?", options: [{ label: "main" }] },
					{ id: "checks", question: "Checks?", multi: true, options: [{ label: "types" }] },
				],
			},
		});
		errorCode(
			() => store.admit(bot.bot_id, { command: "send", job_id: submitted.job_id!, reply_to: "form", input: "main" }),
			"invalid_input",
		);
		expect(store.getJob(bot.bot_id, submitted.job_id!).input_requests[0]!.status).toBe("open");
		const reply = store.admit(bot.bot_id, {
			command: "send",
			job_id: submitted.job_id!,
			reply_to: "form",
			input: '{"branch":"main","checks":["types"]}',
		});
		const followup = store.admit(bot.bot_id, {
			command: "send",
			job_id: submitted.job_id!,
			input: "Keep this follow-up",
		});
		store.closeInputRequests(bot.bot_id, submitted.job_id!, "stop");
		expect(store.request(bot.bot_id, reply.request_id).outcome).toBe("cancelled");
		expect(store.getJob(bot.bot_id, submitted.job_id!).inputs.map(input => input.request_id)).toEqual([
			submitted.request_id,
			followup.request_id,
		]);
	});

	it("stop-all parent exposes independent child outcomes and rejects partial cleanup rather than reporting success", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		submit(store, bot.bot_id, "A");
		submit(store, bot.bot_id, "B");
		const receipt = store.admit(bot.bot_id, { command: "stop", all: true, key: "stop-run" });
		const children = store.request(bot.bot_id, receipt.request_id).children!;
		expect(children).toHaveLength(2);
		store.finishRequest(bot.bot_id, children[0]!.receipt.request_id, "applied");
		expect(store.request(bot.bot_id, receipt.request_id).outcome).toBe("pending");
		store.finishRequest(bot.bot_id, children[1]!.receipt.request_id, "rejected", {
			code: "cleanup_failed",
			message: "Process ownership uncertain",
			retryable: true,
		});
		const parent = store.request(bot.bot_id, receipt.request_id);
		expect(parent.outcome).toBe("rejected");
		expect(parent.error?.code).toBe("cleanup_failed");
		expect(parent.children!.map(child => child.outcome).sort()).toEqual(["applied", "rejected"]);
		expect(store.admit(bot.bot_id, { command: "stop", all: true, key: "stop-run" })).toEqual(receipt);
	});

	it("worker ownership excludes a competing live process, survives reconnects and rejects stale heartbeats", () => {
		const first = open();
		const bot = first.createBot({ bot_name: "reviewer" });
		const second = open(first.root);
		expect(first.claimWorker(bot.bot_id, "owner-a", process.pid)).toBe(true);
		expect(second.claimWorker(bot.bot_id, "owner-b", process.pid)).toBe(false);
		expect(second.snapshot(bot.bot_id).bot.worker.state).toBe("online");
		expect(second.heartbeatWorker(bot.bot_id, "owner-b")).toBe(false);
		first.releaseWorker(bot.bot_id, "owner-a");
		expect(second.snapshot(bot.bot_id).bot.worker.state).toBe("offline");
		expect(second.claimWorker(bot.bot_id, "owner-b", process.pid)).toBe(true);
		first.releaseWorker(bot.bot_id, "owner-a");
		expect(second.workerLease(bot.bot_id)?.owner_id).toBe("owner-b");
	});

	it("model switches persist the actual effective model across worker restarts without changing the frozen prompt", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer", system_prompt: "Pinned" });
		const receipt = submit(store, bot.bot_id);
		expect(store.getJob(bot.bot_id, receipt.job_id!).model.current).toBeNull();
		store.setJobModel(bot.bot_id, receipt.job_id!, "provider/actual-model");
		const second = open(store.root);
		const job = second.getJob(bot.bot_id, receipt.job_id!);
		expect(job.config.model).toBe("provider/actual-model");
		expect(job.model.current).toBe(job.config.model);
		expect(job.config.system_prompt).toBe("Pinned");
		expect(job.session_file).toBe(path.join(store.root, "sessions", `${job.job_id}.jsonl`));
	});
});

describe("Bot snapshot, replay, errors and protected detail", () => {
	it("snapshot pagination retains one immutable watermark while subsequent mutations replay strictly after it", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const a = submit(store, bot.bot_id, "A");
		const b = submit(store, bot.bot_id, "B");
		const first = store.snapshot(bot.bot_id, { limit: 1 });
		const captured = store.jobs(bot.bot_id).map(job => ({ job_id: job.job_id, revision: job.revision }));
		store.updateJob(bot.bot_id, b.job_id!, {
			phase: "retry_wait",
			wait: { kind: "retry", message: "Backoff", request_id: null, retry_at: null },
		});
		const c = submit(store, bot.bot_id, "C");
		const second = store.snapshot(bot.bot_id, { page_token: first.next_page_token! });
		expect(second.cursor).toEqual(first.cursor);
		expect(second.next_page_token).toBeNull();
		expect([...first.jobs, ...second.jobs].map(job => ({ job_id: job.job_id, revision: job.revision }))).toEqual(
			captured,
		);
		expect(first.bot.jobs_total).toBe(2);
		expect(second.bot.counts.queued).toBe(2);
		const replay = drainEvents(store, bot.bot_id, first.cursor);
		expect(replay.every(event => BigInt(event.cursor.seq) > BigInt(first.cursor.seq))).toBe(true);
		expect(replay.some(event => event.job_id === c.job_id)).toBe(true);
		const latest = new Map([...first.jobs, ...second.jobs].map(job => [job.job_id, job]));
		for (const event of replay)
			if (event.type === "job.changed") {
				const data = event.data as { job: { job_id: string; revision: string } };
				latest.set(data.job.job_id, data.job as (typeof first.jobs)[number]);
			}
		expect(
			Array.from(latest.values())
				.map(job => [job.job_id, job.revision])
				.sort(),
		).toEqual(
			store
				.snapshot(bot.bot_id)
				.jobs.map(job => [job.job_id, job.revision])
				.sort(),
		);
		const scoped = store.snapshot(bot.bot_id, a.job_id!);
		expect(scoped.jobs.map(job => job.job_id)).toEqual([a.job_id!]);
		expect(scoped.bot.jobs_total).toBe(3);
	});

	it("malformed, future and pruned cursors fail explicitly and foreign page tokens never expose another Bot", () => {
		const store = open();
		const a = store.createBot({ bot_name: "a" });
		const b = store.createBot({ bot_name: "b" });
		const start = store.snapshot(a.bot_id).cursor;
		submit(store, a.bot_id);
		const current = store.snapshot(a.bot_id).cursor;
		for (const seq of ["-1", "1.5", "01", "999999999999999999999999"])
			errorCode(() => store.events(a.bot_id, { after: { ...current, seq } }), "invalid_cursor");
		const page = store.events(a.bot_id, { limit: 1 });
		errorCode(() => store.events(b.bot_id, { page_token: page.next_page_token! }), "invalid_cursor");
		store.pruneEvents(a.bot_id, current);
		expect(errorCode(() => store.events(a.bot_id, { after: start }), "cursor_expired").details?.reset_required).toBe(
			true,
		);
		expect(store.events(a.bot_id, { after: current }).items).toEqual([]);
	});

	it("active-to-settled transitions publish once and frozen queued inputs remain counted on a stopped Job", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		applyInput(store, bot.bot_id, receipt);
		store.updateJob(bot.bot_id, receipt.job_id!, { state: "stopped", phase: "none", settled: true });
		store.updateJob(bot.bot_id, receipt.job_id!, { activity: null });
		const job = store.snapshot(bot.bot_id, receipt.job_id!).jobs[0]!;
		expect(job.pending_input_count).toBe(1);
		expect(job.settled).toBe(true);
		expect(drainEvents(store, bot.bot_id).filter(event => event.type === "job.settled")).toHaveLength(1);
		errorCode(() => store.updateJob(bot.bot_id, receipt.job_id!, { state: "idle", settled: true }), "invalid_input");
		expect(store.getJob(bot.bot_id, receipt.job_id!).state).toBe("stopped");
	});

	it("summaries are redacted, terminal-safe and bounded while authorized goal references preserve input", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const raw = `\x1b[31mReview\x1b[0m\x07 password=super-secret-value /Users/private/project/file ${"🧪".repeat(300)}`;
		const receipt = submit(store, bot.bot_id, raw);
		const job = store.snapshot(bot.bot_id, receipt.job_id!).jobs[0]!;
		expect(job.goal_preview).not.toContain("super-secret-value");
		expect(job.goal_preview).not.toContain("/Users/private");
		expect(job.goal_preview).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(Array.from(job.goal_preview).length).toBeLessThanOrEqual(240);
		expect(store.inspect(bot.bot_id, job.goal_ref!).content).toBe(raw);
		const event = store.emit(
			bot.bot_id,
			"span.started",
			{ span_id: "span", label: raw, detail_ref: null },
			{ job_id: receipt.job_id! },
		);
		expect(JSON.stringify(event.data)).not.toContain("super-secret-value");
	});

	it("protected details exclude reasoning and paginate text, messages and expired references explicitly", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		const ref = store.putRef(bot.bot_id, receipt.job_id!, {
			content: [
				{ type: "thinking", thinking: "Hidden chain" },
				{ type: "text", text: "Public answer" },
			],
			reasoning: "Other hidden chain",
		});
		expect(store.inspect(bot.bot_id, ref).content).toEqual({ content: [{ type: "text", text: "Public answer" }] });
		const reasoning = store.putRef(bot.bot_id, receipt.job_id!, { type: "reasoning", text: "Hidden" });
		expect(store.inspect(bot.bot_id, reasoning)).toMatchObject({ availability: "redacted", content: null });
		const text = "🧪".repeat(20_000);
		const longRef = store.putRef(bot.bot_id, receipt.job_id!, text, "text/plain");
		const first = store.inspect(bot.bot_id, longRef);
		const last = store.inspect(bot.bot_id, longRef, first.next_page_token!);
		expect(String(first.content) + String(last.content)).toBe(text);
		const structured = { tool_result: "x".repeat(20_000) };
		const structuredRef = store.putRef(bot.bot_id, receipt.job_id!, structured);
		const head = store.inspect(bot.bot_id, structuredRef);
		const remainder = store.inspect(bot.bot_id, structuredRef, head.next_page_token!);
		expect(JSON.parse(String(head.content) + String(remainder.content))).toEqual(structured);
		errorCode(() => store.inspect(bot.bot_id, ref, head.next_page_token!), "invalid_cursor");
		store.recordMessage(bot.bot_id, receipt.job_id!, { message_id: "m1", content: "draft" });
		store.recordMessage(bot.bot_id, receipt.job_id!, { message_id: "m1", content: "final" });
		store.recordMessage(bot.bot_id, receipt.job_id!, { message_id: "m2", content: "other" });
		const messages = store.messages(bot.bot_id, receipt.job_id!, undefined, 1);
		const tail = store.messages(bot.bot_id, receipt.job_id!, messages.next_page_token!, 1);
		expect(messages.items).toEqual([{ message_id: "m1", content: "final" }]);
		expect(tail.items).toEqual([{ message_id: "m2", content: "other" }]);
		store.expireRef(bot.bot_id, ref);
		expect(store.inspect(bot.bot_id, ref)).toMatchObject({ availability: "expired", content: null });
	});

	it("unknown usage remains null while a measured zero remains distinguishable after reconnecting", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		expect(store.snapshot(bot.bot_id).jobs[0]!.usage.input_tokens).toBeNull();
		const job = store.getJob(bot.bot_id, receipt.job_id!);
		store.updateJob(bot.bot_id, job.job_id, {
			usage: {
				...job.usage,
				input_tokens: 0,
				output_tokens: 0,
				completeness: "partial",
				measured_at: new Date().toISOString(),
			},
		});
		const second = open(store.root);
		expect(second.snapshot(bot.bot_id).jobs[0]!.usage).toMatchObject({
			input_tokens: 0,
			output_tokens: 0,
			cost_usd: null,
			completeness: "partial",
		});
		errorCode(
			() => store.updateJob(bot.bot_id, job.job_id, { usage: { ...job.usage, input_tokens: -1 } }),
			"invalid_input",
		);
	});
});

describe("Bot durable claims and revision samples", () => {
	it("retains initializing input evidence and fences the old owner after replacement", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id, "Never replay this effect");
		store.finishRequest(bot.bot_id, receipt.request_id, "applied");
		expect(store.claimWorker(bot.bot_id, "first", process.pid)).toBe(true);
		const epoch = store.workerLease(bot.bot_id)!.owner_epoch;
		const claim = store.claimInput(bot.bot_id, receipt.job_id!, receipt.request_id, "first", epoch)!;
		expect(store.getJob(bot.bot_id, receipt.job_id!)).toMatchObject({
			settled: false,
			pending_input_count: 0,
			ownership: { state: "active", activation_ref: claim.activation.activation_ref },
		});
		expect(
			store.inspect(bot.bot_id, claim.activation.activation_ref, undefined, receipt.job_id!).content,
		).toMatchObject({
			execution_id: null,
			request_id: receipt.request_id,
			input_ref: claim.activation.input_ref,
			stage: "initializing",
		});
		expect(store.inspect(bot.bot_id, claim.activation.input_ref!, undefined, receipt.job_id!).content).toBe(
			"Never replay this effect",
		);
		store.releaseWorker(bot.bot_id, "first");
		expect(store.claimWorker(bot.bot_id, "replacement", process.pid)).toBe(true);
		errorCode(
			() => store.claimInput(bot.bot_id, receipt.job_id!, receipt.request_id, "first", epoch),
			"invalid_state",
		);
		store.interruptOwnership(bot.bot_id, receipt.job_id!, {
			code: "worker_lost",
			message: "Lost claim",
			retryable: false,
		});
		expect(store.getJob(bot.bot_id, receipt.job_id!)).toMatchObject({
			state: "interrupted",
			settled: false,
			ownership: { state: "uncertain" },
		});
	});

	it("materializes the same timing sample for each revision without losing the current interval", () => {
		setSystemTime(1_000_000);
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		store.finishRequest(bot.bot_id, receipt.request_id, "applied");
		store.claimWorker(bot.bot_id, "owner", process.pid);
		const epoch = store.workerLease(bot.bot_id)!.owner_epoch;
		store.claimInput(bot.bot_id, receipt.job_id!, receipt.request_id, "owner", epoch);
		store.updateJob(bot.bot_id, receipt.job_id!, { execution_id: "execution", phase: "model" });
		setSystemTime(1_000_043);
		store.updateJob(bot.bot_id, receipt.job_id!, { phase: "tool" });
		const sample = store.snapshot(bot.bot_id).jobs[0]!;
		expect(sample.active_ms).toBe(43);
		setSystemTime(1_000_060);
		expect(store.snapshot(bot.bot_id).jobs[0]).toEqual(sample);
		const changed = drainEvents(store, bot.bot_id)
			.filter(event => event.type === "job.changed")
			.at(-1)!;
		expect(changed.data).toEqual({ job: sample });
		store.updateJob(bot.bot_id, receipt.job_id!, { phase: "model" });
		const newer = store.snapshot(bot.bot_id).jobs[0]!;
		expect(BigInt(newer.revision)).toBeGreaterThan(BigInt(sample.revision));
		expect(newer.active_ms).toBe(60);
		store.updateJob(bot.bot_id, receipt.job_id!, { execution_id: null, phase: "input", state: "waiting_input" });
		const waiting = store.snapshot(bot.bot_id).jobs[0]!;
		setSystemTime(1_001_060);
		store.updateJob(bot.bot_id, receipt.job_id!, {
			wait: { kind: "input", message: "Waiting", request_id: null, retry_at: null },
		});
		expect(store.snapshot(bot.bot_id).jobs[0]!.active_ms).toBe(waiting.active_ms);
	});

	it("keeps private lease renewal out of snapshots until an explicit journaled publication", () => {
		setSystemTime(2_000_000);
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		store.claimWorker(bot.bot_id, "owner", process.pid);
		const before = store.snapshot(bot.bot_id);
		setSystemTime(2_003_000);
		expect(store.heartbeatWorker(bot.bot_id, "owner")).toBe(true);
		expect(store.snapshot(bot.bot_id)).toEqual(before);
		expect(store.publishWorker(bot.bot_id, "owner")).toBe(true);
		const published = store.snapshot(bot.bot_id);
		expect(published.bot.worker.last_seen_at).not.toBe(before.bot.worker.last_seen_at);
		expect(BigInt(published.cursor.seq)).toBeGreaterThan(BigInt(before.cursor.seq));
		const events = drainEvents(store, bot.bot_id, before.cursor);
		expect(events.filter(event => event.type === "bot.changed")).toHaveLength(1);
		expect(events[0]!.data).toEqual({ bot: published.bot });
	});

	it("bootstraps typed questions after pruning and releases only definitively rejected reservations", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		store.registerInputRequest(bot.bot_id, receipt.job_id!, {
			input_request_id: "branch",
			kind: "text",
			prompt: { title: "Branch", options: ["main", "release"] },
		});
		const watermark = store.snapshot(bot.bot_id).cursor;
		store.pruneEvents(bot.bot_id, watermark);
		const openQuestion = store.snapshot(bot.bot_id).jobs[0]!.input_requests[0]!;
		expect(openQuestion).toMatchObject({ status: "open", reply_request_id: null, completion_reason: null });
		expect(store.inspect(bot.bot_id, openQuestion.prompt_ref, undefined, receipt.job_id!)).toMatchObject({
			media_type: "application/vnd.omp.bot-question+json",
			content: {
				schema_version: 1,
				reply_encoding: "text",
				fields: [{ mode: "single", allow_custom: false, options: [{ value: "main" }, { value: "release" }] }],
			},
		});
		const rejected = store.admit(bot.bot_id, {
			command: "send",
			job_id: receipt.job_id!,
			reply_to: "branch",
			input: "main",
		});
		expect(store.snapshot(bot.bot_id).jobs[0]!.input_requests[0]).toMatchObject({
			status: "reply_queued",
			reply_request_id: rejected.request_id,
		});
		store.finishRequest(bot.bot_id, rejected.request_id, "rejected", {
			code: "invalid_input",
			message: "Definitively unconsumed",
			retryable: false,
		});
		expect(store.snapshot(bot.bot_id).jobs[0]!.input_requests[0]).toMatchObject({
			status: "open",
			reply_request_id: null,
		});
		const applied = store.admit(bot.bot_id, {
			command: "send",
			job_id: receipt.job_id!,
			reply_to: "branch",
			input: "release",
		});
		store.finishRequest(bot.bot_id, applied.request_id, "applied");
		store.releaseInputReservation(bot.bot_id, receipt.job_id!, applied.request_id);
		expect(store.snapshot(bot.bot_id).jobs[0]!.input_requests[0]).toMatchObject({
			status: "reply_queued",
			reply_request_id: applied.request_id,
		});
	});

	it("holds cleanup uncertainty at zero counts and never regresses a final launch disposition", () => {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id);
		store.finishRequest(bot.bot_id, receipt.request_id, "applied");
		store.claimWorker(bot.bot_id, "owner", process.pid);
		store.claimInput(
			bot.bot_id,
			receipt.job_id!,
			receipt.request_id,
			"owner",
			store.workerLease(bot.bot_id)!.owner_epoch,
		);
		store.setSessionOwner(bot.bot_id, receipt.job_id!, "session", "3");
		store.recordLaunchIntent(bot.bot_id, receipt.job_id!, {
			launch_intent_id: "launch",
			session_owner_id: "session",
			owner_epoch: "3",
			payload: { command: "side effect" },
		});
		errorCode(() => store.closeOwnership(bot.bot_id, receipt.job_id!), "cleanup_failed");
		store.interruptOwnership(bot.bot_id, receipt.job_id!, {
			code: "cleanup_failed",
			message: "Broker unavailable",
			retryable: true,
		});
		expect(store.getJob(bot.bot_id, receipt.job_id!)).toMatchObject({
			settled: false,
			pending_background_count: 0,
			pending_delivery_count: 0,
			ownership: { state: "uncertain" },
		});
		const final = {
			state: "cancelled_before_launch" as const,
			service: null,
			outcome: null,
			final: true,
			error: null,
		};
		store.updateLaunchIntent(bot.bot_id, receipt.job_id!, "launch", final);
		store.updateLaunchIntent(bot.bot_id, receipt.job_id!, "launch", {
			state: "pending",
			service: null,
			outcome: null,
			final: false,
			error: null,
		});
		expect(store.launchIntents(bot.bot_id, receipt.job_id!)[0]!.disposition).toEqual(final);
		store.closeOwnership(bot.bot_id, receipt.job_id!);
		expect(store.getJob(bot.bot_id, receipt.job_id!).ownership.state).toBe("none");
	});
});

describe("Bot schema-one migration", () => {
	function legacyFixture(liveOwner = false): {
		root: string;
		botId: string;
		receipt: Receipt;
		goalRef: string;
		oldQuestionRef: string;
	} {
		const store = open();
		const bot = store.createBot({ bot_name: "reviewer" });
		const receipt = submit(store, bot.bot_id, "Legacy retained input", "legacy-key");
		const job = store.getJob(bot.bot_id, receipt.job_id!);
		const oldQuestionRef = store.putRef(bot.bot_id, job.job_id, {
			title: "Legacy branch",
			options: ["main", "release"],
		});
		const {
			ownership: _ownership,
			session_owner_id: _sessionOwner,
			owner_epoch: _epoch,
			launch_intents: _intents,
			input_requests: _questions,
			...legacyJob
		} = job;
		const legacy = {
			...legacyJob,
			input_requests: [
				{
					input_request_id: "legacy-question",
					kind: "text",
					prompt: { title: "Legacy branch", options: ["main", "release"] },
					prompt_ref: oldQuestionRef,
					resolved_by: null,
				},
			],
		};
		legacy.state = "running";
		legacy.phase = "model";
		legacy.execution_id = "legacy-execution";
		legacy.settled = false;
		const root = store.root;
		store.close();
		connections.splice(connections.indexOf(store), 1);
		const db = new Database(path.join(root, "bots.sqlite"));
		try {
			const guards = db
				.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'bot_writer_guard_%'")
				.all() as Array<{ name: string }>;
			for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
			db.exec(
				"DROP TABLE activations; ALTER TABLE bots DROP COLUMN owner_epoch; ALTER TABLE jobs DROP COLUMN active_accum;",
			);
			db.query("UPDATE metadata SET value='1' WHERE key='schema_version'").run();
			db.query("UPDATE jobs SET data=?,active_since=? WHERE job_id=?").run(
				JSON.stringify(legacy),
				job.updated_at,
				job.job_id,
			);
			if (liveOwner)
				db.query("UPDATE bots SET lease=? WHERE bot_id=?").run(
					JSON.stringify({
						owner_id: "legacy-live",
						pid: process.pid,
						last_seen_at: job.updated_at,
						expires_at: job.updated_at,
					}),
					bot.bot_id,
				);
		} finally {
			db.close();
		}
		return { root, botId: bot.bot_id, receipt, goalRef: job.goal_ref!, oldQuestionRef };
	}

	it("backs up the complete SQLite image and retains identity, keys, refs and uncertain legacy ownership", () => {
		const fixture = legacyFixture();
		const source = new Database(path.join(fixture.root, "bots.sqlite"));
		let upgraded: BotStore;
		try {
			source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
			source
				.query("INSERT INTO metadata(key,value) VALUES ('backup_wal_marker','latest committed WAL value')")
				.run();
			upgraded = open(fixture.root);
		} finally {
			source.close();
		}
		expect(upgraded.getBot("reviewer").bot_id).toBe(fixture.botId);
		expect(submit(upgraded, fixture.botId, "Legacy retained input", "legacy-key")).toEqual(fixture.receipt);
		expect(upgraded.inspect(fixture.botId, fixture.goalRef).content).toBe("Legacy retained input");
		const job = upgraded.getJob(fixture.botId, fixture.receipt.job_id!);
		expect(job).toMatchObject({
			state: "interrupted",
			execution_id: null,
			settled: false,
			ownership: { state: "uncertain" },
		});
		expect(
			upgraded.inspect(fixture.botId, job.ownership.activation_ref!, undefined, job.job_id).content,
		).toMatchObject({ stage: "interrupted", recovery: "inspection_required" });
		const question = upgraded.snapshot(fixture.botId).jobs[0]!.input_requests[0]!;
		expect(question).toMatchObject({ input_request_id: "legacy-question", status: "open", reply_request_id: null });
		expect(question.prompt_ref).not.toBe(fixture.oldQuestionRef);
		expect(upgraded.inspect(fixture.botId, question.prompt_ref)).toMatchObject({
			media_type: "application/vnd.omp.bot-question+json",
			content: { schema_version: 1, input_request_id: "legacy-question", reply_encoding: "text" },
		});
		expect(upgraded.inspect(fixture.botId, fixture.oldQuestionRef).content).toEqual({
			title: "Legacy branch",
			options: ["main", "release"],
		});
		const backups = fs
			.readdirSync(fixture.root)
			.filter(name => name.startsWith("bots.sqlite.schema1-") && name.endsWith(".backup"));
		expect(backups).toHaveLength(1);
		const standalone = path.join(fixture.root, "standalone-backup");
		fs.mkdirSync(standalone, { mode: 0o700 });
		const backupPath = path.join(standalone, "schema1.sqlite");
		fs.copyFileSync(path.join(fixture.root, backups[0]!), backupPath);
		const backup = new Database(backupPath, { readonly: true });
		try {
			expect(backup.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
			expect(backup.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
			expect(backup.query("SELECT value FROM metadata WHERE key='backup_wal_marker'").get()).toEqual({
				value: "latest committed WAL value",
			});
			expect(backup.query("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: "1" });
			expect(backup.query("SELECT job_id FROM jobs").get()).toEqual({ job_id: fixture.receipt.job_id });
			expect(backup.query("SELECT request_id FROM requests WHERE key='legacy-key'").get()).toEqual({
				request_id: fixture.receipt.request_id,
			});
		} finally {
			backup.close();
		}
		expect(fs.readdirSync(standalone)).toEqual(["schema1.sqlite"]);
	});

	it("refuses an expired lease whose legacy process is still alive before changing schema or creating a backup", () => {
		const fixture = legacyFixture(true);
		errorCode(() => new BotStore(fixture.root), "invalid_state");
		const db = new Database(path.join(fixture.root, "bots.sqlite"), { readonly: true });
		try {
			expect(db.query("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({ value: "1" });
			expect(db.query("SELECT name FROM pragma_table_info('bots') WHERE name='owner_epoch'").all()).toEqual([]);
			expect(db.query("SELECT name FROM sqlite_master WHERE name='activations'").all()).toEqual([]);
		} finally {
			db.close();
		}
		expect(fs.readdirSync(fixture.root).some(name => name.includes(".schema1-"))).toBe(false);
	});

	it("fences an already-open legacy connection after migration commits", () => {
		const fixture = legacyFixture();
		const oldWriter = new Database(path.join(fixture.root, "bots.sqlite"));
		try {
			const upgraded = open(fixture.root);
			const before = upgraded.snapshot(fixture.botId);
			expect(() =>
				oldWriter.query("UPDATE jobs SET data=data WHERE job_id=?").run(fixture.receipt.job_id!),
			).toThrow();
			expect(upgraded.snapshot(fixture.botId)).toEqual(before);
		} finally {
			oldWriter.close();
		}
	});
});

it("commits cancellation outcome and stopped projection atomically", () => {
	const store = open();
	const bot = store.createBot({ bot_name: "atomic-stop" });
	const submitted = submit(store, bot.bot_id, "work");
	const stop = store.admit(bot.bot_id, { command: "stop", job_id: submitted.job_id! });
	expect(store.claimWorker(bot.bot_id, "owner", process.pid)).toBe(true);
	const epoch = store.workerLease(bot.bot_id)!.owner_epoch;
	const db = new Database(path.join(store.root, "bots.sqlite"));
	try {
		db.exec(`CREATE TRIGGER fail_stop_projection BEFORE UPDATE ON jobs
			WHEN json_extract(NEW.data, '$.state') = 'stopped'
			BEGIN SELECT RAISE(ABORT, 'injected stop projection failure'); END`);
		expect(() =>
			store.finishCancellation(bot.bot_id, submitted.job_id!, stop.request_id, "owner", epoch, "stop"),
		).toThrow();
		expect(store.request(bot.bot_id, stop.request_id).outcome).toBe("pending");
		expect(store.getJob(bot.bot_id, submitted.job_id!).state).not.toBe("stopped");
		db.exec("DROP TRIGGER fail_stop_projection");
		store.finishCancellation(bot.bot_id, submitted.job_id!, stop.request_id, "owner", epoch, "stop");
		expect(store.request(bot.bot_id, stop.request_id).outcome).toBe("applied");
		expect(store.getJob(bot.bot_id, submitted.job_id!)).toMatchObject({ state: "stopped", settled: true });
	} finally {
		db.close();
	}
});

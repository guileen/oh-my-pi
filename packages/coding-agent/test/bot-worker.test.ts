import { afterEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BotRuntime, BotRuntimeCallbacks, BotRuntimeEvent, BotRuntimeState } from "../src/bots/agent-runtime";
import { BotService } from "../src/bots/service";
import { BotStore } from "../src/bots/store";
import type { BotJob } from "../src/bots/types";
import { BotWorker } from "../src/bots/worker";
import * as daemonClient from "../src/launch/client";
import type { DaemonBrokerClient } from "../src/launch/client";

class ControlledRuntime implements BotRuntime {
	readonly inputs: string[] = [];
	readonly #emit: (event: BotRuntimeEvent) => void;
	readonly #onContinuation: BotRuntimeCallbacks["onContinuation"];
	#turn = Promise.withResolvers<void>();
	#model = "fixture/one";
	#streaming = false;
	#background = 0;
	#question: string | null = null;
	#compactions = 0;
	contextUsed = 20;
	questionPrompt: unknown = { question: "Which branch?" };
	cleanupFails = false;
	compactGate: Promise<void> | undefined;

	constructor(emit: (event: BotRuntimeEvent) => void, onContinuation?: BotRuntimeCallbacks["onContinuation"]) {
		this.#emit = emit;
		this.#onContinuation = onContinuation;
	}
	prompt(input: string): Promise<void> {
		this.inputs.push(input);
		this.#turn = Promise.withResolvers<void>();
		this.#streaming = true;
		this.#emit({ type: "execution_start" });
		return this.#turn.promise;
	}
	async steer(input: string): Promise<void> {
		this.inputs.push(input);
	}
	async abort(): Promise<void> {
		if (this.cleanupFails) throw new Error("Owned process did not terminate");
		this.#streaming = false;
		this.#background = 0;
		this.#question = null;
		this.#emit({ type: "execution_end", outcome: "cancelled" });
		this.#turn.resolve();
	}
	async stop(): Promise<void> {
		await this.abort();
	}
	async compact(): Promise<void> {
		await this.compactGate;
		this.#compactions++;
		this.#emit({ type: "span_start", span_id: `compact-${this.#compactions}`, kind: "compaction", label: "qaonly" });
		this.#emit({
			type: "span_end",
			span_id: `compact-${this.#compactions}`,
			kind: "compaction",
			label: "qaonly",
			outcome: "ok",
		});
	}
	async setModel(model: string): Promise<void> {
		if (model === "fixture/incompatible") throw new Error("Incompatible context");
		this.#model = model;
	}
	messages(): unknown[] {
		return this.inputs.map(content => ({ role: "user", content }));
	}
	state(): BotRuntimeState {
		return {
			model: this.#model,
			is_streaming: this.#streaming,
			waiting_input_count: this.#question ? 1 : 0,
			waiting_input_requests: this.#question
				? [{ input_request_id: this.#question, kind: "text", prompt: this.questionPrompt }]
				: [],
			pending_background_count: this.#background,
			pending_delivery_count: 0,
			context: { used_tokens: this.contextUsed, limit_tokens: 1000 },
			progress: null,
			session_file: null,
		};
	}
	async dispose(): Promise<void> {
		await this.abort();
	}
	reply(id: string, input: string): Promise<void> {
		if (id !== this.#question) throw new Error("Wrong question");
		this.#question = null;
		this.#emit({ type: "input_resolved", input_request_id: id });
		return this.prompt(input);
	}
	question(id: string): void {
		this.#question = id;
		this.#emit({ type: "input_required", input_request_id: id, kind: "text", prompt: this.questionPrompt });
		this.#turn.resolve();
	}
	async timeout(input: string): Promise<void> {
		const question = this.#question;
		if (!question) throw new Error("No question is open");
		await this.#onContinuation?.({
			continuation_id: crypto.randomUUID(),
			origin: "timeout",
			input_request_id: question,
			payload: input,
		});
		await this.reply(question, input);
	}
	finish(text: string, background = 0, cost: string | null = null): void {
		this.#streaming = false;
		this.#background = background;
		this.#emit({ type: "output", text, final: true, message_id: crypto.randomUUID() });
		this.#emit({
			type: "usage",
			input_tokens: 10,
			output_tokens: 0,
			cache_read_tokens: null,
			cache_write_tokens: null,
			cost_usd: cost,
		});
		this.#emit({ type: "execution_end", outcome: "returned" });
		this.#turn.resolve();
	}
	backgroundDone(): void {
		this.#background = 0;
		this.#emit({ type: "state" });
	}
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	setSystemTime();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function harness() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-worker-"));
	const store = new BotStore(root);
	const bot = store.createBot({ bot_name: "reviewer", cwd: root });
	const runtimes = new Map<string, ControlledRuntime>();
	const runtimeCallbacks = new Map<string, BotRuntimeCallbacks>();
	const worker = new BotWorker(store, bot.bot_id, async (job: BotJob, callbacks) => {
		runtimeCallbacks.set(job.job_id, callbacks);
		const runtime = new ControlledRuntime(callbacks.onEvent, callbacks.onContinuation);
		runtimes.set(job.job_id, runtime);
		return runtime;
	});
	expect(worker.claim()).toBe(true);
	cleanups.push(async () => {
		for (const runtime of runtimes.values()) runtime.cleanupFails = false;
		await worker.close();
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return { root, store, bot, worker, runtimes, runtimeCallbacks };
}
async function drain(worker: BotWorker): Promise<void> {
	await Promise.resolve();
	await worker.tick();
	await Promise.resolve();
}

describe("Bot Job ownership and observable lifecycle", () => {
	for (const failurePoint of ["state", "session persistence"] as const) {
		for (const cleanupFails of [false, true]) {
			test(`initialization ${failurePoint} failure ${cleanupFails ? "retains uncertain ownership" : "cleans up the runtime"}`, async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-init-"));
				const store = new BotStore(root);
				const bot = store.createBot({ bot_name: "reviewer", cwd: root });
				let failCleanup = cleanupFails;
				let stops = 0;
				let disposals = 0;
				let created = 0;
				let runtime: ControlledRuntime | undefined;
				const worker = new BotWorker(store, bot.bot_id, async (_job, callbacks) => {
					created++;
					runtime = new ControlledRuntime(callbacks.onEvent);
					const originalState = runtime.state.bind(runtime);
					runtime.state = () => {
						if (failurePoint === "state") throw new Error("state unavailable");
						return { ...originalState(), session_file: "fixture-session" };
					};
					runtime.stop = async () => {
						stops++;
						if (failCleanup) throw new Error("stop failed");
					};
					runtime.dispose = async () => {
						disposals++;
						if (failCleanup) throw new Error("dispose failed");
					};
					return runtime;
				});
				if (failurePoint === "session persistence")
					vi.spyOn(store, "setSessionFile").mockImplementation(() => {
						throw new Error("session persistence failed");
					});
				expect(worker.claim()).toBe(true);
				cleanups.push(async () => {
					failCleanup = false;
					await worker.close();
					store.close();
					await fs.rm(root, { recursive: true, force: true });
				});
				const receipt = store.admit(bot.bot_id, { command: "submit", input: "Do not replay" });
				await worker.tick();
				await drain(worker);
				const job = store.getJob(bot.bot_id, receipt.job_id!);
				expect(stops).toBe(1);
				expect(disposals).toBe(cleanupFails ? 0 : 1);
				expect(runtime?.inputs).toEqual([]);
				expect(created).toBe(1);
				expect(job.state).toBe(cleanupFails ? "interrupted" : "failed");
				expect(job.settled).toBe(!cleanupFails);
				expect(job.ownership.state).toBe(cleanupFails ? "uncertain" : "none");
				if (cleanupFails) {
					await worker.tick();
					expect(created).toBe(1);
					await expect(worker.close()).rejects.toThrow("did not confirm cleanup");
					expect(disposals).toBe(0);
					expect(store.workerLease(bot.bot_id)?.owner_id).toBeDefined();
					failCleanup = false;
					await worker.close();
					expect(stops).toBe(3);
					expect(disposals).toBe(1);
				}
			});
		}
	}

	test("one Bot serializes isolated Jobs and does not report idle while background work remains", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const first = store.admit(bot.bot_id, { command: "submit", input: "PR123" });
		const second = store.admit(bot.bot_id, { command: "submit", input: "PR456" });
		await worker.tick();
		expect(runtimes.get(first.job_id!)?.inputs).toEqual(["PR123"]);
		expect(store.getJob(bot.bot_id, second.job_id!).state).toBe("queued");
		runtimes.get(first.job_id!)!.finish("Partial answer", 1);
		await drain(worker);
		const pending = store.getJob(bot.bot_id, first.job_id!);
		expect([pending.state, pending.phase, pending.settled, pending.pending_background_count]).toEqual([
			"running",
			"background",
			false,
			1,
		]);
		expect(runtimes.has(second.job_id!)).toBe(false);
		runtimes.get(first.job_id!)!.backgroundDone();
		await drain(worker);
		expect(store.getJob(bot.bot_id, first.job_id!).state).toBe("idle");
		expect(runtimes.get(second.job_id!)?.inputs).toEqual(["PR456"]);
		const usage = store.getJob(bot.bot_id, first.job_id!).usage;
		expect([usage.output_tokens, usage.cache_read_tokens, usage.cost_usd, usage.completeness]).toEqual([
			0,
			null,
			null,
			"partial",
		]);
	});

	test("stop freezes queued input, cancels maintenance and cannot be undone by a late result", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const submitted = store.admit(bot.bot_id, { command: "submit", input: "Work" });
		await worker.tick();
		const id = submitted.job_id!;
		store.admit(bot.bot_id, { command: "send", job_id: id, input: "Later" });
		const compact = store.admit(bot.bot_id, { command: "compact", job_id: id });
		const stop = store.admit(bot.bot_id, { command: "stop", job_id: id });
		await drain(worker);
		expect(store.request(bot.bot_id, stop.request_id).outcome).toBe("applied");
		expect(store.request(bot.bot_id, compact.request_id).outcome).toBe("cancelled");
		expect(store.getJob(bot.bot_id, id).state).toBe("stopped");
		expect(store.getJob(bot.bot_id, id).pending_input_count).toBe(1);
		runtimes.get(id)!.finish("Late evidence");
		await drain(worker);
		expect(store.getJob(bot.bot_id, id).state).toBe("stopped");
		expect(runtimes.get(id)!.inputs).toEqual(["Work"]);
		const events = store.events(bot.bot_id, { limit: 1000 }).items;
		const outcomeIndex = events.findIndex(
			event => event.type === "request.finished" && event.request_id === stop.request_id,
		);
		const settledIndex = events.findIndex((event, index) => index > outcomeIndex && event.type === "job.settled");
		expect(settledIndex).toBeGreaterThan(outcomeIndex);
	});

	test("waiting input releases Bot capacity and a targeted reply resumes only the owning Job", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const first = store.admit(bot.bot_id, { command: "submit", input: "Need branch" });
		await worker.tick();
		store.admit(bot.bot_id, { command: "send", job_id: first.job_id!, input: "Deferred follow-up" });
		runtimes.get(first.job_id!)!.question("question-1");
		await drain(worker);
		expect(store.getJob(bot.bot_id, first.job_id!).state).toBe("waiting_input");
		const second = store.admit(bot.bot_id, { command: "submit", input: "Independent" });
		await worker.tick();
		expect(runtimes.get(second.job_id!)!.inputs).toEqual(["Independent"]);
		store.admit(bot.bot_id, { command: "send", job_id: first.job_id!, reply_to: "question-1", input: "main" });
		await worker.tick();
		expect(runtimes.get(first.job_id!)!.inputs).toEqual(["Need branch"]);
		runtimes.get(second.job_id!)!.finish("Done");
		await drain(worker);
		expect(runtimes.get(first.job_id!)!.inputs).toEqual(["Need branch", "main"]);
		expect(() =>
			store.admit(bot.bot_id, { command: "send", job_id: first.job_id!, reply_to: "question-1", input: "other" }),
		).toThrow("already resolved");
	});

	test("a pending model change is visible, applies at the boundary and survives runtime reconstruction", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const receipt = store.admit(bot.bot_id, { command: "submit", input: "Work" });
		await worker.tick();
		const change = store.admit(bot.bot_id, { command: "set-model", job_id: receipt.job_id!, model: "fixture/two" });
		await worker.tick();
		expect(store.getJob(bot.bot_id, receipt.job_id!).model).toEqual({
			current: "fixture/one",
			pending: "fixture/two",
		});
		runtimes.get(receipt.job_id!)!.finish("Ready");
		await drain(worker);
		expect(store.request(bot.bot_id, change.request_id).outcome).toBe("applied");
		expect(store.getJob(bot.bot_id, receipt.job_id!).config.model).toBe("fixture/two");
	});

	test("crash recovery exposes uncertainty and does not replay prior input", async () => {
		const { root, store, bot, worker } = await harness();
		const receipt = store.admit(bot.bot_id, { command: "submit", input: "Side effect" });
		await worker.tick();
		await worker.close();
		const called: string[] = [];
		const recovered = new BotWorker(store, bot.bot_id, async (_job, callbacks) => {
			called.push("created");
			return new ControlledRuntime(callbacks.onEvent);
		});
		expect(recovered.claim()).toBe(true);
		cleanups.push(() => recovered.close());
		expect(store.getJob(bot.bot_id, receipt.job_id!).state).toBe("interrupted");
		await recovered.tick();
		expect(called).toEqual([]);
		const service = new BotService(root, { ensure_worker: async () => {} });
		try {
			expect(service.status("reviewer").jobs[0]!.settled).toBe(false);
		} finally {
			await service.close();
		}
	});

	test("whole-Bot stop exposes partial cleanup failure rather than false success", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const first = store.admit(bot.bot_id, { command: "submit", input: "Owned process" });
		await worker.tick();
		runtimes.get(first.job_id!)!.cleanupFails = true;
		store.admit(bot.bot_id, { command: "submit", input: "Queued" });
		const stop = store.admit(bot.bot_id, { command: "stop", all: true });
		await drain(worker);
		const result = store.request(bot.bot_id, stop.request_id);
		expect(result.outcome).toBe("rejected");
		expect(result.error?.code).toBe("cleanup_failed");
		expect(result.children?.map(child => child.outcome).sort()).toEqual(["applied", "rejected"]);
		expect(store.getJob(bot.bot_id, first.job_id!).state).toBe("interrupted");
	});

	test("failed cancellation retains capacity until the uncertain owner confirms cleanup", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const first = store.admit(bot.bot_id, { command: "submit", input: "Owned work" });
		await worker.tick();
		runtimes.get(first.job_id!)!.cleanupFails = true;
		const second = store.admit(bot.bot_id, { command: "submit", input: "Must wait" });
		const interrupt = store.admit(bot.bot_id, { command: "interrupt", job_id: first.job_id! });
		await worker.tick();
		expect(store.request(bot.bot_id, interrupt.request_id).outcome).toBe("rejected");
		expect(store.getJob(bot.bot_id, first.job_id!).settled).toBe(false);
		expect(runtimes.has(second.job_id!)).toBe(false);
		runtimes.get(first.job_id!)!.cleanupFails = false;
		store.admit(bot.bot_id, { command: "stop", job_id: first.job_id! });
		await drain(worker);
		expect(runtimes.get(second.job_id!)!.inputs).toEqual(["Must wait"]);
	});

	test("input admitted during awaited maintenance executes once, after its admission is applied", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const first = store.admit(bot.bot_id, { command: "submit", input: "Initial" });
		await worker.tick();
		const runtime = runtimes.get(first.job_id!)!;
		runtime.finish("Ready");
		await drain(worker);
		const gate = Promise.withResolvers<void>();
		runtime.compactGate = gate.promise;
		store.admit(bot.bot_id, { command: "compact", job_id: first.job_id! });
		const tick = worker.tick();
		await Promise.resolve();
		const late = store.admit(bot.bot_id, { command: "send", job_id: first.job_id!, input: "One side effect" });
		gate.resolve();
		await tick;
		expect(runtime.inputs).toEqual(["Initial"]);
		expect(store.request(bot.bot_id, late.request_id).outcome).toBe("pending");
		await worker.tick();
		expect(runtime.inputs).toEqual(["Initial", "One side effect"]);
		runtime.finish("Applied");
		await drain(worker);
		expect(runtime.inputs).toEqual(["Initial", "One side effect"]);
	});

	test("a steer applied after foreground yield retains its place before a later follow-up", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const first = store.admit(bot.bot_id, { command: "submit", input: "Initial" });
		await worker.tick();
		const runtime = runtimes.get(first.job_id!)!;
		store.admit(bot.bot_id, { command: "steer", job_id: first.job_id!, input: "Earlier steer" });
		store.admit(bot.bot_id, { command: "send", job_id: first.job_id!, input: "Later follow-up" });
		runtime.finish("Yielded");
		await drain(worker);
		expect(runtime.inputs).toEqual(["Initial", "Earlier steer"]);
		runtime.finish("Steered");
		await drain(worker);
		expect(runtime.inputs).toEqual(["Initial", "Earlier steer", "Later follow-up"]);
	});

	test("sub-microdollar costs accumulate exactly as decimal strings", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const first = store.admit(bot.bot_id, { command: "submit", input: "Initial" });
		await worker.tick();
		const runtime = runtimes.get(first.job_id!)!;
		runtime.finish("First", 0, "0.0000001");
		await drain(worker);
		store.admit(bot.bot_id, { command: "send", job_id: first.job_id!, input: "Second" });
		await worker.tick();
		runtime.finish("Second", 0, "0.0000002");
		await drain(worker);
		expect(store.getJob(bot.bot_id, first.job_id!).usage.cost_usd).toBe("0.0000003");
	});

	test("a launcher communication failure cannot overwrite an already-running Job", async () => {
		const { root, store, bot, worker, runtimes } = await harness();
		const service = new BotService(root, {
			ensure_worker: async () => {
				await worker.tick();
				throw new Error("Broker connection vanished after worker admission");
			},
		});
		try {
			const receipt = await service.submit("reviewer", { command: "submit", input: "Must continue" });
			expect(store.request(bot.bot_id, receipt.request_id).outcome).toBe("applied");
			expect(store.getJob(bot.bot_id, receipt.job_id!).state).toBe("running");
			expect(runtimes.get(receipt.job_id!)!.inputs).toEqual(["Must continue"]);
		} finally {
			await service.close();
		}
	});

	test("stopping an idle Job enters cancellation without violating the idle settlement invariant", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const receipt = store.admit(bot.bot_id, { command: "submit", input: "Finish first" });
		await worker.tick();
		const executionId = store.getJob(bot.bot_id, receipt.job_id!).execution_id;
		runtimes.get(receipt.job_id!)!.finish("Ready");
		await drain(worker);
		const idle = store.snapshot(bot.bot_id, { job_id: receipt.job_id! }).jobs[0]!;
		expect(idle.state).toBe("idle");
		expect(idle.ownership.state).toBe("none");
		expect(idle.ownership.activation_ref).toEqual(expect.any(String));
		const stop = store.admit(bot.bot_id, { command: "stop", job_id: receipt.job_id! });
		await worker.tick();
		expect(store.request(bot.bot_id, stop.request_id).outcome).toBe("applied");
		const stopped = store.snapshot(bot.bot_id, { job_id: receipt.job_id! }).jobs[0]!;
		expect(stopped.state).toBe("stopped");
		expect(stopped.ownership).toEqual(idle.ownership);
		expect(
			store.inspect(bot.bot_id, stopped.ownership.activation_ref!, undefined, stopped.job_id).content,
		).toMatchObject({
			stage: "closed",
			recovery: "not_required",
			execution_id: executionId,
			request_id: receipt.request_id,
		});
	});
});

describe("Bot durable initialization and continuation fences", () => {
	test("initialization failure retains applied input evidence and publishes a terminal failure, not idle", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-init-failure-"));
		const store = new BotStore(root);
		const bot = store.createBot({ bot_name: "reviewer", cwd: root });
		const worker = new BotWorker(store, bot.bot_id, async () => {
			throw new Error("Runtime initialization failed");
		});
		cleanups.push(async () => {
			await worker.close();
			store.close();
			await fs.rm(root, { recursive: true, force: true });
		});
		worker.claim();
		const receipt = store.admit(bot.bot_id, { command: "submit", input: "Retained original" });
		await worker.tick();
		const job = store.getJob(bot.bot_id, receipt.job_id!);
		expect(job).toMatchObject({
			state: "failed",
			settled: true,
			pending_input_count: 0,
			error: { message: "Runtime initialization failed" },
		});
		expect(store.request(bot.bot_id, receipt.request_id).outcome).toBe("applied");
		const evidence = store.activation(job.ownership.activation_ref!);
		expect(store.inspect(bot.bot_id, evidence.input_ref!, undefined, job.job_id).content).toBe("Retained original");
		expect(store.events(bot.bot_id, { limit: 1000 }).items.some(event => event.type === "execution.started")).toBe(
			false,
		);
	});

	test("a queued timeout reacquires capacity before tool continuation and bypasses pending maintenance", async () => {
		const { store, bot, worker, runtimes } = await harness();
		const first = store.admit(bot.bot_id, { command: "submit", input: "Need branch" });
		await worker.tick();
		const a = runtimes.get(first.job_id!)!;
		a.question("question-timeout");
		await drain(worker);
		const followup = store.admit(bot.bot_id, { command: "send", job_id: first.job_id!, input: "Ordinary follow-up" });
		const compact = store.admit(bot.bot_id, { command: "compact", job_id: first.job_id! });
		const second = store.admit(bot.bot_id, { command: "submit", input: "Other Job owns capacity" });
		await worker.tick();
		const timedout = a.timeout("default branch");
		expect(store.snapshot(bot.bot_id, { job_id: first.job_id! }).jobs[0]!.input_requests[0]).toMatchObject({
			status: "completion_queued",
			completion_reason: "timeout",
			reply_request_id: null,
		});
		expect(a.inputs).toEqual(["Need branch"]);
		expect(store.request(bot.bot_id, compact.request_id).outcome).toBe("pending");
		runtimes.get(second.job_id!)!.finish("Other Job finished");
		await drain(worker);
		expect(a.inputs).toEqual(["Need branch", "default branch"]);
		expect(store.request(bot.bot_id, compact.request_id).outcome).toBe("pending");
		expect(store.getJob(bot.bot_id, first.job_id!).input_requests).toEqual([]);
		a.finish("Timed out continuation finished");
		await timedout;
		await drain(worker);
		expect(store.request(bot.bot_id, compact.request_id).outcome).toBe("applied");
		expect(a.inputs).toEqual(["Need branch", "default branch", "Ordinary follow-up"]);
		const events = store.events(bot.bot_id, { limit: 1000 }).items;
		const compactApplied = events.findIndex(
			event => event.type === "request.finished" && event.request_id === compact.request_id,
		);
		const followupStarted = events.findIndex(
			event => event.type === "execution.started" && event.request_id === followup.request_id,
		);
		expect(followupStarted).toBeGreaterThan(compactApplied);
	});

	for (const stage of ["before_claim", "after_claim", "factory"] as const) {
		test(`SIGKILL ${stage} preserves the input handoff and never replays an uncertain claim`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-claim-crash-"));
			const store = new BotStore(root);
			const bot = store.createBot({ bot_name: "reviewer", cwd: root });
			const receipt = store.admit(bot.bot_id, { command: "submit", input: "One real admission" });
			store.finishRequest(bot.bot_id, receipt.request_id, "applied");
			cleanups.push(async () => {
				store.close();
				await fs.rm(root, { recursive: true, force: true });
			});
			const storeUrl = new URL("../src/bots/store.ts", import.meta.url).href;
			const workerUrl = new URL("../src/bots/worker.ts", import.meta.url).href;
			const script = `import {BotStore} from ${JSON.stringify(storeUrl)};
import {BotWorker} from ${JSON.stringify(workerUrl)};
const store=new BotStore(process.env.BOT_CRASH_ROOT);
const botId=process.env.BOT_CRASH_ID;
const stage=process.env.BOT_CRASH_STAGE;
if(stage==="after_claim"){
 store.claimWorker(botId,"crashed-owner",process.pid);
 store.claimInput(botId,process.env.BOT_CRASH_JOB,process.env.BOT_CRASH_REQUEST,"crashed-owner",store.workerLease(botId).owner_epoch);
 console.log("bot-crash-ready");
 await Bun.stdin.text();
}else{
 const worker=new BotWorker(store,botId,async()=>{
  console.log("bot-crash-ready");
  await Bun.stdin.text();
  throw new Error("Unexpected initialization return");
 });
 if(!worker.claim()) throw new Error("Worker did not claim");
 if(stage==="factory") await worker.tick();
 else {console.log("bot-crash-ready");await Bun.stdin.text();}
}`;
			const child = Bun.spawn([process.execPath, "--eval", script], {
				env: {
					...process.env,
					BOT_CRASH_ROOT: root,
					BOT_CRASH_ID: bot.bot_id,
					BOT_CRASH_STAGE: stage,
					BOT_CRASH_JOB: receipt.job_id!,
					BOT_CRASH_REQUEST: receipt.request_id,
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			cleanups.push(async () => {
				child.kill("SIGKILL");
				await child.exited;
			});
			const reader = child.stdout.getReader();
			let output = "";
			while (!output.includes("bot-crash-ready")) {
				const next = await reader.read();
				if (next.done)
					throw new Error(`Crash child exited before its boundary: ${await new Response(child.stderr).text()}`);
				output += new TextDecoder().decode(next.value);
			}
			reader.releaseLock();
			child.kill("SIGKILL");
			await child.exited;
			const called: ControlledRuntime[] = [];
			const recovered = new BotWorker(store, bot.bot_id, async (_job, callbacks) => {
				const runtime = new ControlledRuntime(callbacks.onEvent, callbacks.onContinuation);
				called.push(runtime);
				return runtime;
			});
			cleanups.push(() => recovered.close());
			expect(recovered.claim()).toBe(true);
			expect(store.request(bot.bot_id, receipt.request_id).outcome).toBe("applied");
			if (stage === "before_claim") {
				await recovered.tick();
				expect(called[0]!.inputs).toEqual(["One real admission"]);
			} else {
				const job = store.getJob(bot.bot_id, receipt.job_id!);
				expect(job).toMatchObject({
					state: "interrupted",
					execution_id: null,
					pending_input_count: 0,
					settled: false,
					ownership: { state: "uncertain" },
				});
				const activation = store.activation(job.ownership.activation_ref!);
				expect(store.inspect(bot.bot_id, activation.input_ref!, undefined, job.job_id).content).toBe(
					"One real admission",
				);
				store.admit(bot.bot_id, { command: "submit", input: "Must retain capacity" });
				await recovered.tick();
				expect(called).toEqual([]);
				expect(store.events(bot.bot_id, { limit: 1000 }).items.some(event => event.type === "job.settled")).toBe(
					false,
				);
			}
		}, 15_000);
	}
});

describe("Bot retained dispatch and sample boundaries", () => {
	test("retains a late factory runtime when its stale-owner cleanup fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-stale-factory-"));
		const store = new BotStore(root);
		const bot = store.createBot({ bot_name: "reviewer", cwd: root });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let failCleanup = true;
		let disposals = 0;
		const worker = new BotWorker(store, bot.bot_id, async (_job, callbacks) => {
			entered.resolve();
			await release.promise;
			const runtime = new ControlledRuntime(callbacks.onEvent);
			runtime.stop = async () => {
				stopped.resolve();
				if (failCleanup) throw new Error("unconfirmed cleanup");
			};
			runtime.dispose = async () => {
				disposals++;
			};
			return runtime;
		});
		try {
			expect(worker.claim()).toBe(true);
			const receipt = store.admit(bot.bot_id, { command: "submit", input: "Do not replay" });
			await worker.tick();
			await entered.promise;
			const oldLease = store.workerLease(bot.bot_id)!;
			store.releaseWorker(bot.bot_id, oldLease.owner_id);
			expect(store.claimWorker(bot.bot_id, "replacement", process.pid)).toBe(true);
			release.resolve();
			await stopped.promise;
			await expect(worker.close()).rejects.toThrow("did not confirm cleanup");
			expect(disposals).toBe(0);
			expect(store.workerLease(bot.bot_id)?.owner_id).toBe("replacement");
			expect(store.getJob(bot.bot_id, receipt.job_id!).settled).toBe(false);
			failCleanup = false;
			await worker.close();
			expect(disposals).toBe(1);
			expect(store.workerLease(bot.bot_id)?.owner_id).toBe("replacement");
		} finally {
			failCleanup = false;
			release.resolve();
			await worker.close();
			store.releaseWorker(bot.bot_id, "replacement");
			store.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("replacement worker epochs fence model/tool dispatch, callbacks and old-owner shutdown", async () => {
		const { store, bot, worker, runtimeCallbacks } = await harness();
		const receipt = store.admit(bot.bot_id, { command: "submit", input: "Owned dispatch" });
		await worker.tick();
		const callbacks = runtimeCallbacks.get(receipt.job_id!)!;
		expect(() => callbacks.assertDispatch?.()).not.toThrow();
		store.releaseWorker(bot.bot_id, store.workerLease(bot.bot_id)!.owner_id);
		store.claimWorker(bot.bot_id, "replacement", process.pid);
		const replacement = store.snapshot(bot.bot_id);
		expect(() => callbacks.assertDispatch?.()).toThrow("fenced");
		const disposition = {
			launch_intent_id: "old-launch",
			state: "cancelled_before_launch" as const,
			service: null,
			outcome: "cancelled" as const,
			final: true,
			error: null,
		};
		expect(() => callbacks.onLaunchDisposition?.("old-launch", disposition)).toThrow();
		expect(() => callbacks.onLaunchDisposition?.("old-launch", disposition, true)).not.toThrow();
		callbacks.onEvent({ type: "execution_start" });
		callbacks.onEvent({ type: "output", message_id: "stale", text: "Late output", final: true });
		callbacks.onEvent({
			type: "input_required",
			input_request_id: "stale-question",
			kind: "text",
			prompt: { title: "Late question" },
		});
		expect(store.snapshot(bot.bot_id)).toEqual(replacement);
		await worker.close();
		expect(store.snapshot(bot.bot_id)).toEqual(replacement);
	});

	test("scalar context samples coalesce while lifecycle changes remain immediate", async () => {
		setSystemTime(1_000_000);
		const { store, bot, worker, runtimes } = await harness();
		const receipt = store.admit(bot.bot_id, { command: "submit", input: "Sample scalar context" });
		await worker.tick();
		await drain(worker);
		const runtime = runtimes.get(receipt.job_id!)!;
		const baseline = store.snapshot(bot.bot_id);
		runtime.contextUsed = 21;
		setSystemTime(1_000_100);
		await worker.tick();
		expect(store.snapshot(bot.bot_id).jobs[0]!.context.used_tokens).toBe(20);
		runtime.contextUsed = 22;
		setSystemTime(1_000_200);
		await worker.tick();
		expect(store.snapshot(bot.bot_id).jobs[0]!.context.used_tokens).toBe(20);
		setSystemTime(1_000_250);
		await worker.tick();
		expect(store.snapshot(bot.bot_id).jobs[0]!.context.used_tokens).toBe(22);
		expect(
			store
				.events(bot.bot_id, { after: baseline.cursor, limit: 1000 })
				.items.filter(event => event.type === "job.changed"),
		).toHaveLength(1);
		runtime.question("immediate-question");
		expect(store.snapshot(bot.bot_id).jobs[0]!).toMatchObject({
			state: "waiting_input",
			execution_id: null,
			input_requests: [{ input_request_id: "immediate-question", status: "open" }],
		});
	});
});

test("application-time reply rejection releases its matching unconsumed reservation", async () => {
	const { store, bot, worker, runtimes } = await harness();
	const receipt = store.admit(bot.bot_id, { command: "submit", input: "Ask a branch" });
	await worker.tick();
	const runtime = runtimes.get(receipt.job_id!)!;
	runtime.question("changing-question");
	await drain(worker);
	const reply = store.admit(bot.bot_id, {
		command: "send",
		job_id: receipt.job_id!,
		reply_to: "changing-question",
		input: "main",
	});
	runtime.questionPrompt = { title: "Branch", options: ["release"] };
	await worker.tick();
	expect(store.request(bot.bot_id, reply.request_id)).toMatchObject({
		outcome: "rejected",
		error: { code: "invalid_input" },
	});
	expect(store.getJob(bot.bot_id, receipt.job_id!).input_requests[0]).toMatchObject({
		status: "open",
		reply_request_id: null,
		completion_reason: null,
	});
	expect(runtime.inputs).toEqual(["Ask a branch"]);
	const valid = store.admit(bot.bot_id, {
		command: "send",
		job_id: receipt.job_id!,
		reply_to: "changing-question",
		input: "release",
	});
	await worker.tick();
	expect(store.request(bot.bot_id, valid.request_id).outcome).toBe("applied");
	expect(runtime.inputs).toEqual(["Ask a branch", "release"]);
});

test("a scoped worker admits, replies and stops only its bound Graph job", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-scoped-"));
	const store = new BotStore(root);
	const bot = store.createBot({ bot_name: "scoped", cwd: root });
	const runtimes = new Map<string, ControlledRuntime>();
	const worker = new BotWorker(
		store,
		bot.bot_id,
		async (job, callbacks) => {
			const runtime = new ControlledRuntime(callbacks.onEvent, callbacks.onContinuation);
			runtimes.set(job.job_id, runtime);
			return runtime;
		},
		{ scoped: true },
	);
	cleanups.push(async () => {
		await worker.close();
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const other = store.admit(bot.bot_id, { command: "submit", input: "Unrelated" });
	expect(() => worker.admitGraph({ command: "submit", input: "unclaimed" })).toThrow();
	expect(worker.claim()).toBe(true);
	const contender = new BotWorker(store, bot.bot_id, undefined, { scoped: true });
	expect(contender.claim()).toBe(false);
	await contender.close();
	await worker.tick();
	expect(store.request(bot.bot_id, other.request_id).outcome).toBe("pending");
	const graph = worker.admitGraph({
		command: "submit",
		input: "Graph work",
		key: "hosted-submit",
		graph_context: { graph_id: "g", graph_run_id: "r", node_id: "n", invocation_id: "i", attempt: 1, upstream: [] },
	});
	expect(store.graphHostedByKey(bot.bot_id, "hosted-submit")?.receipt).toEqual(graph);
	expect(store.graphHostedByKey(bot.bot_id, "missing")).toBeNull();
	worker.bindJob(graph.job_id!);
	expect(() => worker.bindJob(other.job_id!)).toThrow();
	await worker.tick();
	const runtime = runtimes.get(graph.job_id!)!;
	expect(runtime.inputs).toEqual(["Graph work"]);
	expect(runtimes.has(other.job_id!)).toBe(false);
	runtime.question("question");
	await drain(worker);
	expect(() =>
		store.admit(bot.bot_id, {
			command: "send",
			job_id: graph.job_id!,
			reply_to: "question",
			input: "unauthorized",
		}),
	).toThrow("Graph-authorized");
	expect(() => store.admit(bot.bot_id, { command: "stop", job_id: graph.job_id! })).toThrow("Graph-authorized");
	expect(() => store.admit(bot.bot_id, { command: "stop", all: true })).toThrow("Graph-hosted");
	const reply = worker.admitGraphControl({
		command: "send",
		job_id: graph.job_id!,
		reply_to: "question",
		input: "answer",
	});
	await drain(worker);
	expect(store.request(bot.bot_id, reply.request_id).outcome).toBe("applied");
	expect(runtime.inputs).toEqual(["Graph work", "answer"]);
	const stop = worker.admitGraphControl({ command: "stop", job_id: graph.job_id!, key: "cleanup-0" });
	expect(store.graphControlByKey(bot.bot_id, graph.job_id!, "cleanup-0")?.outcome).toBe("pending");
	expect(store.graphControlByKey(bot.bot_id, graph.job_id!, "cleanup-1")).toBeNull();
	await drain(worker);
	expect(store.request(bot.bot_id, stop.request_id).outcome).toBe("applied");
	expect(store.graphControlByKey(bot.bot_id, graph.job_id!, "cleanup-0")?.outcome).toBe("applied");
	expect(store.getJob(bot.bot_id, graph.job_id!).state).toBe("stopped");
	expect(store.request(bot.bot_id, other.request_id).outcome).toBe("pending");
	expect(store.getJob(bot.bot_id, other.job_id!).state).toBe("queued");
	await worker.close();
	const ordinary = new BotWorker(
		store,
		bot.bot_id,
		async (_job, callbacks) => new ControlledRuntime(callbacks.onEvent, callbacks.onContinuation),
	);
	expect(ordinary.claim()).toBe(true);
	const stopAll = store.admit(bot.bot_id, { command: "stop", all: true });
	await ordinary.tick();
	await ordinary.tick();
	expect(store.request(bot.bot_id, stopAll.request_id).outcome).toBe("applied");
	await ordinary.close();
});

test("ordinary workers do not execute Graph jobs without their fenced runtime", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-hosted-"));
	const store = new BotStore(root);
	const bot = store.createBot({ bot_name: "hosted", cwd: root });
	const scoped = new BotWorker(store, bot.bot_id, undefined, { scoped: true });
	expect(scoped.claim()).toBe(true);
	const graph = scoped.admitGraph({
		command: "submit",
		input: "Graph work",
		graph_context: { graph_id: "g", graph_run_id: "r", node_id: "n", invocation_id: "i", attempt: 1, upstream: [] },
	});
	await scoped.close();
	const runtimes = new Map<string, ControlledRuntime>();
	const worker = new BotWorker(store, bot.bot_id, async (job, callbacks) => {
		const runtime = new ControlledRuntime(callbacks.onEvent, callbacks.onContinuation);
		runtimes.set(job.job_id, runtime);
		return runtime;
	});
	expect(worker.claim()).toBe(true);
	cleanups.push(async () => {
		await worker.close();
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const ordinary = store.admit(bot.bot_id, {
		command: "submit",
		input: "Ordinary work",
		graph_context: {
			graph_id: "legacy",
			graph_run_id: "r",
			node_id: "n",
			invocation_id: "i",
			attempt: 1,
			upstream: [],
		},
	});
	await worker.tick();
	expect(store.request(bot.bot_id, graph.request_id).outcome).toBe("pending");
	expect(runtimes.has(graph.job_id!)).toBe(false);
	expect(runtimes.get(ordinary.job_id!)?.inputs).toEqual(["Ordinary work"]);
});

test("ordinary takeover fences crashed Graph ownership without consuming its mailbox", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-hosted-recovery-"));
	const store = new BotStore(root);
	const bot = store.createBot({ bot_name: "recovery", cwd: root });
	const scoped = new BotWorker(store, bot.bot_id, undefined, { scoped: true });
	expect(scoped.claim()).toBe(true);
	const receipt = scoped.admitGraph({
		command: "submit",
		input: "Graph side effect",
		graph_context: { graph_id: "g", graph_run_id: "r", node_id: "n", invocation_id: "i", attempt: 1, upstream: [] },
	});
	const lease = store.workerLease(bot.bot_id)!;
	store.finishRequest(bot.bot_id, receipt.request_id, "applied");
	expect(
		store.claimInput(bot.bot_id, receipt.job_id!, receipt.request_id, lease.owner_id, lease.owner_epoch),
	).not.toBeNull();
	// Model the dead owner's lost lease with its claimed activation still durable.
	store.releaseWorker(bot.bot_id, lease.owner_id);
	await scoped.close();
	const queued = store.admit(bot.bot_id, { command: "submit", input: "unrelated queued work" });
	const ordinary = new BotWorker(store, bot.bot_id);
	expect(ordinary.claim()).toBe(true);
	expect(store.getJob(bot.bot_id, receipt.job_id!)).toMatchObject({
		state: "interrupted",
		ownership: { state: "uncertain" },
	});
	expect(store.hasUncertainOwnership(bot.bot_id)).toBe(true);
	const recovery = new BotWorker(
		store,
		bot.bot_id,
		async () => {
			throw new Error("Recovery must not create a runtime");
		},
		{ scoped: true },
	);
	expect(recovery.claim()).toBe(false);
	expect(ordinary.shouldYieldToGraph()).toBe(true);
	expect(store.request(bot.bot_id, queued.request_id).outcome).toBe("pending");
	await ordinary.close();
	expect(recovery.claim()).toBe(true);
	recovery.bindJob(receipt.job_id!);
	expect(store.getJob(bot.bot_id, receipt.job_id!).ownership.state).toBe("uncertain");
	expect(store.request(bot.bot_id, queued.request_id).outcome).toBe("pending");
	store.updateRuntimeState(bot.bot_id, receipt.job_id!, { pending_delivery_count: 1 });
	const uncertain = recovery.admitGraphControl({ command: "stop", job_id: receipt.job_id!, key: "recovery-failed" });
	await recovery.tick();
	expect(store.request(bot.bot_id, uncertain.request_id).outcome).toBe("rejected");
	expect(store.getJob(bot.bot_id, receipt.job_id!).ownership.state).toBe("uncertain");
	store.updateRuntimeState(bot.bot_id, receipt.job_id!, { pending_delivery_count: 0 });
	const stop = recovery.admitGraphControl({ command: "stop", job_id: receipt.job_id!, key: "recovery-stop" });
	await recovery.tick();
	expect(store.request(bot.bot_id, stop.request_id).outcome).toBe("applied");
	expect(store.getJob(bot.bot_id, receipt.job_id!)).toMatchObject({ state: "stopped", ownership: { state: "none" } });
	await recovery.close();
	store.close();
	await fs.rm(root, { recursive: true, force: true });
});

test("a Graph lease request waits for ordinary active work to settle", async () => {
	const { store, bot, worker, runtimes } = await harness();
	const receipt = store.admit(bot.bot_id, { command: "submit", input: "ordinary" });
	await worker.tick();
	const scoped = new BotWorker(store, bot.bot_id, undefined, { scoped: true });
	expect(scoped.claim()).toBe(false);
	expect(store.hasGraphHandoff(bot.bot_id)).toBe(true);
	expect(worker.shouldYieldToGraph()).toBe(false);
	runtimes.get(receipt.job_id!)!.finish("done");
	await drain(worker);
	expect(worker.shouldYieldToGraph()).toBe(true);
	await worker.close();
	expect(scoped.claim()).toBe(true);
	expect(store.hasGraphHandoff(bot.bot_id)).toBe(false);
	await scoped.close();
});

test("hosted cleanup stops verified services even when launch and delivery evidence is uncertain", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-partial-cleanup-"));
	const store = new BotStore(root);
	const bot = store.createBot({ bot_name: "partial-cleanup", cwd: root });
	const original = new BotWorker(store, bot.bot_id, undefined, { scoped: true });
	const recovery = new BotWorker(
		store,
		bot.bot_id,
		async () => {
			throw new Error("Cleanup must not initialize a model");
		},
		{ scoped: true },
	);
	const calls: Array<Record<string, unknown>> = [];
	const daemon = { id: "service-id", name: "owned", owner: "session", startedAt: 123, state: "running" };
	const broker = {
		request: async (operation: Record<string, unknown>) => {
			calls.push(operation);
			switch (operation.op) {
				case "fence_owner":
					return { op: "fence_owner", fenced_through_epoch: operation.through_epoch };
				case "reconcile_launch":
					return { op: "reconcile_launch", disposition: { final: false, state: "unknown" } };
				case "list":
					return { op: "list", daemons: [daemon] };
				case "stop_owned":
					return { op: "stop_owned", daemon: { ...daemon, state: "exited" } };
				default:
					throw new Error("Unexpected broker operation");
			}
		},
	} as unknown as DaemonBrokerClient;
	const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
	try {
		expect(original.claim()).toBe(true);
		const receipt = original.admitGraph({
			command: "submit",
			input: "work",
			graph_context: {
				graph_id: "g",
				graph_run_id: "r",
				node_id: "n",
				invocation_id: "i",
				attempt: 1,
				upstream: [],
			},
		});
		const lease = store.workerLease(bot.bot_id)!;
		store.finishRequest(bot.bot_id, receipt.request_id, "applied");
		store.claimInput(bot.bot_id, receipt.job_id!, receipt.request_id, lease.owner_id, lease.owner_epoch);
		store.setSessionOwner(bot.bot_id, receipt.job_id!, "session", lease.owner_epoch);
		store.recordLaunchIntent(bot.bot_id, receipt.job_id!, {
			launch_intent_id: "uncertain-launch",
			session_owner_id: "session",
			owner_epoch: lease.owner_epoch,
			payload: {},
		});
		store.updateRuntimeState(
			bot.bot_id,
			receipt.job_id!,
			{
				pending_background_count: 1,
				pending_delivery_count: 1,
			},
			[{ id: daemon.id, name: daemon.name, started_at: daemon.startedAt }],
		);
		store.releaseWorker(bot.bot_id, lease.owner_id);
		await original.close();
		expect(recovery.claim()).toBe(true);
		recovery.bindJob(receipt.job_id!);
		const stop = recovery.admitGraphControl({ command: "stop", job_id: receipt.job_id! });
		await recovery.tick();
		expect(calls).toContainEqual({
			op: "stop_owned",
			name: "owned",
			id: "service-id",
			generation: "123",
			session_owner_id: "session",
			through_epoch: lease.owner_epoch,
			timeoutMs: 5_000,
		});
		expect(store.request(bot.bot_id, stop.request_id).outcome).toBe("rejected");
		expect(store.getJob(bot.bot_id, receipt.job_id!).ownership.state).toBe("uncertain");
	} finally {
		spy.mockRestore();
		await recovery.close();
		await original.close();
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

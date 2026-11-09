import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { ThinkingLevel, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model, ModelSpec, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createBotRuntime,
	type BotRuntime,
	type BotRuntimeCallbacks,
	type BotRuntimeEvent,
	type BotRuntimeOptions,
} from "@oh-my-pi/pi-coding-agent/bots/agent-runtime";
import type { BotJob } from "@oh-my-pi/pi-coding-agent/bots/types";
import { BotStore } from "@oh-my-pi/pi-coding-agent/bots/store";
import { BotWorker } from "@oh-my-pi/pi-coding-agent/bots/worker";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import * as skillDescriptions from "@oh-my-pi/pi-coding-agent/extensibility/skill-descriptions";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { closeDaemonClients, createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { cfgAskTimeout } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgRetryEnabled } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgToolsApproval, cfgToolsMaxTimeout } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function fixtureModel(id = "primary", contextWindow = 8192): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "bot-fixture",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(512, contextWindow),
	} as ModelSpec);
}

function fixtureJob(temp: TempDir, tools: string[], id = "job-one"): BotJob {
	return {
		job_id: id,
		bot_id: "bot-one",
		config_revision: "config-one",
		revision: "1",
		goal_preview: "assignment",
		goal_ref: null,
		cwd: temp.path(),
		graph_context: null,
		state: "queued",
		phase: "queued",
		settled: false,
		execution_id: null,
		pending_input_count: 1,
		pending_background_count: 0,
		pending_delivery_count: 0,
		activity: null,
		wait: null,
		progress: null,
		model: { current: null, pending: null },
		context: { used_tokens: null, limit_tokens: null },
		usage: {
			input_tokens: null,
			output_tokens: null,
			cache_read_tokens: null,
			cache_write_tokens: null,
			cost_usd: null,
			completeness: "unknown",
			measured_at: null,
		},
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
		last_activity_at: new Date(0).toISOString(),
		elapsed_ms: 0,
		active_ms: 0,
		output_ref: null,
		artifact_ids: [],
		error: null,
		controls: [],
		config: { cwd: temp.path(), system_prompt: "BOT_ONLY_SYSTEM", tools, skills_dirs: [], model: null },
		session_file: temp.join("sessions", `${id}.jsonl`),
		inputs: [],
		input_requests: [],
		ownership: { state: "none", activation_ref: null },
		session_owner_id: null,
		owner_epoch: null,
		launch_intents: [],
	};
}

type FixtureResponse = string | ToolCall[] | { error: string };
interface Fixture {
	runtime: BotRuntime;
	session: AgentSession;
	events: BotRuntimeEvent[];
	contexts: Context[];
	models: Model[];
	registry: ModelRegistry;
}

const resources: Array<() => void | Promise<void>> = [];
async function openFixture(
	temp: TempDir,
	job: BotJob,
	responses: FixtureResponse[],
	callbacks?: BotRuntimeCallbacks | ((event: BotRuntimeEvent) => void),
	options: Pick<BotRuntimeOptions, "owner_epoch" | "session_owner_id" | "graph" | "thinkingLevel"> & {
		fixtureCleanup?: "unrecoverable";
		fixtureBeforeInitialize?: (session: AgentSession) => void;
	} = {},
	beforeHook?: AgentSession["agent"]["beforeToolCall"],
): Promise<Fixture> {
	const auth = createInMemoryAuthStorage();
	resources.push(() => auth.close());
	auth.keys.setRuntime("bot-fixture", "fixture-key");
	const registry = new ModelRegistry(auth, temp.join("models.yml"));
	const contexts: Context[] = [];
	const models: Model[] = [];
	const events: BotRuntimeEvent[] = [];
	let session!: AgentSession;
	let counter = 0;
	const stream: StreamFn = (model, context) => {
		contexts.push({
			...context,
			systemPrompt: [...(context.systemPrompt ?? [])],
			messages: structuredClone(context.messages),
			tools: context.tools?.map(tool => ({ ...tool })),
		});
		models.push(model);
		const response = responses[counter++];
		if (response === undefined) throw new Error("Unexpected model call (including auxiliary inference)");
		const result = new AssistantMessageEventStream();
		const failed = typeof response === "object" && !Array.isArray(response);
		const message: AssistantMessage = {
			...createAssistantMessage(typeof response === "string" ? response : ""),
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now() + counter,
			responseId: `fixture-response-${counter}`,
			stopReason: failed ? "error" : typeof response === "string" ? "stop" : "toolUse",
		};
		if (Array.isArray(response)) message.content = response;
		if (failed) message.errorMessage = response.error;
		else {
			message.usage.input = 10;
			message.usage.totalTokens = 10;
		}
		queueMicrotask(() => {
			const partial = { ...message, content: [] };
			result.push({ type: "start", partial });
			if (typeof response === "string") {
				result.push({ type: "text_start", contentIndex: 0, partial });
				const text = { ...message, content: [{ type: "text" as const, text: response }] };
				result.push({ type: "text_delta", contentIndex: 0, delta: response, partial: text });
				result.push({ type: "text_end", contentIndex: 0, content: response, partial: text });
			}
			if (failed) result.push({ type: "error", reason: "error", error: message });
			else result.push({ type: "done", reason: typeof response === "string" ? "stop" : "toolUse", message });
			result.end();
		});
		return result;
	};
	const runtime = await createBotRuntime(
		job,
		{
			...(typeof callbacks === "function" ? {} : callbacks),
			onEvent: event => {
				events.push(event);
				if (typeof callbacks === "function") callbacks(event);
				else callbacks?.onEvent(event);
			},
		},
		{
			...options,
			agent_dir: temp.join("agent"),
			model: fixtureModel(),
			modelRegistry: registry,
			stream,
			createSession: async sessionOptions => {
				const result = await createAgentSession(sessionOptions);
				if (beforeHook) result.session.agent.beforeToolCall = beforeHook;
				session = result.session;
				options.fixtureBeforeInitialize?.(session);
				return result;
			},
		},
	);
	resources.push(async () => {
		if (options.fixtureCleanup === "unrecoverable") {
			try {
				await expect(runtime.dispose()).rejects.toMatchObject({ code: "cleanup_failed" });
			} finally {
				// This fixture invents an unrecoverable previous owner; release only its
				// local test resources without reporting successful owned-work cleanup.
				await (runtime as BotRuntime & { releaseLocalResources(): Promise<void> }).releaseLocalResources();
			}
		} else await runtime.dispose();
	});
	return { runtime, session, events, contexts, models, registry };
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: { i: `Executing ${name}`, ...args } };
}

afterEach(async () => {
	try {
		const errors: unknown[] = [];
		for (const release of resources.splice(0).reverse()) {
			try {
				await release();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
	} finally {
		await closeDaemonClients();
		vi.restoreAllMocks();
	}
});

describe("isolated Bot AgentSession runtime", () => {
	it("rejects an effort the selected model cannot preserve rather than silently running without thinking", async () => {
		const temp = TempDir.createSync("@omp-bot-thinking-");
		resources.push(() => temp.removeSync());
		await expect(openFixture(temp, fixtureJob(temp, []), [], undefined, {
			thinkingLevel: ThinkingLevel.High,
		})).rejects.toMatchObject({ code: "incompatible_model" });
	});

	it("releases runtime listeners and timer if initialization fails", async () => {
		const temp = TempDir.createSync("@omp-bot-init-failure-");
		resources.push(() => temp.removeSync());
		const intervals = vi.spyOn(globalThis, "setInterval");
		const cleared = vi.spyOn(globalThis, "clearInterval");
		let disposed = false;
		await expect(
			openFixture(temp, fixtureJob(temp, []), [], undefined, {
				fixtureBeforeInitialize: session => {
					const dispose = session.dispose.bind(session);
					vi.spyOn(session, "dispose").mockImplementation(async () => {
						disposed = true;
						await dispose();
					});
					Object.defineProperty(session, "extensionRunner", {
						configurable: true,
						get() {
							Reflect.deleteProperty(session, "extensionRunner");
							throw new Error("extension initialization failed");
						},
					});
				},
			}),
		).rejects.toThrow("extension initialization failed");
		const index = intervals.mock.calls.findLastIndex(args => args[1] === 100);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(cleared.mock.calls.some(args => args[0] === intervals.mock.results[index]?.value)).toBe(true);
		expect(disposed).toBe(true);
	});

	it("reconciles a fenced owner's launch without treating uncertain broker cleanup as final", async () => {
		const temp = TempDir.createSync("@omp-bot-fenced-launch-");
		resources.push(() => temp.removeSync());
		const job = fixtureJob(temp, ["bash"]);
		job.session_owner_id = "old-session";
		job.owner_epoch = "1";
		job.launch_intents = [
			{
				launch_intent_id: "old-launch",
				session_owner_id: "old-session",
				owner_epoch: "1",
				payload: {},
				disposition: null,
			},
		];
		let final = false;
		let stale = false;
		const modes: string[] = [];
		const broker = {
			onCompletion: () => () => {},
			request: async (request: { op: string; mode?: string; through_epoch?: string }) => {
				if (request.op === "fence_owner") return { op: "fence_owner", fenced_through_epoch: request.through_epoch };
				if (request.op === "list") return { op: "list", daemons: [] };
				if (request.op !== "reconcile_launch") throw new Error("Unexpected broker operation");
				modes.push(request.mode!);
				const cancelled = request.mode === "cancel" && final;
				return {
					op: "reconcile_launch",
					disposition: {
						launch_intent_id: "old-launch",
						state: cancelled ? "cancelled_before_launch" : request.mode === "cancel" ? "unknown" : "pending",
						service: null,
						outcome: cancelled ? "cancelled" : null,
						final: cancelled,
						error: null,
					},
				};
			},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
		const fixture = await openFixture(temp, job, [], {
			onEvent: () => {},
			onLaunchDisposition: (_id, _disposition, cleanup) => {
				if (stale && !cleanup) throw new Error("stale lease");
			},
		});
		resources.push(() => {
			final = true;
		});
		stale = true;
		await expect(fixture.runtime.stop()).rejects.toMatchObject({ code: "cleanup_failed" });
		final = true;
		await fixture.runtime.dispose();
		expect(modes.filter(mode => mode === "cancel")).toHaveLength(2);
	});

	it("keeps an empty Bot prompt empty and does not add coding instructions", async () => {
		const temp = TempDir.createSync("@omp-bot-empty-");
		resources.push(() => temp.removeSync());
		await fs.writeFile(temp.join("AGENTS.md"), "AMBIENT_RULES_MUST_NOT_LOAD");
		const job = fixtureJob(temp, []);
		job.config.system_prompt = "";
		const fixture = await openFixture(temp, job, ["hello"]);
		await fixture.runtime.prompt("hello");
		expect(fixture.contexts).toHaveLength(1);
		expect(fixture.contexts[0]!.systemPrompt).toEqual([]);
		expect(fixture.contexts[0]!.tools).toEqual([]);
		expect(fixture.runtime.state().session_file).toBe(job.session_file);
		expect(await Bun.file(job.session_file!).exists()).toBe(true);
		await fixture.runtime.dispose();
		const resumed = await openFixture(temp, job, ["resumed"]);
		await resumed.runtime.prompt("Continue the same conversation");
		expect(JSON.stringify(resumed.contexts[0]!.messages)).toContain("hello");
		expect(resumed.runtime.state().session_file).toBe(job.session_file);
	});

	it("executes only approved read tools and frozen skills without auxiliary inference", async () => {
		const temp = TempDir.createSync("@omp-bot-read-");
		resources.push(() => temp.removeSync());
		await fs.mkdir(temp.join("frozen", "reviewer"), { recursive: true });
		await fs.mkdir(temp.join(".omp", "skills", "ambient"), { recursive: true });
		await fs.writeFile(
			temp.join("frozen", "reviewer", "SKILL.md"),
			"---\nname: reviewer\ndescription: Review the configured document without ambient capabilities\n---\nFROZEN_REVIEW_INSTRUCTIONS",
		);
		await fs.writeFile(
			temp.join(".omp", "skills", "ambient", "SKILL.md"),
			"---\nname: ambient\ndescription: AMBIENT_SKILL_MUST_NOT_LOAD\n---\nAMBIENT_BODY",
		);
		await fs.writeFile(temp.join("AGENTS.md"), "AMBIENT_RULES_MUST_NOT_LOAD");
		await fs.writeFile(temp.join("WATCHDOG.md"), "AMBIENT_WATCHDOG_MUST_NOT_LOAD");
		await fs.writeFile(temp.join("subject.txt"), "ACTUAL_SUBJECT_CONTENT");
		const compressor = vi.spyOn(skillDescriptions, "createSkillDescriptionCompressor").mockImplementation(() => {
			throw new Error("Auxiliary compressor was constructed");
		});
		const job = fixtureJob(temp, ["read"]);
		job.config.skills_dirs = [temp.join("frozen")];
		const fixture = await openFixture(temp, job, [
			[call("read-skill", "read", { path: "skill://reviewer" })],
			[call("read-skill", "read", { path: "subject.txt" })],
			"Reviewed the actual document.",
		]);
		await fixture.runtime.prompt("Review the document");
		expect(compressor).not.toHaveBeenCalled();
		expect(fixture.contexts).toHaveLength(3);
		for (const context of fixture.contexts) {
			expect(context.tools?.map(tool => tool.name)).toEqual(["read"]);
			expect(context.tools?.[0]?.description.length).toBeGreaterThan(0);
			expect(JSON.stringify(context.systemPrompt)).not.toContain("AMBIENT_");
			expect(context.systemPrompt?.[0]).toBe("BOT_ONLY_SYSTEM");
		}
		expect(JSON.stringify(fixture.contexts[2]!.messages)).toContain("FROZEN_REVIEW_INSTRUCTIONS");
		expect(JSON.stringify(fixture.contexts[2]!.messages)).toContain("ACTUAL_SUBJECT_CONTENT");
		expect(fixture.events.filter(event => event.type === "span_start" && event.kind === "tool")).toHaveLength(2);
		expect(
			new Set(
				fixture.events.flatMap(event =>
					event.type === "span_start" && event.kind === "tool" ? [event.span_id] : [],
				),
			).size,
		).toBe(2);
		const outputs = fixture.events.filter(event => event.type === "output");
		expect(outputs.filter(event => event.final)).toHaveLength(1);
		expect(new Set(outputs.map(event => event.message_id)).size).toBe(1);
		const usage = fixture.events.filter(event => event.type === "usage");
		expect(usage).toHaveLength(3);
		expect(usage[0]).toMatchObject({
			input_tokens: 10,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			cost_usd: "0",
		});
		expect(fixture.runtime.state()).toMatchObject({
			pending_background_count: 0,
			pending_delivery_count: 0,
			waiting_input_count: 0,
			is_streaming: false,
		});
	});

	it("suspends a real ask tool, permits another Job, and resumes only the targeted question", async () => {
		const temp = TempDir.createSync("@omp-bot-ask-");
		resources.push(() => temp.removeSync());
		const first = await openFixture(temp, fixtureJob(temp, ["ask"], "ask-job"), [
			[
				call("question", "ask", {
					questions: [{ id: "choice", question: "Choose a target", options: [{ label: "A" }, { label: "B" }] }],
				}),
			],
			"Received the targeted reply.",
		]);
		await first.runtime.prompt("Ask me for a target");
		const question = first.events.find(event => event.type === "input_required");
		if (!question || question.type !== "input_required")
			throw new Error(
				`Expected a real runtime question: ${JSON.stringify(first.events.filter(event => event.type === "span_end" && event.kind === "tool"))}`,
			);
		expect(first.runtime.state()).toMatchObject({ waiting_input_count: 1, is_streaming: false });
		await expect(first.runtime.reply("wrong-question", "B")).rejects.toMatchObject({ code: "input_request_closed" });
		const second = await openFixture(temp, fixtureJob(temp, [], "independent-job"), ["Independent answer."]);
		await second.runtime.prompt("Independent assignment");
		await first.runtime.reply(question.input_request_id, "B");
		expect(first.runtime.state().waiting_input_count).toBe(0);
		expect(first.events.filter(event => event.type === "input_required")).toHaveLength(1);
		expect(first.events.filter(event => event.type === "input_resolved")).toHaveLength(1);
		expect(JSON.stringify(first.contexts[1]!.messages)).toContain("B");
		expect(JSON.stringify(second.contexts[0]!.messages)).not.toContain("Choose a target");
		await expect(first.runtime.reply(question.input_request_id, "A")).rejects.toMatchObject({
			code: "input_request_closed",
		});
	});

	it("validates structured multi-question replies before closing the pending question", async () => {
		const temp = TempDir.createSync("@omp-bot-multi-ask-");
		resources.push(() => temp.removeSync());
		const fixture = await openFixture(temp, fixtureJob(temp, ["ask"]), [
			[
				call("multiple-questions", "ask", {
					questions: [
						{ id: "target", question: "Choose a target", options: [{ label: "A" }, { label: "B" }] },
						{ id: "flags", question: "Choose flags", multi: true, options: [{ label: "X" }, { label: "Y" }] },
					],
				}),
			],
			"Received distinct answers.",
		]);
		await fixture.runtime.prompt("Ask two questions");
		const question = fixture.events.find(event => event.type === "input_required");
		if (!question || question.type !== "input_required")
			throw new Error(
				`Expected a multi-question input: ${JSON.stringify(fixture.events.filter(event => event.type === "span_end" && event.kind === "tool"))}`,
			);
		for (const invalid of [
			"B",
			"{}",
			'{"target":["B"],"flags":"X"}',
			'{"target":"B","flags":"X","unknown":"bad"}',
			'{"target":"B","flags":"X"}',
			'{"target":"","flags":["X"]}',
		]) {
			await expect(fixture.runtime.reply(question.input_request_id, invalid)).rejects.toMatchObject({
				code: "invalid_input",
			});
			expect(fixture.runtime.state().waiting_input_count).toBe(1);
			expect(fixture.events.filter(event => event.type === "input_resolved")).toHaveLength(0);
		}
		await fixture.runtime.reply(question.input_request_id, '{"target":"B","flags":["X","Y"]}');
		const result = fixture.session.messages.find(
			message => message.role === "toolResult" && message.toolName === "ask",
		);
		expect(result && "details" in result ? result.details : undefined).toMatchObject({
			results: [
				{ id: "target", selectedOptions: ["B"] },
				{ id: "flags", selectedOptions: ["X", "Y"] },
			],
		});
		expect(fixture.runtime.state().waiting_input_count).toBe(0);
	});

	it("preserves select-none answers from a real multi-select ask", async () => {
		const temp = TempDir.createSync("@omp-bot-select-none-");
		resources.push(() => temp.removeSync());
		const fixture = await openFixture(temp, fixtureJob(temp, ["ask"]), [
			[
				call("select-none", "ask", {
					questions: [{ id: "flags", question: "Choose flags", multi: true, options: [{ label: "X" }] }],
				}),
			],
			"No flags selected.",
		]);
		await fixture.runtime.prompt("Choose any flags, including none");
		const question = fixture.events.find(event => event.type === "input_required");
		if (!question || question.type !== "input_required") throw new Error("Missing multi-select question");
		await fixture.runtime.reply(question.input_request_id, '{"flags":[]}');
		const result = fixture.session.messages.find(
			message => message.role === "toolResult" && message.toolName === "ask",
		);
		expect(result && "details" in result ? result.details : undefined).toMatchObject({
			multi: true,
			selectedOptions: [],
		});
		expect(fixture.runtime.state().waiting_input_count).toBe(0);
		expect(fixture.contexts).toHaveLength(2);
	});

	it("normalizes offered approvals and rejects malformed replies without closing the gate", async () => {
		const temp = TempDir.createSync("@omp-bot-approval-");
		resources.push(() => temp.removeSync());
		const fixture = await openFixture(temp, fixtureJob(temp, ["bash"]), [
			[call("approval-command", "bash", { command: "printf approved-evidence", timeout: 60 })],
			"Approved command finished.",
		]);
		cfgToolsApproval.override(fixture.session, { bash: "prompt" });
		await fixture.runtime.prompt("Run the command after approval");
		const question = fixture.events.find(event => event.type === "input_required" && event.kind === "approval");
		if (!question || question.type !== "input_required")
			throw new Error(
				`Expected approval: ${JSON.stringify(fixture.events.filter(event => event.type === "span_end" && event.kind === "tool"))}`,
			);
		await expect(fixture.runtime.reply(question.input_request_id, "perhaps")).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(fixture.runtime.state().waiting_input_count).toBe(1);
		await fixture.runtime.reply(question.input_request_id, "  aPpRoVe  ");
		expect(JSON.stringify(fixture.contexts[1]!.messages)).toContain("approved-evidence");
		expect(fixture.runtime.state().waiting_input_count).toBe(0);
	});

	it("preserves measured Todo state through qaonly and rejects incompatible models without deleting history", async () => {
		const temp = TempDir.createSync("@omp-bot-compact-");
		resources.push(() => temp.removeSync());
		const fixture = await openFixture(temp, fixtureJob(temp, ["todo"]), [
			[call("todo-init", "todo", { op: "init", items: ["Keep requirement A", "Keep requirement B"] })],
			[call("todo-done", "todo", { op: "done", task: "Keep requirement A" })],
			"One measured task remains.",
			"Continued on the selected model.",
		]);
		await fixture.runtime.prompt("REQUIREMENT_A must survive conversation compaction");
		expect(fixture.runtime.state().progress).toEqual({ source: "todo", completed: 1, total: 2, unit: "tasks" });
		await fixture.runtime.compact();
		expect(fixture.contexts).toHaveLength(3);
		expect(JSON.stringify(fixture.runtime.messages())).toContain("REQUIREMENT_A");
		expect(fixture.runtime.state().progress).toEqual({ source: "todo", completed: 1, total: 2, unit: "tasks" });
		const tiny = fixtureModel("tiny", 1);
		const wide = fixtureModel("wide", 16384);
		vi.spyOn(fixture.registry, "find").mockImplementation((_provider, id) =>
			id === "tiny" ? tiny : id === "wide" ? wide : undefined,
		);
		const before = JSON.stringify(fixture.runtime.messages());
		await expect(fixture.runtime.setModel("bot-fixture/tiny")).rejects.toMatchObject({ code: "incompatible_model" });
		expect(fixture.runtime.state().model).toBe("bot-fixture/primary");
		expect(JSON.stringify(fixture.runtime.messages())).toBe(before);
		await fixture.runtime.setModel("bot-fixture/wide");
		await fixture.runtime.prompt("Continue without losing requirements");
		expect(fixture.models.at(-1)?.id).toBe("wide");
		expect(
			fixture.events.some(
				event => event.type === "span_end" && event.kind === "compaction" && event.outcome === "ok",
			),
		).toBe(true);
	});

	it("awaits actual owned asynchronous bash cancellation before reporting stopped", async () => {
		const temp = TempDir.createSync("@omp-bot-background-");
		resources.push(() => temp.removeSync());
		const fixture = await openFixture(temp, fixtureJob(temp, ["bash"]), [
			[call("background-command", "bash", { command: "sleep 30", async: true, timeout: 60 })],
			"The owned command is still running.",
		]);
		await fixture.runtime.prompt("Start an owned asynchronous command");
		expect(fixture.runtime.state().pending_background_count).toBe(1);
		expect(fixture.events.some(event => event.type === "span_start" && event.kind === "background")).toBe(true);
		await fixture.runtime.stop();
		expect(fixture.runtime.state()).toMatchObject({
			pending_background_count: 0,
			pending_delivery_count: 0,
			is_streaming: false,
		});
		expect(
			fixture.events.some(
				event => event.type === "span_end" && event.kind === "background" && event.outcome === "cancelled",
			),
		).toBe(true);
		expect(fixture.contexts).toHaveLength(2);
		await expect(fixture.runtime.prompt("Late input")).rejects.toMatchObject({ code: "invalid_state" });
	});

	it("reports synthetic failed-call zeros as unknown rather than complete measured usage", async () => {
		const temp = TempDir.createSync("@omp-bot-unknown-");
		resources.push(() => temp.removeSync());
		const fixture = await openFixture(temp, fixtureJob(temp, []), [
			{ error: "Provider failed before reporting usage" },
		]);
		cfgRetryEnabled.override(fixture.session, false);
		await fixture.runtime.prompt("Fail before receiving usage").catch(error => {
			expect(error).toBeInstanceOf(Error);
		});
		expect(fixture.events.find(event => event.type === "usage")).toMatchObject({
			input_tokens: null,
			output_tokens: null,
			cache_read_tokens: null,
			cache_write_tokens: null,
			cost_usd: null,
		});
	});

	it("tracks and stops owned named services through the real daemon broker", async () => {
		const temp = TempDir.createSync("@omp-bot-service-");
		resources.push(() => temp.removeSync());
		const fixture = await openFixture(temp, fixtureJob(temp, ["bash"]), [
			[call("service-command", "bash", { command: "sleep 30", name: "owned-bot-service" })],
			"The named service is running.",
		]);
		await fixture.runtime.prompt("Start a named service");
		expect(fixture.runtime.state().pending_background_count).toBe(1);
		await fixture.runtime.stop();
		expect(fixture.runtime.state()).toMatchObject({
			pending_background_count: 0,
			pending_delivery_count: 0,
			is_streaming: false,
		});
		expect(fixture.contexts).toHaveLength(2);
	}, 30_000);

	it("publishes only actual persisted tool artifacts with their producer span", async () => {
		const temp = TempDir.createSync("@omp-bot-artifact-");
		resources.push(() => temp.removeSync());
		const fixture = await openFixture(temp, fixtureJob(temp, ["bash"]), [
			[call("artifact-command", "bash", { command: "printf 'artifact-evidence\\n%.0s' {1..10000}", timeout: 60 })],
			"The complete output is retained.",
		]);
		await fixture.runtime.prompt("Produce artifact evidence");
		const artifact = fixture.events.find(event => event.type === "artifact");
		if (!artifact || artifact.type !== "artifact") throw new Error("Expected an actual tool output artifact");
		expect(artifact.content).toContain("artifact-evidence");
		expect(artifact.size_bytes).toBe(Buffer.byteLength(String(artifact.content)));
		expect(
			fixture.events.some(event => event.type === "span_start" && event.span_id === artifact.producer_span_id),
		).toBe(true);
	}, 30_000);

	it("does not turn unknown crash-owned work into successful cleanup", async () => {
		const temp = TempDir.createSync("@omp-bot-unowned-");
		resources.push(() => temp.removeSync());
		const job = fixtureJob(temp, []);
		job.pending_background_count = 1;
		const fixture = await openFixture(temp, job, [], undefined, { fixtureCleanup: "unrecoverable" });
		await expect(fixture.runtime.stop()).rejects.toMatchObject({ code: "cleanup_failed" });
		expect(fixture.runtime.state().pending_background_count).toBe(1);
		await expect(fixture.runtime.dispose()).rejects.toMatchObject({ code: "cleanup_failed" });
	});

	it("a stop control recovers a confirmed terminal service generation without replaying the model", async () => {
		const temp = TempDir.createSync("@omp-bot-recovered-service-");
		resources.push(() => temp.removeSync());
		const store = new BotStore(temp.join("bots"));
		const bot = store.createBot({ bot_name: "reviewer", cwd: temp.path(), tools: ["bash"] });
		const submitted = store.admit(bot.bot_id, { command: "submit", input: "Initialize recovery context" });
		store.finishRequest(bot.bot_id, submitted.request_id, "applied");
		store.consumeInput(bot.bot_id, submitted.job_id!, submitted.request_id);
		const original = await openFixture(temp, store.getJob(bot.bot_id, submitted.job_id!), ["Initialized."]);
		await original.runtime.prompt("Initialize recovery context");
		const sessionId = original.session.sessionManager.getSessionId();
		await original.runtime.dispose();
		const client = await createDaemonBrokerClient(temp.path());
		let worker: BotWorker | undefined;
		try {
			const started = await client.request({
				op: "start",
				owner: sessionId,
				spec: {
					name: "recoverable-service",
					application: process.execPath,
					args: ["--eval", "await Bun.sleep(30000)"],
					cwd: temp.path(),
					env: {},
					pty: false,
					persist: false,
					detached: false,
					restart: "no",
				},
			});
			if (started.op !== "start") throw new Error("Expected actual service admission");
			await client.request({ op: "stop", name: started.daemon.name, id: started.daemon.id, timeoutMs: 5_000 });
			store.updateRuntimeState(
				bot.bot_id,
				submitted.job_id!,
				{
					state: "interrupted",
					phase: "none",
					settled: false,
					pending_background_count: 1,
				},
				[{ id: started.daemon.id, name: started.daemon.name, started_at: started.daemon.startedAt ?? null }],
			);
			let recovery: Fixture | undefined;
			worker = new BotWorker(store, bot.bot_id, async (job, callbacks, options) => {
				recovery = await openFixture(temp, job, [], callbacks, options);
				return recovery.runtime;
			});
			expect(worker.claim()).toBe(true);
			const stopped = store.admit(bot.bot_id, { command: "stop", job_id: submitted.job_id! });
			await worker.tick();
			expect(store.request(bot.bot_id, stopped.request_id).outcome).toBe("applied");
			expect(store.getJob(bot.bot_id, submitted.job_id!)).toMatchObject({
				state: "stopped",
				settled: true,
				pending_background_count: 0,
			});
			expect(recovery?.contexts).toEqual([]);
		} finally {
			await worker?.close();
			await client.request({ op: "shutdown" });
			client.close();
			store.close();
		}
	});

	it("recovers and stops a real crash-owned launch despite zero published service counts", async () => {
		const temp = TempDir.createSync("@omp-bot-zero-count-crash-");
		resources.push(() => temp.removeSync());
		const store = new BotStore(temp.join("bots"));
		const bot = store.createBot({ bot_name: "reviewer", cwd: temp.path(), tools: ["bash"] });
		const submitted = store.admit(bot.bot_id, { command: "submit", input: "Initialize recovery transcript" });
		const jobId = submitted.job_id!;
		store.finishRequest(bot.bot_id, submitted.request_id, "applied");
		store.consumeInput(bot.bot_id, jobId, submitted.request_id);
		const original = await openFixture(temp, store.getJob(bot.bot_id, jobId), ["Initialized."]);
		await original.runtime.prompt("Initialize recovery transcript");
		store.setSessionFile(bot.bot_id, jobId, original.runtime.state().session_file!);
		store.setSessionOwner(bot.bot_id, jobId, original.session.sessionManager.getSessionId(), "1");
		await original.runtime.dispose();
		const input = store.admit(bot.bot_id, { command: "send", job_id: jobId, input: "Start owned service" });
		store.enqueueInput(bot.bot_id, jobId, { request_id: input.request_id, input: "Start owned service" });
		store.finishRequest(bot.bot_id, input.request_id, "applied");
		const keeper = await createDaemonBrokerClient(temp.path());
		await keeper.request({ op: "list" });
		const ready = Promise.withResolvers<DaemonSnapshot>();
		const script = `
import {BotStore} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/bots/store.ts"))};
import {BotWorker} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/bots/worker.ts"))};
import {createDaemonBrokerClient} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/launch/client.ts"))};
const store=new BotStore(process.env.BOT_CRASH_ROOT);
const worker=new BotWorker(store,process.env.BOT_CRASH_ID,async(job,callbacks)=>{
 const launch={launch_intent_id:crypto.randomUUID(),session_owner_id:job.session_owner_id,owner_epoch:job.owner_epoch};
 const payload={op:"start",owner:launch.session_owner_id,awaitReady:false,spec:{
  name:"zero-count-owned",application:process.execPath,args:["--eval","await Bun.sleep(60000)"],
  cwd:job.cwd,env:{},pty:false,persist:false,detached:false,restart:"no"
 }};
 await callbacks.onLaunchIntent({...launch,payload});
 const client=await createDaemonBrokerClient(job.cwd);
 const started=await client.request({...payload,launch});
 if(started.op!=="start") throw new Error("Unexpected service launch response");
 process.send({type:"service_started",daemon:started.daemon});
 await Bun.stdin.text();
 throw new Error("Crash gate unexpectedly released");
});
if(!worker.claim()) throw new Error("Unable to claim worker");
for(;;){await worker.tick();await Bun.sleep(10);}
`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			env: { ...process.env, BOT_CRASH_ROOT: store.root, BOT_CRASH_ID: bot.bot_id },
			stdin: "pipe",
			stdout: "ignore",
			stderr: "pipe",
			ipc(message: unknown) {
				if (typeof message === "object" && message !== null && "daemon" in message)
					ready.resolve(message.daemon as DaemonSnapshot);
			},
		});
		let worker: BotWorker | undefined;
		try {
			const daemon = await Promise.race([
				ready.promise,
				child.exited.then(async code => {
					throw new Error(`Crash fixture exited ${code}: ${await new Response(child.stderr).text()}`);
				}),
			]);
			expect(store.getJob(bot.bot_id, jobId)).toMatchObject({
				pending_background_count: 0,
				pending_delivery_count: 0,
			});
			child.kill("SIGKILL");
			await child.exited;
			const live = await keeper.request({ op: "describe", name: daemon.name });
			expect(live.op === "describe" ? live.daemon.state : undefined).toBe("running");
			let recovery: Fixture | undefined;
			worker = new BotWorker(store, bot.bot_id, async (job, callbacks, options) => {
				recovery = await openFixture(temp, job, [], callbacks, options);
				return recovery.runtime;
			});
			expect(worker.claim()).toBe(true);
			const stopped = store.admit(bot.bot_id, { command: "stop", job_id: jobId });
			const deadline = Date.now() + 10_000;
			while (store.request(bot.bot_id, stopped.request_id).outcome === "pending" && Date.now() < deadline) {
				await worker.tick();
				await Bun.sleep(5);
			}
			expect(store.request(bot.bot_id, stopped.request_id).outcome).toBe("applied");
			expect(store.getJob(bot.bot_id, jobId)).toMatchObject({
				state: "stopped",
				settled: true,
				ownership: { state: "none" },
				pending_background_count: 0,
			});
			const terminal = await keeper.request({ op: "describe", name: daemon.name });
			expect(terminal.op === "describe" ? terminal.daemon.state : undefined).toBe("exited");
			expect(recovery?.contexts).toEqual([]);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
			await worker?.close();
			await keeper.request({ op: "shutdown" });
			keeper.close();
			store.close();
		}
	}, 30_000);

	it("holds a real ask timeout behind the continuation permit before selecting its default", async () => {
		const temp = TempDir.createSync("@omp-bot-timeout-gate-");
		resources.push(() => temp.removeSync());
		const requested = Promise.withResolvers<void>();
		const permit = Promise.withResolvers<void>();
		const fixture = await openFixture(
			temp,
			fixtureJob(temp, ["ask"]),
			[
				[
					call("timed-question", "ask", {
						questions: [
							{
								id: "target",
								question: "Choose a target",
								options: [{ label: "A" }, { label: "B" }],
								recommended: 1,
							},
						],
					}),
				],
				"Continued with the default after capacity was acquired.",
			],
			{
				onEvent() {},
				onContinuation: async continuation => {
					if (continuation.origin !== "timeout") throw new Error("Unexpected continuation");
					requested.resolve();
					await permit.promise;
				},
			},
		);
		resources.push(() => permit.resolve());
		cfgAskTimeout.override(fixture.session, 0.02);
		await fixture.runtime.prompt("Ask with a timeout");
		await requested.promise;
		expect(fixture.contexts).toHaveLength(1);
		expect(fixture.runtime.state().waiting_input_count).toBe(1);
		permit.resolve();
		const deadline = Date.now() + 5_000;
		while (fixture.contexts.length !== 2 && Date.now() < deadline) await Bun.sleep(5);
		const result = fixture.session.messages.find(
			message => message.role === "toolResult" && message.toolName === "ask",
		);
		expect(result && "details" in result ? result.details : undefined).toMatchObject({
			selectedOptions: ["B"],
			timedOut: true,
		});
		expect(fixture.runtime.state().waiting_input_count).toBe(0);
		expect(fixture.contexts).toHaveLength(2);
	});

	it("does not dispatch a background completion until its execution permit is granted", async () => {
		const temp = TempDir.createSync("@omp-bot-delivery-gate-");
		resources.push(() => temp.removeSync());
		const requested = Promise.withResolvers<void>();
		const permit = Promise.withResolvers<void>();
		const fixture = await openFixture(
			temp,
			fixtureJob(temp, ["bash"]),
			[
				[
					call("background", "bash", {
						command: "sleep 0.15; printf background-delivery-evidence",
						async: true,
						timeout: 5,
					}),
				],
				"Waiting for background evidence.",
				"Processed background evidence.",
			],
			{
				onEvent() {},
				onContinuation: async continuation => {
					if (continuation.origin !== "background") throw new Error("Unexpected continuation");
					requested.resolve();
					await permit.promise;
				},
			},
		);
		resources.push(() => permit.resolve());
		await fixture.runtime.prompt("Start background work");
		await requested.promise;
		expect(fixture.contexts).toHaveLength(2);
		permit.resolve();
		const deadline = Date.now() + 5_000;
		while (fixture.contexts.length !== 3 && Date.now() < deadline) await Bun.sleep(5);
		expect(fixture.contexts).toHaveLength(3);
		expect(JSON.stringify(fixture.contexts[2]!.messages)).toContain("background-delivery-evidence");
	});

	it("allows a targeted real ask reply through pending compaction, then compacts before ordinary follow-up", async () => {
		const temp = TempDir.createSync("@omp-bot-question-maintenance-");
		resources.push(() => temp.removeSync());
		const store = new BotStore(temp.join("bots"));
		const bot = store.createBot({ bot_name: "reviewer", cwd: temp.path(), tools: ["ask"] });
		let fixture: Fixture | undefined;
		const worker = new BotWorker(store, bot.bot_id, async (job, callbacks, options) => {
			fixture = await openFixture(
				temp,
				job,
				[
					[
						call("question", "ask", {
							questions: [{ id: "choice", question: "Choose", options: [{ label: "A" }, { label: "B" }] }],
						}),
					],
					"Answer received.",
					"Follow-up completed.",
				],
				callbacks,
				options,
			);
			return fixture.runtime;
		});
		const drive = async (condition: () => boolean): Promise<void> => {
			const deadline = Date.now() + 10_000;
			while (!condition() && Date.now() < deadline) {
				await worker.tick();
				await Bun.sleep(5);
			}
			expect(condition()).toBe(true);
		};
		try {
			expect(worker.claim()).toBe(true);
			const submitted = store.admit(bot.bot_id, { command: "submit", input: "Ask for a choice" });
			const jobId = submitted.job_id!;
			await drive(() => store.getJob(bot.bot_id, jobId).state === "waiting_input");
			const compact = store.admit(bot.bot_id, { command: "compact", job_id: jobId });
			store.admit(bot.bot_id, { command: "send", job_id: jobId, input: "FOLLOWUP_AFTER_COMPACTION" });
			await worker.tick();
			expect(store.request(bot.bot_id, compact.request_id).outcome).toBe("pending");
			const question = store.getJob(bot.bot_id, jobId).input_requests[0]!;
			store.admit(bot.bot_id, { command: "send", job_id: jobId, input: "B", reply_to: question.input_request_id });
			await drive(() => store.request(bot.bot_id, compact.request_id).outcome === "applied");
			await drive(() => store.getJob(bot.bot_id, jobId).settled);
			expect(fixture?.contexts).toHaveLength(3);
			const followUp = fixture!.contexts[2]!;
			expect(JSON.stringify(followUp.messages)).toContain("FOLLOWUP_AFTER_COMPACTION");
			expect(followUp.messages.some(message => message.role === "toolResult")).toBe(false);
			expect(store.snapshot(bot.bot_id).jobs[0]!.input_requests).toEqual([]);
		} finally {
			await worker.close();
			store.close();
		}
	}, 20_000);
	it("keeps Graph-authorized tool arguments unchanged at execution despite session transforms", async () => {
		const temp = TempDir.createSync("@omp-graph-bot-arguments-");
		resources.push(() => temp.removeSync());
		const authorizedTimeouts: unknown[] = [];
		const fixture = await openFixture(
			temp,
			fixtureJob(temp, ["bash"], "graph"),
			[[call("command", "bash", { command: "printf ok", timeout: 60 })], "done"],
			{ onEvent() {}, assertDispatch() {} },
			{
				graph: {
					base: "isolated",
					model: fixtureModel(),
					appendPrompt: "Graph",
					assertToolCall(context) {
						authorizedTimeouts.push(context.args.timeout);
					},
				},
			},
		);
		cfgToolsMaxTimeout.set(fixture.session.settings, 1);
		const timeouts: number[] = [];
		fixture.session.agent.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName === "bash") timeouts.push(event.args.timeout);
		});
		await fixture.runtime.prompt("Run the command");
		expect(timeouts).toEqual([1]);
		expect(authorizedTimeouts).toEqual([1]);
	});

	it("does not let Graph authorization rewrite the file actually read", async () => {
		const temp = TempDir.createSync("@omp-graph-bot-policy-");
		resources.push(() => temp.removeSync());
		const allowed = temp.join("allowed.txt");
		const denied = temp.join("denied.txt");
		await Bun.write(allowed, "approved file bytes");
		await Bun.write(denied, "unapproved file bytes");
		const inspected: unknown[] = [];
		const fixture = await openFixture(
			temp,
			fixtureJob(temp, ["read"], "policy"),
			[[call("read-file", "read", { path: allowed })], "done"],
			{ onEvent() {}, assertDispatch() {} },
			{
				graph: {
					base: "isolated",
					model: fixtureModel(),
					appendPrompt: "Graph",
					assertToolCall(context) {
						inspected.push(context.args.path);
						context.args.path = denied;
						context.toolCall.arguments.path = denied;
					},
				},
			},
		);
		await fixture.runtime.prompt("Read the approved file");
		const results = fixture.runtime
			.messages()
			.filter((message): message is ToolResultMessage => (message as { role?: string }).role === "toolResult");
		expect(inspected).toEqual([allowed]);
		expect(results.map(message => message.content)).toEqual([[{ type: "text", text: "approved file bytes" }]]);
		const replay = fixture.contexts.at(-1)?.messages.filter(message => message.role === "toolResult");
		expect(replay?.map(message => message.content)).toEqual([[{ type: "text", text: "approved file bytes" }]]);
	});

	it("cannot introduce an ambient argument replacement while Graph authorization awaits", async () => {
		const temp = TempDir.createSync("@omp-graph-bot-late-hook-");
		resources.push(() => temp.removeSync());
		const allowed = temp.join("allowed.txt");
		await Bun.write(allowed, "original approved bytes");
		const hookResult: { args?: Record<string, unknown>; additionalContext: string } = {
			additionalContext: "ambient context",
		};
		const fixture = await openFixture(
			temp,
			fixtureJob(temp, ["read"], "late-hook"),
			[[call("read-file", "read", { path: allowed })], "done"],
			{ onEvent() {}, assertDispatch() {} },
			{
				graph: {
					base: "isolated",
					model: fixtureModel(),
					appendPrompt: "Graph",
					async assertToolCall() {
						await Promise.resolve();
						hookResult.args = { path: temp.join("not-authorized.txt") };
					},
				},
			},
			() => hookResult,
		);
		await fixture.runtime.prompt("Read the approved file");
		const results = fixture.runtime
			.messages()
			.filter((message): message is ToolResultMessage => (message as { role?: string }).role === "toolResult");
		expect(results.map(message => message.content)).toEqual([[{ type: "text", text: "original approved bytes" }]]);
	});

	it("rejects same-id Graph session endpoint drift before the next model request", async () => {
		const temp = TempDir.createSync("@omp-graph-model-deployment-");
		resources.push(() => temp.removeSync());
		const selected = fixtureModel();
		const fixture = await openFixture(
			temp,
			fixtureJob(temp, [], "graph-deployment"),
			["Approved deployment responded.", "Unapproved deployment responded."],
			{ onEvent() {}, assertDispatch() {} },
			{
				graph: {
					base: "isolated",
					model: selected,
					appendPrompt: "Graph assignment",
					assertToolCall() {},
				},
			},
		);
		await fixture.runtime.prompt("First request");
		expect(fixture.models.map(model => model.baseUrl)).toEqual([selected.baseUrl]);
		fixture.session.model!.baseUrl = "https://unapproved.invalid/v1";
		await fixture.runtime.prompt("Second request");
		expect(fixture.contexts).toHaveLength(1);
		expect(fixture.runtime.messages().at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("Graph model configuration changed"),
		});
	});

	it("authorizes the final tool arguments after the ambient hook and rechecks the dispatch fence", async () => {
		const temp = TempDir.createSync("@omp-graph-bot-hook-");
		resources.push(() => temp.removeSync());
		let fenced = false;
		let mode: "replace" | "mutate" | "fence" = "replace";
		const authorized: unknown[] = [];
		const fixture = await openFixture(
			temp,
			fixtureJob(temp, []),
			["ready"],
			{
				onEvent() {},
				assertDispatch() {
					if (fenced) throw new Error("stale attempt");
				},
			},
			{
				graph: {
					base: "isolated",
					model: fixtureModel(),
					appendPrompt: "Graph assignment",
					assertToolCall(context) {
						authorized.push([context.args.path, context.toolCall.arguments.path]);
						if (context.args.path === "/denied") throw new Error("permission denied");
					},
				},
			},
			async context => {
				if (mode === "fence") {
					fenced = true;
					return;
				}
				if (mode === "replace") return { args: { path: "/denied" } };
				context.args.path = "/denied";
			},
		);
		await fixture.runtime.prompt("Start the activation");
		const context = {
			args: { path: "/allowed" },
			toolCall: { type: "toolCall", id: "call", name: "read", arguments: { path: "/allowed" } },
		} as unknown as Parameters<NonNullable<AgentSession["agent"]["beforeToolCall"]>>[0];
		await expect(fixture.session.agent.beforeToolCall!(context)).rejects.toThrow("argument replacement");
		expect(authorized).toHaveLength(0);
		mode = "mutate";
		await expect(fixture.session.agent.beforeToolCall!(context)).rejects.toThrow("permission denied");
		expect(authorized).toEqual([["/denied", "/denied"]]);
		mode = "fence";
		await expect(fixture.session.agent.beforeToolCall!(context)).rejects.toThrow("stale attempt");
		expect(authorized).toHaveLength(1);
	});
});

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type Context, ProviderRequestDeniedError, type ToolChoice } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgCompactionThresholdTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	QA_CHECKPOINT_ENTRY_TYPE,
	type QaCheckpointAcceptance,
	type QaCheckpointInput,
} from "@oh-my-pi/pi-coding-agent/session/qa-rollover";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { CheckpointTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { NewContextTool } from "@oh-my-pi/pi-coding-agent/tools/context-notes";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// The 300K fixture has a 255K report budget and a 4,096-token safety gap.
// The configured general compaction trigger must not replace QA's boundaries.
const HARD = 250_904;
const HINT = 100_000;
const WARNING = 150_542;
const WARNED_INPUT = 151_000;
const RAW_MARKER = "QA_RAW_TOOL_PAYLOAD_ONLY";
const RAW_RESULT = `${RAW_MARKER}\n${"working observation 17; ".repeat(600)}`;
const SUMMARY = "Parser changes saved in src/parser.ts. Empty-input check passed. Integration remains unverified.";
const NEXT_ACTION = "Run the parser integration scenario without repeating the saved edits.";
const FINAL = "Parser integration is complete.";
const REQUEST = "Finish the parser refactor without deploying.";
const FALLBACK_SUMMARY = "SOFT_FALLBACK_SUMMARY: parser edits are saved; run the remaining integration scenario.";

type ScriptedResponse = AssistantMessage & { stopReason: "stop" | "toolUse" };

function assistant(content: AssistantMessage["content"], input = 100): ScriptedResponse {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function finalAnswer(text = FINAL): ScriptedResponse {
	return assistant([{ type: "text", text }]);
}

function work(input = WARNED_INPUT): ScriptedResponse {
	return assistant([{ type: "toolCall", id: `qa-work-${workId++}`, name: "qa_work", arguments: {} }], input);
}

let workId = 0;

type Request = {
	index: number;
	context: Context;
	messages: AgentMessage[];
	compactions: number;
	toolChoice: ToolChoice | undefined;
	maxTokens: number | undefined;
	retryProviderRequest(): Promise<void>;
	/** Read from the storage backend, not the manager's staged in-memory entries. */
	durableEntries: SessionEntry[];
};
type Step = (request: Request) => AssistantMessage | Promise<AssistantMessage>;
type WriteBoundary = "checkpoint" | "compaction";
type WriteGate = {
	entered: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
};

function journalEntries(content: string): SessionEntry[] {
	return content
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as SessionEntry);
}

function isCheckpoint(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === QA_CHECKPOINT_ENTRY_TYPE;
}

/** Real atomic journal writes with a single controllable persistence boundary. */
class QaStorage extends MemorySessionStorage {
	#next: { boundary: WriteBoundary; gate?: WriteGate; error?: Error } | undefined;
	readonly #gates: WriteGate[] = [];

	pauseNext(boundary: WriteBoundary): WriteGate {
		const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		this.#gates.push(gate);
		this.#next = { boundary, gate };
		return gate;
	}

	failNext(boundary: WriteBoundary): void {
		this.#next = { boundary, error: new Error(`Injected ${boundary} storage failure`) };
	}

	releaseAll(): void {
		for (const gate of this.#gates) gate.release.resolve();
	}

	override async writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const next = this.#next;
		if (next) {
			const entries = journalEntries(content);
			const matches =
				next.boundary === "checkpoint" ? entries.some(isCheckpoint) : entries.some(e => e.type === "compaction");
			if (matches) {
				this.#next = undefined;
				next.gate?.entered.resolve();
				if (next.gate) await next.gate.release.promise;
				if (next.error) throw next.error;
			}
		}
		await super.writeTextAtomic(file, content, options);
	}
}

function warningMessages(request: Request): AgentMessage[] {
	return request.messages.filter(message => message.role === "custom" && message.customType === "qa-rollover-warning");
}

/** Read the cycle correlation from any advisory or a direct hard report. */
function cycleId(request: Request): string {
	const warning = request.messages.findLast(
		message =>
			message.role === "custom" &&
			(message.customType === "qa-rollover-hint" ||
				message.customType === "qa-rollover-warning" ||
				message.customType === "qa-rollover-hard-report"),
	);
	const text = warning && "content" in warning ? String(warning.content) : "";
	const id = text.match(/\bqa:[\w:.-]+/)?.[0];
	if (!id) throw new Error("Scripted provider did not receive a QA cycle identifier");
	return id;
}

function checkpoint(disposition: QaCheckpointInput["disposition"] = "continue"): Step {
	return request => {
		const input: QaCheckpointInput = {
			cycleId: cycleId(request),
			summary: SUMMARY,
			disposition,
			...(disposition === "continue" ? { nextAction: NEXT_ACTION } : {}),
		};
		return assistant(
			[
				{
					type: "toolCall",
					id: `qa-checkpoint-${request.index}`,
					name: "new_context",
					arguments: { checkpoint: input },
				},
			],
			WARNED_INPUT,
		);
	};
}

function checkpoints(entries: SessionEntry[]): SessionEntry[] {
	return entries.filter(isCheckpoint);
}

function compactions(entries: SessionEntry[]) {
	return entries.filter(entry => entry.type === "compaction");
}

function newContextResults(entries: SessionEntry[]) {
	return entries.flatMap(entry =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "new_context"
			? [entry.message]
			: [],
	);
}

const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage);
afterAll(() => authStorage.close());

describe("AgentSession cooperative QA rollover", () => {
	let tempDir: TempDir;
	const fixtures: Array<{ session: AgentSession; storage: QaStorage }> = [];
	const jobManagers: AsyncJobManager[] = [];
	const jobGates: Array<PromiseWithResolvers<string>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-qa-rollover-");
		workId = 0;
	});

	afterEach(async () => {
		for (const gate of jobGates.splice(0)) gate.resolve("fixture cleanup");
		for (const fixture of fixtures) fixture.storage.releaseAll();
		for (const fixture of fixtures.splice(0)) await fixture.session.dispose();
		for (const manager of jobManagers.splice(0)) {
			manager.cancelAll();
			await manager.dispose();
		}
		tempDir.removeSync();
	});

	async function createHarness(
		steps: Step[],
		options: {
			settings?: Record<string, unknown>;
			toolResult?: string;
			storage?: QaStorage;
			asyncJobManager?: AsyncJobManager;
			allowSoftFallback?: boolean;
			fixedContextTokens?: number;
			contextWindow?: number;
			maxTokens?: number;
			omitMaxOutputTokens?: boolean;
			workPackages?: boolean;
			afterCheckpointAccepted?: (
				session: AgentSession,
				input: QaCheckpointInput,
				signal?: AbortSignal,
			) => Promise<void>;
		} = {},
	) {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled Anthropic model");
		const model = {
			...bundled,
			contextWindow: options.contextWindow ?? 300_000,
			maxTokens: options.maxTokens ?? 8_192,
			omitMaxOutputTokens: options.omitMaxOutputTokens ?? bundled.omitMaxOutputTokens,
		};
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.midTurnEnabled": true,
			"compaction.methodOrder": ["qaonly"],
			"compaction.autoContinue": true,
			"compaction.thresholdTokens": 100_000,
			"compaction.thresholdPercent": -1,
			"compaction.keepRecentTokens": 1,
			"compaction.dropUseless": false,
			"compaction.supersedeReads": false,
			"contextPromotion.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"task.eager": "default",
			...options.settings,
		});
		const storage = options.storage ?? new QaStorage();
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
		await manager.ensureOnDisk();
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			sessionManager: manager,
			getSessionId: () => manager.getSessionId(),
			getSessionFile: () => manager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			isDisposed: () => session?.isDisposed ?? false,
			getCheckpointState: () => session?.getCheckpointState(),
			qaRollover: {
				isEnabled: () => session?.isQaRolloverEnabled() ?? false,
				accept: async (input, signal) => {
					const accepted = await session.acceptQaCheckpoint(input, signal);
					await options.afterCheckpointAccepted?.(session, input, signal);
					return accepted;
				},
			},
		};
		const executions: number[] = [];
		const workTool: AgentTool = {
			name: "qa_work",
			label: "QA work fixture",
			description: "Return an isolated deterministic working observation.",
			parameters: type({}),
			execute: async () => {
				executions.push(executions.length);
				return { content: [{ type: "text", text: options.toolResult ?? RAW_RESULT }] };
			},
		};
		const tools: AgentTool[] = [
			workTool,
			new NewContextTool(toolSession),
			...(options.workPackages ? [new CheckpointTool(toolSession) as AgentTool] : []),
		];
		const calls: Request[] = [];
		const sideRequests: Context[] = [];
		const events: AgentSessionEvent[] = [];
		let providerMessages: AgentMessage[] = [];
		const streamFn: StreamFn = async (requestModel, context, requestOptions) => {
			// Custom transports use the same generic actual-dispatch admission gate
			// as built-in providers, including for transport retries.
			await requestOptions?.beforeProviderRequest?.(requestModel, requestOptions.signal);
			const file = manager.getSessionFile();
			const request: Request = {
				index: calls.length,
				toolChoice: requestOptions?.toolChoice,
				maxTokens: requestOptions?.maxTokens,
				retryProviderRequest: async () => {
					await requestOptions?.beforeProviderRequest?.(requestModel, requestOptions.signal);
				},
				context: {
					...context,
					systemPrompt: context.systemPrompt?.slice(),
					messages: structuredClone(context.messages),
					// Schemas can be callable omptype values; retain their immutable identity.
					tools: context.tools?.slice(),
				},
				messages: structuredClone(providerMessages),
				compactions: compactions(manager.getEntries()).length,
				durableEntries: file ? journalEntries(await storage.readText(file)) : [],
			};
			calls.push(request);
			const step = steps[request.index];
			if (!step) throw new Error(`Unexpected provider request ${request.index + 1}`);
			const response = await step(request);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					stream.push({ type: "error", reason: response.stopReason, error: response });
				} else {
					stream.push({ type: "done", reason: response.stopReason, message: response });
				}
			});
			return stream;
		};
		const sideStreamFn: StreamFn = async (_requestModel, context) => {
			sideRequests.push({
				...context,
				systemPrompt: context.systemPrompt?.slice(),
				messages: structuredClone(context.messages),
				tools: context.tools?.slice(),
			});
			if (!options.allowSoftFallback) throw new Error("QA-only rollover must not issue a summarization request");
			const stream = new AssistantMessageEventStream();
			const response = finalAnswer(FALLBACK_SUMMARY);
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
			});
			return stream;
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Isolated QA rollover fixture."], tools, messages: [] },
			convertToLlm,
			streamFn,
		});
		if (options.fixedContextTokens !== undefined) {
			agent.setSystemPrompt([textAtLeastTokens(agent, options.fixedContextTokens)]);
		}
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: tools.map(tool => tool.name),
			agentId: "Main",
			asyncJobManager: options.asyncJobManager,
			sideStreamFn,
		});
		agent.addBeforeModelCallHook((_signal, context) => {
			providerMessages = context.messages;
		});
		session.subscribe(event => {
			events.push(event);
		});
		fixtures.push({ session, storage });
		return {
			session,
			manager,
			storage,
			calls,
			sideRequests,
			events,
			executions,
			async durableEntries() {
				await manager.flush();
				const file = manager.getSessionFile();
				if (!file) throw new Error("Expected persistent fixture session");
				return journalEntries(await storage.readText(file));
			},
		};
	}

	it("defers QA advisories to an active work package but retains hard-boundary recovery", async () => {
		const h = await createHarness(
			[
				() =>
					assistant([
						{
							type: "toolCall",
							id: "package-a",
							name: "checkpoint",
							arguments: {
								goal: "Finish A",
								finishWhen: "A validated",
								carryForward: "Evidence for B",
							},
						},
					]),
				() => work(WARNED_INPUT),
				request => {
					expect(h.session.getCheckpointState()?.checkpointId).toBe("package-a");
					expect(
						request.messages.filter(
							message => message.role === "custom" && message.customType.startsWith("qa-rollover-"),
						),
					).toEqual([]);
					expect(request.compactions).toBe(0);
					return work(HARD + 1);
				},
				request => {
					expect(request.toolChoice).toEqual({ type: "tool", name: "new_context" });
					return checkpoint()(request);
				},
				request => {
					expect(request.compactions).toBe(1);
					expect(h.session.getCheckpointState()).toBeUndefined();
					return finalAnswer();
				},
			],
			{ workPackages: true },
		);
		await run(h.session);
		expect(h.calls).toHaveLength(5);
	});

	async function run(session: AgentSession, request = REQUEST): Promise<void> {
		await session.prompt(request);
		await session.waitForIdle();
		expect(
			session.agent.state.messages.find(message => message.role === "assistant" && message.stopReason === "error"),
		).toBeUndefined();
	}

	function textAtLeastTokens(agent: Agent, tokens: number): string {
		const unit = " retained";
		let lower = 0;
		let upper = tokens;
		while (agent.tokenizer.countTokens(unit.repeat(upper)) < tokens) upper *= 2;
		while (lower + 1 < upper) {
			const middle = Math.floor((lower + upper) / 2);
			if (agent.tokenizer.countTokens(unit.repeat(middle)) < tokens) lower = middle;
			else upper = middle;
		}
		return unit.repeat(upper);
	}

	async function seedExactOccupancy(
		h: { session: AgentSession; manager: SessionManager },
		target: number,
	): Promise<void> {
		const tokenizer = h.session.agent.tokenizer;
		const earlierUser = { role: "user" as const, content: "Earlier unfinished parser work.", timestamp: Date.now() };
		const earlierWork = work(0);
		earlierWork.usage.output = 0;
		earlierWork.usage.totalTokens = 0;
		const call = earlierWork.content[0];
		if (call?.type !== "toolCall") throw new Error("Expected fixture work call");
		const resultBase = {
			role: "toolResult" as const,
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text" as const, text: RAW_MARKER }],
			isError: false,
			timestamp: Date.now(),
		};
		const pending = tokenizer.countMessage({ role: "user", content: REQUEST, timestamp: Date.now() });
		const fixed = computeNonMessageTokens(h.session, tokenizer, h.session.settings.revision);
		const baseline = fixed + tokenizer.countMessages([earlierUser, earlierWork, resultBase]) + pending;
		// Test-mode counting is bytes/4. Four ASCII bytes advance exactly one
		// token, including the real tool envelope, fixed instructions and input.
		// Keep each persisted text block under the journal's truncation limit.
		const padding = "x".repeat(4 * (target - baseline));
		const result = {
			...resultBase,
			content: [
				{ type: "text" as const, text: RAW_MARKER + padding.slice(0, 400_000) },
				{ type: "text" as const, text: padding.slice(400_000, 800_000) },
				{ type: "text" as const, text: padding.slice(800_000) },
			],
		};
		const history = [earlierUser, earlierWork, result];
		const actual = fixed + tokenizer.countMessages(history) + pending;
		if (actual !== target) throw new Error(`Expected exact fixture occupancy ${target}, got ${actual}`);
		for (const message of history) h.manager.appendMessage(message);
		h.session.agent.replaceMessages(history);
		await h.manager.flush();
	}

	it("warns, durably accepts a real new_context call, locally compacts, and sends exactly one rebuilt continuation", async () => {
		const h = await createHarness([() => work(), checkpoint(), () => finalAnswer()]);
		await run(h.session);

		expect(h.calls).toHaveLength(3);
		expect(warningMessages(h.calls[0]!)).toHaveLength(0);
		expect(warningMessages(h.calls[1]!)).toHaveLength(1);
		expect(h.calls[1]!.context.tools?.some(tool => tool.name === "new_context")).toBe(true);
		expect(JSON.stringify(h.calls[1]!.context)).toContain(RAW_MARKER);
		const rebuilt = JSON.stringify(h.calls[2]!.context);
		expect(rebuilt).toContain(REQUEST);
		expect(rebuilt).toContain(SUMMARY);
		expect(rebuilt).toContain(NEXT_ACTION);
		expect(rebuilt).not.toContain(RAW_MARKER);
		expect(h.calls.map(call => call.compactions)).toEqual([0, 0, 1]);
		expect(checkpoints(h.calls[2]!.durableEntries)).toHaveLength(1);
		expect(compactions(h.calls[2]!.durableEntries)).toHaveLength(1);
		expect(newContextResults(h.calls[2]!.durableEntries)).toMatchObject([
			{ isError: false, details: { requested: true, checkpoint: { status: "accepted" } } },
		]);
		expect(h.sideRequests).toHaveLength(0);
		const entries = await h.durableEntries();
		expect(checkpoints(entries)).toHaveLength(1);
		expect(compactions(entries)).toMatchObject([
			{ method: "qaonly", details: { checkpointEntryId: checkpoints(entries)[0]!.id } },
		]);
		expect(JSON.stringify(entries)).toContain(RAW_MARKER);
		expect(JSON.stringify(h.manager.buildSessionContext().messages)).not.toContain(RAW_MARKER);
		expect(h.events.filter(event => event.type === "auto_compaction_start")).toMatchObject([{ action: "qaonly" }]);
		expect(h.events.filter(event => event.type === "auto_compaction_end")).toMatchObject([
			{ action: "qaonly", aborted: false },
		]);
	});

	it("lets the agent choose a later appropriate milestone after more than three warned requests", async () => {
		const h = await createHarness([
			() => work(),
			...Array.from({ length: 5 }, () => () => work()),
			checkpoint(),
			() => finalAnswer(),
		]);
		await run(h.session);

		expect(h.calls).toHaveLength(8);
		expect(h.executions).toHaveLength(6);
		expect(h.calls.slice(1, 7).map(call => warningMessages(call).length)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(h.calls.slice(0, 7).map(call => call.compactions)).toEqual([0, 0, 0, 0, 0, 0, 0]);
		expect(h.calls.slice(1, 6).every(call => call.context.tools?.some(tool => tool.name === "qa_work"))).toBe(true);
		expect(h.calls.slice(1, 6).every(call => call.toolChoice === undefined)).toBe(true);
		const entries = await h.durableEntries();
		expect(newContextResults(entries)).toMatchObject([
			{ isError: false, details: { checkpoint: { status: "accepted" } } },
		]);
		expect(compactions(entries)).toHaveLength(1);
		expect(JSON.stringify(h.calls[7]!.context)).toContain(NEXT_ACTION);
		expect(JSON.stringify(h.calls[7]!.context)).not.toContain(RAW_MARKER);
		expect(h.sideRequests).toHaveLength(0);
	});

	it("continues ordinary work below the hard stop without forcing a checkpoint after three requests", async () => {
		const h = await createHarness([...Array.from({ length: 7 }, () => () => work()), () => finalAnswer()]);
		await run(h.session);

		expect(h.calls).toHaveLength(8);
		expect(h.executions).toHaveLength(7);
		expect(h.calls.slice(1).every(call => call.context.tools?.some(tool => tool.name === "qa_work"))).toBe(true);
		const entries = await h.durableEntries();
		expect(compactions(entries)).toHaveLength(0);
		expect(checkpoints(entries)).toHaveLength(0);
		expect(JSON.stringify(entries)).toContain(RAW_MARKER);
		expect(JSON.stringify(h.manager.buildSessionContext().messages)).toContain(FINAL);
		expect(h.sideRequests).toHaveLength(0);
	});

	it("does not send an unsafe checkpoint request when one giant result overshoots both watermarks", async () => {
		// Stay below the journal's existing payload truncation cap while exceeding
		// this model's safe reporting capacity, so raw preservation is observable.
		const payload = `${RAW_MARKER}\n${"oversized observation ".repeat(18_000)}`;
		const h = await createHarness([() => work(1_000), checkpoint()], {
			toolResult: payload,
			contextWindow: 100_000,
		});
		await run(h.session);

		expect(h.calls).toHaveLength(1);
		expect(h.executions).toHaveLength(1);
		expect(h.sideRequests).toHaveLength(0);
		const entries = await h.durableEntries();
		expect(compactions(entries)).toHaveLength(0);
		expect(checkpoints(entries)).toHaveLength(0);
		const raw = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		expect(raw).toMatchObject({ message: { content: [{ type: "text", text: payload }] } });
		expect(
			h.session.agent.state.messages.some(
				message =>
					message.role === "toolResult" &&
					message.content.some(block => block.type === "text" && block.text === payload),
			),
		).toBe(true);
	});

	it("preserves a natural terminal answer after warning without inventing a continuation", async () => {
		const h = await createHarness([() => work(), () => finalAnswer()]);
		await run(h.session);

		expect(h.calls).toHaveLength(2);
		expect(warningMessages(h.calls[1]!)).toHaveLength(1);
		expect(checkpoints(await h.durableEntries())).toHaveLength(0);
		expect(JSON.stringify(h.manager.buildSessionContext().messages)).toContain(FINAL);
		expect(h.sideRequests).toHaveLength(0);
	});

	it.each([
		{ disposition: "complete" as const, autoContinue: true },
		{ disposition: "blocked" as const, autoContinue: true },
		{ disposition: "continue" as const, autoContinue: false },
	])("pauses after $disposition with autoContinue=$autoContinue", async ({ disposition, autoContinue }) => {
		const h = await createHarness([() => work(), checkpoint(disposition)], {
			settings: { "compaction.autoContinue": autoContinue },
		});
		if (disposition === "blocked") {
			const now = Date.now();
			h.session.setGoalModeState({
				enabled: true,
				mode: "active",
				goal: {
					id: "qa-blocked-goal",
					objective: "Finish the parser",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: now,
					updatedAt: now,
				},
			});
		}
		await run(h.session);

		expect(h.calls).toHaveLength(2);
		const entries = await h.durableEntries();
		expect(checkpoints(entries)).toMatchObject([{ data: { disposition } }]);
		expect(compactions(entries)).toHaveLength(1);
		expect(JSON.stringify(h.manager.buildSessionContext().messages)).toContain(SUMMARY);
		expect(h.sideRequests).toHaveLength(0);
	});

	it.each(["fixed context", "retained Q&A"])("pauses once when the %s floor prevents recovery", async floor => {
		const h = await createHarness([() => work(), checkpoint()], {
			fixedContextTokens: floor === "fixed context" ? 98_000 : undefined,
		});
		await run(h.session, floor === "retained Q&A" ? textAtLeastTokens(h.session.agent, 98_000) : REQUEST);

		expect(h.calls).toHaveLength(2);
		expect(compactions(await h.durableEntries())).toHaveLength(0);
		expect(checkpoints(await h.durableEntries())).toHaveLength(1);
		expect(h.events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		expect(h.events.filter(event => event.type === "auto_compaction_end")).toMatchObject([{ skipped: true }]);
		expect(
			h.events.filter(
				event => event.type === "notice" && event.source === "compaction" && event.level === "warning",
			),
		).toHaveLength(1);
		expect(JSON.stringify(h.session.agent.state.messages)).toContain(RAW_MARKER);
		expect(h.sideRequests).toHaveLength(0);
	});

	it("requires configured fallback to recover below the QA warning rather than a higher general trigger", async () => {
		const h = await createHarness([() => work(), checkpoint()], {
			fixedContextTokens: 100_000,
			allowSoftFallback: true,
			settings: {
				"compaction.methodOrder": ["qaonly", "soft"],
				"compaction.thresholdTokens": 250_000,
			},
		});
		await run(h.session);

		expect(h.calls).toHaveLength(2);
		expect(checkpoints(await h.durableEntries())).toHaveLength(1);
		expect(h.sideRequests.length).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(h.sideRequests[0])).toContain(SUMMARY);
		expect(
			h.events.some(event => event.type === "notice" && event.source === "compaction" && event.level === "warning"),
		).toBe(true);
		expect(h.calls.filter(call => call.compactions > 0)).toHaveLength(0);
		expect(JSON.stringify(await h.durableEntries())).toContain(RAW_MARKER);
	});

	it.each([false, true])("gives queued input precedence during QA commit (hard report=%s)", async hardReport => {
		const storage = new QaStorage();
		const gate = storage.pauseNext("compaction");
		const h = await createHarness(
			[...(hardReport ? [] : [() => work()]), checkpoint(), () => finalAnswer("New direction accepted.")],
			{ storage },
		);
		if (hardReport) await seedExactOccupancy(h, HARD);
		const prompt = h.session.prompt(REQUEST);
		try {
			await withTimeout(gate.entered.promise, 2_000, "QA compaction did not reach its atomic commit");
			await h.session.followUp("NEWER_USER_DIRECTION: inspect the API only; do not run integration.");
		} finally {
			gate.release.resolve();
		}
		await prompt;
		await h.session.waitForIdle();

		expect(h.calls).toHaveLength(hardReport ? 2 : 3);
		const next = h.calls.at(-1)!;
		expect(JSON.stringify(next.context)).toContain("NEWER_USER_DIRECTION");
		expect(
			next.context.messages.filter(
				message => message.role === "user" && JSON.stringify(message.content).includes("NEWER_USER_DIRECTION"),
			),
		).toHaveLength(1);
		expect(next.messages.filter(message => message.role === "developer" && message.synthetic === true)).toHaveLength(
			0,
		);
		expect(next.compactions).toBe(1);
		expect(JSON.stringify(next.context)).not.toContain(RAW_MARKER);
	});

	it("reports checkpoint persistence failure without accepting or rewriting uncommitted work", async () => {
		const storage = new QaStorage();
		storage.failNext("checkpoint");
		const h = await createHarness(
			[() => work(), checkpoint(), () => finalAnswer("Checkpoint persistence failed; work remains saved.")],
			{ storage },
		);
		await run(h.session);

		expect(h.calls).toHaveLength(3);
		const entries = await h.durableEntries();
		expect(checkpoints(entries)).toHaveLength(0);
		expect(compactions(entries)).toHaveLength(0);
		expect(newContextResults(entries)).toMatchObject([{ isError: true, details: { code: "QA_PERSIST_FAILED" } }]);
		expect(JSON.stringify(h.calls[2]!.context)).toContain(RAW_MARKER);
		expect(h.sideRequests).toHaveLength(0);
	});

	it("preserves the pre-commit conversation when the QA boundary itself cannot persist", async () => {
		const storage = new QaStorage();
		storage.failNext("compaction");
		const h = await createHarness([() => work(), checkpoint()], { storage });
		await run(h.session);

		expect(h.calls).toHaveLength(2);
		const entries = await h.durableEntries();
		expect(checkpoints(entries)).toHaveLength(1);
		expect(compactions(entries)).toHaveLength(0);
		expect(JSON.stringify(h.session.agent.state.messages)).toContain(RAW_MARKER);
		expect(JSON.stringify(h.manager.buildSessionContext().messages)).toContain(RAW_MARKER);
		expect(h.sideRequests).toHaveLength(0);
	});

	it.each([false, true])("does not accept a checkpoint losing an abort race (hard report=%s)", async hardReport => {
		const storage = new QaStorage();
		const gate = storage.pauseNext("checkpoint");
		const h = await createHarness([...(hardReport ? [] : [() => work()]), checkpoint()], { storage });
		if (hardReport) await seedExactOccupancy(h, HARD);
		const prompt = h.session.prompt(REQUEST);
		let aborted: Promise<void> | undefined;
		try {
			await withTimeout(gate.entered.promise, 2_000, "Checkpoint did not reach persistence");
			aborted = h.session.abort();
		} finally {
			gate.release.resolve();
		}
		await aborted;
		await prompt;
		await h.session.waitForIdle();

		expect(h.calls).toHaveLength(hardReport ? 1 : 2);
		const entries = await h.durableEntries();
		expect(compactions(entries)).toHaveLength(0);
		expect(newContextResults(entries).some(result => !result.isError)).toBe(false);
		expect(JSON.stringify(h.manager.buildSessionContext().messages)).toContain(RAW_MARKER);
	});

	it.each([false, true])(
		"does not publish a QA commit cancelled before persistence (hard report=%s)",
		async hardReport => {
			const storage = new QaStorage();
			const gate = storage.pauseNext("compaction");
			const h = await createHarness([...(hardReport ? [] : [() => work()]), checkpoint()], { storage });
			if (hardReport) await seedExactOccupancy(h, HARD);
			const prompt = h.session.prompt(REQUEST);
			let aborted: Promise<void> | undefined;
			try {
				await withTimeout(gate.entered.promise, 2_000, "QA boundary did not reach persistence");
				aborted = h.session.abort();
			} finally {
				gate.release.resolve();
			}
			await aborted;
			await prompt;
			await h.session.waitForIdle();

			expect(h.calls).toHaveLength(hardReport ? 1 : 2);
			expect(compactions(await h.durableEntries())).toHaveLength(0);
			expect(JSON.stringify(h.manager.buildSessionContext().messages)).toContain(RAW_MARKER);
			expect(JSON.stringify(h.session.agent.state.messages)).toContain(RAW_MARKER);
		},
	);

	it("keeps a durable QA commit authoritative when a late consumer notification throws", async () => {
		const h = await createHarness([() => work(), checkpoint(), () => finalAnswer()]);
		let lateNotifications = 0;
		h.session.subscribe(event => {
			if (event.type !== "auto_compaction_end" || event.action !== "qaonly" || !event.result) return;
			lateNotifications++;
			throw new Error("Injected post-commit consumer notification failure");
		});
		await run(h.session);

		expect(lateNotifications).toBe(1);
		expect(h.calls).toHaveLength(3);
		const entries = await h.durableEntries();
		expect(checkpoints(entries)).toHaveLength(1);
		expect(compactions(entries)).toHaveLength(1);
		expect(JSON.stringify(h.calls[2]!.context)).toContain(SUMMARY);
		expect(JSON.stringify(h.calls[2]!.context)).not.toContain(RAW_MARKER);
		const file = h.manager.getSessionFile();
		if (!file) throw new Error("Expected committed session file");
		const reopened = await SessionManager.open(file, path.dirname(file), h.storage, { suppressBreadcrumb: true });
		try {
			expect(compactions(reopened.getEntries())).toHaveLength(1);
			expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain(SUMMARY);
			expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain(RAW_MARKER);
		} finally {
			await reopened.close();
		}
	});

	it("uses only an explicitly configured later soft method, through the real summary preparation and injected side stream", async () => {
		const h = await createHarness([() => work(), checkpoint(), () => finalAnswer()], {
			allowSoftFallback: true,
			settings: { "compaction.methodOrder": ["qaonly", "soft"] },
		});
		const history = [
			{ role: "user" as const, content: textAtLeastTokens(h.session.agent, 98_000), timestamp: Date.now() - 2 },
			finalAnswer("Historical answer preserved by QA, but eligible for the configured summary fallback."),
		];
		for (const message of history) h.manager.appendMessage(message);
		h.session.agent.replaceMessages(history);
		await h.manager.flush();
		await run(h.session);

		expect(h.sideRequests.length).toBeGreaterThanOrEqual(1);
		const summaryInput = JSON.stringify(h.sideRequests[0]);
		expect(summaryInput).toContain(SUMMARY);
		expect(summaryInput).toContain(NEXT_ACTION);
		expect(h.calls).toHaveLength(3);
		expect(compactions(await h.durableEntries())).toMatchObject([{ method: "soft" }]);
		expect(JSON.stringify(h.calls[2]!.context)).toContain(FALLBACK_SUMMARY);
	});

	it("does not apply a lower general trigger before or after a QA-first turn below the warning", async () => {
		const h = await createHarness(
			[
				() =>
					assistant(
						[{ type: "text", text: "Parser work remains saved; awaiting the next instruction." }],
						103_000,
					),
				() => work(),
				checkpoint(),
				() => finalAnswer(),
			],
			{
				allowSoftFallback: true,
				settings: { "compaction.methodOrder": ["qaonly", "soft"], "compaction.thresholdTokens": 100_000 },
			},
		);
		const history = [
			{ role: "user" as const, content: textAtLeastTokens(h.session.agent, 102_000), timestamp: Date.now() - 2 },
			finalAnswer("Earlier parser answer retained as terminal Q&A."),
		];
		for (const message of history) h.manager.appendMessage(message);
		h.session.agent.replaceMessages(history);
		await h.manager.flush();

		await run(h.session);

		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]!.compactions).toBe(0);
		expect(warningMessages(h.calls[0]!)).toHaveLength(0);
		expect(h.sideRequests).toHaveLength(0);
		expect(compactions(await h.durableEntries())).toHaveLength(0);
		expect(checkpoints(await h.durableEntries())).toHaveLength(0);

		await run(h.session, "Continue the saved parser work to its next appropriate milestone.");

		expect(h.calls).toHaveLength(4);
		expect(h.calls.slice(0, 3).map(call => call.compactions)).toEqual([0, 0, 0]);
		expect(checkpoints(await h.durableEntries())).toHaveLength(1);
		expect(h.sideRequests.length).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(h.sideRequests[0])).toContain(SUMMARY);
		expect(compactions(await h.durableEntries())).toMatchObject([{ method: "soft" }]);
		expect(JSON.stringify(h.calls[3]!.context)).toContain(FALLBACK_SUMMARY);
	});

	it.each([false, true])("delivers an owned job result once during QA commit (hard report=%s)", async hardReport => {
		const jobs = new AsyncJobManager({});
		jobManagers.push(jobs);
		const result = Promise.withResolvers<string>();
		jobGates.push(result);
		const storage = new QaStorage();
		const gate = storage.pauseNext("compaction");
		const h = await createHarness(
			[
				...(hardReport ? [] : [() => work()]),
				checkpoint("blocked"),
				() => finalAnswer("Background result acknowledged."),
			],
			{
				storage,
				asyncJobManager: jobs,
			},
		);
		if (hardReport) await seedExactOccupancy(h, HARD);
		const jobId = jobs.register("bash", "QA-race background observation", () => result.promise, {
			id: "qa-race-job",
			ownerId: "Main",
		});
		const queued = Promise.withResolvers<void>();
		// Observe the existing delivery queue without replacing the manager or sink.
		const enqueue = h.session.yieldQueue.enqueueWithReceipt.bind(h.session.yieldQueue);
		h.session.yieldQueue.enqueueWithReceipt = (kind, entry) => {
			const receipt = enqueue(kind, entry);
			if (kind === "async-result") queued.resolve();
			return receipt;
		};
		const prompt = h.session.prompt(REQUEST);
		try {
			await withTimeout(gate.entered.promise, 2_000, "QA commit did not pause for the job race");
			result.resolve("QA_JOB_RESULT_ONCE: background observation completed successfully.");
			await withTimeout(queued.promise, 2_000, "Owned async result did not reach its delivery queue");
		} finally {
			gate.release.resolve();
			h.session.yieldQueue.enqueueWithReceipt = enqueue;
		}
		await prompt;
		await h.session.settleAsyncWork();
		await h.session.waitForIdle();

		expect(jobs.getJob(jobId)?.status).toBe("completed");
		expect(jobs.isJobResultConsumed(jobId)).toBe(true);
		expect(h.session.hasPendingAsyncWork()).toBe(false);
		expect(h.calls).toHaveLength(hardReport ? 2 : 3);
		expect(JSON.stringify(h.calls.at(-1)!.context)).toContain("QA_JOB_RESULT_ONCE");
		expect(JSON.stringify(h.calls.at(-1)!.context)).not.toContain(RAW_MARKER);
		const entries = await h.durableEntries();
		expect(compactions(entries)).toHaveLength(1);
		expect(
			entries.filter(entry => entry.type === "custom_message" && entry.customType === "async-result"),
		).toHaveLength(1);
	});

	it.each([
		{ occupancy: HINT - 1, hints: 0 },
		{ occupancy: HINT, hints: 1 },
	])("starts its optional hint exactly at H (occupancy=$occupancy)", async ({ occupancy, hints }) => {
		const h = await createHarness(hints ? [checkpoint(), () => finalAnswer()] : [() => finalAnswer()]);
		await seedExactOccupancy(h, occupancy);
		await run(h.session);

		expect(
			h.calls[0]!.messages.filter(message => message.role === "custom" && message.customType === "qa-rollover-hint"),
		).toHaveLength(hints);
		expect(warningMessages(h.calls[0]!)).toHaveLength(0);
		expect(h.calls[0]!.toolChoice).toBeUndefined();
		expect(h.calls).toHaveLength(hints ? 2 : 1);
		expect(checkpoints(await h.durableEntries())).toHaveLength(hints);
	});

	it("escalates a hint to a warning in the same cycle without restricting ordinary work", async () => {
		const h = await createHarness([() => work(), checkpoint(), () => finalAnswer()]);
		await seedExactOccupancy(h, HINT);
		await run(h.session);

		expect(h.calls).toHaveLength(3);
		expect(cycleId(h.calls[0]!)).toBe(cycleId(h.calls[1]!));
		expect(warningMessages(h.calls[0]!)).toHaveLength(0);
		expect(warningMessages(h.calls[1]!)).toHaveLength(1);
		expect(h.calls[0]!.toolChoice).toBeUndefined();
		expect(h.calls[1]!.toolChoice).toBeUndefined();
		expect(h.executions).toHaveLength(1);
		expect(checkpoints(await h.durableEntries())).toHaveLength(1);
	});

	it.each([
		{ occupancy: WARNING - 1, warnings: 0 },
		{ occupancy: WARNING, warnings: 1 },
	])("starts its warning exactly at W, not below it (occupancy=$occupancy)", async ({ occupancy, warnings }) => {
		const h = await createHarness(warnings ? [checkpoint(), () => finalAnswer()] : [() => finalAnswer()]);
		await seedExactOccupancy(h, occupancy);
		await run(h.session);

		expect(warningMessages(h.calls[0]!)).toHaveLength(warnings);
		expect(h.calls).toHaveLength(warnings ? 2 : 1);
		expect(checkpoints(await h.durableEntries())).toHaveLength(warnings);
		expect(h.sideRequests).toHaveLength(0);
	});

	it.each([false, true])(
		"preserves hard-report progress with unsupported output caps=%s",
		async omitMaxOutputTokens => {
			const h = await createHarness([checkpoint(), () => finalAnswer()], { omitMaxOutputTokens });
			await seedExactOccupancy(h, HARD);
			await run(h.session);

			expect(h.calls).toHaveLength(2);
			expect(h.calls[0]!.toolChoice).toEqual({ type: "tool", name: "new_context" });
			expect(h.calls[0]!.maxTokens).toBe(omitMaxOutputTokens ? undefined : 8_192);
			expect(h.calls[0]!.context.tools?.map(tool => tool.name)).toEqual(["new_context"]);
			expect(h.executions).toHaveLength(0);
			const entries = await h.durableEntries();
			expect(checkpoints(entries)).toMatchObject([
				{ data: { summary: SUMMARY, nextAction: NEXT_ACTION, disposition: "continue" } },
			]);
			expect(compactions(entries)).toHaveLength(1);
			expect(JSON.stringify(h.calls[1]!.context)).toContain(SUMMARY);
			expect(JSON.stringify(h.calls[1]!.context)).toContain(NEXT_ACTION);
			expect(JSON.stringify(h.calls[1]!.context)).not.toContain(RAW_MARKER);
			expect(h.sideRequests).toHaveLength(0);
		},
	);

	it.each(["ordinary", "mixed", "text", "invalid"] as const)(
		"does not execute ordinary tools or reopen work after a %s hard-report response",
		async kind => {
			const report: Step = request => {
				if (kind === "ordinary") return work(HARD);
				if (kind === "text") return finalAnswer("Saved parser edits; integration is incomplete.");
				const input: QaCheckpointInput = {
					cycleId: cycleId(request),
					summary: kind === "invalid" ? " " : SUMMARY,
					disposition: "continue",
					nextAction: NEXT_ACTION,
				};
				const content: AssistantMessage["content"] = [
					{ type: "toolCall", id: "hard-report", name: "new_context", arguments: { checkpoint: input } },
				];
				if (kind === "mixed")
					content.push({ type: "toolCall", id: "forbidden-hard-work", name: "qa_work", arguments: {} });
				return assistant(content, HARD);
			};
			const h = await createHarness([report]);
			await seedExactOccupancy(h, HARD);
			await run(h.session);

			expect(h.calls).toHaveLength(1);
			expect(h.calls[0]!.toolChoice).toEqual({ type: "tool", name: "new_context" });
			expect(h.calls[0]!.context.tools?.map(tool => tool.name)).toEqual(["new_context"]);
			expect(h.executions).toHaveLength(0);
			const entries = await h.durableEntries();
			expect(checkpoints(entries)).toHaveLength(0);
			expect(compactions(entries)).toHaveLength(0);
			expect(JSON.stringify(entries)).toContain(RAW_MARKER);
			expect(JSON.stringify(h.session.agent.state.messages)).toContain(RAW_MARKER);
			expect(h.sideRequests).toHaveLength(0);
		},
	);

	it("pauses visibly when the single report attempt's transport retry is denied without a user abort", async () => {
		const h = await createHarness([
			async request => {
				try {
					await request.retryProviderRequest();
				} catch (error) {
					expect(error).toBeInstanceOf(ProviderRequestDeniedError);
					return {
						...assistant([], HARD),
						stopReason: "aborted",
						errorId: AIError.create(AIError.Flag.Abort, AIError.Flag.ProviderRequestDenied),
						errorMessage: error instanceof Error ? error.message : String(error),
					};
				}
				throw new Error("The hard-report retry must not be admitted");
			},
		]);
		await seedExactOccupancy(h, HARD);
		await run(h.session);

		expect(h.calls).toHaveLength(1);
		expect(h.executions).toHaveLength(0);
		const entries = await h.durableEntries();
		expect(checkpoints(entries)).toHaveLength(0);
		expect(compactions(entries)).toHaveLength(0);
		expect(JSON.stringify(entries)).toContain(RAW_MARKER);
		expect(JSON.stringify(h.session.agent.state.messages)).toContain(RAW_MARKER);
		expect(
			h.events.filter(
				event => event.type === "notice" && event.source === "compaction" && event.level === "warning",
			),
		).toHaveLength(1);
		expect(h.sideRequests).toHaveLength(0);
	});

	it("lets a synchronous work result settle before switching the next request to report-only", async () => {
		const h = await createHarness([() => work(HARD), checkpoint(), () => finalAnswer()]);
		await run(h.session);

		expect(h.calls).toHaveLength(3);
		expect(h.executions).toHaveLength(1);
		expect(h.calls[0]!.toolChoice).toBeUndefined();
		expect(h.calls[1]!.toolChoice).toEqual({ type: "tool", name: "new_context" });
		expect(h.calls[1]!.context.tools?.map(tool => tool.name)).toEqual(["new_context"]);
		expect(JSON.stringify(h.calls[1]!.durableEntries)).toContain(RAW_MARKER);
		expect(checkpoints(await h.durableEntries())).toHaveLength(1);
		expect(compactions(await h.durableEntries())).toHaveLength(1);
		expect(JSON.stringify(h.calls[2]!.context)).toContain(NEXT_ACTION);
	});

	it.each([
		{ reserve: undefined, contextWindow: 200_000, stop: 165_904 },
		{ reserve: 0, contextWindow: 200_000, stop: 165_904 },
		{ reserve: 0, contextWindow: 20_000, stop: 7_712 },
	])(
		"clamps the ordinary stop for window=$contextWindow and reserve=$reserve",
		async ({ reserve, contextWindow, stop }) => {
			const h = await createHarness([checkpoint(), () => finalAnswer()], {
				contextWindow,
				settings: reserve === undefined ? {} : { "compaction.reserveTokens": reserve },
			});
			await seedExactOccupancy(h, stop);
			await run(h.session);

			expect(h.calls).toHaveLength(2);
			expect(h.calls[0]!.toolChoice).toEqual({ type: "tool", name: "new_context" });
			expect(h.calls[0]!.maxTokens).toBe(8_192);
			expect(h.calls[0]!.context.tools?.map(tool => tool.name)).toEqual(["new_context"]);
			expect(h.executions).toHaveLength(0);
			expect(compactions(await h.durableEntries())).toHaveLength(1);
		},
	);

	it.each([
		{ contextWindow: 200_000, reportInputLimit: 170_000 },
		{ contextWindow: 20_000, reportInputLimit: 11_808 },
	])(
		"preserves report output capacity with a $contextWindow-token window",
		async ({ contextWindow, reportInputLimit }) => {
			const h = await createHarness([checkpoint()], {
				contextWindow,
				settings: { "compaction.reserveTokens": 0 },
			});
			await seedExactOccupancy(h, reportInputLimit + 1);
			await run(h.session);

			expect(h.calls).toHaveLength(0);
			expect(h.executions).toHaveLength(0);
			const entries = await h.durableEntries();
			expect(checkpoints(entries)).toHaveLength(0);
			expect(compactions(entries)).toHaveLength(0);
			expect(JSON.stringify(entries)).toContain(RAW_MARKER);
			expect(JSON.stringify(h.session.agent.state.messages)).toContain(RAW_MARKER);
			expect(h.sideRequests).toHaveLength(0);
		},
	);

	it.each([
		{ occupancy: 47_711, warnings: 0 },
		{ occupancy: 47_712, warnings: 1 },
	])(
		"clamps the warning below 120K for a smaller safe window (occupancy=$occupancy)",
		async ({ occupancy, warnings }) => {
			const h = await createHarness(warnings ? [checkpoint(), () => finalAnswer()] : [() => finalAnswer()], {
				contextWindow: 100_000,
			});
			await seedExactOccupancy(h, occupancy);
			await run(h.session);

			expect(warningMessages(h.calls[0]!)).toHaveLength(warnings);
			expect(h.calls[0]!.toolChoice).toBeUndefined();
			expect(h.calls).toHaveLength(warnings ? 2 : 1);
			expect(checkpoints(await h.durableEntries())).toHaveLength(warnings);
			expect(h.sideRequests).toHaveLength(0);
		},
	);

	it.each([
		{
			name: "disabled automatic compaction",
			settings: { "compaction.enabled": false },
			contextWindow: 200_000,
			maxTokens: 8_192,
		},
		{
			name: "experimental precedence",
			settings: { "compaction.experimentalContextManagement": true },
			contextWindow: 200_000,
			maxTokens: 8_192,
		},
		{
			name: "an earlier selected summary method",
			settings: { "compaction.methodOrder": ["soft", "qaonly"] },
			contextWindow: 200_000,
			maxTokens: 8_192,
		},
		{
			name: "disabled mid-turn eligibility",
			settings: { "compaction.midTurnEnabled": false },
			contextWindow: 200_000,
			maxTokens: 8_192,
		},
		{ name: "an unknown model window", settings: {}, contextWindow: 0, maxTokens: 8_192 },
		{ name: "a window too small for distinct watermarks", settings: {}, contextWindow: 1, maxTokens: 1 },
	])("does not acquire an automatic QA cycle with $name", async ({ settings, contextWindow, maxTokens }) => {
		const h = await createHarness([() => work(), () => finalAnswer()], {
			settings: { "compaction.thresholdTokens": HARD, ...settings },
			contextWindow,
			maxTokens,
		});
		await run(h.session);

		expect(h.calls.flatMap(warningMessages)).toHaveLength(0);
		expect(checkpoints(await h.durableEntries())).toHaveLength(0);
		expect(
			h.events.filter(
				event =>
					(event.type === "auto_compaction_start" || event.type === "auto_compaction_end") &&
					event.action === "qaonly",
			),
		).toHaveLength(0);
		expect(h.sideRequests).toHaveLength(0);
	});

	it.each(["stale", "malformed", "mixed-tool"] as const)(
		"rejects a %s checkpoint without claiming the QA boundary",
		async kind => {
			const h = await createHarness([
				() => work(),
				request => {
					const input: QaCheckpointInput = {
						cycleId: kind === "stale" ? `stale:${cycleId(request)}` : cycleId(request),
						summary: kind === "malformed" ? " " : SUMMARY,
						disposition: "continue",
						nextAction: NEXT_ACTION,
					};
					const content: AssistantMessage["content"] = [
						{ type: "toolCall", id: `invalid-${kind}`, name: "new_context", arguments: { checkpoint: input } },
					];
					if (kind === "mixed-tool")
						content.push({ type: "toolCall", id: "mixed-ordinary-work", name: "qa_work", arguments: {} });
					return assistant(content, WARNED_INPUT);
				},
				() => finalAnswer("The invalid checkpoint was not accepted."),
			]);
			await run(h.session);

			expect(h.calls).toHaveLength(3);
			const entries = await h.durableEntries();
			expect(newContextResults(entries)).toMatchObject([
				{ isError: true, details: { code: kind === "stale" ? "QA_STALE_CYCLE" : "QA_INVALID_CHECKPOINT" } },
			]);
			expect(checkpoints(entries)).toHaveLength(0);
			expect(compactions(entries)).toHaveLength(0);
			expect(h.executions).toHaveLength(kind === "mixed-tool" ? 2 : 1);
			expect(JSON.stringify(h.calls[2]!.context)).toContain(RAW_MARKER);
		},
	);

	it("makes identical acknowledgements idempotent and rejects conflicts before the accepted tool boundary settles", async () => {
		let duplicate: QaCheckpointAcceptance | undefined;
		let conflictCode: unknown;
		const h = await createHarness([() => work(), checkpoint(), () => finalAnswer()], {
			afterCheckpointAccepted: async (session, input, signal) => {
				duplicate = await session.acceptQaCheckpoint({ ...input }, signal);
				try {
					await session.acceptQaCheckpoint({ ...input, summary: "Different checkpoint evidence." }, signal);
				} catch (error) {
					if (!(error instanceof ToolError)) throw error;
					conflictCode = error.context?.code;
				}
			},
		});
		await run(h.session);

		const entries = await h.durableEntries();
		expect(duplicate).toMatchObject({
			requested: true,
			checkpoint: { entryId: checkpoints(entries)[0]!.id, status: "already-accepted" },
		});
		expect(conflictCode).toBe("QA_CHECKPOINT_CONFLICT");
		expect(checkpoints(entries)).toHaveLength(1);
		expect(compactions(entries)).toHaveLength(1);
		expect(h.calls).toHaveLength(3);
	});

	it.each(["configuration", "model"] as const)(
		"invalidates an in-flight acknowledgement after its %s changes",
		async changed => {
			const storage = new QaStorage();
			const gate = storage.pauseNext("checkpoint");
			const h = await createHarness(
				[() => work(), checkpoint(), () => finalAnswer("Changed policy owns the next request.")],
				{ storage },
			);
			const prompt = h.session.prompt(REQUEST);
			try {
				await withTimeout(gate.entered.promise, 2_000, "Checkpoint did not reach its ownership boundary");
				if (changed === "configuration") {
					cfgCompactionThresholdTokens.set(h.session.settings, 110_000);
				} else {
					const current = h.session.model;
					if (!current) throw new Error("Expected active fixture model");
					const replacement = { ...current, id: "qa-scripted-replacement" };
					await h.session.setModelTemporary(replacement, undefined, { ephemeral: true });
				}
			} finally {
				gate.release.resolve();
			}
			await prompt;
			await h.session.waitForIdle();

			const entries = await h.durableEntries();
			expect(newContextResults(entries)).toMatchObject([{ isError: true, details: { code: "QA_STALE_CYCLE" } }]);
			expect(checkpoints(entries)).toHaveLength(0);
			expect(compactions(entries)).toHaveLength(0);
			expect(h.calls).toHaveLength(3);
			expect(JSON.stringify(h.calls[2]!.context)).toContain(RAW_MARKER);
		},
	);
});

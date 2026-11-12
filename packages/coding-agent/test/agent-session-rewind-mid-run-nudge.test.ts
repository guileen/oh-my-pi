import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool, type AsideBoundary, type AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	DAY_STEP_BUDGET,
	MID_RUN_REWIND_NUDGE_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/instruction-anchor";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * The mid-run fold hint exists because a prompt-only instruction point is easy
 * to ignore: a real session burned ~100k tokens of exploration and never
 * folded. This defends the observable contract of the aside:
 *
 *   1. It only fires while a point is live and after
 *      {@link DAY_STEP_BUDGET} settled tool results, once per point.
 *   2. It is hidden (`display: false`) and model-only.
 *   3. It fires at most once per point; a new instruction re-arms it.
 *   4. Disabled checkpoints mean no point and no hint.
 *
 * Drives the aside provider directly, as the production loop does between
 * tool-use turns.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

const rewindStub = {
	name: "rewind",
	description: "fold the current instruction's exploration",
	parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
} as unknown as AgentTool;

describe("AgentSession mid-run rewind nudge", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let asideProvider: ((boundary: AsideBoundary) => AsideMessage[] | Promise<AsideMessage[]>) | undefined;

	const THRESHOLD = DAY_STEP_BUDGET;
	const NUDGE_TYPE = MID_RUN_REWIND_NUDGE_MESSAGE_TYPE;

	function toolUseAssistant(toolName: string): AssistantMessage {
		const id = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id, name: toolName, arguments: {} };
		return {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	/** User turns are handled asynchronously; settle before asserting the point. */
	async function emitUser(text: string): Promise<void> {
		session.agent.emitExternalEvent({
			type: "message_end",
			message: { role: "user", content: text, timestamp: Date.now() },
		});
		await Bun.sleep(1);
	}

	/** Production-shaped tool round trip: assistant toolCall turn + toolResult. */
	function emitToolResult(toolName: string): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		session.agent.emitExternalEvent({ type: "message_end", message: toolUseAssistant(toolName) });
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: false,
				timestamp: Date.now(),
			},
		});
	}

	async function drainNudges(): Promise<CustomMessage[]> {
		if (!asideProvider) throw new Error("aside provider was never captured");
		const thunks = await asideProvider("work");
		const out: CustomMessage[] = [];
		for (const entry of thunks) {
			const message = typeof entry === "function" ? entry() : entry;
			if (!message) continue;
			if (message.role !== "custom") continue;
			if ((message as CustomMessage).customType !== NUDGE_TYPE) continue;
			out.push(message as CustomMessage);
		}
		return out;
	}

	function createSession(checkpointsEnabled: boolean): void {
		tempDir = TempDir.createSync("@pi-rewind-mid-run-nudge-");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"checkpoint.enabled": checkpointsEnabled,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [rewindStub],
				messages: [],
			},
		});
		asideProvider = undefined;
		const originalSet = agent.setAsideMessageProvider.bind(agent);
		agent.setAsideMessageProvider = (fn): void => {
			if (fn !== undefined && asideProvider === undefined) asideProvider = fn;
			originalSet(fn);
		};
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
			toolRegistry: new Map([["rewind", rewindStub]]),
		});
	}

	afterEach(async () => {
		await session.dispose();
		try {
			tempDir.removeSync();
		} catch {}
	});

	it("stays silent below the threshold and keeps the point hidden from output", async () => {
		createSession(true);
		await emitUser("fix a");
		expect(session.getInstructionAnchor()?.id).toBe("R0");

		for (let i = 0; i < THRESHOLD - 1; i++) emitToolResult("read");

		expect(await drainNudges()).toEqual([]);
	});

	it("reminds once per point when the day budget is spent", async () => {
		createSession(true);
		await emitUser("fix a");
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("grep");

		const nudges = await drainNudges();
		expect(nudges.length).toBe(1);
		const nudge = nudges[0];
		expect(nudge?.display).toBe(false);
		const text = typeof nudge?.content === "string" ? nudge.content : "";
		expect(text).toContain("`R0`");
		expect(text).toContain(`${THRESHOLD} settled tool results`);
		expect(text).toContain("rewind({");

		// The poll right after firing must not re-inject.
		expect(await drainNudges()).toEqual([]);
		// A still-producing day is not nagged again: no second reminder.
		for (let i = THRESHOLD; i < THRESHOLD * 2; i++) emitToolResult("read");
		expect(await drainNudges()).toEqual([]);
	});

	it("re-arms for the next instruction", async () => {
		createSession(true);
		await emitUser("fix a");
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("read");
		expect((await drainNudges()).length).toBe(1);

		await emitUser("now fix b");
		expect(session.getInstructionAnchor()?.id).toBe("R1");
		for (let i = 0; i < THRESHOLD; i++) emitToolResult("read");

		const nudges = await drainNudges();
		expect(nudges.length).toBe(1);
		expect(nudges[0]?.content).toContain("`R1`");
	});

	it("does nothing when checkpoints are disabled", async () => {
		createSession(false);
		await emitUser("fix a");
		expect(session.getInstructionAnchor()).toBeUndefined();

		for (let i = 0; i < THRESHOLD * 2; i++) emitToolResult("read");

		expect(await drainNudges()).toEqual([]);
	});
});

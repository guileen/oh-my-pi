import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ThinkingContent } from "@oh-my-pi/pi-ai";
import {
	createMockModel,
	type MockContent,
	type MockModel,
	type MockResponseSource,
} from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CheckpointTool, RewindTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { SEARCH_MATERIAL, searchReference } from "@oh-my-pi/pi-coding-agent/session/search-rewind";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

// Legacy result fixtures deliberately omit work-package fields to cover persisted-session recovery.
const checkpointSchema = type({ goal: type("string") });
const rewindSchema = type({ report: type("string") });

const xdevWriteSchema = type({ path: type("string"), content: type("string") });

const xdevWriteTool: AgentTool<typeof xdevWriteSchema, unknown> = {
	name: "write",
	label: "Write",
	description: "Dispatch a write to an xd:// device",
	parameters: xdevWriteSchema,
	async execute(_toolCallId, params) {
		const tool = params.path === "xd://checkpoint" ? "checkpoint" : "rewind";
		if (/^\s*(?:\?|help)?\s*$/i.test(params.content)) {
			return {
				content: [{ type: "text" as const, text: `${tool} docs via xdev` }],
				details: { xdev: { tool, mode: "help" } },
			};
		}
		const parsed: unknown = JSON.parse(params.content);
		const args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		const goal = "goal" in args && typeof args.goal === "string" ? args.goal : undefined;
		const report = "report" in args && typeof args.report === "string" ? args.report : undefined;
		const inner = tool === "checkpoint" ? { goal, startedAt: "2026-01-01T00:00:00.000Z" } : { report, rewound: true };
		return {
			content: [{ type: "text" as const, text: `${tool} via xdev` }],
			details: {
				xdev: {
					tool,
					mode: "execute",
					args,
					inner,
				},
			},
		};
	},
};

const checkpointTool: AgentTool<typeof checkpointSchema, { startedAt: string }> = {
	name: "checkpoint",
	label: "Checkpoint",
	description: "Create a checkpoint",
	parameters: checkpointSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: `checkpoint:${params.goal}` }],
			details: { startedAt: "2026-01-01T00:00:00.000Z" },
		};
	},
};

const rewindTool: AgentTool<typeof rewindSchema, { report: string; rewound: boolean }> = {
	name: "rewind",
	label: "Rewind",
	description: "Rewind to the checkpoint",
	parameters: rewindSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: "rewind requested" }],
			details: { report: params.report, rewound: true },
		};
	},
};

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	extraSessions: AgentSession[];
	tempDir: TempDir;
};

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		for (const extraSession of harness?.extraSessions ?? []) {
			await extraSession.dispose();
		}
		await harness?.session.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
});

function signedThinking(thinking: string, thinkingSignature: string): MockContent {
	return { type: "thinking", thinking, thinkingSignature } as unknown as MockContent;
}

async function createHarness(
	responses: MockResponseSource,
	tools: AgentTool[] = [checkpointTool as AgentTool, rewindTool as AgentTool],
	options?: {
		onAgentEnd?: (willContinue: boolean | undefined) => void;
		resolveFallbackTool?: (name: string) => AgentTool | undefined;
		realTools?: boolean;
		realSearchTools?: boolean;
		todoBinding?: boolean;
		persist?: boolean;
		initialMessages?: AgentMessage[];
	},
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-checkpoint-rewind-branch-");
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"checkpoint.enabled": options?.realTools ?? false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	if (options?.realTools) {
		const toolSession = createToolSession({
			cwd: tempDir.path(),
			settings,
			getCheckpointState: () => session.getCheckpointState(),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
			validateRewind: (checkpointId, report, nextAction, outcome, reason) =>
				session.validateRewind(checkpointId, report, nextAction, outcome, reason),
			bindCheckpointTodo: options.todoBinding ? target => session.bindCheckpointTodo(target) : undefined,
			validateSearchRewind: input => session.validateSearchRewind(input),
			getToolForEvalBridge: name => session.getToolForEvalBridge(name),
		});
		tools = [new CheckpointTool(toolSession) as AgentTool, new RewindTool(toolSession) as AgentTool, ...tools];
		if (options.realSearchTools)
			tools.push(new GrepTool(toolSession) as AgentTool, new ReadTool(toolSession) as AgentTool);
	}
	const toolRegistry = new Map(tools.map(tool => [tool.name, tool]));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: options?.initialMessages ?? [],
		},
		convertToLlm,
		streamFn: mock.stream,
		resolveFallbackTool: options?.resolveFallbackTool,
	});

	const sessionManager = options?.persist
		? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"))
		: SessionManager.inMemory(tempDir.path());
	for (const message of options?.initialMessages ?? []) {
		if (message.role === "assistant" || message.role === "user" || message.role === "toolResult") {
			sessionManager.appendMessage(message);
		}
	}
	let extensionRunner: ExtensionRunner | undefined;
	if (options?.onAgentEnd) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", event => options.onAgentEnd?.(event.willContinue));
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"capture-agent-end",
		);
		extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry,
		extensionRunner,
	});
	const harness = { session, authStorage, tempDir, extraSessions: [] };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function expectLastAssistant(messages: AgentMessage[]): AssistantMessage {
	const message = messages.at(-1);
	expect(message?.role).toBe("assistant");
	if (message?.role !== "assistant") throw new Error("Expected last message to be assistant");
	return message;
}
function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function rewindToolForSession(session: AgentSession): RewindTool {
	return new RewindTool(
		createToolSession({
			getCheckpointState: () => session.getCheckpointState(),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
		}),
	);
}

function validatingRewindToolForSession(session: AgentSession): RewindTool {
	return new RewindTool(
		createToolSession({
			getCheckpointState: () => session.getCheckpointState(),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
			validateRewind: (checkpointId, report, nextAction) => session.validateRewind(checkpointId, report, nextAction),
		}),
	);
}

const workPackage = {
	goal: "Complete work package A",
	finishWhen: "A is implemented and its result is recorded",
	carryForward: "Keep the user constraint: do not commit",
};

function assistantFixture(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

async function createActiveWorkPackage(trace = "Exploration evidence. ".repeat(1200)) {
	const result = await new CheckpointTool(createToolSession()).execute("package_a", workPackage);
	const initialMessages: AgentMessage[] = [
		{ role: "user", content: "Complete A, then continue with B. Do not commit.", timestamp: 1 },
		assistantFixture([{ type: "toolCall", id: "package_a", name: "checkpoint", arguments: workPackage }]),
		{
			role: "toolResult",
			toolCallId: "package_a",
			toolName: "checkpoint",
			...result,
			isError: false,
			timestamp: 2,
		},
	];
	if (trace) initialMessages.push(assistantFixture([{ type: "text", text: trace }]));
	return createHarness([], [], { realTools: true, initialMessages });
}

function rewindMutationSnapshot(session: AgentSession) {
	return structuredClone({
		messages: session.messages,
		entries: session.sessionManager.getEntries(),
		leafId: session.sessionManager.getLeafId(),
		checkpoint: session.getCheckpointState(),
		completed: session.getLastCompletedRewind(),
		todos: session.getTodoPhases(),
	});
}

function expectJsonInText(text: string, value: unknown): void {
	// Accept receipt formatting differences without weakening exact string/numeric values.
	const tokens = JSON.stringify(value).match(/"(?:\\.|[^"\\])*"|[^\s]/g) ?? [];
	const pattern = tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
	expect(text).toMatch(new RegExp(pattern));
}

async function expectNoActiveCheckpointError(session: AgentSession): Promise<void> {
	await expect(
		rewindToolForSession(session).execute("repeat_rewind", {
			checkpointId: "call_checkpoint",
			report: "retry",
			nextAction: "Continue the task",
		}),
	).rejects.toThrow("No active checkpoint. Create a checkpoint before calling rewind.");
}

describe("AgentSession checkpoint rewind branch context", () => {
	it("rejects a todo binding already owned by a non-immediate ancestor", async () => {
		const { session } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "root_task", name: "checkpoint", arguments: workPackage }],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "intermediate",
							name: "checkpoint",
							arguments: { ...workPackage, todo: false },
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "duplicate", name: "checkpoint", arguments: workPackage }],
					stopReason: "toolUse",
				},
				{ content: ["Keep the existing scopes."], stopReason: "stop" },
			],
			[],
			{ realTools: true, todoBinding: true },
		);
		session.commitTodoPhases([{ name: "Build", tasks: [{ content: "A", status: "in_progress" }] }]);
		await session.prompt("Explore a nested scope without duplicating its todo.");
		const intermediate = session.messages.find(
			message => message.role === "toolResult" && message.toolCallId === "intermediate",
		);
		expect(intermediate).toMatchObject({ isError: false });
		expect(
			session.messages.find(message => message.role === "toolResult" && message.toolCallId === "duplicate"),
		).toMatchObject({ isError: true });
		expect(session.getCheckpointState()).toMatchObject({
			checkpointId: "intermediate",
			parent: { checkpointId: "root_task" },
		});
		expect(session.getTodoPhases()[0].tasks[0].status).toBe("in_progress");
	});

	it("preserves an external delivery that arrives while macro commit waits for the journal lock", async () => {
		const { session } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "bound", name: "checkpoint", arguments: workPackage }],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "close",
							name: "rewind",
							arguments: {
								checkpointId: "bound",
								report: "A verified.",
								nextAction: "Continue B.",
								outcome: "completed",
							},
						},
					],
					stopReason: "toolUse",
				},
			],
			[],
			{ realTools: true, todoBinding: true },
		);
		session.commitTodoPhases([
			{
				name: "Build",
				tasks: [
					{ content: "A", status: "in_progress" },
					{ content: "B", status: "pending" },
				],
			},
		]);
		const manager = session.sessionManager;
		const original = manager.appendEntriesAtomically.bind(manager);
		const intercept = spyOn(manager, "appendEntriesAtomically").mockImplementationOnce(
			<T>(append: () => T, options?: { commitGuard?: () => boolean }): Promise<T> => {
				manager.appendCustomMessageEntry("external-delivery", "KEEP_NEW_DELIVERY", false, undefined, "agent");
				session.agent.appendMessage({
					role: "custom",
					customType: "external-delivery",
					content: "KEEP_NEW_DELIVERY",
					display: false,
					timestamp: Date.now(),
				});
				return original(append, options);
			},
		);
		try {
			await session.prompt("Complete A.").catch(() => undefined);
			expect(intercept).toHaveBeenCalledTimes(1);
			expect(session.getTodoPhases()[0].tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
			expect(session.getCheckpointState()?.checkpointId).toBe("bound");
			expect(
				manager
					.getBranch()
					.some(
						entry =>
							entry.type === "custom_message" &&
							entry.customType === "external-delivery" &&
							entry.content === "KEEP_NEW_DELIVERY",
					),
			).toBe(true);
			expect(manager.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
		} finally {
			intercept.mockRestore();
		}
	});
	it("closes A and B into their parent phase with canonical todo advancement and no child-history accumulation", async () => {
		const running: { session?: AgentSession } = {};
		const evidenceSchema = type({ scope: "string" });
		const tool: AgentTool<typeof evidenceSchema> = {
			name: "stage_evidence",
			label: "Stage evidence",
			description: "Observe stage evidence",
			parameters: evidenceSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `${params.scope}_LOCAL_EVIDENCE `.repeat(1500) }] };
			},
		};
		const responses = (async function* () {
			yield {
				content: [
					{
						type: "toolCall",
						id: "root",
						name: "checkpoint",
						arguments: { ...workPackage, goal: "Integrate both tasks", todo: { phase: "Build" } },
					},
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "evidence", name: "stage_evidence", arguments: { scope: "STAGE" } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "a", name: "checkpoint", arguments: workPackage }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "a_evidence", name: "stage_evidence", arguments: { scope: "A" } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "close_a",
						name: "rewind",
						arguments: {
							checkpointId: "a",
							report:
								"A implemented and verified. src/shared.ts:resolveJob keeps job ids stable; B must reuse that contract.",
							nextAction: "Implement B.",
							outcome: "completed",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			expect(running.session?.getCheckpointState()?.checkpointId).toBe("root");
			expect(running.session?.getLastCompletedRewind()).toMatchObject({ checkpointId: "a", contextChanged: true });
			expect(running.session?.getTodoPhases()[0].tasks.map(task => task.status)).toEqual([
				"completed",
				"in_progress",
			]);
			const beforeB = convertToLlm(running.session?.messages ?? [])
				.map(messageText)
				.join("\n");
			expect(beforeB).toContain("src/shared.ts:resolveJob");
			expect(beforeB).toContain("job ids stable");
			expect(beforeB).not.toContain("A_LOCAL_EVIDENCE");
			yield {
				content: [
					{ type: "toolCall", id: "b", name: "checkpoint", arguments: { ...workPackage, goal: "Implement B" } },
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "b_evidence", name: "stage_evidence", arguments: { scope: "B" } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "close_b",
						name: "rewind",
						arguments: {
							checkpointId: "b",
							report:
								"B implemented and verified. src/worker.ts:resumeJob reuses stable ids; restart behavior verified.",
							nextAction: "Verify the combined stage.",
							outcome: "completed",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			expect(running.session?.getCheckpointState()?.checkpointId).toBe("root");
			const beforeParentClose = convertToLlm(running.session?.messages ?? [])
				.map(messageText)
				.join("\n");
			expect(beforeParentClose).toContain("src/shared.ts:resolveJob");
			expect(beforeParentClose).toContain("src/worker.ts:resumeJob");
			expect(beforeParentClose).not.toContain("B_LOCAL_EVIDENCE");
			expect(running.session?.getLastCompletedRewind()).toMatchObject({ checkpointId: "b", contextChanged: true });
			yield {
				content: [
					{
						type: "toolCall",
						id: "close_root",
						name: "rewind",
						arguments: {
							checkpointId: "root",
							report:
								"Both tasks and the integration boundary are verified. Stable-id flow: src/shared.ts:resolveJob → src/worker.ts:resumeJob; restart verified.",
							nextAction: "Deliver the verified work.",
							outcome: "completed",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			yield { content: ["Verified."], stopReason: "stop" as const };
		})() as MockResponseSource;
		const { session, mock } = await createHarness(responses, [tool], { realTools: true, todoBinding: true });
		running.session = session;
		session.commitTodoPhases([
			{
				name: "Build",
				tasks: [
					{ content: "A", status: "in_progress" },
					{ content: "B", status: "pending" },
				],
			},
		]);
		await session.prompt("Complete and integrate A and B.");
		expect(session.getTodoPhases()[0].tasks.map(task => task.status)).toEqual(["completed", "completed"]);
		expect(session.getCheckpointState()).toBeUndefined();
		expect(session.getLastCompletedRewind()).toMatchObject({
			checkpointId: "root",
			contextChanged: true,
			outcome: "completed",
		});
		const text = mock.calls.at(-1)?.context.messages.map(messageText).join("\n") ?? "";
		expect(text).not.toContain("A implemented and verified.");
		expect(text).not.toContain("B implemented and verified.");
		expect(text).not.toContain("STAGE_LOCAL_EVIDENCE");
		expect(text).toContain("Both tasks and the integration boundary are verified.");
		expect(text).toContain("src/shared.ts:resolveJob");
		expect(text).toContain("src/worker.ts:resumeJob");
	});

	it("records completed and blocked outcomes without cutting when the full handoff has no savings", async () => {
		for (const outcome of ["completed", "blocked"] as const) {
			const { session } = await createHarness(
				[
					{
						content: [{ type: "toolCall", id: "bound", name: "checkpoint", arguments: workPackage }],
						stopReason: "toolUse",
					},
					{
						content: [
							{
								type: "toolCall",
								id: "close",
								name: "rewind",
								arguments: {
									checkpointId: "bound",
									report: "Evidence and remaining boundary recorded. ".repeat(100),
									nextAction: "Continue B.",
									outcome,
									...(outcome === "blocked" ? { reason: "waiting for owner" } : {}),
								},
							},
						],
						stopReason: "toolUse",
					},
					{ content: ["Continue."], stopReason: "stop" },
				],
				[],
				{ realTools: true, todoBinding: true },
			);
			session.commitTodoPhases([
				{
					name: "Build",
					tasks: [
						{ content: "A", status: "in_progress" },
						{ content: "B", status: "pending" },
					],
				},
			]);
			await session.prompt("Record A's evidence-backed result and continue B.");
			expect(session.getTodoPhases()[0].tasks[0].status).toBe(outcome);
			expect(session.getTodoPhases()[0].tasks[1].status).toBe("in_progress");
			if (outcome === "blocked") expect(session.getTodoPhases()[0].tasks[0].blocker).toBe("waiting for owner");
			expect(session.getLastCompletedRewind()?.contextChanged).toBe(false);
			expect(session.sessionManager.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
			expect(session.getCheckpointState()).toBeUndefined();
			expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
		}
	});

	it("keeps the bound todo and checkpoint unchanged when macro outcome persistence fails", async () => {
		const { session } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "bound", name: "checkpoint", arguments: workPackage }],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "close",
							name: "rewind",
							arguments: {
								checkpointId: "bound",
								report: "A verified.",
								nextAction: "Continue B.",
								outcome: "completed",
							},
						},
					],
					stopReason: "toolUse",
				},
			],
			[],
			{ realTools: true, todoBinding: true },
		);
		session.commitTodoPhases([
			{
				name: "Build",
				tasks: [
					{ content: "A", status: "in_progress" },
					{ content: "B", status: "pending" },
				],
			},
		]);
		const failure = spyOn(session.sessionManager, "appendEntriesAtomically").mockRejectedValueOnce(
			new Error("outcome storage failed"),
		);
		try {
			await session.prompt("Complete A.").catch(() => undefined);
			expect(failure).toHaveBeenCalledTimes(1);
			expect(session.getTodoPhases()[0].tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
			expect(session.getCheckpointState()?.checkpointId).toBe("bound");
			expect(session.getLastCompletedRewind()).toBeUndefined();
		} finally {
			failure.mockRestore();
		}
	});

	it("rehydrates a durable parent after child completion with the refreshed todo identity", async () => {
		const harness = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "root",
							name: "checkpoint",
							arguments: { ...workPackage, todo: { phase: "Build" } },
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "child", name: "checkpoint", arguments: workPackage }],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "close",
							name: "rewind",
							arguments: {
								checkpointId: "child",
								report: "A verified.",
								nextAction: "Continue B.",
								outcome: "completed",
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["A is closed; B remains."], stopReason: "stop" },
			],
			[],
			{ realTools: true, todoBinding: true, persist: true },
		);
		harness.session.commitTodoPhases([
			{
				name: "Build",
				tasks: [
					{ content: "A", status: "in_progress" },
					{ content: "B", status: "pending" },
				],
			},
		]);
		await harness.session.prompt("Complete A before B.");
		const file = harness.session.sessionManager.getSessionFile();
		if (!file) throw new Error("Missing durable session");
		await harness.session.dispose();
		const manager = await SessionManager.open(file);
		const model = createMockModel({ responses: [] });
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
		const reloaded = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					tools: [],
					messages: manager.buildSessionContext().messages,
					systemPrompt: ["Test"],
				},
				streamFn: model.stream,
				convertToLlm,
			}),
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(harness.authStorage, path.join(harness.tempDir.path(), "reload.yml")),
		});
		harness.extraSessions.push(reloaded);
		expect(reloaded.getCheckpointState()?.checkpointId).toBe("root");
		expect(reloaded.getTodoPhases()[0].tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		expect(() => reloaded.validateRewind("root", "Not integrated yet.", "Continue B.", "completed")).toThrow(
			"every task",
		);
	});
	it("carries selected read snapshots across two search hops inside an active work package", async () => {
		let sourcePath = "";
		const responses = (async function* () {
			yield {
				content: [{ type: "toolCall", id: "parent_package", name: "checkpoint", arguments: workPackage }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{ type: "toolCall", id: "search_a", name: "grep", arguments: { pattern: "SEARCH_NOISE", path: "." } },
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "source_a", name: "read", arguments: { path: "entry.ts:1-4" } }],
				stopReason: "toolUse" as const,
			};
			await Bun.write(sourcePath, 'export const entry = "CHANGED_AFTER_READ";\n');
			yield {
				content: [
					{
						type: "toolCall",
						id: "cut_a",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", "search_a"),
							retain: [{ readId: searchReference("r", "source_a"), path: "entry.ts", from: 1, to: 4 }],
							nextAction: "Located entry; follow its worker.",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{ type: "toolCall", id: "search_b", name: "grep", arguments: { pattern: "SEARCH_NOISE", path: "." } },
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "source_b", name: "read", arguments: { path: "worker.ts:1-4" } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "cut_b",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", "search_b"),
							retain: [{ readId: searchReference("r", "source_b"), path: "worker.ts", from: 1, to: 4 }],
							nextAction: "Located worker; implement the fix.",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			yield { content: ["Ready to implement."], stopReason: "stop" as const };
		})() as MockResponseSource;
		const { session, mock, tempDir } = await createHarness(responses, [], {
			realTools: true,
			realSearchTools: true,
			todoBinding: true,
		});
		await Bun.write(
			path.join(tempDir.path(), "entry.ts"),
			'export const entry = "KEEP_ENTRY";\nexport const caller = "worker";\nexport const limit = 20;\nexport const enabled = true;\n',
		);
		await Bun.write(
			path.join(tempDir.path(), "worker.ts"),
			'export const worker = "KEEP_WORKER";\nexport const mode = "safe";\nexport const ready = true;\nexport const count = 3;\n',
		);
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 190 }, (_, i) => `export const noise${i} = "SEARCH_NOISE_${i}";`).join("\n"),
		);
		sourcePath = path.join(tempDir.path(), "entry.ts");
		session.commitTodoPhases([
			{
				name: "Locate",
				tasks: [
					{ content: "A", status: "in_progress" },
					{ content: "B", status: "pending" },
				],
			},
		]);
		await session.prompt("Locate the entry and worker, then implement. Do not commit.");
		const request = mock.calls.at(-1);
		if (!request) throw new Error("Missing post-cut request");
		const text = request.context.messages.map(messageText).join("\n");
		expect(text).toContain('export const entry = "KEEP_ENTRY";');
		expect(text).toContain('export const worker = "KEEP_WORKER";');
		expect(text).not.toContain("CHANGED_AFTER_READ");
		expect(text).not.toContain("SEARCH_NOISE_");
		expect(
			request.context.messages.filter(message => message.role === "toolResult" && message.toolName !== "checkpoint"),
		).toEqual([]);
		expect(
			session.sessionManager
				.getEntries()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "search_a",
				),
		).toBe(true);
		expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
		expect(session.sessionManager.getBranch().filter(entry => entry.type === "branch_summary")).toHaveLength(2);
		expect(session.getCheckpointState()?.checkpointId).toBe("parent_package");
		const accepted = await new RewindTool(
			createToolSession({
				getCheckpointState: () => session.getCheckpointState(),
				validateRewind: (id, report, next, outcome, reason) =>
					session.validateRewind(id, report, next, outcome, reason),
			}),
		).execute("after_hops", {
			checkpointId: "parent_package",
			report: "Both code paths located.",
			nextAction: "Continue implementation.",
			outcome: "in_progress",
		});
		expect(accepted.details?.estimate?.willCompact).toBe(true);
	});

	it("demotes and releases retained code across later decisions without resurrecting it on rebuild", async () => {
		const materialRef = () => {
			const entry = session.sessionManager
				.getBranch()
				.findLast(item => item.type === "custom_message" && item.customType === SEARCH_MATERIAL);
			if (
				entry?.type !== "custom_message" ||
				!entry.details ||
				typeof entry.details !== "object" ||
				!("ref" in entry.details) ||
				typeof entry.details.ref !== "string"
			)
				throw new Error("Missing retained material");
			return entry.details.ref;
		};
		const responses = (async function* () {
			yield {
				content: [{ type: "toolCall", id: "find1", name: "grep", arguments: { pattern: "NOISE", path: "." } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "one.ts:1-2" } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "close1",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", "find1"),
							retain: [{ readId: searchReference("r", "read1"), path: "one.ts", from: 1, to: 2 }],
							nextAction: "Follow dependency.",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			const first = materialRef();
			yield {
				content: [{ type: "toolCall", id: "find2", name: "grep", arguments: { pattern: "NOISE", path: "." } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "read2", name: "read", arguments: { path: "two.ts:1-2" } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "close2",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", "find2"),
							retain: [{ readId: searchReference("r", "read2"), path: "two.ts", from: 1, to: 2 }],
							demote: [{ ref: first, note: "The entry delegates to the worker." }],
							nextAction: "Check remaining candidates.",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			const second = materialRef();
			yield {
				content: [{ type: "toolCall", id: "find3", name: "grep", arguments: { pattern: "NOISE", path: "." } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "close3",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", "find3"),
							release: [second],
							nextAction: "Located the relevant path; continue.",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			yield { content: ["Ready."], stopReason: "stop" as const };
		})() as MockResponseSource;
		const { session, mock, tempDir } = await createHarness(responses, [], { realTools: true, realSearchTools: true });
		await Bun.write(
			path.join(tempDir.path(), "one.ts"),
			'export const one = "OLD_ENTRY_BODY";\nexport const target = "two";\n',
		);
		await Bun.write(
			path.join(tempDir.path(), "two.ts"),
			'export const two = "OLD_WORKER_BODY";\nexport const ready = true;\n',
		);
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 180 }, (_, i) => `export const n${i} = "NOISE_${i}";`).join("\n"),
		);
		await session.prompt("Locate the dependency and retain only the final decision.");
		const text = mock.calls.at(-1)?.context.messages.map(messageText).join("\n") ?? "";
		expect(text).toContain("The entry delegates to the worker.");
		expect(text).toContain("[one.ts#");
		expect(text).not.toContain("OLD_ENTRY_BODY");
		expect(text).not.toContain("OLD_WORKER_BODY");
		expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
	});

	it("rewinds search before reading, then excludes a standalone wrong read before the next read", async () => {
		const chosen = 'export const chosen = "CORRECT_SOURCE";';
		const responses = (async function* () {
			yield {
				content: [{ type: "toolCall", id: "locate", name: "grep", arguments: { pattern: "CANDIDATE", path: "." } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "locate_cut",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", "locate"),
							note: "Two candidates located; inspect the first.",
							nextAction: "Read wrong.ts.",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "wrong", name: "read", arguments: { path: "wrong.ts" } }],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "wrong_cut",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", "wrong"),
							note: "Exclude wrong.ts: it is generated test data, not the implementation.",
							nextAction: "Read correct.ts.",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [{ type: "toolCall", id: "correct", name: "read", arguments: { path: "correct.ts:1-2" } }],
				stopReason: "toolUse" as const,
			};
			yield { content: ["Located the implementation."], stopReason: "stop" as const };
		})() as MockResponseSource;
		const { session, mock, tempDir } = await createHarness(responses, [], {
			realTools: true,
			realSearchTools: true,
		});
		await Bun.write(
			path.join(tempDir.path(), "wrong.ts"),
			Array.from({ length: 180 }, (_, i) => `export const item${i} = "CANDIDATE_WRONG_READ_${i}";`).join("\n"),
		);
		await Bun.write(path.join(tempDir.path(), "correct.ts"), `${chosen}\nexport const ready = true;\n`);
		await session.prompt("Locate the implementation, retiring each observation before the next read.");
		const beforeWrong = mock.calls[2]!.context.messages;
		expect(beforeWrong.map(messageText).join("\n")).not.toContain("CANDIDATE_WRONG_READ_");
		expect(beforeWrong.some(message => message.role === "toolResult" && message.toolName === "read")).toBe(false);
		const beforeCorrect = mock.calls[4]!.context.messages;
		const beforeCorrectText = beforeCorrect.map(messageText).join("\n");
		expect(beforeCorrectText).toContain("Two candidates located; inspect the first.");
		expect(beforeCorrectText).toContain("Exclude wrong.ts: it is generated test data, not the implementation.");
		expect(beforeCorrectText).not.toContain("CANDIDATE_WRONG_READ_");
		expect(beforeCorrect.some(message => message.role === "toolResult" && message.toolName === "read")).toBe(false);
		expect(beforeCorrectText).not.toContain(chosen);
		expect(mock.calls[5]!.context.messages.map(messageText).join("\n")).toContain(chosen);
		const originalResults = session.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(messageText(originalResults.find(result => result.toolCallId === "locate")!)).toContain(
			`observationId=${searchReference("o", "locate")}`,
		);
		expect(messageText(originalResults.find(result => result.toolCallId === "wrong")!)).toContain(
			`observationId=${searchReference("o", "wrong")}`,
		);
		expect(messageText(originalResults.find(result => result.toolCallId === "wrong")!)).toContain(
			`readId=${searchReference("r", "wrong")}`,
		);
		expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
	});

	it("delivers fused source reads to the very next provider request and reloads them without rereading", async () => {
		const note = "source.ts contains the implementation; generated matches are excluded.";
		const nextAction = "Use the displayed implementation to make the requested change.";
		const harness = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "fused_search",
							name: "grep",
							arguments: { pattern: "FUSED_SEARCH_NOISE", path: "." },
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "fused_cut",
							name: "rewind",
							arguments: {
								observationId: searchReference("o", "fused_search"),
								note,
								nextAction,
								read: ["source.ts:2-4"],
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["Continue directly from the source."], stopReason: "stop" },
			],
			[],
			{ realTools: true, realSearchTools: true, persist: true },
		);
		const { session, mock, tempDir, authStorage, extraSessions } = harness;
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 190 }, (_, i) => `export const noise${i} = "FUSED_SEARCH_NOISE_${i}";`).join("\n"),
		);
		await Bun.write(
			path.join(tempDir.path(), "source.ts"),
			'export function render(value: string) {\n\tif (value) {\n\t\treturn "EXACT_FUSED_SOURCE";\n\t}\n\treturn value;\n}\n',
		);
		const reader = session.agent.state.tools.find(tool => tool.name === "read");
		if (!reader) throw new Error("Missing canonical reader");
		const reads = spyOn(reader, "execute");
		try {
			await session.prompt("Locate the implementation and continue without a separate read turn.");
			expect(mock.calls).toHaveLength(3);
			expect(reads).toHaveBeenCalledTimes(1);
			expect(reads.mock.calls[0]?.[1]).toEqual({ path: "source.ts:2-4" });
			const request = mock.calls[2]!.context.messages;
			const text = request.map(messageText).join("\n");
			expect(text).toContain(note);
			expect(text).toContain(nextAction);
			expect(text).toMatch(/\[source\.ts#[0-9a-f]{4}\]/i);
			expect(text).toContain('3:\t\treturn "EXACT_FUSED_SOURCE";');
			expect(text).toContain("2:\tif (value) {");
			expect(text).not.toContain("FUSED_SEARCH_NOISE_");
			expect(request.some(message => message.role === "toolResult" && message.toolName === "grep")).toBe(false);
			const sourceResults = request.filter(message => message.role === "toolResult" && message.toolName === "read");
			expect(sourceResults).toHaveLength(1);
			const source = sourceResults[0]!;
			if (source.role !== "toolResult") throw new Error("Missing fused source result");
			expect(source.toolCallId).toBe("fused_cut:read:0");
			expect(source.isError).toBe(false);
			expect(messageText(source)).toContain(`observationId=${searchReference("o", source.toolCallId)}`);
			expect(messageText(source)).toContain(`readId=${searchReference("r", source.toolCallId)}`);
			const sourceCalls = request.flatMap(message =>
				message.role === "assistant"
					? message.content.filter(block => block.type === "toolCall" && block.name === "read")
					: [],
			);
			expect(sourceCalls).toEqual([
				{ type: "toolCall", id: source.toolCallId, name: "read", arguments: { path: "source.ts:2-4" } },
			]);
			expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
			const committed = structuredClone(
				session.messages.filter(message => message.role === "toolResult" && message.toolName === "read"),
			);
			const file = session.sessionManager.getSessionFile();
			if (!file) throw new Error("Missing durable fused-read session");
			await session.dispose();
			await Bun.write(path.join(tempDir.path(), "source.ts"), "SOURCE_CHANGED_AFTER_FUSED_READ\n");
			const manager = await SessionManager.open(file);
			const model = createMockModel({
				responses: [{ content: ["Continue from the saved source."], stopReason: "stop" }],
			});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.reminders": false,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			const reloaded = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: {
						model,
						tools: [reader],
						messages: manager.buildSessionContext().messages,
						systemPrompt: ["Test"],
					},
					streamFn: model.stream,
					convertToLlm,
				}),
				sessionManager: manager,
				settings,
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "fused-reload.yml")),
				toolRegistry: new Map([[reader.name, reader]]),
			});
			extraSessions.push(reloaded);
			expect(
				reloaded.messages.filter(message => message.role === "toolResult" && message.toolName === "read"),
			).toEqual(committed);
			await reloaded.prompt("Continue from the saved implementation.");
			const resumedText = model.calls[0]!.context.messages.map(messageText).join("\n");
			expect(resumedText).toContain('3:\t\treturn "EXACT_FUSED_SOURCE";');
			expect(resumedText).toMatch(/\[source\.ts#[0-9a-f]{4}\]/i);
			expect(resumedText).not.toContain("SOURCE_CHANGED_AFTER_FUSED_READ");
			expect(resumedText).not.toContain("FUSED_SEARCH_NOISE_");
			expect(reads).toHaveBeenCalledTimes(1);
		} finally {
			reads.mockRestore();
		}
	});

	it("keeps successful fused ranges and a canonical read failure together without another model round", async () => {
		const paths = ["entry.ts:2-3", "missing.ts:1-2", "worker.ts:2-4", "entry.ts:9-10"];
		const { session, mock, tempDir } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "ranges_search",
							name: "grep",
							arguments: { pattern: "RANGES_NOISE", path: "." },
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "ranges_cut",
							name: "rewind",
							arguments: {
								observationId: searchReference("o", "ranges_search"),
								note: "Entry and worker own the implementation; missing.ts remains unverified.",
								nextAction: "Compare the displayed sources and account for the missing-file error.",
								read: paths,
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["Use available source and investigate the error."], stopReason: "stop" },
			],
			[],
			{ realTools: true, realSearchTools: true },
		);
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 190 }, (_, i) => `export const noise${i} = "RANGES_NOISE_${i}";`).join("\n"),
		);
		await Bun.write(
			path.join(tempDir.path(), "entry.ts"),
			Array.from({ length: 15 }, (_, i) => `export const entry${i + 1} = "ENTRY_EXACT_${i + 1}";`).join("\n"),
		);
		await Bun.write(
			path.join(tempDir.path(), "worker.ts"),
			'export function worker() {\n\tconst value = "WORKER_EXACT_SOURCE";\n\treturn value;\n}\n',
		);
		const reader = session.agent.state.tools.find(tool => tool.name === "read");
		if (!reader) throw new Error("Missing canonical reader");
		const reads = spyOn(reader, "execute");
		try {
			await session.prompt("Locate both implementations, preserving any read error.");
			expect(mock.calls).toHaveLength(3);
			expect(reads).toHaveBeenCalledTimes(paths.length);
			expect(reads.mock.calls.map(call => call[1])).toEqual(paths.map(path => ({ path })));
			const request = mock.calls[2]!.context.messages;
			const results = request.filter(message => message.role === "toolResult" && message.toolName === "read");
			expect(results).toHaveLength(paths.length);
			expect(new Set(results.map(result => result.role === "toolResult" && result.toolCallId)).size).toBe(
				paths.length,
			);
			expect(results.map(result => result.role === "toolResult" && result.isError)).toEqual([
				false,
				true,
				false,
				false,
			]);
			expect(messageText(results[0]!)).toContain('2:export const entry2 = "ENTRY_EXACT_2";');
			expect(messageText(results[2]!)).toContain('2:\tconst value = "WORKER_EXACT_SOURCE";');
			expect(messageText(results[3]!)).toContain('9:export const entry9 = "ENTRY_EXACT_9";');
			expect(messageText(results[0]!)).toMatch(/\[entry\.ts#[0-9a-f]{4}\]/i);
			expect(messageText(results[2]!)).toMatch(/\[worker\.ts#[0-9a-f]{4}\]/i);
			const failure = results[1]!;
			const canonicalFailure = await Promise.resolve(reads.mock.results[1]!.value as Promise<AgentToolResult>).then(
				result => ({ result }),
				(error: unknown) => ({ error }),
			);
			if (failure.role !== "toolResult") throw new Error("Missing failed read result");
			if ("error" in canonicalFailure) {
				const error = canonicalFailure.error;
				expect(messageText(failure)).toContain(error instanceof Error ? error.message : String(error));
			} else {
				for (const block of canonicalFailure.result.content) {
					if (block.type === "text") expect(messageText(failure)).toContain(block.text);
				}
			}
			expect(messageText(failure)).toContain("missing.ts");
			expect(request.map(messageText).join("\n")).not.toContain("RANGES_NOISE_");
			expect(request.some(message => message.role === "toolResult" && message.toolName === "grep")).toBe(false);
			expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
		} finally {
			reads.mockRestore();
		}
	});

	it("rejects invalid boundaries and disabled fused readers before reading or changing the branch", async () => {
		const { session, tempDir } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "disabled_search",
							name: "grep",
							arguments: { pattern: "DISABLED_NOISE", path: "." },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["Located the source."], stopReason: "stop" },
			],
			[],
			{ realTools: true, realSearchTools: true },
		);
		await Bun.write(
			path.join(tempDir.path(), "source.ts"),
			Array.from({ length: 190 }, (_, i) => `export const value${i} = "DISABLED_NOISE_${i}";`).join("\n"),
		);
		await session.prompt("Locate the source.");
		const reader = session.agent.state.tools.find(tool => tool.name === "read");
		const rewind = session.agent.state.tools.find(tool => tool.name === "rewind");
		if (!reader || !rewind) throw new Error("Missing real rewind/read tools");
		const reads = spyOn(reader, "execute");
		try {
			const beforeInvalid = rewindMutationSnapshot(session);
			await expect(
				rewind.execute("invalid_fused_cut", {
					observationId: searchReference("o", "never_delivered"),
					nextAction: "Implement the change.",
					read: ["source.ts:1-2"],
				}),
			).rejects.toThrow();
			expect(reads).toHaveBeenCalledTimes(0);
			expect(rewindMutationSnapshot(session)).toEqual(beforeInvalid);
			await session.setActiveToolsByName(["checkpoint", "rewind", "grep"]);
			expect(session.getToolForEvalBridge("read")).toBeUndefined();
			const beforeDisabled = rewindMutationSnapshot(session);
			await expect(
				rewind.execute("disabled_fused_cut", {
					observationId: searchReference("o", "disabled_search"),
					nextAction: "Implement the change.",
					read: ["source.ts:1-2"],
				}),
			).rejects.toThrow(/read/i);
			expect(reads).toHaveBeenCalledTimes(0);
			expect(rewindMutationSnapshot(session)).toEqual(beforeDisabled);
		} finally {
			reads.mockRestore();
		}
	});

	it("rejects fused reads on macro rewind without performing I/O or consuming the checkpoint", async () => {
		const { session } = await createActiveWorkPackage();
		const rewind = session.agent.state.tools.find(tool => tool.name === "rewind");
		if (!rewind) throw new Error("Missing real rewind tool");
		const bridge = spyOn(session, "getToolForEvalBridge");
		const before = rewindMutationSnapshot(session);
		try {
			await expect(
				rewind.execute("macro_read_cut", {
					checkpointId: "package_a",
					report: "A implemented.",
					nextAction: "Continue B.",
					read: ["source.ts:1-2"],
				}),
			).rejects.toThrow(/read|observation|macro/i);
			expect(bridge).toHaveBeenCalledTimes(0);
			expect(rewindMutationSnapshot(session)).toEqual(before);
		} finally {
			bridge.mockRestore();
		}
	});

	it("can retire a wrong fused source and retain a later fused source using its ordinary read identity", async () => {
		let wrongCallId = "";
		let correctCallId = "";
		async function* responses() {
			yield {
				content: [
					{
						type: "toolCall",
						id: "identity_search",
						name: "grep",
						arguments: { pattern: "IDENTITY_NOISE", path: "." },
					},
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "identity_cut",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", "identity_search"),
							note: "Two candidate implementations located.",
							nextAction: "Determine whether the displayed candidate owns the behavior.",
							read: ["wrong.ts:1-140"],
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			const wrong = session.messages.findLast(
				message => message.role === "toolResult" && message.toolName === "read",
			);
			if (wrong?.role !== "toolResult") throw new Error("Missing wrong fused source observation");
			wrongCallId = wrong.toolCallId;
			yield {
				content: [
					{
						type: "toolCall",
						id: "wrong_fused_cut",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", wrongCallId),
							note: "Exclude wrong.ts: generated fixtures do not own the implementation.",
							nextAction: "Use the displayed correct implementation to follow its dependency.",
							read: ["correct.ts:1-4"],
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			const correct = session.messages.findLast(
				message => message.role === "toolResult" && message.toolName === "read",
			);
			if (correct?.role !== "toolResult") throw new Error("Missing correct fused source observation");
			correctCallId = correct.toolCallId;
			yield {
				content: [
					{
						type: "toolCall",
						id: "dependency_search",
						name: "grep",
						arguments: { pattern: "IDENTITY_NOISE", path: "." },
					},
				],
				stopReason: "toolUse" as const,
			};
			yield {
				content: [
					{
						type: "toolCall",
						id: "retain_fused_cut",
						name: "rewind",
						arguments: {
							observationId: searchReference("o", correctCallId),
							retain: [{ readId: searchReference("r", correctCallId), path: "correct.ts", from: 1, to: 4 }],
							note: "The dependency search adds no implementation evidence.",
							nextAction: "Implement against the retained correct source.",
						},
					},
				],
				stopReason: "toolUse" as const,
			};
			yield { content: ["Proceed with the retained implementation."], stopReason: "stop" as const };
		}
		const harness = await createHarness(responses() as MockResponseSource, [], {
			realTools: true,
			realSearchTools: true,
		});
		const session = harness.session;
		const { mock, tempDir } = harness;
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 190 }, (_, i) => `export const noise${i} = "IDENTITY_NOISE_${i}";`).join("\n"),
		);
		await Bun.write(
			path.join(tempDir.path(), "wrong.ts"),
			Array.from({ length: 160 }, (_, i) => `export const fixture${i} = "WRONG_FUSED_BODY_${i}";`).join("\n"),
		);
		await Bun.write(
			path.join(tempDir.path(), "correct.ts"),
			'export function correct() {\n\tconst value = "RETAINED_FUSED_SOURCE";\n\treturn value;\n}\n',
		);
		const reader = session.agent.state.tools.find(tool => tool.name === "read");
		if (!reader) throw new Error("Missing canonical reader");
		const reads = spyOn(reader, "execute");
		try {
			await session.prompt(
				"Locate the implementation, excluding generated candidates and retaining the correct source.",
			);
			expect(mock.calls).toHaveLength(6);
			expect(reads).toHaveBeenCalledTimes(2);
			expect(wrongCallId).toBe("identity_cut:read:0");
			expect(correctCallId).toBe("wrong_fused_cut:read:0");
			const afterWrong = mock.calls[2]!.context.messages.map(messageText).join("\n");
			expect(afterWrong).toContain('1:export const fixture0 = "WRONG_FUSED_BODY_0";');
			expect(afterWrong).toContain(`observationId=${searchReference("o", wrongCallId)}`);
			const afterCorrect = mock.calls[3]!.context.messages.map(messageText).join("\n");
			expect(afterCorrect).not.toContain("WRONG_FUSED_BODY_");
			expect(afterCorrect).toContain("Exclude wrong.ts: generated fixtures do not own the implementation.");
			expect(afterCorrect).toContain('2:\tconst value = "RETAINED_FUSED_SOURCE";');
			expect(afterCorrect).toContain(`readId=${searchReference("r", correctCallId)}`);
			const afterRetain = mock.calls[5]!.context.messages;
			const finalText = afterRetain.map(messageText).join("\n");
			expect(finalText).toContain('2:\tconst value = "RETAINED_FUSED_SOURCE";');
			expect(finalText).toMatch(/\[correct\.ts#[0-9a-f]{4}\]/i);
			expect(finalText).not.toContain("WRONG_FUSED_BODY_");
			expect(finalText).not.toContain("IDENTITY_NOISE_");
			expect(afterRetain.some(message => message.role === "toolResult" && message.toolName === "read")).toBe(false);
			expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
		} finally {
			reads.mockRestore();
		}
	});

	it("does not commit a stale cut when new user input arrives while a fused read is pending", async () => {
		const { session, tempDir } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "pending_search",
							name: "grep",
							arguments: { pattern: "PENDING_NOISE", path: "." },
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "pending_cut",
							name: "rewind",
							arguments: {
								observationId: searchReference("o", "pending_search"),
								nextAction: "Implement the displayed source.",
								read: ["source.ts:1-2"],
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["Preserve the new instructions and exploration."], stopReason: "stop" },
			],
			[],
			{ realTools: true, realSearchTools: true },
		);
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 190 }, (_, i) => `export const noise${i} = "PENDING_NOISE_${i}";`).join("\n"),
		);
		await Bun.write(path.join(tempDir.path(), "source.ts"), 'export const source = "STALE_FUSED_SOURCE";\n');
		const reader = session.agent.state.tools.find(tool => tool.name === "read");
		if (!reader) throw new Error("Missing canonical reader");
		const execute = reader.execute.bind(reader);
		const { promise: reading, resolve: announceRead } = Promise.withResolvers<void>();
		const { promise: pending, resolve: releaseRead } = Promise.withResolvers<void>();
		const reads = spyOn(reader, "execute").mockImplementationOnce(async (...args) => {
			announceRead();
			await pending;
			return execute(...args);
		});
		try {
			const run = session.prompt("Locate and read the implementation.");
			await reading;
			const instruction = {
				role: "user" as const,
				content: "NEW_USER_INPUT: preserve this exploration and do not apply the old cut.",
				timestamp: Date.now(),
			};
			session.sessionManager.appendMessage(instruction);
			session.agent.appendMessage(instruction);
			releaseRead();
			await run.catch(() => undefined);
			expect(reads).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
			const rebuilt = session.sessionManager.buildSessionContext().messages;
			const text = convertToLlm(rebuilt).map(messageText).join("\n");
			expect(text).toContain("NEW_USER_INPUT: preserve this exploration");
			expect(text).toContain("PENDING_NOISE_");
			expect(rebuilt.some(message => message.role === "toolResult" && message.toolName === "read")).toBe(false);
			expect(session.messages.some(message => message.role === "toolResult" && message.toolName === "read")).toBe(
				false,
			);
		} finally {
			releaseRead();
			reads.mockRestore();
		}
	});

	it("does not persist fused source calls or results when the branch transaction fails", async () => {
		const { session, tempDir } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "atomic_search",
							name: "grep",
							arguments: { pattern: "ATOMIC_NOISE", path: "." },
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "atomic_cut",
							name: "rewind",
							arguments: {
								observationId: searchReference("o", "atomic_search"),
								nextAction: "Implement the displayed source.",
								read: ["source.ts:1-2"],
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["The exploration remains available."], stopReason: "stop" },
			],
			[],
			{ realTools: true, realSearchTools: true, persist: true },
		);
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 190 }, (_, i) => `export const noise${i} = "ATOMIC_NOISE_${i}";`).join("\n"),
		);
		await Bun.write(path.join(tempDir.path(), "source.ts"), 'export const source = "UNCOMMITTED_FUSED_SOURCE";\n');
		const reader = session.agent.state.tools.find(tool => tool.name === "read");
		if (!reader) throw new Error("Missing canonical reader");
		const reads = spyOn(reader, "execute");
		const failure = spyOn(session.sessionManager, "appendEntriesAtomically").mockRejectedValueOnce(
			new Error("fused-read storage unavailable"),
		);
		try {
			await session.prompt("Locate and read the implementation atomically.").catch(() => undefined);
			expect(reads).toHaveBeenCalledTimes(1);
			expect(failure).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
			const persistedMessages = session.sessionManager
				.getEntries()
				.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
			expect(
				persistedMessages.some(message => message.role === "toolResult" && message.toolCallId === "atomic_search"),
			).toBe(true);
			expect(
				persistedMessages.some(
					message =>
						(message.role === "toolResult" && message.toolName === "read") ||
						(message.role === "assistant" &&
							message.content.some(block => block.type === "toolCall" && block.name === "read")),
				),
			).toBe(false);
			expect(convertToLlm(session.messages).map(messageText).join("\n")).toContain("ATOMIC_NOISE_");
		} finally {
			failure.mockRestore();
			reads.mockRestore();
		}
	});

	it("retires failed and uncertain action logs while exact receipts, selected error text and images survive hops and reload", async () => {
		const schema = type({ request: "string", options: { label: "string", flags: "string[]" } });
		const cases = [
			{
				name: "bash",
				id: "failed_test",
				isError: true,
				args: {
					request: "bun test 'edge case.test.ts'\n# preserve exactly",
					options: { label: "test run", flags: ["--timeout=19", "a b"] },
				},
				details: { exitCode: 1, async: { id: "bg_exact_17", status: "still-running" }, signal: null },
			},
			{
				name: "browser",
				id: "failed_browser",
				isError: true,
				args: {
					request: "await page.click('[data-action=\"save\"]')",
					options: { label: "save attempt", flags: ["do not replay"] },
				},
				details: {
					targetId: "tab_exact_9",
					action: { status: "uncertain", submitted: true },
					errors: ["navigation timeout"],
				},
			},
			{
				name: "probe",
				id: "unknown_action",
				isError: false,
				args: {
					request: "dispatch action with unknown outcome",
					options: { label: "not proof of success", flags: [] },
				},
				details: { handle: "job_exact_42", status: "accepted", businessSuccess: null },
			},
		];
		const selectedError = "ASSERTION_EXACT: expected 3, received 4.";
		const keptImage = { type: "image" as const, data: "a2VlcC1pbWFnZQ==", mimeType: "image/png" };
		const droppedImage = { type: "image" as const, data: "ZHJvcC1pbWFnZQ==", mimeType: "image/png" };
		const invocations: string[] = [];
		const tools = cases.map(item => ({
			name: item.name,
			label: item.name,
			description: "Action receipt fixture",
			parameters: schema,
			async execute() {
				invocations.push(item.id);
				if (item.name === "browser") {
					session.sessionManager.appendCustomMessageEntry(
						"async-result",
						"ASYNC_NOTIFICATION_MUST_SURVIVE",
						false,
						{ jobId: "unrelated_job_23", status: "completed" },
						"agent",
					);
					session.agent.appendMessage({
						role: "custom",
						customType: "async-result",
						content: "ASYNC_NOTIFICATION_MUST_SURVIVE",
						display: false,
						attribution: "agent",
						details: { jobId: "unrelated_job_23", status: "completed" },
						timestamp: Date.now(),
					});
				}
				return {
					content: [
						{ type: "text" as const, text: `${item.id}_PRIVATE_LOG\n`.repeat(900) },
						{
							type: "text" as const,
							text: item.name === "bash" ? `prefix\n${selectedError}\nsuffix` : "unselected result",
						},
						...(item.name === "browser" ? [droppedImage, keptImage] : []),
					],
					details: item.details,
					isError: item.isError,
				};
			},
		})) as AgentTool[];
		const { session, mock, tempDir, authStorage, extraSessions } = await createHarness(
			[
				{
					content: cases.map(item => ({ type: "toolCall", id: item.id, name: item.name, arguments: item.args })),
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "actions_cut",
							name: "rewind",
							arguments: {
								observationId: searchReference("o", "failed_test"),
								note: "Test failed; browser action outcome is uncertain. Do not repeat either action.",
								keep: [
									{ observationId: searchReference("o", "failed_test"), text: selectedError },
									{ observationId: searchReference("o", "failed_browser"), images: [1] },
								],
								nextAction: "Locate the cause without replaying actions.",
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "followup_search",
							name: "grep",
							arguments: { pattern: "FOLLOWUP_NOISE", path: "." },
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "followup_cut",
							name: "rewind",
							arguments: {
								observationId: searchReference("o", "followup_search"),
								note: "Excluded generated diagnostics; investigate the assertion.",
								nextAction: "Inspect the assertion source.",
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["Proceed without replaying side effects."], stopReason: "stop" },
			],
			tools,
			{ realTools: true, realSearchTools: true, persist: true },
		);
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 180 }, (_, i) => `export const n${i} = "FOLLOWUP_NOISE_${i}";`).join("\n"),
		);
		await session.prompt("Investigate failures; preserve action receipts and exact selected evidence.");
		const assertEvidence = (messages: Message[]) => {
			const text = messages.map(messageText).join("\n");
			expect(text).toContain(selectedError);
			expect(text).toContain("Test failed; browser action outcome is uncertain. Do not repeat either action.");
			expect(text).toContain("ASYNC_NOTIFICATION_MUST_SURVIVE");
			for (const item of cases) {
				expect(text).not.toContain(`${item.id}_PRIVATE_LOG`);
				expect(text).toContain(item.name);
				expectJsonInText(text, item.args);
				expectJsonInText(text, item.details);
			}
			expect(text).toMatch(/"isError"\s*:\s*true/);
			expect(text).toMatch(/"isError"\s*:\s*false/);
			const images = messages.flatMap(message =>
				typeof message.content === "string" ? [] : message.content.filter(block => block.type === "image"),
			);
			expect(images).toEqual([keptImage]);
			expect(text).not.toContain("prefix");
			expect(text).not.toContain("suffix");
			expect(text).not.toContain("unselected result");
			expect(
				messages.some(
					message => message.role === "toolResult" && cases.some(item => item.id === message.toolCallId),
				),
			).toBe(false);
		};
		assertEvidence(mock.calls[2]!.context.messages);
		assertEvidence(mock.calls[4]!.context.messages);
		expect(mock.calls[4]!.context.messages.map(messageText).join("\n")).not.toContain("FOLLOWUP_NOISE_");
		expect(mock.calls[4]!.context.messages.map(messageText).join("\n")).toContain(
			"Excluded generated diagnostics; investigate the assertion.",
		);
		expect(invocations.sort()).toEqual(cases.map(item => item.id).sort());
		const results = session.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		for (const item of cases) {
			const result = results.find(message => message.toolCallId === item.id)!;
			expect(result.isError).toBe(item.isError);
			expect(messageText(result)).toContain(`observationId=${searchReference("o", item.id)}`);
		}
		expect(messageText(results.find(result => result.toolCallId === "actions_cut")!)).not.toContain("observationId=");
		const committed = structuredClone(session.messages.filter(message => message.role === "custom"));
		const file = session.sessionManager.getSessionFile();
		if (!file) throw new Error("Missing durable observation session");
		await session.dispose();
		const manager = await SessionManager.open(file);
		const model = createMockModel({ responses: [] });
		const reloaded = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					tools: [],
					messages: manager.buildSessionContext().messages,
					systemPrompt: ["Test"],
				},
				streamFn: model.stream,
				convertToLlm,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "observation-reload.yml")),
		});
		extraSessions.push(reloaded);
		expect(reloaded.messages.filter(message => message.role === "custom")).toEqual(committed);
		expect(reloaded.messages).toEqual(manager.buildSessionContext().messages);
		assertEvidence(convertToLlm(reloaded.messages));
	});

	it("rejects invented kept text, cross-part text and undelivered images without mutating history", async () => {
		const tool: AgentTool = {
			name: "browser",
			label: "Browser",
			description: "Deliver exact evidence",
			parameters: type({}),
			async execute() {
				return {
					content: [
						{ type: "text", text: "FIRST_DELIVERED_PART\n".repeat(700) },
						{ type: "text", text: "SECOND_DELIVERED_PART" },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					],
					details: { target: "exact-tab" },
					isError: true,
				};
			},
		};
		const { session } = await createHarness(
			[
				{ content: [{ type: "toolCall", id: "evidence", name: "browser", arguments: {} }], stopReason: "toolUse" },
				{ content: ["Decide what to retain."], stopReason: "stop" },
			],
			[tool],
			{ realTools: true },
		);
		await session.prompt("Inspect delivered evidence.");
		const before = rewindMutationSnapshot(session);
		const observationId = searchReference("o", "evidence");
		for (const keep of [
			[{ observationId, text: "MODEL_INVENTED_TEXT" }],
			[{ observationId, text: "FIRST_DELIVERED_PART\nSECOND_DELIVERED_PART" }],
			[{ observationId, images: [1] }],
			[{ observationId: searchReference("o", "not_delivered"), text: "SECOND_DELIVERED_PART" }],
		]) {
			expect(() => session.validateSearchRewind({ observationId, keep, nextAction: "Continue." })).toThrow();
			expect(rewindMutationSnapshot(session)).toEqual(before);
		}
	});

	it("rejects an incomplete later parallel batch without retiring an earlier completed observation", async () => {
		const { session, tempDir } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "completed_search",
							name: "grep",
							arguments: { pattern: "NOISE", path: "." },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["Search complete."], stopReason: "stop" },
			],
			[],
			{ realTools: true, realSearchTools: true },
		);
		await Bun.write(
			path.join(tempDir.path(), "noise.ts"),
			Array.from({ length: 180 }, (_, i) => `export const noise${i} = "NOISE_${i}";`).join("\n"),
		);
		await session.prompt("Locate the source.");
		session.sessionManager.appendMessage(
			assistantFixture([
				{ type: "toolCall", id: "finished_sibling", name: "read", arguments: { path: "noise.ts" } },
				{ type: "toolCall", id: "unfinished_sibling", name: "browser", arguments: { action: "inspect" } },
			]),
		);
		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "finished_sibling",
			toolName: "read",
			content: [{ type: "text", text: "Completed sibling only." }],
			isError: false,
			timestamp: Date.now(),
		});
		const before = rewindMutationSnapshot(session);
		expect(() =>
			session.validateSearchRewind({
				observationId: searchReference("o", "completed_search"),
				nextAction: "Inspect the source.",
			}),
		).toThrow(/incomplete|unfinished|pending|final result|completed result|missing.*result/i);
		expect(rewindMutationSnapshot(session)).toEqual(before);
	});

	it("rejects unseen source lines and a search superseded by new user instructions without cutting context", async () => {
		const { session, tempDir } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "search", name: "grep", arguments: { pattern: "value", path: "." } }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "source", name: "read", arguments: { path: "sample.ts:1-2" } }],
					stopReason: "toolUse",
				},
				{ content: ["Located."], stopReason: "stop" },
			],
			[],
			{ realTools: true, realSearchTools: true },
		);
		await Bun.write(
			path.join(tempDir.path(), "sample.ts"),
			Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i};`).join("\n"),
		);
		await session.prompt("Locate the code.");
		const snapshot = rewindMutationSnapshot(session);
		const selection = { readId: searchReference("r", "source"), path: "sample.ts", from: 40, to: 41 };
		expect(() =>
			session.validateSearchRewind({
				observationId: searchReference("o", "search"),
				retain: [selection],
				nextAction: "Continue.",
			}),
		).toThrow("not fully displayed");
		expect(rewindMutationSnapshot(session)).toEqual(snapshot);
		session.sessionManager.appendMessage({
			role: "user",
			content: "Keep the current exploration.",
			timestamp: Date.now(),
		});
		const afterUserInput = rewindMutationSnapshot(session);
		expect(() =>
			session.validateSearchRewind({
				observationId: searchReference("o", "search"),
				retain: [],
				nextAction: "Continue.",
			}),
		).toThrow("New user input");
		expect(rewindMutationSnapshot(session)).toEqual(afterUserInput);
		expect(session.sessionManager.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
	});

	it("keeps the exploration and latest todo when handoff persistence fails", async () => {
		const trace = "UNCOMMITTED_EXPLORATION ".repeat(1200);
		const { session, mock } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "package_a", name: "checkpoint", arguments: workPackage }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "read_trace", name: "read_trace", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "rewind_a",
							name: "rewind",
							arguments: { checkpointId: "package_a", report: "A validated.", nextAction: "Start B." },
						},
					],
					stopReason: "toolUse",
				},
			],
			[
				{
					name: "read_trace",
					label: "Read trace",
					description: "Read the exploration evidence",
					parameters: type({}),
					async execute() {
						return { content: [{ type: "text", text: trace }] };
					},
				} as AgentTool,
			],
			{ realTools: true },
		);
		const todos = [{ name: "Work", tasks: [{ content: "Implement B", status: "in_progress" as const }] }];
		session.commitTodoPhases(todos);
		const failure = spyOn(session.sessionManager, "appendEntriesAtomically").mockRejectedValueOnce(
			new Error("handoff storage unavailable"),
		);
		try {
			await session.prompt("Investigate A then B.").catch(() => undefined);
			expect(failure).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
			expect(
				session.messages.some(
					message =>
						message.role === "toolResult" &&
						message.content.some(block => block.type === "text" && block.text === trace),
				),
			).toBe(true);
			expect(session.getCheckpointState()?.checkpointId).toBe("package_a");
			expect(session.getLastCompletedRewind()).toBeUndefined();
			expect(session.getTodoPhases()).toEqual(todos);
			expect(mock.calls.length).toBe(3);
		} finally {
			failure.mockRestore();
		}
	});

	it("rejects a mixed checkpoint batch before any exploration tool runs", async () => {
		let reads = 0;
		const { session } = await createHarness(
			[
				{
					content: [
						{ type: "toolCall", id: "package_a", name: "checkpoint", arguments: workPackage },
						{ type: "toolCall", id: "read_trace", name: "read_trace", arguments: {} },
					],
					stopReason: "toolUse",
				},
				{ content: ["Batch refused; plan the work package first."], stopReason: "stop" },
			],
			[
				{
					name: "read_trace",
					label: "Read trace",
					description: "Read evidence",
					parameters: type({}),
					async execute() {
						reads++;
						return { content: [{ type: "text", text: "trace" }] };
					},
				} as AgentTool,
			],
			{ realTools: true },
		);
		await session.prompt("Research A.");
		expect(reads).toBe(0);
		expect(session.getCheckpointState()).toBeUndefined();
		expect(session.messages.filter(message => message.role === "toolResult" && message.isError).length).toBe(2);
	});

	it("hands file changes and the latest todo from A to B without retaining A's long trace", async () => {
		const traceMarker = "A_PRIVATE_EXPLORATION_TRACE";
		const trace = `${traceMarker}: inspected implementation details.\n`.repeat(1200);
		const report = "A implemented: package-a.txt contains the completed change.";
		const nextAction = "Begin B by consuming package-a.txt; do not repeat A's exploration.";
		const initialTodos = [
			{
				name: "Work",
				tasks: [
					{ content: "Implement A", status: "in_progress" as const },
					{ content: "Implement B", status: "pending" as const },
				],
			},
		];
		const latestTodos = [
			{
				name: "Work",
				tasks: [
					{ content: "Implement A", status: "completed" as const },
					{ content: "Implement B", status: "in_progress" as const },
				],
			},
		];
		const implementSchema = type({});
		const implement: AgentTool<typeof implementSchema, unknown> = {
			name: "implement_a",
			label: "Implement A",
			description: "Apply A and record its detailed evidence",
			parameters: implementSchema,
			async execute() {
				await Bun.write(path.join(session.sessionManager.getCwd(), "package-a.txt"), "A is implemented\n");
				session.commitTodoPhases(latestTodos);
				return { content: [{ type: "text", text: trace }] };
			},
		};
		const { session, mock, tempDir } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "package_a", name: "checkpoint", arguments: workPackage }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "implement_a", name: "implement_a", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "rewind_a",
							name: "rewind",
							arguments: {
								checkpointId: "package_a",
								report,
								nextAction,
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["B begins from the retained handoff."], stopReason: "stop" },
			],
			[implement as AgentTool],
			{ realTools: true },
		);
		session.commitTodoPhases(initialTodos);

		await session.prompt("Complete A, then B. Keep all file changes and do not commit.");

		expect(await Bun.file(path.join(tempDir.path(), "package-a.txt")).text()).toBe("A is implemented\n");
		expect(session.getTodoPhases()).toEqual(latestTodos);
		expect(session.getCheckpointState()).toBeUndefined();
		expect(session.getLastCompletedRewind()).toMatchObject({ checkpointId: "package_a", nextAction });
		expect(mock.calls).toHaveLength(4);
		const beforeRewind = mock.calls[2]!.context.messages.map(messageText).join("\n");
		expect(beforeRewind).toContain(traceMarker);
		const nextCall = mock.calls[3]!.context.messages;
		const nextContext = nextCall.map(messageText).join("\n");
		expect(nextContext).not.toContain(traceMarker);
		expect(nextContext).toContain("do not commit");
		const handoffs = nextCall.filter(
			message => message.role === "developer" && messageText(message).includes(report),
		);
		expect(handoffs).toHaveLength(1);
		expect(messageText(handoffs[0]!)).toContain(nextAction);
		expect(nextContext.length).toBeLessThan(beforeRewind.length);
		expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
		const retained = convertToLlm(session.sessionManager.buildSessionContext().messages).map(messageText).join("\n");
		expect(retained).toContain(report);
		expect(retained).toContain(nextAction);
		expect(retained).not.toContain(traceMarker);
	});

	it("returns the matching checkpoint ID and next action only after runtime validation succeeds", async () => {
		const { session } = await createActiveWorkPackage();
		const before = rewindMutationSnapshot(session);
		const request = { checkpointId: "package_a", report: "A completed", nextAction: "Start B" };

		const result = await validatingRewindToolForSession(session).execute("rewind_a", request);

		expect(result.details).toMatchObject({ ...request, rewound: true });
		const estimate = result.details?.estimate;
		if (!estimate) throw new Error("Expected projected context estimate");
		expect(estimate.afterTokens).toBeLessThan(estimate.beforeTokens);
		expect(estimate.reusablePrefixTokens).toBeLessThanOrEqual(estimate.afterTokens);
		// The tool acknowledges the request; only the session lifecycle applies the branch cut.
		expect(rewindMutationSnapshot(session)).toEqual(before);
	});

	it("refuses a stale checkpoint ID through the real rewind tool without mutating state", async () => {
		const { session } = await createActiveWorkPackage();
		expect(session.getCheckpointState()).toMatchObject({ checkpointId: "package_a", ...workPackage });
		const before = rewindMutationSnapshot(session);

		await expect(
			validatingRewindToolForSession(session).execute("stale_rewind", {
				checkpointId: "previous_package",
				report: "A completed",
				nextAction: "Start B",
			}),
		).rejects.toThrow(/checkpoint/i);

		expect(rewindMutationSnapshot(session)).toEqual(before);
	});

	it.each([false, true])("refuses to discard a newer user instruction (persisted=%s)", async persisted => {
		const { session } = await createActiveWorkPackage();
		const instruction: AgentMessage = {
			role: "user",
			content: "New instruction: preserve the audit output and stop after A.",
			timestamp: 3,
		};
		session.agent.appendMessage(instruction);
		if (persisted) session.sessionManager.appendMessage(instruction);
		const before = rewindMutationSnapshot(session);

		await expect(
			validatingRewindToolForSession(session).execute("unsafe_rewind", {
				checkpointId: "package_a",
				report: "A completed",
				nextAction: "Start B",
			}),
		).rejects.toThrow(/user|instruction/i);

		const after = rewindMutationSnapshot(session);
		expect({ ...after, checkpoint: before.checkpoint }).toEqual(before);
		expect(session.messages).toContainEqual(instruction);
	});

	it("fails closed when the matching checkpoint has lost its durable anchor", async () => {
		const { session } = await createActiveWorkPackage();
		const state = session.getCheckpointState();
		if (!state) throw new Error("Expected active work package");
		session.setCheckpointState({ ...state, checkpointEntryId: "missing-anchor" });
		const before = rewindMutationSnapshot(session);
		await expect(
			validatingRewindToolForSession(session).execute("lost_anchor", {
				checkpointId: "package_a",
				report: "A validated.",
				nextAction: "Start B.",
			}),
		).rejects.toThrow();
		expect(rewindMutationSnapshot(session)).toEqual(before);
	});

	it("does not schedule hidden continuation after a no-savings refusal", async () => {
		const { session, mock } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "package_a", name: "checkpoint", arguments: workPackage }],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "rewind_a",
							name: "rewind",
							arguments: {
								checkpointId: "package_a",
								report: "Retained implementation finding. ".repeat(300),
								nextAction: "Start B.",
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["Context retained; no rewrite performed."], stopReason: "stop" },
			],
			[],
			{ realTools: true },
		);
		await session.prompt("Complete A.");
		await session.waitForIdle();
		expect(mock.calls.length).toBe(3);
		expect(
			session.messages.some(
				message => message.role === "toolResult" && message.toolName === "rewind" && message.isError,
			),
		).toBe(true);
		expect(session.sessionManager.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
	});

	it("rejects a no-savings handoff before mutating the active branch", async () => {
		const { session } = await createActiveWorkPackage("");
		const before = rewindMutationSnapshot(session);

		await expect(
			validatingRewindToolForSession(session).execute("no_savings_rewind", {
				checkpointId: "package_a",
				report: "Retained implementation finding. ".repeat(90),
				nextAction: "Start B",
			}),
		).rejects.toThrow();

		expect(rewindMutationSnapshot(session)).toEqual(before);
	});

	it("rebuilds active history at the checkpoint before the post-rewind assistant turn", async () => {
		const report = "findings: kept checkpoint; risks: stale signed thinking";
		const { session, mock } = await createHarness([
			{
				content: [
					signedThinking("checkpoint before exploring", "sig_checkpoint"),
					{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [
					signedThinking("ready to rewind", "sig_rewind"),
					{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } },
				],
				stopReason: "toolUse",
			},
			{
				content: [signedThinking("answer after rewind", "sig_after_rewind"), "DONE"],
				stopReason: "stop",
			},
		]);

		await session.prompt("investigate with a checkpoint");

		expect(mock.calls.length).toBe(3);
		const finalCall = mock.calls[2];
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		const reportIndex = finalCall.context.messages.findIndex(
			message => message.role === "developer" && messageText(message).includes(report),
		);
		expect(reportIndex).toBeGreaterThan(-1);
		const reportMessage = finalCall.context.messages[reportIndex];
		if (!reportMessage) throw new Error("Expected rewind report context");
		const reportText = messageText(reportMessage);
		expect(reportText).toContain(report);

		expect(
			finalCall.context.messages.some(message => message.role === "toolResult" && message.toolName === "rewind"),
		).toBe(false);

		const activeRoles = session.messages.map(message => message.role);
		expect(activeRoles).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
		expect(activeRoles).toEqual(session.sessionManager.buildSessionContext().messages.map(message => message.role));

		const finalAssistant = expectLastAssistant(session.messages);
		const finalThinking = finalAssistant.content.find((block): block is ThinkingContent => block.type === "thinking");
		expect(finalThinking?.thinking).toBe("answer after rewind");
		expect(finalThinking?.thinkingSignature).toBe("sig_after_rewind");
	});

	it("retains a sibling task result after rewinding the same assistant turn", async () => {
		const report = "investigation complete";
		const taskSchema = type({ goal: type("string") });
		const taskTool: AgentTool<typeof taskSchema, unknown> = {
			name: "task",
			label: "Task",
			description: "Run a subagent",
			parameters: taskSchema,
			async execute() {
				return { content: [{ type: "text", text: "<task-result>completed work</task-result>" }] };
			},
		};
		const { session, mock } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
					stopReason: "toolUse",
				},
				{
					content: [
						{ type: "toolCall", id: "rewind", name: "rewind", arguments: { report } },
						{ type: "toolCall", id: "task", name: "task", arguments: { goal: "complete work" } },
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[checkpointTool as AgentTool, rewindTool as AgentTool, taskTool as AgentTool],
		);

		await session.prompt("investigate with a subagent");

		const nextTurn = mock.calls[2]?.context.messages;
		expect(nextTurn).toBeDefined();
		expect(
			nextTurn?.some(
				message =>
					message.role === "toolResult" &&
					message.toolCallId === "task" &&
					messageText(message).includes("<task-result>completed work</task-result>"),
			),
		).toBe(true);
		expect(
			nextTurn?.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "toolCall" && block.id === "task"),
			),
		).toBe(true);
		expect(nextTurn?.some(message => message.role === "toolResult" && message.toolCallId === "rewind")).toBe(false);
		expect(
			session.sessionManager
				.buildSessionContext()
				.messages.some(message => message.role === "toolResult" && message.toolCallId === "task"),
		).toBe(true);
	});

	it("records the prompt a rewound sibling reply was produced under on the rewind branch", async () => {
		const report = "investigation complete";
		const taskSchema = type({ goal: type("string") });
		const taskTool: AgentTool<typeof taskSchema, unknown> = {
			name: "task",
			label: "Task",
			description: "Run a subagent",
			parameters: taskSchema,
			async execute() {
				return { content: [{ type: "text", text: "<task-result>completed work</task-result>" }] };
			},
		};
		const promptChangingCheckpoint: AgentTool<typeof checkpointSchema, { startedAt: string }> = {
			...checkpointTool,
			async execute(toolCallId, params, signal, onUpdate, context) {
				// The exploration after the checkpoint runs under a different prompt.
				session.agent.setSystemPrompt(["Changed"]);
				return checkpointTool.execute(toolCallId, params, signal, onUpdate, context);
			},
		};
		const { session } = await createHarness(
			[
				{
					content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
					stopReason: "toolUse",
				},
				{
					content: [
						{ type: "toolCall", id: "rewind", name: "rewind", arguments: { report } },
						{ type: "toolCall", id: "task", name: "task", arguments: { goal: "complete work" } },
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[promptChangingCheckpoint as AgentTool, rewindTool as AgentTool, taskTool as AgentTool],
		);
		const recordedPromptBefore = (entryId: string): unknown => {
			for (let entry = session.sessionManager.getEntry(entryId); entry;) {
				if (entry.type === "custom" && entry.customType === "system-prompt-digest") return entry.data;
				entry = entry.parentId ? session.sessionManager.getEntry(entry.parentId) : undefined;
			}
			return undefined;
		};

		await session.prompt("investigate with a subagent");

		const replies = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "assistant");
		const rewindReply = replies.find(
			entry =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(block => block.type === "toolCall" && block.id === "rewind"),
		);
		const reparentedReply = replies.find(
			entry =>
				entry !== rewindReply &&
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(block => block.type === "toolCall" && block.id === "task"),
		);
		if (!rewindReply || !reparentedReply) throw new Error("expected the rewind reply and its reparented sibling");
		expect(recordedPromptBefore(reparentedReply.id)).toBe(recordedPromptBefore(rewindReply.id));
		expect(recordedPromptBefore(reparentedReply.id)).not.toBe(recordedPromptBefore(replies[0]!.id));
	});

	it("shows a transient checkpoint-active reminder that is branch-cut away on rewind", async () => {
		const report = "findings: transient reminder";
		const proceed = Promise.withResolvers<void>();
		const { session, mock } = await createHarness(
			(async function* () {
				yield {
					content: [
						{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
					],
					stopReason: "toolUse",
				};
				await proceed.promise;
				yield {
					content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } }],
					stopReason: "toolUse",
				};
				yield { content: ["DONE"], stopReason: "stop" };
			})() as MockResponseSource,
		);

		const promptPromise = session.prompt("investigate with a checkpoint");
		// Pause the model between the checkpoint and rewind calls to observe the
		// active-checkpoint state: the transient notice must be in the active path.
		const deadline = Date.now() + 5000;
		while (
			!session.messages.some(
				message => message.role === "custom" && message.customType === "checkpoint-active-reminder",
			) ||
			mock.calls.length < 2
		) {
			if (Date.now() > deadline) throw new Error("checkpoint reminder/provider call never appeared");
			await Bun.sleep(10);
		}
		const reminder = session.messages.find(
			(message): message is Extract<AgentMessage, { role: "custom" }> =>
				message.role === "custom" && message.customType === "checkpoint-active-reminder",
		);
		expect(reminder).toBeDefined();
		expect(reminder?.content).toBeTruthy();
		const activeCall = mock.calls[1];
		expect(activeCall).toBeDefined();
		expect(
			activeCall?.context.messages.some(
				message => message.role === "developer" && messageText(message) === reminder?.content,
			),
		).toBe(true);
		// #checkpointState is set synchronously with the reminder (pre-await), so an
		// immediate rewind would find an active checkpoint, not "No active checkpoint".
		expect(session.getCheckpointState()).toBeDefined();
		proceed.resolve();
		await promptPromise;

		// After rewind the branch cut dropped the reminder from the active path.
		expect(
			session.messages.some(
				message => message.role === "custom" && message.customType === "checkpoint-active-reminder",
			),
		).toBe(false);

		// No negation guard anywhere in the model-visible context.
		const finalCall = mock.calls.at(-1);
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		for (const message of finalCall.context.messages) {
			const text = messageText(message);
			expect(text).not.toContain("NEVER call");
			expect(text).not.toContain("Do not call `rewind` again");
		}

		// Exactly one developer message carries the forward-looking rewind report.
		const reportMessages = finalCall.context.messages.filter(
			message => message.role === "developer" && messageText(message).includes(report),
		);
		expect(reportMessages).toHaveLength(1);
		expect(messageText(reportMessages[0]!)).toContain(report);
	});

	it("carries each rewind report into model context exactly once across checkpoint cycles", async () => {
		const reportA = "findings from checkpoint cycle A";
		const reportB = "findings from checkpoint cycle B";
		const { session, mock } = await createHarness([
			{
				content: [
					{ type: "toolCall", id: "call_checkpoint_a", name: "checkpoint", arguments: { goal: "inspect A" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind_a", name: "rewind", arguments: { report: reportA } }],
				stopReason: "toolUse",
			},
			{
				content: [
					{ type: "toolCall", id: "call_checkpoint_b", name: "checkpoint", arguments: { goal: "inspect B" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind_b", name: "rewind", arguments: { report: reportB } }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);

		await session.prompt("investigate with two checkpoints");

		const finalCall = mock.calls.at(-1);
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		const contextText = finalCall.context.messages.map(messageText).join("\n");
		expect(contextText.split(reportA)).toHaveLength(2);
		expect(contextText.split(reportB)).toHaveLength(2);
		// Resume rebuilds the same context from the persisted session.
		const resumedText = convertToLlm(session.sessionManager.buildSessionContext().messages)
			.map(messageText)
			.join("\n");
		expect(resumedText.split(reportA)).toHaveLength(2);
		expect(resumedText.split(reportB)).toHaveLength(2);
		// The transcript still shows each rewind as a branch summary.
		const transcriptSummaries = session.sessionManager
			.buildSessionContext({ transcript: true })
			.messages.flatMap(message => (message.role === "branchSummary" ? [message.summary] : []));
		expect(transcriptSummaries).toEqual([reportA, reportB]);
	});

	it("ignores a completed cycle's rewind result after rebuilding context", async () => {
		const staleReport = "findings from the previous checkpoint";
		const currentReport = "findings from the current checkpoint";
		const { session, mock } = await createHarness([
			{
				content: [
					{ type: "toolCall", id: "call_checkpoint_a", name: "checkpoint", arguments: { goal: "inspect A" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind_a", name: "rewind", arguments: { report: staleReport } }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);
		await session.prompt("investigate the first checkpoint");

		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_rewind_a_late",
			toolName: "rewind",
			content: [{ type: "text", text: "rewind requested" }],
			details: { report: staleReport, rewound: true },
			isError: false,
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		mock.push({
			content: [{ type: "toolCall", id: "call_checkpoint_b", name: "checkpoint", arguments: { goal: "inspect B" } }],
			stopReason: "toolUse",
		});
		mock.push({
			content: [{ type: "toolCall", id: "call_rewind_b", name: "rewind", arguments: { report: currentReport } }],
			stopReason: "toolUse",
		});
		mock.push({ content: ["DONE"], stopReason: "stop" });

		await session.prompt("investigate the second checkpoint");

		expect(session.getLastCompletedRewind()?.report).toBe(currentReport);
	});

	it("does not start checkpoint tracking for xdev help envelopes", async () => {
		const { session } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_help",
							name: "write",
							arguments: { path: "xd://checkpoint", content: "help" },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[xdevWriteTool],
		);

		await session.prompt("show checkpoint help");

		expect(session.getCheckpointState()).toBeUndefined();
	});

	it("tracks checkpoint and rewind through execute xdev write results", async () => {
		const report = "findings: xdev wrapper";
		const { session, mock } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_xdev",
							name: "write",
							arguments: {
								path: "xd://checkpoint",
								content: JSON.stringify({ goal: "inspect" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "call_rewind_xdev",
							name: "write",
							arguments: {
								path: "xd://rewind",
								content: JSON.stringify({ report }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[xdevWriteTool],
		);

		await session.prompt("investigate with an xdev checkpoint");

		const finalCall = mock.calls.at(-1);
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		expect(
			finalCall.context.messages.some(
				message => message.role === "toolResult" && message.toolCallId === "call_rewind_xdev",
			),
		).toBe(false);
		expect(
			session.messages.some(message => message.role === "toolResult" && message.toolCallId === "call_rewind_xdev"),
		).toBe(false);
		expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);

		expect(session.getLastCompletedRewind()).toMatchObject({
			checkpointId: "call_checkpoint_xdev",
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
	});

	it("tracks direct xd:// checkpoint and rewind calls through the session lifecycle", async () => {
		const report = "findings: prefixed direct calls";
		const proceed = Promise.withResolvers<void>();
		const secondRequestStarted = Promise.withResolvers<void>();
		const { session } = await createHarness(
			(async function* () {
				yield {
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_direct_xdev",
							name: "xd://checkpoint",
							arguments: { goal: "inspect" },
						},
					],
					stopReason: "toolUse",
				};
				secondRequestStarted.resolve();
				await proceed.promise;
				yield {
					content: [
						{
							type: "toolCall",
							id: "call_rewind_direct_xdev",
							name: "xd://rewind",
							arguments: { report },
						},
					],
					stopReason: "toolUse",
				};
				yield { content: ["DONE"], stopReason: "stop" };
			})() as MockResponseSource,
			[checkpointTool as AgentTool, rewindTool as AgentTool],
			{
				resolveFallbackTool: name => {
					if (name === "xd://checkpoint") return checkpointTool as AgentTool;
					if (name === "xd://rewind") return rewindTool as AgentTool;
					return undefined;
				},
			},
		);

		const promptPromise = session.prompt("investigate with direct xd device calls");
		await secondRequestStarted.promise;

		// Exercise the real RewindTool while the provider's second response is
		// paused: prefixed checkpoint results must activate its session state.
		const checkpointState = session.getCheckpointState();
		const rewindProbe = await rewindToolForSession(session)
			.execute("probe_rewind_after_direct_xdev", {
				checkpointId: "call_checkpoint_direct_xdev",
				report: "probe",
				nextAction: "Continue the task",
			})
			.then(
				result => ({ result }),
				error => ({ error }),
			);
		proceed.resolve();
		await promptPromise;

		expect(checkpointState).toBeDefined();
		expect(rewindProbe).not.toHaveProperty("error");
		expect(session.getCheckpointState()).toBeUndefined();
		expect(session.getLastCompletedRewind()).toMatchObject({
			checkpointId: "call_checkpoint_direct_xdev",
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
		expect(
			session.messages.some(
				message => message.role === "toolResult" && message.toolCallId === "call_rewind_direct_xdev",
			),
		).toBe(false);
	});

	it("rehydrates completed rewind state from the retained report on resume", async () => {
		const report = "findings: retained after resume";
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [checkpointTool as AgentTool, rewindTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		expect(reloadedSession.getLastCompletedRewind()).toMatchObject({
			checkpointId: "call_checkpoint",
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
		const tool = new RewindTool(
			createToolSession({
				getLastCompletedRewind: () => reloadedSession.getLastCompletedRewind(),
			}),
		);
		await expect(
			tool.execute("repeat_rewind", {
				checkpointId: "call_checkpoint",
				report: "retry",
				nextAction: "Continue the task",
			}),
		).rejects.toThrow(
			"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
		);
	});

	it("clears completed rewind state when starting a new session", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");
		expect(harness.session.getLastCompletedRewind()).toBeDefined();

		await harness.session.newSession();

		expect(harness.session.getLastCompletedRewind()).toBeUndefined();
		await expectNoActiveCheckpointError(harness.session);
	});

	it("rehydrates completed rewind state from the branched path", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");
		expect(harness.session.getLastCompletedRewind()).toBeDefined();
		const userEntry = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected user entry for branch");

		await harness.session.branch(userEntry.id);

		expect(harness.session.getLastCompletedRewind()).toBeUndefined();
		await expectNoActiveCheckpointError(harness.session);
	});
	it("tells the model to continue when rewind is repeated after completion", async () => {
		const tool = new RewindTool(
			createToolSession({
				getLastCompletedRewind: () => ({
					checkpointId: "call_checkpoint",
					nextAction: "Continue the task",
					report: "findings retained",
					startedAt: "2026-01-01T00:00:00.000Z",
					rewoundAt: "2026-01-01T00:01:00.000Z",
				}),
			}),
		);

		await expect(
			tool.execute("repeat_rewind", {
				checkpointId: "call_checkpoint",
				report: "retry",
				nextAction: "Continue the task",
			}),
		).rejects.toThrow(
			"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
		);
	});

	it("rehydrates active checkpoint state when resuming a session with no rewind yet", async () => {
		const startedAt = "2026-01-01T00:00:00.000Z";
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);
		await harness.session.prompt("investigate with a checkpoint");
		const originalCompleted = harness.session.getLastCompletedRewind();
		expect(originalCompleted).toBeDefined();

		// Simulate "run aborted between checkpoint and rewind" by branching to the
		// checkpoint entry itself — the rewind and its rewind-report entry drop off
		// the active branch, leaving the checkpoint tool result as the leaf.
		const branch = harness.session.sessionManager.getBranch();
		const checkpointEntry = branch.find(
			entry =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "checkpoint",
		);
		if (!checkpointEntry) throw new Error("Expected checkpoint tool result entry");
		harness.session.sessionManager.branch(checkpointEntry.id);

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [checkpointTool as AgentTool, rewindTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		const restored = reloadedSession.getCheckpointState();
		expect(restored).toBeDefined();
		expect(restored?.checkpointEntryId).toBe(checkpointEntry.id);
		expect(restored?.checkpointId).toBe("call_checkpoint");
		expect(restored?.startedAt).toBe(startedAt);
		expect(reloadedSession.getLastCompletedRewind()).toBeUndefined();

		// The rewind tool must accept the request now that the active checkpoint
		// has been re-hydrated — previously this threw "No active checkpoint".
		const rewindResult = await rewindToolForSession(reloadedSession).execute("call_rewind_after_resume", {
			checkpointId: "call_checkpoint",
			nextAction: "Continue the task",
			report: "post-resume findings",
		});
		expect(rewindResult.details?.rewound).toBe(true);
	});
	it("marks extension agent_end willContinue when enforceRewindBeforeYield continues", async () => {
		const agentEnds: Array<boolean | undefined> = [];

		const report = "findings: enforced rewind before yield";
		const { session, mock } = await createHarness(
			[
				{
					content: [
						{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
					],
					stopReason: "toolUse",
				},
				// Text-only stop while checkpoint is open → #enforceRewindBeforeYield.
				{ content: ["done without rewind"], stopReason: "stop" },
				{
					content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } }],
					stopReason: "toolUse",
				},
				{ content: ["terminal after rewind"], stopReason: "stop" },
			],
			undefined,
			{ onAgentEnd: willContinue => agentEnds.push(willContinue) },
		);

		await session.prompt("investigate with a checkpoint then yield early");
		await session.waitForIdle();

		// Intermediate enforceRewindBeforeYield settle, then terminal post-rewind settle.
		expect(agentEnds.length).toBeGreaterThanOrEqual(2);
		const continuing = agentEnds.filter(willContinue => willContinue === true);
		expect(continuing).toHaveLength(1);
		const intermediateIndex = agentEnds.indexOf(true);
		expect(intermediateIndex).toBeGreaterThanOrEqual(0);
		expect(intermediateIndex).toBeLessThan(agentEnds.length - 1);
		expect(agentEnds.at(-1)).toBeFalsy();
		expect(mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(expectLastAssistant(session.messages).stopReason).toBe("stop");
	});

	it("rehydrates an active checkpoint from an xdev write after branching and resume", async () => {
		const harness = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_xdev",
							name: "write",
							arguments: {
								path: "xd://checkpoint",
								content: JSON.stringify({ goal: "inspect" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "call_rewind_xdev",
							name: "write",
							arguments: {
								path: "xd://rewind",
								content: JSON.stringify({ report: "findings" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[xdevWriteTool],
		);
		await harness.session.prompt("investigate with an xdev checkpoint");

		const checkpointEntry = harness.session.sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "write") {
				return false;
			}
			const details = entry.message.details as { xdev?: { tool?: string } } | undefined;
			return details?.xdev?.tool === "checkpoint";
		});
		if (!checkpointEntry) throw new Error("Expected xdev checkpoint tool result entry");
		harness.session.sessionManager.branch(checkpointEntry.id);

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [xdevWriteTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-xdev-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		expect(reloadedSession.getCheckpointState()).toMatchObject({
			checkpointEntryId: checkpointEntry.id,
			checkpointId: "call_checkpoint_xdev",
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(reloadedSession.getLastCompletedRewind()).toBeUndefined();
		await expect(
			rewindToolForSession(reloadedSession).execute("call_rewind_after_xdev_resume", {
				checkpointId: "call_checkpoint_xdev",
				nextAction: "Continue the task",
				report: "post-resume findings",
			}),
		).resolves.toMatchObject({ details: { report: "post-resume findings", rewound: true } });
	});
});

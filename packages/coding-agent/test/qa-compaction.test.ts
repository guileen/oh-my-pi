import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { parseCompactArgs, QA_STATE_TYPE } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import { CONTEXT_NOTES_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { prepareLocalRewindCompaction, prepareQaCompaction } from "@oh-my-pi/pi-coding-agent/session/qa-compaction";
import { QA_CHECKPOINT_ENTRY_TYPE, type QaCheckpointData } from "@oh-my-pi/pi-coding-agent/session/qa-rollover";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { preserveSearchMaterials, SEARCH_REWIND_STATE, searchReference } from "@oh-my-pi/pi-coding-agent/session/search-rewind";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { resolveLocalUrlToPath } from "../src/internal-urls";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let temp: TempDir;
let auth: AuthStorage;
let sessions: AgentSession[];
let readOnlyManagers: SessionManager[];
let jobManagers: AsyncJobManager[];
let releaseGates: Array<() => void>;

beforeEach(() => {
	temp = TempDir.createSync("@pi-qa-compact-");
	auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	sessions = [];
	readOnlyManagers = [];
	jobManagers = [];
	releaseGates = [];
});

afterEach(async () => {
	for (const release of releaseGates) release();
	for (const session of sessions) await session.dispose();
	for (const manager of readOnlyManagers) await manager.close();
	for (const manager of jobManagers) await manager.dispose();
	auth.close();
	temp.removeSync();
	vi.restoreAllMocks();
});

function createSession(
	manager: SessionManager,
	streamFn: StreamFn,
	options: { asyncJobManager?: AsyncJobManager; agentId?: string } = {},
): AgentSession {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: manager.buildSessionContext().messages },
		convertToLlm,
		streamFn,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"compaction.autoContinue": true,
			"contextPromotion.enabled": false,
			"task.eager": "default",
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		}),
		modelRegistry: new ModelRegistry(auth),
		...options,
	});
	sessions.push(session);
	return session;
}

function recordRequests() {
	const requests: Message[][] = [];
	const streamFn: StreamFn = (_model, context) => {
		requests.push([...context.messages]);
		const stream = new AssistantMessageEventStream();
		const response = createAssistantMessage("continued");
		queueMicrotask(() => {
			stream.push({ type: "start", partial: response });
			stream.push({ type: "done", reason: "stop", message: response });
		});
		return stream;
	};
	return { requests, streamFn };
}

function forbidSummarizer() {
	return vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("unexpected summarizer call"));
}

function seedConversation(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: "Continue the release work", timestamp: Date.now() });
	manager.appendMessage(createAssistantMessage("The release is underway."));
}

function checkpointText(messages: readonly AgentMessage[]): string {
	const checkpoints = messages.filter(message => message.role === "custom" && message.customType === QA_STATE_TYPE);
	expect(checkpoints).toHaveLength(1);
	const checkpoint = checkpoints[0];
	if (checkpoint?.role !== "custom" || typeof checkpoint.content !== "string") {
		throw new Error("Expected one textual QA checkpoint");
	}
	expect(checkpoint.display).toBe(false);
	return checkpoint.content;
}

function expectTodoCheckpoint(state: string, phases: readonly TodoPhase[]): void {
	for (const phase of phases) {
		expect(state).toContain(phase.name);
		for (const task of phase.tasks) {
			const row = state.split("\n").find(line => line.includes(task.content));
			expect(row).toContain(task.status);
			if (task.blocker) expect(row).toContain(task.blocker);
		}
	}
}

it("keeps journal Q&A without a model call and makes file activity immediately model-visible", async () => {
	expect(parseCompactArgs("qaonly")).toEqual({ mode: "qaonly", instructions: undefined });
	expect(parseCompactArgs("qaonly focus")).toHaveProperty("error");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const stream = vi.fn(() => {
		throw new Error("unexpected model call");
	});
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistant = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage => ({
		role: "assistant" as const,
		content,
		stopReason,
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: model.id,
		usage,
		timestamp: Date.now(),
	});
	manager.appendMessage({ role: "user", content: "first instruction", timestamp: Date.now() });
	manager.appendMessage(
		assistant(
			[
				{ type: "text", text: "intermediate" },
				{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts:1-20" } },
				{ type: "toolCall", id: "r2", name: "read", arguments: { path: "a.ts:30-40" } },
				{ type: "toolCall", id: "s", name: "read", arguments: { path: "skill://sample" } },
				{ type: "toolCall", id: "w", name: "write", arguments: { path: "b.ts", content: "x" } },
				{ type: "toolCall", id: "c", name: "bash", arguments: { command: "pwd" } },
				{ type: "toolCall", id: "e", name: "eval", arguments: { language: "js", code: "example" } },
			],
			"toolUse",
		),
	);
	for (const [id, name] of [
		["r1", "read"],
		["r2", "read"],
		["s", "read"],
		["w", "write"],
		["c", "bash"],
	]) {
		manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "e",
		toolName: "eval",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: Date.now(),
		details: {
			statusEvents: [
				{ op: "read", path: "nested.ts:10-20" },
				{ op: "write", path: "nested-out.ts" },
				{ op: "read", path: "skill://nested-skill" },
				{ op: "run", cmd: "git status" },
			],
		},
	});
	manager.appendMessage(
		assistant(
			[
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "final answer" },
			],
			"stop",
		),
	);
	const summarizer = forbidSummarizer();
	const session = createSession(manager, stream);
	const compacted = await session.compact(undefined, { mode: "qaonly" });
	expect(compacted.summary).toContain("first instruction");
	expect(compacted.summary).toContain("final answer");
	expect(stream).not.toHaveBeenCalled();
	const before = convertToLlm(session.messages);
	const beforeText = JSON.stringify(before);
	expect(beforeText).toContain("first instruction");
	expect(beforeText).toContain("final answer");
	expect(beforeText).not.toContain("intermediate");
	expect(beforeText).not.toContain("private reasoning");
	expect(beforeText).toContain("a.ts");

	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	readOnlyManagers.push(reopened);
	const after = convertToLlm(reopened.buildSessionContext().messages);
	const text = JSON.stringify(after);
	expect(text.match(/a\.ts/g)?.length).toBe(1);
	expect(text).toContain("nested.ts");
	expect(text).toContain("nested-out.ts");
	expect(text).toContain("nested-skill");
	expect(text).toContain("git status");
	expect(text).toContain("b.ts");
	expect(text).toContain("sample");
	expect(text).toContain("pwd");

	manager.appendMessage({ role: "user", content: "next instruction", timestamp: Date.now() });
	await session.compact(undefined, { mode: "qaonly" });
	const twice = JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
	expect(twice).toContain("first instruction");
	expect(twice).toContain("final answer");
	expect(twice).toContain("next instruction");
	manager.appendCompaction("older lossy summary", undefined, "", 0);
	await session.compact(undefined, { mode: "qaonly" });
	const recovered = JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
	expect(recovered).toContain("first instruction");
	expect(recovered).toContain("final answer");
	expect(recovered).not.toContain("older lossy summary");
	manager.appendResetBoundary();
	manager.appendMessage({ role: "user", content: "after clear", timestamp: Date.now() });
	manager.appendMessage(assistant([{ type: "text", text: "new answer" }], "stop"));
	await session.compact(undefined, { mode: "qaonly" });
	const cleared = JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
	expect(cleared).toContain("after clear");
	expect(cleared).toContain("new answer");
	expect(cleared).not.toContain("first instruction");
	expect(
		manager
			.getEntries()
			.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "first instruction",
			),
	).toBe(true);
	expect(stream).not.toHaveBeenCalled();
	expect(summarizer).not.toHaveBeenCalled();
});

it("retains canonical todo phases, statuses, blockers and active goal through reopen and the first provider request", async () => {
	const summarizer = forbidSummarizer();
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	seedConversation(manager);
	const finding = "Confirmed release fact: the signing key resides in the HSM.";
	manager.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, { version: 1, text: finding });
	const phases: TodoPhase[] = [
		{
			name: "Implementation",
			tasks: [
				{ content: "Inspect the release journal", status: "completed" },
				{ content: "Wire the release checkpoint", status: "in_progress" },
				{ content: "Remove the superseded release path", status: "abandoned" },
			],
		},
		{
			name: "Acceptance",
			tasks: [
				{ content: "Run release acceptance", status: "pending" },
				{ content: "Publish the release", status: "blocked", blocker: "Waiting for the signing certificate" },
			],
		},
	];
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	for (const [id, op, isError] of [
		["failed-todo", "init", true],
		["view-todo", "view", false],
	] as const) {
		manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "todo",
			content: [{ type: "text", text: "DO NOT COPY THIS NONCANONICAL TODO OUTPUT" }],
			details: {
				op,
				phases: [{ name: "Noncanonical", tasks: [{ content: "Discard these todos", status: "pending" }] }],
			},
			isError,
			timestamp: Date.now(),
		});
	}
	const recorder = recordRequests();
	const session = createSession(manager, recorder.streamFn);
	const now = Date.now();
	session.setGoalModeState({
		enabled: true,
		mode: "active",
		goal: {
			id: "release-goal",
			objective: "Finish the release checkpoint",
			status: "active",
			tokensUsed: 20,
			timeUsedSeconds: 3,
			createdAt: now,
			updatedAt: now,
		},
	});

	const result = await session.compact(undefined, { mode: "qaonly" });
	const state = checkpointText(session.messages);
	expectTodoCheckpoint(state, phases);
	expect(state).toContain("release-goal");
	expect(state).toContain("Finish the release checkpoint");
	expect(state).toMatch(/"status"\s*:\s*"active"/);
	expect(state).toMatch(/"tokensUsed"\s*:\s*20\b/);
	expect(state).toMatch(/"timeUsedSeconds"\s*:\s*3\b/);
	expect(state).not.toContain("Noncanonical");
	expect(state).not.toContain(finding);
	expect(JSON.stringify(convertToLlm(session.messages))).not.toContain("DO NOT COPY THIS NONCANONICAL TODO OUTPUT");
	expect(result.details).toMatchObject({ kind: "qaonly", state });
	expect(session.getTodoPhases()).toEqual(phases);
	expect(recorder.requests).toHaveLength(0);

	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	const reopenedSession = createSession(reopened, recorder.streamFn);
	expect(reopenedSession.getTodoPhases()).toEqual(phases);
	expect(checkpointText(reopenedSession.messages)).toBe(state);
	await reopenedSession.prompt("Continue with the current release tasks");
	await reopenedSession.waitForIdle();

	expect(recorder.requests).toHaveLength(1);
	const request = JSON.stringify(recorder.requests[0]);
	expect(request).toContain(JSON.stringify(state).slice(1, -1));
	expect(request.split(finding)).toHaveLength(2);
	expect(
		reopened.getEntries().some(entry => entry.type === "custom_message" && entry.customType === QA_STATE_TYPE),
	).toBe(false);
	expect(summarizer).not.toHaveBeenCalled();
});

it("recalculates a changed canonical todo snapshot instead of carrying a stale checkpoint into recompaction", async () => {
	const summarizer = forbidSummarizer();
	const manager = SessionManager.inMemory(temp.path());
	seedConversation(manager);
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Original rollout",
				tasks: [
					{ content: "Approve release artifact", status: "blocked", blocker: "Old approval blocker" },
					{ content: "Use the superseded deployment", status: "pending" },
				],
			},
		],
	});
	const recorder = recordRequests();
	const session = createSession(manager, recorder.streamFn);
	await session.compact(undefined, { mode: "qaonly" });
	expect(checkpointText(session.messages)).toContain("Old approval blocker");

	const changed: TodoPhase[] = [
		{
			name: "Revised rollout",
			tasks: [
				{ content: "Approve release artifact", status: "completed" },
				{ content: "Deploy the signed artifact", status: "blocked", blocker: "New deployment blocker" },
			],
		},
	];
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "completed-todo-update",
		toolName: "todo",
		content: [{ type: "text", text: "The canonical release tasks changed." }],
		details: { op: "done", phases: changed },
		isError: false,
		timestamp: Date.now(),
	});
	manager.appendMessage({ role: "user", content: "Use the revised rollout only", timestamp: Date.now() });
	await session.compact(undefined, { mode: "qaonly" });

	const state = checkpointText(session.messages);
	expectTodoCheckpoint(state, changed);
	expect(state).not.toContain("Original rollout");
	expect(state).not.toContain("Old approval blocker");
	expect(state).not.toContain("Use the superseded deployment");
	expect(session.getTodoPhases()).toEqual(changed);
	expect(JSON.stringify(convertToLlm(session.messages))).toContain("Use the revised rollout only");
	expect(recorder.requests).toHaveLength(0);
	expect(summarizer).not.toHaveBeenCalled();
});

it("excludes canonical todo state before clear without replacing it with an empty checkpoint", async () => {
	const summarizer = forbidSummarizer();
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	seedConversation(manager);
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Cleared release phase",
				tasks: [{ content: "Obsolete release task", status: "blocked", blocker: "Obsolete blocker" }],
			},
		],
	});
	const recorder = recordRequests();
	const session = createSession(manager, recorder.streamFn);
	await session.compact(undefined, { mode: "qaonly" });
	expect(checkpointText(session.messages)).toContain("Obsolete release task");

	manager.appendResetBoundary();
	manager.appendMessage({ role: "user", content: "Start the replacement release", timestamp: Date.now() });
	manager.appendMessage(createAssistantMessage("The replacement release is fresh."));
	const result = await session.compact(undefined, { mode: "qaonly" });
	expect(result.details).not.toHaveProperty("state");
	expect(session.messages.some(message => message.role === "custom" && message.customType === QA_STATE_TYPE)).toBe(
		false,
	);
	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	const reopenedSession = createSession(reopened, recorder.streamFn);
	await reopenedSession.prompt("Continue the replacement release");
	await reopenedSession.waitForIdle();

	expect(recorder.requests).toHaveLength(1);
	const request = JSON.stringify(recorder.requests[0]);
	expect(request).toContain("Start the replacement release");
	expect(request).not.toContain("Cleared release phase");
	expect(request).not.toContain("Obsolete release task");
	expect(request).not.toContain("Obsolete blocker");
	expect(
		reopened.getEntries().some(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE),
	).toBe(true);
	expect(summarizer).not.toHaveBeenCalled();
});

it.each(["planning", "approved"] as const)("checkpoints the %s plan reference from a real session", async mode => {
	const summarizer = forbidSummarizer();
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	seedConversation(manager);
	const recorder = recordRequests();
	const session = createSession(manager, recorder.streamFn);
	const planUrl = `local://${mode}-release-plan.md`;
	const planFile = resolveLocalUrlToPath(planUrl, {
		getArtifactsDir: () => manager.getArtifactsDir(),
		getSessionId: () => manager.getSessionId(),
	});
	await Bun.write(planFile, "# Release plan\n\nPLAN-BODY-NOT-COPIED-INTO-CHECKPOINT\n");
	session.setPlanModeState({ enabled: true, planFilePath: planUrl });
	if (mode === "approved") {
		session.setPlanModeState(undefined);
		session.setPlanReferencePath(planUrl);
		session.markPlanReferenceSent();
	}

	await session.compact(undefined, { mode: "qaonly" });
	const state = checkpointText(session.messages);
	expect(state).toContain(planUrl);
	expect(state).toMatch(new RegExp(`"mode"\\s*:\\s*"${mode}"`));
	expect(state).not.toContain("PLAN-BODY-NOT-COPIED-INTO-CHECKPOINT");
	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	readOnlyManagers.push(reopened);
	expect(checkpointText(reopened.buildSessionContext().messages)).toBe(state);
	expect(recorder.requests).toHaveLength(0);
	expect(summarizer).not.toHaveBeenCalled();
});

it("automatically resumes an interrupted turn with the newest request, checkpoint and file activity but no summarizer call", async () => {
	const summarizer = forbidSummarizer();
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	seedConversation(manager);
	const phases: TodoPhase[] = [
		{
			name: "Interrupted release",
			tasks: [{ content: "Complete the interrupted rollout", status: "blocked", blocker: "Keep the release lock" }],
		},
	];
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	manager.appendMessage({
		...createAssistantMessage(""),
		content: [
			{ type: "toolCall", id: "qa-read", name: "read", arguments: { path: "release-input.ts:1-20" } },
			{ type: "toolCall", id: "qa-edit", name: "edit", arguments: { path: "release-output.ts" } },
		],
		stopReason: "toolUse",
	});
	for (const [id, name] of [
		["qa-read", "read"],
		["qa-edit", "edit"],
	]) {
		manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "file operation complete" }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	const requests: Message[][] = [];
	const started = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	const streamFn: StreamFn = (_model, context, options) => {
		requests.push([...context.messages]);
		const stream = new AssistantMessageEventStream();
		if (requests.length === 1) {
			const partial = createAssistantMessage("");
			options?.signal?.addEventListener(
				"abort",
				() => {
					stream.push({
						type: "error",
						reason: "aborted",
						error: { ...partial, stopReason: "aborted" },
					});
				},
				{ once: true },
			);
			stream.push({ type: "start", partial });
			started.resolve();
		} else {
			const response = createAssistantMessage("The interrupted rollout continued.");
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
				resumed.resolve();
			});
		}
		return stream;
	};
	const session = createSession(manager, streamFn);
	const turn = session.prompt("Newest user request: preserve the release lock and continue the rollout");
	await withTimeout(started.promise, 2_000, "The active provider request did not start");
	await session.compact(undefined, { mode: "qaonly" });
	await withTimeout(Promise.all([turn, resumed.promise]), 2_000, "The interrupted turn did not automatically resume");
	await session.waitForIdle();

	expect(requests).toHaveLength(2);
	const continuation = JSON.stringify(requests[1]);
	const state = checkpointText(session.messages);
	expectTodoCheckpoint(state, phases);
	expect(continuation).toContain(JSON.stringify(state).slice(1, -1));
	expect(continuation).toContain("Newest user request: preserve the release lock and continue the rollout");
	expect(continuation).toContain("release-input.ts");
	expect(continuation).toContain("release-output.ts");
	expect(summarizer).not.toHaveBeenCalled();
});

it("checkpoints only owned running jobs and pending deliveries, then drops settled job state on recompaction", async () => {
	const summarizer = forbidSummarizer();
	const manager = SessionManager.inMemory(temp.path());
	seedConversation(manager);
	const jobs = new AsyncJobManager({});
	jobManagers.push(jobs);
	const recorder = recordRequests();
	const session = createSession(manager, recorder.streamFn, { asyncJobManager: jobs, agentId: "Main" });
	const runningGate = Promise.withResolvers<string>();
	const deliveryGate = Promise.withResolvers<void>();
	const deliveryStarted = Promise.withResolvers<void>();
	const otherDeliveryStarted = Promise.withResolvers<void>();
	releaseGates.push(
		() => runningGate.resolve("finished"),
		() => deliveryGate.resolve(),
	);
	jobs.registerDeliverySink("Main", async () => {
		deliveryStarted.resolve();
		await deliveryGate.promise;
	});
	jobs.registerDeliverySink("OtherAgent", async () => {
		otherDeliveryStarted.resolve();
		await deliveryGate.promise;
	});
	const runningId = jobs.register("bash", "Build the release package", async () => await runningGate.promise, {
		id: "qa-owned-running",
		ownerId: "Main",
		intent: "Produce the signed release bundle",
	});
	const otherRunningId = jobs.register("bash", "OTHER-AGENT-RUNNING-PURPOSE", async () => await runningGate.promise, {
		id: "qa-other-running",
		ownerId: "OtherAgent",
	});
	const pendingId = jobs.register("task", "Owned result awaiting delivery", async () => "ready", {
		id: "qa-owned-pending",
		ownerId: "Main",
	});
	const otherPendingId = jobs.register("task", "OTHER-AGENT-PENDING-PURPOSE", async () => "ready", {
		id: "qa-other-pending",
		ownerId: "OtherAgent",
	});
	await withTimeout(
		Promise.all([deliveryStarted.promise, otherDeliveryStarted.promise]),
		2_000,
		"The owned and unrelated jobs did not reach pending delivery",
	);

	await session.compact(undefined, { mode: "qaonly" });
	const state = checkpointText(session.messages);
	expect(state).toContain(runningId);
	expect(state).toMatch(/"status"\s*:\s*"running"/);
	expect(state).toContain("Build the release package");
	expect(state).toContain("Produce the signed release bundle");
	expect(state).toContain(pendingId);
	expect(state).not.toContain(otherRunningId);
	expect(state).not.toContain(otherPendingId);
	expect(state).not.toContain("OTHER-AGENT");

	runningGate.resolve("finished");
	deliveryGate.resolve();
	await jobs.waitForAll();
	await jobs.drainDeliveries();
	await session.compact(undefined, { mode: "qaonly" });
	expect(session.messages.some(message => message.role === "custom" && message.customType === QA_STATE_TYPE)).toBe(
		false,
	);
	expect(recorder.requests).toHaveLength(0);
	expect(summarizer).not.toHaveBeenCalled();
});

it("projects a durable tool-only checkpoint without mutating live history and replays it once after commit", async () => {
	const summarizer = forbidSummarizer();
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	const userId = manager.appendMessage({
		role: "user",
		content: "Investigate the release failure",
		timestamp: Date.now(),
	});
	manager.appendMessage({
		...createAssistantMessage("Working observation, not a terminal answer"),
		content: [{ type: "toolCall", id: "release-log", name: "read", arguments: { path: "release.log" } }],
		stopReason: "toolUse",
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "release-log",
		toolName: "read",
		content: [{ type: "text", text: "RAW-LOG-PAYLOAD: the signature expired" }],
		isError: false,
		timestamp: Date.now(),
	});
	const checkpoint: QaCheckpointData = {
		version: 1,
		cycleId: "qa-tool-findings",
		summary: "release.log confirms an expired signature; no replacement artifact has been built.",
		disposition: "continue",
		nextAction: "Inspect the signing configuration before building a replacement.",
	};
	const checkpointId = manager.appendCustomEntry(QA_CHECKPOINT_ENTRY_TYPE, checkpoint);
	await manager.flush();
	const uncommitted = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	readOnlyManagers.push(uncommitted);
	expect(JSON.stringify(convertToLlm(uncommitted.buildSessionContext().messages))).toContain("RAW-LOG-PAYLOAD");
	expect(
		uncommitted
			.buildSessionContext()
			.messages.some(message => message.role === "custom" && message.customType === QA_CHECKPOINT_ENTRY_TYPE),
	).toBe(false);

	const branch = manager.getBranch();
	const original = structuredClone(branch);
	const { details, summary } = prepareQaCompaction(branch, {
		plan: { path: "local://signing-plan.md", mode: "planning" },
	});
	expect(details.retainedEntryIds).toEqual([userId]);
	expect(details.checkpointEntryId).toBe(checkpointId);
	expect(summary).not.toContain(checkpoint.summary);
	const candidate: CompactionEntry = {
		type: "compaction",
		id: "qa-candidate",
		parentId: branch.at(-1)!.id,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId: "",
		tokensBefore: 0,
		details,
	};
	const projected = buildSessionContext([...branch, candidate]).messages;
	const projectedText = JSON.stringify(convertToLlm(projected));
	expect(projectedText).toContain(checkpoint.summary);
	expect(projectedText).toContain(checkpoint.nextAction!);
	expect(projectedText).toContain("local://signing-plan.md");
	expect(projectedText).not.toContain("RAW-LOG-PAYLOAD");
	expect(projectedText).not.toContain("Working observation");
	expect(branch).toEqual(original);
	expect(manager.getBranch()).toEqual(original);
	manager.appendCompaction(summary, undefined, "", 0, { details });
	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	const recorder = recordRequests();
	const session = createSession(reopened, recorder.streamFn);
	expect(recorder.requests).toHaveLength(0);
	const restored = JSON.stringify(convertToLlm(session.messages));
	expect(restored).toContain(checkpoint.summary);
	expect(restored).toContain("local://signing-plan.md");
	expect(restored).not.toContain("RAW-LOG-PAYLOAD");
	await session.prompt("Continue with the investigation");
	await session.waitForIdle();
	expect(recorder.requests).toHaveLength(1);
	const request = JSON.stringify(recorder.requests[0]);
	expect(request.split(checkpoint.summary)).toHaveLength(2);
	expect(request).toContain(checkpoint.nextAction!);
	expect(request).not.toContain("RAW-LOG-PAYLOAD");
	expect(summarizer).not.toHaveBeenCalled();
});

it("replaces operational checkpoints across repeated QA and reload while reset excludes earlier checkpoints and Q&A", async () => {
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	seedConversation(manager);
	const recorder = recordRequests();
	const session = createSession(manager, recorder.streamFn);
	const firstId = manager.appendCustomEntry(QA_CHECKPOINT_ENTRY_TYPE, {
		version: 1,
		cycleId: "qa-first",
		summary: "OLD-OPERATIONAL-FINDING",
		disposition: "continue",
		nextAction: "OLD-NEXT-ACTION",
	});
	await session.compact(undefined, { mode: "qaonly" });
	expect(JSON.stringify(convertToLlm(session.messages))).toContain("OLD-OPERATIONAL-FINDING");
	const latestId = manager.appendCustomEntry(QA_CHECKPOINT_ENTRY_TYPE, {
		version: 1,
		cycleId: "qa-second",
		summary: "LATEST-OPERATIONAL-FINDING",
		disposition: "blocked",
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Canonical state", tasks: [{ content: "Wait for signing approval", status: "blocked" }] }],
	});
	manager.appendMessage({ role: "user", content: "Keep the release paused", timestamp: Date.now() });
	const second = await session.compact(undefined, { mode: "qaonly" });
	expect(second.details).toHaveProperty("checkpointEntryId", latestId);
	await session.compact(undefined, { mode: "qaonly" });
	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	readOnlyManagers.push(reopened);
	const messages = reopened.buildSessionContext().messages;
	const text = JSON.stringify(convertToLlm(messages));
	expect(
		messages.filter(message => message.role === "custom" && message.customType === QA_CHECKPOINT_ENTRY_TYPE),
	).toHaveLength(1);
	expect(text.split("LATEST-OPERATIONAL-FINDING")).toHaveLength(2);
	expect(text).not.toContain("OLD-OPERATIONAL-FINDING");
	expect(text).not.toContain("OLD-NEXT-ACTION");
	expect(text).toContain("Continue the release work");
	expect(text).toContain("The release is underway.");
	expect(text).toContain("Keep the release paused");
	expect(text).toContain("Wait for signing approval");
	expect(manager.getEntries().some(entry => entry.id === firstId)).toBe(true);

	manager.appendResetBoundary();
	manager.appendMessage({ role: "user", content: "New unrelated request", timestamp: Date.now() });
	const afterReset = await session.compact(undefined, { mode: "qaonly" });
	expect(afterReset.details).not.toHaveProperty("checkpointEntryId");
	const resetText = JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
	expect(resetText).toContain("New unrelated request");
	expect(resetText).not.toContain("OPERATIONAL-FINDING");
	expect(resetText).not.toContain("Continue the release work");
	expect(resetText).not.toContain("Wait for signing approval");
	expect(recorder.requests).toHaveLength(0);
});

it("rejects missing, misplaced and unsupported checkpoint references instead of silently dropping evidence", () => {
	const manager = SessionManager.inMemory(temp.path());
	seedConversation(manager);
	const validId = manager.appendCustomEntry(QA_CHECKPOINT_ENTRY_TYPE, {
		version: 1,
		cycleId: "qa-valid",
		summary: "Retained evidence",
		disposition: "complete",
	});
	const { details, summary } = prepareQaCompaction(manager.getBranch());
	const branch = manager.getBranch();
	const candidate: CompactionEntry = {
		type: "compaction",
		id: "qa-invalid-candidate",
		parentId: branch.at(-1)!.id,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId: "",
		tokensBefore: 0,
	};
	for (const checkpointEntryId of ["missing", branch[0]!.id, "", null, 42]) {
		expect(() =>
			buildSessionContext([...branch, { ...candidate, details: { ...details, checkpointEntryId } }]),
		).toThrow();
	}
	const unsupported = branch.map(entry =>
		entry.id === validId && entry.type === "custom"
			? { ...entry, data: { ...(entry.data as QaCheckpointData), version: 2 } }
			: entry,
	);
	expect(() => prepareQaCompaction(unsupported)).toThrow();
	expect(() => buildSessionContext([...unsupported, { ...candidate, details }])).toThrow();
	for (const invalid of [
		{ version: 1, cycleId: "qa", summary: " ", disposition: "complete" },
		{ version: 1, cycleId: "qa", summary: "Finding", disposition: "continue" },
		{ version: 1, cycleId: "qa", summary: "Finding", disposition: "blocked", nextAction: "Run anyway" },
	]) {
		const malformed = branch.map(entry =>
			entry.id === validId && entry.type === "custom" ? { ...entry, data: invalid } : entry,
		);
		expect(() => prepareQaCompaction(malformed)).toThrow();
	}
	manager.appendResetBoundary();
	manager.appendMessage({ role: "user", content: "After reset", timestamp: Date.now() });
	const resetBranch = manager.getBranch();
	expect(() =>
		buildSessionContext([...resetBranch, { ...candidate, parentId: resetBranch.at(-1)!.id, details }]),
	).toThrow();
	const futureSource = branch.at(-1)!;
	expect(() =>
		buildSessionContext([
			...branch.slice(0, -1),
			{ ...candidate, parentId: branch.at(-2)!.id, details },
			{ ...futureSource, parentId: candidate.id },
		]),
	).toThrow();
});

it("sends an unchanged original prefix and complete ordered post-interval suffix after local fold and reload", async () => {
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	const summarizer = forbidSummarizer();
	const assistant = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage => ({
		...createAssistantMessage(""),
		content,
		stopReason,
	});
	const prefix: AgentMessage[] = [
		{ role: "user", content: "Original request: preserve parser compatibility; never deploy.", timestamp: Date.now() - 50 },
		assistant([{ type: "thinking", thinking: "PREFIX_THOUGHT", thinkingSignature: "PREFIX_SIGNATURE" },
			{ type: "text", text: "Compatibility recorded." }], "stop"),
		{ role: "user", content: "Continue that exact request.", timestamp: Date.now() - 40 },
	];
	for (const message of prefix) manager.appendMessage(message);
	manager.appendMessage(assistant([
		{ type: "thinking", thinking: "REMOVED_REASONING_CHAIN", thinkingSignature: "removed-signature" },
		{ type: "toolCall", id: "fold-read", name: "read", arguments: { path: "missing-source.ts:71-72" } },
	], "toolUse"));
	manager.appendMessage({
		role: "toolResult", toolCallId: "fold-read", toolName: "read", isError: false, timestamp: Date.now(),
		content: [{ type: "text", text: "[missing-source.ts#CAFE]\n71:const immutable = 17;\n72:export { immutable };\nUNSELECTED_RAW_PAYLOAD" }],
	});
	manager.appendCustomMessageEntry(SEARCH_REWIND_STATE, "", false, { activeRefs: [searchReference("r", "fold-read")] });
	const checkpoint: QaCheckpointData = {
		version: 1, cycleId: "local-fold", summary: "Saved parser implementation.", disposition: "continue",
		nextAction: "Review integration without deploying.",
	};
	manager.appendMessage(assistant([{ type: "toolCall", id: "report-local", name: "new_context",
		arguments: { checkpoint } }], "toolUse"));
	manager.appendCustomEntry(QA_CHECKPOINT_ENTRY_TYPE, checkpoint);
	manager.appendMessage({
		role: "toolResult", toolCallId: "report-local", toolName: "new_context", isError: false,
		timestamp: Date.now(), content: [{ type: "text", text: "accepted" }],
	});
	const suffix: AgentMessage[] = [
		assistant([
			{ type: "thinking", thinking: "SUFFIX_THOUGHT", thinkingSignature: "UNSAFE_SUFFIX_SIGNATURE" },
			{ type: "text", text: "Ordered suffix before both results." },
			{ type: "toolCall", id: "suffix-one", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "suffix-two", name: "read", arguments: { path: "b.ts" } },
		], "toolUse"),
		{ role: "toolResult", toolCallId: "suffix-two", toolName: "read", isError: false, timestamp: Date.now(),
			content: [{ type: "text", text: "SECOND_CALL_RESULT_DELIVERED_FIRST" }] },
		{ role: "toolResult", toolCallId: "suffix-one", toolName: "read", isError: false, timestamp: Date.now(),
			content: [{ type: "text", text: "FIRST_CALL_RESULT_DELIVERED_LAST" }] },
	];
	for (const message of suffix) manager.appendMessage(message);
	const originalContext = manager.buildSessionContext().messages;
	const prepared = prepareLocalRewindCompaction(manager.getBranch(), originalContext);
	manager.appendCompaction(prepared.summary, undefined, "", 0, {
		method: "rewind", details: preserveSearchMaterials(manager.getBranch(), prepared.details),
	});
	for (let cycle = 0; cycle < 8; cycle++) {
		manager.appendMessage({ role: "user", content: `Continue phase ${cycle}; preserve every original constraint.`,
			timestamp: Date.now() });
		manager.appendMessage(assistant([
			{ type: "thinking", thinking: `REMOVED_REPEAT_CHAIN_${cycle}` },
			{ type: "toolCall", id: `repeat-work-${cycle}`, name: "read", arguments: { path: "unselected.log" } },
		], "toolUse"));
		manager.appendMessage({ role: "toolResult", toolCallId: `repeat-work-${cycle}`, toolName: "read",
			isError: false, timestamp: Date.now(), content: [{ type: "text", text: "REMOVED_REPEAT_PAYLOAD" }] });
		const next = { ...checkpoint, cycleId: `repeat-local-${cycle}`, summary: `Saved phase ${cycle}.` };
		manager.appendMessage(assistant([{ type: "toolCall", id: `repeat-report-${cycle}`, name: "new_context",
			arguments: { checkpoint: next } }], "toolUse"));
		manager.appendCustomEntry(QA_CHECKPOINT_ENTRY_TYPE, next);
		manager.appendMessage({ role: "toolResult", toolCallId: `repeat-report-${cycle}`, toolName: "new_context",
			isError: false, timestamp: Date.now(), content: [{ type: "text", text: "accepted" }] });
		const nextFold = prepareLocalRewindCompaction(manager.getBranch(), manager.buildSessionContext().messages);
		manager.appendCompaction(nextFold.summary, undefined, "", 0, {
			method: "rewind", details: preserveSearchMaterials(manager.getBranch(), nextFold.details),
		});
	}
	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	const recorder = recordRequests();
	const session = createSession(reopened, recorder.streamFn);
	expect(session.messages.slice(0, prefix.length)).toEqual(prefix);
	await session.prompt("Continue after the fold.");
	await session.waitForIdle();
	expect(recorder.requests).toHaveLength(1);
	const request = recorder.requests[0]!;
	expect(request.slice(0, convertToLlm(prefix).length)).toEqual(convertToLlm(prefix));
	const payload = JSON.stringify(request);
	expect(payload).toContain("PREFIX_SIGNATURE");
	expect(payload).not.toContain("UNSAFE_SUFFIX_SIGNATURE");
	expect(payload).not.toContain("REMOVED_REASONING_CHAIN");
	expect(payload).not.toContain("REMOVED_REPEAT_CHAIN");
	expect(payload).not.toContain("REMOVED_REPEAT_PAYLOAD");
	for (let cycle = 0; cycle < 8; cycle++) expect(payload).toContain(`Continue phase ${cycle}`);
	expect(payload).not.toContain("UNSELECTED_RAW_PAYLOAD");
	expect(payload.match(/71:const immutable = 17;/g)).toHaveLength(1);
	expect(payload).toContain("[missing-source.ts#CAFE]");
	const one = request.findIndex(message => message.role === "assistant" &&
		message.content.some(block => block.type === "toolCall" && block.id === "suffix-one"));
	expect(one).toBeGreaterThanOrEqual(0);
	expect(request.slice(one, one + 3).map(message =>
		message.role === "toolResult" ? message.toolCallId : message.role)).toEqual([
		"assistant", "suffix-two", "suffix-one",
	]);
	expect(summarizer).not.toHaveBeenCalled();
});

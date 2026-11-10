import { afterEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { parseCompactArgs, QA_TOOL_TIP_TYPE } from "@oh-my-pi/pi-coding-agent/session/compact-modes";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const temp = TempDir.createSync("@pi-qa-compact-");
const auth = createInMemoryAuthStorage();
let session: AgentSession | undefined;
afterEach(async () => {
	await session?.dispose();
	auth.close();
	temp.removeSync();
});

it("keeps journal Q&A without a model call and exposes deduplicated activity immediately and after reopen", async () => {
	expect(parseCompactArgs("qaonly")).toEqual({ mode: "qaonly", instructions: undefined });
	expect(parseCompactArgs("qaonly focus")).toHaveProperty("error");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const stream = vi.fn(() => { throw new Error("unexpected model call"); });
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage => ({
		role: "assistant" as const, content, stopReason, api: "anthropic-messages" as const,
		provider: "anthropic", model: model.id, usage, timestamp: Date.now(),
	});
	manager.appendMessage({ role: "user", content: "first instruction", timestamp: Date.now() });
	manager.appendMessage(assistant([
		{ type: "text", text: "intermediate" },
		{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts:1-20" } },
		{ type: "toolCall", id: "r2", name: "read", arguments: { path: "a.ts:30-40" } },
		{ type: "toolCall", id: "s", name: "read", arguments: { path: "skill://sample" } },
		{ type: "toolCall", id: "w", name: "write", arguments: { path: "b.ts", content: "x" } },
		{ type: "toolCall", id: "c", name: "bash", arguments: { command: "pwd" } },
		{ type: "toolCall", id: "e", name: "eval", arguments: { language: "js", code: "example" } },
	], "toolUse"));
	for (const [id, name] of [["r1", "read"], ["r2", "read"], ["s", "read"], ["w", "write"], ["c", "bash"]]) {
		manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "result" }], isError: false, timestamp: Date.now() });
	}
	manager.appendMessage({
		role: "toolResult", toolCallId: "e", toolName: "eval", content: [{ type: "text", text: "done" }],
		isError: false, timestamp: Date.now(),
		details: { statusEvents: [
			{ op: "read", path: "nested.ts:10-20" },
			{ op: "write", path: "nested-out.ts" },
			{ op: "read", path: "skill://nested-skill" },
			{ op: "run", cmd: "git status" },
		] },
	});
	manager.appendMessage(assistant([{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "final answer" }], "stop"));
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [] }, streamFn: stream });
	session = new AgentSession({ agent, sessionManager: manager, settings: Settings.isolated(), modelRegistry: new ModelRegistry(auth) });
	const compacted = await session.compact(undefined, { mode: "qaonly" });
	expect(compacted.summary).toContain("first instruction");
	expect(compacted.summary).toContain("final answer");
	expect(compacted.summary).not.toContain("a.ts");
	expect(stream).not.toHaveBeenCalled();
	const before = convertToLlm(session.messages);
	const beforeText = JSON.stringify(before);
	expect(beforeText).toContain("first instruction");
	expect(beforeText).toContain("final answer");
	expect(beforeText).not.toContain("intermediate");
	expect(beforeText).not.toContain("private reasoning");
	const beforeActivity = session.messages.filter(message => message.role === "custom" && message.customType === QA_TOOL_TIP_TYPE);
	expect(beforeActivity).toHaveLength(1);
	expect(beforeText.match(/a\.ts/g)?.length).toBe(1);
	expect(beforeText).toContain("nested.ts");
	expect(beforeText).toContain("nested-out.ts");

	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile()!, temp.join("sessions"));
	reopened.appendMessage({ role: "user", content: "next instruction", timestamp: Date.now() });
	const reopenedMessages = reopened.buildSessionContext().messages;
	const afterActivity = reopenedMessages.filter(message => message.role === "custom" && message.customType === QA_TOOL_TIP_TYPE);
	expect(afterActivity).toEqual(beforeActivity);
	expect(reopenedMessages.findIndex(message => message.role === "custom" && message.customType === QA_TOOL_TIP_TYPE))
		.toBeLessThan(reopenedMessages.findIndex(message => message.role === "user" && message.content === "next instruction"));
	const after = convertToLlm(reopenedMessages);
	const text = JSON.stringify(after);
	expect(text.match(/a\.ts/g)?.length).toBe(1);
	expect(text).toContain("nested.ts");
	expect(text).toContain("nested-out.ts");
	expect(text).toContain("nested-skill");
	expect(text).toContain("git status");
	expect(text).toContain("b.ts");
	expect(text).toContain("sample");
	expect(text).toContain("pwd");
	expect(reopened.getEntries().filter(entry => entry.type === "message").length).toBeGreaterThan(2);

	manager.appendMessage({ role: "user", content: "next instruction", timestamp: Date.now() });
	await session.compact(undefined, { mode: "qaonly" });
	const twiceMessages = manager.buildSessionContext().messages;
	const twice = JSON.stringify(convertToLlm(twiceMessages));
	expect(twice).toContain("first instruction");
	expect(twice).toContain("final answer");
	expect(twice).toContain("next instruction");
	expect(twiceMessages.some(message => message.role === "custom" && message.customType === QA_TOOL_TIP_TYPE)).toBe(false);
	expect(twice).not.toContain("a.ts");
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
	expect(manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "user" &&
		entry.message.content === "first instruction")).toBe(true);
	expect(stream).not.toHaveBeenCalled();
});

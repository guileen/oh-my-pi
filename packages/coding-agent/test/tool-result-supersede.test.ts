import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "../src/session/session-entries";
import { elideSupersededToolResults, planSupersededReads } from "../src/session/tool-result-supersede";

let seq = 0;

function assistant(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function result(callId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function entry(message: AgentMessage): SessionEntry {
	seq += 1;
	return {
		type: "message",
		id: `s-${seq}`,
		parentId: seq === 1 ? null : `s-${seq - 1}`,
		timestamp: new Date(Date.now() + seq).toISOString(),
		message,
	};
}

const read = (id: string, path: string, offset?: number, limit?: number) =>
	assistant([{ type: "toolCall", id, name: "read", arguments: { path, offset, limit } }]);
const write = (id: string, path: string) => assistant([{ type: "toolCall", id, name: "edit", arguments: { path } }]);

describe("superseded reads", () => {
	test("an edit makes earlier reads of that file stale", () => {
		const branch = [
			entry(read("r1", "/repo/a.ts")),
			entry(result("r1", "old contents")),
			entry(write("e1", "/repo/a.ts")),
			entry(result("e1", "ok")),
		];
		expect(planSupersededReads(branch).get("r1")).toBe("e1");
	});

	test("orthogonal windows are not superseded by each other", () => {
		const branch = [
			entry(read("r1", "/repo/a.ts", 1, 100)),
			entry(result("r1", "head")),
			entry(read("r2", "/repo/a.ts", 500, 100)),
			entry(result("r2", "tail")),
		];
		expect(planSupersededReads(branch).size).toBe(0);
	});

	test("a covering window supersedes the narrower one", () => {
		const branch = [
			entry(read("r1", "/repo/a.ts", 10, 20)),
			entry(result("r1", "slice")),
			entry(read("r2", "/repo/a.ts")),
			entry(result("r2", "whole file")),
		];
		expect(planSupersededReads(branch).get("r1")).toBe("r2");
	});

	test("elision keeps the tool pairing and only replaces the payload", () => {
		const messages = [result("r1", "stale bytes"), result("keep", "fresh bytes")];
		const elided = elideSupersededToolResults(messages, new Map([["r1", "e1"]]));
		expect(elided).toHaveLength(2);
		const first = elided[0];
		expect(first.role).toBe("toolResult");
		expect(first.role === "toolResult" && first.toolCallId).toBe("r1");
		expect(first.role === "toolResult" && first.content[0].type === "text" && first.content[0].text).toContain(
			"superseded",
		);
		expect(elided[1]).toBe(messages[1]);
	});
});

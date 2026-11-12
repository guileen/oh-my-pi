import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "../src/session/session-entries";
import {
	pinRecordsFor,
	pinnedCallIds,
	pinnedEntryIds,
	resolvePinTargets,
	TOOL_RESULT_PIN_CUSTOM_TYPE,
} from "../src/session/tool-result-pins";

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

function result(callId: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

function messageEntry(message: AgentMessage): SessionEntry {
	seq += 1;
	return {
		type: "message",
		id: `m-${seq}`,
		parentId: seq === 1 ? null : `m-${seq - 1}`,
		timestamp: new Date(Date.now() + seq).toISOString(),
		message,
	};
}

function pinEntry(callId: string, pinned: boolean): SessionEntry {
	seq += 1;
	return {
		type: "custom",
		id: `p-${seq}`,
		parentId: `m-${seq}`,
		timestamp: new Date(Date.now() + seq).toISOString(),
		customType: TOOL_RESULT_PIN_CUSTOM_TYPE,
		data: { callId, pinned, ts: new Date().toISOString() },
	};
}

const branch: SessionEntry[] = [
	messageEntry(
		assistant([
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/repo/a.ts", offset: 1, limit: 50 } },
		]),
	),
	messageEntry(result("c1", "first window")),
	messageEntry(
		assistant([
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "/repo/a.ts", offset: 100, limit: 20 } },
		]),
	),
	messageEntry(result("c2", "second window")),
	messageEntry(assistant([{ type: "toolCall", id: "c3", name: "read", arguments: { path: "/repo/b.ts" } }])),
	messageEntry(result("c3", "whole file", true)),
];

describe("tool result pins", () => {
	test("the last decision per call id wins, so unpin releases a pin", () => {
		const entries = [...branch, pinEntry("c1", true), pinEntry("c2", true), pinEntry("c1", false)];
		const pinned = pinnedCallIds(entries);
		expect([...pinned]).toEqual(["c2"]);
	});

	test("a path target resolves to the newest successful read covering the range", () => {
		const plan = resolvePinTargets(branch, [{ path: "/repo/a.ts", from: 100, to: 110 }], "/repo");
		expect(plan.resolved.map(item => item.callId)).toEqual(["c2"]);
		expect(plan.skipped).toHaveLength(0);

		const missed = resolvePinTargets(branch, [{ path: "/repo/a.ts", from: 1, to: 200 }], "/repo");
		expect(missed.resolved).toHaveLength(0);
		expect(missed.skipped[0]?.reason).toBe("not_found");
	});

	test("an errored result is never pinned", () => {
		const plan = resolvePinTargets(branch, [{ path: "/repo/b.ts" }], "/repo");
		expect(plan.resolved).toHaveLength(0);
		expect(plan.skipped[0]?.reason).toBe("unsuccessful");
	});

	test("pinned entry ids point at the surviving tool result entry", () => {
		const records = pinRecordsFor([{ callId: "c2", entryId: branch[3].id, label: "read" }], true);
		const entries = [...branch, ...records.map(record => pinEntryFor(record))];
		expect(pinnedEntryIds(entries)).toEqual([branch[3].id]);
	});
});

function pinEntryFor(record: { callId: string; pinned: boolean; ts: string }): SessionEntry {
	seq += 1;
	return {
		type: "custom",
		id: `p-${seq}`,
		parentId: `m-${seq}`,
		timestamp: new Date(Date.now() + seq).toISOString(),
		customType: TOOL_RESULT_PIN_CUSTOM_TYPE,
		data: record,
	};
}

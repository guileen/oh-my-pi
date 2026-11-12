import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { Tokenizer } from "@oh-my-pi/pi-agent-core/tokenizer";
import { createAssistantMessage, createUserMessage } from "./helpers";

const tokenizer = new Tokenizer();
const BIG = "x".repeat(100_000);

let seq = 0;
function entry(message: SessionMessageEntry["message"]): SessionMessageEntry {
	seq += 1;
	return {
		id: `pin-${seq}`,
		parentId: seq === 1 ? null : `pin-${seq - 1}`,
		timestamp: new Date(Date.now() + seq).toISOString(),
		type: "message",
		message,
	};
}

const toolResult = (callId: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: Date.now(),
});

/**
 * A pin is a cut barrier. Retaining is a suffix, so the only legal implementation
 * is moving the retained start back to the turn that issued the protected tool
 * result — never past it, and never into the middle of that turn.
 */
describe("prepareCompaction protected entries", () => {
	const entries: SessionMessageEntry[] = [
		entry(createUserMessage(BIG)),
		entry(createAssistantMessage([{ type: "text", text: BIG }])),
		entry(createUserMessage(BIG)),
		entry(
			createAssistantMessage([
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "spec.md" } },
				{ type: "text", text: BIG },
			]),
		),
		entry(toolResult("call-1", BIG)),
		entry(createUserMessage("continue")),
		entry(createAssistantMessage([{ type: "text", text: "done" }])),
	];

	test("a pinned tool result pulls the cut back to its turn start", () => {
		const unprotected = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, undefined, tokenizer);
		expect(unprotected).toBeDefined();
		expect(unprotected!.firstKeptEntryId).not.toBe(entries[2].id);

		const protectedPrep = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, undefined, tokenizer, [
			entries[4].id,
		]);
		expect(protectedPrep).toBeDefined();
		expect(protectedPrep!.firstKeptEntryId).toBe(entries[2].id);
		expect(protectedPrep!.isSplitTurn).toBe(false);
		expect(protectedPrep!.messagesToSummarize).toHaveLength(2);
	});

	test("a pin after the cut changes nothing", () => {
		const plain = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, undefined, tokenizer);
		const withLaterPin = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, undefined, tokenizer, [
			entries[6].id,
		]);
		expect(withLaterPin!.firstKeptEntryId).toBe(plain!.firstKeptEntryId);
	});
});

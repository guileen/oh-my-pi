import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isRecord, stringProperty } from "@oh-my-pi/pi-utils";

/** Hidden marker applied after an assistant turn whose reasoning was rewritten. */
export const THINK_NOTE_MESSAGE_TYPE = "think-note";

/** Tool call that asks the runtime to rewrite this turn's reasoning. */
export const THINK_NOTE_TOOL_NAME = "thinknote";

/**
 * Signatures that name a plaintext replay field rather than opaque provider
 * ciphertext. Rewriting any other signature invalidates content the provider
 * binds to it (Anthropic extended thinking, encrypted Responses items).
 */
export const PLAINTEXT_REASONING_SIGNATURES: Readonly<Record<string, true>> = {
	reasoning_content: true,
	reasoning: true,
	reasoning_text: true,
};

/**
 * Replace only when the note is at most a quarter of the reasoning it
 * replaces: the note is output plus one first-replay input, while the
 * reasoning is one first-replay input (DeepSeek flash: output 1.20 versus
 * input 0.30 USD/1M). A note replayed inside the tool call arguments is a
 * second input copy; a caller that hides the call can use 4.
 */
export const THINK_NOTE_TOKEN_RATIO = 4;

export type ThinkNoteMode = "replace" | "drop" | "kept";

export interface ThinkNoteDetails {
	/** Tool call that requested the rewrite. */
	toolCallId: string;
	mode: ThinkNoteMode;
	/** Replacement reasoning; present only for `replace`. */
	note?: string;
	beforeTokens: number;
	afterTokens: number;
	/** Why the reasoning was kept; present only for `kept`. */
	reason?: string;
}

/** Parse a persisted marker; malformed details are ignored (reasoning replays). */
export function parseThinkNoteDetails(value: unknown): ThinkNoteDetails | undefined {
	if (!isRecord(value)) return undefined;
	const mode = value.mode;
	if (mode !== "replace" && mode !== "drop" && mode !== "kept") return undefined;
	const toolCallId = stringProperty(value, "toolCallId");
	if (!toolCallId) return undefined;
	const beforeTokens = typeof value.beforeTokens === "number" ? value.beforeTokens : 0;
	const afterTokens = typeof value.afterTokens === "number" ? value.afterTokens : 0;
	const note = typeof value.note === "string" ? value.note : undefined;
	const reason = typeof value.reason === "string" ? value.reason : undefined;
	return {
		toolCallId,
		mode,
		beforeTokens,
		afterTokens,
		...(note !== undefined && { note }),
		...(reason !== undefined && { reason }),
	};
}

/**
 * Rewrite the assistant turn for the LLM view only. The persisted message keeps
 * the full reasoning, so the transcript, reload and display-reset rebuilds stay
 * intact; a dropped or replaced reasoning exists only in the provider request.
 */
export function applyThinkNoteToAssistant(message: AssistantMessage, details: ThinkNoteDetails): AssistantMessage {
	if (details.mode === "kept") return message;
	let replaced = false;
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "thinking") {
			if (details.mode === "replace" && !replaced) {
				content.push({ type: "thinking", thinking: details.note ?? "" });
				replaced = true;
			}
			continue;
		}
		content.push(block);
	}
	return { ...message, content, providerPayload: undefined };
}

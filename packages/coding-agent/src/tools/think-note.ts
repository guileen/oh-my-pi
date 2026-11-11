import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import thinkNoteDescription from "../prompts/tools/think-note.md" with { type: "text" };
import { THINK_NOTE_TOOL_NAME, type ThinkNoteDetails } from "../session/think-note";
import type { ToolSession } from ".";
import { cfgCheckpointEnabled } from "./settings";

const thinkNoteSchema = type({ note: "string | null" });

type ThinkNoteParams = typeof thinkNoteSchema.infer;

/**
 * Asks the runtime to replace or drop this turn's reasoning for the next
 * provider request. The decision is made at message end with the tokenizer and
 * the provider's replay constraints; this tool only reports that decision.
 */
export class ThinkNoteTool implements AgentTool<typeof thinkNoteSchema, ThinkNoteDetails | undefined> {
	readonly name = THINK_NOTE_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "ThinkNote";
	readonly summary = "Compress or drop the current reasoning";
	readonly description = prompt.render(thinkNoteDescription);
	readonly parameters = thinkNoteSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = (): string => "noting";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ThinkNoteTool | null {
		return cfgCheckpointEnabled.get(session.settings) ? new ThinkNoteTool(session) : null;
	}

	async execute(
		toolCallId: string,
		_params: ThinkNoteParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ThinkNoteDetails | undefined>> {
		signal?.throwIfAborted();
		const outcome = this.session.takeThinkNoteOutcome?.(toolCallId);
		if (!outcome) {
			return { content: [{ type: "text", text: "Thinking note recorded for the next request." }] };
		}
		const text =
			outcome.mode === "kept"
				? `Thinking kept: ${outcome.reason ?? "not rewritten"}.`
				: outcome.mode === "drop"
					? `Thinking dropped: ${outcome.beforeTokens} tokens leave the next request.`
					: `Thinking replaced: ${outcome.beforeTokens} → ${outcome.afterTokens} tokens.`;
		return { content: [{ type: "text", text }], details: outcome };
	}
}

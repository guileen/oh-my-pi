import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import rememberDescription from "../prompts/tools/remember.md" with { type: "text" };
import {
	CONTEXT_MEMORY_LINE_HINT_CHARS,
	CONTEXT_MEMORY_LINE_MAX_CHARS,
	CONTEXT_MEMORY_LINE_TOOL_NAME,
	CONTEXT_MEMORY_LINES_PER_DAY,
	type ContextMemoryLineAccepted,
} from "../session/context-memory";
import type { ToolSession } from ".";
import { cfgCheckpointEnabled } from "./settings";

const rememberSchema = type({ line: "string" });

type RememberParams = typeof rememberSchema.infer;

/**
 * Appends one long-term memory line. The line is one sentence by contract, but
 * the only enforced bounds are a soft hint and a hard limit that asks for a
 * rewrite instead of truncating.
 */
export class RememberTool implements AgentTool<typeof rememberSchema, ContextMemoryLineAccepted | undefined> {
	readonly name = CONTEXT_MEMORY_LINE_TOOL_NAME;
	readonly approval = "read" as const;
	readonly label = "Remember";
	readonly summary = "Record one long-term memory line";
	readonly description = prompt.render(rememberDescription);
	readonly parameters = rememberSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = (): string => "remembering";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): RememberTool | null {
		return cfgCheckpointEnabled.get(session.settings) ? new RememberTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: RememberParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ContextMemoryLineAccepted | undefined>> {
		signal?.throwIfAborted();
		const result = this.session.rememberContextLine?.(params.line);
		if (!result) {
			return { content: [{ type: "text", text: "Line recorded." }] };
		}
		if (!result.ok) {
			switch (result.reason) {
				case "empty":
					throw new ToolError("Line is empty after trimming. Write one sentence.");
				case "too_long":
					throw new ToolError(
						`Line is ${result.chars} characters; the hard limit is ${CONTEXT_MEMORY_LINE_MAX_CHARS}. Rewrite it under ${CONTEXT_MEMORY_LINE_HINT_CHARS}.`,
					);
				case "daily_limit":
					throw new ToolError(
						`Already ${CONTEXT_MEMORY_LINES_PER_DAY} lines this day. Merge or select a line before adding another.`,
					);
			}
		}
		const text = result.hint
			? `Line recorded (${result.count}/${CONTEXT_MEMORY_LINES_PER_DAY}, ${result.chars} chars — over the ${CONTEXT_MEMORY_LINE_HINT_CHARS}-char hint; shorter is better).`
			: `Line recorded (${result.count}/${CONTEXT_MEMORY_LINES_PER_DAY}, ${result.chars} chars).`;
		return { content: [{ type: "text", text }], details: result };
	}
}

import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import pinDescription from "../prompts/tools/pin.md" with { type: "text" };
import type { PinResult, PinTarget } from "../session/tool-result-pins";
import type { ToolSession } from ".";
import { cfgCheckpointEnabled } from "./settings";

const pinSchema = type({
	targets: type({
		"callId?": "string",
		"path?": "string",
		"from?": "number",
		"to?": "number",
	}).array(),
	"unpin?": "boolean",
});

type PinParams = typeof pinSchema.infer;

/**
 * Marks tool results as fold barriers. The pin itself is a flag entry: no
 * tokens move, so the cached prefix is untouched and the call is free.
 */
export class PinTool implements AgentTool<typeof pinSchema, PinResult | undefined> {
	readonly name = "pin";
	readonly approval = "read" as const;
	readonly label = "Pin";
	readonly summary = "Keep selected tool results across context folds";
	readonly description = prompt.render(pinDescription);
	readonly parameters = pinSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = (): string => "pinning evidence";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): PinTool | null {
		return cfgCheckpointEnabled.get(session.settings) ? new PinTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: PinParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<PinResult | undefined>> {
		signal?.throwIfAborted();
		if (params.targets.length === 0) return { content: [{ type: "text", text: "No targets given." }] };
		const result = this.session.pinToolResults?.(params.targets as PinTarget[], params.unpin !== true);
		if (!result) return { content: [{ type: "text", text: "Pinning is unavailable in this session." }] };
		const verb = params.unpin === true ? "Unpinned" : "Pinned";
		const lines: string[] = [];
		if (result.resolved.length > 0) {
			lines.push(`${verb} ${result.resolved.length}: ${result.resolved.map(item => item.label).join(", ")}`);
		}
		if (result.skipped.length > 0) {
			lines.push(
				`Skipped ${result.skipped.length}: ${result.skipped
					.map(item => `${describeTarget(item.target)} (${item.reason})`)
					.join(", ")}`,
			);
		}
		if (lines.length === 0) lines.push("Nothing to change.");
		if (params.unpin !== true && result.resolved.length > 0) {
			lines.push("Pins shrink what a fold can reclaim; unpin once the content stops mattering.");
		}
		return { content: [{ type: "text", text: lines.join("\n") }], details: result };
	}
}

function describeTarget(target: PinTarget): string {
	if (target.callId) return `call ${target.callId}`;
	if (target.path) {
		const window =
			target.from === undefined ? "" : `:${target.from}${target.to === undefined ? "" : `-${target.to}`}`;
		return `${target.path}${window}`;
	}
	return "empty target";
}

/**
 * Supersession is hygiene, not token economics: a read whose file was later
 * edited, or whose lines were later re-read, has negative utility (stale
 * content that invites the model to trust outdated code), and the counterfactual
 * is not "save tokens" but "stop poisoning attention".
 *
 * The plan never deletes an entry: `tool_result` messages must stay paired with
 * their `tool_call`, so the retained copy is degraded to a stub that names the
 * newer evidence. That keeps provider tool-pairing valid by construction.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import type { SessionEntry } from "./session-entries";

/** Tools whose result is a file projection that a later call can invalidate. */
const READ_TOOLS = new Set(["read"]);
/** Tools whose success invalidates every earlier projection of the same file. */
const WRITE_TOOLS = new Set(["write", "edit", "ast_edit", "apply_patch"]);

interface ProjectionCall {
	index: number;
	callId: string;
	name: string;
	args: Record<string, unknown>;
	ok: boolean;
}

interface Span {
	start: number;
	end: number;
}

/** Inclusive 1-based line window a read covered; unbounded when `limit` is absent. */
function readSpan(args: Record<string, unknown>): Span {
	const offset = typeof args.offset === "number" ? args.offset : 1;
	const limit = typeof args.limit === "number" ? args.limit : Number.POSITIVE_INFINITY;
	return { start: offset, end: offset + limit - 1 };
}

function arguedPath(args: Record<string, unknown>): string | undefined {
	const value = args.path ?? args.file_path ?? args.filePath ?? args.file;
	return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined;
}

function collectProjections(branch: readonly SessionEntry[]): ProjectionCall[] {
	const index = new Map<string, number>();
	const projections: ProjectionCall[] = [];
	branch.forEach((entry, entryIndex) => {
		if (entry.type !== "message") return;
		const message = entry.message as AgentMessage;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				index.set(block.id, projections.length);
				projections.push({
					index: entryIndex,
					callId: block.id,
					name: block.name,
					args: block.arguments,
					ok: false,
				});
			}
			return;
		}
		if (message.role !== "toolResult") return;
		const at = index.get(message.toolCallId);
		if (at === undefined) return;
		projections[at].ok = !message.isError;
	});
	return projections;
}

/**
 * Superseded read call id → the newer evidence that makes it stale.
 * A read is stale when a later successful write/blob-changing tool touched the
 * same file, or when a later successful read of the same file covers its window.
 * Unbounded (whole-file) reads subsume every earlier window of that file.
 */
export function planSupersededReads(branch: readonly SessionEntry[]): Map<string, string> {
	const superseded = new Map<string, string>();
	const projections = collectProjections(branch);
	for (let i = 0; i < projections.length; i++) {
		const current = projections[i];
		if (!current.ok || !READ_TOOLS.has(current.name)) continue;
		const file = arguedPath(current.args);
		if (!file) continue;
		const span = readSpan(current.args);
		for (let j = i + 1; j < projections.length; j++) {
			const later = projections[j];
			if (!later.ok) continue;
			if (arguedPath(later.args) !== file) continue;
			if (WRITE_TOOLS.has(later.name)) {
				superseded.set(current.callId, later.callId);
				break;
			}
			if (!READ_TOOLS.has(later.name)) continue;
			const laterSpan = readSpan(later.args);
			const whole = later.args.limit === undefined && (later.args.offset ?? 1) === 1;
			if (whole || (laterSpan.start <= span.start && laterSpan.end >= span.end)) {
				superseded.set(current.callId, later.callId);
				break;
			}
		}
	}
	return superseded;
}

/**
 * Degrade superseded tool results to a stub, on a copy. The journal keeps the
 * original bytes; only the request/display projection is shortened, and the
 * `tool_call`/`tool_result` pairing is preserved exactly.
 */
export function elideSupersededToolResults(
	messages: readonly AgentMessage[],
	superseded: ReadonlyMap<string, string>,
): AgentMessage[] {
	if (superseded.size === 0) return messages as AgentMessage[];
	return messages.map(message => {
		if (message.role !== "toolResult") return message;
		if (!superseded.has(message.toolCallId)) return message;
		const by = superseded.get(message.toolCallId)!;
		return {
			...message,
			content: [
				{
					type: "text" as const,
					text: `[superseded: newer evidence came from tool call ${by}; re-read the file if its current contents matter]`,
				},
			],
		} satisfies AgentMessage;
	});
}

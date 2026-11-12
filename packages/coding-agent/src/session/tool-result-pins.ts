/**
 * Entry-level pin flags for tool results.
 *
 * A pin never moves tokens: the entry keeps its position in the append-only
 * history, so the cached prefix is untouched. What a pin buys is a cut barrier:
 * `prepareCompaction` may not move its retained start past a pinned entry, so
 * the result survives the fold verbatim instead of being summarized away.
 *
 * Pins are branch-scoped, unlike day notes and memory lines (which are
 * deliberately session-wide): rewinding off a branch must not leave a pin
 * protecting content that branch no longer contains.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as path from "node:path";
import type { SessionEntry } from "./session-entries";

/** Custom entry type carrying one pin/unpin decision. */
export const TOOL_RESULT_PIN_CUSTOM_TYPE = "tool-result-pin";

/** One recorded pin decision; later entries win. */
export interface ToolResultPinRecord {
	callId: string;
	pinned: boolean;
	ts: string;
	reason?: string;
}

export function isToolResultPinRecord(value: unknown): value is ToolResultPinRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.callId === "string" && typeof record.pinned === "boolean";
}

/** Live pin state accumulated from custom entries, last write per call id. */
export function pinnedCallIds(entries: readonly SessionEntry[]): Set<string> {
	const state = new Map<string, boolean>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TOOL_RESULT_PIN_CUSTOM_TYPE) continue;
		if (!isToolResultPinRecord(entry.data)) continue;
		state.set(entry.data.callId, entry.data.pinned);
	}
	const pinned = new Set<string>();
	for (const [callId, value] of state) if (value) pinned.add(callId);
	return pinned;
}

interface ToolCallRecord {
	callId: string;
	name: string;
	args: Record<string, unknown>;
	result?: ToolResultMessage;
	entryId?: string;
}

function toolCalls(branch: readonly SessionEntry[]): Map<string, ToolCallRecord> {
	const calls = new Map<string, ToolCallRecord>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				calls.set(block.id, { callId: block.id, name: block.name, args: block.arguments });
			}
			continue;
		}
		if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			if (!call) continue;
			call.result = message;
			call.entryId = entry.id;
		}
	}
	return calls;
}

/** Entry ids of the pinned tool results that still exist on this branch. */
export function pinnedEntryIds(branch: readonly SessionEntry[]): string[] {
	const pinned = pinnedCallIds(branch);
	if (pinned.size === 0) return [];
	const ids: string[] = [];
	for (const call of toolCalls(branch).values()) {
		if (call.entryId && pinned.has(call.callId)) ids.push(call.entryId);
	}
	return ids;
}

/** A pin target as the model names it: a call id, or the file it read. */
export interface PinTarget {
	callId?: string;
	path?: string;
	from?: number;
	to?: number;
}

export interface PinResolution {
	callId: string;
	entryId: string;
	label: string;
}

export interface PinResult {
	resolved: PinResolution[];
	skipped: { target: PinTarget; reason: "not_found" | "unsuccessful" | "empty" }[];
}

function argumentPath(args: Record<string, unknown>): string | undefined {
	const value = args.path ?? args.file_path ?? args.filePath;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolvesTo(cwd: string, reported: string, target: string): boolean {
	const normalize = (value: string) => path.resolve(cwd, value);
	return normalize(reported) === normalize(target);
}

function rangeCovers(args: Record<string, unknown>, from?: number, to?: number): boolean {
	if (from === undefined && to === undefined) return true;
	const offset = typeof args.offset === "number" ? args.offset : 1;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	const start = offset;
	const end = limit === undefined ? Number.POSITIVE_INFINITY : offset + limit - 1;
	if (from !== undefined && from < start) return false;
	if (to !== undefined && to > end) return false;
	return true;
}

/**
 * Resolve pin targets against this branch. A path target selects the most
 * recent successful result whose call read that path (and whose window covers
 * the requested range). Results never throw: unresolved targets are reported.
 */
export function resolvePinTargets(
	branch: readonly SessionEntry[],
	targets: readonly PinTarget[],
	cwd: string,
): PinResult {
	const calls = [...toolCalls(branch).values()];
	const resolved: PinResolution[] = [];
	const skipped: PinResult["skipped"] = [];
	for (const target of targets) {
		if (target.callId) {
			const call = calls.find(item => item.callId === target.callId);
			if (!call) skipped.push({ target, reason: "not_found" });
			else if (!call.result || !call.entryId) skipped.push({ target, reason: "unsuccessful" });
			else if (call.result.isError) skipped.push({ target, reason: "unsuccessful" });
			else resolved.push({ callId: call.callId, entryId: call.entryId, label: call.name });
			continue;
		}
		if (!target.path) {
			skipped.push({ target, reason: "empty" });
			continue;
		}
		const matches = calls.filter(call => {
			if (!call.result || !call.entryId) return false;
			const reported = argumentPath(call.args);
			if (!reported || !resolvesTo(cwd, reported, target.path!)) return false;
			return rangeCovers(call.args, target.from, target.to);
		});
		const match = matches.findLast(call => !call.result!.isError);
		if (match?.entryId) resolved.push({ callId: match.callId, entryId: match.entryId, label: match.name });
		else if (matches.length > 0) skipped.push({ target, reason: "unsuccessful" });
		else skipped.push({ target, reason: "not_found" });
	}
	return { resolved, skipped };
}

/** One pin decision per resolved call id, written as an append-only custom entry. */
export function pinRecordsFor(resolutions: readonly PinResolution[], pinned: boolean): ToolResultPinRecord[] {
	const ts = new Date().toISOString();
	return resolutions.map(resolution => ({ callId: resolution.callId, pinned, ts }));
}

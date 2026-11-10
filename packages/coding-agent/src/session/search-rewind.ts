import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { stripXdUrlPrefix } from "@oh-my-pi/pi-tui/tools/xd-url";
import materialTemplate from "../prompts/system/search-material.md" with { type: "text" };
import { writeDeviceDispatch } from "../tools/resolve";
import type { SessionEntry } from "./session-entries";

export const SEARCH_MATERIAL = "search-material";
export const SEARCH_REWIND_STATE = "search-rewind-state";
export const SEARCH_DECISION = "search-decision";
export const SEARCH_REWIND_KIND = "search-rewind";

export interface SourceSelection {
	readId: string;
	path: string;
	from: number;
	to: number;
}

export interface SearchRewindInput {
	searchId: string;
	retain?: SourceSelection[];
	release?: string[];
	demote?: { ref: string; note: string }[];
	nextAction: string;
}

export interface SearchMaterial {
	ref: string;
	path: string;
	tag: string;
	first: number;
	last: number;
	body: string;
	note?: string;
}

export interface SearchRewindPlan {
	anchorId: string;
	anchorIndex: number;
	materials: SearchMaterial[];
	activeRefs: string[];
	nextAction: string;
}

/** Short references are derived from persisted call identities, never model-authored offsets. */
export function searchReference(kind: "s" | "r", callId: string): string {
	return `${kind}${Bun.hash(callId).toString(36)}`;
}

function resultKind(message: ToolResultMessage): string {
	return stripXdUrlPrefix(writeDeviceDispatch(message.toolName, message)?.tool ?? message.toolName);
}

function normalizedCall(call: ToolCall): { name: string; args: Record<string, unknown> } {
	const name = stripXdUrlPrefix(call.name);
	if (name !== "write" || typeof call.arguments.path !== "string" || !call.arguments.path.startsWith("xd://"))
		return { name, args: call.arguments };
	try {
		const args: unknown = typeof call.arguments.content === "string" ? JSON.parse(call.arguments.content) : undefined;
		if (isRecord(args)) return { name: stripXdUrlPrefix(call.arguments.path), args };
	} catch {
		// An invalid device payload is not a usable context boundary.
	}
	return { name, args: call.arguments };
}

export function isSearchRewindCall(call: ToolCall): boolean {
	const normalized = normalizedCall(call);
	return normalized.name === "rewind" && typeof normalized.args.searchId === "string";
}

/** Annotate the actual delivered result before persistence; recovery needs no mutable reference registry. */
export function annotateSearchResult(message: ToolResultMessage): void {
	if (message.isError) return;
	const kind = resultKind(message);
	if (kind !== "grep" && kind !== "find" && kind !== "read") return;
	const label = kind === "read" ? "readId" : "searchId";
	const ref = searchReference(kind === "read" ? "r" : "s", message.toolCallId);
	const text = `${label}=${ref}`;
	if (message.content.some(part => part.type === "text" && part.text.endsWith(text))) return;
	message.content.push({ type: "text", text });
}

export function isSearchRewind(entry: SessionEntry): boolean {
	return entry.type === "branch_summary" && isRecord(entry.details) && entry.details.kind === SEARCH_REWIND_KIND;
}

export function activeSearchMaterialRefs(branch: readonly SessionEntry[]): Set<string> | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction" || entry.type === "reset_boundary") return undefined;
		if (entry.type !== "custom_message" || entry.customType !== SEARCH_REWIND_STATE || !isRecord(entry.details))
			continue;
		const refs = entry.details.activeRefs;
		if (Array.isArray(refs) && refs.every(ref => typeof ref === "string")) return new Set(refs);
	}
	return undefined;
}

export function keepSearchMessage(message: AgentMessage, active: ReadonlySet<string>): boolean {
	if (message.role !== "custom" || message.customType !== SEARCH_MATERIAL || !isRecord(message.details)) return true;
	return typeof message.details.ref === "string" && active.has(message.details.ref);
}

export function renderSearchMaterial(material: SearchMaterial): string {
	return prompt.render(materialTemplate, { ...material });
}

function materialFromEntry(entry: SessionEntry): SearchMaterial | undefined {
	if (entry.type !== "custom_message" || entry.customType !== SEARCH_MATERIAL || !isRecord(entry.details)) return;
	const d = entry.details;
	if (
		typeof d.ref !== "string" ||
		typeof d.path !== "string" ||
		typeof d.tag !== "string" ||
		typeof d.first !== "number" ||
		typeof d.last !== "number" ||
		typeof d.body !== "string"
	)
		return;
	return {
		ref: d.ref,
		path: d.path,
		tag: d.tag,
		first: d.first,
		last: d.last,
		body: d.body,
		note: typeof d.note === "string" ? d.note : undefined,
	};
}

/** Extract ONLY complete numbered rows from the already-delivered read, never from the current file. */
function selectMaterial(message: ToolResultMessage, selection: SourceSelection): SearchMaterial {
	const { path, from, to } = selection;
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from >= 2000) {
		throw new ToolError("Select an ordered, positive range of at most 2000 displayed lines.");
	}
	let tag: string | undefined;
	let currentPath: string | undefined;
	const rows = new Map<number, string>();
	for (const part of message.content) {
		if (part.type !== "text") continue;
		for (const line of part.text.split("\n")) {
			const header = /^\[(.+)#([0-9A-Fa-f]{4,})\]$/.exec(line);
			if (header) {
				currentPath = header[1];
				if (currentPath === path) {
					if (tag && tag !== header[2]) throw new ToolError("Selection spans different source snapshots.");
					tag = header[2];
				}
				continue;
			}
			if (currentPath !== path) continue;
			const row = /^(\d+):(.*)$/.exec(line);
			if (!row) continue;
			const n = Number(row[1]);
			if (n >= from && n <= to && !/(?:\.\.\.|…|\[col \d+\])\s*$/.test(row[2])) rows.set(n, line);
		}
	}
	if (!tag) throw new ToolError("Select an exact path from an already-seen numbered read with a snapshot tag.");
	const body: string[] = [];
	for (let n = from; n <= to; n++) {
		const row = rows.get(n);
		if (row === undefined)
			throw new ToolError(`Line ${n} was not fully displayed; unseen or truncated code cannot be retained.`);
		body.push(row);
	}
	return {
		ref: `m${Bun.hash(`${message.toolCallId}\0${path}\0${from}\0${to}`).toString(36)}`,
		path,
		tag,
		first: from,
		last: to,
		body: body.join("\n"),
	};
}

export function buildSearchRewindPlan(branch: readonly SessionEntry[], input: SearchRewindInput): SearchRewindPlan {
	const nextAction = input.nextAction.trim();
	if (!nextAction) throw new ToolError("nextAction must name the next concrete action.");
	if ((input.retain?.length ?? 0) > 32 || (input.demote?.length ?? 0) > 32 || (input.release?.length ?? 0) > 128)
		throw new ToolError("Select at most 32 ranges/demotions and 128 releases per decision.");
	const matches = branch.flatMap((entry, index) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		!entry.message.isError &&
		["grep", "find"].includes(resultKind(entry.message)) &&
		searchReference("s", entry.message.toolCallId) === input.searchId
			? [{ entry, index, message: entry.message }]
			: [],
	);
	if (matches.length !== 1)
		throw new ToolError("Search reference is missing, ambiguous, or no longer on the active branch.");
	const target = matches[0];
	let callIndex = target.index - 1;
	for (; callIndex >= 0; callIndex--) {
		const entry = branch[callIndex];
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(part => part.type === "toolCall" && part.id === target.message.toolCallId)
		)
			break;
	}
	if (callIndex <= 0) throw new ToolError("Search has no safe pre-call boundary.");
	const callEntry = branch[callIndex];
	if (callEntry.type !== "message" || callEntry.message.role !== "assistant")
		throw new ToolError("Missing search call.");
	const pureBatch = callEntry.message.content.every(
		part => part.type !== "toolCall" || ["read", "grep", "find", "glob"].includes(normalizedCall(part).name),
	);
	if (!pureBatch)
		throw new ToolError("Search shared a batch with other operations; use a standalone read-only search boundary.");
	const suffix = branch.slice(callIndex + 1);
	if (
		suffix.some(
			entry =>
				entry.type === "compaction" ||
				entry.type === "reset_boundary" ||
				entry.type === "branch_summary" ||
				(entry.type === "message" && entry.message.role === "user"),
		)
	) {
		throw new ToolError(
			"New user input or a context boundary superseded this search. Current context was not changed.",
		);
	}
	if (
		suffix.some(
			entry =>
				(entry.type === "custom_message" &&
					![SEARCH_MATERIAL, SEARCH_REWIND_STATE, SEARCH_DECISION].includes(entry.customType)) ||
				(entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some(
						part =>
							part.type === "toolCall" &&
							!["read", "grep", "find", "glob", "rewind", "todo"].includes(normalizedCall(part).name),
					)),
		)
	) {
		throw new ToolError(
			"This boundary includes non-search work or delivered context. Keep it and use a fresh search boundary.",
		);
	}
	const anchor = branch[callIndex - 1];
	const previousRefs = activeSearchMaterialRefs(branch) ?? new Set<string>();
	const active = new Set(previousRefs);
	const materials: SearchMaterial[] = [];
	for (const ref of [...(input.release ?? []), ...(input.demote ?? []).map(item => item.ref)]) {
		if (!active.delete(ref)) throw new ToolError(`Retained material ${ref} is not active.`);
	}
	for (const demotion of input.demote ?? []) {
		if (!demotion.note.trim()) throw new ToolError("A demoted material needs a concise fact or exclusion reason.");
		const old = branch.map(materialFromEntry).findLast(material => material?.ref === demotion.ref);
		if (!old) throw new ToolError("Retained source provenance is missing.");
		const material = { ...old, ref: `${old.ref}n`, note: demotion.note.trim(), body: "" };
		materials.push(material);
		active.add(material.ref);
	}
	for (const selection of input.retain ?? []) {
		const reads = branch
			.slice(callIndex + 1)
			.flatMap(entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				!entry.message.isError &&
				resultKind(entry.message) === "read" &&
				searchReference("r", entry.message.toolCallId) === selection.readId
					? [entry.message]
					: [],
			);
		if (reads.length !== 1)
			throw new ToolError("Read reference is missing, ambiguous, or outside this search decision.");
		const material = selectMaterial(reads[0], selection);
		if (!active.has(material.ref)) materials.push(material);
		active.add(material.ref);
	}
	if (active.size > 128)
		throw new ToolError("Too many retained materials; release or demote completed evidence first.");
	return { anchorId: anchor.id, anchorIndex: callIndex - 1, materials, activeRefs: [...active], nextAction };
}

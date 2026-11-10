import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { stripXdUrlPrefix } from "@oh-my-pi/pi-tui/tools/xd-url";
import materialTemplate from "../prompts/system/search-material.md" with { type: "text" };
import observationTemplate from "../prompts/system/observation-material.md" with { type: "text" };
import receiptTemplate from "../prompts/system/observation-receipt.md" with { type: "text" };
import { CHECKPOINT_ACTIVE_REMINDER_TYPE, type CustomMessage, REWIND_REPORT_MESSAGE_TYPE } from "./messages";
import { WORK_PACKAGE_STATE_TYPE } from "./work-package-state";
import { writeDeviceDispatch } from "../tools/resolve";
import type { SessionEntry } from "./session-entries";

export const SEARCH_MATERIAL = "search-material";
export const SEARCH_REWIND_STATE = "search-rewind-state";
export const SEARCH_DECISION = "search-decision";
export const SEARCH_REWIND_KIND = "search-rewind";

export const OBSERVATION_RECEIPT = "observation-receipt";
export interface SourceSelection {
	readId: string;
	path: string;
	from: number;
	to: number;
}

export interface ObservationSelection {
	observationId: string;
	text?: string;
	images?: number[];
}

export interface SearchRewindInput {
	observationId: string;
	note?: string;
	keep?: ObservationSelection[];
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
	carried: CustomMessage[];
	note?: string;
	activeRefs: string[];
	nextAction: string;
}

/** Short references are derived from persisted call identities, never model-authored offsets. */
export function searchReference(kind: "o" | "r", callId: string): string {
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
	return normalized.name === "rewind" && typeof normalized.args.observationId === "string";
}

/** Annotate the actual delivered result before persistence; recovery needs no mutable reference registry. */
export function annotateSearchResult(message: ToolResultMessage): void {
	const kind = resultKind(message);
	if (["rewind", "checkpoint", "todo"].includes(kind)) return;
	const refs = [`observationId=${searchReference("o", message.toolCallId)}`];
	if (kind === "read" && !message.isError) refs.push(`readId=${searchReference("r", message.toolCallId)}`);
	const text = refs.join("\n");
	if (message.content.some(part => part.type === "text" && part.text === text)) return;
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
	if (input.note !== undefined && !input.note.trim())
		throw new ToolError("note must contain a decision or exclusion.");
	if (
		(input.retain?.length ?? 0) > 32 ||
		(input.keep?.length ?? 0) > 32 ||
		(input.demote?.length ?? 0) > 32 ||
		(input.release?.length ?? 0) > 128
	)
		throw new ToolError("Select at most 32 ranges/observations/demotions and 128 releases per decision.");
	const matches = branch.flatMap((entry, index) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		!["rewind", "checkpoint", "todo"].includes(resultKind(entry.message)) &&
		searchReference("o", entry.message.toolCallId) === input.observationId
			? [{ index, message: entry.message }]
			: [],
	);
	if (matches.length !== 1)
		throw new ToolError("Observation reference is missing, ambiguous, or no longer on the active branch.");
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
	if (callIndex <= 0) throw new ToolError("Observation has no safe pre-call boundary.");
	const suffix = branch.slice(callIndex);
	if (
		suffix.some(
			entry =>
				entry.type === "compaction" ||
				entry.type === "reset_boundary" ||
				entry.type === "branch_summary" ||
				(entry.type === "message" &&
					(entry.message.role === "user" ||
						(entry.message.role === "custom" && entry.message.attribution === "user"))) ||
				(entry.type === "custom_message" &&
					(entry.attribution === "user" ||
						[CHECKPOINT_ACTIVE_REMINDER_TYPE, REWIND_REPORT_MESSAGE_TYPE, WORK_PACKAGE_STATE_TYPE].includes(
							entry.customType,
						))),
		)
	)
		throw new ToolError("New user input or a context/work-package boundary superseded this observation.");
	const calls = new Map<string, ToolCall>();
	const results = new Map<string, ToolResultMessage>();
	for (const entry of suffix) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (["checkpoint", "new_context"].includes(normalizedCall(part).name))
					throw new ToolError("A work-package or context transition cannot be retired as an observation.");
				if (calls.has(part.id)) throw new ToolError("Observation contains ambiguous tool-call identities.");
				calls.set(part.id, part);
			}
		} else if (message.role === "toolResult") {
			if (results.has(message.toolCallId)) throw new ToolError("Observation contains duplicate tool results.");
			results.set(message.toolCallId, message);
		} else if (message.role !== "custom") {
			throw new ToolError("Delivered context cannot be retired as a tool observation.");
		}
	}
	const pendingRewind = suffix.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
	const pendingCalls =
		pendingRewind?.type === "message" && pendingRewind.message.role === "assistant"
			? pendingRewind.message.content.filter(part => part.type === "toolCall")
			: [];
	for (const [id, call] of calls) {
		if (!results.has(id) && !(pendingCalls.length === 1 && pendingCalls[0].id === id && isSearchRewindCall(call)))
			throw new ToolError("Observation batch is incomplete; wait for every tool result before rewinding.");
	}
	for (const id of results.keys()) {
		if (!calls.has(id)) throw new ToolError("Observation contains a result from an earlier unfinished batch.");
	}
	const previousRefs = activeSearchMaterialRefs(branch) ?? new Set<string>();
	const active = new Set(previousRefs);
	const materials: SearchMaterial[] = [];
	const carried: CustomMessage[] = [];
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
		const reads = [...results.values()].filter(
			message =>
				!message.isError &&
				resultKind(message) === "read" &&
				searchReference("r", message.toolCallId) === selection.readId,
		);
		if (reads.length !== 1) throw new ToolError("Read reference is missing, ambiguous, or outside this observation.");
		const material = selectMaterial(reads[0], selection);
		if (!active.has(material.ref)) materials.push(material);
		active.add(material.ref);
	}
	for (const selection of input.keep ?? []) {
		const observations = [...results.values()].filter(
			message => searchReference("o", message.toolCallId) === selection.observationId,
		);
		if (observations.length !== 1)
			throw new ToolError("Kept observation is missing, ambiguous, or outside the retired interval.");
		const message = observations[0];
		const images = message.content.filter((part): part is ImageContent => part.type === "image");
		const text = selection.text;
		if (
			text !== undefined &&
			(!text.trim() || !message.content.some(part => part.type === "text" && part.text.includes(text)))
		)
			throw new ToolError("Keep an exact nonempty substring from one delivered text part.");
		if (
			(selection.images?.length ?? 0) > 32 ||
			selection.images?.some(index => !Number.isSafeInteger(index) || index < 0 || index >= images.length)
		)
			throw new ToolError("Select zero-based image indexes from the delivered observation.");
		if (selection.text === undefined && !selection.images?.length)
			throw new ToolError("A kept observation needs exact text or at least one image.");
		const indexes = [...new Set(selection.images ?? [])];
		const ref = `m${Bun.hash(JSON.stringify([message.toolCallId, selection.text, indexes])).toString(36)}`;
		if (!active.has(ref)) {
			const content: (TextContent | ImageContent)[] = [
				{ type: "text", text: prompt.render(observationTemplate, { ...selection, ref }) },
				...indexes.map(index => images[index]),
			];
			carried.push({
				role: "custom",
				customType: SEARCH_MATERIAL,
				content,
				details: { ref, observationId: selection.observationId },
				display: false,
				attribution: "agent",
				timestamp: message.timestamp,
			});
		}
		active.add(ref);
	}
	for (const entry of suffix) {
		if (entry.type === "custom_message") {
			if (
				entry.customType === SEARCH_REWIND_STATE ||
				(entry.customType === SEARCH_MATERIAL &&
					(!isRecord(entry.details) || typeof entry.details.ref !== "string" || !active.has(entry.details.ref)))
			)
				continue;
			carried.push({
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				details: entry.details,
				display: entry.display,
				attribution: entry.attribution,
				timestamp: Date.parse(entry.timestamp),
			});
		} else if (entry.type === "message" && entry.message.role === "custom") {
			carried.push(entry.message);
		}
	}
	for (const [id, call] of calls) {
		const normalized = normalizedCall(call);
		if (["read", "grep", "find", "glob", "rewind", "todo"].includes(normalized.name)) continue;
		const result = results.get(id);
		if (!result) continue;
		const receipt = {
			observationId: searchReference("o", id),
			toolCallId: id,
			name: call.name,
			arguments: call.arguments,
			isError: result.isError,
			details: result.details,
		};
		carried.push({
			role: "custom",
			customType: OBSERVATION_RECEIPT,
			content: prompt.render(receiptTemplate, { receipt: JSON.stringify(receipt) }),
			details: receipt,
			display: false,
			attribution: "agent",
			timestamp: result.timestamp,
		});
	}
	if (active.size > 128)
		throw new ToolError("Too many retained materials; release or demote completed evidence first.");
	return {
		anchorId: branch[callIndex - 1].id,
		anchorIndex: callIndex - 1,
		materials,
		carried,
		activeRefs: [...active],
		nextAction,
		note: input.note?.trim(),
	};
}

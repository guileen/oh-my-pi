import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { GoalModeState } from "../goals/state";
import qaCompactionActivityPrompt from "../prompts/system/qa-compaction-activity.md" with { type: "text" };
import qaCompactionCheckpointPrompt from "../prompts/system/qa-compaction-checkpoint.md" with { type: "text" };
import qaCompactionStatePrompt from "../prompts/system/qa-compaction-state.md" with { type: "text" };
import { getLatestTodoPhasesFromEntries } from "../tools/todo";
import type { AsyncJobSnapshot } from "./agent-session-types";
import type { CustomEntry, SessionEntry } from "./session-entries";
import { QA_CHECKPOINT_ENTRY_TYPE, type QaCheckpointData } from "./qa-rollover";
import { isTerminalTextAssistantAnswer } from "./queued-messages";

export interface QaCompactionDetails {
	kind: "qaonly";
	retainedEntryIds: string[];
	toolTip: string;
	state?: string;
	checkpointEntryId?: string;
}

export interface QaCompactionRuntimeState {
	plan?: { path: string; mode: "planning" | "approved" };
	goal?: GoalModeState["goal"];
	jobs?: AsyncJobSnapshot;
}

/** Resolve only journal-owned checkpoint data from the active reset boundary. */
export function resolveQaCompactionCheckpoint(
	entries: readonly SessionEntry[],
	checkpointEntryId: unknown,
): CustomEntry<QaCheckpointData> & { data: QaCheckpointData } {
	if (typeof checkpointEntryId !== "string" || !checkpointEntryId) {
		throw new Error("Invalid QA checkpoint reference");
	}
	const boundary = entries.reduce((last, entry, i) => (entry.type === "reset_boundary" ? i : last), -1);
	const index = entries.findIndex(entry => entry.id === checkpointEntryId);
	const entry = entries[index];
	if (index <= boundary || !entry || entry.type !== "custom" || entry.customType !== QA_CHECKPOINT_ENTRY_TYPE) {
		throw new Error(`QA checkpoint reference is unavailable: ${checkpointEntryId}`);
	}
	const data = entry.data;
	if (
		!isRecord(data) ||
		data.version !== 1 ||
		typeof data.cycleId !== "string" ||
		!data.cycleId.trim() ||
		typeof data.summary !== "string" ||
		!data.summary.trim() ||
		(data.disposition !== "continue" && data.disposition !== "complete" && data.disposition !== "blocked") ||
		(data.disposition === "continue"
			? typeof data.nextAction !== "string" || !data.nextAction.trim()
			: data.nextAction !== undefined)
	) {
		throw new Error(`Invalid or unsupported QA checkpoint: ${checkpointEntryId}`);
	}
	return entry as CustomEntry<QaCheckpointData> & { data: QaCheckpointData };
}

export function renderQaCompactionCheckpoint(checkpoint: QaCheckpointData): string {
	return prompt
		.render(qaCompactionCheckpointPrompt, {
			cycleId: checkpoint.cycleId,
			summary: checkpoint.summary,
			disposition: checkpoint.disposition,
			nextAction: checkpoint.nextAction,
		})
		.trim();
}

/** Recover user turns from the journal, not a previous lossy summary. */
export function prepareQaCompaction(
	entries: readonly SessionEntry[],
	runtimeState?: QaCompactionRuntimeState,
): { details: QaCompactionDetails; summary: string } {
	const boundary = entries.reduce((last, entry, i) => (entry.type === "reset_boundary" ? i : last), -1);
	const active = entries.slice(boundary + 1);
	const latestCheckpoint = active.findLast(
		entry => entry.type === "custom" && entry.customType === QA_CHECKPOINT_ENTRY_TYPE,
	);
	const checkpoint = latestCheckpoint ? resolveQaCompactionCheckpoint(active, latestCheckpoint.id) : undefined;
	const activityStart = active.reduce((last, entry, i) => (entry.type === "compaction" ? i + 1 : last), 0);
	const retainedEntryIds: string[] = [];
	const summaryParts: string[] = [];
	const text = (content: string | readonly { type: string; text?: string }[]) =>
		typeof content === "string"
			? content
			: content.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
	const reads = new Set<string>();
	const modified = new Set<string>();
	const skills = new Set<string>();
	const commands = new Set<string>();
	const results = new Map<string, boolean>();
	for (const entry of active) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			results.set(entry.message.toolCallId, !entry.message.isError);
		}
	}
	for (let index = 0; index < active.length; index++) {
		const entry = active[index];
		if (entry.type === "custom_message" && isUserRequestEntry(entry)) {
			if (
				index >= activityStart &&
				entry.customType === "skill-prompt" &&
				entry.details &&
				typeof entry.details === "object" &&
				"name" in entry.details &&
				typeof entry.details.name === "string"
			) {
				skills.add(entry.details.name);
			}
			retainedEntryIds.push(entry.id);
			summaryParts.push(`User:\n${text(entry.content)}`);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (
			message.role === "toolResult" &&
			message.toolName === "eval" &&
			index >= activityStart &&
			isRecord(message.details)
		) {
			const groups: unknown[] = [message.details.statusEvents];
			if (Array.isArray(message.details.cells)) {
				for (const cell of message.details.cells) if (isRecord(cell)) groups.push(cell.statusEvents);
			}
			for (const group of groups) {
				if (!Array.isArray(group)) continue;
				for (const event of group) {
					if (!isRecord(event)) continue;
					if (event.op === "run" && typeof event.cmd === "string") commands.add(event.cmd);
					if (event.hasError === true || event.error) continue;
					if (typeof event.path !== "string") continue;
					const skill = /^skill:\/\/([\w.-]+)/.exec(event.path);
					if (skill) skills.add(skill[1]);
					else if (!/^[\w+.-]+:\/\//.test(event.path)) {
						if (event.op === "read")
							reads.add(event.path.replace(/:(?:(?:\d[^:]*|raw|img|conflicts)(?::.*)?)$/, ""));
						if (event.op === "write" || event.op === "edit") modified.add(event.path);
					}
				}
			}
		}
		if (message.role === "user") {
			retainedEntryIds.push(entry.id);
			summaryParts.push(`User:\n${text(message.content)}`);
			continue;
		}
		if (message.role !== "assistant") continue;
		if (isTerminalTextAssistantAnswer(message)) {
			retainedEntryIds.push(entry.id);
			summaryParts.push(`Assistant:\n${text(message.content)}`);
		}
		if (index < activityStart) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !results.has(block.id)) continue;
			const args = block.arguments as Record<string, unknown>;
			if (!args || typeof args !== "object") continue;
			const name = block.name.replace(/^xd:\/\//, "");
			if (name === "bash" && typeof args.command === "string") commands.add(args.command);
			if (results.get(block.id) !== true) continue;
			const raw = JSON.stringify(args);
			for (const match of raw.matchAll(/skill:\/\/([\w.-]+)/g)) skills.add(match[1]);
			const path = typeof args.path === "string" ? args.path : undefined;
			if (path && !/^[\w+.-]+:\/\//.test(path)) {
				if (name === "read") reads.add(path.replace(/:(?:(?:\d[^:]*|raw|img|conflicts)(?::.*)?)$/, ""));
				if (name === "write" || name === "edit" || name === "ast_edit") modified.add(path);
			}
			if (name === "edit") {
				for (const value of Object.values(args)) {
					if (typeof value !== "string") continue;
					for (const match of value.matchAll(/^\[([^#\]\n]+)#[0-9A-Fa-f]{4}\]$/gm)) modified.add(match[1]);
				}
			}
		}
	}
	const sections = [
		["Files read", reads],
		["Files modified", modified],
		["Skills", skills],
		["Commands", commands],
	] as const;
	const activitySections = sections.flatMap(([label, values]) =>
		values.size ? [{ label, values: Array.from(values) }] : [],
	);
	const phases = getLatestTodoPhasesFromEntries(active);
	const todos = phases.some(phase => phase.tasks.length > 0) ? phases : undefined;
	const plan = runtimeState?.plan ? JSON.stringify(runtimeState.plan, null, 2) : undefined;
	const goal = runtimeState?.goal ? JSON.stringify(runtimeState.goal, null, 2) : undefined;
	const runningJobs = runtimeState?.jobs?.running.length
		? JSON.stringify(
				runtimeState.jobs.running.map(({ id, type, status, label, intent, command, caption }) => ({
					id,
					type,
					status,
					label,
					intent,
					command,
					caption,
				})),
				null,
				2,
			)
		: undefined;
	const pendingJobIds = runtimeState?.jobs?.delivery.pendingJobIds.length
		? JSON.stringify(runtimeState.jobs.delivery.pendingJobIds, null, 2)
		: undefined;
	const state =
		todos || plan || goal || runningJobs || pendingJobIds
			? prompt.render(qaCompactionStatePrompt, { todos, plan, goal, runningJobs, pendingJobIds }).trim()
			: undefined;
	return {
		details: {
			kind: "qaonly",
			retainedEntryIds,
			...(checkpoint ? { checkpointEntryId: checkpoint.id } : {}),
			toolTip: activitySections.length
				? prompt.render(qaCompactionActivityPrompt, { sections: activitySections }).trim()
				: "",
			...(state ? { state } : {}),
		},
		summary: summaryParts.join("\n\n"),
	};
}

/** A local fold replaces one complete interval, not the original request prefix. */
export function prepareLocalRewindCompaction(
	entries: readonly SessionEntry[],
	messages: readonly AgentMessage[],
	runtimeState?: QaCompactionRuntimeState,
): { details: Record<string, unknown> & { retainedEntryIds: string[] }; summary: string } {
	const prepared = prepareQaCompaction(entries, runtimeState);
	const checkpoint = resolveQaCompactionCheckpoint(entries, prepared.details.checkpointEntryId);
	const checkpointIndex = entries.findIndex(entry => entry.id === checkpoint.id);
	const report = entries.slice(0, checkpointIndex).findLast(entry =>
		entry.type === "message" && entry.message.role === "assistant");
	if (report?.type !== "message" || report.message.role !== "assistant") {
		throw new Error("Local rewind requires a journal-owned checkpoint reporting turn.");
	}
	const reportCalls = report.message.content.filter(block => block.type === "toolCall");
	if (reportCalls.length !== 1) throw new Error("Local rewind requires a sole checkpoint report.");
	const reportCall = reportCalls[0];
	let name = reportCall.name.replace(/^xd:\/\//, "");
	let args = reportCall.arguments;
	if (name === "write" && args.path === "xd://new_context" && typeof args.content === "string") {
		try {
			const decoded: unknown = JSON.parse(args.content);
			if (!isRecord(decoded)) throw new Error("Invalid checkpoint device arguments.");
			args = decoded;
			name = "new_context";
		} catch {
			throw new Error("Invalid checkpoint reporting call.");
		}
	}
	if (name !== "new_context" || !isRecord(args.checkpoint) || args.checkpoint.cycleId !== checkpoint.data.cycleId) {
		throw new Error("Checkpoint does not belong to the reporting call.");
	}
	const reportIndex = messages.findIndex(message => message.role === "assistant" &&
		message.content.some(block => block.type === "toolCall" && block.id === reportCall.id));
	const reportResult = messages.findIndex((message, index) => index > reportIndex &&
		message.role === "toolResult" && message.toolCallId === reportCall.id);
	if (reportIndex < 0 || reportResult < 0) throw new Error("Checkpoint reporting batch is incomplete.");
	// Validate the delivered journal lane before context reconstruction can strip
	// dangling calls. Incomplete/ambiguous batches must not become a valid fold.
	const rawEnd = entries.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult" &&
		entry.message.toolCallId === reportCall.id);
	if (rawEnd <= checkpointIndex) throw new Error("Checkpoint reporting result is unavailable.");
	const rawBoundary = entries.slice(0, checkpointIndex).findLastIndex(entry =>
		entry.type === "compaction" || entry.type === "reset_boundary");
	const rawCalls = new Set<string>();
	const rawResults = new Set<string>();
	for (const entry of entries.slice(rawBoundary + 1)) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type !== "toolCall") continue;
				if (rawCalls.has(block.id)) throw new Error("Ambiguous delivered tool batch.");
				rawCalls.add(block.id);
			}
		} else if (entry.message.role === "toolResult") {
			if (!rawCalls.has(entry.message.toolCallId) || rawResults.has(entry.message.toolCallId)) {
				throw new Error("Incomplete delivered tool batch.");
			}
			rawResults.add(entry.message.toolCallId);
		}
	}
	if (rawCalls.size !== rawResults.size) throw new Error("Incomplete delivered tool batch.");
	let latestRequest = -1;
	for (let index = 0; index < reportIndex; index++) {
		const message = messages[index];
		if (message.role === "user" || (message.role === "custom" && message.attribution === "user")) latestRequest = index;
	}
	if (latestRequest < 0) throw new Error("Local rewind has no original user request prefix.");
	const start = messages.findIndex((message, index) => index > latestRequest && message.role === "assistant");
	if (start < 0 || start >= reportIndex) throw new Error("Local rewind has no completed exploration interval.");
	const end = reportResult + 1;
	const interval = messages.slice(start, end);
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of interval) {
		if (message.role === "user" || (message.role === "custom" && message.attribution === "user")) {
			throw new Error("A user request superseded the local rewind interval.");
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (calls.has(block.id)) throw new Error("Ambiguous local rewind tool call.");
				calls.add(block.id);
			}
		} else if (message.role === "toolResult") {
			if (!calls.has(message.toolCallId) || results.has(message.toolCallId)) throw new Error("Incomplete local rewind tool group.");
			results.add(message.toolCallId);
		}
	}
	if (calls.size !== results.size) throw new Error("Incomplete local rewind tool group.");
	return {
		details: {
			...prepared.details,
			kind: "local-rewind",
			version: 1,
			// Reference the immutable source path, including earlier compaction
			// projections, rather than persisting a second full copy of its prefix.
			sourceLeafId: entries.at(-1)!.id,
			sourceMessageCount: messages.length,
			intervalStart: start,
			intervalEnd: end,
		},
		summary: checkpoint.data.summary,
	};
}

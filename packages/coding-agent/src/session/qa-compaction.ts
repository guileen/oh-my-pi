import { isUserRequestEntry } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";
import { isTerminalTextAssistantAnswer } from "./queued-messages";

export interface QaCompactionDetails {
	kind: "qaonly";
	retainedEntryIds: string[];
	toolTip: string;
}

/** Recover user turns from the journal, not a previous lossy summary. */
export function prepareQaCompaction(entries: readonly SessionEntry[]): { details: QaCompactionDetails; summary: string } {
	const boundary = entries.reduce((last, entry, i) => entry.type === "reset_boundary" ? i : last, -1);
	const active = entries.slice(boundary + 1);
	const activityStart = active.reduce((last, entry, i) => entry.type === "compaction" ? i + 1 : last, 0);
	const retainedEntryIds: string[] = [];
	const summaryParts: string[] = [];
	const text = (content: string | readonly { type: string; text?: string }[]) =>
		typeof content === "string" ? content : content.flatMap(block => block.type === "text" && block.text ? [block.text] : []).join("\n");
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
			if (index >= activityStart && entry.customType === "skill-prompt" && entry.details &&
				typeof entry.details === "object" && "name" in entry.details && typeof entry.details.name === "string") {
				skills.add(entry.details.name);
			}
			retainedEntryIds.push(entry.id);
			summaryParts.push(`User:\n${text(entry.content)}`);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && message.toolName === "eval" && index >= activityStart && isRecord(message.details)) {
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
						if (event.op === "read") reads.add(event.path.replace(/:(?:(?:\d[^:]*|raw|img|conflicts)(?::.*)?)$/, ""));
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
		["Files read", reads], ["Files modified", modified], ["Skills", skills], ["Commands", commands],
	] as const;
	const lines = sections.flatMap(([label, values]) => values.size ? [`${label}:\n${Array.from(values, value => `- ${value}`).join("\n")}`] : []);
	return {
		details: { kind: "qaonly", retainedEntryIds, toolTip: lines.length ? `Earlier tool activity (temporary reference):\n${lines.join("\n\n")}` : "" },
		summary: summaryParts.join("\n\n"),
	};
}

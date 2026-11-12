import { isRecord, stringProperty } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";

/** Hidden notice that advertises an instruction rewind point. */
export const INSTRUCTION_ANCHOR_MESSAGE_TYPE = "instruction-rewind-point";

/**
 * Hidden one-shot explanation of the instruction rewind mechanism, injected
 * before the first point. It is not tied to point validity, so later user
 * input does not drop it from the rebuilt context.
 */
export const REWIND_SKILL_MESSAGE_TYPE = "rewind-skill";

/** Branch-summary kind written when an instruction point is used. */
export const INSTRUCTION_REWIND_KIND = "instruction-rewind";

/** Hidden aside reminding the model that a point is still waiting after heavy tool work. */
export const MID_RUN_REWIND_NUDGE_MESSAGE_TYPE = "mid-run-rewind-nudge";

/**
 * Settled tool results a day may spend before the runtime asks for progress.
 * Derived from three real sessions: results between cuts p50 151–209, p90 241–279.
 * Below this the runtime stays silent: a day is not "over" just because it is long.
 */
export const DAY_STEP_BUDGET = 250;

/**
 * Unfolded results that block a QA rollover. This is a safety gate, not pacing:
 * rollover is requested by the model under context pressure, and it discards the
 * evidence the fold would keep.
 */
export const QA_FOLD_GATE_RESULTS = 12;

/** Live state for an instruction point. Not serialized; recovery reads notice entries. */
export interface InstructionAnchorState {
	id: string;
	/** In-memory message count when the notice was queued; only used for live result scans. */
	messageCount: number;
	/** Settled tool results since the notice; live counter for the mid-run fold hint. */
	toolResults: number;
	startedAt: string;
}

/** A resolvable instruction point. The notice entry itself is the cut boundary. */
export interface ResolvedInstructionAnchor {
	id: string;
	/** Session entry id of the notice; a cut keeps it and drops later work. */
	entryId: string;
}

function isUserAuthored(entry: SessionEntry): boolean {
	return (
		(entry.type === "message" &&
			(entry.message.role === "user" ||
				(entry.message.role === "custom" && entry.message.attribution === "user"))) ||
		(entry.type === "custom_message" && entry.attribution === "user")
	);
}

/**
 * Entries that make an earlier point unsafe to cut across. Fold summaries are
 * transparent: a summary can only sit on the branch at a cut point, so a cut at
 * or before the notice already removed the notice from the branch.
 */
function invalidatesPoint(entry: SessionEntry): boolean {
	if (entry.type === "compaction" || entry.type === "reset_boundary") return true;
	return isUserAuthored(entry);
}

function instructionAnchorId(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom_message" || entry.customType !== INSTRUCTION_ANCHOR_MESSAGE_TYPE) return undefined;
	const id = isRecord(entry.details) ? stringProperty(entry.details, "id") : undefined;
	return id && /^R\d+$/.test(id) ? id : undefined;
}

/**
 * Resolve every instruction point still usable on the branch.
 *
 * Points are reusable: using one keeps its notice, and a later point does not
 * invalidate earlier ones. Only a later user instruction, compaction, or reset
 * blocks an earlier point, because cutting across those would drop a user
 * instruction or rewrite the projection.
 */
export function resolveInstructionAnchors(branch: readonly SessionEntry[]): ResolvedInstructionAnchor[] {
	const found = new Map<string, { index: number; entryId: string }>();
	for (let index = 0; index < branch.length; index++) {
		const id = instructionAnchorId(branch[index]);
		if (!id) continue;
		let blocked = false;
		for (let after = index + 1; after < branch.length; after++) {
			if (invalidatesPoint(branch[after])) {
				blocked = true;
				break;
			}
		}
		if (!blocked) found.set(id, { index, entryId: branch[index].id });
	}
	return [...found.entries()]
		.sort((left, right) => left[1].index - right[1].index)
		.map(([id, resolved]) => ({ id, entryId: resolved.entryId }));
}

/** Resolve one point by id, or the newest usable point when no id is given. */
export function resolveInstructionAnchor(
	branch: readonly SessionEntry[],
	id?: string,
): ResolvedInstructionAnchor | undefined {
	const anchors = resolveInstructionAnchors(branch);
	return id ? anchors.find(anchor => anchor.id === id) : anchors.at(-1);
}

/** Restore the allocator across every journal entry, including rolled-back branches. */
export function instructionAnchorSequence(entries: readonly SessionEntry[]): number {
	let max = -1;
	for (const entry of entries) {
		const id = instructionAnchorId(entry);
		const match = id ? /^R(\d+)$/.exec(id) : null;
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max + 1;
}

import { describe, expect, it } from "bun:test";
import {
	INSTRUCTION_ANCHOR_MESSAGE_TYPE,
	instructionAnchorSequence,
	resolveInstructionAnchor,
	resolveInstructionAnchors,
} from "@oh-my-pi/pi-coding-agent/session/instruction-anchor";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomMessageEntry,
	ResetBoundaryEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";

let nextId = 0;
function user(text = "instruction"): SessionMessageEntry {
	const id = `u${nextId++}`;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: id,
		message: { role: "user", content: text, timestamp: nextId },
	};
}

function notice(anchorId: string): CustomMessageEntry {
	const id = `n${nextId++}`;
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: id,
		customType: INSTRUCTION_ANCHOR_MESSAGE_TYPE,
		content: `point ${anchorId}`,
		display: false,
		details: { id: anchorId },
		attribution: "agent",
	};
}

function boundary(): ResetBoundaryEntry {
	const id = `b${nextId++}`;
	return { type: "reset_boundary", id, parentId: null, timestamp: id };
}

function summary(kind: string): BranchSummaryEntry {
	const id = `s${nextId++}`;
	return {
		type: "branch_summary",
		id,
		parentId: null,
		timestamp: id,
		fromId: "",
		summary: "",
		details: { kind },
	};
}

describe("instruction anchor resolution", () => {
	it("keeps every point reusable and resolves one by id", () => {
		const first = user();
		const root = notice("R0");
		const branch: SessionEntry[] = [first, root, summary("instruction-rewind"), notice("R1")];
		expect(resolveInstructionAnchors(branch)).toEqual([
			{ id: "R0", entryId: root.id },
			{ id: "R1", entryId: branch[3]!.id },
		]);
		expect(resolveInstructionAnchor(branch, "R0")).toEqual({ id: "R0", entryId: root.id });
		expect(resolveInstructionAnchor(branch)).toEqual({ id: "R1", entryId: branch[3]!.id });
	});

	it("invalidates earlier points across a user instruction or reset", () => {
		const first = user();
		expect(resolveInstructionAnchors([first, notice("R0"), user()])).toEqual([]);
		expect(resolveInstructionAnchors([first, notice("R0"), boundary()])).toEqual([]);
	});

	it("keeps a point usable when a fold summary lands after it", () => {
		const first = user();
		const root = notice("R0");
		// Both observation and work-package folds append their summary at the cut,
		// so a summary on the branch never straddles a surviving notice.
		for (const kind of ["search-rewind", "work-package-rewind"]) {
			expect(resolveInstructionAnchors([first, root, summary(kind)])).toEqual([{ id: "R0", entryId: root.id }]);
		}
	});

	it("restores the allocator after a journal that already used point ids", () => {
		expect(instructionAnchorSequence([user(), notice("R0"), user(), notice("R7")])).toBe(8);
		expect(instructionAnchorSequence([user()])).toBe(0);
	});

	it("drops a notice whose point died at a later compaction from every projection", () => {
		nextId = 0;
		const instruction = user("fix a");
		const stale = notice("R0");
		stale.parentId = instruction.id;
		const compact: CompactionEntry = {
			type: "compaction",
			id: "c0",
			parentId: stale.id,
			timestamp: "c0",
			summary: "folded",
			firstKeptEntryId: instruction.id,
			tokensBefore: 1000,
		};
		const fresh = notice("R1");
		fresh.parentId = compact.id;
		const branch: SessionEntry[] = [instruction, stale, compact, fresh];

		const model = JSON.stringify(buildSessionContext(branch, fresh.id).messages);
		expect(model).toContain("point R1");
		expect(model).not.toContain("point R0");

		const transcript = JSON.stringify(
			buildSessionContext(branch, fresh.id, undefined, { transcript: true }).messages,
		);
		expect(transcript).toContain("point R1");
		expect(transcript).not.toContain("point R0");
	});
});

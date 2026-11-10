import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import { GraphHumanError, type GraphHumanEvidence, type GraphHumanEvidenceScope } from "./human";
import { readScreenwritingApprovalEvidence, type ScreenwritingApprovalProposal } from "./screenwriting-approval";

/** A scope is UTF-8 JSON: {"version":1,"ranges":[{"start":0,"end":1,"max_replacement_bytes":10}]}.
 * Offsets are bytes in the approved subject, end exclusive. Ranges must be ordered and disjoint.
 * This deliberately supports only literal byte-range replacement, not semantic screenplay constraints. */
export interface ScreenwritingRevisionPatch {
	/** Index into the approved scope's ranges. Each index may occur at most once. */
	range: number;
	replacement: Uint8Array;
}

const MAX_SUBJECT_BYTES = 8 * 1024 * 1024;
const MAX_SCOPE_BYTES = 64 * 1024;
const MAX_RANGES = 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

type Range = { start: number; end: number; max_replacement_bytes: number };

function invalid(message: string): never {
	throw new GraphHumanError("invalid", message);
}

function digest(bytes: Uint8Array): string {
	return `sha256:${Bun.SHA256.hash(bytes, "hex")}`;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every(key => Object.hasOwn(value, key))
	);
}

function readScope(bytes: Uint8Array, subjectLength: number): Range[] {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return invalid("Invalid revision scope encoding");
	}
	if (
		!exactKeys(value, ["version", "ranges"]) ||
		value.version !== 1 ||
		!Array.isArray(value.ranges) ||
		value.ranges.length === 0 ||
		value.ranges.length > MAX_RANGES
	)
		return invalid("Invalid revision scope");
	const ranges: Range[] = [];
	let previousEnd = 0;
	for (const item of value.ranges) {
		if (
			!exactKeys(item, ["start", "end", "max_replacement_bytes"]) ||
			!Number.isSafeInteger(item.start) ||
			!Number.isSafeInteger(item.end) ||
			!Number.isSafeInteger(item.max_replacement_bytes)
		)
			return invalid("Invalid revision scope range");
		const start = item.start as number;
		const end = item.end as number;
		const max = item.max_replacement_bytes as number;
		// Empty ranges are excluded to avoid ambiguous insertions at range boundaries.
		if (start < previousEnd || end <= start || end > subjectLength || max < 0 || max > MAX_OUTPUT_BYTES)
			return invalid("Invalid revision scope range bounds");
		ranges.push({ start, end, max_replacement_bytes: max });
		previousEnd = end;
	}
	return ranges;
}

/** Construct a candidate from approved bytes and bounded replacements only. This reads historical
 * evidence but is NOT an authorization, dispatch grant, or publication decision. The host must
 * atomically check current authority, revocation and applicability, and enforce this candidate as
 * the actual output before dispatch/publication. Until integrated with those checks, retain HOLD.
 * All inputs and the ledger adapter must be supplied by trusted host code. */
export function buildScreenwritingRevisionCandidate(
	store: {
		getHumanEvidence(principal: string, reference: GraphRef, scope: GraphHumanEvidenceScope): GraphHumanEvidence;
	},
	reader: string,
	evidenceRef: GraphRef,
	proposal: ScreenwritingApprovalProposal,
	subject: Uint8Array,
	scope: Uint8Array,
	patches: readonly ScreenwritingRevisionPatch[],
): Uint8Array {
	if (
		!(subject instanceof Uint8Array) ||
		subject.byteLength > MAX_SUBJECT_BYTES ||
		!(scope instanceof Uint8Array) ||
		scope.byteLength > MAX_SCOPE_BYTES ||
		!Array.isArray(patches)
	)
		return invalid("Invalid revision inputs");
	// Snapshot before hashing so even a shared backing buffer cannot change verified bytes later.
	subject = Uint8Array.from(subject);
	scope = Uint8Array.from(scope);
	proposal = structuredClone(proposal);
	patches = patches.map(patch => {
		if (!patch || !(patch.replacement instanceof Uint8Array)) return invalid("Invalid revision patch");
		return { range: patch.range, replacement: Uint8Array.from(patch.replacement) };
	});
	readScreenwritingApprovalEvidence(store, reader, evidenceRef, proposal);
	if (digest(subject) !== proposal.subject.digest || digest(scope) !== proposal.change_scope.digest)
		throw new GraphHumanError("input_stale", "Revision bytes do not match the approved proposal");
	const ranges = readScope(scope, subject.byteLength);
	if (patches.length > ranges.length) return invalid("Too many revision patches");
	let length = subject.byteLength;
	let previous = -1;
	for (const patch of patches) {
		if (
			!patch ||
			!Number.isSafeInteger(patch.range) ||
			patch.range <= previous ||
			patch.range >= ranges.length ||
			!(patch.replacement instanceof Uint8Array)
		)
			return invalid("Invalid revision patch");
		const range = ranges[patch.range];
		if (patch.replacement.byteLength > range.max_replacement_bytes)
			return invalid("Revision replacement exceeds scope");
		length += patch.replacement.byteLength - (range.end - range.start);
		if (length > MAX_OUTPUT_BYTES) return invalid("Revision output exceeds limit");
		previous = patch.range;
	}
	const output = new Uint8Array(length);
	let sourceOffset = 0;
	let outputOffset = 0;
	for (const patch of patches) {
		const range = ranges[patch.range];
		const unchanged = subject.subarray(sourceOffset, range.start);
		output.set(unchanged, outputOffset);
		outputOffset += unchanged.byteLength;
		output.set(patch.replacement, outputOffset);
		outputOffset += patch.replacement.byteLength;
		sourceOffset = range.end;
	}
	output.set(subject.subarray(sourceOffset), outputOffset);
	return output;
}

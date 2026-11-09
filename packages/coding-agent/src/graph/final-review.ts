import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";

/** The host supplies this from the current, frozen invocation and an authoritative blocker inventory. */
export interface FinalReviewAuthority {
	invocation_id: string;
	input_digest: string;
	artifacts: Record<string, GraphRef>;
	blocker_ids: string[];
	inventory_evidence: GraphRef;
}

export interface FinalReviewSubmission {
	invocation_id: string;
	input_digest: string;
	artifacts: Record<string, GraphRef>;
	blockers: { id: string; disposition: "cleared" | "refuted"; evidence: GraphRef }[];
	/** Explicitly present, including when there are no remaining preferences. */
	preferences: { id: string; classification: "nonblocking"; evidence: GraphRef }[];
}

export type FinalReviewClaim =
	| { kind: "inventory"; blocker_ids: string[]; evidence: GraphRef }
	| { kind: "blocker"; id: string; disposition: "cleared" | "refuted"; evidence: GraphRef }
	| { kind: "preference"; id: string; classification: "nonblocking"; evidence: GraphRef };

export type FinalReviewResult = { allowed: true } | { allowed: false; reason: string };

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function copyRef(value: unknown): GraphRef | null {
	if (!isRecord(value) || !nonempty(value.id) || !nonempty(value.digest)) return null;
	return { id: value.id, digest: value.digest };
}
function copyArtifacts(value: unknown): Record<string, GraphRef> | null {
	if (!isRecord(value) || Object.keys(value).length === 0) return null;
	const result: Record<string, GraphRef> = Object.create(null);
	for (const [key, ref] of Object.entries(value)) {
		const copy = copyRef(ref);
		if (!nonempty(key) || !copy) return null;
		result[key] = copy;
	}
	return result;
}
function sameArtifacts(a: Record<string, GraphRef>, b: Record<string, GraphRef>): boolean {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every(key => Object.hasOwn(b, key) && a[key].id === b[key].id && a[key].digest === b[key].digest)
	);
}

/**
 * Verify a proposed GO; this function never grants authority by itself. The synchronous trusted
 * verifier must authenticate and read each evidence ref, establish the claim (including that the
 * inventory is complete), and bind it to the supplied invocation, input and artifact versions.
 * It must return literal true; missing, unavailable, stale, unauthorized or invalid evidence fails.
 * The caller must fence the current invocation and frozen inputs and apply the result atomically.
 */
export function verifyFinalReview(
	authority: FinalReviewAuthority,
	submission: unknown,
	verifyEvidence: (
		claim: FinalReviewClaim,
		binding: Readonly<Pick<FinalReviewAuthority, "invocation_id" | "input_digest" | "artifacts">>,
	) => boolean,
): FinalReviewResult {
	const denied = (reason: string): FinalReviewResult => ({ allowed: false, reason });
	if (!isRecord(authority) || !nonempty(authority.invocation_id) || !nonempty(authority.input_digest))
		return denied("Invalid authority binding");
	const invocationId = authority.invocation_id;
	const inputDigest = authority.input_digest;
	const artifacts = copyArtifacts(authority.artifacts);
	const inventory = copyRef(authority.inventory_evidence);
	if (
		!artifacts ||
		!inventory ||
		!Array.isArray(authority.blocker_ids) ||
		!authority.blocker_ids.every(nonempty) ||
		new Set(authority.blocker_ids).size !== authority.blocker_ids.length
	)
		return denied("Invalid blocker inventory or artifact binding");
	const blockerIds = [...authority.blocker_ids];
	if (!isRecord(submission) || submission.invocation_id !== invocationId || submission.input_digest !== inputDigest)
		return denied("Review binding is missing or stale");
	const submittedArtifacts = copyArtifacts(submission.artifacts);
	if (!submittedArtifacts || !sameArtifacts(artifacts, submittedArtifacts))
		return denied("Review artifact versions are missing or stale");
	if (!Array.isArray(submission.blockers) || !Array.isArray(submission.preferences))
		return denied("Review findings are missing");
	const claims: FinalReviewClaim[] = [{ kind: "inventory", blocker_ids: blockerIds, evidence: inventory }];
	const remaining = new Set(blockerIds);
	const seen = new Set<string>();
	for (const item of submission.blockers) {
		if (
			!isRecord(item) ||
			!nonempty(item.id) ||
			!remaining.has(item.id) ||
			(item.disposition !== "cleared" && item.disposition !== "refuted")
		)
			return denied("Blocker is missing, duplicated, unknown or unresolved");
		const evidence = copyRef(item.evidence);
		if (!evidence) return denied("Blocker evidence is missing or invalid");
		remaining.delete(item.id);
		seen.add(item.id);
		claims.push({ kind: "blocker", id: item.id, disposition: item.disposition, evidence });
	}
	if (remaining.size) return denied("Blocker evidence is incomplete");
	for (const item of submission.preferences) {
		if (!isRecord(item) || !nonempty(item.id) || seen.has(item.id) || item.classification !== "nonblocking")
			return denied("Preference is duplicated or not explicitly nonblocking");
		const evidence = copyRef(item.evidence);
		if (!evidence) return denied("Preference evidence is missing or invalid");
		seen.add(item.id);
		claims.push({ kind: "preference", id: item.id, classification: "nonblocking", evidence });
	}
	try {
		for (const claim of claims) {
			// Isolate claims and binding from mutation by a verifier between calls.
			const binding = {
				invocation_id: invocationId,
				input_digest: inputDigest,
				artifacts: structuredClone(artifacts),
			};
			if (verifyEvidence(structuredClone(claim), binding) !== true) return denied("Evidence could not be verified");
		}
	} catch {
		return denied("Evidence could not be verified");
	}
	return { allowed: true };
}

import { describe, expect, it } from "bun:test";
import {
	verifyFinalReview,
	type FinalReviewAuthority,
	type FinalReviewClaim,
	type FinalReviewSubmission,
} from "../src/graph/final-review";

const ref = (id: string) => ({ id, digest: `sha256:${id}` });
function fixture(): { authority: FinalReviewAuthority; review: FinalReviewSubmission } {
	return {
		authority: {
			invocation_id: "final-1",
			input_digest: "sha256:inputs",
			artifacts: { spec: ref("spec-v2"), review: ref("review-v3") },
			blocker_ids: ["security", "correctness"],
			inventory_evidence: ref("inventory"),
		},
		review: {
			invocation_id: "final-1",
			input_digest: "sha256:inputs",
			artifacts: { spec: ref("spec-v2"), review: ref("review-v3") },
			blockers: [
				{ id: "security", disposition: "cleared", evidence: ref("security-proof") },
				{ id: "correctness", disposition: "refuted", evidence: ref("correctness-proof") },
			],
			preferences: [{ id: "style", classification: "nonblocking", evidence: ref("style-proof") }],
		},
	};
}

describe("trusted final review evidence", () => {
	it("allows only fully evidenced findings on the exact frozen binding", () => {
		const { authority, review } = fixture();
		const claims: FinalReviewClaim[] = [];
		const result = verifyFinalReview(authority, review, (claim, binding) => {
			expect(binding).toEqual({
				invocation_id: authority.invocation_id,
				input_digest: authority.input_digest,
				artifacts: authority.artifacts,
			});
			claims.push(claim);
			return true;
		});
		expect(result).toEqual({ allowed: true });
		expect(claims.map(claim => claim.kind)).toEqual(["inventory", "blocker", "blocker", "preference"]);
	});

	it("requires a verified complete inventory even when there are no blockers or preferences", () => {
		const { authority, review } = fixture();
		authority.blocker_ids = [];
		review.blockers = [];
		review.preferences = [];
		expect(verifyFinalReview(authority, review, () => false).allowed).toBe(false);
		expect(verifyFinalReview(authority, review, claim => claim.kind === "inventory").allowed).toBe(true);
	});

	it("rejects omitted, duplicated, unknown and unresolved blockers", () => {
		for (const blockers of [
			[],
			[{ id: "security", disposition: "cleared", evidence: ref("proof") }],
			[
				{ id: "security", disposition: "cleared", evidence: ref("proof") },
				{ id: "security", disposition: "cleared", evidence: ref("proof") },
			],
			[
				{ id: "security", disposition: "cleared", evidence: ref("proof") },
				{ id: "other", disposition: "refuted", evidence: ref("proof") },
			],
			[
				{ id: "security", disposition: "open", evidence: ref("proof") },
				{ id: "correctness", disposition: "refuted", evidence: ref("proof") },
			],
		]) {
			const { authority, review } = fixture();
			expect(verifyFinalReview(authority, { ...review, blockers }, () => true).allowed).toBe(false);
		}
	});

	it("rejects stale invocation, inputs and any missing, changed or added artifact", () => {
		const { authority, review } = fixture();
		for (const change of [
			{ invocation_id: "final-0" },
			{ input_digest: "sha256:old" },
			{ artifacts: { spec: ref("spec-v1"), review: ref("review-v3") } },
			{ artifacts: { spec: ref("spec-v2") } },
			{ artifacts: { ...review.artifacts, extra: ref("extra") } },
		])
			expect(verifyFinalReview(authority, { ...review, ...change }, () => true).allowed).toBe(false);
	});

	it("requires explicit nonblocking preferences and valid evidence for all claims", () => {
		const { authority, review } = fixture();
		for (const change of [
			{ preferences: undefined },
			{ preferences: [{ id: "style", evidence: ref("proof") }] },
			{ preferences: [{ id: "style", classification: "blocking", evidence: ref("proof") }] },
			{ preferences: [{ id: "style", classification: "nonblocking" }] },
			{ blockers: [{ ...review.blockers[0], evidence: { id: "bad", digest: "" } }, review.blockers[1]] },
		])
			expect(verifyFinalReview(authority, { ...review, ...change }, () => true).allowed).toBe(false);
	});

	it("fails closed when any trusted evidence check fails, throws or returns a non-boolean", () => {
		const { authority, review } = fixture();
		for (const kind of ["inventory", "blocker", "preference"]) {
			expect(verifyFinalReview(authority, review, claim => claim.kind !== kind).allowed).toBe(false);
		}
		expect(
			verifyFinalReview(authority, review, () => {
				throw new Error("unavailable");
			}).allowed,
		).toBe(false);
		expect(
			verifyFinalReview(authority, review, (() => Promise.resolve(true)) as unknown as () => boolean).allowed,
		).toBe(false);
	});
});

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { GraphHumanDecisions } from "../src/graph/human";
import {
	screenwritingApprovalQuestionRef,
	type ScreenwritingApprovalProposal,
} from "../src/graph/screenwriting-approval";
import {
	buildScreenwritingRevisionCandidate,
	type ScreenwritingRevisionPatch,
} from "../src/graph/screenwriting-revision-scope";

const encode = (value: string) => new TextEncoder().encode(value);
const ref = (id: string, bytes: Uint8Array) => ({ id, digest: `sha256:${Bun.SHA256.hash(bytes, "hex")}` });
const subject = encode("A café B scene C");
const scopeObject = {
	version: 1,
	ranges: [
		{ start: 2, end: 7, max_replacement_bytes: 8 },
		{ start: 10, end: 15, max_replacement_bytes: 5 },
	],
};

function fixture(scopeBytes = encode(JSON.stringify(scopeObject)), outcome = "approve", verdict = "APPROVE") {
	const db = new Database(":memory:");
	const ledger = new GraphHumanDecisions({
		database: db,
		authorize: (action, principal) => action !== "read" || principal === "reader",
		fence: () => true,
	});
	const proposal: ScreenwritingApprovalProposal = {
		decision_id: "decision",
		run_id: "run",
		invocation_id: "invocation",
		input_digest: "input",
		source_revision: "revision",
		subject: ref("draft", subject),
		change_scope: ref("scope", scopeBytes),
		principal: "alice",
		author_ref: { id: "alice", digest: "identity" },
	};
	ledger.create("creator", {
		id: proposal.decision_id,
		run_id: proposal.run_id,
		invocation_id: proposal.invocation_id,
		input_digest: proposal.input_digest,
		source_revision: proposal.source_revision,
		question_ref: screenwritingApprovalQuestionRef(proposal),
		outcomes: ["approve", "reject"],
		verdicts: ["APPROVE", "REJECT"],
		decisions: null,
	});
	const evidence = ledger.answer({
		request_key: "answer",
		principal: proposal.principal,
		run_id: proposal.run_id,
		invocation_id: proposal.invocation_id,
		decision_id: proposal.decision_id,
		input_digest: proposal.input_digest,
		if_revision: "1",
		outcome,
		verdict,
		content_ref: { id: "answer", digest: "answer" },
		evidence_refs: [],
		reason: "answer",
		author_ref: proposal.author_ref,
	}).evidence_ref!;
	const store = { getHumanEvidence: ledger.getEvidence.bind(ledger) };
	const build = (patches: ScreenwritingRevisionPatch[], draft = subject, scope = scopeBytes) =>
		buildScreenwritingRevisionCandidate(store, "reader", evidence, proposal, draft, scope, patches);
	return { db, build, store, proposal, evidence, scopeBytes };
}

describe("screenwriting bounded revision candidate", () => {
	it("replaces only selected approved byte ranges and preserves everything else", () => {
		const f = fixture();
		try {
			const result = f.build([
				{ range: 0, replacement: encode("tea") },
				{ range: 1, replacement: encode("act") },
			]);
			expect(new TextDecoder().decode(result)).toBe("A tea B act C");
			expect(new TextDecoder().decode(f.build([{ range: 1, replacement: encode("") }]))).toBe("A café B  C");
			expect(f.build([])).toEqual(subject);
		} finally {
			f.db.close();
		}
	});

	it("snapshots the proposal and bounded patch bytes before consulting ledger policy", () => {
		const f = fixture();
		try {
			const draft = Uint8Array.from(subject);
			const scope = Uint8Array.from(f.scopeBytes);
			const replacement = encode("tea");
			const proposal = structuredClone(f.proposal);
			const store = {
				getHumanEvidence: (...args: Parameters<typeof f.store.getHumanEvidence>) => {
					const evidence = f.store.getHumanEvidence(...args);
					draft.fill(0);
					scope.fill(0);
					replacement.fill(0);
					proposal.subject.digest = `sha256:${"0".repeat(64)}`;
					return evidence;
				},
			};
			const result = buildScreenwritingRevisionCandidate(store, "reader", f.evidence, proposal, draft, scope, [
				{ range: 0, replacement },
			]);
			expect(new TextDecoder().decode(result)).toBe("A tea B scene C");
		} finally {
			f.db.close();
		}
	});

	it("rejects changed bytes, wrong evidence, unauthorized readers, and rejected answers", () => {
		const f = fixture();
		try {
			expect(() => f.build([], encode("other"))).toThrow();
			expect(() => f.build([], subject, encode("{}"))).toThrow();
			expect(() =>
				buildScreenwritingRevisionCandidate(f.store, "other", f.evidence, f.proposal, subject, f.scopeBytes, []),
			).toThrow();
			expect(() =>
				buildScreenwritingRevisionCandidate(
					f.store,
					"reader",
					{ ...f.evidence, digest: "wrong" },
					f.proposal,
					subject,
					f.scopeBytes,
					[],
				),
			).toThrow();
			expect(() =>
				buildScreenwritingRevisionCandidate(
					f.store,
					"reader",
					f.evidence,
					{ ...f.proposal, source_revision: "new" },
					subject,
					f.scopeBytes,
					[],
				),
			).toThrow();
		} finally {
			f.db.close();
		}
		const rejected = fixture(undefined, "reject", "REJECT");
		try {
			expect(() => rejected.build([])).toThrow();
		} finally {
			rejected.db.close();
		}
	});

	it("rejects out-of-scope, duplicate, unordered and oversized patches", () => {
		const f = fixture();
		try {
			for (const patches of [
				[{ range: -1, replacement: encode("x") }],
				[{ range: 2, replacement: encode("x") }],
				[{ range: 0, replacement: encode("123456789") }],
				[
					{ range: 0, replacement: encode("x") },
					{ range: 0, replacement: encode("y") },
				],
				[
					{ range: 1, replacement: encode("x") },
					{ range: 0, replacement: encode("y") },
				],
			])
				expect(() => f.build(patches)).toThrow();
		} finally {
			f.db.close();
		}
	});

	it("rejects malformed, ambiguous, overlapping and unbounded scope documents even if approved", () => {
		for (const scope of [
			"not json",
			"{}",
			JSON.stringify({ ...scopeObject, extra: true }),
			JSON.stringify({ version: 2, ranges: scopeObject.ranges }),
			JSON.stringify({ version: 1, ranges: [] }),
			JSON.stringify({ version: 1, ranges: [{ start: 0, end: 0, max_replacement_bytes: 1 }] }),
			JSON.stringify({ version: 1, ranges: [{ start: 0, end: 100, max_replacement_bytes: 1 }] }),
			JSON.stringify({
				version: 1,
				ranges: [
					{ start: 0, end: 5, max_replacement_bytes: 1 },
					{ start: 4, end: 6, max_replacement_bytes: 1 },
				],
			}),
			JSON.stringify({ version: 1, ranges: [{ start: 0, end: 1, max_replacement_bytes: -1 }] }),
		]) {
			const f = fixture(encode(scope));
			try {
				expect(() => f.build([])).toThrow();
			} finally {
				f.db.close();
			}
		}
	});
});

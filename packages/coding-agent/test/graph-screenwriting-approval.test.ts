import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { GraphHumanDecisions, type GraphHumanAnswer, type GraphHumanQuestion } from "../src/graph/human";
import {
	readScreenwritingApprovalEvidence,
	screenwritingApprovalQuestionRef,
	type ScreenwritingApprovalProposal,
} from "../src/graph/screenwriting-approval";

const proposal: ScreenwritingApprovalProposal = {
	decision_id: "decision",
	run_id: "run",
	invocation_id: "invocation",
	input_digest: "input",
	source_revision: "revision",
	subject: { id: "draft", digest: `sha256:${"a".repeat(64)}` },
	change_scope: { id: "scope", digest: `sha256:${"b".repeat(64)}` },
	principal: "alice",
	author_ref: { id: "alice", digest: "identity" },
};

function fixture(
	options: {
		questionRef?: GraphHumanQuestion["question_ref"];
		outcome?: string;
		verdict?: string;
		principal?: string;
	} = {},
) {
	const db = new Database(":memory:");
	const ledger = new GraphHumanDecisions({
		database: db,
		authorize: (action, principal) => action !== "read" || principal === "reader",
		fence: () => true,
	});
	const question: GraphHumanQuestion = {
		id: proposal.decision_id,
		run_id: proposal.run_id,
		invocation_id: proposal.invocation_id,
		input_digest: proposal.input_digest,
		source_revision: proposal.source_revision,
		question_ref: options.questionRef ?? screenwritingApprovalQuestionRef(proposal),
		outcomes: ["approve", "reject"],
		verdicts: ["APPROVE", "REJECT"],
		decisions: null,
	};
	const answer: GraphHumanAnswer = {
		request_key: "answer",
		principal: options.principal ?? proposal.principal,
		run_id: proposal.run_id,
		invocation_id: proposal.invocation_id,
		decision_id: proposal.decision_id,
		input_digest: proposal.input_digest,
		if_revision: "1",
		outcome: options.outcome ?? "approve",
		verdict: options.verdict ?? "APPROVE",
		content_ref: { id: "approval prose", digest: "text" },
		evidence_refs: [],
		reason: "approved",
		author_ref: proposal.author_ref,
	};
	ledger.create("creator", question);
	const evidence = ledger.answer(answer).evidence_ref!;
	const store = { getHumanEvidence: ledger.getEvidence.bind(ledger) };
	return { db, store, evidence };
}

describe("screenwriting approval evidence", () => {
	it("accepts only an authenticated ledger answer bound to the exact proposal", () => {
		const f = fixture();
		try {
			expect(readScreenwritingApprovalEvidence(f.store, "reader", f.evidence, proposal)).toMatchObject({
				principal: "alice",
				answer: { outcome: "approve", verdict: "APPROVE" },
			});
			const changes: Partial<ScreenwritingApprovalProposal>[] = [
				{ decision_id: "other" },
				{ run_id: "other" },
				{ invocation_id: "other" },
				{ input_digest: "other" },
				{ source_revision: "other" },
				{ subject: { ...proposal.subject, id: "other" } },
				{ subject: { ...proposal.subject, digest: `sha256:${"c".repeat(64)}` } },
				{ change_scope: { ...proposal.change_scope, id: "other" } },
				{ change_scope: { ...proposal.change_scope, digest: `sha256:${"c".repeat(64)}` } },
				{ principal: "bob" },
				{ author_ref: { ...proposal.author_ref, id: "bob" } },
				{ author_ref: { ...proposal.author_ref, digest: "other" } },
			];
			for (const change of changes)
				expect(() =>
					readScreenwritingApprovalEvidence(f.store, "reader", f.evidence, { ...proposal, ...change }),
				).toThrow();
			expect(() => readScreenwritingApprovalEvidence(f.store, "other", f.evidence, proposal)).toThrow();
			expect(() =>
				readScreenwritingApprovalEvidence(f.store, "reader", { ...f.evidence, digest: "wrong" }, proposal),
			).toThrow();
		} finally {
			f.db.close();
		}
	});

	it("rejects text, rejection, non-approval verdict, and a different answering principal", () => {
		for (const options of [
			{ questionRef: { id: "text saying approved", digest: "text" } },
			{ outcome: "reject" },
			{ verdict: "REJECT" },
			{ principal: "bob" },
		]) {
			const f = fixture(options);
			try {
				expect(() => readScreenwritingApprovalEvidence(f.store, "reader", f.evidence, proposal)).toThrow();
			} finally {
				f.db.close();
			}
		}
	});

	it("requires an exact content-addressed subject and scope and a nonempty source revision", () => {
		for (const change of [
			{ subject: { id: "draft", digest: "unverified" } },
			{ change_scope: { id: "scope", digest: "" } },
			{ source_revision: "" },
		])
			expect(() => screenwritingApprovalQuestionRef({ ...proposal, ...change })).toThrow();
	});
});

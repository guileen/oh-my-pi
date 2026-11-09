import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { GraphHumanDecisions, type GraphHumanAnswer, type GraphHumanQuestion } from "../src/graph/human";

const question: GraphHumanQuestion = {
	id: "decision-1",
	run_id: "run-1",
	invocation_id: "invocation-1",
	input_digest: "sha256:input",
	source_revision: "source-1",
	question_ref: { id: "question", digest: "sha256:question" },
	outcomes: ["proceed", "revise"],
	verdicts: ["conditional", "reject"],
	decisions: [
		{ verdict: "conditional", outcome: "revise" },
		{ verdict: "reject", outcome: "revise" },
	],
};
const answer: GraphHumanAnswer = {
	request_key: "answer-1",
	principal: "alice",
	run_id: "run-1",
	invocation_id: "invocation-1",
	decision_id: "decision-1",
	input_digest: "sha256:input",
	if_revision: "9",
	outcome: "revise",
	verdict: "conditional",
	content_ref: { id: "explanation", digest: "sha256:text" },
	evidence_refs: [{ id: "evidence", digest: "sha256:evidence" }],
	reason: "needs evidence",
	author_ref: { id: "alice", digest: "sha256:identity" },
};

function expectError(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		expect(error).toMatchObject({ code });
		return;
	}
	throw new Error(`Expected ${code}`);
}

function fixture() {
	const db = new Database(":memory:");
	let revision = "9";
	let digest = question.input_digest;
	let source = question.source_revision;
	let allowed = true;
	const ledger = new GraphHumanDecisions({
		database: db,
		authorize: (_action, principal, _decision, submitted) =>
			allowed && principal === "alice" && (!submitted || submitted.author_ref.id === principal),
		fence: (_action, decision, submitted) => {
			if (decision.input_digest !== digest || decision.source_revision !== source) return "input_stale";
			if (submitted && submitted.if_revision !== revision) return "revision_conflict";
			return true;
		},
	});
	return {
		db,
		ledger,
		setRevision: (value: string) => {
			revision = value;
		},
		setDigest: (value: string) => {
			digest = value;
		},
		setSource: (value: string) => {
			source = value;
		},
		setAllowed: (value: boolean) => {
			allowed = value;
		},
	};
}

describe("Graph human decisions", () => {
	it("persists a version-bound decision and replays only the exact authorized request", () => {
		const f = fixture();
		try {
			const pending = f.ledger.create("alice", question);
			expect(pending.answer).toBeNull();
			expect(f.ledger.create("alice", question)).toEqual(pending);
			const result = f.ledger.answer(answer);
			expect(result).toMatchObject({
				revision: "2",
				run_id: "run-1",
				invocation_id: "invocation-1",
				input_digest: "sha256:input",
				answer: {
					verdict: "conditional",
					outcome: "revise",
					content_ref: answer.content_ref,
					evidence_refs: answer.evidence_refs,
					author_ref: answer.author_ref,
				},
			});
			f.setRevision("10");
			f.setDigest("new-input");
			expect(f.ledger.answer(answer)).toEqual(result);
			expect(f.ledger.get("alice", question.id)).toEqual(result);
			expectError(() => f.ledger.answer({ ...answer, reason: "different" }), "idempotency_conflict");
			f.setAllowed(false);
			expectError(() => f.ledger.answer(answer), "permission_denied");
		} finally {
			f.db.close();
		}
	});

	it("records answer evidence atomically and checks its exact scope and read authorization", () => {
		const f = fixture();
		try {
			f.ledger.create("alice", question);
			expect(() =>
				f.db.transaction(() => {
					f.ledger.answer(answer);
					throw new Error("rollback");
				})(),
			).toThrow("rollback");
			expect(f.db.query("SELECT count(*) AS count FROM graph_human_evidence").get()).toEqual({ count: 0 });
			const result = f.ledger.answer(answer);
			const evidenceRef = result.evidence_ref!;
			const scope = {
				decision_id: question.id,
				run_id: question.run_id,
				invocation_id: question.invocation_id,
				input_digest: question.input_digest,
				source_revision: question.source_revision,
				outcome: answer.outcome,
				author_ref: answer.author_ref,
			};
			const evidence = f.ledger.getEvidence("alice", evidenceRef, scope);
			expect(evidence).toMatchObject({
				decision_id: question.id,
				question_ref: question.question_ref,
				principal: "alice",
				answer: { outcome: answer.outcome, verdict: answer.verdict, author_ref: answer.author_ref },
			});
			expect(f.ledger.answer(answer).evidence_ref).toEqual(evidenceRef);
			for (const changed of [
				{ decision_id: "other" },
				{ run_id: "other" },
				{ invocation_id: "other" },
				{ input_digest: "old" },
				{ source_revision: "old" },
				{ outcome: "proceed" },
				{ author_ref: { id: "bob", digest: "other" } },
			])
				expectError(() => f.ledger.getEvidence("alice", evidenceRef, { ...scope, ...changed }), "input_stale");
			expectError(() => f.ledger.getEvidence("bob", evidenceRef, scope), "permission_denied");
			expectError(() => f.ledger.getEvidence("alice", { ...evidenceRef, digest: "sha256:wrong" }, scope), "invalid");
			f.db.query("UPDATE graph_human_evidence SET data=? WHERE id=?").run("{}", evidenceRef.id);
			expectError(() => f.ledger.getEvidence("alice", evidenceRef, scope), "invalid");
		} finally {
			f.db.close();
		}
	});

	it("rejects stale inputs, source and revision without closing the question", () => {
		const f = fixture();
		try {
			f.ledger.create("alice", question);
			expectError(() => f.ledger.answer({ ...answer, input_digest: "old" }), "input_stale");
			f.setDigest("changed");
			expectError(() => f.ledger.answer(answer), "input_stale");
			f.setDigest(question.input_digest);
			f.setSource("source-2");
			expectError(() => f.ledger.answer(answer), "input_stale");
			f.setSource("source-1");
			f.setRevision("10");
			expectError(() => f.ledger.answer(answer), "revision_conflict");
			expect(f.ledger.get("alice", question.id)?.answer).toBeNull();
			f.setRevision("9");
			expect(f.ledger.answer(answer).answer?.outcome).toBe("revise");
		} finally {
			f.db.close();
		}
	});

	it("rejects wrong identities, unauthorized authors, invalid decisions and closed questions", () => {
		const f = fixture();
		try {
			f.ledger.create("alice", question);
			expectError(() => f.ledger.create("alice", { ...question, invocation_id: "other" }), "idempotency_conflict");
			expectError(() => f.ledger.answer({ ...answer, run_id: "other" }), "unknown_reference");
			expectError(() => f.ledger.answer({ ...answer, invocation_id: "other" }), "unknown_reference");
			expectError(
				() => f.ledger.answer({ ...answer, author_ref: { id: "bob", digest: "identity" } }),
				"permission_denied",
			);
			expectError(() => f.ledger.answer({ ...answer, outcome: "proceed" }), "invalid");
			f.ledger.answer(answer);
			expectError(() => f.ledger.answer({ ...answer, request_key: "another" }), "question_closed");
		} finally {
			f.db.close();
		}
	});

	it("rolls back decision and receipt with host transaction and survives reopening the component", () => {
		const f = fixture();
		try {
			expect(() =>
				f.db.transaction(() => {
					f.ledger.create("alice", question);
					throw new Error("rollback");
				})(),
			).toThrow("rollback");
			expect(f.ledger.get("alice", question.id)).toBeNull();
			f.ledger.create("alice", question);
			expect(() =>
				f.db.transaction(() => {
					f.ledger.answer(answer);
					throw new Error("rollback");
				})(),
			).toThrow("rollback");
			expect(f.ledger.get("alice", question.id)?.answer).toBeNull();
			const result = f.ledger.answer(answer);
			const reopened = new GraphHumanDecisions({ database: f.db, authorize: () => true, fence: () => false });
			expect(reopened.answer(answer)).toEqual(result);
		} finally {
			f.db.close();
		}
	});
});

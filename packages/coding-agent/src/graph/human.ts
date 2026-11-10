import { Database } from "bun:sqlite";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";

export interface GraphHumanQuestion {
	id: string;
	run_id: string;
	invocation_id: string;
	input_digest: string;
	source_revision: string | null;
	question_ref: GraphRef;
	outcomes: string[];
	verdicts: string[] | null;
	decisions: { verdict: string; outcome: string }[] | null;
}

export interface GraphHumanAnswer {
	request_key: string;
	principal: string;
	run_id: string;
	invocation_id: string;
	decision_id: string;
	input_digest: string;
	/** The expected Run revision, not the decision's revision. */
	if_revision: string;
	outcome: string;
	verdict: string;
	content_ref: GraphRef;
	evidence_refs: GraphRef[];
	reason: string;
	author_ref: GraphRef;
}

/** Historical evidence of a committed answer, not an authorization grant or an artifact. */
export interface GraphHumanEvidence {
	version: 1;
	decision_id: string;
	run_id: string;
	invocation_id: string;
	input_digest: string;
	source_revision: string | null;
	question_ref: GraphRef;
	principal: string;
	answer: NonNullable<GraphHumanDecision["answer"]>;
}

export interface GraphHumanEvidenceScope {
	decision_id: string;
	run_id: string;
	invocation_id: string;
	input_digest: string;
	source_revision: string | null;
	author_ref: GraphRef;
	outcome: string;
}

export interface GraphHumanDecision extends GraphHumanQuestion {
	revision: string;
	created_at: string;
	updated_at: string;
	/** Present only for answers committed after evidence recording was introduced. */
	evidence_ref?: GraphRef;
	answer: Pick<
		GraphHumanAnswer,
		"outcome" | "verdict" | "content_ref" | "evidence_refs" | "reason" | "author_ref"
	> | null;
}

export class GraphHumanError extends Error {
	constructor(
		readonly code:
			| "invalid"
			| "permission_denied"
			| "unknown_reference"
			| "input_stale"
			| "revision_conflict"
			| "question_closed"
			| "idempotency_conflict",
		message: string,
	) {
		super(message);
		this.name = "GraphHumanError";
	}
}

/** These callbacks are trusted host code and execute synchronously within the shared transaction.
 * Authorization must verify the principal, author and references; the fence must check the current
 * Run revision, invocation identity/state, input digest and source revision against host-owned state.
 * Authorization requires true. A fence may return the exact stale/conflict reason or false
 * (a fail-closed generic conflict); thrown errors also abort the entire transaction. */
export interface GraphHumanDecisionOptions {
	database: Database;
	authorize: (
		action: "create" | "answer" | "read",
		principal: string,
		decision: GraphHumanQuestion | GraphHumanDecision,
		answer?: GraphHumanAnswer,
	) => boolean;
	fence: (
		action: "create" | "answer",
		decision: GraphHumanQuestion | GraphHumanDecision,
		answer?: GraphHumanAnswer,
	) => true | false | "input_stale" | "revision_conflict";
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function ref(value: GraphRef): GraphRef {
	if (!value || !nonempty(value.id) || !nonempty(value.digest))
		throw new GraphHumanError("invalid", "Invalid reference");
	return { id: value.id, digest: value.digest };
}
function questionCopy(value: GraphHumanQuestion): GraphHumanQuestion {
	if (
		!value ||
		!nonempty(value.id) ||
		!nonempty(value.run_id) ||
		!nonempty(value.invocation_id) ||
		!nonempty(value.input_digest) ||
		(value.source_revision !== null && !nonempty(value.source_revision)) ||
		!Array.isArray(value.outcomes) ||
		!value.outcomes.length ||
		value.outcomes.some(item => !nonempty(item)) ||
		new Set(value.outcomes).size !== value.outcomes.length ||
		(value.verdicts !== null &&
			(!Array.isArray(value.verdicts) ||
				!value.verdicts.length ||
				value.verdicts.some(item => !nonempty(item)) ||
				new Set(value.verdicts).size !== value.verdicts.length)) ||
		(value.decisions !== null &&
			(!Array.isArray(value.decisions) ||
				!value.decisions.length ||
				value.decisions.some(
					item =>
						!item ||
						!value.outcomes.includes(item.outcome) ||
						!(value.verdicts ?? value.outcomes).includes(item.verdict),
				)))
	)
		throw new GraphHumanError("invalid", "Invalid human question");
	return {
		id: value.id,
		run_id: value.run_id,
		invocation_id: value.invocation_id,
		input_digest: value.input_digest,
		source_revision: value.source_revision,
		question_ref: ref(value.question_ref),
		outcomes: [...value.outcomes],
		verdicts: value.verdicts && [...value.verdicts],
		decisions: value.decisions?.map(item => ({ verdict: item.verdict, outcome: item.outcome })) ?? null,
	};
}
function answerCopy(value: GraphHumanAnswer): GraphHumanAnswer {
	if (
		!value ||
		![
			value.request_key,
			value.principal,
			value.run_id,
			value.invocation_id,
			value.decision_id,
			value.input_digest,
			value.if_revision,
			value.outcome,
			value.verdict,
			value.reason,
		].every(nonempty) ||
		!Array.isArray(value.evidence_refs)
	)
		throw new GraphHumanError("invalid", "Invalid human answer");
	return {
		request_key: value.request_key,
		principal: value.principal,
		run_id: value.run_id,
		invocation_id: value.invocation_id,
		decision_id: value.decision_id,
		input_digest: value.input_digest,
		if_revision: value.if_revision,
		outcome: value.outcome,
		verdict: value.verdict,
		content_ref: ref(value.content_ref),
		evidence_refs: value.evidence_refs.map(ref),
		reason: value.reason,
		author_ref: ref(value.author_ref),
	};
}

/** A host-owned ledger: use the same connection and transaction as Run/journal transitions.
 * It does not schedule, publish artifacts, or turn a text message into an authorization. */
export class GraphHumanDecisions {
	readonly #db: Database;
	readonly #authorize: GraphHumanDecisionOptions["authorize"];
	readonly #fence: GraphHumanDecisionOptions["fence"];
	constructor(options: GraphHumanDecisionOptions) {
		this.#db = options.database;
		this.#authorize = options.authorize;
		this.#fence = options.fence;
		this.#db.exec(`CREATE TABLE IF NOT EXISTS graph_human_decisions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_human_answer_requests (request_key TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_human_evidence (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, data TEXT NOT NULL);`);
	}

	#load(id: string): GraphHumanDecision | null {
		const row = this.#db.query("SELECT data FROM graph_human_decisions WHERE id=?").get(id) as {
			data: string;
		} | null;
		return row ? (JSON.parse(row.data) as GraphHumanDecision) : null;
	}
	#checkAuthorization(
		action: "create" | "answer" | "read",
		principal: string,
		decision: GraphHumanQuestion | GraphHumanDecision,
		answer?: GraphHumanAnswer,
	): void {
		if (this.#authorize(action, principal, structuredClone(decision), answer && structuredClone(answer)) !== true)
			throw new GraphHumanError("permission_denied", "Human decision not authorized");
	}
	get(principal: string, id: string): GraphHumanDecision | null {
		if (!nonempty(principal) || !nonempty(id)) throw new GraphHumanError("invalid", "Invalid decision identity");
		const decision = this.#load(id);
		if (decision) this.#checkAuthorization("read", principal, decision);
		return decision;
	}
	/** Read historical evidence only for the exact expected scope. This does not check current
	 * applicability or authorize any downstream modification; trusted host policy must do both. */
	getEvidence(principal: string, reference: GraphRef, scope: GraphHumanEvidenceScope): GraphHumanEvidence {
		if (!nonempty(principal)) throw new GraphHumanError("invalid", "Invalid principal");
		const requested = ref(reference);
		if (
			!scope ||
			![scope.decision_id, scope.run_id, scope.invocation_id, scope.input_digest, scope.outcome].every(nonempty) ||
			(scope.source_revision !== null && !nonempty(scope.source_revision))
		)
			throw new GraphHumanError("invalid", "Invalid evidence scope");
		const author = ref(scope.author_ref);
		const row = this.#db
			.query("SELECT decision_id,digest,data FROM graph_human_evidence WHERE id=?")
			.get(requested.id) as { decision_id: string; digest: string; data: string } | null;
		if (!row) throw new GraphHumanError("unknown_reference", "Decision evidence not found");
		const decision = this.#load(row.decision_id);
		if (!decision) throw new GraphHumanError("unknown_reference", "Decision not found");
		this.#checkAuthorization("read", principal, decision);
		if (
			row.digest !== requested.digest ||
			`sha256:${Bun.SHA256.hash(row.data, "hex")}` !== row.digest ||
			decision.evidence_ref?.id !== requested.id ||
			decision.evidence_ref.digest !== requested.digest
		)
			throw new GraphHumanError("invalid", "Decision evidence integrity mismatch");
		const evidence = JSON.parse(row.data) as GraphHumanEvidence;
		if (
			evidence.decision_id !== decision.id ||
			evidence.decision_id !== scope.decision_id ||
			evidence.run_id !== scope.run_id ||
			evidence.invocation_id !== scope.invocation_id ||
			evidence.input_digest !== scope.input_digest ||
			evidence.source_revision !== scope.source_revision ||
			evidence.answer.outcome !== scope.outcome ||
			evidence.answer.author_ref.id !== author.id ||
			evidence.answer.author_ref.digest !== author.digest
		)
			throw new GraphHumanError("input_stale", "Decision evidence scope does not match");
		return evidence;
	}
	/** Authorize before consulting a shared mutation ledger, including on replay. */
	authorizeAnswer(input: GraphHumanAnswer): void {
		const answer = answerCopy(input);
		const decision = this.#load(answer.decision_id);
		if (!decision) throw new GraphHumanError("unknown_reference", "Decision not found");
		this.#checkAuthorization("answer", answer.principal, decision, answer);
	}
	create(principal: string, input: GraphHumanQuestion): GraphHumanDecision {
		if (!nonempty(principal)) throw new GraphHumanError("invalid", "Invalid principal");
		const question = questionCopy(input);
		return this.#db
			.transaction(() => {
				this.#checkAuthorization("create", principal, question);
				const existing = this.#load(question.id);
				if (existing) {
					const previous = questionCopy(existing);
					if (JSON.stringify(previous) !== JSON.stringify(question))
						throw new GraphHumanError("idempotency_conflict", "Decision identity already exists");
					return existing;
				}
				if (this.#fence("create", structuredClone(question)) !== true)
					throw new GraphHumanError("input_stale", "Question inputs or invocation are stale");
				const now = new Date().toISOString();
				const decision: GraphHumanDecision = {
					...question,
					revision: "1",
					created_at: now,
					updated_at: now,
					answer: null,
				};
				this.#db
					.query("INSERT INTO graph_human_decisions (id,data) VALUES (?,?)")
					.run(decision.id, JSON.stringify(decision));
				return decision;
			})
			.immediate();
	}
	answer(input: GraphHumanAnswer): GraphHumanDecision {
		const answer = answerCopy(input);
		return this.#db
			.transaction(() => {
				const decision = this.#load(answer.decision_id);
				if (!decision) throw new GraphHumanError("unknown_reference", "Decision not found");
				this.#checkAuthorization("answer", answer.principal, decision, answer);
				const payload = JSON.stringify(answer);
				const request = this.#db
					.query("SELECT payload,result FROM graph_human_answer_requests WHERE request_key=?")
					.get(answer.request_key) as { payload: string; result: string } | null;
				if (request) {
					if (request.payload !== payload)
						throw new GraphHumanError("idempotency_conflict", "Request key already used for another answer");
					return JSON.parse(request.result) as GraphHumanDecision;
				}
				if (decision.run_id !== answer.run_id || decision.invocation_id !== answer.invocation_id)
					throw new GraphHumanError("unknown_reference", "Decision identity does not match invocation");
				if (decision.input_digest !== answer.input_digest)
					throw new GraphHumanError("input_stale", "Answer refers to different inputs");
				if (decision.answer) throw new GraphHumanError("question_closed", "Decision already answered");
				if (
					!decision.outcomes.includes(answer.outcome) ||
					!(decision.verdicts ?? [answer.outcome]).includes(answer.verdict) ||
					(decision.decisions !== null &&
						!decision.decisions.some(pair => pair.outcome === answer.outcome && pair.verdict === answer.verdict))
				)
					throw new GraphHumanError("invalid", "Undeclared verdict or outcome");
				const fenced = this.#fence("answer", structuredClone(decision), structuredClone(answer));
				if (fenced !== true)
					throw new GraphHumanError(
						fenced === "input_stale" ? "input_stale" : "revision_conflict",
						"Run revision, invocation or input is stale",
					);
				const result: GraphHumanDecision = {
					...decision,
					revision: (BigInt(decision.revision) + 1n).toString(),
					updated_at: new Date().toISOString(),
					answer: {
						outcome: answer.outcome,
						verdict: answer.verdict,
						content_ref: answer.content_ref,
						evidence_refs: answer.evidence_refs,
						reason: answer.reason,
						author_ref: answer.author_ref,
					},
				};
				const evidence: GraphHumanEvidence = {
					version: 1,
					decision_id: decision.id,
					run_id: decision.run_id,
					invocation_id: decision.invocation_id,
					input_digest: decision.input_digest,
					source_revision: decision.source_revision,
					question_ref: decision.question_ref,
					principal: answer.principal,
					answer: result.answer!,
				};
				const evidenceData = JSON.stringify(evidence);
				result.evidence_ref = {
					id: `human-evidence:${decision.id}`,
					digest: `sha256:${Bun.SHA256.hash(evidenceData, "hex")}`,
				};
				this.#db
					.query("INSERT INTO graph_human_evidence (id,decision_id,digest,data) VALUES (?,?,?,?)")
					.run(result.evidence_ref.id, decision.id, result.evidence_ref.digest, evidenceData);
				this.#db
					.query("UPDATE graph_human_decisions SET data=? WHERE id=?")
					.run(JSON.stringify(result), decision.id);
				this.#db
					.query("INSERT INTO graph_human_answer_requests (request_key,payload,result) VALUES (?,?,?)")
					.run(answer.request_key, payload, JSON.stringify(result));
				return result;
			})
			.immediate();
	}
}

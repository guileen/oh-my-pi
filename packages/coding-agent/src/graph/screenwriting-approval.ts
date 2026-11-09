import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import { GraphHumanError, type GraphHumanEvidence, type GraphHumanEvidenceScope } from "./human";

/** A host-created, immutable proposal. The host must resolve and present the exact subject and
 * scope bytes to the author and verify their digests; this commitment does not store those bytes. */
export interface ScreenwritingApprovalProposal {
	decision_id: string;
	run_id: string;
	invocation_id: string;
	input_digest: string;
	source_revision: string;
	subject: GraphRef;
	change_scope: GraphRef;
	principal: string;
	author_ref: GraphRef;
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validRef(value: GraphRef, contentAddressed = false): boolean {
	return (
		!!value &&
		nonempty(value.id) &&
		nonempty(value.digest) &&
		(!contentAddressed || /^sha256:[0-9a-f]{64}$/.test(value.digest))
	);
}

/** Commit the question to one exact proposal and identity, not to an approval mentioned in prose.
 * The host must register/present this same commitment when creating the human question. */
export function screenwritingApprovalQuestionRef(proposal: ScreenwritingApprovalProposal): GraphRef {
	if (
		!proposal ||
		![
			proposal.decision_id,
			proposal.run_id,
			proposal.invocation_id,
			proposal.input_digest,
			proposal.source_revision,
			proposal.principal,
		].every(nonempty) ||
		!validRef(proposal.subject, true) ||
		!validRef(proposal.change_scope, true) ||
		!validRef(proposal.author_ref)
	)
		throw new GraphHumanError("invalid", "Invalid screenwriting approval proposal");
	const commitment = JSON.stringify([
		"omp.screenwriting.revision-approval/v1",
		proposal.decision_id,
		proposal.run_id,
		proposal.invocation_id,
		proposal.input_digest,
		proposal.source_revision,
		[proposal.subject.id, proposal.subject.digest],
		[proposal.change_scope.id, proposal.change_scope.digest],
		proposal.principal,
		[proposal.author_ref.id, proposal.author_ref.digest],
	]);
	const hash = Bun.SHA256.hash(commitment, "hex");
	return { id: `screenwriting-approval:${hash}`, digest: `sha256:${hash}` };
}

/** Read only matching historical approval from the trusted human ledger. This is not a dispatch
 * grant: the embedding must atomically fence current applicability and enforce the scope on both
 * dispatch and output. In particular, never pass fabricated evidence or model-generated prose. */
export function readScreenwritingApprovalEvidence(
	store: {
		getHumanEvidence(principal: string, reference: GraphRef, scope: GraphHumanEvidenceScope): GraphHumanEvidence;
	},
	reader: string,
	evidenceRef: GraphRef,
	proposal: ScreenwritingApprovalProposal,
): GraphHumanEvidence {
	proposal = structuredClone(proposal);
	evidenceRef = structuredClone(evidenceRef);
	const question = screenwritingApprovalQuestionRef(proposal);
	const evidence = store.getHumanEvidence(reader, evidenceRef, {
		decision_id: proposal.decision_id,
		run_id: proposal.run_id,
		invocation_id: proposal.invocation_id,
		input_digest: proposal.input_digest,
		source_revision: proposal.source_revision,
		author_ref: proposal.author_ref,
		outcome: "approve",
	});
	if (
		evidence.question_ref.id !== question.id ||
		evidence.question_ref.digest !== question.digest ||
		evidence.principal !== proposal.principal ||
		evidence.answer.verdict !== "APPROVE"
	)
		throw new GraphHumanError("input_stale", "Screenwriting approval does not match the exact proposal and identity");
	return evidence;
}

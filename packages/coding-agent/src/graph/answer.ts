import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import type { GraphOperation } from "./authoring";
import type { GraphHumanDecisionOptions } from "./human";
import type { GraphRunStore } from "./store";

export interface GraphAnswerTarget {
	run_id: string;
	decision_id: string;
	request_key: string;
}

/** Trusted identity and current decision authorization, never supplied by model arguments. */
export interface GraphAnswerAuthorization {
	principal: string;
	authorizeTarget(principal: string, target: GraphAnswerTarget): boolean | Promise<boolean>;
	authorRef(principal: string): Promise<GraphRef>;
	authorize: GraphHumanDecisionOptions["authorize"];
}

export interface GraphAnswerPolicy extends GraphAnswerAuthorization {
	/** Resolve authorized immutable answer bytes; reject unavailable, oversized or mismatched refs. */
	resolveContent(principal: string, scope: GraphAnswerTarget & { content_ref: GraphRef }): Promise<string>;
}

export interface GraphAnswerRequest {
	version: 1;
	request_key: string;
	operation: "answer";
	target_id: string;
	if_revision: string;
	payload: {
		decision_id: string;
		input_digest: string;
		outcome: string;
		content_ref: GraphRef;
		verdict?: string;
		evidence_refs?: GraphRef[];
	};
}

export class GraphAnswerError extends Error {
	constructor(
		readonly code: "permission_denied" | "unknown_reference" | "definition_invalid",
		message: string,
	) {
		super(message);
	}
}

/** Expand public requests using authentic answer bytes and host-owned invocation/author identity.
 * The trusted adapter configures Store with policy.authorize before calling; Store reauthorizes
 * inside its receipt/answer transaction, including exact replay. */
export async function answerGraphRun(
	store: GraphRunStore,
	policy: GraphAnswerPolicy,
	input: GraphAnswerRequest,
): Promise<GraphOperation> {
	const request = structuredClone(input);
	const principal = policy.principal;
	const target: GraphAnswerTarget = {
		run_id: request.target_id,
		decision_id: request.payload.decision_id,
		request_key: request.request_key,
	};
	if (!principal || (await policy.authorizeTarget(principal, { ...target })) !== true)
		throw new GraphAnswerError("permission_denied", "Graph answer target authorization denied");
	const decision = store.getHumanQuestion(principal, target.decision_id);
	if (!decision || decision.run_id !== target.run_id)
		throw new GraphAnswerError("unknown_reference", "Human decision does not exist in this Run");
	const reason = await policy.resolveContent(principal, {
		...target,
		content_ref: { ...request.payload.content_ref },
	});
	if (typeof reason !== "string" || !reason.length)
		throw new GraphAnswerError("definition_invalid", "Human answer requires resolved content");
	const author = await policy.authorRef(principal);
	return store.answerHuman({
		...target,
		principal,
		invocation_id: decision.invocation_id,
		if_revision: request.if_revision,
		input_digest: request.payload.input_digest,
		outcome: request.payload.outcome,
		verdict: request.payload.verdict ?? request.payload.outcome,
		content_ref: request.payload.content_ref,
		evidence_refs: request.payload.evidence_refs ?? [],
		reason,
		author_ref: { id: author.id, digest: author.digest },
	});
}

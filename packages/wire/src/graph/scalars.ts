/** Browser-neutral Graph identities and state vocabularies shared by execution and observation. */
export interface GraphRef {
	id: string;
	digest: string;
}

export interface GraphCursor {
	journal_id: string;
	seq: string;
}

export type GraphMemberDuty =
	| "research"
	| "guide"
	| "spec"
	| "review"
	/** Ask-only consultant: one bounded question in, one bounded answer out, no tools. */
	| "consult"
	| "code-only"
	| "test-only"
	| "general";
export type GraphNodeKind = "bot" | "program" | "queue" | "human" | "subgraph";

export type SchedulerInvocationState =
	| "pending"
	| "ready"
	| "running"
	| "waiting"
	| "succeeded"
	| "failed"
	| "blocked"
	| "skipped"
	| "cancelled"
	| "unknown";

export type ConsultationState = "queued" | "active" | "answered" | "timed_out" | "cancelled";

export type GraphRunState =
	| "queued"
	| "running"
	| "held"
	| "cancelling"
	| "cancelled"
	| "succeeded"
	| "failed"
	| "unknown";

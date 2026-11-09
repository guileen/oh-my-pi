import type {
	ConsultationState,
	GraphMemberDuty,
	GraphNodeKind,
	GraphRef,
	GraphRunState,
	SchedulerInvocationState,
} from "./scalars";
import type { GraphSourceRef, GraphWireRun } from "./wire-types";

export const GRAPH_WIRE_EXECUTION_EXTENSION = "graph.execution.v1";

/** C2 includes cancelling even though the scheduler's persisted union does not yet expose it. */
export type GraphWireInvocationState = SchedulerInvocationState | "cancelling";
export type GraphWireAttemptState = Exclude<GraphWireInvocationState, "pending" | "blocked" | "skipped">;

export interface GraphWireExecutionRun {
	graph_run_id: string;
	revision: string;
	state: GraphRunState;
	reason: string | null;
	snapshot_ref: GraphRef;
	budget_refs: string[];
	decision_refs: string[];
}

export interface GraphWireExecutionMember {
	graph_run_id: string;
	member_id: string;
	revision: string;
	label: string;
	bot: GraphSourceRef | null;
	duty: GraphMemberDuty;
	model_binding_ref: GraphRef;
	base_snapshot_ref: GraphRef;
	communication_targets: string[];
}

export interface GraphWireExecutionInvocation {
	graph_run_id: string;
	node_id: string;
	invocation_id: string;
	revision: string;
	member_id: string | null;
	kind: GraphNodeKind;
	origin: "executed" | "imported";
	iteration: number;
	scope_id: string;
	parent_invocation_id: string | null;
	state: GraphWireInvocationState;
	selected_outcome: string | null;
	input_refs: string[];
	upstream_attempt_ids: string[];
	wait_reason: string | null;
	current_attempt_id: string | null;
}

export interface GraphWireExecutionAttempt {
	graph_run_id: string;
	attempt_id: string;
	invocation_id: string;
	revision: string;
	number: number;
	executor_kind: GraphNodeKind;
	state: GraphWireAttemptState;
	execution_ref: string | null;
	result_ref: string | null;
	job: (GraphSourceRef & { job_id: string }) | null;
}

export interface GraphWireExecutionConversation {
	graph_run_id: string;
	conversation_id: string;
	revision: string;
	requester_member: string;
	responder_member: string;
	state: ConsultationState;
	remaining_rounds: number;
	deadline: string;
	content_ref: string;
	message_refs: string[];
}

export interface GraphWireExecutionBudget {
	graph_run_id: string;
	budget_id: string;
	revision: string;
	scope_key: string;
	limit: number;
	consumed: number;
}

export type GraphWireExecutionRecord =
	| { kind: "execution_run"; value: GraphWireExecutionRun }
	| { kind: "execution_member"; value: GraphWireExecutionMember }
	| { kind: "execution_invocation"; value: GraphWireExecutionInvocation }
	| { kind: "execution_attempt"; value: GraphWireExecutionAttempt }
	| { kind: "execution_conversation"; value: GraphWireExecutionConversation }
	| { kind: "execution_budget"; value: GraphWireExecutionBudget };

const executionKinds: Record<GraphWireExecutionRecord["kind"], true> = {
	execution_run: true,
	execution_member: true,
	execution_invocation: true,
	execution_attempt: true,
	execution_conversation: true,
	execution_budget: true,
};

export function isGraphWireExecutionKind(kind: unknown): kind is GraphWireExecutionRecord["kind"] {
	return typeof kind === "string" && Object.hasOwn(executionKinds, kind);
}

/** The base frozen Run owns node identity; an execution Run never invents a second topology. */
export type GraphWireExecutionImageRecord = GraphWireExecutionRecord | { kind: "run"; value: GraphWireRun };

/** Shared with consumers: unknown incoming states render unsupported, never as successful work. */
export const GRAPH_WIRE_EXECUTION_STATES = {
	execution_run: [
		"queued",
		"running",
		"held",
		"cancelling",
		"cancelled",
		"succeeded",
		"failed",
		"unknown",
	] satisfies GraphRunState[],
	execution_invocation: [
		"pending",
		"ready",
		"running",
		"waiting",
		"succeeded",
		"failed",
		"blocked",
		"skipped",
		"cancelling",
		"cancelled",
		"unknown",
	] satisfies GraphWireInvocationState[],
	execution_attempt: [
		"ready",
		"running",
		"waiting",
		"succeeded",
		"failed",
		"cancelling",
		"cancelled",
		"unknown",
	] satisfies GraphWireAttemptState[],
	execution_conversation: ["queued", "active", "answered", "timed_out", "cancelled"] satisfies ConsultationState[],
} as const;

/** Fallbacks are validation-only: consumers MUST retain unsupported status and the raw state.
 * Conversation has no unknown enum in C3; queued is nonterminal, never a successful outcome. */
export const GRAPH_WIRE_EXECUTION_STATE_POLICIES = {
	execution_run: { field: "state", values: GRAPH_WIRE_EXECUTION_STATES.execution_run, fallback: "unknown" },
	execution_invocation: {
		field: "state",
		values: GRAPH_WIRE_EXECUTION_STATES.execution_invocation,
		fallback: "unknown",
	},
	execution_attempt: { field: "state", values: GRAPH_WIRE_EXECUTION_STATES.execution_attempt, fallback: "unknown" },
	execution_conversation: {
		field: "state",
		values: GRAPH_WIRE_EXECUTION_STATES.execution_conversation,
		fallback: "queued",
	},
} as const;

export function graphWireExecutionStateSupported(kind: string, state: unknown): boolean {
	if (typeof state !== "string" || !Object.hasOwn(GRAPH_WIRE_EXECUTION_STATES, kind)) return false;
	const states: readonly string[] = GRAPH_WIRE_EXECUTION_STATES[kind as keyof typeof GRAPH_WIRE_EXECUTION_STATES];
	return states.includes(state);
}

import type { GraphCursor } from "./scalars";
import type { GraphWireExecutionRecord } from "./wire-execution-types";

export const GRAPH_WIRE_PROTOCOL = "omp.graph.v1";

export interface GraphSourceRef {
	source_id: string;
	profile_id: string;
	bot_id: string;
}
export interface GraphWireDefinition {
	nodes: {
		node_id: string;
		label: string;
		bot: GraphSourceRef | null;
		config_revision: string | null;
		acceptance_ref: string | null;
	}[];
	edges: { edge_id: string; from_node_id: string; to_node_id: string; condition_ref: string | null }[];
}
export interface GraphWireRun {
	graph_id: string;
	graph_run_id: string;
	definition_revision: string;
	definition: GraphWireDefinition;
	revision: string;
	created_at: string;
}
export interface GraphWireBinding {
	binding_id: string;
	graph_run_id: string;
	node_id: string;
	invocation_id: string;
	attempt: number;
	job: GraphSourceRef & { job_id: string };
	config_revision: string;
	revision: string;
	acceptance: "pending" | "accepted" | "rejected" | "unknown";
	evidence_refs: string[];
	reason: string | null;
}
export interface GraphWireEvidence {
	source: GraphSourceRef;
	job_id: string;
	artifact_id: string | null;
	ref: string | null;
}
export interface GraphWireDependency {
	dependency_id: string;
	graph_run_id: string;
	edge_id: string;
	target_invocation_id: string;
	target_attempt: number;
	revision: string;
	state: "waiting" | "satisfied" | "rejected" | "unknown";
	reason: string | null;
	evidence: GraphWireEvidence[];
}
export interface GraphWireTransfer {
	transfer_id: string;
	graph_run_id: string;
	edge_id: string;
	from_binding_id: string;
	to_binding_id: string;
	artifact: GraphWireEvidence;
	revision: string;
	state: "pending" | "delivered" | "failed" | "unknown";
	reason: string | null;
	occurred_at: string;
}
export type GraphWireRecord =
	| { kind: "run"; value: GraphWireRun }
	| { kind: "binding"; value: GraphWireBinding }
	| { kind: "dependency"; value: GraphWireDependency }
	| { kind: "transfer"; value: GraphWireTransfer }
	| GraphWireExecutionRecord;

export interface GraphWireSource {
	source_id: string;
	kind: "bot" | "graph";
	profile_id: string | null;
	bot_id: string | null;
	capabilities: string[];
}
export interface GraphWireCheckpoint {
	scope_id: string;
	entries: { source_id: string; cursor: GraphCursor }[];
}
export interface GraphWireHistoryEvent {
	event_id: string;
	cursor: GraphCursor;
	occurred_at: string;
	records: GraphWireRecord[];
}

/** Graph-source synchronization frames only; Bot sources use their own guarded projections. */
export type GraphWireSourceFrame = {
	protocol: typeof GRAPH_WIRE_PROTOCOL;
	in_reply_to: string | null;
	subscription_id: string;
} & (
	| {
			type: "subscription";
			scope_id: string;
			mode: "live" | "history";
			sources: GraphWireSource[];
			authorized_at: string;
			authorization_expires_at: string;
	  }
	| {
			type: "scope.authorized";
			scope_id: string;
			authorized_at: string;
			authorization_expires_at: string;
	  }
	| { type: "scope.invalidated"; scope_id: string; reason: "revoked" | "expired" | "scope_changed" }
	| {
			type: "source.state";
			source_id: string;
			state: "syncing" | "live" | "stale" | "denied" | "unsupported";
			reason: string | null;
	  }
	| { type: "snapshot.begin"; source_id: string; snapshot_id: string; cursor: GraphCursor; page_count: number }
	| {
			type: "snapshot.page";
			source_id: string;
			snapshot_id: string;
			cursor: GraphCursor;
			page: number;
			records: GraphWireRecord[];
	  }
	| { type: "snapshot.end"; source_id: string; snapshot_id: string; cursor: GraphCursor }
	| {
			type: "graph.event";
			source_id: string;
			event_id: string;
			cursor: GraphCursor;
			occurred_at: string;
			records: GraphWireRecord[];
			replay: boolean;
	  }
	| { type: "source.ready"; source_id: string; cursor: GraphCursor }
	| { type: "heartbeat"; observed_at: string; checkpoint: GraphWireCheckpoint }
);

export class GraphWireError extends Error {
	constructor(
		readonly code:
			| "invalid_input"
			| "invalid_cursor"
			| "cursor_expired"
			| "binding_conflict"
			| "protocol_error"
			| "scope_denied"
			| "unsupported_version"
			| "capability_unavailable",
		message: string,
	) {
		super(message);
		this.name = "GraphWireError";
	}
}

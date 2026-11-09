import type { GraphRef, GraphRunState } from "./scalars";
import type { GraphObservedUsage } from "./wire-catalog";

/**
 * Durable notification outbox contract. The host appends one record inside the
 * transaction that commits a Run transition; readers poll this format instead of
 * subscribing to a host-specific transport, so a CLI, the wherdr session view and
 * any headless consumer read the same bytes.
 *
 * Publishing or reading a notification carries no authority: it never starts,
 * resumes, cancels or authorizes a Run. `report_to` is a caller-declared address
 * that a delivery agent may interpret; the outbox itself delivers nothing.
 */
export const GRAPH_NOTIFICATION_FORMAT = "omp.graph/notification/v1" as const;

export type GraphNotificationKind = "run.succeeded" | "run.failed" | "run.cancelled" | "run.held" | "run.stalled";

export interface GraphNotificationOutput {
	node: string;
	name: string;
	ref: GraphRef;
}

export interface GraphNotification {
	format: typeof GRAPH_NOTIFICATION_FORMAT;
	id: string;
	/** Monotonic per Run; pass as `since` to resume reading without gaps or duplicates. */
	sequence: number;
	kind: GraphNotificationKind;
	state: GraphRunState;
	occurred_at: string;
	run_id: string;
	graph_id: string;
	graph_name: string | null;
	/** Caller-supplied task label; the outbox never derives it from Run content. */
	title: string | null;
	report_to: string | null;
	reason: string | null;
	last_event: string | null;
	outputs: GraphNotificationOutput[];
	observed_bot_usage?: GraphObservedUsage;
	/**
	 * Present on `run.stalled` alarms only. `activity_at` is the newest liveness instant
	 * the alarm was raised for, so a resume followed by a second stall notifies again
	 * while a repeated sweep over the same idle window stays silent.
	 */
	stall?: { activity_at: string; threshold_ms: number };
}

export interface GraphNotificationPage {
	format: typeof GRAPH_NOTIFICATION_FORMAT;
	as_of: string;
	/** Highest sequence included; pass back as `since` to read only newer records. */
	cursor: number;
	notifications: GraphNotification[];
}

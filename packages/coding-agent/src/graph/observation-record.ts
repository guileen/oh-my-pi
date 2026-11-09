import type { SchedulerInvocation } from "./scheduler";
import type { GraphRunRecord } from "./store";

/** Private, minimal journal replacement for the local observation view, not a wire record. */
export interface GraphRecordedView {
	run: Pick<
		GraphRunRecord,
		| "id"
		| "graph_id"
		| "revision"
		| "definition_revision"
		| "state"
		| "created_at"
		| "updated_at"
		| "observed_bot_usage"
	>;
	invocations: Pick<
		SchedulerInvocation,
		"id" | "node" | "state" | "iteration" | "scope_id" | "attempt_id" | "superseded" | "consultation" | "outcome"
	>[];
}

export function graphRecordedView(
	run: GraphRecordedView["run"],
	invocations: SchedulerInvocation[],
): GraphRecordedView {
	return {
		run: {
			id: run.id,
			graph_id: run.graph_id,
			revision: run.revision,
			definition_revision: run.definition_revision,
			state: run.state,
			created_at: run.created_at,
			updated_at: run.updated_at,
			...(run.observed_bot_usage ? { observed_bot_usage: structuredClone(run.observed_bot_usage) } : {}),
		},
		invocations: invocations.map(item => ({
			id: item.id,
			node: item.node,
			state: item.state,
			iteration: item.iteration,
			scope_id: item.scope_id,
			attempt_id: item.attempt_id,
			superseded: item.superseded,
			consultation: item.consultation,
			outcome: item.outcome ?? null,
		})),
	};
}

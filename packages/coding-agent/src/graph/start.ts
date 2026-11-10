import type { GraphOperation, GraphSnapshot } from "./authoring";
import type { GraphPreparedRun, GraphRunStore, GraphStartRequest } from "./store";

/** Trusted embedding policy; neither Graph content nor tool arguments can install it. */
export interface GraphStartPolicy {
	principal: string;
	authorizeTarget(
		principal: string,
		target: { graph_id: string; request_key: string; revision: string },
	): boolean | Promise<boolean>;
	/** Rechecked for every request, including receipt replay. */
	authorizeRequest(principal: string, request: GraphStartRequest): boolean | Promise<boolean>;
	/** Verify grants, inputs, import provenance, frozen bindings and executor availability. */
	preflight(principal: string, request: GraphStartRequest, snapshot: GraphSnapshot): Promise<GraphPreparedRun>;
}

export class GraphStartError extends Error {
	readonly code = "permission_denied";
}

/** Shared typed CLI/Agent admission. Publication is a separate, already-authorized operation. */
export async function startGraphRun(
	store: GraphRunStore,
	policy: GraphStartPolicy,
	input: GraphStartRequest,
): Promise<GraphOperation> {
	const request = structuredClone(input);
	const principal = policy.principal;
	if (
		!principal ||
		(await policy.authorizeTarget(principal, {
			graph_id: request.target_id,
			request_key: request.request_key,
			revision: request.if_revision,
		})) !== true
	)
		throw new GraphStartError("Graph start target authorization denied");
	if ((await policy.authorizeRequest(principal, structuredClone(request))) !== true)
		throw new GraphStartError("Graph start authorization denied");
	const prior = store.getStartReceipt(request);
	if (prior) return prior;
	const snapshot = store.definitions.get(request.target_id);
	const prepared =
		snapshot && snapshot.revision === request.if_revision
			? await policy.preflight(principal, structuredClone(request), snapshot)
			: null;
	return store.start(request, prepared);
}

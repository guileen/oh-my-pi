import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { readProfileArtifact } from "./artifacts";
import { createLocalDispatchPolicy } from "./dispatch";
import { createLocalLifecyclePolicy } from "./local-lifecycle";
import { GRAPH_CLI_LIMITS } from "./limits";
import { GraphRunStore, type GraphLifecyclePolicy } from "./store";
import type { GraphToolOptions } from "../tools/graph";

export interface LocalGraphToolOptionsConfig {
	/**
	 * Graph data directory holding graphs.sqlite and artifacts.
	 * Defaults to `<agent dir>/graphs`; passing the agent dir itself creates a second,
	 * empty store, so callers should omit this unless they relocate the whole profile.
	 */
	root?: string;
	/** Session workspace; dispatch bindings resolve inside it. */
	cwd: string;
	principal?: string;
	maxModelCalls?: number;
	maxTimeoutMs?: number;
}

/**
 * Policy for the local profile owner: the OS user who already owns the Graph
 * databases and artifact directory. Embedded hosts (RPC, web, workers) MUST build
 * their own principal-scoped callbacks instead of reusing this function.
 *
 * Observation is limited to Runs that exist in this profile. Lifecycle control covers
 * hold/cancel plus resuming this principal's own operator pause; gate holds stay behind
 * the human decision gate.
 */
export function createLocalGraphToolOptions(config: LocalGraphToolOptionsConfig): GraphToolOptions {
	const principal = config.principal ?? "local-user";
	const root = config.root ?? path.join(getAgentDir(), "graphs");
	const ownsRun = (runId: string): boolean => {
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		try {
			return store.getRun(runId) !== null;
		} finally {
			store.close();
		}
	};
	// Operator pauses (kind: "operator") stay reversible by the same principal; gate holds
	// still require a resolved decision and are rejected by this policy's verifyResume.
	const lifecycle: GraphLifecyclePolicy = createLocalLifecyclePolicy({ principal });
	return {
		root,
		authorizeRun: ownsRun,
		lifecycle: { principal, policy: lifecycle },
		// Same owner-local trust boundary: a read-only connection, and the read grant never
		// widens into publication authority.
		readArtifact: ref =>
			readProfileArtifact(ref, {
				root,
				maxBytes: GRAPH_CLI_LIMITS.maxBytes,
				principal,
				authorize: async (_principal, action) => action === "read",
			}),
		dispatch: createLocalDispatchPolicy({
			root,
			cwd: config.cwd,
			principal,
			maxModelCalls: config.maxModelCalls,
			maxTimeoutMs: config.maxTimeoutMs,
		}),
	};
}

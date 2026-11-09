import type { GraphLimits } from "./definition";

/** Shared parse/validation ceilings. Kept import-free so tool, CLI and worker paths can share it. */
export const GRAPH_CLI_LIMITS: GraphLimits = {
	maxBytes: 1024 * 1024,
	maxDepth: 64,
	maxAliases: 100,
	maxNodes: 10000,
};

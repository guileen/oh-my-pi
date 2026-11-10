import type { GraphMemberDuty, GraphRunState, SchedulerInvocationState } from "./scalars";

/**
 * Read-only discovery contracts. They carry no authority: publishing or reading a
 * catalogue entry never starts, resumes or authorizes a Run. Consumers that need
 * lifecycle control must obtain their own trusted admission.
 */
export const GRAPH_CATALOG_FORMAT = "omp.graph/catalog/v1" as const;
export const GRAPH_RUN_INDEX_FORMAT = "omp.graph/run-index/v1" as const;

/** A Run is reported stalled only after this much persisted inactivity, never by guesswork. */
export const GRAPH_DEFAULT_STALL_THRESHOLD_MS = 300_000;

/** `declared` means the author wrote `extensions.x-contract`; `derived` means the catalog inferred it. */
export type GraphCatalogContractSource = "declared" | "derived";

export interface GraphCatalogInput {
	name: string;
	description: string | null;
	media_type: string | null;
	required: boolean;
}

export interface GraphCatalogOutput extends GraphCatalogInput {
	node: string | null;
	output: string | null;
}

export interface GraphCatalogMember {
	key: string;
	duty: GraphMemberDuty;
	model: string;
}

export interface GraphCatalogDeliverable {
	/** What the human receives, in the Graph author's words. */
	summary: string | null;
	/** How the human tries it firsthand (command, URL, entry point). */
	experience: string | null;
	/** Declared output names that must reach the human; unknown names are dropped. */
	artifacts: string[];
}

export interface GraphCatalogEntry {
	graph_id: string;
	revision: string;
	digest: string;
	name: string;
	summary: string | null;
	contract_source: GraphCatalogContractSource;
	inputs: GraphCatalogInput[];
	outputs: GraphCatalogOutput[];
	report_events: string[];
	stall_threshold_ms: number | null;
	/**
	 * Model-binding file the author declares for this Graph, as written in `x-contract`.
	 * A dispatcher resolves it against the session workspace instead of guessing a name.
	 */
	bindings?: string;
	/** What completes the Run for a human reader; absent when the author declared none. */
	deliverable?: GraphCatalogDeliverable;
	members: GraphCatalogMember[];
	nodes: number;
	/** Foreground local runner support only; a different host performs its own capability check. */
	local_run: { supported: boolean; reason: string | null };
	/**
	 * Byte-identical imports of this definition collapsed into this entry. Every duplicate
	 * keeps its own `graph_id`, so an explicit id still addresses it; discovery shows one
	 * row per distinct content instead of one per import.
	 */
	duplicates?: number;
}

export interface GraphCatalog {
	format: typeof GRAPH_CATALOG_FORMAT;
	entries: GraphCatalogEntry[];
}

/** Token and cost figures observed from Bot jobs; never a complete Run bill. */
export interface GraphObservedUsage {
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	cost_usd: string | null;
	completeness: "complete" | "partial" | "unknown";
	measured_at: string | null;
	observed_sources?: number;
}

/**
 * Whether the Run's declared human deliverable is fully produced, judged only from
 * committed schedule state. A ready deliverable is an observation fact, not acceptance.
 */
export interface GraphRunDeliverable {
	ready: boolean;
	/** Declared deliverable artifacts in declaration order. */
	artifacts: string[];
	/** Declared artifacts with no committed output yet. */
	missing: string[];
}

/**
 * Per-node progress for one Run, projected from committed schedule state. It answers
 * "which steps finished and which one is executing" without the reader replaying every
 * event. A node with no committed invocation reports `pending`, which means not started,
 * not failed.
 */
export interface GraphRunNodeProgress {
	/** Node key from the Run's frozen definition. */
	node: string;
	state: SchedulerInvocationState;
	/** Present once the scheduler created an attempt for this node. */
	attempt_id?: string;
	/** First recorded executor activity, never a dispatch request time. */
	started_at?: string;
	last_activity_at?: string;
	/** Model/tool turns recorded for this node. */
	turns?: number;
	/** Latest recorded activity label for this node. */
	summary?: string;
	/** The node the Run is working on now; at most one per index entry. */
	current?: boolean;
	/** Invocation was invalidated by a later loop generation. */
	superseded?: boolean;
}

export interface GraphRunIndexEntry {
	run_id: string;
	graph_id: string;
	/** Frozen definition name; absent for Runs created before labels were recorded. */
	graph_name?: string;
	/** Caller-supplied task label from dispatch; never derived from Run content. */
	title?: string;
	state: GraphRunState;
	/** Present while held: `operator` pauses are resumable by the holder, `gate` needs a decision. */
	hold_kind?: "operator" | "gate";
	created_at: string;
	updated_at: string;
	/** Last persisted transition or recorded model/tool activity; never a provider heartbeat. */
	last_activity_at: string;
	last_event: string | null;
	stalled: boolean;
	/** Threshold this Run's frozen definition declares, when it declares one; the index default applies otherwise. */
	stall_threshold_ms?: number;
	/** Model/tool turns recorded for this Run; absent until the executor reports any. */
	turn_count?: number;
	/** Latest recorded activity label, for example `tool:graph_publish`; not a completion signal. */
	activity_summary?: string;
	/** Present only when the frozen definition declared a human deliverable. */
	deliverable?: GraphRunDeliverable;
	observed_bot_usage?: GraphObservedUsage;
	/** Bounded per-node progress in frozen definition order; absent when the Run has no definition. */
	nodes?: GraphRunNodeProgress[];
	/** Declared nodes omitted from `nodes` by the projection bound. */
	nodes_omitted?: number;
}

export interface GraphRunIndex {
	format: typeof GRAPH_RUN_INDEX_FORMAT;
	as_of: string;
	stall_threshold_ms: number;
	runs: GraphRunIndexEntry[];
}

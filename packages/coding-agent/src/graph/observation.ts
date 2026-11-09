import type { Database } from "bun:sqlite";
import {
	GRAPH_DEFAULT_STALL_THRESHOLD_MS,
	GRAPH_RUN_INDEX_FORMAT,
	type GraphCursor,
	type GraphNotification,
	type GraphRunDeliverable,
	type GraphRunIndex,
	type GraphRunIndexEntry,
	type GraphRunNodeProgress,
	type GraphRunState,
} from "@oh-my-pi/pi-wire/graph";
import { type GraphCatalogContract, readDeclaredContract } from "./catalog";
import type { GraphLimits } from "./definition";
import {
	type GraphInvocationActivity,
	GraphReadProfile,
	readGraphFrozenDefinition,
	readGraphInvocationActivity,
	readGraphScheduleState,
} from "./read-profile";
import type { StartDescriptorReference } from "./start-descriptor";
import type { GraphRunRecord, GraphScheduleState, GraphStoredInvocation } from "./store";

/** Authorization references are protected execution data, not observation data. */
export type GraphObservedRun = Omit<GraphRunRecord, "authorization_ref">;
export interface GraphObservationSnapshot {
	run: GraphObservedRun;
	cursor: GraphCursor;
}
export interface GraphObservedEvent {
	cursor: GraphCursor;
	/** The host's persisted event, not an invented graph.event wire record. */
	data: unknown;
}
export interface GraphNotificationQuery {
	/** Exclusive global cursor: return records committed after this ordinal. */
	since?: number;
	run_id?: string;
	limit?: number;
	/**
	 * Return the newest `limit` records after `since` instead of the oldest. Still
	 * ordered oldest-first, and the returned cursor is the newest ordinal consumed, so
	 * resuming from it never skips a record.
	 */
	latest?: boolean;
}
export interface GraphNotificationRead {
	notifications: GraphNotification[];
	/** Highest ordinal consumed; pass back as `since` to read only newer records. */
	cursor: number;
}
export interface GraphEventPage {
	events: GraphObservedEvent[];
	/** Last consumed cursor; use this to resume even when the page is empty. */
	cursor: GraphCursor;
	/** Pass this back as options.watermark to keep subsequent pages on the same committed boundary. */
	watermark: GraphCursor;
	next_cursor: GraphCursor | null;
}
export class GraphObservationError extends Error {
	constructor(
		readonly code:
			| "unknown_run"
			| "invalid_cursor"
			| "cursor_expired"
			| "invalid_input"
			| "resource_limit"
			| "internal_error",
		message: string,
		readonly details: Record<string, unknown> | null = null,
	) {
		super(message);
		this.name = "GraphObservationError";
	}
}

/**
 * Read committed host facts only. The caller must authorize the Run before disclosing
 * results; profile access is checked here but is not per-principal authorization.
 * No observation wire capability is advertised by this internal query interface.
 */
export class GraphObservation {
	readonly profile: GraphReadProfile;
	readonly #db: Database;
	readonly #limits: GraphLimits;
	constructor(root: string | undefined, limits: GraphLimits) {
		this.#limits = { ...limits };
		this.profile = new GraphReadProfile(root);
		this.#db = this.profile.db;
	}

	close(): void {
		this.profile.close();
	}

	getScheduleState(runId: string) {
		this.profile.assertAccess();
		return readGraphScheduleState(this.#db, runId);
	}

	/** Liveness facts an executor reported; empty for Runs that have none. Never a success signal. */
	getInvocationActivity(runId: string) {
		this.profile.assertAccess();
		return readGraphInvocationActivity(this.#db, runId);
	}

	getFrozenDefinition(runId: string) {
		this.profile.assertAccess();
		return readGraphFrozenDefinition(this.#db, runId, this.#limits);
	}

	/**
	 * Newest host-published start descriptor reference for the Run's Graph, keyed by the
	 * Run's own `graph_id` so a caller cannot point one Graph's reference at another.
	 * Observation answers "which immutable artifact could start this Graph"; it never
	 * answers "may this principal start it". The reference grants nothing and is
	 * re-authorized at the gateway on every author frame.
	 */
	getStartDescriptor(runId: string): StartDescriptorReference | null {
		this.profile.assertAccess();
		return this.#db.transaction(() => {
			const run = this.#db
				.query("SELECT json_extract(data,'$.graph_id') AS graph_id FROM graph_runs WHERE id=?")
				.get(runId) as { graph_id: string | null } | null;
			if (!run) throw new GraphObservationError("unknown_run", "Graph Run does not exist");
			const graphId = typeof run.graph_id === "string" ? run.graph_id.trim() : "";
			if (!graphId) return null;
			const row = this.#db
				.query(
					"SELECT artifact_id,artifact_digest,created_at FROM graph_start_descriptors WHERE graph_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
				)
				.get(graphId) as { artifact_id: string; artifact_digest: string; created_at: string } | null;
			// An incomplete row is not usable evidence: omit it rather than hand back a partial reference.
			if (!row?.artifact_id || !row.artifact_digest || !row.created_at) return null;
			return { id: row.artifact_id, digest: row.artifact_digest, created_at: row.created_at };
		})();
	}

	#journal(runId: string): { journal_id: string; seq: string; data: string } {
		const row = this.#db
			.query(
				"SELECT j.journal_id,CAST(j.seq AS TEXT) AS seq,r.data FROM graph_runs r LEFT JOIN graph_journals j ON j.run_id=r.id WHERE r.id=?",
			)
			.get(runId) as { journal_id: string | null; seq: string | null; data: string } | null;
		if (!row) throw new GraphObservationError("unknown_run", "Graph Run does not exist");
		if (row.journal_id === null || row.seq === null)
			throw new GraphObservationError("internal_error", "Graph Run journal is missing");
		return { journal_id: row.journal_id, seq: row.seq, data: row.data };
	}

	snapshot(runId: string): GraphObservationSnapshot {
		this.profile.assertAccess();
		return this.#db.transaction(() => {
			const row = this.#journal(runId);
			const { authorization_ref: _authorization, ...run } = JSON.parse(row.data) as GraphRunRecord;
			return { run, cursor: { journal_id: row.journal_id, seq: row.seq } };
		})();
	}

	events(
		runId: string,
		options: { after?: GraphCursor; watermark?: GraphCursor; limit?: number } = {},
	): GraphEventPage {
		this.profile.assertAccess();
		const limit = options.limit === undefined ? 50 : options.limit;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new GraphObservationError("invalid_input", "Event limit must be between 1 and 100");
		return this.#db.transaction(() => {
			const journal = this.#journal(runId);
			const watermark =
				options.watermark === undefined ? { journal_id: journal.journal_id, seq: journal.seq } : options.watermark;
			const after = options.after === undefined ? { journal_id: journal.journal_id, seq: "0" } : options.after;
			for (const cursor of [watermark, after]) {
				if (
					!cursor ||
					typeof cursor !== "object" ||
					Object.keys(cursor).some(key => key !== "journal_id" && key !== "seq") ||
					cursor.journal_id !== journal.journal_id ||
					typeof cursor.seq !== "string" ||
					!/^(0|[1-9][0-9]*)$/.test(cursor.seq) ||
					BigInt(cursor.seq) > BigInt(journal.seq)
				)
					throw new GraphObservationError("invalid_cursor", "Cursor does not belong to this Run journal");
			}
			if (BigInt(after.seq) > BigInt(watermark.seq))
				throw new GraphObservationError("invalid_cursor", "Cursor is beyond the requested watermark");
			const rows = this.#db
				.query(
					"SELECT CAST(seq AS TEXT) AS seq,data FROM graph_events WHERE journal_id=? AND seq>CAST(? AS INTEGER) AND seq<=CAST(? AS INTEGER) ORDER BY graph_events.seq LIMIT ?",
				)
				.all(journal.journal_id, after.seq, watermark.seq, limit + 1) as { seq: string; data: string }[];
			let previous = BigInt(after.seq);
			for (const row of rows) {
				if (BigInt(row.seq) !== previous + 1n)
					throw new GraphObservationError(
						"cursor_expired",
						"Event history is incomplete; obtain a fresh snapshot",
						{ reset_required: true },
					);
				previous = BigInt(row.seq);
			}
			if (rows.length <= limit && previous !== BigInt(watermark.seq))
				throw new GraphObservationError("cursor_expired", "Event history is incomplete; obtain a fresh snapshot", {
					reset_required: true,
				});
			const events = rows.slice(0, limit).map(row => ({
				cursor: { journal_id: journal.journal_id, seq: row.seq },
				data: JSON.parse(row.data) as unknown,
			}));
			// The input watermark and the cursors exposed in each result are independently
			// mutable objects. Do not let a caller alter a page's resume boundary by
			// changing an event cursor, its continuation cursor, or the input object.
			const last = events.at(-1)?.cursor;
			const cursor = { journal_id: journal.journal_id, seq: last?.seq ?? after.seq };
			return {
				events,
				cursor,
				watermark: { journal_id: watermark.journal_id, seq: watermark.seq },
				next_cursor: rows.length > limit ? { ...cursor } : null,
			};
		})();
	}

	/**
	 * Every Run with its last persisted transition, in creation order. The caller authorizes
	 * each entry before disclosure; this method performs no principal check.
	 */
	listRuns(): { run: GraphObservedRun; last_event: string | null }[] {
		this.profile.assertAccess();
		return this.#db.transaction(() => {
			const rows = this.#db
				.query(
					`SELECT r.data AS run,e.data AS event FROM graph_runs r
					 LEFT JOIN graph_journals j ON j.run_id=r.id
					 LEFT JOIN graph_events e ON e.journal_id=j.journal_id AND e.seq=j.seq
					 ORDER BY json_extract(r.data,'$.created_at'),r.rowid`,
				)
				.all() as { run: string; event: string | null }[];
			return rows.map(row => {
				const { authorization_ref: _authorization, ...run } = JSON.parse(row.run) as GraphRunRecord;
				const recorded = row.event ? (JSON.parse(row.event) as { type?: unknown }).type : null;
				return { run, last_event: typeof recorded === "string" ? recorded : null };
			});
		})();
	}

	/** Read the durable outbox. Ordering is the host's commit order, never a client clock. */
	notifications(query: GraphNotificationQuery = {}): GraphNotificationRead {
		this.profile.assertAccess();
		const since = query.since ?? 0;
		if (!Number.isInteger(since) || since < 0)
			throw new GraphObservationError("invalid_input", "Notification cursor must be a non-negative integer");
		const limit = query.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200)
			throw new GraphObservationError("invalid_input", "Notification limit must be 1..200");
		const order = query.latest ? "DESC" : "ASC";
		const rows = this.#db
			.query(
				`SELECT rowid AS ordinal,data FROM graph_notifications WHERE rowid>?${query.run_id ? " AND run_id=?" : ""} ORDER BY rowid ${order} LIMIT ?`,
			)
			.all(...(query.run_id ? [since, query.run_id, limit] : [since, limit])) as { ordinal: number; data: string }[];
		// Consumers resume from the highest ordinal actually returned, never from a
		// projection of the newest row, so a descending read cannot skip a record.
		const newest = rows.reduce((highest, row) => Math.max(highest, row.ordinal), since);
		const ordered = query.latest ? rows.toReversed() : rows;
		return {
			notifications: ordered.map(row => JSON.parse(row.data) as GraphNotification),
			cursor: newest,
		};
	}
}

export function isTerminalRunState(state: GraphRunState): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled" || state === "unknown";
}

/**
 * Deliverable readiness from committed schedule state only. An artifact counts as
 * produced when its declared node output is present on a non-superseded invocation; a
 * successful Run that is missing an artifact still reports `ready: false`.
 */
export function resolveDeliverableReadiness(
	contract: Pick<GraphCatalogContract, "outputs" | "deliverable">,
	schedule: GraphScheduleState | null,
): GraphRunDeliverable | undefined {
	const declared = contract.deliverable;
	if (!declared || declared.artifacts.length === 0) return undefined;
	const artifacts = [...declared.artifacts];
	const missing: string[] = [];
	for (const name of artifacts) {
		const output = contract.outputs.find(candidate => candidate.name === name);
		const node = output?.node;
		const key = output?.output;
		const produced =
			node && key && schedule
				? schedule.invocations.some(
						invocation =>
							invocation.node === node &&
							!invocation.superseded &&
							invocation.outputs !== undefined &&
							Object.hasOwn(invocation.outputs, key),
					)
				: false;
		if (!produced) missing.push(name);
	}
	return { ready: missing.length === 0, artifacts, missing };
}

/** Upper bound on projected nodes per Run; a Run past this reports how many were omitted. */
export const GRAPH_RUN_NODE_PROGRESS_LIMIT = 64;

/** Node states that will not change again for this Run. */
const NODE_SETTLED: ReadonlySet<GraphRunNodeProgress["state"]> = new Set([
	"succeeded",
	"failed",
	"skipped",
	"blocked",
	"cancelled",
]);

/** `nodes:2/3  current:review`; one line answering how far along a Run is. */
export function summarizeNodeProgress(nodes: readonly GraphRunNodeProgress[] | undefined): string | null {
	if (!nodes?.length) return null;
	const settled = nodes.filter(node => NODE_SETTLED.has(node.state)).length;
	const current = nodes.find(node => node.current);
	return `nodes:${settled}/${nodes.length}${current ? `  current:${current.node}` : ""}`;
}

/** One progress line shared by the CLI printers and the foreground runner. */
export function formatNodeProgressLine(node: GraphRunNodeProgress): string {
	return `Node: ${node.node}  ${node.state}${node.current ? "  (current)" : ""}${node.turns ? `  turns:${node.turns}` : ""}${node.last_activity_at ? `  ${node.last_activity_at}` : ""}${node.summary ? `  ${node.summary}` : ""}`;
}

export interface NodeProgressSequence {
	invocations: readonly GraphStoredInvocation[];
	activity?: readonly GraphInvocationActivity[];
	/** Frozen definition node order; synthetic nodes follow it alphabetically. */
	order?: readonly string[];
	runState: GraphRunState;
}

/**
 * Which nodes finished and which one is executing, from committed schedule state only.
 * Declared-but-unstarted nodes report `pending`. A consultation invocation answers for its
 * member; when that member owns a declared node, the node's own execution is the progress,
 * so a late answer can never flip a settled node back to `running`.
 */
export function projectNodeProgress(sequence: NodeProgressSequence): {
	nodes: GraphRunNodeProgress[];
	omitted: number;
} {
	const declared = new Set(sequence.order ?? []);
	const activity = new Map((sequence.activity ?? []).map(row => [row.invocation_id, row]));
	// Later generations supersede earlier ones for the same node; the last entry wins.
	const latest = new Map<string, GraphStoredInvocation>();
	for (const invocation of sequence.invocations) {
		if (invocation.consultation && declared.has(invocation.node)) continue;
		const previous = latest.get(invocation.node);
		if (!previous || (previous.superseded && !invocation.superseded) || previous.iteration <= invocation.iteration)
			latest.set(invocation.node, invocation);
	}
	const extras = [...latest.keys()].filter(node => !declared.has(node)).sort();
	const projected: GraphRunNodeProgress[] = [];
	for (const node of [...declared, ...extras]) {
		const invocation = latest.get(node);
		const row = invocation ? activity.get(invocation.id) : undefined;
		projected.push({
			node,
			state: invocation?.state ?? "pending",
			...(invocation?.attempt_id ? { attempt_id: invocation.attempt_id } : {}),
			...(row ? { started_at: row.started_at, last_activity_at: row.last_activity_at } : {}),
			...(row && Number.isFinite(row.turns) && row.turns > 0 ? { turns: row.turns } : {}),
			...(row?.summary ? { summary: row.summary } : {}),
			...(invocation?.superseded ? { superseded: true } : {}),
		});
	}
	if (!isTerminalRunState(sequence.runState)) {
		// Exactly one node is "current": an executing node outranks a waiting one, and the
		// most recent activity breaks ties inside a state.
		const live = projected
			.filter(node => node.state === "running" || node.state === "waiting")
			.sort(
				(left, right) =>
					Number(right.state === "running") - Number(left.state === "running") ||
					String(right.last_activity_at ?? "").localeCompare(String(left.last_activity_at ?? "")),
			)[0];
		if (live) live.current = true;
	}
	return {
		nodes: projected.slice(0, GRAPH_RUN_NODE_PROGRESS_LIMIT),
		omitted: Math.max(0, projected.length - GRAPH_RUN_NODE_PROGRESS_LIMIT),
	};
}

/** Observation-backed variant of {@link projectNodeProgress} for a stored Run. */
export function buildNodeProgress(
	observation: GraphObservation,
	runId: string,
	runState: GraphRunState,
): { nodes: GraphRunNodeProgress[]; omitted: number } | null {
	const schedule = observation.getScheduleState(runId);
	if (!schedule) return null;
	const declared = observation.getFrozenDefinition(runId);
	return projectNodeProgress({
		invocations: schedule.invocations,
		activity: observation.getInvocationActivity(runId),
		order: declared ? Object.keys(declared.nodes) : [],
		runState,
	});
}

/**
 * Shared Run index projection. The CLI and the headless read tool must project the same
 * facts, so both call this; an unauthorized Run is omitted, never disclosed as an error.
 * Entries are newest-first: a dispatcher looks for the Run it just started, and the index
 * is capped by consumers, so the oldest Run must be the one dropped.
 */
export async function buildRunIndex(
	observation: GraphObservation,
	authorize: (runId: string) => boolean | Promise<boolean>,
	options: { now?: number; stallThresholdMs?: number } = {},
): Promise<GraphRunIndex> {
	const now = options.now ?? Date.now();
	const stallThresholdMs = options.stallThresholdMs ?? GRAPH_DEFAULT_STALL_THRESHOLD_MS;
	const runs: GraphRunIndexEntry[] = [];
	for (const { run, last_event } of observation.listRuns().reverse()) {
		if ((await authorize(run.id)) !== true) continue;
		const activity = observation.getInvocationActivity(run.id);
		const latest = activity.at(-1);
		const latestAt =
			latest && Date.parse(latest.last_activity_at) > Date.parse(run.updated_at)
				? latest.last_activity_at
				: run.updated_at;
		const turns = activity.reduce((total, item) => total + (Number.isFinite(item.turns) ? item.turns : 0), 0);
		const idle = now - Date.parse(latestAt);
		const declared = observation.getFrozenDefinition(run.id);
		const contract = declared ? readDeclaredContract(declared) : null;
		// A Graph that declares its own stall threshold overrides the index default for its Runs.
		const threshold = contract?.stall_threshold_ms ?? stallThresholdMs;
		const deliverable = contract?.deliverable?.artifacts.length
			? resolveDeliverableReadiness(contract, observation.getScheduleState(run.id))
			: undefined;
		const progress = buildNodeProgress(observation, run.id, run.state);
		runs.push({
			run_id: run.id,
			...(run.title ? { title: run.title } : {}),
			...(run.graph_name ? { graph_name: run.graph_name } : {}),
			graph_id: run.graph_id,
			state: run.state,
			...(run.state === "held" ? { hold_kind: run.hold_kind ?? "gate" } : {}),
			created_at: run.created_at,
			updated_at: run.updated_at,
			last_activity_at: latestAt,
			last_event,
			stalled: !isTerminalRunState(run.state) && Number.isFinite(idle) && idle > threshold,
			...(contract?.stall_threshold_ms ? { stall_threshold_ms: contract.stall_threshold_ms } : {}),
			...(turns > 0 ? { turn_count: turns } : {}),
			...(latest?.summary ? { activity_summary: latest.summary } : {}),
			...(deliverable ? { deliverable } : {}),
			...(run.observed_bot_usage ? { observed_bot_usage: run.observed_bot_usage } : {}),
			...(progress?.nodes.length ? { nodes: progress.nodes } : {}),
			...(progress?.omitted ? { nodes_omitted: progress.omitted } : {}),
		});
	}
	return {
		format: GRAPH_RUN_INDEX_FORMAT,
		as_of: new Date(now).toISOString(),
		stall_threshold_ms: stallThresholdMs,
		runs,
	};
}

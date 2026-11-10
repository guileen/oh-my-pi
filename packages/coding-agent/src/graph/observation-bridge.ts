import type { GraphNode } from "./contracts";
import type { SchedulerInvocation } from "./scheduler";
import type { GraphCursor, GraphRunState } from "@oh-my-pi/pi-wire/graph";
import type { GraphObservation } from "./observation";
import { graphRecordedView, type GraphRecordedView } from "./observation-record";
import { projectGraphPulses, type GraphObservationMessage, type GraphObservationTransfer } from "./observation-pulses";
import type { GraphUsageSummary } from "./usage";

/** A deliberately limited, read-only interface, not the omp.graph.v1 wire protocol. */
export interface GraphRunSummary {
	id: string;
	graph_id: string;
	revision: string;
	definition_revision: string;
	state: GraphRunState;
	created_at: string;
	updated_at: string;
	/** Present only while held: `operator` pauses are resumable, `gate` pauses need a decision. */
	hold_kind?: "operator" | "gate";
	/** Observed Bot jobs only, not a complete Run bill or budget guarantee. */
	observed_bot_usage?: GraphUsageSummary;
}

export interface GraphJournalFact {
	cursor: GraphCursor;
	type: string;
	run_id: string;
	revision: string;
	at: string;
}

/** Local, read-only view used by the wherdr adapter. This is not an omp.graph.v1 record. */
export interface GraphObservationView {
	version: 1;
	run: GraphRunSummary;
	cursor: GraphCursor;
	nodes: { id: string; kind: GraphNode["kind"]; member: string | null }[];
	edges: { id: string; from: string; to: string; loop: string | null }[];
	communications: { from: string; to: string }[];
	invocations: {
		id: string;
		kind: "node" | "consultation";
		node: string | null;
		member: string | null;
		state: SchedulerInvocation["state"];
		iteration: number;
		scope_id: string;
		attempt_id: string | null;
		superseded: boolean;
		/** Absent on older retained views; null means no selected business outcome. */
		selected_outcome?: string | null;
	}[];
	/** Latest bounded handoffs on live attempts; omitted entries are not claimed as absent activity. */
	transfers: GraphObservationTransfer[];
	/** Latest bounded consultation messages on live senders. */
	messages: GraphObservationMessage[];
}

export type { GraphObservationMessage, GraphObservationTransfer } from "./observation-pulses";

export class GraphObservationBridgeError extends Error {
	constructor(readonly code: "scope_denied" | "unsupported" | "capability_unavailable") {
		super(
			code === "scope_denied"
				? "Graph Run observation is not authorized"
				: code === "capability_unavailable"
					? "Graph execution observation is unavailable"
					: "Unsupported Graph journal fact",
		);
	}
}

/**
 * The embedding host supplies principal-aware authorization, checked before every
 * read. Profile access alone is not sufficient. No raw journal payload, definition,
 * authorization reference, or arbitrary reason text crosses this boundary.
 * Local view history is not a subscription or a wire capability claim.
 */
export class GraphObservationBridge<Principal> {
	constructor(
		private readonly observation: GraphObservation,
		private readonly authorize: (principal: Principal, runId: string) => boolean | Promise<boolean>,
	) {}

	async #check(principal: Principal, runId: string): Promise<void> {
		if ((await this.authorize(principal, runId)) !== true) throw new GraphObservationBridgeError("scope_denied");
	}

	async snapshot(principal: Principal, runId: string): Promise<{ run: GraphRunSummary; cursor: GraphCursor }> {
		await this.#check(principal, runId);
		const { run, cursor } = this.observation.snapshot(runId);
		return {
			run: {
				id: run.id,
				graph_id: run.graph_id,
				revision: run.revision,
				definition_revision: run.definition_revision,
				state: run.state,
				created_at: run.created_at,
				updated_at: run.updated_at,
				...(run.hold_kind ? { hold_kind: run.hold_kind } : {}),
				...(run.observed_bot_usage ? { observed_bot_usage: run.observed_bot_usage } : {}),
			},
			cursor,
		};
	}

	/**
	 * This local view is intentionally distinct from the negotiated execution wire.
	 * Reads are authorized before and after collection, and never return protected
	 * definitions, prompts, authorization references, or consultation messages.
	 */
	async view(principal: Principal, runId: string): Promise<GraphObservationView> {
		const before = await this.snapshot(principal, runId);
		const schedule = this.observation.getScheduleState(runId);
		if (!schedule) throw new GraphObservationBridgeError("unsupported");
		const view = this.#project(runId, graphRecordedView(before.run, schedule.invocations), before.cursor);
		const after = await this.snapshot(principal, runId);
		if (
			before.cursor.journal_id !== after.cursor.journal_id ||
			before.cursor.seq !== after.cursor.seq ||
			before.run.revision !== after.run.revision
		)
			throw new GraphObservationBridgeError("unsupported");
		return view;
	}

	#project(runId: string, recorded: GraphRecordedView, cursor: GraphCursor): GraphObservationView {
		const definition = this.observation.getFrozenDefinition(runId);
		if (!definition || recorded.run.id !== runId) throw new GraphObservationBridgeError("unsupported");
		const nodes = Object.entries(definition.nodes).map(([id, node]) => ({
			id,
			kind: node.kind,
			member: node.member ?? null,
		}));
		const edges = (definition.edges ?? []).map(edge => ({
			id: edge.id,
			from: edge.from,
			to: edge.to,
			loop: edge.loop ?? null,
		}));
		const communications = (definition.communications ?? []).map(item => ({ from: item.from, to: item.to }));
		const db = this.observation.profile.db;
		const invocations: GraphObservationView["invocations"] = recorded.invocations.map(item => {
			const marker = item.consultation;
			if (marker) {
				const node = definition.nodes[item.node];
				if (
					!Object.hasOwn(definition.members, marker.member_id) ||
					!(
						item.node === `consultation:${marker.member_id}` ||
						(node?.kind === "bot" && node.member === marker.member_id)
					)
				)
					throw new GraphObservationBridgeError("unsupported");
				const row = db
					.query(`SELECT c.data AS conversation, m.data AS message FROM consultations c
						JOIN consultation_messages m ON m.conversation_id=c.id
						WHERE c.id=? AND c.run_id=? AND m.message_id=?`)
					.get(marker.conversation_id, runId, marker.message_id) as {
					conversation: string;
					message: string;
				} | null;
				const conversation = row && JSON.parse(row.conversation);
				const message = row && JSON.parse(row.message);
				if (
					!conversation ||
					conversation.id !== marker.conversation_id ||
					conversation.run_id !== runId ||
					!message ||
					message.message_id !== marker.message_id ||
					message.conversation_id !== marker.conversation_id ||
					message.recipient_member !== marker.member_id
				)
					throw new GraphObservationBridgeError("unsupported");
			} else if (!Object.hasOwn(definition.nodes, item.node)) throw new GraphObservationBridgeError("unsupported");
			return {
				id: item.id,
				kind: marker ? "consultation" : "node",
				node: marker ? null : item.node,
				member: marker?.member_id ?? null,
				state: item.state,
				iteration: item.iteration,
				scope_id: item.scope_id,
				attempt_id: item.attempt_id ?? null,
				superseded: item.superseded ?? false,
				...(Object.hasOwn(item, "outcome") ? { selected_outcome: item.outcome ?? null } : {}),
			};
		});
		const { id, graph_id, revision, definition_revision, state, created_at, updated_at } = recorded.run;
		const pulses = projectGraphPulses(this.observation.profile.db, runId, definition, recorded);
		return {
			version: 1,
			run: {
				id,
				graph_id,
				revision,
				definition_revision,
				state,
				created_at,
				updated_at,
				...(recorded.run.observed_bot_usage
					? { observed_bot_usage: structuredClone(recorded.run.observed_bot_usage) }
					: {}),
			},
			cursor,
			nodes,
			edges,
			communications,
			invocations,
			transfers: pulses.transfers,
			messages: pulses.messages,
		};
	}

	/**
	 * Replay complete local view replacements through a fixed journal watermark.
	 * Older journals without persisted replacements fail closed rather than inventing history.
	 * These views are not graph.execution.v1 records and do not enable that capability.
	 */
	async viewHistory(
		principal: Principal,
		runId: string,
		options: { after?: GraphCursor; watermark?: GraphCursor; limit?: number } = {},
	): Promise<{
		views: GraphObservationView[];
		cursor: GraphCursor;
		watermark: GraphCursor;
		next_cursor: GraphCursor | null;
	}> {
		const page = await this.events(principal, runId, options);
		this.observation.profile.assertAccess();
		const db = this.observation.profile.db;
		const query = db.query(
			"SELECT data FROM graph_observation_replacements WHERE journal_id=? AND seq=CAST(? AS INTEGER)",
		);
		const views = page.events.map(event => {
			const row = query.get(event.cursor.journal_id, event.cursor.seq) as { data: string } | null;
			if (!row) throw new GraphObservationBridgeError("capability_unavailable");
			let recorded: GraphRecordedView;
			try {
				recorded = JSON.parse(row.data) as GraphRecordedView;
			} catch {
				throw new GraphObservationBridgeError("unsupported");
			}
			if (
				!recorded ||
				!recorded.run ||
				!Array.isArray(recorded.invocations) ||
				recorded.run.id !== runId ||
				recorded.run.revision !== event.revision ||
				recorded.run.updated_at !== event.at
			)
				throw new GraphObservationBridgeError("unsupported");
			return this.#project(runId, recorded, event.cursor);
		});
		await this.#check(principal, runId);
		return { views, cursor: page.cursor, watermark: page.watermark, next_cursor: page.next_cursor };
	}

	/**
	 * Store integration must atomically persist complete, independently revisioned
	 * record replacements with each journal event and retain a baseline for state
	 * reconstruction. Also required: scoped protected-reference reads, paginated
	 * history, and synchronized consumers. Metadata-only events are not replayable
	 * execution records; until all of these exist, do not negotiate the extension.
	 */
	async extensions(principal: Principal, runId: string, _offered: readonly string[]): Promise<string[]> {
		await this.snapshot(principal, runId);
		await this.#check(principal, runId);
		return [];
	}

	/** Raw host journal facts cannot be promoted to graph.event replacement records. */
	async executionRecords(principal: Principal, runId: string): Promise<never> {
		await this.#check(principal, runId);
		throw new GraphObservationBridgeError("capability_unavailable");
	}

	async events(
		principal: Principal,
		runId: string,
		options: { after?: GraphCursor; watermark?: GraphCursor; limit?: number } = {},
	): Promise<{
		events: GraphJournalFact[];
		cursor: GraphCursor;
		watermark: GraphCursor;
		next_cursor: GraphCursor | null;
	}> {
		options = structuredClone(options);
		await this.#check(principal, runId);
		const page = this.observation.events(runId, options);
		const events = page.events.map(({ cursor, data }): GraphJournalFact => {
			if (!data || typeof data !== "object" || Array.isArray(data))
				throw new GraphObservationBridgeError("unsupported");
			const fact = data as Record<string, unknown>;
			if (
				typeof fact.type !== "string" ||
				!/^[a-z][a-z0-9_.-]{0,127}$/.test(fact.type) ||
				fact.run_id !== runId ||
				typeof fact.revision !== "string" ||
				!/^(0|[1-9][0-9]*)$/.test(fact.revision) ||
				typeof fact.at !== "string" ||
				!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(fact.at)
			)
				throw new GraphObservationBridgeError("unsupported");
			return { cursor, type: fact.type, run_id: runId, revision: fact.revision, at: fact.at };
		});
		await this.#check(principal, runId);
		return { events, cursor: page.cursor, watermark: page.watermark, next_cursor: page.next_cursor };
	}
}

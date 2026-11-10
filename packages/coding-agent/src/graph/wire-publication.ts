import type { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { GraphDefinition } from "./contracts";
import type { GraphRunRecord } from "./store";
import { validateGraphWireRecord } from "@oh-my-pi/pi-wire/graph/wire-records";
import { GraphWireError, type GraphRef, type GraphSourceRef, type GraphWireRun } from "@oh-my-pi/pi-wire/graph";

/** Resolved by trusted admission before Run creation; never accepted from GRAPH.md or browser input. */
export interface GraphPreparedObservation {
	source_id: string;
	members: Record<string, { bot: GraphSourceRef; config_revision: string; model_binding_ref: GraphRef }>;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
	);
}

/** Missing provenance is not repaired from a later Job or today's deployment configuration. */
export function validateGraphPreparedObservation(binding: GraphPreparedObservation, definition: GraphDefinition): void {
	if (
		!exact(binding, ["source_id", "members"]) ||
		typeof binding.source_id !== "string" ||
		!binding.source_id.trim() ||
		!exact(binding.members, Object.keys(definition.members))
	)
		throw new GraphWireError("invalid_input", "Observation requires a graph source and exact frozen member bindings");
	const sourceIdentities = new Map<string, string>();
	for (const member of Object.values(binding.members)) {
		if (
			!exact(member, ["bot", "config_revision", "model_binding_ref"]) ||
			typeof member.config_revision !== "string" ||
			!member.config_revision.trim() ||
			!exact(member.bot, ["source_id", "profile_id", "bot_id"]) ||
			Object.values(member.bot).some(value => typeof value !== "string" || !value.trim()) ||
			!exact(member.model_binding_ref, ["id", "digest"]) ||
			Object.values(member.model_binding_ref).some(value => typeof value !== "string" || !value.trim())
		)
			throw new GraphWireError(
				"invalid_input",
				"Observation member has incomplete source or protected model binding",
			);
		const bot = member.bot;
		const identity = canonicalJson([bot.profile_id, bot.bot_id]);
		if (
			bot.source_id === binding.source_id ||
			(sourceIdentities.has(bot.source_id) && sourceIdentities.get(bot.source_id) !== identity)
		)
			throw new GraphWireError("binding_conflict", "A source ID cannot name different Graph or Bot identities");
		sourceIdentities.set(bot.source_id, identity);
	}
}

export function installGraphWirePublicationSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS graph_wire_source_identities (
		source_id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		profile_id TEXT,
		bot_id TEXT
	)`);
}

/** Admission and source identities share the Run transaction; source IDs never change meaning. */
export function registerGraphObservationSources(db: Database, binding: GraphPreparedObservation): void {
	if (!db.inTransaction) throw new GraphWireError("invalid_input", "Source registration requires the Run transaction");
	db.transaction(() => {
		const sources = [
			{ source_id: binding.source_id, kind: "graph", profile_id: null, bot_id: null },
			...Object.values(binding.members).map(member => ({ ...member.bot, kind: "bot" })),
		];
		for (const source of sources) {
			const existing = db
				.query("SELECT source_id,kind,profile_id,bot_id FROM graph_wire_source_identities WHERE source_id=?")
				.get(source.source_id);
			if (
				(existing && canonicalJson(existing) !== canonicalJson(source)) ||
				(source.kind === "bot" &&
					db.query("SELECT 1 FROM graph_wire_sources WHERE source_id=?").get(source.source_id))
			)
				throw new GraphWireError("binding_conflict", "Deployment source identity differs from its durable binding");
			db.query("INSERT OR IGNORE INTO graph_wire_source_identities VALUES (?,?,?,?)").run(
				source.source_id,
				source.kind,
				source.profile_id,
				source.bot_id,
			);
		}
	})();
}

export function graphWireFrozenRun(
	run: GraphRunRecord,
	definition: GraphDefinition,
	binding: GraphPreparedObservation,
): GraphWireRun {
	const value: GraphWireRun = {
		graph_id: run.graph_id,
		graph_run_id: run.id,
		definition_revision: run.definition_revision,
		definition: {
			nodes: Object.entries(definition.nodes).map(([node_id, node]) => ({
				node_id,
				label: node_id,
				bot: node.kind === "bot" ? binding.members[node.member!].bot : null,
				config_revision: node.kind === "bot" ? binding.members[node.member!].config_revision : null,
				acceptance_ref: null,
			})),
			edges: (definition.edges ?? []).map(edge => ({
				edge_id: edge.id,
				from_node_id: edge.from,
				to_node_id: edge.to,
				// Conditions are protected refs, not invented from edge labels or outcome strings.
				condition_ref: null,
			})),
		},
		revision: "1",
		created_at: run.created_at,
	};
	validateGraphWireRecord({ kind: "run", value });
	return value;
}

import {
	type GraphCatalogContractSource,
	type GraphCatalogEntry,
	type GraphCatalogInput,
	type GraphCatalogOutput,
} from "@oh-my-pi/pi-wire/graph";
import type { GraphSnapshot } from "./authoring";
import { type GraphCatalogContract, readDeclaredContract } from "./contract-meta";
import type { GraphDefinition } from "./contracts";
import type { GraphLimits } from "./definition";
import { localRunSupport } from "./local-run";
import { parseGraphSource } from "./source";

export * from "./contract-meta";

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Infer a contract from the definition when the author declared none. */
function deriveContract(definition: GraphDefinition): GraphCatalogContract {
	const from = new Set((definition.edges ?? []).map(edge => edge.from));
	const inputs = new Map<string, GraphCatalogInput>();
	const outputs: GraphCatalogOutput[] = [];
	for (const [nodeKey, node] of Object.entries(definition.nodes)) {
		for (const input of Object.values(node.inputs ?? {})) {
			if (!("run_input" in input) || !input.run_input) continue;
			inputs.set(input.run_input, {
				name: input.run_input,
				description: null,
				media_type: null,
				required: true,
			});
		}
		if (from.has(nodeKey)) continue;
		for (const [name, output] of Object.entries(node.outputs ?? {}))
			outputs.push({
				name,
				description: null,
				media_type: output.media_type,
				required: output.required,
				node: nodeKey,
				output: name,
			});
	}
	return {
		summary: null,
		inputs: [...inputs.values()],
		outputs,
		report_events: [],
		stall_threshold_ms: null,
		bindings: null,
		deliverable: null,
	};
}

/**
 * Inputs a Run must supply, from the declared contract or inferred from node `run_input`.
 * Dispatch uses this so a Graph with no inputs can still be dispatched, and a missing
 * required input is reported before a detached process is spawned.
 */
export function graphInputContract(definition: GraphDefinition): GraphCatalogInput[] {
	return (readDeclaredContract(definition) ?? deriveContract(definition)).inputs;
}

/**
 * Build the read-only catalogue. A definition that cannot be parsed stays listed with an
 * explicit reason instead of disappearing, and no entry implies execution authority.
 *
 * Repeated imports of the same source produce distinct `graph_id`s with an identical
 * digest. Discovery collapses those to one row per distinct content — otherwise a
 * dispatcher sees N indistinguishable entries and has to guess. The retained entry records
 * how many it absorbed, and every id stays addressable by explicit `graph_id`.
 */
export function buildGraphCatalog(snapshots: GraphSnapshot[], limits: GraphLimits): GraphCatalogEntry[] {
	const entries = snapshots.map(snapshot => buildCatalogEntry(snapshot, limits));
	const seen = new Map<string, GraphCatalogEntry>();
	for (const entry of entries) {
		const key = `${entry.name}\u0000${entry.digest}`;
		const retained = seen.get(key);
		if (!retained) {
			seen.set(key, entry);
			continue;
		}
		retained.duplicates = (retained.duplicates ?? 0) + 1;
	}
	return entries.filter(entry => seen.get(`${entry.name}\u0000${entry.digest}`) === entry);
}

function buildCatalogEntry(snapshot: GraphSnapshot, limits: GraphLimits): GraphCatalogEntry {
	let definition: GraphDefinition | null = null;
	let reason: string | null = null;
	try {
		definition = parseGraphSource(snapshot.content, limits).frontmatter.frontmatter as unknown as GraphDefinition;
	} catch (error) {
		reason = error instanceof Error ? error.message : "Definition could not be parsed";
	}
	const empty: GraphCatalogEntry = {
		graph_id: snapshot.graph_id,
		revision: snapshot.revision,
		digest: snapshot.digest,
		name: snapshot.graph_id,
		summary: null,
		contract_source: "derived",
		inputs: [],
		outputs: [],
		report_events: [],
		stall_threshold_ms: null,
		members: [],
		nodes: 0,
		local_run: { supported: false, reason: reason ?? "Definition could not be parsed" },
	};
	if (!definition) return empty;
	const declared = readDeclaredContract(definition);
	const contract = declared ?? deriveContract(definition);
	const source: GraphCatalogContractSource = declared ? "declared" : "derived";
	return {
		...empty,
		name: text(definition.name) ?? snapshot.graph_id,
		summary: contract.summary,
		contract_source: source,
		inputs: contract.inputs,
		outputs: contract.outputs,
		report_events: contract.report_events,
		stall_threshold_ms: contract.stall_threshold_ms,
		...(contract.bindings ? { bindings: contract.bindings } : {}),
		...(contract.deliverable ? { deliverable: contract.deliverable } : {}),
		members: Object.entries(definition.members ?? {}).map(([key, member]) => ({
			key,
			duty: member.duty,
			model: member.model,
		})),
		nodes: Object.keys(definition.nodes ?? {}).length,
		local_run: localRunSupport(definition),
	};
}

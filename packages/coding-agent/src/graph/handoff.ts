import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { GraphRef, GraphWireBinding, GraphWireEvidence } from "@oh-my-pi/pi-wire/graph";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Receipt } from "../bots/types";
import type { GraphDefinition } from "./contracts";
import type { GraphAttemptCompletion, GraphDispatchIntent, GraphStoredInvocation } from "./store";
import { graphReadyEdgeSelected } from "./scheduler";
import handoffInput from "./handoff-input.md" with { type: "text" };

export interface GraphBotHandoff {
	edge_id: string;
	from_binding_id: string;
	input: string;
	output: string;
	reference: GraphRef;
	artifact: GraphWireEvidence;
}

/** Frozen before mailbox admission; only the receipt can advance this evidence to delivered. */
export interface GraphBotHandoffRecord {
	intent_id: string;
	run_id: string;
	invocation_id: string;
	attempt_id: string;
	fence: string;
	request_key: string;
	bot_id: string;
	input: string;
	handoffs: GraphBotHandoff[];
	receipt: Receipt | null;
	occurred_at: string | null;
}

/** Use selected input mappings and accepted source attempts, never the source's latest outputs. */
export function selectGraphBotHandoffs(
	definition: GraphDefinition,
	target: GraphStoredInvocation,
	intent: GraphDispatchIntent,
	bindings: Map<string, GraphWireBinding>,
	history: GraphAttemptCompletion[],
	sources: GraphStoredInvocation[],
): GraphBotHandoff[] {
	if (target.consultation || definition.nodes[target.node]?.kind !== "bot" || !target.ready) return [];
	const handoffs: GraphBotHandoff[] = [];
	for (const edge of definition.edges ?? []) {
		const sourceId = target.upstream[edge.id];
		if (edge.to !== target.node || !sourceId || !target.ready.upstream_invocation_ids.includes(sourceId)) continue;
		if (definition.nodes[edge.from]?.kind !== "bot") continue;
		const completions = history.filter(
			completion =>
				completion.invocation_id === sourceId &&
				completion.state === "succeeded" &&
				target.ready!.upstream_attempt_ids.includes(completion.attempt_id),
		);
		if (completions.length !== 1) continue;
		const completion = completions[0];
		const invocation = sources.find(source => source.id === sourceId);
		if (
			!invocation ||
			!graphReadyEdgeSelected(definition, target, invocation, edge) ||
			invocation.attempt_id !== completion.attempt_id
		)
			continue;
		const source = bindings.get(completion.attempt_id);
		if (!source || source.node_id !== edge.from || source.graph_run_id !== intent.run_id) continue;
		for (const [input, output] of Object.entries(edge.bind ?? {})) {
			const reference = completion.outputs?.[output];
			if (
				!reference ||
				target.ready.inputs[input] === undefined ||
				canonicalJson(target.ready.inputs[input]) !== canonicalJson(reference)
			)
				continue;
			handoffs.push({
				edge_id: edge.id,
				from_binding_id: source.binding_id,
				input,
				output,
				reference,
				artifact: {
					source: {
						source_id: source.job.source_id,
						profile_id: source.job.profile_id,
						bot_id: source.job.bot_id,
					},
					job_id: source.job.job_id,
					artifact_id: reference.id,
					ref: reference.id,
				},
			});
		}
	}
	return handoffs;
}

export function renderGraphBotHandoff(
	input: string,
	record: Omit<GraphBotHandoffRecord, "input" | "receipt" | "occurred_at">,
): string {
	return prompt.render(handoffInput, { input, handoffs: record.handoffs });
}

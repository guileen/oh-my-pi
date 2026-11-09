import type { GraphCatalogDeliverable, GraphCatalogInput, GraphCatalogOutput } from "@oh-my-pi/pi-wire/graph";
import type { GraphDefinition } from "./contracts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function positive(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface GraphCatalogContract {
	summary: string | null;
	inputs: GraphCatalogInput[];
	outputs: GraphCatalogOutput[];
	report_events: string[];
	stall_threshold_ms: number | null;
	bindings: string | null;
	deliverable: GraphCatalogDeliverable | null;
}

/**
 * Read `extensions.x-contract`, the only extension that carries discovery metadata.
 * Kept free of catalog and executor imports so the Run store can read a frozen
 * definition's declared stall threshold without importing the execution layer.
 */
export function readDeclaredContract(definition: GraphDefinition): GraphCatalogContract | null {
	const contract = object(definition.extensions?.["x-contract"]);
	if (!contract) return null;
	const inputs: GraphCatalogInput[] = [];
	for (const [name, raw] of Object.entries<unknown>(object(contract.inputs) ?? {})) {
		const value = object(raw);
		if (!value) continue;
		inputs.push({
			name,
			description: text(value.description),
			media_type: text(value.media_type),
			required: value.required !== false,
		});
	}
	const outputs: GraphCatalogOutput[] = [];
	for (const [name, raw] of Object.entries<unknown>(object(contract.outputs) ?? {})) {
		const value = object(raw);
		if (!value) continue;
		outputs.push({
			name,
			description: text(value.description),
			media_type: text(value.media_type),
			required: value.required !== false,
			node: text(value.node),
			output: text(value.output),
		});
	}
	const report_events = Array.isArray(contract.report_events)
		? contract.report_events.filter((event): event is string => typeof event === "string")
		: [];
	const rawDeliverable = object(contract.deliverable);
	const deliverable: GraphCatalogDeliverable | null = rawDeliverable
		? {
				summary: text(rawDeliverable.summary),
				experience: text(rawDeliverable.experience),
				// Only declared outputs can reach a human; unknown names would overstate the hand-off.
				artifacts: (Array.isArray(rawDeliverable.artifacts) ? rawDeliverable.artifacts : [])
					.filter((name): name is string => typeof name === "string")
					.filter(name => outputs.some(output => output.name === name)),
			}
		: null;
	return {
		summary: text(contract.summary),
		inputs,
		outputs,
		report_events,
		stall_threshold_ms: positive(contract.stall_threshold_ms),
		bindings: text(contract.bindings),
		deliverable,
	};
}

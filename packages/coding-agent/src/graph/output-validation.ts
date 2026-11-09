import { validateJsonSchemaStrict, validateJsonSchemaValueStrict } from "@oh-my-pi/pi-ai/utils/schema";
import type { LocalArtifactStore } from "./artifacts";
import type { GraphOutput } from "./contracts";

function parseJson(bytes: Uint8Array, label: string): unknown {
	try {
		// Preserve the original bytes: reject invalid UTF-8/BOM rather than silently
		// replacing characters or stripping a prefix before JSON parsing.
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
	} catch {
		throw new Error(`${label} must contain valid UTF-8 JSON`);
	}
}

/** Read the exact immutable, authorized schema and reject unsupported semantics even for absent optional outputs. */
export async function readGraphOutputSchema(
	declaration: GraphOutput,
	principal: string,
	store: LocalArtifactStore,
): Promise<unknown> {
	if (!declaration.schema_ref) return undefined;
	const schema = parseJson(await store.read(principal, declaration.schema_ref), "Graph output schema");
	const checked = validateJsonSchemaStrict(schema);
	if (!checked.success) throw new Error(`Invalid Graph output schema: ${checked.issues[0]?.message}`);
	return schema;
}

/** Validate original artifact bytes, without normalization, mutation, coercion or data repair. */
export async function validateGraphOutputContent(
	declaration: GraphOutput,
	bytes: Uint8Array,
	principal: string,
	store: LocalArtifactStore,
): Promise<void> {
	if (!declaration.schema_ref) return;
	const schema = parseJson(await store.read(principal, declaration.schema_ref), "Graph output schema");
	const result = validateJsonSchemaValueStrict(schema, parseJson(bytes, "Graph output"));
	if (!result.success) throw new Error(`Graph output schema validation failed: ${result.issues[0]?.message}`);
}

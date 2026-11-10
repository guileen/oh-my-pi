import { parseLocalRefPointer } from "@oh-my-pi/omptype";
import { isRecord } from "@oh-my-pi/pi-utils";
import { validateJsonSchemaValue, type JsonSchemaValidationResult } from "./json-schema-validator";
import { isValidJsonSchema } from "./meta-validator";

const ANNOTATIONS: Record<string, true> = {
	title: true,
	description: true,
	$comment: true,
	default: true,
	examples: true,
	deprecated: true,
	readOnly: true,
	writeOnly: true,
};
const MAPS = ["$defs", "properties", "patternProperties", "dependentSchemas"] as const;
const ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SCHEMAS = ["not", "if", "then", "else", "items", "contains", "propertyNames", "additionalProperties"] as const;
const KEYWORDS: Record<string, true> = {
	...ANNOTATIONS,
	$defs: true,
	properties: true,
	patternProperties: true,
	dependentSchemas: true,
	allOf: true,
	anyOf: true,
	oneOf: true,
	prefixItems: true,
	not: true,
	if: true,
	then: true,
	else: true,
	items: true,
	contains: true,
	propertyNames: true,
	additionalProperties: true,
	$schema: true,
	$ref: true,
	type: true,
	enum: true,
	const: true,
	required: true,
	dependentRequired: true,
	minProperties: true,
	maxProperties: true,
	minItems: true,
	maxItems: true,
	uniqueItems: true,
	minContains: true,
	maxContains: true,
	minLength: true,
	maxLength: true,
	pattern: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
};
const TYPES: Record<string, true> = {
	null: true,
	boolean: true,
	object: true,
	array: true,
	number: true,
	integer: true,
	string: true,
};

const MAX_JSON_NODES = 10_000;
const MAX_DEPTH = 64;
const MAX_SCHEMA_EXPANSION = 10_000;
const MAX_SCHEMA_DATA_PRODUCT = 100_000;

/** Count the JSON tree before invoking recursive validators; reject aliases/cycles
 * once their expanded tree exceeds the same depth/node limits as parsed JSON. */
function finiteJsonSize(value: unknown): number | null {
	const stack = [{ value, depth: 0 }];
	let count = 0;
	while (stack.length) {
		const entry = stack.pop()!;
		if (++count > MAX_JSON_NODES || entry.depth >= MAX_DEPTH) return null;
		const current = entry.value;
		if (current === null || typeof current === "string" || typeof current === "boolean") continue;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) return null;
			continue;
		}
		if (!isRecord(current) && !Array.isArray(current)) return null;
		if (!Array.isArray(current)) {
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) return null;
		}
		const children = Array.isArray(current) ? current : Object.values(current);
		if (children.length > MAX_JSON_NODES - count - stack.length) return null;
		for (const child of children) stack.push({ value: child, depth: entry.depth + 1 });
	}
	return count;
}

/**
 * Fail-closed validation of a deliberately restricted 2020-12 subset, without
 * coercion or repair. Unknown keywords, format/content assertions, unevaluated*,
 * dialect/resource changes, recursive refs and multipleOf are unsupported. The
 * latter cannot use the permissive floating-point tolerance of tool validation.
 * Local acyclic JSON-pointer refs are supported only without assertion siblings
 * (the tool validator otherwise ignores those siblings). All schema locations,
 * including unused definitions/branches, are checked before evaluating data.
 */
function checkSchemaStrict(schema: unknown, expansionLimit: number): JsonSchemaValidationResult {
	try {
		if (finiteJsonSize(schema) === null || !isValidJsonSchema(schema))
			return failure("Malformed or oversized JSON Schema");
		let problem = "Unsupported JSON Schema semantics";
		const active = new Set<object>();
		let remaining = expansionLimit;
		const visit = (node: unknown, depth: number): boolean => {
			if (--remaining < 0) {
				problem = "JSON Schema expansion limit exceeded";
				return false;
			}
			if (typeof node === "boolean") return true;
			if (!isRecord(node) || depth >= MAX_DEPTH || active.has(node)) return false;
			active.add(node);
			try {
				for (const key of Object.keys(node)) {
					if (!Object.hasOwn(KEYWORDS, key)) {
						problem = `Unsupported JSON Schema keyword '${key}'`;
						return false;
					}
				}
				if (
					"$schema" in node &&
					(node !== schema || node.$schema !== "https://json-schema.org/draft/2020-12/schema")
				)
					return false;
				if ("type" in node) {
					const types = Array.isArray(node.type) ? node.type : [node.type];
					if (types.some(type => typeof type !== "string" || !Object.hasOwn(TYPES, type))) return false;
				}
				for (const key of ["title", "description", "$comment"])
					if (key in node && typeof node[key] !== "string") return false;
				if ("examples" in node && !Array.isArray(node.examples)) return false;
				for (const key of ["exclusiveMinimum", "exclusiveMaximum"])
					if (key in node && typeof node[key] !== "number") return false;
				if (isRecord(node.dependentRequired)) {
					for (const dependencies of Object.values(node.dependentRequired)) {
						if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length) return false;
					}
				}
				if ("pattern" in node) {
					if (typeof node.pattern !== "string") return false;
					new RegExp(node.pattern, "u");
				}
				if ("$ref" in node) {
					if (typeof node.$ref !== "string") return false;
					if (
						Object.keys(node).some(
							key => key !== "$ref" && key !== "$defs" && key !== "$schema" && !Object.hasOwn(ANNOTATIONS, key),
						)
					)
						return false;
					const pointer = parseLocalRefPointer(node.$ref);
					if (!pointer || /~(?:[^01]|$)/.test(decodeURIComponent(node.$ref.slice(1)))) return false;
					let target: unknown = schema;
					for (const token of pointer) {
						if ((!isRecord(target) && !Array.isArray(target)) || !Object.hasOwn(target, token)) return false;
						target = (target as Record<string, unknown>)[token];
					}
					if (!visit(target, depth + 1)) return false;
				}
				for (const key of MAPS) {
					if (!(key in node)) continue;
					const children = node[key];
					if (!isRecord(children)) return false;
					for (const [name, child] of Object.entries(children)) {
						if (key === "patternProperties") new RegExp(name, "u");
						if (!visit(child, depth + 1)) return false;
					}
				}
				for (const key of ARRAYS) {
					if (!(key in node)) continue;
					const children = node[key];
					if (
						!Array.isArray(children) ||
						children.length === 0 ||
						!children.every(child => visit(child, depth + 1))
					)
						return false;
				}
				for (const key of SCHEMAS) if (key in node && !visit(node[key], depth + 1)) return false;
				return true;
			} finally {
				active.delete(node);
			}
		};
		if (!visit(schema, 0)) return failure(problem);
		return { success: true, issues: [] };
	} catch {
		return failure("Malformed or unsupported JSON Schema/data");
	}
}

export function validateJsonSchemaStrict(schema: unknown): JsonSchemaValidationResult {
	return checkSchemaStrict(schema, MAX_SCHEMA_EXPANSION);
}

function failure(message: string): JsonSchemaValidationResult {
	return { success: false, issues: [{ path: [], keyword: "schema", message }] };
}

/** Validate original JSON data only after every declared schema capability is checked. */
export function validateJsonSchemaValueStrict(schema: unknown, value: unknown): JsonSchemaValidationResult {
	try {
		const size = finiteJsonSize(value);
		if (size === null) return failure("Output is not a finite JSON tree within depth/node limits");
		// Count expanded paths, not just unique schema objects: the evaluator follows
		// each incoming ref. Memoizing preflight alone would leave evaluation exponential.
		const supported = checkSchemaStrict(
			schema,
			Math.min(MAX_SCHEMA_EXPANSION, Math.floor(MAX_SCHEMA_DATA_PRODUCT / size)),
		);
		if (!supported.success) return supported;
		return validateJsonSchemaValue(schema, value);
	} catch {
		return failure("Malformed or unsupported JSON Schema/data");
	}
}

import { describe, expect, it } from "bun:test";
import { validateJsonSchemaStrict, validateJsonSchemaValueStrict } from "../src/utils/schema/strict-value-validation";
import { validateJsonSchemaValue } from "../src/utils/schema/json-schema-validator";

const valid = (schema: unknown, value: unknown) => validateJsonSchemaValueStrict(schema, value).success;

describe("strict immutable JSON Schema validation", () => {
	it("honors boolean schemas and never coerces, defaults or deletes data", () => {
		expect(valid(true, { anything: [1, null] })).toBe(true);
		expect(valid(false, {})).toBe(false);
		expect(valid({ type: "integer" }, "1")).toBe(false);
		const data = { extra: "keep" };
		const schema = { properties: { count: { default: 1 } }, required: ["count"], additionalProperties: false };
		expect(valid(schema, data)).toBe(false);
		expect(data).toEqual({ extra: "keep" });
		expect(valid(true, { nested: [Infinity] })).toBe(false);
		expect(valid({ not: { const: 0 } }, -0)).toBe(false);
		expect(valid({ uniqueItems: true }, [0, -0])).toBe(false);
		expect(valid({ const: JSON.parse('{"__proto__":{}}') }, { other: 1 })).toBe(false);
	});

	it("enforces ordinary composition and acyclic immutable local references", () => {
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$defs: { "escaped/key": { type: "integer", minimum: 2 } },
			type: "object",
			properties: { count: { $ref: "#/$defs/escaped~1key" }, mode: { enum: ["on", "off"] } },
			required: ["count"],
			additionalProperties: false,
			if: { properties: { mode: { const: "on" } }, required: ["mode"] },
			then: { properties: { count: { maximum: 3 } } },
			else: { not: { properties: { count: { const: 4 } } } },
		};
		const original = JSON.stringify(schema);
		expect(valid(schema, { count: 2, mode: "on" })).toBe(true);
		expect(valid(schema, { count: 1 })).toBe(false);
		expect(valid(schema, { count: 4, mode: "on" })).toBe(false);
		expect(valid(schema, { count: 4, mode: "off" })).toBe(false);
		expect(valid(schema, { count: 2, extra: true })).toBe(false);
		expect(JSON.stringify(schema)).toBe(original);
	});

	it("enforces tuple, contains, object dependencies, patterns and numeric bounds", () => {
		const array = {
			type: "array",
			prefixItems: [{ type: "string" }],
			items: { type: "integer" },
			contains: { const: 2 },
			minContains: 1,
			maxContains: 1,
			uniqueItems: true,
		};
		expect(valid(array, ["label", 1, 2])).toBe(true);
		expect(valid(array, ["label", 1])).toBe(false);
		expect(valid(array, ["label", 2, 2])).toBe(false);
		expect(valid(array, ["label", "2"])).toBe(false);
		const object = {
			type: "object",
			patternProperties: { "^x": { type: "integer", exclusiveMinimum: 0, maximum: 3 } },
			propertyNames: { pattern: "^[a-z]+$" },
			dependentRequired: { x: ["y"] },
			dependentSchemas: { y: { required: ["x"] } },
			minProperties: 2,
			maxProperties: 2,
		};
		expect(valid(object, { x: 2, y: true })).toBe(true);
		expect(valid(object, { x: 0, y: true })).toBe(false);
		expect(valid(object, { x: 2 })).toBe(false);
		expect(valid(object, { y: true, z: true })).toBe(false);
	});

	it("uses JSON own-property presence and Unicode character lengths", () => {
		expect(valid({ required: ["constructor"] }, {})).toBe(false);
		expect(valid({ dependentRequired: { x: ["constructor"] } }, { x: true })).toBe(false);
		expect(valid({ dependentSchemas: { constructor: false } }, {})).toBe(true);
		expect(valid({ properties: { constructor: false } }, {})).toBe(true);
		expect(valid({ minLength: 1, maxLength: 1 }, "😀")).toBe(true);
		expect(valid({ minLength: 2 }, "😀")).toBe(false);
	});

	it("matches Unicode codepoints and property names rather than UTF-16 halves", () => {
		expect(valid({ pattern: "^.$" }, "😀")).toBe(true);
		expect(valid({ pattern: "^..$" }, "😀")).toBe(false);
		expect(valid({ pattern: "^\\p{L}+$" }, "汉字")).toBe(true);
		expect(valid({ pattern: "^\\p{L}+$" }, "123")).toBe(false);
		const schema = { patternProperties: { "^.$": { type: "integer" } }, additionalProperties: false };
		expect(valid(schema, { "😀": 1 })).toBe(true);
		expect(valid(schema, { "😀": "not-an-integer" })).toBe(false);
		expect(validateJsonSchemaStrict({ pattern: "\\u{" }).success).toBe(false);
	});

	it("rejects excessive schema expansion and deeply nested data before consuming the host", () => {
		const definitions: Record<string, unknown> = { leaf: { type: "integer" } };
		let previous = "leaf";
		for (let index = 0; index < 16; index++) {
			const name = `level${index}`;
			definitions[name] = { allOf: [{ $ref: `#/$defs/${previous}` }, { $ref: `#/$defs/${previous}` }] };
			previous = name;
		}
		const schema = { $defs: definitions, $ref: `#/$defs/${previous}` };
		expect(validateJsonSchemaStrict(schema).success).toBe(false);
		let nested: unknown = null;
		for (let index = 0; index < 80; index++) nested = [nested];
		expect(valid(true, nested)).toBe(false);
	});

	it("rejects non-JSON objects and ignores inherited fields in ordinary JSON validation", () => {
		expect(valid(true, new Date())).toBe(false);
		expect(valid(true, new Map())).toBe(false);
		const inherited: unknown = Object.create({ hidden: 1 });
		expect(validateJsonSchemaValue({ const: {} }, inherited).success).toBe(true);
		expect(validateJsonSchemaValue({ const: inherited }, {}).success).toBe(true);
		expect(validateJsonSchemaValue({ patternProperties: { "^hidden$": false } }, inherited).success).toBe(true);
		expect(validateJsonSchemaValue({ additionalProperties: false }, inherited).success).toBe(true);
		expect(validateJsonSchemaValue({ additionalProperties: { type: "string" } }, inherited).success).toBe(true);
		expect(valid(true, inherited)).toBe(false);
	});

	it.each([
		{ unevaluatedProperties: false },
		{ unevaluatedItems: true },
		{ format: "email" },
		{ contentSchema: false },
		{ contentEncoding: "base64" },
		{ nullable: true },
		{ multipleOf: 0.1 },
		{ unknownAssertion: true },
		{ $id: "https://example.test/schema" },
		{ $anchor: "node" },
		{ $dynamicRef: "#node" },
		{ $ref: "https://example.test/schema" },
		{ $ref: "#missing" },
		{ $ref: "#/$defs/value", $defs: { value: true }, const: 2 },
		{ $ref: "#/$defs/constructor", $defs: {} },
		{ $ref: "#/$defs/a~2b", $defs: { "a~2b": true } },
		{ $ref: "#" },
		{ $defs: { loop: { $ref: "#/$defs/loop" } } },
		{ anyOf: [true, { format: "email" }] },
		{ $defs: { unused: { unevaluatedItems: false } } },
		{ patternProperties: { "[": true } },
		{ type: ["constructor", "string"] },
		{ allOf: [] },
		{ prefixItems: [] },
		{ exclusiveMinimum: true },
		{ dependentRequired: { x: ["y", "y"] } },
		{ title: 42 },
		{ $schema: "https://json-schema.org/draft/2019-09/schema" },
	])("rejects unsupported or malformed schema before evaluating any data: %j", schema => {
		expect(validateJsonSchemaStrict(schema).success).toBe(false);
		expect(valid(schema, null)).toBe(false);
	});
});

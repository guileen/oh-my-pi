import { describe, expect, it } from "bun:test";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";

describe("canonicalJson", () => {
	it("sorts nested record keys while preserving array order and JSON escaping", () => {
		expect(canonicalJson({ z: [true, null, '\n"', -0], a: { y: 2, x: 1 } })).toBe(
			'{"a":{"x":1,"y":2},"z":[true,null,"\\n\\\"",0]}',
		);
	});

	it("serializes shared references without treating them as cycles", () => {
		const shared = Object.freeze({ z: 1, a: 2 });
		const value = Object.freeze([shared, shared]);
		expect(canonicalJson(value)).toBe('[{"a":2,"z":1},{"a":2,"z":1}]');
	});

	it("rejects undefined nested data, non-finite numbers, and object instances instead of losing information", () => {
		expect(() => canonicalJson({ nested: undefined })).toThrow();
		expect(() => canonicalJson(Number.NaN)).toThrow();
		expect(() => canonicalJson(new Date(0))).toThrow();
	});

	it("rejects sparse arrays and cycles", () => {
		const sparse: unknown[] = [];
		sparse.length = 1;
		expect(() => canonicalJson(sparse)).toThrow();
		const record: Record<string, unknown> = {};
		record.self = record;
		expect(() => canonicalJson(record)).toThrow();
		const array: unknown[] = [];
		array.push(array);
		expect(() => canonicalJson(array)).toThrow();
	});
});

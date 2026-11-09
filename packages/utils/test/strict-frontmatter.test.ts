import { describe, expect, it } from "bun:test";
import { parseStrictFrontmatter } from "../src/strict-frontmatter";

const limits = { maxBytes: 1024, maxDepth: 8, maxAliases: 100, maxNodes: 100 };

describe("strict frontmatter", () => {
	it("preserves the body and original line endings while accepting shared aliases", () => {
		const source = "---\r\na: &item [one]\r\nb: *item\r\n---\r\n\r\nBody\r\n";
		const result = parseStrictFrontmatter(source, limits);
		expect(result.frontmatter).toEqual({ a: ["one"], b: ["one"] });
		expect(result.body).toBe("\r\nBody\r\n");
		expect(result.metadataOffset).toBe(5);
	});

	it("rejects duplicate keys and recursive aliases rather than silently changing a definition", () => {
		expect(() => parseStrictFrontmatter("---\na: 1\na: 2\n---\n", limits)).toThrow();
		expect(() => parseStrictFrontmatter("---\na: &a [*a]\n---\n", limits)).toThrow("Recursive YAML alias");
	});

	it("rejects incomplete documents and resource limits", () => {
		expect(() => parseStrictFrontmatter("---\na: 1\n", limits)).toThrow("closing");
		expect(() => parseStrictFrontmatter("---\na: [1]\n---\n", { ...limits, maxBytes: 5 })).toThrow("byte limit");
		expect(() => parseStrictFrontmatter("---\na: [1]\n---\n", { ...limits, maxDepth: 1 })).toThrow("depth limit");
		expect(() => parseStrictFrontmatter("---\na: [1, 2]\n---\n", { ...limits, maxNodes: 2 })).toThrow("node limit");
		expect(() => parseStrictFrontmatter("---\na: 1\n---\n", { ...limits, maxAliases: -1 })).toThrow("limits");
		expect(() =>
			parseStrictFrontmatter("---\na: &item [1]\nb: {nested: *item}\n---\n", { ...limits, maxDepth: 2 }),
		).toThrow("depth limit");
	});
});

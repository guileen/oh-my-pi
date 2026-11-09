import { describe, expect, it } from "bun:test";
import { parseGraphSource } from "../src/graph/source";

const limits = { maxBytes: 4096, maxDepth: 16, maxAliases: 100, maxNodes: 100 };

describe("Graph source parsing", () => {
	it("preserves source and locates real sections, excluding fenced examples", () => {
		const source =
			"---\r\nformat: omp.graph/v1\r\nname: test\r\nmembers: {}\r\nnodes: {}\r\n---\r\n\r\n```md\r\n## ignored\r\n```\r\n## task\r\nText.\r\n";
		const parsed = parseGraphSource(source, limits);
		expect(parsed.source).toBe(source);
		expect([...parsed.headings]).toEqual([["task", 11]]);
	});

	it("does not treat setext prose headings as addressable task sections", () => {
		const source = "---\nname: test\n---\ntask\n----\n";
		expect(parseGraphSource(source, limits).headings.has("task")).toBe(false);
	});
	it("extracts exact task bodies without absorbing later sections or fenced headings", () => {
		const source =
			"---\r\nname: test\r\n---\r\n## task\r\nFirst.\r\n### Detail\r\n```md\r\n## not-a-section\r\n```\r\n## other\r\nSecond.\r\n# End\r\nOutside.\r\n";
		const parsed = parseGraphSource(source, limits);
		expect(parsed.sections.get("task")).toBe("First.\r\n### Detail\r\n```md\r\n## not-a-section\r\n```\r\n");
		expect(parsed.sections.get("other")).toBe("Second.\r\n");
		expect(parsed.sections.has("not-a-section")).toBe(false);
	});

	it("rejects duplicate task sections without treating code fences as duplicates", () => {
		const source = "---\nname: test\n---\n## task\nFirst.\n\n```\n## task\n```\n\n## task\nSecond.\n";
		expect(() => parseGraphSource(source, limits)).toThrow("Duplicate heading 'task' at line 11; first at line 4");
	});
});

import { lexer } from "@oh-my-pi/pi-utils/marked/core";
import { parseStrictFrontmatter, type StrictFrontmatter } from "@oh-my-pi/pi-utils/strict-frontmatter";

export interface GraphSource {
	/** The untouched input is the authority for export and revision digests. */
	source: string;
	frontmatter: StrictFrontmatter;
	/** One-based source lines for addressable level-two headings. */
	headings: ReadonlyMap<string, number>;
	/** Exact original body of each addressable section, excluding its heading. */
	sections: ReadonlyMap<string, string>;
}

export class GraphSourceError extends Error {
	constructor(
		message: string,
		readonly location: { file: string; path: string; line: number; column: number },
	) {
		super(message);
	}
}

/** Parse the source document; callers must separately validate the definition before execution. */
export function parseGraphSource(
	source: string,
	limits: { maxBytes: number; maxDepth: number; maxAliases: number; maxNodes: number },
): GraphSource {
	let frontmatter: StrictFrontmatter;
	try {
		frontmatter = parseStrictFrontmatter(source, limits);
	} catch (error) {
		if (error instanceof Error && "pos" in error && Array.isArray(error.pos) && typeof error.pos[0] === "number") {
			const opening = /^---(?:\r\n|\n|\r)/.exec(source);
			const before = source.slice(0, (opening?.[0].length ?? 0) + error.pos[0]).split(/\r\n|\r|\n/);
			throw new GraphSourceError(error.message, {
				file: "GRAPH.md",
				path: "",
				line: before.length,
				column: before[before.length - 1].length + 1,
			});
		}
		throw error;
	}
	const headings = new Map<string, number>();
	const sections = new Map<string, string>();
	const lineOffsets = [0];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "\r" && source[i + 1] === "\n") i++;
		if (source[i] === "\n" || source[i] === "\r") lineOffsets.push(i + 1);
	}
	let section: { key: string; start: number } | undefined;
	const normalized = frontmatter.body.replace(/\r\n|\r/g, "\n").replace(/\t/g, "    ");
	let offset = 0;
	let line = source.slice(0, source.length - frontmatter.body.length).split(/\r\n|\r|\n/).length;
	for (const token of lexer(normalized)) {
		const position = normalized.indexOf(token.raw, offset);
		if (position < 0) throw new Error("Unable to locate Markdown token in source");
		line += countNewlines(normalized, offset, position);
		if (token.type === "heading" && token.depth <= 2 && section) {
			sections.set(section.key, source.slice(section.start, lineOffsets[line - 1] ?? source.length));
			section = undefined;
		}
		if (
			token.type === "heading" &&
			token.depth === 2 &&
			typeof token.text === "string" &&
			/^ {0,3}##[ \t]+/.test(token.raw)
		) {
			const key = token.text.trim();
			if (/^[a-z][a-z0-9-]*$/.test(key)) {
				const previous = headings.get(key);
				if (previous !== undefined)
					throw new GraphSourceError(`Duplicate heading '${key}' at line ${line}; first at line ${previous}`, {
						file: "GRAPH.md",
						path: "",
						line,
						column: 1,
					});
				headings.set(key, line);
				section = { key, start: lineOffsets[line] ?? source.length };
			}
		}
		line += countNewlines(normalized, position, position + token.raw.length);
		offset = position + token.raw.length;
	}
	if (section) sections.set(section.key, source.slice(section.start));
	return { source, frontmatter, headings, sections };
}

function countNewlines(text: string, start: number, end: number): number {
	let count = 0;
	for (let i = start; i < end; i++) if (text.charCodeAt(i) === 10) count++;
	return count;
}

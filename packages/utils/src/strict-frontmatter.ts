import { isMap, isSeq, LineCounter, parseDocument, type Document } from "yaml";

export interface StrictFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
	/** YAML syntax tree; offsets are relative to metadataOffset in the original source. */
	document: Document;
	lineCounter: LineCounter;
	metadataOffset: number;
}

/** Parse an unmodified Markdown document without accepting duplicate YAML keys or recursive aliases. */
export function parseStrictFrontmatter(
	content: string,
	limits: { maxBytes: number; maxDepth: number; maxAliases: number; maxNodes: number },
): StrictFrontmatter {
	if (
		[limits.maxBytes, limits.maxDepth, limits.maxAliases, limits.maxNodes].some(
			limit => !Number.isSafeInteger(limit) || limit < 0,
		)
	) {
		throw new Error("Frontmatter limits must be nonnegative safe integers");
	}
	if (Buffer.byteLength(content, "utf8") > limits.maxBytes) throw new Error("Frontmatter document exceeds byte limit");
	const opening = /^---(?:\r\n|\n|\r)/.exec(content);
	if (!opening) throw new Error("Missing opening frontmatter delimiter");
	const metadataOffset = opening[0].length;
	const closing = /^---[ \t]*(?:\r\n|\n|\r|$)/m.exec(content.slice(metadataOffset));
	if (!closing) throw new Error("Missing closing frontmatter delimiter");
	const metadata = content.slice(metadataOffset, metadataOffset + closing.index);
	const lineCounter = new LineCounter();
	const document = parseDocument(metadata, { lineCounter, uniqueKeys: true, prettyErrors: false });
	if (document.errors.length > 0) throw document.errors[0];
	if (document.warnings.length > 0) throw document.warnings[0];
	const syntax: { node: unknown; depth: number }[] = [{ node: document.contents, depth: 0 }];
	let nodeCount = 0;
	while (syntax.length > 0) {
		const { node, depth } = syntax.pop()!;
		if (++nodeCount > limits.maxNodes) throw new Error("Frontmatter exceeds node limit");
		if (depth > limits.maxDepth) throw new Error("Frontmatter exceeds depth limit");
		if (isMap(node)) {
			for (const pair of node.items) {
				syntax.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
			}
		} else if (isSeq(node)) {
			for (const item of node.items) syntax.push({ node: item, depth: depth + 1 });
		}
	}
	const value: unknown = document.toJS({ maxAliasCount: limits.maxAliases });
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Frontmatter must be a mapping");

	const ancestors = new Set<object>();
	const visitedDepth = new Map<object, number>();
	const pending: { value: unknown; depth: number; leaving: boolean }[] = [{ value, depth: 0, leaving: false }];
	while (pending.length > 0) {
		const current = pending.pop()!;
		const item = current.value;
		if (current.depth > limits.maxDepth) throw new Error("Frontmatter exceeds depth limit");
		if (item === null || typeof item !== "object") continue;
		if (current.leaving) {
			ancestors.delete(item);
			continue;
		}
		if (ancestors.has(item)) throw new Error("Recursive YAML alias");
		const previous = visitedDepth.get(item);
		if (previous !== undefined && previous >= current.depth) continue;
		visitedDepth.set(item, current.depth);
		ancestors.add(item);
		pending.push({ value: item, depth: current.depth, leaving: true });
		for (const child of Object.values(item)) {
			pending.push({ value: child, depth: current.depth + 1, leaving: false });
		}
	}
	return {
		frontmatter: value as Record<string, unknown>,
		body: content.slice(metadataOffset + closing.index + closing[0].length),
		document,
		lineCounter,
		metadataOffset,
	};
}

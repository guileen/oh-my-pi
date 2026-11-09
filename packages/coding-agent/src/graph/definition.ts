import { isMap, isSeq } from "yaml";
import type { GraphDefinition } from "./contracts";
import { validateGraphRelations } from "./relations";
import { validateGraphShape } from "./shape";
import { parseGraphSource, type GraphSource } from "./source";
import type { GraphIssue } from "./validation-types";

export interface GraphLimits {
	maxBytes: number;
	maxDepth: number;
	maxAliases: number;
	maxNodes: number;
}

export interface LocatedGraphIssue extends GraphIssue {
	location: { file: string; path: string; line: number; column: number };
}

export interface GraphValidation {
	source: GraphSource;
	issues: LocatedGraphIssue[];
}

/** Validate the entire definition before accepting an edit or preparing execution. */
export function validateGraphDefinition(content: string, limits: GraphLimits): GraphValidation {
	const source = parseGraphSource(content, limits);
	const issues = [...validateGraphShape(source), ...validateGraphRelations(source)].map(issue => ({
		...issue,
		location: locateIssue(source, issue.path),
	}));
	return { source, issues };
}

/** Check whether a valid draft has a non-virtual entry before a Host starts it. */
export function validateGraphForStart(content: string, limits: GraphLimits): GraphValidation {
	const result = validateGraphDefinition(content, limits);
	if (result.issues.length) return result;
	const definition = result.source.frontmatter.frontmatter as unknown as GraphDefinition;
	const nonEntries = new Set<string>();
	for (const edge of definition.edges ?? []) if (!edge.loop) nonEntries.add(edge.to);
	for (const loop of Object.values(definition.loops ?? {})) nonEntries.add(loop.final_node);
	for (const node of Object.values(definition.nodes)) {
		if (node.on_budget_exhausted && node.on_budget_exhausted !== "hold") nonEntries.add(node.on_budget_exhausted);
	}
	if (!Object.keys(definition.nodes).some(key => !nonEntries.has(key))) {
		const path = "/nodes";
		result.issues.push({ path, message: "missing_entry", location: locateIssue(result.source, path) });
	}
	return result;
}

function locateIssue(source: GraphSource, pointer: string): LocatedGraphIssue["location"] {
	const { document, lineCounter, metadataOffset } = source.frontmatter;
	const segments =
		pointer === ""
			? []
			: pointer
					.slice(1)
					.split("/")
					.map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
	let node: unknown = document.contents;
	for (const segment of segments) {
		if (!isMap(node) && !isSeq(node)) break;
		const key = isSeq(node) && /^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment;
		const child: unknown = node.get(key, true);
		if (child === undefined || child === null) break;
		node = child;
	}
	let offset = 0;
	if (node !== null && typeof node === "object" && "range" in node && Array.isArray(node.range)) {
		const start: unknown = node.range[0];
		if (typeof start === "number") offset = start;
	}
	const position = lineCounter.linePos(offset);
	const prefixLines = source.source.slice(0, metadataOffset).split(/\r\n|\r|\n/).length - 1;
	return { file: "GRAPH.md", path: pointer, line: position.line + prefixLines, column: position.col };
}

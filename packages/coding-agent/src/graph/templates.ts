import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GraphCatalogEntry } from "@oh-my-pi/pi-wire/graph";
import { DAILY_CODE_WORKFLOW } from "../bots/daily-code-input";
import { buildGraphCatalog } from "./catalog";
import type { GraphLimits } from "./definition";
import { validateGraphForStart } from "./definition";

/**
 * A Graph shipped in `examples/graph/<name>/GRAPH.md`. Discovery answers "which Graph should
 * take this task" without the caller knowing a repository layout, and without importing
 * anything: listing templates grants no execution or authoring authority.
 */
export interface GraphTemplateEntry {
	/** Directory name; the stable handle used instead of a path. */
	template: string;
	/** Absolute `GRAPH.md` path, for callers that import the file directly. */
	path: string;
	/** Catalogue-shaped contract, or null when the template cannot be parsed. */
	entry: GraphCatalogEntry | null;
	/** Parse or validation failure; a listed template with an error is never runnable. */
	error: string | null;
}

export interface GraphTemplateListing {
	/** Directory templates were read from, or null when the installation ships none. */
	root: string | null;
	templates: GraphTemplateEntry[];
	/** Host workflows are discoverable here but are not importable Graph templates. */
	workflows: Array<typeof DAILY_CODE_WORKFLOW>;
}

/**
 * Resolve the bundled template directory. `src/graph` and the bundled `dist` both sit one
 * level below the package root, so the same two candidates cover source and published layouts.
 */
export async function graphTemplateRoot(explicit?: string): Promise<string | null> {
	const candidates = explicit
		? [explicit]
		: [
				path.join(import.meta.dir, "..", "..", "examples", "graph"),
				path.join(import.meta.dir, "..", "examples", "graph"),
			];
	for (const candidate of candidates) {
		try {
			if ((await fs.stat(candidate)).isDirectory()) return candidate;
		} catch {}
	}
	return null;
}

/** List bundled templates with their declared input/output contract, newest read only. */
export async function listGraphTemplates(
	limits: GraphLimits,
	options: { root?: string } = {},
): Promise<GraphTemplateListing> {
	const root = await graphTemplateRoot(options.root);
	if (!root) return { root: null, templates: [], workflows: [DAILY_CODE_WORKFLOW] };
	const names = (await fs.readdir(root, { withFileTypes: true }))
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
	const templates: GraphTemplateEntry[] = [];
	for (const template of names) {
		const file = path.join(root, template, "GRAPH.md");
		let content: string;
		try {
			content = await Bun.file(file).text();
		} catch {
			continue;
		}
		let error: string | null = null;
		try {
			// Discovery reports what a caller can actually start, so a structurally invalid or
			// entry-less template is listed with its issue rather than silently offered.
			const validation = validateGraphForStart(content, limits);
			if (validation.issues.length)
				error = validation.issues
					.slice(0, 3)
					.map(issue => `${issue.path || "/"}: ${issue.message}`)
					.join("; ");
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Template could not be parsed";
		}
		const [entry] = buildGraphCatalog(
			[{ graph_id: template, revision: "template", digest: `sha256:${Bun.SHA256.hash(content, "hex")}`, content }],
			limits,
		);
		templates.push({ template, path: file, entry: entry ?? null, error });
	}
	return { root, templates, workflows: [DAILY_CODE_WORKFLOW] };
}

/** Read one template by name. A name is resolved against the bundled directory only. */
export async function readGraphTemplate(
	template: string,
	limits: GraphLimits,
	options: { root?: string } = {},
): Promise<GraphTemplateEntry> {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(template)) throw new Error(`Invalid template name: ${template}`);
	const listing = await listGraphTemplates(limits, options);
	if (!listing.root) throw new Error("No bundled Graph templates are available");
	const found = listing.templates.find(entry => entry.template === template);
	if (!found) throw new Error(`Unknown Graph template: ${template}`);
	if (found.error) throw new Error(`Graph template ${template} is invalid: ${found.error}`);
	return found;
}

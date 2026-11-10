import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BotGraphToolCallContext } from "../bots/agent-runtime";
import { parseSearchPathPreferringLiteral, splitPathAndSelPreferringLiteral } from "../tools/path-utils";

/**
 * Local foreground execution grants. A Graph declares intent; this module decides
 * whether an individual call stays inside that intent.
 *
 * This is admission control, not a kernel sandbox: a raced symlink or a repository
 * test that itself runs arbitrary code is outside what these checks can promise.
 */

export interface GraphMemberGrants {
	read: string[];
	write: string[];
	execute: string[];
}

/** Named execute grants; a Graph never supplies raw shell. */
export const EXECUTE_GRANTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	test: ["bun", "test"],
	typecheck: ["bun", "run", "check:types"],
	check: ["bun", "run", "check"],
});

const READ_TOOLS = ["read", "grep", "glob", "find"] as const;
const WRITE_TOOLS = ["write", "edit"] as const;
const EXECUTE_TOOLS = ["bash"] as const;
/**
 * Harness bookkeeping only: it records the member's plan in the session and touches no
 * workspace path. The frozen `omp-default` prompt asks for it, so refusing it would abort
 * a competent run for a reason the grant model does not actually care about.
 */
export const HARNESS_TOOLS = ["todo"] as const;
const SHELL_META = /[;&|<>$()`\n\r]/;

export class GrantError extends Error {
	constructor(
		readonly code: "permission_denied" | "capability_unavailable",
		message: string,
	) {
		super(message);
		this.name = "GrantError";
	}
}

export function grantedToolNames(grants: GraphMemberGrants): string[] {
	const names: string[] = [];
	if (grants.read.length) names.push(...READ_TOOLS);
	if (grants.write.length) names.push(...WRITE_TOOLS);
	if (grants.execute.length) names.push(...EXECUTE_TOOLS);
	return names;
}

/** Patterns are workspace-relative. Absolute paths, parent escapes and empty entries are invalid. */
export function validateGrantPattern(pattern: string, label: string): void {
	if (typeof pattern !== "string" || pattern.trim().length === 0)
		throw new GrantError("capability_unavailable", `${label}: empty grant pattern`);
	const normalized = pattern.replaceAll("\\", "/").trim();
	if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized === "~" || normalized.startsWith("~/"))
		throw new GrantError("capability_unavailable", `${label}: grant patterns must be workspace-relative`);
	const segments = normalized.split("/");
	if (segments.includes(".."))
		throw new GrantError("capability_unavailable", `${label}: grant patterns cannot escape the workspace`);
	if (segments.some(segment => segment === ""))
		throw new GrantError("capability_unavailable", `${label}: grant patterns contain an empty segment`);
}

export function validateExecuteGrant(name: string, label: string): void {
	if (!Object.hasOwn(EXECUTE_GRANTS, name))
		throw new GrantError(
			"capability_unavailable",
			`${label}: execute grant "${name}" is not one of ${Object.keys(EXECUTE_GRANTS).join(", ")}`,
		);
}

/** Match a workspace-relative posix path against one declared pattern. */
function matches(pattern: string, relative: string): boolean {
	const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
	// "." or "**" grants the whole workspace; a plain path grants that path and its subtree.
	if (normalized === "." || normalized === "**" || normalized === "") return true;
	if (normalized.endsWith("/**")) {
		const base = normalized.slice(0, -3);
		return relative === base || relative.startsWith(`${base}/`);
	}
	if (normalized.endsWith("/*")) {
		const base = normalized.slice(0, -2);
		const rest = relative.slice(base.length + 1);
		return relative.startsWith(`${base}/`) && rest.length > 0 && !rest.includes("/");
	}
	return relative === normalized || relative.startsWith(`${normalized}/`);
}

function matchesAny(patterns: readonly string[], relative: string): boolean {
	return patterns.some(pattern => matches(pattern, relative));
}

function relativeInside(root: string, candidate: string, allowRoot = false): string | null {
	const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
	const relative = path.relative(root, absolute);
	if (relative === "") return allowRoot ? "" : null;
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return relative.split(path.sep).join("/");
}

async function realRoot(root: string): Promise<string> {
	return fs.realpath(root).catch(() => path.resolve(root));
}

/** Resolve the nearest existing ancestor so a not-yet-created file still cannot traverse a symlink out. */
async function realCandidate(root: string, candidate: string): Promise<string | null> {
	const base = path.resolve(root, candidate);
	let cursor = base;
	const missing: string[] = [];
	for (;;) {
		try {
			const real = await fs.realpath(cursor);
			return path.resolve(real, ...missing.slice().reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
			const parent = path.dirname(cursor);
			if (parent === cursor) return null;
			missing.push(path.basename(cursor));
			cursor = parent;
		}
	}
}

async function contained(
	root: string,
	candidate: string,
	patterns: readonly string[],
	allowRoot = false,
): Promise<boolean> {
	const lexical = relativeInside(root, candidate, allowRoot);
	if (lexical === null || !matchesAny(patterns, lexical)) return false;
	const resolved = await realCandidate(root, candidate);
	if (resolved === null) return false;
	const canonical = await realRoot(root);
	const relative = path.relative(canonical, resolved);
	if (
		(!allowRoot && relative === "") ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		return false;
	return matchesAny(patterns, relative.split(path.sep).join("/"));
}

function pickPath(args: Record<string, unknown>): string | null {
	for (const key of ["path", "file", "file_path", "target"]) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/** Keep authorization and dispatch on the same local filesystem interpretation. */
function localTarget(target: string): void {
	if (
		/^[~@\\]/.test(target) ||
		/[;\n\r]/.test(target) ||
		(/:/.test(target) && !/^[A-Za-z]:[\\/][^:]*$/.test(target))
	) {
		throw new GrantError("permission_denied", "Only unambiguous local workspace paths are granted");
	}
}

function executeGrantFor(command: string): string | null {
	if (typeof command !== "string" || command.trim().length === 0) return null;
	if (SHELL_META.test(command)) return null;
	const tokens = command.trim().split(/\s+/);
	for (const [name, argv] of Object.entries(EXECUTE_GRANTS)) {
		if (argv.every((token, index) => tokens[index] === token)) return name;
	}
	return null;
}

/**
 * Deny a call that leaves the member's declared grants. Graph capability tools are
 * admitted separately by the caller; this function only judges workspace access.
 */
export async function assertGrantedToolCall(
	context: BotGraphToolCallContext,
	grants: GraphMemberGrants,
	root: string,
): Promise<void> {
	const name = context.toolCall.name;
	if ((HARNESS_TOOLS as readonly string[]).includes(name)) return;
	if ((READ_TOOLS as readonly string[]).includes(name)) {
		if (!grants.read.length) throw new GrantError("permission_denied", `${name} is not granted to this member`);
		let target = pickPath(context.args) ?? ".";
		if (name === "read") {
			if (target.includes("?")) throw new GrantError("permission_denied", "Read queries are not granted");
			target = (await splitPathAndSelPreferringLiteral(target, root)).path;
		} else {
			// Search tools recover lists and globs; authorize a single bounded search root,
			// never a string that can expand into additional roots after this check.
			if (/[\s,;{}]/.test(target) || target.includes(".."))
				throw new GrantError("permission_denied", "Use one unambiguous search path per call");
			localTarget(target);
			target = (await parseSearchPathPreferringLiteral(target, root)).basePath;
		}
		localTarget(target);
		await fs.realpath(path.resolve(root, target)).catch(() => {
			throw new GrantError("permission_denied", "Read/search target must exist inside the workspace");
		});
		if (!(await contained(root, target, grants.read, true)))
			throw new GrantError("permission_denied", `${name} path is outside the member's read grants: ${target}`);
		return;
	}
	if ((WRITE_TOOLS as readonly string[]).includes(name)) {
		if (!grants.write.length) throw new GrantError("permission_denied", `${name} is not granted to this member`);
		const targets =
			name === "edit" && context.editTargets !== undefined ? context.editTargets : [pickPath(context.args) ?? ""];
		if (!targets.length || targets.some(target => !target))
			throw new GrantError("permission_denied", "No host-inspected write target is available");
		for (const target of targets) {
			localTarget(target);
			if (!(await contained(root, target, grants.write)))
				throw new GrantError("permission_denied", `${name} path is outside the member's write grants: ${target}`);
		}
		return;
	}
	if ((EXECUTE_TOOLS as readonly string[]).includes(name)) {
		if (!grants.execute.length) throw new GrantError("permission_denied", "bash is not granted to this member");
		const grant = executeGrantFor(String(context.args.command ?? ""));
		if (grant === null)
			throw new GrantError(
				"permission_denied",
				`Command is outside the member's execute grants (${grants.execute.join(", ")})`,
			);
		if (!grants.execute.includes(grant))
			throw new GrantError("permission_denied", `Execute grant ${grant} is not declared for this member`);
		return;
	}
	throw new GrantError("permission_denied", `Local text Bots cannot invoke ${name}`);
}

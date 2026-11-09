import type { GraphDefinition, GraphMember, GraphNode } from "./contracts";
import { type GraphLimits, validateGraphForStart } from "./definition";
import type { GraphIssue } from "./validation-types";

export interface ChildGraphAuthority {
	/** A validated, frozen parent definition and its subgraph node key. */
	parent: GraphDefinition;
	parentNode: string;
	limits: GraphLimits;
	/**
	 * Trusted registry authorization, not model input. Must prove that the executor,
	 * parameters and all its effects stay within the parent's permissions and node.writes.
	 * Omit to reject program and queue nodes.
	 */
	authorizeExecutor?: (node: GraphNode, parent: GraphMember) => boolean;
	/** Prove a role heading resolves to the same frozen parent role prose. */
	authorizeRole?: (key: string, member: GraphMember, childSource: string) => boolean;
	/** Prove two literal write scopes do not alias on the actual target filesystem. */
	writesAreDisjoint?: (first: string, second: string) => boolean;
}

export interface ChildGraphValidation {
	issues: GraphIssue[];
	/** Present only for an accepted candidate. This does not authorize dispatch. */
	definition?: GraphDefinition;
}

const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

// Only literal repository-relative paths have a locally provable containment relation.
// In particular globs, absolute paths, traversal, and platform-dependent separators are not grants here.
function literalPath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!/[\\*?[\]{}!\x00-\x1f:]/.test(path) &&
		path.split("/").every(part => part !== "" && part !== "." && part !== "..")
	);
}
function contains(parent: string, child: string): boolean {
	return parent === "."
		? child === "." || literalPath(child)
		: literalPath(parent) && literalPath(child) && (parent === child || child.startsWith(`${parent}/`));
}
function sameIdentity(a: GraphMember, b: GraphMember): boolean {
	return (
		a.model === b.model &&
		a.base === b.base &&
		a.duty === b.duty &&
		a.role === b.role &&
		a.bot?.id === b.bot?.id &&
		a.bot?.digest === b.bot?.digest &&
		JSON.stringify(a.skills ?? []) === JSON.stringify(b.skills ?? [])
	);
}

/**
 * Validate a candidate before creating a child scope. Parent members are pinned to the
 * frozen parent identities; their grants may only narrow. The literal path subset is
 * deliberately conservative: an unresolved pattern is never treated as safe.
 *
 * Acceptance is not a sandbox, a budget reservation, or an execution receipt. The
 * host must enforce grants and declared writes, atomically consume the parent Run's
 * budgets, isolate concurrent worktrees on a frozen baseline (or serialize), and
 * aggregate mandatory results/integration before completing the parent.
 */
export function validateChildGraph(content: string, authority: ChildGraphAuthority): ChildGraphValidation {
	const { authorizeRole, authorizeExecutor, writesAreDisjoint } = authority;
	authority = { ...authority, parent: structuredClone(authority.parent), limits: { ...authority.limits } };
	const parsed = validateGraphForStart(content, authority.limits);
	if (parsed.issues.length) return { issues: parsed.issues };
	const child = parsed.source.frontmatter.frontmatter as unknown as GraphDefinition;
	const issues: GraphIssue[] = [];
	const issue = (path: string, message: string) => issues.push({ path, message });
	const parentNode = Object.hasOwn(authority.parent.nodes, authority.parentNode)
		? authority.parent.nodes[authority.parentNode]
		: undefined;
	const policy = parentNode?.child_policy;
	const parentMember =
		parentNode?.member && Object.hasOwn(authority.parent.members, parentNode.member)
			? authority.parent.members[parentNode.member]
			: undefined;
	if (
		parentNode?.kind !== "subgraph" ||
		!policy ||
		!parentMember ||
		!Array.isArray(policy.kinds) ||
		!positive(policy.max_nodes) ||
		!positive(policy.max_parallel)
	) {
		return { issues: [{ path: "", message: "Invalid parent subgraph authority" }] };
	}
	const parentMaxNodes = authority.parent.policy?.max_child_nodes ?? 32;
	const parentParallel = authority.parent.policy?.max_parallel ?? 1;
	if (!positive(parentMaxNodes) || !positive(parentParallel))
		return { issues: [{ path: "", message: "Invalid parent policy limits" }] };
	const parallel = child.policy?.max_parallel ?? 1;
	if (Object.keys(child.nodes).length > Math.min(policy.max_nodes, parentMaxNodes))
		issue("/nodes", "Child node limit exceeded");
	if (parallel > Math.min(policy.max_parallel, parentParallel))
		issue("/policy/max_parallel", "Child concurrency limit exceeded");
	if (Object.keys(child.budgets ?? {}).length || child.budgets !== undefined)
		issue("/budgets", "Child budgets are forbidden; budgets belong to the parent Run");
	if (child.loops !== undefined) issue("/loops", "Child loops are forbidden");
	if (child.communications?.length) issue("/communications", "Child communication authority is not inherited");
	for (const key of Object.keys(child.policy ?? {})) {
		if (key !== "max_parallel") issue(`/policy/${pointer(key)}`, "Child policy cannot override inherited policy");
	}
	for (const [key, member] of Object.entries(child.members)) {
		const path = `/members/${pointer(key)}`;
		const original = Object.hasOwn(authority.parent.members, key) ? authority.parent.members[key] : undefined;
		if (!original || !sameIdentity(member, original)) issue(path, "Child member is not a frozen parent identity");
		if (member.role && authorizeRole?.(key, structuredClone(member), content) !== true)
			issue(`${path}/role`, "Child role prose is not proven to match the frozen parent role");
		if (member.duty === "code-only" && member.base !== "omp-default")
			issue(`${path}/base`, "Code-only requires omp-default");
		for (const kind of ["read", "write"] as const) {
			for (const [index, grant] of member.permissions[kind].entries()) {
				if (
					!original?.permissions[kind].some(allowed => contains(allowed, grant)) ||
					!parentMember.permissions[kind].some(allowed => contains(allowed, grant))
				)
					issue(`${path}/permissions/${kind}/${index}`, "Permission is not provably within both parent grants");
			}
		}
		for (const [index, command] of member.permissions.execute.entries()) {
			if (!original?.permissions.execute.includes(command) || !parentMember.permissions.execute.includes(command))
				issue(`${path}/permissions/execute/${index}`, "Command is not authorized by both parent grants");
		}
	}
	for (const [key, node] of Object.entries(child.nodes)) {
		const path = `/nodes/${pointer(key)}`;
		if (node.kind === "subgraph" || !policy.kinds.includes(node.kind as Exclude<GraphNode["kind"], "subgraph">))
			issue(`${path}/kind`, "Child node kind is forbidden");
		if (node.consume !== undefined || node.on_budget_exhausted !== undefined)
			issue(path, "Child cannot declare independent budget consumption or routes");
		const writes = node.writes ?? [];
		for (const [index, write] of writes.entries()) {
			if (!parentMember.permissions.write.some(grant => contains(grant, write)))
				issue(`${path}/writes/${index}`, "Write is not provably within parent permissions");
			if (!(parentNode.writes ?? []).some(grant => contains(grant, write)))
				issue(`${path}/writes/${index}`, "Write is not provably within parent node writes");
		}
		if (node.kind === "bot" && node.member && Object.hasOwn(child.members, node.member)) {
			const member = child.members[node.member];
			for (const grant of member.permissions.write) {
				if (!writes.some(write => contains(write, grant)))
					issue(`${path}/writes`, "Declared writes must cover all member write permissions");
			}
			for (const write of writes) {
				if (!member.permissions.write.some(grant => contains(grant, write)))
					issue(`${path}/writes`, "Declared writes exceed member permissions");
			}
		} else if (node.kind === "program" || node.kind === "queue") {
			if (authorizeExecutor?.(structuredClone(node), structuredClone(parentMember)) !== true)
				issue(`${path}/executor`, "Executor effects are not authorized");
		} else if (node.kind === "human" && writes.length) {
			issue(`${path}/writes`, "Human nodes cannot own writes");
		}
	}
	// A single-incoming-edge chain forces each successor to wait for its predecessor,
	// even with conditional routing or an any join. Other paths are not assumed serial.
	const incoming = new Map<string, string[]>();
	for (const edge of child.edges ?? []) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
	const precedes = (from: string, to: string): boolean => {
		const seen = new Set<string>();
		let current = to;
		while (!seen.has(current)) {
			seen.add(current);
			const parents = incoming.get(current);
			if (parents?.length !== 1) return false;
			if (parents[0] === from) return true;
			current = parents[0];
		}
		return false;
	};
	if (parallel > 1) {
		const nodes = Object.entries(child.nodes);
		for (let i = 0; i < nodes.length; i++)
			for (let j = i + 1; j < nodes.length; j++) {
				const [a, first] = nodes[i];
				const [b, second] = nodes[j];
				if (
					(first.writes ?? []).some(x =>
						(second.writes ?? []).some(
							y => contains(x, y) || contains(y, x) || writesAreDisjoint?.(x, y) !== true,
						),
					) &&
					!precedes(a, b) &&
					!precedes(b, a)
				)
					issue("/nodes", `Concurrent write ownership overlaps: ${a}, ${b}`);
			}
	}
	return issues.length ? { issues } : { issues, definition: child };
}

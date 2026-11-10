import { describe, expect, it } from "bun:test";
import { type ChildGraphAuthority, validateChildGraph } from "../src/graph/child-policy";
import type { GraphDefinition, GraphMember } from "../src/graph/contracts";

const limits = { maxBytes: 32768, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const member = (write: string[]): GraphMember => ({
	bot: { id: "bot", digest: "sha256:abc" },
	model: "model",
	base: "omp-default",
	duty: "code-only",
	permissions: { read: ["src"], write, execute: ["check"] },
});
function fixture(): { parent: GraphDefinition; child: GraphDefinition; authority: ChildGraphAuthority } {
	const parent: GraphDefinition = {
		format: "omp.graph/v1",
		name: "parent",
		members: { owner: member(["src"]), first: member(["src"]), second: member(["src"]) },
		nodes: {
			build: {
				kind: "subgraph",
				task: "#task",
				member: "owner",
				writes: ["src"],
				child_policy: { kinds: ["bot", "program", "queue", "human"], max_nodes: 4, max_parallel: 2 },
			},
		},
		policy: { max_parallel: 2, max_child_nodes: 4 },
	};
	const child: GraphDefinition = {
		format: "omp.graph/v1",
		name: "child",
		members: { first: member(["src/a"]), second: member(["src/b"]) },
		nodes: {
			first: { kind: "bot", task: "#task", member: "first", writes: ["src/a"] },
			second: { kind: "bot", task: "#task", member: "second", writes: ["src/b"] },
		},
		policy: { max_parallel: 2 },
	};
	return { parent, child, authority: { parent, parentNode: "build", limits, writesAreDisjoint: () => true } };
}
function validate(child: GraphDefinition, authority: ChildGraphAuthority) {
	return validateChildGraph(`---\n${JSON.stringify(child)}\n---\n## task\nImplement.\n## role\nRole.\n`, authority);
}

describe("child graph policy", () => {
	it("accepts a bounded, authorized child without mutating its parent", () => {
		const { child, parent, authority } = fixture();
		const before = JSON.stringify(parent);
		const result = validate(child, authority);
		expect(result.issues).toEqual([]);
		expect(result.definition?.nodes).toEqual(child.nodes);
		expect(JSON.stringify(parent)).toBe(before);
	});

	it("rejects forbidden kinds, excessive nodes and concurrency under both limits", () => {
		const { child, parent, authority } = fixture();
		parent.nodes.build.child_policy!.kinds = ["human"];
		parent.policy!.max_child_nodes = 1;
		parent.nodes.build.child_policy!.max_parallel = 1;
		const paths = validate(child, authority).issues.map(issue => issue.path);
		expect(paths).toContain("/nodes/first/kind");
		expect(paths).toContain("/nodes");
		expect(paths).toContain("/policy/max_parallel");
	});

	it("rejects nested graphs, child budgets, loops and policy escapes", () => {
		const { child, authority } = fixture();
		child.nodes.second = {
			kind: "subgraph",
			task: "#task",
			member: "second",
			child_policy: { kinds: ["bot"], max_nodes: 1, max_parallel: 1 },
		};
		child.budgets = { extra: { limit: 99, scope: "run" } };
		child.loops = {};
		child.nodes.first.consume = ["extra"];
		child.policy!.cost_limit = "100";
		child.policy!.currency = "USD";
		const paths = validate(child, authority).issues.map(issue => issue.path);
		expect(paths).toContain("/nodes/second/kind");
		expect(paths).toContain("/budgets");
		expect(paths).toContain("/loops");
		expect(paths).toContain("/nodes/first");
		expect(paths).toContain("/policy/cost_limit");
	});

	it("rejects unapproved executors, but accepts a trusted registry decision", () => {
		const { child, authority } = fixture();
		child.nodes.second = { kind: "program", executor: "compiler", task: "#task", writes: ["src/b"] };
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/nodes/second/executor");
		authority.authorizeExecutor = node => node.executor === "compiler";
		expect(validate(child, authority).issues).toEqual([]);
	});

	it("does not let registry policy replace an already validated executor", () => {
		const { child, authority } = fixture();
		child.nodes.second = { kind: "program", executor: "compiler", task: "#task", writes: ["src/b"] };
		authority.authorizeExecutor = node => {
			if (node.executor !== "compiler") return false;
			node.executor = "unapproved-shell";
			node.writes = ["secrets"];
			return true;
		};
		const result = validate(child, authority);
		expect(result.issues).toEqual([]);
		expect(result.definition?.nodes.second.executor).toBe("compiler");
		expect(result.definition?.nodes.second.writes).toEqual(["src/b"]);
	});

	it("rejects non-boolean authority and disjointness claims", () => {
		const { child, parent, authority } = fixture();
		const truthy = "approved" as unknown as boolean;
		authority.writesAreDisjoint = () => truthy;
		expect(validate(child, authority).issues.some(issue => issue.message.includes("Concurrent write"))).toBe(true);
		authority.writesAreDisjoint = () => true;
		child.nodes.second = { kind: "program", executor: "compiler", task: "#task", writes: ["src/b"] };
		authority.authorizeExecutor = () => truthy;
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/nodes/second/executor");
		const roleMember = { ...member(["src/a"]), bot: undefined, role: "#role" as const };
		child.members.first = roleMember;
		parent.members.first = { ...roleMember, permissions: { ...roleMember.permissions, write: ["src"] } };
		authority.authorizeRole = () => truthy;
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/members/first/role");
	});

	it("rejects changed identities, expanded permissions, undeclared writes and ambiguous paths", () => {
		const { child, authority } = fixture();
		child.members.first.model = "other";
		child.members.first.permissions.write = ["src/../secret"];
		child.members.first.permissions.execute.push("shell");
		child.nodes.first.writes = ["src/a"];
		const paths = validate(child, authority).issues.map(issue => issue.path);
		expect(paths).toContain("/members/first");
		expect(paths).toContain("/members/first/permissions/write/0");
		expect(paths).toContain("/members/first/permissions/execute/1");
		expect(paths).toContain("/nodes/first/writes");
	});

	it("constrains child writes to both parent node scope and member grants", () => {
		const { child, parent, authority } = fixture();
		parent.nodes.build.writes = ["src/a"];
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/nodes/second/writes/0");
		parent.nodes.build.writes = ["."];
		parent.members.owner.permissions.write = ["src/a"];
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/nodes/second/writes/0");
		parent.members.owner.permissions.write = ["."];
		expect(validate(child, authority).issues).toEqual([]);
		child.nodes.first.writes = ["src/../secret"];
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/nodes/first/writes/0");
	});

	it("allows repository-root writes only under explicit root grants", () => {
		const { child, parent, authority } = fixture();
		delete child.nodes.second;
		delete child.members.second;
		child.policy!.max_parallel = 1;
		child.nodes.first.writes = ["."];
		child.members.first.permissions.write = ["."];
		parent.members.first.permissions.write = ["."];
		parent.members.owner.permissions.write = ["."];
		parent.nodes.build.writes = ["."];
		expect(validate(child, authority).issues).toEqual([]);
		parent.nodes.build.writes = ["src"];
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/nodes/first/writes/0");
	});

	it("requires proof of role prose and the default base for coding bots", () => {
		const { child, parent, authority } = fixture();
		const roleMember = { ...member(["src/a"]), bot: undefined, role: "#role" as const };
		child.members.first = roleMember;
		parent.members.first = { ...roleMember, permissions: { ...roleMember.permissions, write: ["src"] } };
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/members/first/role");
		authority.authorizeRole = () => true;
		expect(validate(child, authority).issues).toEqual([]);
		child.members.first.base = "isolated";
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/members/first/base");
	});

	it("does not expose mutable frozen authority through a role callback receiver", () => {
		const { child, parent, authority } = fixture();
		const roleMember = { ...member(["secret"]), bot: undefined, role: "#role" as const };
		child.members.first = roleMember;
		child.nodes.first.writes = ["secret"];
		parent.members.first = { ...roleMember, permissions: { ...roleMember.permissions, write: ["src"] } };
		authority.authorizeRole = function (this: ChildGraphAuthority | undefined, key) {
			if (this) {
				this.parent.members[key].permissions.write.push("secret");
				this.parent.members.owner.permissions.write.push("secret");
				this.parent.nodes.build.writes!.push("secret");
			}
			return true;
		};
		const paths = validate(child, authority).issues.map(issue => issue.path);
		expect(paths).toContain("/members/first/permissions/write/0");
		expect(paths).toContain("/nodes/first/writes/0");
	});

	it("rejects overlapping or unproven parallel writes and permits actual serialization", () => {
		const { child, authority } = fixture();
		child.members.second.permissions.write = ["src/a/file"];
		child.nodes.second.writes = ["src/a/file"];
		expect(validate(child, authority).issues.some(issue => issue.message.includes("Concurrent write"))).toBe(true);
		child.edges = [{ id: "order", from: "first", to: "second" }];
		expect(validate(child, authority).issues).toEqual([]);
		delete child.edges;
		child.policy!.max_parallel = 1;
		expect(validate(child, authority).issues).toEqual([]);
		child.policy!.max_parallel = 2;
		child.members.second.permissions.write = ["src/b"];
		child.nodes.second.writes = ["src/b"];
		delete authority.writesAreDisjoint;
		expect(validate(child, authority).issues.some(issue => issue.message.includes("Concurrent write"))).toBe(true);
	});

	it("does not mistake an any-join dependency for exclusive serialization", () => {
		const { child, authority } = fixture();
		child.members.second.permissions.write = ["src/a/file"];
		child.nodes.second.writes = ["src/a/file"];
		child.nodes.second.join = "any";
		child.nodes.approval = { kind: "human", task: "#task" };
		child.edges = [
			{ id: "first-edge", from: "first", to: "second" },
			{ id: "approval-edge", from: "approval", to: "second" },
		];
		expect(validate(child, authority).issues.some(issue => issue.message.includes("Concurrent write"))).toBe(true);
	});

	it("rejects malformed dependencies and cycles before policy acceptance", () => {
		const { child, authority } = fixture();
		child.edges = [{ id: "bad", from: "first", to: "missing" }];
		expect(validate(child, authority).issues.map(issue => issue.path)).toContain("/edges/0/to");
		child.edges = [
			{ id: "one", from: "first", to: "second" },
			{ id: "two", from: "second", to: "first" },
		];
		expect(validate(child, authority).issues.length).toBeGreaterThan(0);
	});
});

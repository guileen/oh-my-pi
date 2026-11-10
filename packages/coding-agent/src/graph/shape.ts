import type { GraphSource } from "./source";
import type { GraphIssue } from "./validation-types";

type ObjectValue = Record<string, unknown>;
type Check = (value: unknown, path: string) => void;

/** Validate definition structure only; successful validation is not execution authorization. */
export function validateGraphShape(source: GraphSource): GraphIssue[] {
	const issues: GraphIssue[] = [];
	const issue = (path: string, message: string) => issues.push({ path, message });
	const child = (path: string, key: string | number) =>
		`${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
	const object = (value: unknown, path: string): value is ObjectValue => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			issue(path, "Expected an object");
			return false;
		}
		return true;
	};
	const fields = (value: unknown, path: string, allowed: string[], required: string[] = []): value is ObjectValue => {
		if (!object(value, path)) return false;
		for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(child(path, key), "Unknown field");
		for (const key of required) if (!Object.hasOwn(value, key)) issue(child(path, key), "Required field is missing");
		return true;
	};
	const string: Check = (v, p) => {
		if (typeof v !== "string") issue(p, "Expected a string");
	};
	const nonempty: Check = (v, p) => {
		if (typeof v !== "string" || v.length === 0) issue(p, "Expected a nonempty string");
	};
	const key: Check = (v, p) => {
		if (typeof v !== "string" || !/^[a-z][a-z0-9-]*$/.test(v)) issue(p, "Expected a definition key");
	};
	const heading: Check = (v, p) => {
		if (typeof v !== "string" || !/^#[a-z][a-z0-9-]*$/.test(v)) issue(p, "Expected a heading reference");
	};
	const positive: Check = (v, p) => {
		if (!Number.isSafeInteger(v) || (v as number) < 1) issue(p, "Expected a positive safe integer");
	};
	const bool: Check = (v, p) => {
		if (typeof v !== "boolean") issue(p, "Expected a boolean");
	};
	const enumeration =
		(...values: string[]): Check =>
		(v, p) => {
			if (typeof v !== "string" || !values.includes(v)) issue(p, `Expected one of: ${values.join(", ")}`);
		};
	const array =
		(check: Check): Check =>
		(v, p) => {
			if (!Array.isArray(v)) {
				issue(p, "Expected an array");
				return;
			}
			v.forEach((item, i) => check(item, child(p, i)));
		};
	const map =
		(check: Check, keyCheck: Check = key): Check =>
		(v, p) => {
			if (!object(v, p)) return;
			for (const [name, item] of Object.entries(v)) {
				const at = child(p, name);
				keyCheck(name, at);
				check(item, at);
			}
		};
	const optional = (v: ObjectValue, p: string, name: string, check: Check) => {
		if (Object.hasOwn(v, name)) check(v[name], child(p, name));
	};
	const ref: Check = (v, p) => {
		if (!fields(v, p, ["id", "digest"], ["id", "digest"])) return;
		optional(v, p, "id", nonempty);
		optional(v, p, "digest", nonempty);
	};
	const permissions: Check = (v, p) => {
		if (!fields(v, p, ["read", "write", "execute"], ["read", "write", "execute"])) return;
		for (const name of ["read", "write", "execute"]) optional(v, p, name, array(string));
	};
	const member: Check = (v, p) => {
		if (
			!fields(
				v,
				p,
				["bot", "role", "model", "base", "duty", "permissions", "skills"],
				["model", "base", "duty", "permissions"],
			)
		)
			return;
		if (Object.hasOwn(v, "bot") === Object.hasOwn(v, "role")) issue(p, "Exactly one of bot or role is required");
		optional(v, p, "bot", ref);
		optional(v, p, "role", heading);
		optional(v, p, "model", nonempty);
		optional(v, p, "base", enumeration("omp-default", "isolated"));
		optional(
			v,
			p,
			"duty",
			enumeration("research", "guide", "spec", "review", "consult", "code-only", "test-only", "general"),
		);
		optional(v, p, "permissions", permissions);
		optional(v, p, "skills", array(ref));
		if (v.duty === "code-only" && v.base !== "omp-default" && Object.hasOwn(v, "base"))
			issue(child(p, "base"), "code-only requires omp-default base");
	};
	const binding: Check = (v, p) => {
		if (!fields(v, p, ["text", "artifact", "run_input"])) return;
		if (["text", "artifact", "run_input"].filter(name => Object.hasOwn(v, name)).length !== 1)
			issue(p, "Expected exactly one input binding");
		optional(v, p, "text", string);
		optional(v, p, "artifact", ref);
		optional(v, p, "run_input", key);
	};
	const output: Check = (v, p) => {
		if (!fields(v, p, ["media_type", "required", "schema_ref"], ["media_type", "required"])) return;
		optional(v, p, "media_type", nonempty);
		optional(v, p, "required", bool);
		optional(v, p, "schema_ref", ref);
	};
	const parameter: Check = (v, p) => {
		if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			ref(v, p);
			return;
		}
		issue(p, "Expected a scalar or Ref");
	};
	const node: Check = (v, p) => {
		const names = [
			"kind",
			"task",
			"member",
			"executor",
			"inputs",
			"required_inputs",
			"outputs",
			"approved_outputs",
			"outcomes",
			"join",
			"retry",
			"timeout_ms",
			"writes",
			"consume",
			"on_budget_exhausted",
			"verdicts",
			"terminal",
			"required_gate",
			"decisions",
			"parameters",
			"child_policy",
		];
		if (!fields(v, p, names, ["kind", "task"])) return;
		optional(v, p, "kind", enumeration("bot", "program", "queue", "human", "subgraph"));
		optional(v, p, "task", heading);
		const memberKind = v.kind === "bot" || v.kind === "subgraph";
		const executorKind = v.kind === "program" || v.kind === "queue";
		if (memberKind && !Object.hasOwn(v, "member")) issue(child(p, "member"), "Required field is missing");
		if (executorKind && !Object.hasOwn(v, "executor")) issue(child(p, "executor"), "Required field is missing");
		if (v.kind === "subgraph" && !Object.hasOwn(v, "child_policy"))
			issue(child(p, "child_policy"), "Required field is missing");
		if (typeof v.kind === "string" && ["bot", "program", "queue", "human", "subgraph"].includes(v.kind)) {
			if (!memberKind && Object.hasOwn(v, "member")) issue(child(p, "member"), "Field is not allowed for this kind");
			if (!executorKind && Object.hasOwn(v, "executor"))
				issue(child(p, "executor"), "Field is not allowed for this kind");
			if (!executorKind && Object.hasOwn(v, "parameters"))
				issue(child(p, "parameters"), "Field is not allowed for this kind");
			if (v.kind !== "human" && Object.hasOwn(v, "approved_outputs"))
				issue(child(p, "approved_outputs"), "Field is not allowed for this kind");
			if (v.kind !== "subgraph" && Object.hasOwn(v, "child_policy"))
				issue(child(p, "child_policy"), "Field is not allowed for this kind");
		}
		optional(v, p, "member", key);
		optional(v, p, "executor", nonempty);
		optional(v, p, "inputs", map(binding));
		optional(v, p, "required_inputs", array(key));
		optional(v, p, "outputs", map(output));
		optional(
			v,
			p,
			"approved_outputs",
			map((binding, at) => {
				if (!fields(binding, at, ["input", "on"], ["input", "on"])) return;
				optional(binding, at, "input", key);
				optional(binding, at, "on", array(nonempty));
			}),
		);
		optional(v, p, "outcomes", array(nonempty));
		optional(v, p, "join", enumeration("all", "any"));
		optional(v, p, "retry", (x, at) => {
			if (fields(x, at, ["max_attempts"], ["max_attempts"])) optional(x, at, "max_attempts", positive);
		});
		optional(v, p, "timeout_ms", positive);
		optional(v, p, "writes", array(string));
		optional(v, p, "consume", array(key));
		optional(v, p, "on_budget_exhausted", key);
		optional(v, p, "verdicts", array(nonempty));
		optional(v, p, "terminal", map(enumeration("succeed", "hold", "fail"), nonempty));
		optional(v, p, "required_gate", bool);
		optional(
			v,
			p,
			"decisions",
			array((x, at) => {
				if (!fields(x, at, ["verdict", "outcome"], ["verdict", "outcome"])) return;
				optional(x, at, "verdict", nonempty);
				optional(x, at, "outcome", nonempty);
			}),
		);
		optional(v, p, "parameters", map(parameter));
		optional(v, p, "child_policy", (x, at) => {
			if (!fields(x, at, ["kinds", "max_nodes", "max_parallel"], ["kinds", "max_nodes", "max_parallel"])) return;
			optional(x, at, "kinds", array(enumeration("bot", "program", "queue", "human")));
			optional(x, at, "max_nodes", positive);
			optional(x, at, "max_parallel", positive);
		});
	};
	const edge: Check = (v, p) => {
		if (
			!fields(v, p, ["id", "from", "to", "on", "bind", "loop", "branch_group", "when_budget"], ["id", "from", "to"])
		)
			return;
		for (const name of ["id", "from", "to", "loop", "branch_group"]) optional(v, p, name, key);
		optional(v, p, "on", array(nonempty));
		optional(v, p, "bind", map(key));
		optional(v, p, "when_budget", (x, at) => {
			if (!fields(x, at, ["budget", "state"], ["budget", "state"])) return;
			optional(x, at, "budget", key);
			optional(x, at, "state", enumeration("available", "exhausted"));
		});
	};
	const loop: Check = (v, p) => {
		if (
			!fields(
				v,
				p,
				[
					"max_reviews",
					"final_node",
					"retry_target",
					"final_outcomes",
					"count_nodes",
					"final_bind",
					"scope",
					"cycle_start",
					"reset_from",
					"stage",
				],
				["max_reviews", "final_node", "retry_target", "final_outcomes", "count_nodes", "scope"],
			)
		)
			return;
		optional(v, p, "max_reviews", positive);
		optional(v, p, "final_node", key);
		optional(v, p, "retry_target", key);
		optional(v, p, "final_outcomes", (x, at) => {
			if (fields(x, at, ["go", "hold"], ["go", "hold"])) {
				optional(x, at, "go", nonempty);
				optional(x, at, "hold", nonempty);
			}
		});
		optional(v, p, "count_nodes", array(key));
		optional(v, p, "final_bind", map(key));
		optional(v, p, "scope", enumeration("cycle", "stage"));
		optional(v, p, "cycle_start", key);
		optional(v, p, "reset_from", array(key));
		optional(v, p, "stage", key);
		if (v.scope === "cycle")
			for (const name of ["cycle_start", "reset_from"])
				if (!Object.hasOwn(v, name)) issue(child(p, name), "Required field is missing");
		if (v.scope === "stage" && !Object.hasOwn(v, "stage")) issue(child(p, "stage"), "Required field is missing");
	};
	const budget: Check = (v, p) => {
		if (!fields(v, p, ["limit", "scope", "loop", "stage"], ["limit", "scope"])) return;
		optional(v, p, "limit", positive);
		optional(v, p, "scope", enumeration("run", "cycle", "stage"));
		optional(v, p, "loop", key);
		optional(v, p, "stage", key);
		if (v.scope === "cycle" && !Object.hasOwn(v, "loop")) issue(child(p, "loop"), "Required field is missing");
		if (v.scope === "stage" && !Object.hasOwn(v, "stage")) issue(child(p, "stage"), "Required field is missing");
	};
	const communication: Check = (v, p) => {
		if (!fields(v, p, ["from", "to", "when", "artifacts", "max_rounds", "timeout_ms"], ["from", "to", "when"]))
			return;
		optional(v, p, "from", key);
		optional(v, p, "to", key);
		optional(v, p, "when", heading);
		optional(v, p, "artifacts", array(string));
		optional(v, p, "max_rounds", positive);
		optional(v, p, "timeout_ms", positive);
	};
	const policy: Check = (v, p) => {
		if (
			!fields(v, p, [
				"max_parallel",
				"max_child_nodes",
				"max_consultation_rounds",
				"consultation_timeout_ms",
				"cost_limit",
				"currency",
			])
		)
			return;
		for (const name of ["max_parallel", "max_child_nodes", "max_consultation_rounds", "consultation_timeout_ms"])
			optional(v, p, name, positive);
		optional(v, p, "cost_limit", (x, at) => {
			if (typeof x !== "string" || !/^\d+(?:\.\d+)?$/.test(x))
				issue(at, "Expected a nonnegative decimal amount string");
		});
		optional(v, p, "currency", nonempty);
		if (Object.hasOwn(v, "cost_limit") && !Object.hasOwn(v, "currency"))
			issue(child(p, "currency"), "Required with cost_limit");
	};
	const root = source.frontmatter.frontmatter;
	if (
		!fields(
			root,
			"",
			["format", "name", "members", "nodes", "edges", "communications", "loops", "budgets", "policy", "extensions"],
			["format", "name", "members", "nodes"],
		)
	)
		return issues;
	optional(root, "", "format", enumeration("omp.graph/v1"));
	optional(root, "", "name", key);
	optional(root, "", "members", map(member));
	optional(root, "", "nodes", map(node));
	optional(root, "", "edges", array(edge));
	optional(root, "", "communications", array(communication));
	optional(root, "", "loops", map(loop));
	optional(root, "", "budgets", map(budget));
	optional(root, "", "policy", policy);
	optional(
		root,
		"",
		"extensions",
		map(
			() => {},
			(v, p) => {
				if (typeof v !== "string" || !/^x-.+$/.test(v)) issue(p, "Expected an x-* extension key");
			},
		),
	);
	return issues;
}

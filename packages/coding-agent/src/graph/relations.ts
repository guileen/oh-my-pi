import type { GraphSource } from "./source";
import type { GraphIssue } from "./validation-types";

type ObjectMap = Record<string, unknown>;
const object = (value: unknown): ObjectMap =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ObjectMap) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => array(value).filter((item): item is string => typeof item === "string");
const pointer = (value: string): string => value.replace(/~/g, "~0").replace(/\//g, "~1");
const has = (value: ObjectMap, key: string): boolean => Object.hasOwn(value, key);

/** Validate relationships only; callers must also validate the definition's shape. */
export function validateGraphRelations(source: GraphSource): GraphIssue[] {
	const root = object(source.frontmatter.frontmatter);
	const members = object(root.members);
	const nodes = object(root.nodes);
	const budgets = object(root.budgets);
	const loops = object(root.loops);
	const edges = array(root.edges).map(object);
	const issues: GraphIssue[] = [];
	const issue = (path: string, message: string) => issues.push({ path, message });
	const ref = (value: unknown, table: ObjectMap, path: string, label: string) => {
		if (typeof value === "string" && !has(table, value)) issue(path, `Unknown ${label} '${value}'`);
	};
	const heading = (value: unknown, path: string) => {
		if (typeof value === "string" && value.startsWith("#") && !source.headings.has(value.slice(1)))
			issue(path, `Unknown heading '${value}'`);
	};
	const outcomes = (node: ObjectMap) => (node.outcomes === undefined ? ["done"] : strings(node.outcomes));
	for (const [key, raw] of Object.entries(members)) {
		const member = object(raw);
		const path = `/members/${pointer(key)}`;
		heading(member.role, `${path}/role`);
		if (member.duty === "code-only" && member.base !== "omp-default")
			issue(`${path}/base`, "Code-only members must use omp-default");
	}
	for (const [key, raw] of Object.entries(nodes)) {
		const node = object(raw);
		const path = `/nodes/${pointer(key)}`;
		heading(node.task, `${path}/task`);
		ref(node.member, members, `${path}/member`, "member");
		if (node.kind === "human") {
			const outputs = object(node.outputs);
			const bindings = object(node.approved_outputs);
			for (const [name, rawBinding] of Object.entries(bindings)) {
				const at = `${path}/approved_outputs/${pointer(name)}`;
				if (!has(outputs, name)) issue(at, `Unknown output '${name}'`);
				const binding = object(rawBinding);
				const selected = strings(binding.on);
				if (!selected.length) issue(`${at}/on`, "At least one outcome is required");
				if (new Set(selected).size !== selected.length) issue(`${at}/on`, "Duplicate outcome");
				for (const outcome of selected)
					if (!outcomes(node).includes(outcome)) issue(`${at}/on`, `Unknown outcome '${outcome}'`);
				if (object(outputs[name]).required === true && outcomes(node).some(outcome => !selected.includes(outcome)))
					issue(at, "Required output must be available for every outcome");
			}
			for (const [name, output] of Object.entries(outputs)) {
				if (object(output).required === true && !has(bindings, name))
					issue(`${path}/outputs/${pointer(name)}`, "Required human output needs an approved input binding");
			}
		}
		array(node.consume).forEach((budget, i) => ref(budget, budgets, `${path}/consume/${i}`, "budget"));
		if (node.on_budget_exhausted !== "hold") {
			ref(node.on_budget_exhausted, nodes, `${path}/on_budget_exhausted`, "node");
			if (typeof node.on_budget_exhausted === "string" && has(nodes, node.on_budget_exhausted)) {
				const target = object(nodes[node.on_budget_exhausted]);
				if (strings(node.consume).some(budget => strings(target.consume).includes(budget)))
					issue(`${path}/on_budget_exhausted`, "Budget exhaustion target consumes the same budget");
			}
		}
		const declared = outcomes(node);
		for (const outcome of Object.keys(object(node.terminal)))
			if (!declared.includes(outcome)) issue(`${path}/terminal/${pointer(outcome)}`, `Unknown outcome '${outcome}'`);
		const verdicts = strings(node.verdicts);
		array(node.decisions).forEach((rawDecision, i) => {
			const decision = object(rawDecision);
			if (typeof decision.outcome === "string" && !declared.includes(decision.outcome))
				issue(`${path}/decisions/${i}/outcome`, `Unknown outcome '${decision.outcome}'`);
			if (
				typeof decision.verdict === "string" &&
				node.verdicts !== undefined &&
				!verdicts.includes(decision.verdict)
			)
				issue(`${path}/decisions/${i}/verdict`, `Unknown verdict '${decision.verdict}'`);
		});
	}
	for (const [key, raw] of Object.entries(budgets)) {
		const budget = object(raw);
		if (budget.scope === "cycle") ref(budget.loop, loops, `/budgets/${pointer(key)}/loop`, "loop");
		if (
			budget.scope === "cycle" &&
			typeof budget.loop === "string" &&
			has(loops, budget.loop) &&
			object(loops[budget.loop]).scope !== "cycle"
		)
			issue(`/budgets/${pointer(key)}/loop`, "Cycle budget requires a cycle-scoped loop");
	}
	for (const [key, raw] of Object.entries(loops)) {
		const loop = object(raw);
		const path = `/loops/${pointer(key)}`;
		for (const field of ["final_node", "retry_target"]) ref(loop[field], nodes, `${path}/${field}`, "node");
		if (loop.scope === "cycle") ref(loop.cycle_start, nodes, `${path}/cycle_start`, "node");
		for (const field of ["count_nodes", ...(loop.scope === "cycle" ? ["reset_from"] : [])])
			array(loop[field]).forEach((value, i) => ref(value, nodes, `${path}/${field}/${i}`, "node"));
		if (typeof loop.final_node === "string" && has(nodes, loop.final_node)) {
			const declared = outcomes(object(nodes[loop.final_node]));
			for (const [name, value] of Object.entries(object(loop.final_outcomes)))
				if (typeof value === "string" && !declared.includes(value))
					issue(`${path}/final_outcomes/${pointer(name)}`, `Unknown final outcome '${value}'`);
			for (const [input, output] of Object.entries(object(loop.final_bind))) {
				const at = `${path}/final_bind/${pointer(input)}`;
				for (const count of strings(loop.count_nodes))
					if (
						has(nodes, count) &&
						typeof output === "string" &&
						!has(object(object(nodes[count]).outputs), output)
					)
						issue(at, `Unknown output '${output}' on count node '${count}'`);
				if (has(object(object(nodes[loop.final_node]).inputs), input))
					issue(at, `Input '${input}' is already bound`);
				if (edges.some(edge => edge.to === loop.final_node && has(object(edge.bind), input)))
					issue(at, `Input '${input}' has an incoming edge binding`);
				if (
					Object.entries(loops).some(
						([otherKey, other]) =>
							otherKey !== key &&
							object(other).final_node === loop.final_node &&
							has(object(object(other).final_bind), input),
					)
				)
					issue(at, `Input '${input}' has multiple final bindings`);
			}
			for (const [index, count] of array(loop.count_nodes).entries()) {
				for (const [otherKey, rawOther] of Object.entries(loops)) {
					const other = object(rawOther);
					if (
						typeof count === "string" &&
						otherKey !== key &&
						other.final_node === loop.final_node &&
						strings(other.count_nodes).includes(count)
					)
						issue(`${path}/count_nodes/${index}`, `Final source is ambiguous with loop '${otherKey}'`);
				}
			}
		}
	}
	array(root.communications).forEach((raw, i) => {
		const communication = object(raw);
		ref(communication.from, members, `/communications/${i}/from`, "member");
		ref(communication.to, members, `/communications/${i}/to`, "member");
		heading(communication.when, `/communications/${i}/when`);
	});

	const ids = new Set<string>();
	const arcs: { from: string; to: string; path: string }[] = [];
	const bindings = new Map<string, { edge: number; input: string }[]>();
	edges.forEach((edge, i) => {
		const path = `/edges/${i}`;
		if (typeof edge.id === "string") {
			if (ids.has(edge.id)) issue(`${path}/id`, `Duplicate edge id '${edge.id}'`);
			ids.add(edge.id);
		}
		ref(edge.from, nodes, `${path}/from`, "node");
		ref(edge.to, nodes, `${path}/to`, "node");
		ref(edge.loop, loops, `${path}/loop`, "loop");
		if (edge.when_budget !== undefined)
			ref(object(edge.when_budget).budget, budgets, `${path}/when_budget/budget`, "budget");
		const from = typeof edge.from === "string" && has(nodes, edge.from) ? object(nodes[edge.from]) : undefined;
		const to = typeof edge.to === "string" && has(nodes, edge.to) ? object(nodes[edge.to]) : undefined;
		if (from)
			(edge.on === undefined ? ["done"] : array(edge.on)).forEach((value, index) => {
				if (typeof value === "string" && !outcomes(from).includes(value))
					issue(`${path}/on/${index}`, `Unknown outcome '${value}'`);
			});
		for (const [loopKey, raw] of Object.entries(loops)) {
			const loop = object(raw);
			const hold = object(loop.final_outcomes).hold;
			const conditions = edge.on === undefined ? ["done"] : array(edge.on);
			if (
				typeof edge.from === "string" &&
				edge.from === loop.final_node &&
				typeof hold === "string" &&
				conditions.includes(hold)
			)
				issue(`${path}/on`, `Final hold outcome for loop '${loopKey}' cannot route onward`);
		}
		for (const [input, output] of Object.entries(object(edge.bind))) {
			if (from && typeof output === "string" && !has(object(from.outputs), output))
				issue(`${path}/bind/${pointer(input)}`, `Unknown output '${output}'`);
			if (from?.kind === "human" && typeof output === "string") {
				const binding = object(object(from.approved_outputs)[output]);
				const selected = strings(binding.on);
				const routed = edge.on === undefined ? ["done"] : strings(edge.on);
				if (routed.some(outcome => !selected.includes(outcome)))
					issue(
						`${path}/bind/${pointer(input)}`,
						`Human output '${output}' is not available for every routed outcome`,
					);
			}
			if (to && typeof edge.to === "string") {
				const key = JSON.stringify([edge.to, input]);
				const list = bindings.get(key) ?? [];
				list.push({ edge: i, input });
				bindings.set(key, list);
				if (has(object(to.inputs), input))
					issue(`${path}/bind/${pointer(input)}`, `Input '${input}' is already bound`);
			}
		}
		let back = false;
		if (typeof edge.loop === "string" && has(loops, edge.loop)) {
			const loop = object(loops[edge.loop]);
			if (edge.to !== loop.retry_target || edge.from === loop.final_node)
				issue(`${path}/loop`, "Loop edge must return to its retry target and cannot originate at the final node");
			else back = true;
		}
		if (from && to && typeof edge.from === "string" && typeof edge.to === "string" && !back)
			arcs.push({ from: edge.from, to: edge.to, path });
	});
	// Each selected branch must be pairwise exclusive and have no bypass from a root.
	const reachable = (start: string, target: string): boolean => {
		const seen = new Set<string>();
		const pending = [start];
		while (pending.length) {
			const current = pending.pop()!;
			if (current === target) return true;
			if (seen.has(current)) continue;
			seen.add(current);
			for (const arc of arcs) if (arc.from === current) pending.push(arc.to);
		}
		return false;
	};
	const exclusive = (candidates: { edge: number }[]): boolean => {
		const groups = new Map<string, number[]>();
		edges.forEach((edge, i) => {
			if (typeof edge.from !== "string" || typeof edge.branch_group !== "string" || typeof edge.to !== "string")
				return;
			const key = JSON.stringify([edge.from, edge.branch_group]);
			const group = groups.get(key) ?? [];
			group.push(i);
			groups.set(key, group);
		});
		for (const group of groups.values()) {
			const selected: number[] = [];
			for (const candidate of candidates) {
				const edge = edges[candidate.edge];
				if (typeof edge.from !== "string") break;
				const matches = group.filter(
					i =>
						i === candidate.edge ||
						(typeof edges[i].to === "string" && reachable(edges[i].to as string, edge.from as string)),
				);
				if (matches.length !== 1) break;
				selected.push(matches[0]);
			}
			if (selected.length !== candidates.length || new Set(selected).size !== selected.length) continue;
			let disjoint = true;
			for (let a = 0; a < selected.length; a++)
				for (let b = a + 1; b < selected.length; b++) {
					const left = edges[selected[a]];
					const right = edges[selected[b]];
					const leftOutcomes = left.on === undefined ? ["done"] : strings(left.on);
					const rightOutcomes = right.on === undefined ? ["done"] : strings(right.on);
					const lc = object(left.when_budget);
					const rc = object(right.when_budget);
					const budgetExclusive =
						typeof lc.budget === "string" &&
						lc.budget === rc.budget &&
						((lc.state === "available" && rc.state === "exhausted") ||
							(lc.state === "exhausted" && rc.state === "available"));
					if (leftOutcomes.some(outcome => rightOutcomes.includes(outcome)) && !budgetExclusive) disjoint = false;
				}
			// A candidate reached through a bypass could run alongside another branch.
			const blocked = new Set(group.map(i => `/edges/${i}`));
			const roots = Object.keys(nodes).filter(node => !arcs.some(arc => arc.to === node));
			const pending = [...roots];
			const bypass = new Set<string>();
			while (pending.length) {
				const current = pending.pop()!;
				if (bypass.has(current)) continue;
				bypass.add(current);
				for (const arc of arcs) if (arc.from === current && !blocked.has(arc.path)) pending.push(arc.to);
			}
			if (
				disjoint &&
				candidates.every(
					candidate => group.includes(candidate.edge) || !bypass.has(edges[candidate.edge].from as string),
				)
			)
				return true;
		}
		return false;
	};
	for (const [key, candidates] of bindings) {
		const [nodeKey, input] = JSON.parse(key) as [string, string];
		if (candidates.length > 1 && !(object(nodes[nodeKey]).join === "any" && exclusive(candidates)))
			for (const candidate of candidates.slice(1))
				issue(`/edges/${candidate.edge}/bind/${pointer(input)}`, `Input '${input}' has multiple bindings`);
	}
	for (const [key, raw] of Object.entries(nodes)) {
		const node = object(raw);
		if (
			typeof node.on_budget_exhausted === "string" &&
			node.on_budget_exhausted !== "hold" &&
			has(nodes, node.on_budget_exhausted) &&
			strings(node.consume).length
		)
			arcs.push({ from: key, to: node.on_budget_exhausted, path: `/nodes/${pointer(key)}/on_budget_exhausted` });
	}
	for (const [key, raw] of Object.entries(loops)) {
		const loop = object(raw);
		if (typeof loop.final_node !== "string" || !has(nodes, loop.final_node)) continue;
		for (const count of strings(loop.count_nodes))
			if (has(nodes, count))
				arcs.push({ from: count, to: loop.final_node, path: `/loops/${pointer(key)}/final_node` });
	}
	// Every possible route around a declared back edge must consume a review.
	// Otherwise the loop label could conceal an indefinitely repeatable cycle.
	edges.forEach((edge, i) => {
		if (
			typeof edge.loop !== "string" ||
			!has(loops, edge.loop) ||
			typeof edge.from !== "string" ||
			typeof edge.to !== "string"
		)
			return;
		const loop = object(loops[edge.loop]);
		if (
			edge.to !== loop.retry_target ||
			edge.from === loop.final_node ||
			!has(nodes, edge.from) ||
			!has(nodes, edge.to)
		)
			return;
		if (!reachable(edge.to, edge.from)) {
			issue(`/edges/${i}/loop`, "Declared loop edge does not return along a forward route");
			return;
		}
		const counted = new Set(strings(loop.count_nodes));
		const seen = new Set<string>();
		const pending = [edge.to];
		while (pending.length) {
			const current = pending.pop()!;
			if (counted.has(current) || seen.has(current)) continue;
			if (current === edge.from) {
				issue(`/edges/${i}/loop`, "Loop can repeat without reaching a review count node");
				break;
			}
			seen.add(current);
			for (const arc of arcs) if (arc.from === current) pending.push(arc.to);
		}
	});
	// Kahn's algorithm also catches cycles containing virtual exhaustion routes.
	const indegree = new Map(Object.keys(nodes).map(key => [key, 0]));
	for (const arc of arcs) indegree.set(arc.to, (indegree.get(arc.to) ?? 0) + 1);
	const ready = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key);
	while (ready.length) {
		const current = ready.pop()!;
		for (const arc of arcs)
			if (arc.from === current) {
				const degree = indegree.get(arc.to)! - 1;
				indegree.set(arc.to, degree);
				if (degree === 0) ready.push(arc.to);
			}
	}
	for (const arc of arcs)
		if (indegree.get(arc.from)! > 0 && indegree.get(arc.to)! > 0)
			issue(arc.path, "Route participates in or depends on an unbounded cycle");
	return issues;
}

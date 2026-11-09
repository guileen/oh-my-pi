import type { GraphDefinition } from "./contracts";
import type { SchedulerAction, SchedulerInvocation, SchedulerState } from "./scheduler";

/** Rebuilds the affected generation without discarding prior invocation history. */
export function prepareGraphRewind(
	definition: GraphDefinition,
	state: SchedulerState,
	action: Extract<SchedulerAction, { type: "rewind" }>,
	newId: () => string,
): { invocations: SchedulerInvocation[]; cycles: Record<string, string> } {
	const edge = definition.edges?.find(item => item.id === action.edge);
	const loop = definition.loops?.[action.loop];
	if (!edge || !loop || edge.loop !== action.loop || edge.to !== action.target)
		throw new Error("Rewind edge no longer matches the frozen definition");
	const active = new Map<string, SchedulerInvocation>();
	for (const item of state.invocations) {
		if (item.superseded || item.consultation) continue;
		if (active.has(item.node)) throw new Error(`Ambiguous active generation for ${item.node}`);
		active.set(item.node, item);
	}
	const source = active.get(edge.from);
	if (!source || source.id !== action.invocation_id || source.state !== "succeeded" || source.routed)
		throw new Error("Rewind source is not the current unrouted success");
	const affected = new Set(action.affected_nodes);
	if (!affected.has(edge.from) || !affected.has(edge.to)) throw new Error("Rewind path is incomplete");
	const descendants = new Set(affected);
	const work = [...descendants];
	for (let i = 0; i < work.length; i++) {
		const node = work[i];
		const next = (definition.edges ?? []).filter(item => !item.loop && item.from === node).map(item => item.to);
		const budgetTarget = definition.nodes[node]?.on_budget_exhausted;
		if (budgetTarget && budgetTarget !== "hold") next.push(budgetTarget);
		for (const rule of Object.values(definition.loops ?? {}))
			if (rule.count_nodes.includes(node)) next.push(rule.final_node);
		for (const target of next)
			if (!descendants.has(target)) {
				descendants.add(target);
				work.push(target);
			}
	}
	for (const item of state.invocations) {
		if (
			item.consultation &&
			!item.superseded &&
			descendants.has(item.node) &&
			!["succeeded", "failed", "cancelled"].includes(item.state)
		)
			throw new Error(`Cannot rewind while ${item.node} has an unresolved consultation`);
	}
	for (const node of descendants) {
		const item = active.get(node);
		if (!item) throw new Error(`Missing active invocation for ${node}`);
		if (item.id === source.id) continue;
		if (["running", "waiting", "unknown"].includes(item.state))
			throw new Error(`Cannot rewind while ${node} has an unresolved execution`);
		if (!affected.has(node) && (item.state === "succeeded" || item.state === "failed"))
			throw new Error(`Cannot automatically replay completed downstream ${node}`);
	}
	const ids = new Map([...descendants].map(node => [node, newId()]));
	const allIds = new Set(state.invocations.map(item => item.id));
	for (const id of ids.values()) {
		if (!id || allIds.has(id)) throw new Error("Rewind invocation identity collision");
		allIds.add(id);
	}
	const replacements: SchedulerInvocation[] = [];
	for (const node of descendants) {
		const old = active.get(node)!;
		const upstream: Record<string, string> = {};
		for (const incoming of (definition.edges ?? []).filter(item => item.to === node && !item.loop)) {
			const original = old.upstream[incoming.id];
			if (!original) throw new Error(`Missing frozen upstream for ${incoming.id}`);
			const from = active.get(incoming.from);
			if (!from || from.id !== original) throw new Error(`Stale frozen upstream for ${incoming.id}`);
			upstream[incoming.id] = ids.get(incoming.from) ?? original;
		}
		if (node === edge.to) upstream[edge.id] = source.id;
		replacements.push({
			id: ids.get(node)!,
			node,
			iteration: old.iteration + 1,
			scope_id: old.scope_id,
			state: "pending",
			upstream,
		});
	}
	const cycles = { ...state.cycles };
	if (action.new_cycle) {
		if (loop.scope !== "cycle" || edge.to !== loop.cycle_start || !(loop.reset_from ?? []).includes(edge.from))
			throw new Error("Undeclared cycle reset");
		cycles[action.loop] = newId();
	}
	return {
		invocations: [
			...state.invocations.map(item =>
				descendants.has(item.node) && !item.superseded && !item.consultation
					? { ...item, superseded: true, ...(item.id === source.id ? { routed: true } : {}) }
					: item,
			),
			...replacements,
		],
		cycles,
	};
}

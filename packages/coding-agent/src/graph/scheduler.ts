import type { GraphRef, GraphRunState, SchedulerInvocationState } from "@oh-my-pi/pi-wire/graph";
import type { GraphDefinition, GraphEdge, GraphInput, GraphNode } from "./contracts";

/** A persisted invocation snapshot. `upstream` pins each incoming edge to one exact invocation. */
export interface SchedulerInvocation {
	id: string;
	node: string;
	iteration: number;
	scope_id: string;
	state: SchedulerInvocationState;
	/** Historical invocation invalidated by a later generation; retained for causal references. */
	superseded?: boolean;
	/** A rewind target pins its triggering loop edge here, in addition to ordinary incoming edges. */
	upstream: Record<string, string>;
	origin?: "executed" | "imported";
	attempt_id?: string;
	/** Auxiliary consultation work is independently recorded and never routed as a graph node. */
	consultation?: { conversation_id: string; message_id: string; member_id: string };
	consultation_wait?: { conversation_id: string; message_id: string };
	completion_order?: string;
	outcome?: string | null;
	verdict?: string | null;
	outputs?: Record<string, GraphRef>;
	/** Persisted once for an any join, together with the ready transition. */
	winner_edge?: string;
	/** Virtual targets are dormant until the host persists a route to them. */
	activated?: boolean;
	/** Route source identity, frozen by the host when the virtual target is activated. */
	activation_source?: { invocation_id: string; attempt_id?: string; reason: "loop_exhausted" | "budget_exhausted" };
	/** Set after the terminal result has been routed. */
	routed?: boolean;
	/** Outgoing edges suppressed by a persisted virtual route. */
	suppressed_edges?: string[];
}

export interface SchedulerCounter {
	key: string;
	consumed: number;
	reservations: string[];
}

export interface SchedulerState {
	run_state: GraphRunState;
	invocations: SchedulerInvocation[];
	/** Current cycle ID for each cycle-scoped loop; stage IDs come from the definition. */
	cycles: Record<string, string>;
	counters: SchedulerCounter[];
	run_inputs?: Record<string, GraphRef>;
}

export type SchedulerInput = string | GraphRef;
export interface SchedulerError {
	code: "invalid_state" | "gate_unsatisfied" | "budget_exhausted";
	message: string;
	invocation_id?: string;
}

export interface SchedulerReservation {
	key: string;
	reservation: string;
	limit: number;
}
export type SchedulerAction =
	| {
			type: "ready";
			invocation_id: string;
			inputs: Record<string, SchedulerInput>;
			upstream_invocation_ids: string[];
			upstream_attempt_ids: string[];
			winner_edge?: string;
	  }
	| { type: "authorize"; invocation_id: string; reservations: SchedulerReservation[] }
	| { type: "skip" | "block"; invocation_id: string; reason: string }
	| { type: "hold"; invocation_id: string; error: SchedulerError }
	| {
			type: "route";
			invocation_id: string;
			target: string;
			reason: "loop_exhausted" | "budget_exhausted";
			counter_key?: string;
			suppressed_edges?: string[];
	  }
	| {
			type: "rewind";
			invocation_id: string;
			loop: string;
			edge: string;
			target: string;
			affected_nodes: string[];
			new_cycle: boolean;
			suppressed_edges?: string[];
	  }
	| { type: "finish"; invocation_id: string; disposition: "succeed" | "fail" }
	| { type: "routed"; invocation_id: string; suppressed_edges?: string[] };
export interface SchedulerPlan {
	action: SchedulerAction | null;
	errors: SchedulerError[];
}

const outgoing = (definition: GraphDefinition, node: string) =>
	(definition.edges ?? []).filter(edge => edge.from === node);
const selected = (edge: GraphEdge, outcome: string) => (edge.on ?? ["done"]).includes(outcome);
const ordinal = (value: string) => (/^\d+$/.test(value) ? BigInt(value) : null);
const error = (
	invocation: SchedulerInvocation,
	message: string,
	code: SchedulerError["code"] = "invalid_state",
): SchedulerPlan => {
	const detail = { code, message, invocation_id: invocation.id };
	return { action: { type: "hold", invocation_id: invocation.id, error: detail }, errors: [detail] };
};
const action = (value: SchedulerAction): SchedulerPlan => ({ action: value, errors: [] });

/** Project the frozen ready decision per edge, not merely per upstream invocation. */
export function graphReadyEdgeSelected(
	definition: GraphDefinition,
	target: SchedulerInvocation & { ready?: Extract<SchedulerAction, { type: "ready" }> },
	source: SchedulerInvocation,
	edge: GraphEdge,
): boolean {
	const ready = target.ready;
	return !!(
		ready &&
		edge.to === target.node &&
		edge.from === source.node &&
		target.upstream[edge.id] === source.id &&
		ready.upstream_invocation_ids.includes(source.id) &&
		(source.origin === "imported" || (source.attempt_id && ready.upstream_attempt_ids.includes(source.attempt_id))) &&
		selected(edge, source.outcome ?? "") &&
		!source.suppressed_edges?.includes(edge.id) &&
		(edge.loop || definition.nodes[target.node]?.join !== "any" || ready.winner_edge === edge.id)
	);
}

function scopeKey(
	definition: GraphDefinition,
	state: SchedulerState,
	kind: "loop" | "budget",
	name: string,
): string | null {
	if (kind === "loop") {
		const loop = definition.loops?.[name];
		if (!loop) return null;
		const scope = loop.scope === "stage" ? loop.stage : state.cycles[name];
		return scope ? `loop:${name}:${loop.scope}:${scope}` : null;
	}
	const budget = definition.budgets?.[name];
	if (!budget) return null;
	if (budget.scope === "cycle" && definition.loops?.[budget.loop ?? ""]?.scope !== "cycle") return null;
	const scope =
		budget.scope === "run" ? "run" : budget.scope === "stage" ? budget.stage : state.cycles[budget.loop ?? ""];
	return scope ? `budget:${name}:${budget.scope}:${scope}` : null;
}

/** Shared by admission and durable child-authority checks; never consumes a budget. */
export function graphReservationRequirements(
	definition: GraphDefinition,
	state: SchedulerState,
	invocation: SchedulerInvocation,
): SchedulerReservation[] | { error: string } {
	const node = definition.nodes[invocation.node];
	if (!node) return { error: `Missing node ${invocation.node}` };
	const reservations: SchedulerReservation[] = [];
	for (const name of node.consume ?? []) {
		const key = scopeKey(definition, state, "budget", name);
		const budget = definition.budgets?.[name];
		if (!key || !budget) return { error: `Missing budget or scope ${name}` };
		reservations.push({ key, reservation: invocation.id, limit: budget.limit });
	}
	for (const [name, loop] of Object.entries(definition.loops ?? {}))
		if (loop.count_nodes.includes(invocation.node)) {
			const key = scopeKey(definition, state, "loop", name);
			if (!key) return { error: `Missing scope for loop ${name}` };
			reservations.push({ key, reservation: invocation.id, limit: loop.max_reviews });
		}
	for (const [name, loop] of Object.entries(definition.loops ?? {}))
		if (loop.final_node === invocation.node) {
			const key = scopeKey(definition, state, "loop", name);
			if (!key) return { error: `Missing scope for loop ${name}` };
			reservations.push({ key: `final:${key}`, reservation: invocation.id, limit: 1 });
		}
	return reservations;
}

/** Shared by result admission and routing; neither path may accept a weaker contract. */
export function graphCompletionError(
	node: GraphNode,
	invocation: Pick<SchedulerInvocation, "outcome" | "verdict" | "outputs">,
): string | null {
	const outcome = invocation.outcome;
	if (!outcome || !(node.outcomes ?? ["done"]).includes(outcome)) return "Missing or undeclared outcome";
	const verdict = invocation.verdict;
	if (node.verdicts && (!verdict || !node.verdicts.includes(verdict))) return "Missing or undeclared verdict";
	if (!node.verdicts && verdict != null && verdict !== outcome)
		return "Verdict must equal outcome when verdicts are not declared";
	if (
		node.decisions &&
		!node.decisions.some(decision => decision.outcome === outcome && decision.verdict === (verdict ?? outcome))
	)
		return "Outcome and verdict combination is not declared";
	const outputs = invocation.outputs;
	if (outputs !== undefined && (!outputs || typeof outputs !== "object" || Array.isArray(outputs)))
		return "Invalid output map";
	for (const [name, output] of Object.entries(node.outputs ?? {})) {
		if (output.required && (!outputs || !Object.hasOwn(outputs, name))) return `Missing required output ${name}`;
	}
	for (const [name, ref] of Object.entries(outputs ?? {})) {
		if (
			!Object.hasOwn(node.outputs ?? {}, name) ||
			!ref ||
			typeof ref.id !== "string" ||
			!ref.id.trim() ||
			typeof ref.digest !== "string" ||
			!ref.digest.trim()
		)
			return `Invalid or undeclared output ${name}`;
	}
	return null;
}

/** Nodes on a non-loop path from start to end, including both endpoints. */
function pathNodes(definition: GraphDefinition, start: string, end: string): string[] {
	const edges = (definition.edges ?? []).filter(edge => !edge.loop);
	const walk = (root: string, reverse: boolean): Set<string> => {
		const seen = new Set([root]);
		const queue = [root];
		for (let i = 0; i < queue.length; i++)
			for (const edge of edges) {
				const from = reverse ? edge.to : edge.from;
				const to = reverse ? edge.from : edge.to;
				if (from === queue[i] && !seen.has(to)) {
					seen.add(to);
					queue.push(to);
				}
			}
		return seen;
	};
	const forward = walk(start, false);
	if (!forward.has(end)) return [];
	const backward = walk(end, true);
	return [...forward].filter(node => backward.has(node)).sort();
}

function initialInput(binding: GraphInput, state: SchedulerState): SchedulerInput | undefined {
	if (binding.text !== undefined) return binding.text;
	if (binding.artifact !== undefined) return binding.artifact;
	return binding.run_input === undefined ? undefined : state.run_inputs?.[binding.run_input];
}

/**
 * Compute one deterministic transaction. The host must CAS the complete snapshot, persist the
 * action atomically, and call again. This function never mutates the definition or state.
 * Loop rewinds require the host to create fresh invocations for `affected_nodes`, pin their
 * upstream identities, and preserve all old records. The target pins the triggering loop edge
 * to the source invocation; that edge supplies mandatory inputs independently of the normal join.
 * A route must atomically activate its target, mark its source routed, and persist its suppressed
 * edges; a budget-routed ready invocation must be skipped. Cycle IDs and imported-output
 * authorization are host-owned.
 */
export function planGraphSchedule(definition: GraphDefinition, state: SchedulerState): SchedulerPlan {
	if (state.run_state !== "queued" && state.run_state !== "running") return { action: null, errors: [] };
	const invocations = new Map(state.invocations.map(invocation => [invocation.id, invocation]));
	const virtualSources = new Map<string, Set<string>>();
	const addVirtualSource = (target: string, source: string) => {
		const sources = virtualSources.get(target) ?? new Set<string>();
		sources.add(source);
		virtualSources.set(target, sources);
	};
	for (const loop of Object.values(definition.loops ?? {})) {
		if (!virtualSources.has(loop.final_node)) virtualSources.set(loop.final_node, new Set());
		for (const source of loop.count_nodes) addVirtualSource(loop.final_node, source);
	}
	for (const [key, node] of Object.entries(definition.nodes))
		if (node.on_budget_exhausted && node.on_budget_exhausted !== "hold")
			addVirtualSource(node.on_budget_exhausted, key);
	const ordered = state.invocations
		.filter(invocation => !invocation.superseded && !invocation.consultation)
		.sort((a, b) => a.id.localeCompare(b.id));
	const active = new Map<string, SchedulerInvocation | null>();
	for (const invocation of ordered) active.set(invocation.node, active.has(invocation.node) ? null : invocation);
	// Dormant virtual routes become inapplicable only when all possible activators
	// have settled without selecting them, including chains of virtual routes.
	const dormant = new Map<string, boolean>();
	const checking = new Set<string>();
	const dormantRouteSettled = (invocation: SchedulerInvocation): boolean => {
		if (invocation.state !== "pending" || invocation.activated) return false;
		const sources = virtualSources.get(invocation.node);
		if (!sources || checking.has(invocation.id)) return false;
		const known = dormant.get(invocation.id);
		if (known !== undefined) return known;
		checking.add(invocation.id);
		let settled = true;
		for (const node of sources) {
			const source = active.get(node);
			if (
				!source ||
				!(
					(source.state === "succeeded" && source.routed === true) ||
					source.state === "skipped" ||
					source.state === "failed" ||
					source.state === "blocked" ||
					source.state === "cancelled" ||
					dormantRouteSettled(source)
				)
			) {
				settled = false;
				break;
			}
		}
		checking.delete(invocation.id);
		dormant.set(invocation.id, settled);
		return settled;
	};
	for (const invocation of ordered) {
		const node = definition.nodes[invocation.node];
		if (!node) return error(invocation, `Unknown node ${invocation.node}`);
		if (invocation.state === "succeeded" && !invocation.routed) {
			const problem = graphCompletionError(node, invocation);
			if (problem) return error(invocation, problem, "gate_unsatisfied");
			const outcome = invocation.outcome as string;
			const outcomeEdges = outgoing(definition, invocation.node).filter(edge => selected(edge, outcome));
			const suppressed: string[] = [];
			for (const edge of outcomeEdges) {
				if (!edge.when_budget) continue;
				const { budget: name, state: expected } = edge.when_budget;
				const budget = definition.budgets?.[name];
				const key = scopeKey(definition, state, "budget", name);
				if (!budget || !key) return error(invocation, `Missing budget or scope ${name}`);
				if (
					(expected !== "available" && expected !== "exhausted") ||
					!Number.isSafeInteger(budget.limit) ||
					budget.limit < 1
				)
					return error(invocation, `Invalid budget condition ${name}`);
				const counters = state.counters.filter(counter => counter.key === key);
				if (
					counters.length > 1 ||
					(counters[0] && (!Number.isSafeInteger(counters[0].consumed) || counters[0].consumed < 0))
				)
					return error(invocation, `Ambiguous or invalid budget counter ${key}`);
				const exhausted = (counters[0]?.consumed ?? 0) >= budget.limit;
				if ((expected === "exhausted") !== exhausted) suppressed.push(edge.id);
			}
			const edges = outcomeEdges.filter(edge => !suppressed.includes(edge.id));
			const frozenSuppression = outcomeEdges.some(edge => edge.when_budget) ? suppressed.sort() : undefined;
			for (const [name, loop] of Object.entries(definition.loops ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
				if (loop.final_node === invocation.node && outcome === loop.final_outcomes.hold)
					return error(invocation, "Final review requires hold", "gate_unsatisfied");
				if (!loop.count_nodes.includes(invocation.node)) continue;
				const key = scopeKey(definition, state, "loop", name);
				if (!key) return error(invocation, `Missing scope for loop ${name}`);
				const used = state.counters.find(counter => counter.key === key)?.consumed ?? 0;
				const retryEdges = (definition.edges ?? []).filter(edge => edge.loop === name);
				const retryEdgesSelected = edges.filter(edge =>
					retryEdges.some(retry => edge.id === retry.id || pathNodes(definition, edge.to, retry.from).length > 0),
				);
				if (used >= loop.max_reviews && retryEdgesSelected.length)
					return action({
						type: "route",
						invocation_id: invocation.id,
						target: loop.final_node,
						reason: "loop_exhausted",
						counter_key: key,
						suppressed_edges: [...new Set([...suppressed, ...retryEdgesSelected.map(edge => edge.id)])].sort(),
					});
			}
			const backEdges = edges.filter(edge => edge.loop);
			if (backEdges.length > 1) return error(invocation, "Multiple selected loop edges");
			const back = backEdges[0];
			if (back && Object.values(definition.loops ?? {}).some(loop => loop.final_node === invocation.node))
				return error(invocation, "Final review cannot route back to revision", "gate_unsatisfied");
			if (back?.loop) {
				const loop = definition.loops?.[back.loop];
				if (!loop) return error(invocation, `Unknown loop ${back.loop}`);
				if (
					invocation.completion_order === undefined ||
					ordinal(invocation.completion_order) === null ||
					(invocation.origin !== "imported" && !invocation.attempt_id)
				)
					return error(invocation, "Successful upstream lacks versioned identity or completion order");
				for (const output of Object.values(back.bind ?? {}))
					if (!invocation.outputs?.[output])
						return error(invocation, `Missing upstream output ${back.from}.${output}`, "gate_unsatisfied");
				const affected = pathNodes(definition, back.to, back.from);
				if (!affected.length) return error(invocation, `Invalid loop edge ${back.id}`);
				return action({
					type: "rewind",
					invocation_id: invocation.id,
					loop: back.loop,
					edge: back.id,
					target: back.to,
					affected_nodes: affected,
					...(frozenSuppression ? { suppressed_edges: frozenSuppression } : {}),
					new_cycle:
						loop.scope === "cycle" && back.to === loop.cycle_start && (loop.reset_from ?? []).includes(back.from),
				});
			}
			if (edges.length)
				return action({
					type: "routed",
					invocation_id: invocation.id,
					...(frozenSuppression ? { suppressed_edges: frozenSuppression } : {}),
				});
			const terminal =
				node.terminal?.[outcome] ??
				((node.outcomes ?? ["done"]).length === 1 &&
				(node.outcomes ?? ["done"])[0] === "done" &&
				outgoing(definition, invocation.node).length === 0
					? "succeed"
					: "hold");
			if (terminal === "hold")
				return error(invocation, "No applicable route or terminal disposition", "gate_unsatisfied");
			return action({ type: "finish", invocation_id: invocation.id, disposition: terminal });
		}
		if (invocation.state === "ready") {
			const reservations = graphReservationRequirements(definition, state, invocation);
			if (!Array.isArray(reservations)) return error(invocation, reservations.error);
			for (const reservation of reservations) {
				const counter = state.counters.find(item => item.key === reservation.key);
				if (
					!counter?.reservations.includes(reservation.reservation) &&
					(counter?.consumed ?? 0) >= reservation.limit
				) {
					if (reservation.key.startsWith("loop:")) {
						const entry = Object.entries(definition.loops ?? {}).find(
							([name]) => scopeKey(definition, state, "loop", name) === reservation.key,
						);
						if (!entry) return error(invocation, "Unknown loop counter");
						if (Object.keys(entry[1].final_bind ?? {}).length)
							return error(
								invocation,
								"Loop exhaustion before review has no final binding source",
								"gate_unsatisfied",
							);
						return action({
							type: "route",
							invocation_id: invocation.id,
							target: entry[1].final_node,
							reason: "loop_exhausted",
							counter_key: reservation.key,
						});
					}
					if (reservation.key.startsWith("final:"))
						return error(invocation, "Final review already consumed for this scope", "budget_exhausted");
					if (node.on_budget_exhausted && node.on_budget_exhausted !== "hold")
						return action({
							type: "route",
							invocation_id: invocation.id,
							target: node.on_budget_exhausted,
							reason: "budget_exhausted",
							counter_key: reservation.key,
						});
					return error(invocation, `Budget exhausted: ${reservation.key}`, "budget_exhausted");
				}
			}
			if (
				state.invocations.filter(item => !item.superseded && item.state === "running").length >=
				(definition.policy?.max_parallel ?? 1)
			)
				continue;
			if (
				node.kind === "bot" &&
				node.member &&
				state.invocations.some(
					item =>
						!item.superseded &&
						item.state === "running" &&
						(item.consultation?.member_id ?? definition.nodes[item.node]?.member) === node.member,
				)
			)
				continue;
			return action({ type: "authorize", invocation_id: invocation.id, reservations });
		}
		if (invocation.state !== "pending") continue;
		if (virtualSources.has(invocation.node) && !invocation.activated) continue;
		const finalLoops = Object.values(definition.loops ?? {}).filter(loop => loop.final_node === invocation.node);
		let finalSource: SchedulerInvocation | undefined;
		let finalBindings: Record<string, string> = {};
		if (finalLoops.some(loop => Object.keys(loop.final_bind ?? {}).length)) {
			const activation = invocation.activation_source;
			if (!activation || activation.reason !== "loop_exhausted")
				return error(invocation, "Missing loop exhaustion source for final bindings");
			const source = invocations.get(activation.invocation_id);
			const matches = finalLoops.filter(loop => source && loop.count_nodes.includes(source.node));
			if (!source || source.id === invocation.id || matches.length !== 1)
				return error(invocation, "Invalid or ambiguous final binding source");
			if (source.state !== "succeeded" || !source.routed)
				return error(invocation, "Final binding source is not a routed success");
			if (source.attempt_id !== activation.attempt_id || (source.origin !== "imported" && !source.attempt_id))
				return error(invocation, "Final binding source attempt is missing or stale");
			if (source.completion_order === undefined || ordinal(source.completion_order) === null)
				return error(invocation, "Final binding source lacks completion order");
			const sourceNode = definition.nodes[source.node];
			const problem = sourceNode && graphCompletionError(sourceNode, source);
			if (!sourceNode || problem)
				return error(invocation, problem ?? "Unknown final binding source", "gate_unsatisfied");
			finalSource = source;
			finalBindings = matches[0].final_bind ?? {};
		}
		const loopInputs = (definition.edges ?? []).filter(
			edge => edge.to === invocation.node && edge.loop && invocation.upstream[edge.id],
		);
		if (loopInputs.length > 1) return error(invocation, "Multiple triggering loop edges");
		let loopCandidate: { edge: GraphEdge; source: SchedulerInvocation; order: bigint } | undefined;
		if (loopInputs.length) {
			const edge = loopInputs[0];
			const source = invocations.get(invocation.upstream[edge.id]);
			if (!source || source.node !== edge.from || source.id === invocation.id)
				return error(invocation, `Invalid upstream identity for loop edge ${edge.id}`);
			if (source.state !== "succeeded" || !source.routed)
				return error(invocation, `Loop edge ${edge.id} source is not a routed success`);
			const sourceNode = definition.nodes[source.node];
			const problem = sourceNode && graphCompletionError(sourceNode, source);
			if (!sourceNode || problem) return error(source, problem ?? "Unknown source node", "gate_unsatisfied");
			if (selected(edge, source.outcome as string) && edge.when_budget && !source.suppressed_edges)
				return error(source, `Missing frozen budget branch result for edge ${edge.id}`);
			if (!selected(edge, source.outcome as string) || source.suppressed_edges?.includes(edge.id))
				return error(invocation, `Loop edge ${edge.id} was not selected`);
			const order = source.completion_order === undefined ? null : ordinal(source.completion_order);
			if (order === null || (source.origin !== "imported" && !source.attempt_id))
				return error(source, "Successful upstream lacks versioned identity or completion order");
			loopCandidate = { edge, source, order };
		}
		const incoming = (definition.edges ?? []).filter(edge => edge.to === invocation.node && !edge.loop);
		const candidates: { edge: GraphEdge; source: SchedulerInvocation; order: bigint }[] = [];
		let waiting = false;
		let failed = false;
		for (const edge of incoming) {
			const id = invocation.upstream[edge.id];
			if (!id) {
				waiting = true;
				continue;
			}
			const source = invocations.get(id);
			if (!source || source.node !== edge.from)
				return error(invocation, `Invalid upstream identity for edge ${edge.id}`);
			if (source.state === "skipped" || dormantRouteSettled(source)) continue;
			if (source.state === "failed" || source.state === "blocked" || source.state === "cancelled") {
				failed = true;
				continue;
			}
			if (source.state !== "succeeded") {
				waiting = true;
				continue;
			}
			if (!source.routed) {
				waiting = true;
				continue;
			}
			const sourceNode = definition.nodes[source.node];
			const problem = sourceNode && graphCompletionError(sourceNode, source);
			if (!sourceNode || problem) return error(source, problem ?? "Unknown source node", "gate_unsatisfied");
			if (selected(edge, source.outcome as string) && edge.when_budget && !source.suppressed_edges)
				return error(source, `Missing frozen budget branch result for edge ${edge.id}`);
			if (!selected(edge, source.outcome as string) || source.suppressed_edges?.includes(edge.id)) continue;
			const order = source.completion_order === undefined ? null : ordinal(source.completion_order);
			if (order === null || order === undefined || (source.origin !== "imported" && !source.attempt_id))
				return error(source, "Successful upstream lacks versioned identity or completion order");
			candidates.push({ edge, source, order });
		}
		candidates.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.edge.id.localeCompare(b.edge.id)));
		let chosen = candidates;
		if (node.join === "any") {
			if (invocation.winner_edge) {
				const winner = candidates.find(candidate => candidate.edge.id === invocation.winner_edge);
				if (!winner) return error(invocation, "Persisted any winner is unavailable or stale");
				chosen = [winner];
			} else chosen = candidates.slice(0, 1);
			if (
				waiting &&
				candidates.length &&
				incoming.some(edge => {
					const source = invocations.get(invocation.upstream[edge.id]);
					return source?.state === "succeeded" && !source.routed;
				})
			)
				continue;
			if (!chosen.length && waiting) continue;
		} else {
			if (failed) return action({ type: "block", invocation_id: invocation.id, reason: "Required upstream failed" });
			if (waiting) continue;
		}
		if (incoming.length && !chosen.length && !loopCandidate && !finalSource)
			return action({
				type: failed ? "block" : "skip",
				invocation_id: invocation.id,
				reason: failed ? "No upstream can succeed" : "No applicable incoming branch",
			});
		if (loopCandidate) chosen = [...chosen, loopCandidate];
		const inputs: Record<string, SchedulerInput> = {};
		for (const [name, binding] of Object.entries(node.inputs ?? {})) {
			const value = initialInput(binding, state);
			if (value !== undefined) inputs[name] = value;
		}
		for (const { edge, source } of chosen)
			for (const [name, output] of Object.entries(edge.bind ?? {})) {
				const value = source.outputs?.[output];
				if (!value) return error(invocation, `Missing upstream output ${edge.from}.${output}`, "gate_unsatisfied");
				if (inputs[name] !== undefined) return error(invocation, `Duplicate binding for ${name}`);
				inputs[name] = value;
			}
		if (finalSource)
			for (const [name, output] of Object.entries(finalBindings)) {
				const value = finalSource.outputs?.[output];
				if (!value)
					return error(invocation, `Missing upstream output ${finalSource.node}.${output}`, "gate_unsatisfied");
				if (inputs[name] !== undefined) return error(invocation, `Duplicate binding for ${name}`);
				inputs[name] = value;
			}
		for (const name of node.required_inputs ?? [])
			if (inputs[name] === undefined) return error(invocation, `Missing required input ${name}`, "gate_unsatisfied");
		return action({
			type: "ready",
			invocation_id: invocation.id,
			inputs,
			upstream_invocation_ids: [
				...new Set([...chosen.map(item => item.source.id), ...(finalSource ? [finalSource.id] : [])]),
			],
			upstream_attempt_ids: [
				...new Set([
					...chosen.flatMap(item => (item.source.attempt_id ? [item.source.attempt_id] : [])),
					...(finalSource?.attempt_id ? [finalSource.attempt_id] : []),
				]),
			],
			...(node.join === "any" && chosen[0] && chosen[0] !== loopCandidate ? { winner_edge: chosen[0].edge.id } : {}),
		});
	}
	return { action: null, errors: [] };
}

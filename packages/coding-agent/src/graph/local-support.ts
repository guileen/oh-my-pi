import type { GraphDefinition, GraphEdge } from "./contracts";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import { validateExecuteGrant, validateGrantPattern } from "./workspace-grants";

/**
 * Local foreground admission is deliberately narrower than the general Graph schema.
 * Graph prose grants no tools, so every capability here is an execution fact, not a role.
 * Kept free of session/agent imports: dispatch, discovery and the runner share one rule set.
 */
export class LocalSupportError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "LocalSupportError";
	}
}

function required(condition: unknown, message: string): asserts condition {
	if (!condition) throw new LocalSupportError("capability_unavailable", message);
}

/**
 * The only locally admitted branching program graph is the bounded coding workflow.
 * The topology is a security boundary: no Bot can route around acceptance or turn
 * an exhausted review into success.
 */
function assertDailyCodingSupported(definition: GraphDefinition, availableInputs: ReadonlySet<string> | null): void {
	const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
	const names = Object.keys(definition.nodes).sort();
	required(
		equal(names, ["acceptance", "deliver", "exhausted", "implement", "review"]),
		"Unsupported coding graph nodes",
	);
	const { acceptance, deliver, exhausted, implement, review } = definition.nodes;
	required(
		acceptance.kind === "program" &&
			acceptance.executor === "daily-code-acceptance" &&
			equal(acceptance.outcomes, ["pass", "revise"]) &&
			equal(acceptance.outputs, { evidence: { media_type: "text/plain", required: true } }) &&
			acceptance.required_gate === true &&
			!acceptance.terminal &&
			!acceptance.parameters &&
			Object.keys(acceptance).every(key =>
				["kind", "executor", "task", "inputs", "required_inputs", "outputs", "outcomes", "required_gate"].includes(
					key,
				),
			),
		"Unsupported acceptance node",
	);
	required(
		[implement, review, deliver, exhausted].every(node => node.kind === "bot") &&
			exhausted.required_gate === true &&
			equal(exhausted.outcomes, ["stop", "hold"]) &&
			equal(exhausted.terminal, { stop: "hold", hold: "hold" }) &&
			!implement.terminal &&
			!review.terminal &&
			!deliver.terminal &&
			Object.values(definition.members).every(member => member.permissions.execute.length === 0),
		"Coding members cannot execute commands and exhaustion must hold",
	);
	const expectedEdges: GraphEdge[] = [
		{ id: "implement-review", from: "implement", to: "review", bind: { changes: "changes" } },
		{ id: "review-acceptance", from: "review", to: "acceptance", bind: { review: "review" } },
		{
			id: "acceptance-rework",
			from: "acceptance",
			to: "implement",
			on: ["revise"],
			bind: { failure: "evidence" },
			loop: "rework",
		},
		{ id: "acceptance-deliver", from: "acceptance", to: "deliver", on: ["pass"], bind: { evidence: "evidence" } },
	];
	required(equal(definition.edges, expectedEdges), "Unsupported coding graph routes");
	const loop = definition.loops?.rework;
	required(
		Object.keys(definition.loops ?? {}).length === 1 &&
			loop &&
			Number.isSafeInteger(loop.max_reviews) &&
			loop.max_reviews >= 1 &&
			loop.max_reviews <= 3 &&
			equal(
				{ ...loop, max_reviews: 3 },
				{
					max_reviews: 3,
					final_node: "exhausted",
					retry_target: "implement",
					final_outcomes: { go: "stop", hold: "hold" },
					final_bind: { evidence: "evidence" },
					count_nodes: ["acceptance"],
					scope: "stage",
					stage: "coding",
				},
			),
		"Unsupported coding graph loop",
	);
	// Reuse the ordinary member, input and output capability checks on a synthetic
	// serial projection. This projection is never executed.
	const { executor: _executor, required_gate: _acceptanceGate, ...program } = acceptance;
	const { required_gate: _finalGate, ...final } = exhausted;
	const projection: GraphDefinition = {
		...definition,
		loops: {},
		nodes: {
			implement,
			review,
			acceptance: { ...program, kind: "bot", member: implement.member },
			deliver,
			exhausted: final,
		},
		edges: [
			expectedEdges[0],
			expectedEdges[1],
			{ id: "acceptance-deliver", from: "acceptance", to: "deliver", bind: { evidence: "evidence" } },
			{ id: "deliver-exhausted", from: "deliver", to: "exhausted", bind: { evidence: "report" } },
		],
	};
	assertLocalRunSupported(projection, availableInputs);
}

export function assertLocalRunSupported(
	definition: GraphDefinition,
	availableInputs: ReadonlySet<string> | null = null,
): void {
	if (Object.values(definition.nodes).some(node => node.kind === "program")) {
		assertDailyCodingSupported(definition, availableInputs);
		return;
	}
	const nodes = Object.entries(definition.nodes);
	const edges = definition.edges ?? [];
	required(nodes.length >= 2 && nodes.length <= 64, "Local runs require 2..64 serial Bot nodes");
	required(
		!definition.communications?.length &&
			!Object.keys(definition.loops ?? {}).length &&
			!Object.keys(definition.budgets ?? {}).length &&
			Object.keys(definition.extensions ?? {}).every(extension => extension === "x-contract"),
		"Local runs do not support consultations, loops or scoped budgets; x-contract is the only supported extension",
	);
	required(
		!definition.policy ||
			(Object.keys(definition.policy).every(key => key === "max_parallel") &&
				(definition.policy.max_parallel ?? 1) === 1),
		"Local runs support only max_parallel: 1; monetary ceilings and advanced policy are unavailable",
	);
	for (const [name, member] of Object.entries(definition.members)) {
		required(
			member.base === "omp-default" && typeof member.role === "string" && !member.bot,
			`Member ${name} requires an omp-default base and an inline role`,
		);
		required(
			!member.skills?.length,
			`Member ${name}: explicit skills are unsupported; the frozen omp-default skills remain in force`,
		);
		for (const pattern of member.permissions.read) validateGrantPattern(pattern, `Member ${name} read`);
		for (const pattern of member.permissions.write) validateGrantPattern(pattern, `Member ${name} write`);
		for (const grant of member.permissions.execute) validateExecuteGrant(grant, `Member ${name} execute`);
		required(
			member.duty !== "consult" ||
				(!member.permissions.read.length && !member.permissions.write.length && !member.permissions.execute.length),
			`Member ${name}: a consult member answers text only and should declare no read, write or execute grants`,
		);
	}
	for (const [name, node] of nodes) {
		required(
			node.kind === "bot" && node.member && definition.members[node.member],
			`Node ${name} is not a supported Bot`,
		);
		if (definition.members[node.member!]!.duty === "consult")
			required(
				(node.required_inputs ?? []).length === 1 && !node.terminal && (node.outcomes ?? []).length <= 1,
				`Node ${name}: a consult node answers exactly one required question with one non-terminal outcome`,
			);
		required(
			Object.keys(node).every(key =>
				[
					"kind",
					"task",
					"member",
					"inputs",
					"required_inputs",
					"outputs",
					"outcomes",
					"terminal",
					"retry",
					"join",
				].includes(key),
			),
			`Node ${name} uses unsupported execution fields`,
		);
		required(!node.retry || node.retry.max_attempts === 1, `Node ${name}: retries are unsupported`);
		required(!node.join || node.join === "all", `Node ${name}: non-serial joins are unsupported`);
		for (const [inputName, input] of Object.entries(node.inputs ?? {})) {
			if (typeof input.text === "string") continue;
			required(
				typeof input.run_input === "string",
				`Node ${name} input ${inputName}: local runs accept inline text and run inputs only`,
			);
			required(
				availableInputs === null || availableInputs.has(input.run_input),
				`Node ${name} input ${inputName} requires --input ${input.run_input}=FILE`,
			);
		}
		required(Object.keys(node.outputs ?? {}).length > 0, `Node ${name} must declare a generated text output`);
		required(
			Object.values(node.outputs ?? {}).every(
				output => ["text/plain", "text/markdown"].includes(output.media_type) && !output.schema_ref,
			),
			`Node ${name}: only plain text/Markdown outputs without external schemas are supported`,
		);
	}
	required(edges.length === nodes.length - 1, "Local runs require a single connected serial chain");
	const incoming = new Map<string, number>();
	const outgoing = new Map<string, string>();
	for (const edge of edges) {
		required(
			Object.keys(edge).every(key => ["id", "from", "to", "bind", "on"].includes(key)) && !edge.on?.length,
			"Local runs require unconditional serial edges",
		);
		required(!outgoing.has(edge.from) && !incoming.has(edge.to), "Branches and joins are unsupported");
		outgoing.set(edge.from, edge.to);
		incoming.set(edge.to, 1);
		required(
			Object.keys(edge.bind ?? {}).length > 0,
			`Edge ${edge.id} must bind an upstream output to a downstream input`,
		);
	}
	const roots = nodes.map(([name]) => name).filter(name => !incoming.has(name));
	required(roots.length === 1, "Local runs require one serial entry node");
	const seen = new Set<string>();
	let node: string | undefined = roots[0];
	while (node && !seen.has(node)) {
		seen.add(node);
		node = outgoing.get(node);
	}
	required(!node && seen.size === nodes.length, "Loops and disconnected nodes are unsupported");
	for (const [name, value] of nodes) {
		required(!value.terminal || !outgoing.has(name), `Only the last node may declare terminal behavior: ${name}`);
	}
}

/** Discovery never fails because one Graph needs a capability this runner does not have. */
export function localRunSupport(definition: GraphDefinition): { supported: boolean; reason: string | null } {
	try {
		assertLocalRunSupported(definition, null);
		return { supported: true, reason: null };
	} catch (error) {
		return { supported: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

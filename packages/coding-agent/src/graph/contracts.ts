import type { GraphMemberDuty, GraphNodeKind, GraphRef } from "@oh-my-pi/pi-wire/graph";

export type GraphKey = string;

export type GraphMember = {
	model: string;
	base: "omp-default" | "isolated";
	duty: GraphMemberDuty;
	permissions: { read: string[]; write: string[]; execute: string[] };
	skills?: GraphRef[];
} & ({ bot: GraphRef; role?: never } | { role: `#${string}`; bot?: never });

export type GraphInput =
	| { text: string; artifact?: never; run_input?: never }
	| { artifact: GraphRef; text?: never; run_input?: never }
	| { run_input: GraphKey; text?: never; artifact?: never };
export interface GraphOutput {
	media_type: string;
	required: boolean;
	schema_ref?: GraphRef;
}

export interface GraphNode {
	kind: GraphNodeKind;
	task: `#${string}`;
	member?: GraphKey;
	executor?: string;
	inputs?: Record<GraphKey, GraphInput>;
	required_inputs?: GraphKey[];
	outputs?: Record<GraphKey, GraphOutput>;
	/** Human-only: output to its input artifact and the outcomes that authorize forwarding it. */
	approved_outputs?: Record<GraphKey, { input: GraphKey; on: string[] }>;
	outcomes?: string[];
	join?: "all" | "any";
	retry?: { max_attempts: number };
	timeout_ms?: number;
	writes?: string[];
	consume?: GraphKey[];
	on_budget_exhausted?: GraphKey | "hold";
	verdicts?: string[];
	terminal?: Record<string, "succeed" | "hold" | "fail">;
	required_gate?: boolean;
	decisions?: { verdict: string; outcome: string }[];
	parameters?: Record<GraphKey, string | number | boolean | GraphRef>;
	child_policy?: { kinds: ("bot" | "program" | "queue" | "human")[]; max_nodes: number; max_parallel: number };
}

export interface GraphEdge {
	id: GraphKey;
	from: GraphKey;
	to: GraphKey;
	on?: string[];
	bind?: Record<GraphKey, GraphKey>;
	loop?: GraphKey;
	branch_group?: GraphKey;
	/** Read the named scoped counter without reserving it when this result is routed. */
	when_budget?: { budget: GraphKey; state: "available" | "exhausted" };
}

export interface GraphLoop {
	max_reviews: number;
	final_node: GraphKey;
	retry_target: GraphKey;
	final_outcomes: { go: string; hold: string };
	count_nodes: GraphKey[];
	/** Final-node input name to the triggering counted review's output name. */
	final_bind?: Record<GraphKey, GraphKey>;
	scope: "cycle" | "stage";
	cycle_start?: GraphKey;
	reset_from?: GraphKey[];
	stage?: GraphKey;
}

export interface GraphBudget {
	limit: number;
	scope: "run" | "cycle" | "stage";
	loop?: GraphKey;
	stage?: GraphKey;
}

export interface GraphCommunication {
	from: GraphKey;
	to: GraphKey;
	when: `#${string}`;
	artifacts?: string[];
	max_rounds?: number;
	timeout_ms?: number;
}

export interface GraphDefinition {
	format: "omp.graph/v1";
	name: GraphKey;
	members: Record<GraphKey, GraphMember>;
	nodes: Record<GraphKey, GraphNode>;
	edges?: GraphEdge[];
	communications?: GraphCommunication[];
	loops?: Record<GraphKey, GraphLoop>;
	budgets?: Record<GraphKey, GraphBudget>;
	policy?: {
		max_parallel?: number;
		max_child_nodes?: number;
		max_consultation_rounds?: number;
		consultation_timeout_ms?: number;
		cost_limit?: string;
		currency?: string;
	};
	extensions?: Record<`x-${string}`, unknown>;
}

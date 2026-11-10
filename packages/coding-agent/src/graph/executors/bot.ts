import type { Model, TSchema } from "@oh-my-pi/pi-ai";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { cloneModel } from "@oh-my-pi/pi-catalog/model-snapshot";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	createBotRuntime,
	type BotGraphRuntimeOptions,
	type BotRuntime,
	type BotRuntimeCallbacks,
	type BotRuntimeOptions,
} from "../../bots/agent-runtime";
import type { BotJob } from "../../bots/types";
import type { ModelRegistry } from "../../config/model-registry";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { createGraphCompleteTool, type GraphCompletionRuntime } from "../../tools/graph-complete";
import { createGraphConsultationTools, type GraphConsultationToolContext } from "../../tools/graph-consultation";
import type { GraphMember } from "../contracts";
import botPrompt from "./bot-prompt.md" with { type: "text" };

/** User configuration, not a model capability or price assertion. */
export interface GraphBotModelBinding {
	name: string;
	provider: string;
	model: string;
	revision: string;
}

export class GraphBotAdapterError extends Error {
	constructor(
		readonly code: "base_unavailable" | "model_unavailable" | "policy_unavailable",
		message: string,
	) {
		super(message);
		this.name = "GraphBotAdapterError";
	}
}

export interface GraphBotAssignment {
	member: GraphMember;
	role: string;
	task: string;
	/** Resolved artifact and communication instructions supplied by the Graph host. */
	context?: string;
	bindings: readonly GraphBotModelBinding[];
	modelRegistry: ModelRegistry;
	/** The host has resolved and frozen the requested base and its rules/skills identity. */
	baseAvailable: boolean;
	/** Trusted enforcement, not an instruction to the model. It must enforce the member's permissions. */
	assertToolCall: BotGraphRuntimeOptions["assertToolCall"];
	customTools?: BotGraphRuntimeOptions["customTools"];
	/** Host-bound capabilities for this exact attempt; consultation is optional. */
	tools?: {
		completion: GraphCompletionRuntime;
		consultation?: GraphConsultationToolContext;
		/** A consult member answers only: it gets `graph_reply`/`graph_finish`, never `graph_ask`/`graph_question`. */
		consultRecipient?: boolean;
	};
}

export interface PreparedGraphBot {
	binding: GraphBotModelBinding;
	model: Model;
	graph: BotGraphRuntimeOptions;
	/** Recheck on admission and every dispatch, including restored sessions. */
	assertAvailable(): void;
}

/** Bridge agent tools to the SDK custom-tool interface without exposing session authority to the model. */
function asCustomTool<T extends TSchema>(tool: AgentTool<T>): CustomTool<T> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		approval: tool.approval,
		loadMode: "essential",
		execute: (id, params) => tool.execute(id, params),
	};
}

/** Capabilities must be supplied by the trusted host and bound to the current attempt and fence. */
export function createGraphBotTools(capabilities: NonNullable<GraphBotAssignment["tools"]>): CustomTool[] {
	if (typeof capabilities?.completion?.submit !== "function")
		throw new GraphBotAdapterError("policy_unavailable", "A host-bound Graph completion capability is required");
	const completion = createGraphCompleteTool(capabilities.completion);
	const completionTool = asCustomTool<typeof completion.parameters>(completion);
	// A consultation recipient answers one question and finishes; it never owns a node
	// completion, so the completion tool is withheld from it entirely.
	const tools: CustomTool[] = capabilities.consultRecipient ? [] : [completionTool];
	if (capabilities.consultation) {
		if (
			!capabilities.consultation.store ||
			typeof capabilities.consultation.identity !== "function" ||
			typeof capabilities.consultation.wait !== "function"
		)
			throw new GraphBotAdapterError(
				"policy_unavailable",
				"A host-bound Graph consultation identity and continuation gate are required",
			);
		const { ask, reply, question, finish } = createGraphConsultationTools(capabilities.consultation);
		tools.push(
			...(capabilities.consultRecipient
				? [asCustomTool(reply), asCustomTool(finish)]
				: [asCustomTool(ask), asCustomTool(reply), asCustomTool(question), asCustomTool(finish)]),
		);
	}
	return tools;
}

/** Resolves exact configured identities only; no fuzzy lookup, provider inference or fallback. */
export function prepareGraphBot(assignment: GraphBotAssignment): PreparedGraphBot {
	const { member, modelRegistry } = assignment;
	if (!assignment.baseAvailable || (member.duty === "code-only" && member.base !== "omp-default")) {
		throw new GraphBotAdapterError("base_unavailable", "The requested Graph Bot base is unavailable for this duty");
	}
	if (typeof assignment.assertToolCall !== "function") {
		throw new GraphBotAdapterError("policy_unavailable", "A trusted Graph tool authorization policy is required");
	}
	const bindings = assignment.bindings.filter(binding => binding.name === member.model);
	if (bindings.length !== 1 || !bindings[0].provider || !bindings[0].model || !bindings[0].revision) {
		throw new GraphBotAdapterError(
			"model_unavailable",
			`Graph model binding is missing or ambiguous: ${member.model}`,
		);
	}
	const binding = Object.freeze({ ...bindings[0] });
	const resolve = (): Model => {
		const matches = modelRegistry
			.getAvailableForProviders(new Set([binding.provider]))
			.filter(model => model.provider === binding.provider && model.id === binding.model);
		if (matches.length !== 1 || !modelRegistry.hasConfiguredAuth(matches[0])) {
			throw new GraphBotAdapterError(
				"model_unavailable",
				`Graph model is unavailable: ${binding.provider}/${binding.model}`,
			);
		}
		return matches[0];
	};
	const model = resolve();
	const modelSnapshot = cloneModel(model);
	const graphTools = assignment.tools ? createGraphBotTools(assignment.tools) : [];
	const reserved = ["graph_complete", "graph_ask", "graph_reply", "graph_question", "graph_finish"];
	if (assignment.customTools?.some(tool => reserved.includes(tool.name)))
		throw new GraphBotAdapterError("policy_unavailable", "Graph capability tool names cannot be overridden");
	const appendPrompt = prompt.render(botPrompt, {
		duty: member.duty,
		research: member.duty === "research",
		guide: member.duty === "guide",
		spec: member.duty === "spec",
		review: member.duty === "review",
		codeOnly: member.duty === "code-only",
		testOnly: member.duty === "test-only",
		consult: member.duty === "consult",
		general: member.duty === "general",
		role: assignment.role,
		task: assignment.task,
		context: assignment.context,
	});
	const graph: BotGraphRuntimeOptions = {
		base: member.base,
		model,
		appendPrompt,
		customTools: [...(assignment.customTools ?? []), ...graphTools],
		requiredToolNames: graphTools.map(tool => tool.name),
		assertToolCall: assignment.assertToolCall,
	};
	return {
		binding,
		model,
		graph,
		assertAvailable: () => {
			if (graph.model !== model || model.provider !== binding.provider || model.id !== binding.model) {
				throw new GraphBotAdapterError("model_unavailable", "The prepared Graph model identity changed");
			}
			if (!Bun.deepEquals(model, modelSnapshot) || !Bun.deepEquals(resolve(), modelSnapshot)) {
				throw new GraphBotAdapterError("model_unavailable", "The prepared Graph model configuration changed");
			}
		},
	};
}

/** Uses the existing Bot lifecycle and fencing callbacks; the host owns durable dispatch admission. */
export async function createGraphBotRuntime(
	job: BotJob,
	callbacks: BotRuntimeCallbacks,
	assignment: GraphBotAssignment,
	options: Omit<BotRuntimeOptions, "graph" | "model" | "modelRegistry"> = {},
): Promise<{ runtime: BotRuntime; binding: GraphBotModelBinding }> {
	const prepared = prepareGraphBot(assignment);
	if (typeof callbacks.assertDispatch !== "function")
		throw new GraphBotAdapterError("policy_unavailable", "A trusted Graph dispatch fence is required");
	if (!assignment.tools)
		throw new GraphBotAdapterError("policy_unavailable", "A host-bound Graph completion capability is required");
	const runtime = await createBotRuntime(
		job,
		{
			...callbacks,
			assertDispatch: () => {
				prepared.assertAvailable();
				callbacks.assertDispatch?.();
			},
		},
		{ ...options, modelRegistry: assignment.modelRegistry, graph: prepared.graph },
	);
	return { runtime, binding: prepared.binding };
}

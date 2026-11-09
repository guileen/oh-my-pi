import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { GraphError } from "../graph/authoring";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import description from "../prompts/tools/graph-complete.md" with { type: "text" };

const completeSchema = type({
	"request_key?": "string",
	outcome: "string",
	outputs: { "[string]": { id: "string", digest: "string" } },
	"verdict?": "string",
});

export type GraphCompleteParams = typeof completeSchema.infer;
export interface GraphCompletionCandidate {
	request_key: string;
	outcome: string;
	outputs: Record<string, GraphRef>;
	verdict?: string;
}
export interface GraphCompletionReceipt {
	request_key: string;
	state: "accepted" | "rejected" | "unknown";
	error: GraphError | null;
}

/**
 * A capability bound by the trusted host to one authenticated Bot attempt. The
 * implementation must validate the frozen node's outcome, verdict and output
 * declarations, verify artifact identity, access, availability and provenance,
 * and atomically check the current fence and persist the result and request
 * receipt. Replaying a key with the same candidate returns its original receipt;
 * reusing it for a different candidate must be rejected. No identity comes from
 * the model. An accepted receipt is not a Run completion.
 */
export interface GraphCompletionRuntime {
	submit(candidate: GraphCompletionCandidate): Promise<GraphCompletionReceipt>;
}

function failure(requestKey: string, code: string, message: string): GraphCompletionReceipt {
	return {
		request_key: requestKey,
		state: "rejected",
		error: { code, message, location: null, retryable: false, details: null },
	};
}

function candidateFrom(value: unknown): GraphCompletionCandidate | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some(key => !["request_key", "outcome", "outputs", "verdict"].includes(key))) return null;
	if (
		(input.request_key !== undefined && typeof input.request_key !== "string") ||
		typeof input.outcome !== "string" ||
		!input.outcome.trim() ||
		(input.verdict !== undefined && (typeof input.verdict !== "string" || !input.verdict.trim())) ||
		!input.outputs ||
		typeof input.outputs !== "object" ||
		Array.isArray(input.outputs)
	)
		return null;
	const outputs: Record<string, GraphRef> = Object.create(null);
	for (const [name, raw] of Object.entries(input.outputs)) {
		if (!name || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const ref = raw as Record<string, unknown>;
		if (
			Object.keys(ref).length !== 2 ||
			typeof ref.id !== "string" ||
			!ref.id.trim() ||
			typeof ref.digest !== "string" ||
			!ref.digest.trim()
		)
			return null;
		outputs[name] = { id: ref.id, digest: ref.digest };
	}
	return {
		request_key: typeof input.request_key === "string" ? input.request_key : "",
		outcome: input.outcome,
		outputs,
		...(input.verdict === undefined ? {} : { verdict: input.verdict as string }),
	};
}

/** Construct only with a host-bound capability; absent capability fails closed. */
export class GraphCompleteTool implements AgentTool<typeof completeSchema> {
	readonly name = "graph_complete";
	readonly label = "Graph Complete";
	readonly description = description;
	readonly parameters = completeSchema;
	readonly approval = "write" as const;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Submit a candidate Graph Bot result";

	constructor(private readonly runtime?: GraphCompletionRuntime) {}

	async execute(_id: string, request: GraphCompleteParams): Promise<AgentToolResult> {
		const candidate = candidateFrom(request);
		const key = typeof request?.request_key === "string" ? request.request_key : "";
		let receipt: GraphCompletionReceipt;
		if (!this.runtime) receipt = failure(key, "permission_denied", "Authenticated Graph runtime is unavailable");
		else if (!candidate) receipt = failure(key, "invalid_request", "Invalid completion candidate");
		else {
			try {
				receipt = await this.runtime.submit(candidate);
			} catch {
				receipt = {
					request_key: key,
					state: "unknown",
					error: {
						code: "unknown",
						message: "Completion could not be reconciled; retain the request key",
						location: null,
						retryable: true,
						details: null,
					},
				};
			}
		}
		return {
			content: [
				{
					type: "text",
					text: receipt.error
						? `Completion ${receipt.state}: ${receipt.error.code}: ${receipt.error.message}`
						: `Completion ${receipt.state}. This does not mean the Run is complete.`,
				},
			],
			details: receipt,
			isError: receipt.state !== "accepted",
		};
	}
}

export function createGraphCompleteTool(runtime: GraphCompletionRuntime): GraphCompleteTool {
	return new GraphCompleteTool(runtime);
}

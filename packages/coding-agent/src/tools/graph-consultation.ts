import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
	ConsultationIdentity,
	ConsultationMessage,
	ConsultationResult,
	GraphConsultationStore,
} from "../graph/consultation";
import askDescription from "../prompts/tools/graph-ask.md" with { type: "text" };
import finishDescription from "../prompts/tools/graph-finish.md" with { type: "text" };
import questionDescription from "../prompts/tools/graph-question.md" with { type: "text" };
import replyDescription from "../prompts/tools/graph-reply.md" with { type: "text" };

const refs = { "artifact_refs?": type({ id: "string", digest: "string" }).array() };
const askSchema = type({ to_member: "string", text: "string", request_key: "string", ...refs });
const messageSchema = type({
	conversation_id: "string",
	reply_to: "string",
	text: "string",
	request_key: "string",
	...refs,
});
const finishSchema = type({ conversation_id: "string", text: "string", request_key: "string", ...refs });

/** Only a trusted invocation host may construct these tools and supply its current identity. */
export interface GraphConsultationToolContext {
	store: GraphConsultationStore;
	identity: () => ConsultationIdentity | null | undefined;
	/** Suspend the live tool stack and resume only after host-admitted delivery. */
	wait?: (
		identity: ConsultationIdentity,
		conversationId: string,
		messageId: string,
	) => Promise<ConsultationResult<ConsultationMessage>>;
}

function result<T>(value: ConsultationResult<T>): AgentToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		details: value,
		isError: !value.ok,
	};
}

/** Persistence precedes the optional host-owned continuation gate. */
export function createGraphConsultationTools(context: GraphConsultationToolContext) {
	async function invoke<T extends object>(
		action: (identity: ConsultationIdentity) => ConsultationResult<T>,
		waitRef?: (value: T) => { conversationId: string; messageId: string },
	): Promise<AgentToolResult> {
		try {
			const identity = context.identity();
			if (!identity) return result({ ok: false, error: "permission_denied" });
			const saved = action(identity);
			if (!saved.ok || !waitRef || !context.wait) return result(saved);
			const ref = waitRef(saved.value);
			const delivery = await context.wait(identity, ref.conversationId, ref.messageId);
			if (!delivery.ok) return result(delivery);
			return result({ ok: true, value: { ...saved.value, delivery: delivery.value } });
		} catch {
			return {
				content: [{ type: "text", text: "Graph consultation service failed" }],
				details: { ok: false, error: "internal_error" },
				isError: true,
			};
		}
	}

	const ask: AgentTool<typeof askSchema> = {
		name: "graph_ask",
		label: "Graph Ask",
		approval: "write",
		description: askDescription,
		parameters: askSchema,
		async execute(_id, input) {
			return invoke(
				identity =>
					context.store.ask(identity, {
						to_member: input.to_member,
						text: input.text,
						request_key: input.request_key,
						artifact_refs: input.artifact_refs,
					}),
				value => ({ conversationId: value.conversation_id, messageId: value.message_id }),
			);
		},
	};
	const reply: AgentTool<typeof messageSchema> = {
		name: "graph_reply",
		label: "Graph Reply",
		approval: "write",
		description: replyDescription,
		parameters: messageSchema,
		async execute(_id, input) {
			return invoke(
				identity =>
					context.store.reply(identity, {
						conversation_id: input.conversation_id,
						reply_to: input.reply_to,
						text: input.text,
						request_key: input.request_key,
						artifact_refs: input.artifact_refs,
					}),
				value => ({ conversationId: input.conversation_id, messageId: value.message_id }),
			);
		},
	};
	const question: AgentTool<typeof messageSchema> = {
		name: "graph_question",
		label: "Graph Question",
		approval: "write",
		description: questionDescription,
		parameters: messageSchema,
		async execute(_id, input) {
			return invoke(
				identity =>
					context.store.question(identity, {
						conversation_id: input.conversation_id,
						reply_to: input.reply_to,
						text: input.text,
						request_key: input.request_key,
						artifact_refs: input.artifact_refs,
					}),
				value => ({ conversationId: input.conversation_id, messageId: value.message_id }),
			);
		},
	};
	const finish: AgentTool<typeof finishSchema> = {
		name: "graph_finish",
		label: "Graph Finish",
		approval: "write",
		description: finishDescription,
		parameters: finishSchema,
		async execute(_id, input) {
			return invoke(identity =>
				context.store.finish(identity, {
					conversation_id: input.conversation_id,
					text: input.text,
					request_key: input.request_key,
					artifact_refs: input.artifact_refs,
				}),
			);
		},
	};
	return { ask, reply, question, finish };
}

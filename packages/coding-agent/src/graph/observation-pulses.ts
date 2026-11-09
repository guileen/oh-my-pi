import type { Database } from "bun:sqlite";
import type { ConsultationMessage } from "./consultation";
import type { GraphDefinition } from "./contracts";
import type { GraphBotHandoffRecord } from "./handoff";
import type { GraphRecordedView } from "./observation-record";
import { hasColumns, hasTable } from "./schema";

/**
 * Activity pulse for edge animation. Pulses are a bounded overlay over the Run's
 * recorded handoffs and consultation messages, never a per-frame historical fact.
 */
export interface GraphObservationTransfer {
	edge_id: string;
	from: string;
	to: string;
	state: "delivered" | "unknown";
	occurred_at: string;
}

/** Consultation activity pulse; carries no message text and no conversation identity. */
export interface GraphObservationMessage {
	from: string;
	to: string;
	kind: ConsultationMessage["kind"];
	/** Stable per-Run append order, usable to de-duplicate repeated reads. */
	ordinal: number;
}

/** Animation needs a bounded tail, not a full transcript. */
export const MAX_PULSES = 200;
const PULSE_KINDS = new Set<ConsultationMessage["kind"]>(["request", "question", "reply", "final"]);

/**
 * Pulses describe recorded activity for animation. They are bounded, filtered to
 * attempts still live in this frame, and never throw on an entry the frozen
 * definition cannot place: omission is honest, invention is not.
 */
export function projectGraphPulses(
	db: Database,
	runId: string,
	definition: GraphDefinition,
	recorded: Pick<GraphRecordedView, "invocations" | "run">,
): { transfers: GraphObservationTransfer[]; messages: GraphObservationMessage[] } {
	const live = new Map<string, string>();
	for (const item of recorded.invocations) {
		if (!item.attempt_id || item.superseded) continue;
		live.set(item.attempt_id, item.node);
	}
	const edges = new Map((definition.edges ?? []).map(edge => [edge.id, edge]));
	const transfers: GraphObservationTransfer[] = [];
	if (hasTable(db, "graph_bot_handoffs") && hasColumns(db, "graph_bot_handoffs", ["run_id", "data"])) {
		const rows = db.query("SELECT data FROM graph_bot_handoffs WHERE run_id=? ORDER BY rowid").all(runId) as {
			data: string;
		}[];
		for (const row of rows) {
			let handoff: GraphBotHandoffRecord;
			try {
				handoff = JSON.parse(row.data) as GraphBotHandoffRecord;
			} catch {
				continue;
			}
			if (!handoff || handoff.run_id !== runId) continue;
			const targetNode = live.get(handoff.attempt_id);
			if (!targetNode) continue;
			for (const mapped of handoff.handoffs ?? []) {
				const edge = edges.get(mapped.edge_id);
				if (!edge || edge.from !== live.get(mapped.from_binding_id) || edge.to !== targetNode) continue;
				transfers.push({
					edge_id: edge.id,
					from: edge.from,
					to: edge.to,
					state: handoff.receipt ? "delivered" : "unknown",
					occurred_at: handoff.occurred_at ?? recorded.run.created_at,
				});
			}
		}
	}
	const seen = new Set<string>();
	const unique = transfers.filter(item => {
		const key = [item.edge_id, item.from, item.to, item.state, item.occurred_at].join("\u0000");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const messages: GraphObservationMessage[] = [];
	if (
		hasTable(db, "consultations") &&
		hasTable(db, "consultation_messages") &&
		hasColumns(db, "consultations", ["id", "run_id"]) &&
		hasColumns(db, "consultation_messages", ["conversation_id", "data", "seq"])
	) {
		const rows = db
			.query(
				`SELECT m.data AS data FROM consultations c JOIN consultation_messages m ON m.conversation_id=c.id
				 WHERE c.run_id=? ORDER BY c.rowid, m.seq`,
			)
			.all(runId) as { data: string }[];
		let ordinal = 0;
		for (const row of rows) {
			const index = ordinal++;
			let message: ConsultationMessage;
			try {
				message = JSON.parse(row.data) as ConsultationMessage;
			} catch {
				continue;
			}
			if (!message || !live.has(message.sender_attempt_id)) continue;
			if (
				!Object.hasOwn(definition.members, message.sender_member) ||
				!Object.hasOwn(definition.members, message.recipient_member)
			)
				continue;
			if (!PULSE_KINDS.has(message.kind)) continue;
			messages.push({
				from: message.sender_member,
				to: message.recipient_member,
				kind: message.kind,
				ordinal: index,
			});
		}
	}
	return { transfers: unique.slice(-MAX_PULSES), messages: messages.slice(-MAX_PULSES) };
}

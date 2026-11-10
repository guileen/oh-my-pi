import type { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import { GraphWireError, type GraphRef } from "@oh-my-pi/pi-wire/graph";
import { graphWireRecordKey, validateGraphWireRecord } from "@oh-my-pi/pi-wire/graph/wire-records";

export interface GraphWireConsultationDetail {
	availability: "available" | "missing" | "unknown";
	media_type: string | null;
	content: string | null;
}

const unavailable = (availability: "missing" | "unknown"): GraphWireConsultationDetail => ({
	availability,
	media_type: null,
	content: null,
});
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const ref = (value: unknown): value is GraphRef => object(value) && id(value.id) && id(value.digest);

/** Trusted embedding-only reader, not principal authentication. The bridge must authorize both
 * before and after this read against its current generation. Never installs or mutates schema. */
export class GraphWireConsultationDetailReader {
	constructor(private readonly db: Database) {}

	read(sourceId: string, runId: string, contentRef: string): GraphWireConsultationDetail {
		if (!id(sourceId) || !id(runId) || !id(contentRef))
			throw new GraphWireError("invalid_input", "Protected Graph content requires complete identities");
		try {
			return this.db.transaction(() => this.#read(sourceId, runId, contentRef))();
		} catch (error) {
			if (error instanceof GraphWireError && error.code === "scope_denied") throw error;
			// Malformed or unavailable storage must never escape as raw database data or paths.
			return unavailable("unknown");
		}
	}

	#read(sourceId: string, runId: string, contentRef: string): GraphWireConsultationDetail {
		const runKey = canonicalJson(["run", runId]);
		const runRow = this.db
			.query(`SELECT c.data,s.journal_id,s.seq FROM graph_wire_current c
				JOIN graph_wire_sources s ON s.source_id=c.source_id
				WHERE c.source_id=? AND c.run_id=? AND c.kind='run' AND c.record_key=?`)
			.get(sourceId, runId, runKey) as { data: string; journal_id: string; seq: string } | null;
		if (!runRow) throw new GraphWireError("scope_denied", "Protected Graph content is outside the requested scope");
		const run: unknown = JSON.parse(runRow.data);
		validateGraphWireRecord(run);
		if (
			run.kind !== "run" ||
			run.value.graph_run_id !== runId ||
			graphWireRecordKey(run) !== runKey ||
			!id(runRow.journal_id) ||
			typeof runRow.seq !== "string" ||
			!/^(0|[1-9][0-9]*)$/.test(runRow.seq)
		)
			return unavailable("unknown");

		// Recognize only the exact reference family the consultation producer persists. This is
		// not an artifact, snapshot, model-binding, credential or filesystem detail reader.
		const prefix = "consultation-message:";
		if (!contentRef.startsWith(prefix) || contentRef.length === prefix.length) return unavailable("unknown");
		const messageId = contentRef.slice(prefix.length);
		const records = this.db
			.query(`SELECT record_key,data FROM graph_wire_current
				WHERE source_id=? AND run_id=? AND kind='execution_conversation'
				AND (json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.value.content_ref')=?
					OR EXISTS (SELECT 1 FROM json_each(
						CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.value.message_refs') WHERE value=?))
				LIMIT 2`)
			.all(sourceId, runId, contentRef, contentRef) as { record_key: string; data: string }[];
		// Identical denials for an absent ref and a ref published only by another Run/source.
		if (records.length === 0)
			throw new GraphWireError("scope_denied", "Protected Graph content is outside the requested scope");
		if (records.length !== 1) return unavailable("unknown");
		const row = records[0]!;
		const record: unknown = JSON.parse(row.data);
		validateGraphWireRecord(record);
		if (
			record.kind !== "execution_conversation" ||
			record.value.graph_run_id !== runId ||
			graphWireRecordKey(record) !== row.record_key ||
			(record.value.content_ref !== contentRef && !record.value.message_refs.includes(contentRef))
		)
			return unavailable("unknown");
		const conversation = record.value;
		const conversationRow = this.db
			.query("SELECT run_id,data FROM consultations WHERE id=?")
			.get(conversation.conversation_id) as { run_id: string; data: string } | null;
		if (!conversationRow) return unavailable("missing");
		const stored: unknown = JSON.parse(conversationRow.data);
		if (
			conversationRow.run_id !== runId ||
			!object(stored) ||
			stored.id !== conversation.conversation_id ||
			stored.run_id !== runId ||
			stored.requester !== conversation.requester_member ||
			stored.responder !== conversation.responder_member ||
			stored.requester === stored.responder ||
			!id(stored.requester_invocation_id) ||
			!id(stored.requester_attempt_id)
		)
			return unavailable("unknown");
		const messageRow = this.db
			.query("SELECT data FROM consultation_messages WHERE conversation_id=? AND message_id=?")
			.get(conversation.conversation_id, messageId) as { data: string } | null;
		if (!messageRow) return unavailable("missing");
		const message: unknown = JSON.parse(messageRow.data);
		if (
			!object(message) ||
			message.conversation_id !== conversation.conversation_id ||
			message.message_id !== messageId ||
			!ref(message.content_ref) ||
			message.content_ref.id !== contentRef ||
			typeof message.text !== "string" ||
			!id(message.sender_attempt_id) ||
			!(message.in_reply_to === null || id(message.in_reply_to)) ||
			!Array.isArray(message.artifact_refs) ||
			!message.artifact_refs.every(ref) ||
			!(
				(message.sender_member === stored.requester && message.recipient_member === stored.responder) ||
				(message.sender_member === stored.responder && message.recipient_member === stored.requester)
			) ||
			!(
				(message.kind === "request" && message.sender_member === stored.requester) ||
				message.kind === "reply" ||
				((message.kind === "question" || message.kind === "final") && message.sender_member === stored.responder)
			)
		)
			return unavailable("unknown");
		if (message.content_ref.digest !== `sha256:${Bun.SHA256.hash(message.text, "hex")}`)
			return unavailable("unknown");
		return { availability: "available", media_type: "text/markdown", content: message.text };
	}
}

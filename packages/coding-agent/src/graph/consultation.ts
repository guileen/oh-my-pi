import { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { ConsultationState, GraphRef } from "@oh-my-pi/pi-wire/graph";

/** A single consultation message is one bounded utterance, not a transcript dump. */
export const CONSULTATION_MESSAGE_BYTES = 64 * 1024;

/** Supplied by the host, never by a model tool's arguments. */
export interface ConsultationIdentity {
	run_id: string;
	member_id: string;
	invocation_id: string;
	attempt_id: string;
	fence: string;
}

export interface ConsultationPolicy {
	max_rounds: number;
	timeout_ms: number;
}

/** Callbacks execute synchronously in the store's write transaction and must use only this database
 * for mutable authorization, fencing and reservation state. */
export interface ConsultationAuthority {
	/** Verify run membership, invocation/attempt ownership and the current fence on every call. */
	validate(db: Database, identity: ConsultationIdentity): boolean;
	/** Resolve the directed communication grant and applicable run limits, or deny. */
	policy(db: Database, identity: ConsultationIdentity, recipient: string, refs: GraphRef[]): ConsultationPolicy | null;
	/** Check the sender's current access and the conversation grant for every artifact. */
	artifacts(db: Database, identity: ConsultationIdentity, conversation: Consultation, refs: GraphRef[]): boolean;
	/** Atomically reserve the complete consultation's run resources, or reject admission. */
	reserve?(db: Database, identity: ConsultationIdentity, requestKey: string, policy: ConsultationPolicy): boolean;
	/** Bind a recipient execution to this conversation. Missing policy always denies delivery. */
	delivery?(
		db: Database,
		identity: ConsultationIdentity,
		conversation: Consultation,
		message: ConsultationMessage,
	): boolean;
	/** Authorize this exact attempt as a participant, including the responder execution binding. */
	participant?(db: Database, identity: ConsultationIdentity, conversation: Consultation): boolean;
}

export interface Consultation {
	id: string;
	run_id: string;
	requester: string;
	responder: string;
	requester_invocation_id: string;
	requester_attempt_id: string;
	input_refs: GraphRef[];
	remaining_rounds: number;
	deadline: number;
	state: ConsultationState;
	terminal_reason: "deadline" | "rounds" | "cancelled" | null;
	waiting_refs: string[];
	wait_reason: string | null;
}
export interface ConsultationMessage {
	conversation_id: string;
	message_id: string;
	in_reply_to: string | null;
	kind: "request" | "question" | "reply" | "final";
	sender_member: string;
	recipient_member: string;
	content_ref: GraphRef;
	text: string;
	artifact_refs: GraphRef[];
	sender_attempt_id: string;
}
export interface ConsultationDelivery {
	message: ConsultationMessage;
	identity: ConsultationIdentity;
	state: "reserved" | "delivered" | "unknown";
}
export type ConsultationError =
	| "permission_denied"
	| "wait_cycle"
	| "consultation_timeout"
	| "idempotency_conflict"
	| "invalid_request"
	| "not_found"
	| "closed"
	| "budget_exhausted";
export type ConsultationResult<T> = { ok: true; value: T } | { ok: false; error: ConsultationError };
type AskValue = { conversation_id: string; message_id: string; state: "queued" | "waiting"; wait_ref: string };
type MessageValue = { message_id: string; state: "accepted" | "closed" | "answered" };
type MessageInput = { conversation_id: string; text: string; request_key: string; artifact_refs?: GraphRef[] };

/** Consultation tables share the host's profile database and its transaction boundary. */
export class GraphConsultationStore {
	readonly #db: Database;
	readonly #authority: ConsultationAuthority;
	readonly #now: () => number;
	readonly #onChange?: (runId: string) => void;

	/**
	 * Runs synchronously in the write transaction after each coherent conversation/message change.
	 * Sweeps can notify once per expired conversation; receipts and delivery-only writes do not notify.
	 * Throwing aborts the transaction, including messages, reservations, receipts and observer writes.
	 */
	constructor(
		db: Database,
		authority: ConsultationAuthority,
		now: () => number = Date.now,
		onChange?: (runId: string) => void,
	) {
		this.#authority = authority;
		this.#now = now;
		this.#db = db;
		this.#onChange = onChange;
		this.#db.exec(`
CREATE TABLE IF NOT EXISTS consultations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, deadline INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS consultations_run_state ON consultations(run_id,state);
CREATE TABLE IF NOT EXISTS consultation_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS consultation_messages_conversation ON consultation_messages(conversation_id,seq);
CREATE TABLE IF NOT EXISTS consultation_requests (run_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(run_id,request_key));
CREATE TABLE IF NOT EXISTS consultation_deliveries (message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);`);
	}

	/** Host-only inspection; tool adapters must check identity before exposing these records. */
	get(id: string): Consultation | null {
		const row = this.#db.query("SELECT data FROM consultations WHERE id=?").get(id) as { data: string } | null;
		return row ? (JSON.parse(row.data) as Consultation) : null;
	}
	messages(id: string): ConsultationMessage[] {
		return (
			this.#db.query("SELECT data FROM consultation_messages WHERE conversation_id=? ORDER BY seq").all(id) as {
				data: string;
			}[]
		).map(row => JSON.parse(row.data) as ConsultationMessage);
	}
	list(runId: string): Consultation[] {
		return (
			this.#db.query("SELECT data FROM consultations WHERE run_id=? ORDER BY rowid").all(runId) as { data: string }[]
		).map(row => JSON.parse(row.data) as Consultation);
	}

	/** Host recovery and cancellation sweep must include runs with no live Bot. */
	activeRunIds(): string[] {
		return (
			this.#db.query("SELECT DISTINCT run_id FROM consultations WHERE state IN ('queued','active')").all() as {
				run_id: string;
			}[]
		).map(row => row.run_id);
	}

	/** Unreserved messages in durable order. Reservations are never replayed after uncertainty. */
	pendingDeliveries(runId: string): ConsultationMessage[] {
		return (
			this.#db
				.query(`SELECT m.data FROM consultation_messages m
			JOIN consultations c ON c.id=m.conversation_id
			LEFT JOIN consultation_deliveries d ON d.message_id=m.message_id
			WHERE c.run_id=? AND d.message_id IS NULL AND c.state IN ('queued','active','answered')
			AND NOT EXISTS (SELECT 1 FROM consultation_messages newer
				WHERE newer.conversation_id=m.conversation_id AND newer.seq>m.seq)
			ORDER BY m.seq`)
				.all(runId) as { data: string }[]
		).map(row => JSON.parse(row.data) as ConsultationMessage);
	}

	/** Reserve before crossing the runtime boundary. A reservation is not proof of delivery. */
	reserveDelivery(
		identity: ConsultationIdentity,
		messageId: string,
	): ConsultationResult<{ delivery: ConsultationDelivery; claimed: boolean }> {
		return this.#db
			.transaction((): ConsultationResult<{ delivery: ConsultationDelivery; claimed: boolean }> => {
				if (!this.#validIdentity(identity)) return { ok: false, error: "permission_denied" };
				const row = this.#db.query("SELECT data FROM consultation_messages WHERE message_id=?").get(messageId) as {
					data: string;
				} | null;
				if (!row) return { ok: false, error: "not_found" };
				const message = JSON.parse(row.data) as ConsultationMessage;
				const c = this.get(message.conversation_id);
				if (!c || c.run_id !== identity.run_id) return { ok: false, error: "not_found" };
				this.#timeout(c);
				if (c.state === "timed_out") return { ok: false, error: "consultation_timeout" };
				if (c.state === "cancelled") return { ok: false, error: "closed" };
				if (
					identity.member_id !== message.recipient_member ||
					(identity.member_id === c.requester &&
						(identity.invocation_id !== c.requester_invocation_id ||
							identity.attempt_id !== c.requester_attempt_id)) ||
					this.#authority.delivery?.(this.#db, identity, c, message) !== true ||
					this.#authority.artifacts(this.#db, identity, c, message.artifact_refs) !== true
				)
					return { ok: false, error: "permission_denied" };
				const latest = this.#db
					.query("SELECT message_id FROM consultation_messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1")
					.get(c.id) as { message_id: string } | null;
				if (latest?.message_id !== messageId) return { ok: false, error: "closed" };
				const old = this.#db
					.query("SELECT data FROM consultation_deliveries WHERE message_id=?")
					.get(messageId) as { data: string } | null;
				if (old) {
					const delivery = JSON.parse(old.data) as ConsultationDelivery;
					return canonicalJson(delivery.identity) === canonicalJson(identity)
						? { ok: true, value: { delivery, claimed: false } }
						: { ok: false, error: "permission_denied" };
				}
				const delivery: ConsultationDelivery = { message, identity, state: "reserved" };
				this.#db
					.query("INSERT INTO consultation_deliveries VALUES (?,?,?,?)")
					.run(messageId, identity.run_id, delivery.state, JSON.stringify(delivery));
				return { ok: true, value: { delivery, claimed: true } };
			})
			.immediate();
	}

	/** Only the original reservation may be settled. Unknown is terminal and cannot be retried. */
	settleDelivery(identity: ConsultationIdentity, messageId: string, state: "delivered" | "unknown"): boolean {
		return this.#db
			.transaction(() => {
				if (!this.#validIdentity(identity)) return false;
				const row = this.#db
					.query("SELECT data FROM consultation_deliveries WHERE message_id=?")
					.get(messageId) as { data: string } | null;
				if (!row) return false;
				const delivery = JSON.parse(row.data) as ConsultationDelivery;
				if (canonicalJson(delivery.identity) !== canonicalJson(identity) || delivery.state !== "reserved")
					return false;
				delivery.state = state;
				this.#db
					.query("UPDATE consultation_deliveries SET state=?,data=? WHERE message_id=?")
					.run(state, JSON.stringify(delivery), messageId);
				return true;
			})
			.immediate();
	}

	/** Recovery must fence every unconfirmed side effect instead of replaying it. */
	recoverDeliveries(runId: string): ConsultationDelivery[] {
		return this.#db
			.transaction(() => {
				const rows = this.#db
					.query("SELECT data FROM consultation_deliveries WHERE run_id=? AND state='reserved'")
					.all(runId) as { data: string }[];
				return rows.map(row => {
					const delivery = JSON.parse(row.data) as ConsultationDelivery;
					delivery.state = "unknown";
					this.#db
						.query("UPDATE consultation_deliveries SET state='unknown',data=? WHERE message_id=?")
						.run(JSON.stringify(delivery), delivery.message.message_id);
					return delivery;
				});
			})
			.immediate();
	}

	ask(
		identity: ConsultationIdentity,
		input: { to_member: string; text: string; request_key: string; artifact_refs?: GraphRef[] },
	): ConsultationResult<AskValue> {
		const refs = input.artifact_refs ?? [];
		return this.#perform(identity, "ask", input.request_key, { ...input, artifact_refs: refs }, () => {
			if (
				!this.#validText(input.text) ||
				!input.to_member ||
				input.to_member === identity.member_id ||
				!this.#validRefs(refs)
			)
				return { ok: false, error: "invalid_request" };
			const policy = this.#authority.policy(this.#db, identity, input.to_member, refs);
			if (!policy) return { ok: false, error: "permission_denied" };
			if (
				!Number.isSafeInteger(policy.max_rounds) ||
				policy.max_rounds < 0 ||
				!Number.isSafeInteger(policy.timeout_ms) ||
				policy.timeout_ms <= 0 ||
				!Number.isSafeInteger(this.#now() + policy.timeout_ms)
			)
				return { ok: false, error: "invalid_request" };
			this.#expire(identity.run_id);
			if (this.#wouldCycle(identity.run_id, identity.member_id, input.to_member))
				return { ok: false, error: "wait_cycle" };
			this.#db.exec("SAVEPOINT consultation_reservation");
			if (this.#authority.reserve?.(this.#db, identity, input.request_key, policy) !== true) {
				this.#db.exec("ROLLBACK TO consultation_reservation; RELEASE consultation_reservation");
				return { ok: false, error: "budget_exhausted" };
			}
			this.#db.exec("RELEASE consultation_reservation");
			const id = crypto.randomUUID();
			const conversation: Consultation = {
				id,
				run_id: identity.run_id,
				requester: identity.member_id,
				responder: input.to_member,
				requester_invocation_id: identity.invocation_id,
				requester_attempt_id: identity.attempt_id,
				input_refs: refs,
				remaining_rounds: policy.max_rounds,
				deadline: this.#now() + policy.timeout_ms,
				state: "queued",
				terminal_reason: null,
				waiting_refs: [id],
				wait_reason: "recipient_queued",
			};
			this.#save(conversation);
			const message = this.#message(conversation, identity, "request", null, input.text, refs);
			this.#onChange?.(conversation.run_id);
			return {
				ok: true,
				value: { conversation_id: id, message_id: message.message_id, state: "queued", wait_ref: id },
			};
		});
	}

	question(
		identity: ConsultationIdentity,
		input: MessageInput & { reply_to: string },
	): ConsultationResult<MessageValue> {
		return this.#respond(identity, "question", input);
	}
	reply(identity: ConsultationIdentity, input: MessageInput & { reply_to: string }): ConsultationResult<MessageValue> {
		return this.#respond(identity, "reply", input);
	}
	finish(identity: ConsultationIdentity, input: MessageInput): ConsultationResult<MessageValue> {
		return this.#respond(identity, "final", input);
	}

	/** Host marks a queued recipient as admitted; this does not allocate a compute slot. */
	activate(id: string): Consultation | null {
		return this.#db
			.transaction(() => {
				const c = this.get(id);
				if (!c) return null;
				this.#timeout(c);
				if (c.state === "queued") {
					c.state = "active";
					c.wait_reason = null;
					this.#save(c);
					this.#onChange?.(c.run_id);
				}
				return c;
			})
			.immediate();
	}
	/** Deadline sweep is explicit so a restarted host can terminalize idle conversations. */
	expire(runId: string): Consultation[] {
		return this.#db.transaction(() => this.#expire(runId)).immediate();
	}
	cancel(id: string): Consultation | null {
		return this.#db
			.transaction(() => {
				const c = this.get(id);
				if (!c) return null;
				this.#timeout(c);
				if (c.state === "queued" || c.state === "active") {
					c.state = "cancelled";
					c.terminal_reason = "cancelled";
					c.waiting_refs = [];
					c.wait_reason = null;
					this.#save(c);
					this.#onChange?.(c.run_id);
				}
				return c;
			})
			.immediate();
	}

	#respond(
		identity: ConsultationIdentity,
		kind: "question" | "reply" | "final",
		input: MessageInput & { reply_to?: string },
	): ConsultationResult<MessageValue> {
		const refs = input.artifact_refs ?? [];
		return this.#perform(identity, kind, input.request_key, { ...input, artifact_refs: refs }, () => {
			if (!this.#validText(input.text) || !this.#validRefs(refs)) return { ok: false, error: "invalid_request" };
			const c = this.get(input.conversation_id);
			if (!c || c.run_id !== identity.run_id) return { ok: false, error: "not_found" };
			if (
				(kind === "reply"
					? identity.member_id !== c.requester && identity.member_id !== c.responder
					: identity.member_id !== c.responder) ||
				(identity.member_id === c.requester &&
					(identity.invocation_id !== c.requester_invocation_id ||
						identity.attempt_id !== c.requester_attempt_id)) ||
				this.#authority.participant?.(this.#db, identity, c) !== true ||
				this.#authority.artifacts(this.#db, identity, c, refs) !== true
			)
				return { ok: false, error: "permission_denied" };
			this.#timeout(c);
			if (c.state === "timed_out") return { ok: false, error: "consultation_timeout" };
			if (c.state === "answered" || c.state === "cancelled") return { ok: false, error: "closed" };
			const messages = this.messages(c.id);
			const last = messages[messages.length - 1];
			if (
				!last ||
				(kind !== "final" && (input.reply_to !== last.message_id || last.sender_member === identity.member_id)) ||
				(kind === "question" && last.kind !== "request" && last.kind !== "reply") ||
				(kind === "final" && last.kind === "question")
			)
				return { ok: false, error: "invalid_request" };
			if (kind === "question" && c.remaining_rounds === 0) {
				c.state = "timed_out";
				c.terminal_reason = "rounds";
				c.waiting_refs = [];
				c.wait_reason = null;
				this.#save(c);
				this.#onChange?.(c.run_id);
				return { ok: false, error: "consultation_timeout" };
			}
			if (kind === "question") c.remaining_rounds--;
			if (kind === "final") {
				c.state = "answered";
				c.waiting_refs = [];
				c.wait_reason = null;
			} else {
				c.state = "active";
				c.wait_reason = identity.member_id === c.responder ? "requester_reply" : "responder_reply";
			}
			const m = this.#message(
				c,
				identity,
				kind,
				kind === "final" ? last.message_id : input.reply_to!,
				input.text,
				refs,
			);
			this.#save(c);
			this.#onChange?.(c.run_id);
			return { ok: true, value: { message_id: m.message_id, state: kind === "final" ? "answered" : "accepted" } };
		});
	}

	#perform<T>(
		identity: ConsultationIdentity,
		operation: string,
		key: string,
		payload: unknown,
		action: () => ConsultationResult<T>,
	): ConsultationResult<T> {
		if (typeof key !== "string" || !key) return { ok: false, error: "invalid_request" };
		const fingerprint = canonicalJson({ identity, operation, payload });
		return this.#db
			.transaction((): ConsultationResult<T> => {
				if (!this.#validIdentity(identity)) return { ok: false, error: "permission_denied" };
				const old = this.#db
					.query("SELECT fingerprint,result FROM consultation_requests WHERE run_id=? AND request_key=?")
					.get(identity.run_id, key) as { fingerprint: string; result: string } | null;
				if (old) {
					if (old.fingerprint !== fingerprint) return { ok: false, error: "idempotency_conflict" };
					const previous = JSON.parse(old.result) as ConsultationResult<T>;
					if (previous.ok && !this.#authorizeReplay(identity, operation, payload))
						return { ok: false, error: "permission_denied" };
					return previous;
				}
				const result = action();
				this.#db
					.query("INSERT INTO consultation_requests VALUES (?,?,?,?)")
					.run(identity.run_id, key, fingerprint, JSON.stringify(result));
				return result;
			})
			.immediate();
	}
	#authorizeReplay(identity: ConsultationIdentity, operation: string, payload: unknown): boolean {
		if (!payload || typeof payload !== "object") return false;
		const input = payload as { to_member?: string; conversation_id?: string; artifact_refs?: GraphRef[] };
		const refs = input.artifact_refs ?? [];
		if (!this.#validRefs(refs)) return false;
		if (operation === "ask")
			return (
				typeof input.to_member === "string" && !!this.#authority.policy(this.#db, identity, input.to_member, refs)
			);
		if (typeof input.conversation_id !== "string") return false;
		const c = this.get(input.conversation_id);
		return (
			!!c &&
			c.run_id === identity.run_id &&
			identity.member_id === (operation === "reply" ? identity.member_id : c.responder) &&
			(identity.member_id === c.requester || identity.member_id === c.responder) &&
			(identity.member_id !== c.requester ||
				(identity.invocation_id === c.requester_invocation_id && identity.attempt_id === c.requester_attempt_id)) &&
			this.#authority.participant?.(this.#db, identity, c) === true &&
			this.#authority.artifacts(this.#db, identity, c, refs) === true
		);
	}
	#validIdentity(identity: ConsultationIdentity): boolean {
		return (
			!!identity &&
			[identity.run_id, identity.member_id, identity.invocation_id, identity.attempt_id, identity.fence].every(
				v => typeof v === "string" && v.length > 0,
			) &&
			this.#authority.validate(this.#db, identity) === true
		);
	}
	#validText(text: string): boolean {
		return (
			typeof text === "string" &&
			text.trim().length > 0 &&
			Buffer.byteLength(text, "utf8") <= CONSULTATION_MESSAGE_BYTES
		);
	}
	#validRefs(refs: GraphRef[]): boolean {
		return (
			Array.isArray(refs) &&
			refs.every(r => !!r && typeof r.id === "string" && !!r.id && typeof r.digest === "string" && !!r.digest)
		);
	}
	#save(c: Consultation): void {
		this.#db
			.query(
				"INSERT INTO consultations VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,deadline=excluded.deadline,data=excluded.data",
			)
			.run(c.id, c.run_id, c.state, c.deadline, JSON.stringify(c));
	}
	#message(
		c: Consultation,
		identity: ConsultationIdentity,
		kind: ConsultationMessage["kind"],
		replyTo: string | null,
		text: string,
		refs: GraphRef[],
	): ConsultationMessage {
		const id = crypto.randomUUID();
		const m: ConsultationMessage = {
			conversation_id: c.id,
			message_id: id,
			in_reply_to: replyTo,
			kind,
			sender_member: identity.member_id,
			recipient_member: identity.member_id === c.requester ? c.responder : c.requester,
			content_ref: { id: `consultation-message:${id}`, digest: `sha256:${Bun.SHA256.hash(text, "hex")}` },
			text,
			artifact_refs: refs,
			sender_attempt_id: identity.attempt_id,
		};
		this.#db
			.query("INSERT INTO consultation_messages(conversation_id,message_id,data) VALUES (?,?,?)")
			.run(c.id, id, JSON.stringify(m));
		return m;
	}
	#timeout(c: Consultation): boolean {
		if ((c.state === "queued" || c.state === "active") && this.#now() >= c.deadline) {
			c.state = "timed_out";
			c.terminal_reason = "deadline";
			c.waiting_refs = [];
			c.wait_reason = null;
			this.#save(c);
			this.#onChange?.(c.run_id);
			return true;
		}
		return false;
	}
	#expire(runId: string): Consultation[] {
		const rows = this.#db
			.query("SELECT data FROM consultations WHERE run_id=? AND state IN ('queued','active') AND deadline<=?")
			.all(runId, this.#now()) as { data: string }[];
		return rows.map(row => {
			const c = JSON.parse(row.data) as Consultation;
			this.#timeout(c);
			return c;
		});
	}
	#wouldCycle(runId: string, from: string, to: string): boolean {
		const pending = this.list(runId).filter(c => c.state === "queued" || c.state === "active");
		const seen = new Set<string>();
		const visit = [to];
		while (visit.length) {
			const current = visit.pop()!;
			if (current === from) return true;
			if (seen.has(current)) continue;
			seen.add(current);
			for (const c of pending) if (c.requester === current) visit.push(c.responder);
		}
		return false;
	}
}

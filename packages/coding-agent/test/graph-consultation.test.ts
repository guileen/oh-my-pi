import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	GraphConsultationStore,
	type ConsultationAuthority,
	type ConsultationIdentity,
} from "../src/graph/consultation";

const roots: string[] = [];
const databases: Database[] = [];
let now = 1000;
const identity = (member_id: string, run_id = "run"): ConsultationIdentity => ({
	run_id,
	member_id,
	invocation_id: `inv-${member_id}`,
	attempt_id: `attempt-${member_id}`,
	fence: "current",
});
const authority: ConsultationAuthority = {
	validate: (_db, caller) => caller.fence === "current",
	policy: (_db, caller, to, refs) =>
		caller.member_id === "denied" || to === "denied" || refs.some(ref => ref.id === "private")
			? null
			: { max_rounds: 1, timeout_ms: 100 },
	artifacts: (_db, _caller, _conversation, refs) => !refs.some(ref => ref.id === "private"),
	delivery: () => true,
	participant: () => true,
	reserve: (db, caller, key) => {
		db.query("INSERT INTO test_reservations VALUES (?,?)").run(caller.run_id, key);
		return true;
	},
};
function open(filename?: string, onChange?: (runId: string) => void) {
	if (!filename) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-consultation-"));
		roots.push(root);
		filename = path.join(root, "graphs.sqlite");
	}
	const db = new Database(filename);
	databases.push(db);
	db.exec(
		"CREATE TABLE IF NOT EXISTS test_reservations (run_id TEXT NOT NULL, request_key TEXT NOT NULL, PRIMARY KEY (run_id,request_key))",
	);
	const store = new GraphConsultationStore(db, authority, () => now, onChange);
	return { store, filename, db };
}
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
	if (!result.ok) throw new Error(result.error);
	return result.value;
}
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	now = 1000;
});

describe("durable Graph consultations", () => {
	it("observes coherent conversation images before commit, without replay or delivery-only notifications", () => {
		const images: {
			runId: string;
			conversations: { state: string; wait_reason: string | null; remaining_rounds: number; kinds: string[] }[];
		}[] = [];
		const committedImages: unknown[] = [];
		const { store, filename } = open(undefined, runId => {
			const [currentImage, committedImage] = [store, committed].map(source =>
				source.list(runId).map(c => ({
					state: c.state,
					wait_reason: c.wait_reason,
					remaining_rounds: c.remaining_rounds,
					kinds: source.messages(c.id).map(message => message.kind),
				})),
			);
			images.push({ runId, conversations: currentImage! });
			committedImages.push(committedImage);
		});
		const committed = open(filename).store;
		const input = { to_member: "b", text: "Review", request_key: "ask" };
		const asked = unwrap(store.ask(identity("a"), input));
		expect(images).toEqual([
			{
				runId: "run",
				conversations: [
					{ state: "queued", wait_reason: "recipient_queued", remaining_rounds: 1, kinds: ["request"] },
				],
			},
		]);
		expect(committedImages).toEqual([[]]);
		expect(committed.messages(asked.conversation_id)).toEqual(store.messages(asked.conversation_id));
		expect(store.ask(identity("a"), input)).toEqual({ ok: true, value: asked });
		expect(unwrap(store.reserveDelivery(identity("b"), asked.message_id)).claimed).toBe(true);
		expect(unwrap(store.reserveDelivery(identity("b"), asked.message_id)).claimed).toBe(false);
		expect(store.settleDelivery(identity("b"), asked.message_id, "delivered")).toBe(true);
		expect(store.recoverDeliveries("run")).toEqual([]);
		expect(images).toHaveLength(1);
		store.activate(asked.conversation_id);
		store.activate(asked.conversation_id);
		expect(images).toHaveLength(2);
		const questionInput = {
			conversation_id: asked.conversation_id,
			reply_to: asked.message_id,
			text: "Why?",
			request_key: "question",
		};
		const question = unwrap(store.question(identity("b"), questionInput));
		expect(store.question(identity("b"), questionInput)).toEqual({ ok: true, value: question });
		expect(unwrap(store.reserveDelivery(identity("a"), question.message_id)).claimed).toBe(true);
		expect(store.recoverDeliveries("run").map(delivery => delivery.state)).toEqual(["unknown"]);
		expect(images).toHaveLength(3);
		const replyInput = {
			conversation_id: asked.conversation_id,
			reply_to: question.message_id,
			text: "Because",
			request_key: "reply",
		};
		const reply = unwrap(store.reply(identity("a"), replyInput));
		expect(store.reply(identity("a"), replyInput)).toEqual({ ok: true, value: reply });
		const finishInput = { conversation_id: asked.conversation_id, text: "Accepted", request_key: "finish" };
		const finished = unwrap(store.finish(identity("b"), finishInput));
		expect(store.finish(identity("b"), finishInput)).toEqual({ ok: true, value: finished });
		expect(images.slice(1)).toEqual([
			{
				runId: "run",
				conversations: [{ state: "active", wait_reason: null, remaining_rounds: 1, kinds: ["request"] }],
			},
			{
				runId: "run",
				conversations: [
					{ state: "active", wait_reason: "requester_reply", remaining_rounds: 0, kinds: ["request", "question"] },
				],
			},
			{
				runId: "run",
				conversations: [
					{
						state: "active",
						wait_reason: "responder_reply",
						remaining_rounds: 0,
						kinds: ["request", "question", "reply"],
					},
				],
			},
			{
				runId: "run",
				conversations: [
					{
						state: "answered",
						wait_reason: null,
						remaining_rounds: 0,
						kinds: ["request", "question", "reply", "final"],
					},
				],
			},
		]);
		expect(committedImages).toEqual([[], ...images.slice(0, -1).map(image => image.conversations)]);
	});

	it("rolls back observer writes, conversation mutations, messages, reservations and receipts when observation throws", () => {
		let reject = true;
		const { store, db } = open(undefined, runId => {
			const conversations = store.list(runId);
			expect(conversations).toHaveLength(1);
			expect(store.messages(conversations[0]!.id).length).toBeGreaterThan(0);
			db.query("INSERT INTO test_observations VALUES (?)").run(runId);
			if (reject) throw new Error("publication failed");
		});
		db.exec("CREATE TABLE test_observations (run_id TEXT NOT NULL)");
		const count = (table: string) => {
			const row = db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
			return row.count;
		};
		const input = { to_member: "b", text: "Review", request_key: "ask" };
		expect(() => store.ask(identity("a"), input)).toThrow("publication failed");
		for (const table of [
			"consultations",
			"consultation_messages",
			"consultation_requests",
			"consultation_deliveries",
			"test_reservations",
			"test_observations",
		])
			expect(count(table)).toBe(0);
		reject = false;
		const asked = unwrap(store.ask(identity("a"), input));
		const before = store.get(asked.conversation_id);
		const questionInput = {
			conversation_id: asked.conversation_id,
			reply_to: asked.message_id,
			text: "Why?",
			request_key: "question",
		};
		reject = true;
		expect(() => store.question(identity("b"), questionInput)).toThrow("publication failed");
		expect(store.get(asked.conversation_id)).toEqual(before);
		expect(store.messages(asked.conversation_id).map(message => message.kind)).toEqual(["request"]);
		expect(count("consultation_requests")).toBe(1);
		expect(count("test_observations")).toBe(1);
		reject = false;
		expect(store.question(identity("b"), questionInput).ok).toBe(true);
		expect(store.messages(asked.conversation_id).map(message => message.kind)).toEqual(["request", "question"]);
		expect(count("consultation_requests")).toBe(2);
		expect(count("test_observations")).toBe(2);
	});

	it.each(["activate", "cancel", "expire", "delivery", "response", "denied ask"] as const)(
		"observes deadline terminalization through %s, including denied operations",
		operation => {
			const images: unknown[] = [];
			const onChange = (runId: string) => {
				images.push({
					runId,
					conversations: store.list(runId).map(c => ({
						state: c.state,
						reason: c.terminal_reason,
						waiting_refs: c.waiting_refs,
						wait_reason: c.wait_reason,
						kinds: store.messages(c.id).map(message => message.kind),
					})),
				});
			};
			const { store, db } = open(undefined, onChange);
			const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
			now = 1100;
			if (operation === "activate") expect(store.activate(asked.conversation_id)?.state).toBe("timed_out");
			else if (operation === "cancel") expect(store.cancel(asked.conversation_id)?.state).toBe("timed_out");
			else if (operation === "expire") expect(store.expire("run").map(c => c.state)).toEqual(["timed_out"]);
			else if (operation === "delivery")
				expect(store.reserveDelivery(identity("b"), asked.message_id)).toEqual({
					ok: false,
					error: "consultation_timeout",
				});
			else if (operation === "response")
				expect(
					store.question(identity("b"), {
						conversation_id: asked.conversation_id,
						reply_to: asked.message_id,
						text: "Why?",
						request_key: "question",
					}),
				).toEqual({ ok: false, error: "consultation_timeout" });
			else {
				const denied = new GraphConsultationStore(db, { ...authority, reserve: () => false }, () => now, onChange);
				expect(denied.ask(identity("c"), { to_member: "d", text: "Review", request_key: "denied" })).toEqual({
					ok: false,
					error: "budget_exhausted",
				});
			}
			expect(images).toHaveLength(2);
			expect(images[1]).toEqual({
				runId: "run",
				conversations: [
					{ state: "timed_out", reason: "deadline", waiting_refs: [], wait_reason: null, kinds: ["request"] },
				],
			});
			store.activate(asked.conversation_id);
			store.cancel(asked.conversation_id);
			expect(store.expire("run")).toEqual([]);
			expect(images).toHaveLength(2);
		},
	);

	it("observes round exhaustion without inventing a message, and does not repeat its receipt", () => {
		const images: unknown[] = [];
		const { store } = open(undefined, runId => {
			images.push(store.list(runId).map(c => ({ conversation: c, messages: store.messages(c.id) })));
		});
		const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
		const question = unwrap(
			store.question(identity("b"), {
				conversation_id: asked.conversation_id,
				reply_to: asked.message_id,
				text: "Why?",
				request_key: "question",
			}),
		);
		const reply = unwrap(
			store.reply(identity("a"), {
				conversation_id: asked.conversation_id,
				reply_to: question.message_id,
				text: "Because",
				request_key: "reply",
			}),
		);
		const input = {
			conversation_id: asked.conversation_id,
			reply_to: reply.message_id,
			text: "More?",
			request_key: "exhausted",
		};
		expect(store.question(identity("b"), input)).toEqual({ ok: false, error: "consultation_timeout" });
		expect(images).toHaveLength(4);
		expect(images[3]).toEqual([
			{
				conversation: expect.objectContaining({
					state: "timed_out",
					terminal_reason: "rounds",
					waiting_refs: [],
					wait_reason: null,
				}),
				messages: store.messages(asked.conversation_id),
			},
		]);
		expect(store.messages(asked.conversation_id).map(message => message.kind)).toEqual([
			"request",
			"question",
			"reply",
		]);
		expect(store.question(identity("b"), input)).toEqual({ ok: false, error: "consultation_timeout" });
		expect(images).toHaveLength(4);
	});

	it("observes cancellation once and rolls back terminal transitions if the observer throws", () => {
		let reject = false;
		const images: unknown[] = [];
		const { store } = open(undefined, runId => {
			images.push(
				store.list(runId).map(c => ({ state: c.state, waiting_refs: c.waiting_refs, reason: c.terminal_reason })),
			);
			if (reject) throw new Error("publication failed");
		});
		const first = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "first" }));
		const queued = store.get(first.conversation_id);
		reject = true;
		expect(() => store.activate(first.conversation_id)).toThrow("publication failed");
		expect(store.get(first.conversation_id)).toEqual(queued);
		expect(() => store.cancel(first.conversation_id)).toThrow("publication failed");
		expect(store.get(first.conversation_id)).toEqual(queued);
		reject = false;
		store.activate(first.conversation_id);
		expect(store.cancel(first.conversation_id)?.state).toBe("cancelled");
		expect(images.at(-1)).toEqual([{ state: "cancelled", waiting_refs: [], reason: "cancelled" }]);
		const imageCount = images.length;
		store.cancel(first.conversation_id);
		expect(store.activate("missing")).toBeNull();
		expect(store.cancel("missing")).toBeNull();
		expect(images).toHaveLength(imageCount);
		const second = unwrap(store.ask(identity("c"), { to_member: "d", text: "Review", request_key: "second" }));
		const beforeTimeout = store.get(second.conversation_id);
		now = 1100;
		reject = true;
		expect(() => store.expire("run")).toThrow("publication failed");
		expect(store.get(second.conversation_id)).toEqual(beforeTimeout);
		reject = false;
		expect(store.expire("run").map(c => c.id)).toEqual([second.conversation_id]);
		expect(store.get(second.conversation_id)?.state).toBe("timed_out");
	});

	it("rejects non-boolean identity and artifact authorization decisions", () => {
		const { db, store } = open();
		const truthy = "allowed" as unknown as boolean;
		const invalidIdentity = new GraphConsultationStore(db, { ...authority, validate: () => truthy }, () => now);
		expect(invalidIdentity.ask(identity("a"), { to_member: "b", text: "Review", request_key: "bad-id" })).toEqual({
			ok: false,
			error: "permission_denied",
		});
		const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
		const invalidArtifacts = new GraphConsultationStore(db, { ...authority, artifacts: () => truthy }, () => now);
		expect(invalidArtifacts.reserveDelivery(identity("b"), asked.message_id)).toEqual({
			ok: false,
			error: "permission_denied",
		});
		expect(
			invalidArtifacts.question(identity("b"), {
				conversation_id: asked.conversation_id,
				reply_to: asked.message_id,
				text: "Why?",
				request_key: "question",
			}),
		).toEqual({ ok: false, error: "permission_denied" });
	});

	it("reserves delivery once, fences recipients and preserves uncertain delivery across restart", () => {
		const { store, filename } = open();
		const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
		expect(store.pendingDeliveries("run").map(m => m.message_id)).toEqual([asked.message_id]);
		expect(store.reserveDelivery(identity("c"), asked.message_id)).toEqual({ ok: false, error: "permission_denied" });
		expect(unwrap(store.reserveDelivery(identity("b"), asked.message_id))).toMatchObject({
			claimed: true,
			delivery: { state: "reserved" },
		});
		expect(unwrap(store.reserveDelivery(identity("b"), asked.message_id)).claimed).toBe(false);
		expect(store.pendingDeliveries("run")).toEqual([]);
		const restarted = open(filename).store;
		expect(restarted.recoverDeliveries("run").map(d => d.state)).toEqual(["unknown"]);
		expect(unwrap(restarted.reserveDelivery(identity("b"), asked.message_id))).toMatchObject({
			claimed: false,
			delivery: { state: "unknown" },
		});
		expect(restarted.settleDelivery(identity("b"), asked.message_id, "delivered")).toBe(false);
	});

	it("denies delivery without recipient authority and never delivers after the deadline", () => {
		const { db, store } = open();
		const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
		const withoutDeliveryAuthority = new GraphConsultationStore(db, { ...authority, delivery: undefined }, () => now);
		expect(withoutDeliveryAuthority.reserveDelivery(identity("b"), asked.message_id)).toEqual({
			ok: false,
			error: "permission_denied",
		});
		now = 1100;
		expect(store.reserveDelivery(identity("b"), asked.message_id)).toEqual({
			ok: false,
			error: "consultation_timeout",
		});
		expect(store.pendingDeliveries("run")).toEqual([]);
		expect(store.messages(asked.conversation_id).map(message => message.kind)).toEqual(["request"]);
	});

	it("settles only the admitted recipient's delivery and does not redeliver a receipt", () => {
		const { store } = open();
		const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
		expect(unwrap(store.reserveDelivery(identity("b"), asked.message_id)).claimed).toBe(true);
		expect(store.settleDelivery(identity("c"), asked.message_id, "delivered")).toBe(false);
		expect(store.settleDelivery(identity("b"), asked.message_id, "delivered")).toBe(true);
		expect(unwrap(store.reserveDelivery(identity("b"), asked.message_id))).toMatchObject({
			claimed: false,
			delivery: { state: "delivered" },
		});
		expect(store.pendingDeliveries("run")).toEqual([]);
	});

	it("rechecks conversation authorization when an accepted response is replayed", () => {
		const { db, store } = open();
		const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
		const input = {
			conversation_id: asked.conversation_id,
			reply_to: asked.message_id,
			text: "Why?",
			request_key: "q",
		};
		expect(store.question(identity("b"), input).ok).toBe(true);
		const revoked = new GraphConsultationStore(db, { ...authority, participant: () => false }, () => now);
		expect(revoked.question(identity("b"), input)).toEqual({ ok: false, error: "permission_denied" });
	});

	it("does not allow another invocation of the requester to reply or receive its message", () => {
		const { store } = open();
		const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
		const question = unwrap(
			store.question(identity("b"), {
				conversation_id: asked.conversation_id,
				reply_to: asked.message_id,
				text: "Why?",
				request_key: "question",
			}),
		);
		const other = { ...identity("a"), invocation_id: "other", attempt_id: "other" };
		expect(store.reserveDelivery(other, question.message_id)).toEqual({ ok: false, error: "permission_denied" });
		expect(
			store.reply(other, {
				conversation_id: asked.conversation_id,
				reply_to: question.message_id,
				text: "Because",
				request_key: "reply",
			}),
		).toEqual({ ok: false, error: "permission_denied" });
	});

	it("correlates a multi-round conversation and recovers it without modifying the original invocation", () => {
		const { store, filename } = open();
		const request = { to_member: "reviewer", text: "Review this", request_key: "ask" };
		const asked = unwrap(store.ask(identity("researcher"), request));
		expect(asked.state).toBe("queued");
		expect(store.get(asked.conversation_id)?.wait_reason).toBe("recipient_queued");
		const recovered = open(filename).store;
		expect(recovered.ask(identity("researcher"), request)).toEqual({ ok: true, value: asked });
		expect(recovered.activate(asked.conversation_id)?.state).toBe("active");
		const question = unwrap(
			recovered.question(identity("reviewer"), {
				conversation_id: asked.conversation_id,
				reply_to: asked.message_id,
				text: "Evidence?",
				request_key: "question",
			}),
		);
		const reply = unwrap(
			recovered.reply(identity("researcher"), {
				conversation_id: asked.conversation_id,
				reply_to: question.message_id,
				text: "Here",
				request_key: "reply",
				artifact_refs: [{ id: "evidence", digest: "sha256:evidence" }],
			}),
		);
		const final = unwrap(
			recovered.finish(identity("reviewer"), {
				conversation_id: asked.conversation_id,
				text: "Accepted",
				request_key: "finish",
			}),
		);
		expect(final.state).toBe("answered");
		expect(recovered.get(asked.conversation_id)).toMatchObject({
			state: "answered",
			requester_invocation_id: "inv-researcher",
			remaining_rounds: 0,
			waiting_refs: [],
		});
		expect(recovered.messages(asked.conversation_id).map(m => [m.kind, m.in_reply_to])).toEqual([
			["request", null],
			["question", asked.message_id],
			["reply", question.message_id],
			["final", reply.message_id],
		]);
	});

	it("checks directed authorization, fences, participants, artifacts and message correlation", () => {
		const { store } = open();
		expect(store.ask(identity("denied"), { to_member: "reviewer", text: "No", request_key: "denied" })).toEqual({
			ok: false,
			error: "permission_denied",
		});
		expect(store.list("run")).toEqual([]);
		expect(
			store.ask(
				{ ...identity("researcher"), fence: "stale" },
				{ to_member: "reviewer", text: "No", request_key: "stale" },
			),
		).toEqual({ ok: false, error: "permission_denied" });
		const asked = unwrap(
			store.ask(identity("researcher"), { to_member: "reviewer", text: "Review", request_key: "ask" }),
		);
		expect(
			store.finish(identity("researcher"), {
				conversation_id: asked.conversation_id,
				text: "Forged",
				request_key: "forged",
			}),
		).toEqual({ ok: false, error: "permission_denied" });
		expect(
			store.question(identity("reviewer"), {
				conversation_id: asked.conversation_id,
				reply_to: "wrong",
				text: "Question",
				request_key: "wrong",
			}),
		).toEqual({ ok: false, error: "invalid_request" });
		expect(
			store.question(identity("reviewer"), {
				conversation_id: asked.conversation_id,
				reply_to: asked.message_id,
				text: "Question",
				request_key: "private",
				artifact_refs: [{ id: "private", digest: "x" }],
			}),
		).toEqual({ ok: false, error: "permission_denied" });
		expect(
			store.finish(identity("reviewer", "other-run"), {
				conversation_id: asked.conversation_id,
				text: "No",
				request_key: "other",
			}),
		).toEqual({ ok: false, error: "not_found" });
		expect(store.messages(asked.conversation_id)).toHaveLength(1);
	});

	it("rejects independent cycles, but permits a correlated question and reply", () => {
		const { store } = open();
		const first = unwrap(store.ask(identity("a"), { to_member: "b", text: "A", request_key: "a-b" }));
		unwrap(store.ask(identity("b"), { to_member: "c", text: "B", request_key: "b-c" }));
		expect(store.ask(identity("c"), { to_member: "a", text: "C", request_key: "c-a" })).toEqual({
			ok: false,
			error: "wait_cycle",
		});
		const q = unwrap(
			store.question(identity("b"), {
				conversation_id: first.conversation_id,
				reply_to: first.message_id,
				text: "Why?",
				request_key: "q",
			}),
		);
		expect(
			store.reply(identity("a"), {
				conversation_id: first.conversation_id,
				reply_to: q.message_id,
				text: "Because",
				request_key: "r",
			}).ok,
		).toBe(true);
		expect(store.list("run")).toHaveLength(2);
	});

	it("allows correlated supplementary replies in either direction", () => {
		const { store } = open();
		const asked = unwrap(store.ask(identity("a"), { to_member: "b", text: "A", request_key: "ask" }));
		const first = unwrap(
			store.reply(identity("b"), {
				conversation_id: asked.conversation_id,
				reply_to: asked.message_id,
				text: "Supplement",
				request_key: "first",
			}),
		);
		const second = unwrap(
			store.reply(identity("a"), {
				conversation_id: asked.conversation_id,
				reply_to: first.message_id,
				text: "More",
				request_key: "second",
			}),
		);
		expect(store.get(asked.conversation_id)?.remaining_rounds).toBe(1);
		expect(
			store.finish(identity("b"), { conversation_id: asked.conversation_id, text: "Final", request_key: "final" })
				.ok,
		).toBe(true);
		expect(store.messages(asked.conversation_id)[3].in_reply_to).toBe(second.message_id);
	});

	it("persists deadline and round exhaustion without fabricating a final answer", () => {
		const { store } = open();
		const timed = unwrap(store.ask(identity("a"), { to_member: "b", text: "A", request_key: "timed" }));
		now = 1100;
		expect(
			store.finish(identity("b"), { conversation_id: timed.conversation_id, text: "Late", request_key: "late" }),
		).toEqual({ ok: false, error: "consultation_timeout" });
		expect(store.get(timed.conversation_id)).toMatchObject({
			state: "timed_out",
			terminal_reason: "deadline",
			waiting_refs: [],
		});
		const limited = unwrap(store.ask(identity("a"), { to_member: "b", text: "Again", request_key: "limited" }));
		const q = unwrap(
			store.question(identity("b"), {
				conversation_id: limited.conversation_id,
				reply_to: limited.message_id,
				text: "Question",
				request_key: "q",
			}),
		);
		const r = unwrap(
			store.reply(identity("a"), {
				conversation_id: limited.conversation_id,
				reply_to: q.message_id,
				text: "Reply",
				request_key: "r",
			}),
		);
		expect(
			store.question(identity("b"), {
				conversation_id: limited.conversation_id,
				reply_to: r.message_id,
				text: "Another?",
				request_key: "q2",
			}),
		).toEqual({ ok: false, error: "consultation_timeout" });
		expect(store.get(limited.conversation_id)).toMatchObject({ state: "timed_out", terminal_reason: "rounds" });
		expect(store.messages(limited.conversation_id).map(m => m.kind)).toEqual(["request", "question", "reply"]);
	});

	it("records idempotent receipts and rejects conflicting key reuse", () => {
		const { store } = open();
		const request = { to_member: "b", text: "A", request_key: "same" };
		const first = store.ask(identity("a"), request);
		expect(store.ask(identity("a"), request)).toEqual(first);
		expect(store.ask(identity("a"), { ...request, text: "Different" })).toEqual({
			ok: false,
			error: "idempotency_conflict",
		});
		expect(store.list("run")).toHaveLength(1);
	});

	it("requires atomic budget admission and rolls back rejected reservations", () => {
		const { db } = open();
		const missing = new GraphConsultationStore(
			db,
			{ validate: authority.validate, policy: authority.policy, artifacts: authority.artifacts },
			() => now,
		);
		expect(missing.ask(identity("a"), { to_member: "b", text: "A", request_key: "missing" })).toEqual({
			ok: false,
			error: "budget_exhausted",
		});
		const denied = new GraphConsultationStore(
			db,
			{
				...authority,
				reserve: (connection, caller, key) => {
					connection.query("INSERT INTO test_reservations VALUES (?,?)").run(caller.run_id, key);
					return false;
				},
			},
			() => now,
		);
		expect(denied.ask(identity("a"), { to_member: "b", text: "A", request_key: "denied-budget" })).toEqual({
			ok: false,
			error: "budget_exhausted",
		});
		expect(db.query("SELECT * FROM test_reservations").all()).toEqual([]);
		expect(denied.list("run")).toEqual([]);
	});

	it("refuses a message past the 64 KiB cap on every path", () => {
		const { store } = open();
		const oversized = "a".repeat(64 * 1024 + 1);
		expect(store.ask(identity("a"), { to_member: "b", text: oversized, request_key: "big" })).toEqual({
			ok: false,
			error: "invalid_request",
		});
		expect(store.list("run")).toEqual([]);
		const admitted = unwrap(store.ask(identity("a"), { to_member: "b", text: "Review", request_key: "ask" }));
		expect(
			store.reply(identity("a"), {
				conversation_id: admitted.conversation_id,
				reply_to: admitted.message_id,
				text: oversized,
				request_key: "big-reply",
			}),
		).toEqual({ ok: false, error: "invalid_request" });
		expect(
			store.finish(identity("a"), {
				conversation_id: admitted.conversation_id,
				text: oversized,
				request_key: "big-finish",
			}),
		).toEqual({ ok: false, error: "invalid_request" });
	});
});

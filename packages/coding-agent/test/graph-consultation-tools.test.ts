import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { GraphConsultationStore, type ConsultationIdentity, type ConsultationMessage } from "../src/graph/consultation";
import { createGraphConsultationTools } from "../src/tools/graph-consultation";

const identity = (member_id: string): ConsultationIdentity => ({
	run_id: "run",
	member_id,
	invocation_id: `inv-${member_id}`,
	attempt_id: `attempt-${member_id}`,
	fence: "current",
});

describe("Graph consultation tool adapters", () => {
	it("suspends after durable admission and exposes only the host-delivered message", async () => {
		const db = new Database(":memory:");
		try {
			const store = new GraphConsultationStore(db, {
				validate: () => true,
				policy: () => ({ max_rounds: 1, timeout_ms: 1000 }),
				artifacts: () => true,
				reserve: () => true,
			});
			const ready = Promise.withResolvers<void>();
			const released = Promise.withResolvers<ConsultationMessage>();
			const tools = createGraphConsultationTools({
				store,
				identity: () => identity("researcher"),
				wait: async (_identity, conversationId, messageId) => {
					expect(store.messages(conversationId)[0].message_id).toBe(messageId);
					ready.resolve();
					return { ok: true, value: await released.promise };
				},
			});
			const execution = tools.ask.execute("ask", { to_member: "reviewer", text: "Review", request_key: "ask" });
			await ready.promise;
			const message = store.messages(store.list("run")[0].id)[0];
			released.resolve(message);
			expect((await execution).details.value.delivery).toEqual(message);
		} finally {
			db.close();
		}
	});

	it("returns the real timeout without inventing a consultation answer", async () => {
		const db = new Database(":memory:");
		try {
			const store = new GraphConsultationStore(db, {
				validate: () => true,
				policy: () => ({ max_rounds: 1, timeout_ms: 1000 }),
				artifacts: () => true,
				reserve: () => true,
			});
			const tools = createGraphConsultationTools({
				store,
				identity: () => identity("researcher"),
				wait: async () => ({ ok: false, error: "consultation_timeout" }),
			});
			const response = await tools.ask.execute("ask", {
				to_member: "reviewer",
				text: "Review",
				request_key: "ask",
			});
			expect(response.details).toEqual({ ok: false, error: "consultation_timeout" });
			expect(store.messages(store.list("run")[0].id).map(message => message.kind)).toEqual(["request"]);
		} finally {
			db.close();
		}
	});

	it("persists a correlated conversation with trusted caller identities", async () => {
		const db = new Database(":memory:");
		try {
			const store = new GraphConsultationStore(db, {
				validate: (_db, caller) => caller.fence === "current",
				policy: (_db, _caller, recipient, refs) =>
					recipient === "reviewer" && !refs.some(ref => ref.id === "private")
						? { max_rounds: 1, timeout_ms: 1000 }
						: null,
				artifacts: (_db, _caller, _conversation, refs) => !refs.some(ref => ref.id === "private"),
				participant: () => true,
				reserve: () => true,
			});
			let caller: ConsultationIdentity | null = identity("researcher");
			const tools = createGraphConsultationTools({ store, identity: () => caller });
			const input = { to_member: "reviewer", text: "Review", request_key: "ask", member_id: "reviewer" };
			const asked = await tools.ask.execute("1", input);
			expect(asked.details.ok).toBe(true);
			expect(asked.details.value.state).toBe("queued");
			expect(store.get(asked.details.value.conversation_id)?.requester).toBe("researcher");
			expect((await tools.ask.execute("2", input)).details).toEqual(asked.details);
			const conversation_id = asked.details.value.conversation_id;
			caller = identity("reviewer");
			const question = await tools.question.execute("3", {
				conversation_id,
				reply_to: asked.details.value.message_id,
				text: "Evidence?",
				request_key: "question",
			});
			expect(question.details.ok).toBe(true);
			caller = identity("researcher");
			const reply = await tools.reply.execute("4", {
				conversation_id,
				reply_to: question.details.value.message_id,
				text: "Here",
				request_key: "reply",
			});
			expect(reply.details.value.state).toBe("accepted");
			expect(store.get(conversation_id)?.state).not.toBe("answered");
			const denied = await tools.finish.execute("5", { conversation_id, text: "Forged", request_key: "forged" });
			expect(denied.isError).toBe(true);
			expect(denied.details.error).toBe("permission_denied");
			caller = identity("reviewer");
			const final = await tools.finish.execute("6", { conversation_id, text: "Done", request_key: "finish" });
			expect(final.details.value.state).toBe("answered");
			expect(store.messages(conversation_id).map(message => message.kind)).toEqual([
				"request",
				"question",
				"reply",
				"final",
			]);
		} finally {
			db.close();
		}
	});

	it("fails closed for absent, stale, and unauthorized identities", async () => {
		const db = new Database(":memory:");
		try {
			const store = new GraphConsultationStore(db, {
				validate: (_db, caller) => caller.fence === "current",
				policy: () => null,
				artifacts: () => false,
				reserve: () => true,
			});
			let caller: ConsultationIdentity | null = null;
			const { ask } = createGraphConsultationTools({ store, identity: () => caller });
			const input = { to_member: "reviewer", text: "Review", request_key: "ask" };
			expect((await ask.execute("1", input)).details.error).toBe("permission_denied");
			caller = { ...identity("researcher"), fence: "stale" };
			expect((await ask.execute("2", input)).details.error).toBe("permission_denied");
			caller = identity("researcher");
			expect((await ask.execute("3", input)).details.error).toBe("permission_denied");
			expect(store.list("run")).toEqual([]);
		} finally {
			db.close();
		}
	});
});

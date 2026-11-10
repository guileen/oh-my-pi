import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { BotJob } from "@oh-my-pi/pi-coding-agent/bots/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { GraphConsultationStore } from "@oh-my-pi/pi-coding-agent/graph/consultation";
import {
	createGraphBotRuntime,
	createGraphBotTools,
	prepareGraphBot,
	type GraphBotAssignment,
} from "@oh-my-pi/pi-coding-agent/graph/executors/bot";

const model = { provider: "fixture-provider", id: "fixture-model" } as Model;
const registry = {
	getAvailableForProviders: () => [model],
	hasConfiguredAuth: () => true,
} as unknown as ModelRegistry;

function assignment(): GraphBotAssignment {
	return {
		member: {
			role: "#role",
			model: "binding",
			base: "omp-default",
			duty: "code-only",
			permissions: { read: [], write: [], execute: [] },
		},
		role: "Graph role marker",
		task: "Graph task marker",
		bindings: [{ name: "binding", provider: model.provider, model: model.id, revision: "1" }],
		modelRegistry: registry,
		baseAvailable: true,
		assertToolCall: () => {},
	};
}

describe("Graph Bot adapter", () => {
	it("rejects unavailable bases and missing, ambiguous or unauthenticated bindings", () => {
		const a = assignment();
		expect(() => prepareGraphBot({ ...a, baseAvailable: false })).toThrow("base");
		expect(() => prepareGraphBot({ ...a, bindings: [] })).toThrow("missing or ambiguous");
		expect(() => prepareGraphBot({ ...a, bindings: [...a.bindings, ...a.bindings] })).toThrow("missing or ambiguous");
		expect(() =>
			prepareGraphBot({
				...a,
				modelRegistry: { ...registry, getAvailableForProviders: () => [] } as unknown as ModelRegistry,
			}),
		).toThrow("unavailable");
		expect(() =>
			prepareGraphBot({
				...a,
				modelRegistry: {
					getAvailableForProviders: () => [model],
					hasConfiguredAuth: () => false,
				} as unknown as ModelRegistry,
			}),
		).toThrow("unavailable");
	});

	it("enforces the coding base and trusted tool policy", () => {
		const a = assignment();
		expect(() => prepareGraphBot({ ...a, member: { ...a.member, base: "isolated" } })).toThrow("base");
		expect(() => prepareGraphBot({ ...a, assertToolCall: undefined as never })).toThrow("authorization policy");
	});

	it("freezes the exact binding and rechecks its availability without falling back", () => {
		let available = true;
		const a = assignment();
		const dynamicRegistry = {
			getAvailableForProviders: () => (available ? [model] : [{ ...model, id: "other" }]),
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		const prepared = prepareGraphBot({ ...a, modelRegistry: dynamicRegistry });
		a.bindings[0].model = "other";
		expect(prepared.binding.model).toBe(model.id);
		available = false;
		expect(() => prepared.assertAvailable()).toThrow("unavailable");
	});

	it("keeps the binding immutable and rejects a changed prepared model before dispatch", () => {
		const selected = { ...model };
		let available = [selected];
		const dynamicRegistry = {
			getAvailableForProviders: () => available,
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		const prepared = prepareGraphBot({ ...assignment(), modelRegistry: dynamicRegistry });

		expect(Reflect.set(prepared.binding, "model", "other")).toBe(false);
		expect(Reflect.set(prepared.binding, "revision", "other")).toBe(false);
		available = [{ ...model, id: "other" }];
		expect(() => prepared.assertAvailable()).toThrow("unavailable");

		available = [{ ...model }];
		selected.id = "other";
		expect(() => prepared.assertAvailable()).toThrow("identity changed");
		selected.id = model.id;
		prepared.graph.model = { ...model, id: "other" };
		expect(() => prepared.assertAvailable()).toThrow("identity changed");
	});

	it("rejects same-id deployment changes, including nested request configuration", () => {
		const original = {
			...model,
			api: "openai-completions",
			baseUrl: "https://approved.invalid/v1",
			requestModelId: "approved-wire-model",
			headers: { "X-Tenant": "approved" },
			requestMetadata: { project: "approved" },
		} as Model;
		const changes: Partial<Model>[] = [
			{ baseUrl: "https://other.invalid/v1" },
			{ api: "openai-responses" },
			{ requestModelId: "other-wire-model" },
			{ headers: { "X-Tenant": "other" } },
			{ requestMetadata: { project: "other" } },
			{ resolveHeaders: async () => ({ "X-Tenant": "other" }) },
		];
		for (const change of changes) {
			let selected = structuredClone(original);
			const prepared = prepareGraphBot({
				...assignment(),
				modelRegistry: {
					getAvailableForProviders: () => [selected],
					hasConfiguredAuth: () => true,
				} as unknown as ModelRegistry,
			});
			selected = { ...selected, ...change };
			expect(() => prepared.assertAvailable()).toThrow("configuration changed");
		}
	});

	it("detects in-place deployment mutation while retaining lazy credential resolution", () => {
		let resolutions = 0;
		const selected = {
			...model,
			headers: { "X-Tenant": "approved" },
			resolveHeaders: async () => {
				resolutions++;
				return { Authorization: "refreshed-token" };
			},
		};
		const prepared = prepareGraphBot({
			...assignment(),
			modelRegistry: {
				getAvailableForProviders: () => [selected],
				hasConfiguredAuth: () => true,
			} as unknown as ModelRegistry,
		});
		prepared.assertAvailable();
		expect(resolutions).toBe(0);
		selected.headers["X-Tenant"] = "other";
		expect(() => prepared.assertAvailable()).toThrow("configuration changed");
	});

	it("injects a host-bound completion tool and propagates its actual receipt", async () => {
		const submitted: unknown[] = [];
		const tools = createGraphBotTools({
			completion: {
				async submit(candidate) {
					submitted.push(candidate);
					return {
						request_key: candidate.request_key,
						state: "rejected",
						error: {
							code: "stale_fence",
							message: "stale",
							location: null,
							retryable: false,
							details: null,
						},
					};
				},
			},
		});
		expect(tools.map(tool => tool.name)).toEqual(["graph_complete"]);
		const candidate = { request_key: "one", outcome: "done", outputs: {} };
		const receipt = await tools[0].execute("call", candidate, undefined, undefined as never);
		expect(submitted).toEqual([candidate]);
		expect(receipt.isError).toBe(true);
		expect(receipt.details.state).toBe("rejected");
	});

	it("exposes consultation only with host identity and denies an absent identity", async () => {
		const tools = createGraphBotTools({
			completion: {
				async submit(candidate) {
					return { request_key: candidate.request_key, state: "accepted", error: null };
				},
			},
			consultation: {
				store: {} as never,
				identity: () => null,
				wait: async () => ({ ok: false, error: "permission_denied" }),
			},
		});
		expect(tools.map(tool => tool.name)).toEqual([
			"graph_complete",
			"graph_ask",
			"graph_reply",
			"graph_question",
			"graph_finish",
		]);
		const result = await tools[1].execute(
			"call",
			{
				to_member: "reviewer",
				text: "Review",
				request_key: "ask",
			},
			undefined,
			undefined as never,
		);
		expect(result.isError).toBe(true);
		expect(result.details.error).toBe("permission_denied");
	});

	it("requires a continuation gate before exposing consultation to a Bot", () => {
		expect(() =>
			createGraphBotTools({
				completion: {
					async submit(candidate) {
						return { request_key: candidate.request_key, state: "accepted", error: null };
					},
				},
				consultation: { store: {} as never, identity: () => null },
			}),
		).toThrow("continuation gate");
	});

	it("persists a fenced request before suspending its Bot tool until the host admits delivery", async () => {
		const db = new Database(":memory:");
		try {
			const caller = {
				run_id: "run",
				member_id: "author",
				invocation_id: "inv",
				attempt_id: "attempt",
				fence: "epoch",
			};
			const store = new GraphConsultationStore(db, {
				validate: (_db, identity) => identity.fence === "epoch" && identity.attempt_id === "attempt",
				policy: () => ({ max_rounds: 1, timeout_ms: 10000 }),
				artifacts: () => true,
				reserve: () => true,
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const tools = createGraphBotTools({
				completion: {
					async submit(candidate) {
						return { request_key: candidate.request_key, state: "accepted", error: null };
					},
				},
				consultation: {
					store,
					identity: () => caller,
					wait: async (identity, conversationId, messageId) => {
						expect(identity).toEqual(caller);
						expect(store.messages(conversationId)[0].message_id).toBe(messageId);
						entered.resolve();
						await release.promise;
						return { ok: false, error: "consultation_timeout" };
					},
				},
			});
			let settled = false;
			const execution = tools[1]
				.execute(
					"call",
					{ to_member: "reviewer", text: "Review", request_key: "ask" },
					undefined,
					undefined as never,
				)
				.then(value => {
					settled = true;
					return value;
				});
			await entered.promise;
			expect(settled).toBe(false);
			expect(store.list("run")).toHaveLength(1);
			release.resolve();
			expect((await execution).details).toEqual({ ok: false, error: "consultation_timeout" });
			caller.fence = "stale";
			const denied = await tools[1].execute(
				"stale",
				{ to_member: "reviewer", text: "Review", request_key: "other" },
				undefined,
				undefined as never,
			);
			expect(denied.details.error).toBe("permission_denied");
			expect(store.list("run")).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("rejects capability overrides and requires fencing and completion before runtime creation", async () => {
		const a = assignment();
		const tools = {
			completion: {
				async submit(candidate: { request_key: string }) {
					return { request_key: candidate.request_key, state: "accepted" as const, error: null };
				},
			},
		};
		const tool = createGraphBotTools(tools)[0];
		expect(() => prepareGraphBot({ ...a, tools, customTools: [tool] })).toThrow("cannot be overridden");
		expect(() => prepareGraphBot({ ...a, tools, customTools: [{ ...tool, name: "graph_finish" }] })).toThrow(
			"cannot be overridden",
		);
		await expect(createGraphBotRuntime({} as BotJob, { onEvent() {} }, a)).rejects.toThrow("dispatch fence");
		await expect(createGraphBotRuntime({} as BotJob, { onEvent() {}, assertDispatch() {} }, a)).rejects.toThrow(
			"completion capability",
		);
	});
});

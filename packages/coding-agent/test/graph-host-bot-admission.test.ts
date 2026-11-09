import type { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GraphHost, type GraphHostOptions } from "../src/graph/host";
import { GraphRunStore, type GraphDispatchIntent } from "../src/graph/store";

it("rejects a consultation-enabled Bot before runtime creation when the host has no consultation service", async () => {
	const intent: GraphDispatchIntent = {
		id: "intent",
		run_id: "run",
		invocation_id: "invocation",
		attempt_id: "attempt",
		request_key: "request",
		fence: "epoch",
		state: "pending",
		request: {},
		observation: null,
	};
	const member = {
		role: "#role",
		model: "binding",
		base: "omp-default",
		duty: "general",
		permissions: { read: [], write: [], execute: [] },
	};
	const run = { id: "run", graph_id: "graph", state: "running", snapshot_ref: { id: "snapshot", digest: "d" } };
	let scheduled = false;
	let observation: unknown;
	const store = {
		claimHost: () => ({ owner_id: "owner", epoch: "epoch" }),
		assertHostOwner: () => {},
		getRun: () => run,
		listHostRuns: () => [run],
		listHostIntents: () => [],
		getScheduleState: () => ({
			invocations: [{ id: "invocation", node: "work", state: "running", attempt_id: "attempt" }],
		}),
		getFrozenDefinition: () => ({ members: { worker: member }, nodes: { work: { kind: "bot", member: "worker" } } }),
		getSnapshot: () => ({
			members: {
				worker: { provider: "provider", model: "model", configuration_revision: "rev", base: "omp-default" },
			},
		}),
		getDispatchIntents: () => [intent],
		submitBotCompletion: () => {
			throw new Error("unexpected completion");
		},
		getBotCompletion: () => null,
		schedule: () => {
			if (scheduled) return { intent: null };
			scheduled = true;
			return { intent };
		},
		claimDispatch: () => {
			intent.state = "submitting";
			return { ...intent };
		},
		observeDispatch: (
			_owner: string,
			_epoch: string,
			_id: string,
			state: GraphDispatchIntent["state"],
			value: unknown,
		) => {
			intent.state = state;
			observation = value;
			return true;
		},
	};
	const host = new GraphHost({
		store: store as unknown as GraphHostOptions["store"],
		program: {
			accept: async () => {
				throw new Error("unexpected program");
			},
			query: () => null,
			cancel: () => "unknown",
		},
		resolveProgram: async () => {
			throw new Error("unexpected program");
		},
		verifyProgramResult: async () => {
			throw new Error("unexpected program");
		},
		bot: {
			authorize: () => true,
			resolve: async () => ({
				job: {
					job_id: "job",
					graph_context: { graph_id: "graph", graph_run_id: "run", invocation_id: "invocation", node_id: "work" },
				} as never,
				member_id: "worker",
				input: "work",
				consultation: true,
				assignment: {
					member: member as never,
					role: "role",
					task: "task",
					bindings: [{ name: "binding", provider: "provider", model: "model", revision: "rev" }],
					modelRegistry: {} as never,
					baseAvailable: true,
					assertToolCall: () => {},
				},
				callbacks: {
					onEvent() {},
					assertDispatch() {},
					onContinuation: async () => {},
					onSessionOwner() {},
					onLaunchIntent: async () => {},
					onLaunchDisposition() {},
				},
			}),
		},
	});
	expect(host.start()).toBe(true);
	await host.tick();
	expect(intent.state).toBe("unknown");
	expect(observation).toMatchObject({
		reason: expect.stringContaining("Consultation recipient capability is unavailable"),
	});
});

it("does not deliver or start consultations while a run is held", async () => {
	let examined = 0;
	let expired = 0;
	const store = {
		claimHost: () => ({ owner_id: "owner", epoch: "epoch" }),
		assertHostOwner: () => {},
		listHostIntents: () => [],
		listHostRuns: () => [],
		getRun: () => ({ id: "run", state: "held" }),
		resumeConsultation: () => {
			throw new Error("unexpected resume");
		},
		startConsultationInvocation: () => {
			throw new Error("unexpected dispatch");
		},
	};
	const consultation = {
		activeRunIds: () => ["run"],
		recoverDeliveries: () => [],
		expire: () => {
			expired++;
		},
		pendingDeliveries: () => {
			examined++;
			return [];
		},
	};
	const host = new GraphHost({
		store: store as unknown as GraphHostOptions["store"],
		consultation: consultation as never,
		program: {
			accept: async () => {
				throw new Error("unexpected program");
			},
			query: () => null,
			cancel: () => "unknown",
		},
		resolveProgram: async () => {
			throw new Error("unexpected program");
		},
		verifyProgramResult: async () => {
			throw new Error("unexpected program");
		},
	});
	expect(host.start()).toBe(true);
	await host.tick();
	expect(expired).toBe(1);
	expect(examined).toBe(0);
});

it("installs consultation authority once on the run store's database", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-consultation-host-"));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	try {
		let sawRunSchema = false;
		const authority = {
			validate(db: Database) {
				sawRunSchema = !!db.query("SELECT name FROM sqlite_master WHERE name='graph_dispatch_intents'").get();
				return false;
			},
			policy: () => null,
			artifacts: () => false,
		};
		const consultation = store.configureConsultation(authority);
		expect(store.configureConsultation.bind(store, authority)).toThrow("already configured");
		expect(
			consultation.ask(
				{ run_id: "run", member_id: "author", invocation_id: "inv", attempt_id: "attempt", fence: "epoch" },
				{ to_member: "reviewer", text: "Review", request_key: "request" },
			),
		).toEqual({ ok: false, error: "permission_denied" });
		expect(sawRunSchema).toBe(true);
	} finally {
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("routes an independent consultation for a member without a graph node to the Bot resolver", async () => {
	const consultation = { conversation_id: "conversation", message_id: "message", member_id: "reviewer" };
	const intent: GraphDispatchIntent = {
		id: "intent",
		run_id: "run",
		invocation_id: "invocation",
		attempt_id: "attempt",
		request_key: "request",
		fence: "epoch",
		state: "pending",
		request: { consultation },
		observation: null,
	};
	let resolved = false;
	let observation: unknown;
	let scheduled = false;
	const run = { id: "run", state: "running" };
	const store = {
		claimHost: () => ({ owner_id: "owner", epoch: "epoch" }),
		assertHostOwner: () => {},
		getRun: () => run,
		listHostRuns: () => [run],
		listHostIntents: () => [],
		getScheduleState: () => ({
			invocations: [{ id: "invocation", node: "consultation:reviewer", consultation }],
		}),
		getFrozenDefinition: () => ({ nodes: {}, members: { reviewer: {} } }),
		schedule: () => {
			if (scheduled) return { intent: null };
			scheduled = true;
			return { intent };
		},
		claimDispatch: () => ({ ...intent, state: "submitting" }),
		observeDispatch: (_owner: string, _epoch: string, _id: string, _state: string, value: unknown) => {
			observation = value;
			return true;
		},
	};
	const host = new GraphHost({
		store: store as unknown as GraphHostOptions["store"],
		program: {
			accept: async () => {
				throw new Error("unexpected program");
			},
			query: () => null,
			cancel: () => "unknown",
		},
		resolveProgram: async () => {
			throw new Error("unexpected program");
		},
		verifyProgramResult: async () => {
			throw new Error("unexpected program");
		},
		bot: {
			authorize: () => true,
			resolve: async () => {
				resolved = true;
				return null;
			},
		},
	});
	expect(host.start()).toBe(true);
	await host.tick();
	expect(resolved).toBe(true);
	expect(observation).toMatchObject({ reason: expect.stringContaining("Trusted consultation Bot resolution") });
});

import { describe, expect, it } from "bun:test";
import { GraphHost, type GraphHostOptions } from "../src/graph/host";
import type { ProgramExecutionRequest, ProgramResult } from "../src/graph/executors/program";
import type { GraphDispatchIntent } from "../src/graph/store";

const intent = (): GraphDispatchIntent => ({
	id: "intent",
	run_id: "run",
	invocation_id: "invocation",
	attempt_id: "attempt",
	request_key: "request",
	fence: "1",
	state: "pending",
	request: {},
	observation: null,
});
const envelope = (): ProgramExecutionRequest => ({
	version: 1,
	run_id: "run",
	invocation_id: "invocation",
	attempt_id: "attempt",
	fence: "1",
	request_key: "request",
	executor: "program",
	inputs: {},
	task_ref: { id: "task", digest: "digest" },
	authorization_ref: { id: "auth", digest: "digest" },
	model_binding_ref: null,
	base_snapshot_ref: null,
	duty: "general",
	deadline: null,
	parameters: {},
	outputs: {},
	principal: "user",
	output_scope: [],
});

function fixture(
	existing: GraphDispatchIntent[] = [],
	reject = false,
	registrationMatches: boolean | "missing" = true,
) {
	const intents = [...existing];
	let held = false;
	let scheduled = false;
	let submissions = 0;
	let completions = 0;
	let result: ProgramResult | null = null;
	const store = {
		claimHost: () => ({ owner_id: "owner", epoch: "1" }),
		assertHostOwner: () => {},
		getRun: () => ({ id: "run", state: held ? "held" : "running", snapshot_ref: { id: "snapshot", digest: "d" } }),
		listHostRuns: () =>
			held ? [] : [{ id: "run", state: "running", snapshot_ref: { id: "snapshot", digest: "d" } }],
		getScheduleState: () => ({ invocations: [{ id: "invocation", node: "work" }] }),
		getFrozenDefinition: () => ({ nodes: { work: { kind: "program", executor: "program" } } }),
		getSnapshot: () => ({ executors: { program: { id: "program", digest: "digest" } } }),
		listHostIntents: () => intents.filter(item => item.state !== "finished"),
		claimDispatch: (_owner: string, _epoch: string, id: string) => {
			const item = intents.find(entry => entry.id === id);
			if (!item || item.state !== "pending" || held) return null;
			item.state = "submitting";
			return { ...item };
		},
		observeDispatch: (
			_owner: string,
			_epoch: string,
			id: string,
			state: "accepted" | "unknown",
			observation: unknown,
		) => {
			const item = intents.find(entry => entry.id === id);
			if (!item || item.state === "unknown" || item.state === "finished") return false;
			item.state = state;
			item.observation = observation;
			if (state === "unknown") held = true;
			return true;
		},
		schedule: () => {
			if (scheduled) return { intent: null };
			scheduled = true;
			const next = intent();
			intents.push(next);
			return { intent: next };
		},
		completeAttempt: () => {
			completions++;
			intents[0].state = "finished";
			return true;
		},
	};
	const host = new GraphHost({
		store: store as unknown as GraphHostOptions["store"],
		program: {
			verifyRegistration:
				registrationMatches === "missing"
					? undefined
					: (name, ref) =>
							registrationMatches && name === "program" && ref.id === "program" && ref.digest === "digest",
			accept: async () => {
				submissions++;
				return reject
					? { state: "rejected", execution_ref: null, error: "Program execution denied" }
					: { state: "accepted", execution_ref: "exec", error: null };
			},
			query: () => result,
			cancel: () => "unknown",
		},
		resolveProgram: async () => envelope(),
		verifyProgramResult: async (_intent, observed) => ({
			run_id: "run",
			invocation_id: "invocation",
			attempt_id: "attempt",
			fence: "1",
			state: observed.state as "succeeded" | "failed",
		}),
	});
	return {
		host,
		intents,
		submissions: () => submissions,
		completions: () => completions,
		setResult: (value: ProgramResult) => {
			result = value;
		},
	};
}

describe("Graph dispatch host", () => {
	it("does not dispatch when the frozen program registration no longer matches", async () => {
		const f = fixture([], false, false);
		f.host.start();
		await f.host.tick();
		expect(f.submissions()).toBe(0);
		expect(f.intents[0].state).toBe("unknown");
		expect(f.intents[0].observation).toMatchObject({
			reason: expect.stringContaining("Frozen program registration is unavailable or has changed"),
		});
	});

	it("does not dispatch without a registry verifier", async () => {
		const f = fixture([], false, "missing");
		f.host.start();
		await f.host.tick();
		expect(f.submissions()).toBe(0);
		expect(f.intents[0].state).toBe("unknown");
	});

	it("rejects a program envelope naming a different executor than the frozen node", async () => {
		const current = intent();
		let submissions = 0;
		const store = {
			claimHost: () => ({ owner_id: "owner", epoch: "1" }),
			assertHostOwner: () => {},
			getRun: () => ({ id: "run", state: "running" }),
			listHostRuns: () => [{ id: "run", state: "running" }],
			listHostIntents: () => [],
			getScheduleState: () => ({ invocations: [{ id: "invocation", node: "work" }] }),
			getFrozenDefinition: () => ({ nodes: { work: { kind: "program", executor: "registered" } } }),
			schedule: () => ({ intent: current }),
			claimDispatch: () => ({ ...current, state: "submitting" }),
			observeDispatch: (_owner: string, _epoch: string, _id: string, state: GraphDispatchIntent["state"]) => {
				current.state = state;
				return true;
			},
		};
		const host = new GraphHost({
			store: store as unknown as GraphHostOptions["store"],
			program: {
				accept: async () => {
					submissions++;
					throw new Error("unexpected dispatch");
				},
				query: () => null,
				cancel: () => "unknown",
			},
			resolveProgram: async () => envelope(),
			verifyProgramResult: async () => {
				throw new Error("unexpected result");
			},
		});
		host.start();
		await host.tick();
		expect(current.state).toBe("unknown");
		expect(submissions).toBe(0);
	});

	it.each(["subgraph", "missing"] as const)("does not route a %s frozen node to a resolver", async kind => {
		const current = intent();
		let humanCalls = 0;
		let programCalls = 0;
		let questionCalls = 0;
		const store = {
			claimHost: () => ({ owner_id: "owner", epoch: "1" }),
			assertHostOwner: () => {},
			getRun: () => ({ id: "run", state: "running" }),
			listHostRuns: () => [{ id: "run", state: "running" }],
			listHostIntents: () => [],
			getScheduleState: () => ({ invocations: [{ id: "invocation", node: "child" }] }),
			getFrozenDefinition: () => ({ nodes: kind === "subgraph" ? { child: { kind: "subgraph" } } : {} }),
			schedule: () => ({ intent: current }),
			claimDispatch: () => ({ ...current, state: "submitting" }),
			observeDispatch: (_owner: string, _epoch: string, _id: string, state: GraphDispatchIntent["state"]) => {
				current.state = state;
				return true;
			},
			completeAttempt: () => false,
			createHumanQuestion: () => {
				questionCalls++;
			},
		};
		const host = new GraphHost({
			store: store as unknown as GraphHostOptions["store"],
			program: {
				accept: async () => {
					programCalls++;
					throw new Error("unexpected");
				},
				query: () => null,
				cancel: () => "unknown",
			},
			resolveHuman: async () => {
				humanCalls++;
				return { principal: "user", questionRef: { id: "q", digest: "d" } };
			},
			resolveProgram: async () => envelope(),
			verifyProgramResult: async () => {
				throw new Error("unexpected");
			},
		});
		host.start();
		await host.tick();
		expect(current.state).toBe("unknown");
		expect(humanCalls).toBe(0);
		expect(questionCalls).toBe(0);
		expect(programCalls).toBe(0);
	});

	it("stops dispatch and records active program uncertainty on shutdown", async () => {
		const f = fixture();
		f.host.start();
		await f.host.tick();
		await f.host.shutdown();
		expect(f.intents[0].state).toBe("unknown");
		expect(() => f.host.tick()).toThrow("stopping");
		expect(f.host.start()).toBe(false);
		await f.host.shutdown();
		expect(f.submissions()).toBe(1);
	});

	it("serializes wakeups and commits completion only after a verified program result", async () => {
		const f = fixture();
		expect(f.host.start()).toBe(true);
		await Promise.all([f.host.tick(), f.host.tick()]);
		expect(f.submissions()).toBe(1);
		expect(f.intents[0].state).toBe("accepted");
		expect(f.completions()).toBe(0);
		f.setResult({
			attempt_id: "attempt",
			fence: "1",
			state: "succeeded",
			outcome: "done",
			verdict: null,
			outputs: {},
			error: null,
			usage: { tokens: null, cost: null, currency: null },
		});
		await f.host.tick();
		expect(f.completions()).toBe(1);
		expect(f.intents[0].state).toBe("finished");
	});

	it("records a confirmed rejection as failed rather than uncertain work", async () => {
		const f = fixture([], true);
		f.host.start();
		await f.host.tick();
		expect(f.submissions()).toBe(1);
		expect(f.completions()).toBe(1);
		expect(f.intents[0].state).toBe("finished");
	});

	it("holds previously submitted work instead of replaying it after owner restart", async () => {
		const old = { ...intent(), fence: "0", state: "submitting" as const };
		const f = fixture([old]);
		f.host.start();
		await f.host.tick();
		expect(f.intents[0].state).toBe("unknown");
		expect(f.submissions()).toBe(0);
	});

	it("holds an execution whose observed identity does not match", async () => {
		const f = fixture();
		f.host.start();
		await f.host.tick();
		f.setResult({
			attempt_id: "other",
			fence: "1",
			state: "succeeded",
			outcome: "done",
			verdict: null,
			outputs: {},
			error: null,
			usage: { tokens: null, cost: null, currency: null },
		});
		await f.host.tick();
		expect(f.intents[0].state).toBe("unknown");
		expect(f.completions()).toBe(0);
	});
});

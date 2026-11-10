import { expect, it } from "bun:test";
import { runDailyCodeWorkflow, type DailyAdapters, type DailyInput } from "../src/bots/daily-code-workflow";

const input: DailyInput = {
	task: "implement",
	facts: "known facts",
	userWords: "original request",
	workspace: "/workspace",
	coder: { model: "terra", thinking: "low" },
	reviewer: { model: "sol", thinking: "high" },
	checks: ["test", "typecheck"],
	maxRounds: 3,
};

it("returns failed acceptance to coding, then reviews and checks again", async () => {
	const calls: string[] = [];
	let attempt = 0;
	const adapters: DailyAdapters = {
		code: async (_input, feedback) => {
			calls.push(`code:${feedback ? "feedback" : "initial"}`);
			return "implemented";
		},
		review: async () => {
			calls.push("review");
			return { status: "ready", report: "reviewed" };
		},
		check: async check => {
			calls.push(check);
			return {
				check,
				command: `fixed ${check}`,
				exitCode: check === "test" && attempt++ === 0 ? 1 : 0,
				output: "observed",
			};
		},
	};
	const result = await runDailyCodeWorkflow(input, adapters);
	expect(result.status).toBe("passed");
	expect(calls).toEqual(["code:initial", "review", "test", "code:feedback", "review", "test", "typecheck"]);
	expect(result.rounds[0].evidence[0].exitCode).toBe(1);
});

it("never treats unknown execution as success or automatically retries it", async () => {
	let calls = 0;
	const result = await runDailyCodeWorkflow(input, {
		code: async () => "implemented",
		review: async () => ({ status: "ready", report: "reviewed" }),
		check: async check => {
			calls++;
			return { check, command: "fixed command", exitCode: null, output: "lost" };
		},
	});
	expect(result.status).toBe("blocked");
	expect(calls).toBe(1);
});

it("honors a review rework and stops at the round limit", async () => {
	let checks = 0;
	const result = await runDailyCodeWorkflow(
		{ ...input, maxRounds: 2 },
		{
			code: async () => "implemented",
			review: async () => ({ status: "rework", report: "fix it" }),
			check: async check => {
				checks++;
				return { check, command: "fixed", exitCode: 0, output: "" };
			},
		},
	);
	expect(result.status).toBe("blocked");
	expect(result.rounds).toHaveLength(2);
	expect(checks).toBe(0);
});

it("blocks a negative process result instead of retrying an unknown execution", async () => {
	let codes = 0;
	const result = await runDailyCodeWorkflow(input, {
		code: async () => {
			codes++;
			return "implemented";
		},
		review: async () => ({ status: "ready", report: "reviewed" }),
		check: async check => ({ check, command: "fixed", exitCode: -1, output: "terminated" }),
	});
	expect(result.status).toBe("blocked");
	expect(codes).toBe(1);
});

it("does not dispatch review when completed implementation evidence cannot be persisted", async () => {
	let reviews = 0;
	const result = await runDailyCodeWorkflow(input, {
		code: async () => "implemented",
		review: async () => {
			reviews++;
			return { status: "ready", report: "reviewed" };
		},
		check: async () => {
			throw new Error("must not execute");
		},
		checkpoint: async () => {
			throw new Error("disk full");
		},
	});
	expect(result.status).toBe("blocked");
	expect(result.reason).toContain("disk full");
	expect(result.rounds[0].implementation).toBe("implemented");
	expect(reviews).toBe(0);
});

it("never runs acceptance after an explicit review blocker", async () => {
	const result = await runDailyCodeWorkflow(input, {
		code: async () => "implemented",
		review: async () => ({ status: "blocked", report: "conflicting user changes" }),
		check: async () => {
			throw new Error("must not execute");
		},
	});
	expect(result.reason).toBe("conflicting user changes");
	expect(result.rounds[0].evidence).toEqual([]);
});

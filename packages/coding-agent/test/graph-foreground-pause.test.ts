import { describe, expect, it } from "bun:test";
import { ForegroundPause } from "../src/graph/foreground-pause";

describe("ForegroundPause", () => {
	it("ends only on terminal Run states", () => {
		expect(ForegroundPause.terminal("succeeded")).toBe(true);
		expect(ForegroundPause.terminal("failed")).toBe(true);
		expect(ForegroundPause.terminal("cancelled")).toBe(true);
		// A hold parks the executor; treating it as terminal stranded the in-flight attempt.
		expect(ForegroundPause.terminal("held")).toBe(false);
		expect(ForegroundPause.terminal("running")).toBe(false);
		expect(ForegroundPause.terminal("queued")).toBe(false);
		expect(ForegroundPause.terminal("cancelling")).toBe(false);
	});

	it("settles in-flight attempts while a hold forbids new admission", () => {
		// The regression: the mid-attempt gate demanded `dispatchable`, so a hold that landed
		// while a Bot was working failed the job it had already admitted (`dispatch.unknown`).
		expect(ForegroundPause.settlable("held")).toBe(true);
		expect(ForegroundPause.dispatchable("held")).toBe(false);

		expect(ForegroundPause.settlable("running")).toBe(true);
		expect(ForegroundPause.dispatchable("running")).toBe(true);
		expect(ForegroundPause.settlable("queued")).toBe(true);
		expect(ForegroundPause.dispatchable("queued")).toBe(true);

		// A cancelled Run has already asked its attempts to stop; nothing may settle.
		expect(ForegroundPause.settlable("cancelling")).toBe(false);
		expect(ForegroundPause.dispatchable("cancelling")).toBe(false);
		for (const state of ["succeeded", "failed", "cancelled"] as const) {
			expect(ForegroundPause.settlable(state)).toBe(false);
			expect(ForegroundPause.dispatchable(state)).toBe(false);
		}
		expect(ForegroundPause.settlable(undefined)).toBe(false);
		expect(ForegroundPause.dispatchable(undefined)).toBe(false);
	});

	it("extends the deadline by exactly the held duration", () => {
		const pause = new ForegroundPause(1_000);
		expect(pause.remaining(500)).toBe(500);

		const held = pause.observe("held", 500);
		expect(held).toEqual({ transition: "held", remaining: Number.POSITIVE_INFINITY });
		expect(pause.held).toBe(true);
		// Held time is not execution time, so no budget is consumed while parked.
		expect(pause.remaining(10_000)).toBe(Number.POSITIVE_INFINITY);

		const resumed = pause.observe("running", 3_500);
		expect(resumed.transition).toBe("resumed");
		// 500 ms of budget was left when the hold parked the executor, and parking consumed none.
		expect(resumed.remaining).toBe(500);
		expect(pause.deadline).toBe(4_000);
		expect(pause.held).toBe(false);
	});

	it("reports a single transition across repeated observations", () => {
		const pause = new ForegroundPause(1_000);
		expect(pause.observe("held", 100).transition).toBe("held");
		expect(pause.observe("held", 200)).toEqual({
			transition: null,
			remaining: Number.POSITIVE_INFINITY,
		});
		expect(pause.observe("held", 300).transition).toBe(null);

		expect(pause.observe("running", 600).transition).toBe("resumed");
		expect(pause.observe("running", 700).transition).toBe(null);
	});

	it("never reports negative remaining time", () => {
		const pause = new ForegroundPause(1_000);
		expect(pause.remaining(1_000)).toBe(0);
		expect(pause.remaining(9_999)).toBe(0);

		// A hold that begins after the deadline has passed cannot revive an exhausted budget.
		pause.observe("held", 9_999);
		expect(pause.observe("running", 11_000).remaining).toBe(0);
	});
});

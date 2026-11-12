import { describe, expect, test } from "bun:test";
import { estimateFold, estimateFoldWithPins, keepWindowTurns, priceFactors } from "../src/session/fold-economics";

const factors = (alpha: number, omega: number) => ({ alpha, omega, kappa: 4 });

describe("fold economics", () => {
	test("break-even follows [(1−α+ω)(K+R)+κR] / [α(F−R)]", () => {
		// T=80K, F=28K → K=8K, R=4096, κ=4.
		const input = {
			liveTokens: 36_000,
			foldedTokens: 28_000,
			reportTokens: 4096,
			oneshotSummary: false,
		};
		const quarter = estimateFold({ ...input, factors: factors(0.25, 0.25) });
		const tenth = estimateFold({ ...input, factors: factors(0.1, 0.25) });
		const twentieth = estimateFold({ ...input, factors: factors(0.05, 0.25) });
		expect(quarter.breakEvenTurns).toBeCloseTo(4.77, 1);
		expect(tenth.breakEvenTurns).toBeCloseTo(12.68, 1);
		expect(twentieth.breakEvenTurns).toBeCloseTo(25.85, 1);
		expect(twentieth.retainedTokens).toBe(8_000);
	});

	test("a 1/20 cache needs ~23 turns without a write premium", () => {
		const estimate = estimateFold({
			liveTokens: 36_000,
			foldedTokens: 28_000,
			reportTokens: 4096,
			factors: factors(0.05, 0),
			oneshotSummary: false,
		});
		expect(estimate.breakEvenTurns).toBeCloseTo(23.32, 1);
		expect(estimate.oneTimeCostTokens).toBeCloseTo(0.95 * 12_096 + 4 * 4096, 3);
	});

	test("a oneshot summary pays input on the live context before it can report", () => {
		const local = estimateFold({
			liveTokens: 36_000,
			foldedTokens: 28_000,
			reportTokens: 4096,
			factors: factors(0.05, 0),
			oneshotSummary: false,
		});
		const oneshot = estimateFold({
			liveTokens: 36_000,
			foldedTokens: 28_000,
			reportTokens: 4096,
			factors: factors(0.05, 0),
			oneshotSummary: true,
		});
		expect(oneshot.summaryInputCostTokens).toBeCloseTo(1800, 3);
		expect(oneshot.breakEvenTurns).toBeGreaterThan(local.breakEvenTurns);
	});

	test("pinning inside the folded region makes the fold pay back later", () => {
		const input = {
			liveTokens: 36_000,
			foldedTokens: 28_000,
			reportTokens: 4096,
			factors: factors(0.05, 0.25),
			oneshotSummary: false,
		};
		expect(estimateFoldWithPins(input, 15_000).breakEvenTurns).toBeGreaterThan(estimateFold(input).breakEvenTurns);
	});

	test("worthIt compares the saving against remaining turns", () => {
		const base = {
			liveTokens: 36_000,
			foldedTokens: 28_000,
			reportTokens: 4096,
			factors: factors(0.05, 0),
			oneshotSummary: false,
		};
		expect(estimateFold({ ...base, remainingTurns: 5 }).worthIt).toBe(false);
		expect(estimateFold({ ...base, remainingTurns: 200 }).worthIt).toBe(true);
	});

	test("a model without a cache price must not predict a saving", () => {
		const uncached = priceFactors({ input: 3, output: 9 });
		expect(uncached.alpha).toBe(1);
		expect(uncached.omega).toBe(0);
		expect(uncached.kappa).toBe(3);
		const cached = priceFactors({ input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(cached.alpha).toBeCloseTo(0.1, 6);
		expect(cached.omega).toBeCloseTo(0.25, 6);
		expect(cached.kappa).toBe(3);
	});
});

describe("keep window and re-read odds", () => {
	test("carrying a block for 1/α turns costs one re-read", () => {
		expect(keepWindowTurns(factors(0.1, 0.25))).toBe(10);
		expect(keepWindowTurns(factors(0.05, 0))).toBe(20);
		// No cache: carrying and re-reading cost the same, so the window is one turn.
		expect(keepWindowTurns(factors(1, 0))).toBe(1);
	});

	test("the fold tolerates q* = spare / folded, clamped, only with a turn count", () => {
		const base = { liveTokens: 36_000, foldedTokens: 28_000, reportTokens: 4096, factors: factors(0.1, 0.25) };
		expect(estimateFold({ ...base, remainingTurns: 20 }).maxRereadProbability).toBeCloseTo(0.6255, 3);
		expect(estimateFold({ ...base, remainingTurns: 1 }).maxRereadProbability).toBe(0);
		expect(estimateFold(base).maxRereadProbability).toBeUndefined();
	});
});

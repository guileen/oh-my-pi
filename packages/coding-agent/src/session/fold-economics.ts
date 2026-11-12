/**
 * Fold economics: is it worth rewriting the context?
 *
 * A fold trades a one-time cost (re-cached suffix + report generation) for a
 * per-turn saving (the folded noise stops being re-read). Everything here is in
 * *input-token equivalents*, so α/ω/κ come from the model's price card rather
 * than from usage counters: `usage.cache_read` measures the hit ratio p_t, not
 * the discount α.
 */
/** The price-card slice this module needs; every provider model carries it. */
export interface PriceCard {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface PriceFactors {
	/** Cached input price ÷ input price (1 when the model has no cache). */
	alpha: number;
	/** Cache-write premium over input price (Anthropic 0.25, most others 0). */
	omega: number;
	/** Output price ÷ input price. */
	kappa: number;
}

/**
 * Price-card factors for one model. A missing or zero cache price means the
 * provider does not discount reads, so prediction must assume no saving.
 */
export function priceFactors(cost: PriceCard | undefined): PriceFactors {
	const input = cost?.input && cost.input > 0 ? cost.input : 1;
	const output = cost?.output && cost.output > 0 ? cost.output : 1;
	const cacheRead = cost?.cacheRead && cost.cacheRead > 0 ? cost.cacheRead : undefined;
	const cacheWrite = cost?.cacheWrite && cost.cacheWrite > 0 ? cost.cacheWrite : undefined;
	return {
		alpha: cacheRead ? cacheRead / input : 1,
		omega: cacheWrite ? Math.max(0, cacheWrite / input - 1) : 0,
		kappa: output / input,
	};
}

export interface FoldInputs {
	/** Tokens the next request would carry (retained tail + folded region). */
	liveTokens: number;
	/** Tokens the fold would summarize away. */
	foldedTokens: number;
	/** Tokens the report adds back. */
	reportTokens: number;
	factors: PriceFactors;
	/** A oneshot summary re-reads the live context; a local fold does not. */
	oneshotSummary: boolean;
	/** Turns the session is expected to continue; enables `worthIt`. */
	remainingTurns?: number;
}

export interface FoldEstimate {
	retainedTokens: number;
	foldedTokens: number;
	reportTokens: number;
	factors: PriceFactors;
	/** One-time: re-cached suffix + report generation. */
	oneTimeCostTokens: number;
	/** Per turn: folded noise that stops being re-read, minus the report's own keep. */
	perTurnSavingTokens: number;
	/** Extra input a oneshot summary call pays before it can write the report. */
	summaryInputCostTokens: number;
	/** Infinity when the fold cannot pay for itself. */
	breakEvenTurns: number;
	netBenefitTokens?: number;
	worthIt?: boolean;
	/**
	 * Largest re-read probability the fold still tolerates at `remainingTurns`,
	 * from `αT(N−m) > κm + ωS + qN`: `q* = spare / N`. Clamped to [0, 1];
	 * undefined without a folded region or a remaining-turn count.
	 */
	maxRereadProbability?: number;
}

/**
 * How many turns of carrying one token cost as much as re-reading it once.
 * A block is worth keeping only while it is still needed inside this window:
 * carrying costs `α` per turn, a re-read costs one full input token.
 */
export function keepWindowTurns(factors: PriceFactors): number {
	return factors.alpha > 0 ? 1 / factors.alpha : Number.POSITIVE_INFINITY;
}

/**
 * m* = [(1−α+ω)(K+R) + κR] / [α(F−R)], where K = live − folded.
 * The report is part of the new suffix (it must be cached once) and its
 * generation costs κ per token; it also keeps costing α per turn, hence F−R.
 */
export function estimateFold(input: FoldInputs): FoldEstimate {
	const { alpha, omega, kappa } = input.factors;
	const folded = Math.max(0, input.foldedTokens);
	const retained = Math.max(0, input.liveTokens - folded);
	const report = Math.max(0, input.reportTokens);
	const oneTimeCostTokens = (1 - alpha + omega) * (retained + report) + kappa * report;
	const perTurnSavingTokens = alpha * Math.max(0, folded - report);
	const summaryInputCostTokens = input.oneshotSummary ? alpha * Math.max(0, input.liveTokens) : 0;
	const breakEvenTurns =
		perTurnSavingTokens > 0
			? (oneTimeCostTokens + summaryInputCostTokens) / perTurnSavingTokens
			: Number.POSITIVE_INFINITY;
	const netBenefitTokens =
		input.remainingTurns === undefined
			? undefined
			: perTurnSavingTokens * input.remainingTurns - oneTimeCostTokens - summaryInputCostTokens;
	// The fold is a bet that the folded region is not re-read. This is the odds
	// it can lose at and still come out ahead: a panel can compare it with the
	// observed re-read rate instead of guessing.
	const maxRereadProbability =
		netBenefitTokens === undefined || folded <= 0
			? undefined
			: Math.min(1, Math.max(0, netBenefitTokens / folded));
	return {
		retainedTokens: retained,
		foldedTokens: folded,
		reportTokens: report,
		factors: input.factors,
		oneTimeCostTokens,
		perTurnSavingTokens,
		summaryInputCostTokens,
		breakEvenTurns,
		netBenefitTokens,
		worthIt: netBenefitTokens === undefined ? undefined : netBenefitTokens > 0,
		maxRereadProbability,
	};
}

/**
 * Pinning `pinnedTokens` inside the folded region moves the cut earlier: it
 * shrinks the saving and grows the suffix that must be re-cached. Returns the
 * estimate for the pinned variant, so panels can show what a pin costs.
 */
export function estimateFoldWithPins(input: FoldInputs, pinnedTokens: number): FoldEstimate {
	return estimateFold({ ...input, foldedTokens: Math.max(0, input.foldedTokens - pinnedTokens) });
}

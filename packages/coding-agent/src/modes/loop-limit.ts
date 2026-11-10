import { readShellWord } from "../tools/shell-tokenize";
import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";

export type LoopLimitConfig =
	| {
			kind: "iterations";
			iterations: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
	  };

const TIME_UNITS_MS = new Map<string, number>([
	["s", 1_000],
	["sec", 1_000],
	["secs", 1_000],
	["second", 1_000],
	["seconds", 1_000],
	["m", 60_000],
	["min", 60_000],
	["mins", 60_000],
	["minute", 60_000],
	["minutes", 60_000],
	["h", 3_600_000],
	["hr", 3_600_000],
	["hrs", 3_600_000],
	["hour", 3_600_000],
	["hours", 3_600_000],
]);

const LOOP_USAGE =
	"Usage: /loop [count|duration] [interval] [--count N] [--duration TIME] [--interval TIME] [--while|--until '<command>'] [prompt]. Examples: /loop 100 5m, /loop 6h 5m, /loop --count 20 --until 'bun test' fix the failing tests.";

/**
 * Flag → `until` polarity. `--while` continues while the command succeeds;
 * `--until` continues while it fails.
 */
const CONDITION_FLAGS: Record<string, boolean | undefined> = {
	"--while": false,
	"--until": true,
};

export interface ParsedLoopArgs {
	/** Positional budget or explicit total-count budget. */
	limit?: LoopLimitConfig;
	/** Duration budget when an iteration budget also occupies `limit`. */
	durationLimit?: LoopLimitConfig;
	/** Delay between turns, independent of the budgets. */
	intervalMs?: number;
	/** Continue-condition from `--while` / `--until`, re-evaluated before each iteration. */
	condition?: LoopConditionConfig;
	/** Inline loop prompt: text after the limit and flags, or the whole argument when neither was given. */
	prompt?: string;
}

/**
 * Parse an optional positional limit and interval, leading flags, and prompt.
 * A positional count followed by an interval counts the first turn; a lone
 * positional count retains its legacy meaning of subsequent repeats.
 */
export function parseLoopArgs(args: string): ParsedLoopArgs | string {
	const trimmed = args.trim();
	if (!trimmed) return {};

	let rest = trimmed;
	let positional: LoopLimitConfig | undefined;
	let count: LoopLimitConfig | undefined;
	let duration: LoopLimitConfig | undefined;
	let intervalMs: number | undefined;
	let condition: LoopConditionConfig | undefined;

	while (rest) {
		if (!rest.startsWith("--")) {
			if (positional) break;
			const result = takeLoopLimit(rest);
			if (typeof result === "string") return result;
			if (!result.limit) break;
			positional = result.limit;
			rest = result.rest;
			// A duration immediately after the positional bound is the interval.
			// Do not consume numeric prose without a duration unit.
			if (/^\d+[a-z]/i.test(rest) || /^\d+\s+(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)(?:\s|$)/i.test(rest)) {
				const next = takeLoopLimit(rest);
				if (typeof next === "string") return next;
				if (next.limit?.kind !== "duration" || !Number.isSafeInteger(next.limit.durationMs)) return "Loop interval must be a positive duration.";
				if (intervalMs !== undefined) return "Use --interval only once.";
				intervalMs = next.limit.durationMs;
				if (positional.kind === "iterations") positional = { kind: "iterations", iterations: positional.iterations - 1 };
				rest = next.rest;
			}
			continue;
		}

		const name = /^(--[a-z][a-z-]*)(?=[\s=]|$)/.exec(rest)?.[1];
		const until = name === undefined ? undefined : CONDITION_FLAGS[name];
		if (!name || (until === undefined && !["--count", "--duration", "--interval"].includes(name))) {
			return `Unknown /loop flag ${name ?? rest.split(/\s+/, 1)[0]}. ${LOOP_USAGE}`;
		}
		const valueText = rest.slice(name.length);
		const input = valueText.startsWith("=") ? valueText.slice(1) : valueText;
		const value = readShellWord(input);
		if (value === "unterminated") return `${name} has an unterminated quote.`;
		if (until !== undefined) {
			if (condition) return "Use only one of --while or --until.";
			if (value === undefined || !value.value.trim() || input.trim().startsWith("-")) {
				return `${name} needs a shell command. Quote it when it contains spaces: /loop ${name} 'bun test'.`;
			}
			condition = { command: value.value.trim(), until };
			rest = value.rest;
			continue;
		}
		if (value === undefined || !value.value.trim() || input.trim().startsWith("-")) {
			return `${name} needs a positive ${name === "--count" ? "integer" : "duration"}.`;
		}
		if (name === "--count") {
			if (count) return "Use --count only once.";
			if (!/^\d+$/.test(value.value)) return "Loop count must be a positive integer.";
			const parsed = makeIterations(value.value);
			if (typeof parsed === "string") return parsed;
			count = { kind: "iterations", iterations: parsed.iterations - 1 };
			rest = value.rest;
			continue;
		}
		if (name === "--duration" && duration) return "Use --duration only once.";
		if (name === "--interval" && intervalMs !== undefined) return "Use --interval only once.";
		// Accept both compact and space-separated units, including quoted values.
		let durationText = value.value.trim();
		rest = value.rest;
		if (/^\d+$/.test(durationText)) {
			const unit = /^\S+/.exec(rest)?.[0];
			if (unit && TIME_UNITS_MS.has(unit.toLowerCase())) {
				durationText += ` ${unit}`;
				rest = rest.slice(unit.length).trim();
			}
		}
		const parsed = takeLoopLimit(durationText);
		if (typeof parsed === "string") return parsed;
		if (parsed.limit?.kind !== "duration" || parsed.rest || !Number.isSafeInteger(parsed.limit.durationMs)) {
			return `${name} needs a positive duration.`;
		}
		if (name === "--duration") duration = parsed.limit;
		else intervalMs = parsed.limit.durationMs;
	}

	if (positional?.kind === "iterations" && count) return "A positional count cannot be combined with --count.";
	if (positional?.kind === "duration" && duration) return "A positional duration cannot be combined with --duration.";
	const iterationLimit = positional?.kind === "iterations" ? positional : count;
	const timeLimit = positional?.kind === "duration" ? positional : duration;
	return {
		limit: iterationLimit ?? timeLimit,
		durationLimit: iterationLimit ? timeLimit : undefined,
		intervalMs,
		condition,
		prompt: rest || undefined,
	};
}

/** Split an optional leading limit token off the argument string. */
function takeLoopLimit(input: string): { limit?: LoopLimitConfig; rest: string } | string {
	const firstSpace = input.search(/\s/);
	const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
	const token = firstToken.toLowerCase();

	// Not a limit attempt (prose like "keep going", or a leading condition flag).
	if (!/^[+-]?\d/.test(token)) return { rest: input };

	// Bare integer: iteration count, unless the next token is a time unit ("10 minutes").
	if (/^\d+$/.test(token)) {
		if (rest) {
			const unitToken = /^\S+/.exec(rest)?.[0] ?? "";
			const unitMs = TIME_UNITS_MS.get(unitToken.toLowerCase());
			if (unitMs !== undefined) {
				const limit = makeDuration(token, unitMs);
				if (typeof limit === "string") return limit;
				return { limit, rest: rest.slice(unitToken.length).trim() };
			}
		}
		const limit = makeIterations(token);
		if (typeof limit === "string") return limit;
		return { limit, rest };
	}

	// Compact / compound duration: "10m", "90s", "1h30m".
	const duration = parseCompoundDuration(token);
	if (duration !== undefined) {
		if (typeof duration === "string") return duration;
		return { limit: duration, rest };
	}

	// Limit-shaped but unparseable ("-1", "1.5h", "10x10").
	return LOOP_USAGE;
}

function makeIterations(amountText: string): Extract<LoopLimitConfig, { kind: "iterations" }> | string {
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		return "Loop count must be a positive integer.";
	}
	return { kind: "iterations", iterations: amount };
}

function makeDuration(amountText: string, unitMs: number): LoopLimitConfig | string {
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		return "Loop duration must be positive.";
	}
	const durationMs = amount * unitMs;
	if (!Number.isSafeInteger(durationMs)) return "Loop duration is too large.";
	return { kind: "duration", durationMs };
}

/**
 * Parse a compact duration token such as `10m`, or a compound one like `1h30m`.
 * Returns `undefined` when the token is not duration-shaped, or an error string
 * when it is shaped like a duration but uses an unknown unit / non-positive
 * amount.
 */
function parseCompoundDuration(token: string): LoopLimitConfig | string | undefined {
	if (!/^(?:\d+[a-z]+)+$/.test(token)) return undefined;
	const segments = token.match(/\d+[a-z]+/g);
	if (!segments) return undefined;
	let totalMs = 0;
	for (const segment of segments) {
		const match = /^(\d+)([a-z]+)$/.exec(segment);
		if (!match) return LOOP_USAGE;
		const unitMs = TIME_UNITS_MS.get(match[2]);
		if (unitMs === undefined) {
			return "Loop duration unit must be seconds, minutes, or hours.";
		}
		const amount = Number(match[1]);
		if (!Number.isSafeInteger(amount) || amount <= 0) {
			return "Loop duration must be positive.";
		}
		totalMs += amount * unitMs;
		if (!Number.isSafeInteger(totalMs)) return "Loop duration is too large.";
	}
	if (totalMs <= 0) return "Loop duration must be positive.";
	return { kind: "duration", durationMs: totalMs };
}

export function createLoopLimitRuntime(
	config: LoopLimitConfig | undefined,
	nowMs = Date.now(),
): LoopLimitRuntime | undefined {
	if (!config) return undefined;
	if (config.kind === "iterations") {
		return { kind: "iterations", initial: config.iterations, remaining: config.iterations };
	}
	return { kind: "duration", durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs };
}

export function consumeLoopLimitIteration(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	if (!limit) return true;
	if (limit.kind === "duration") {
		return nowMs < limit.deadlineMs;
	}
	if (limit.remaining <= 0) return false;
	limit.remaining -= 1;
	return true;
}

export function isLoopDurationExpired(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	return limit?.kind === "duration" && nowMs >= limit.deadlineMs;
}

/**
 * True when the loop's budget is already spent: a duration past its deadline,
 * or an iteration count with none remaining. Unlike {@link consumeLoopLimitIteration}
 * this never mutates the runtime, so callers can check it before deciding
 * whether to run anything (e.g. a `/loop --while`/`--until` condition command)
 * that would otherwise run once more for a loop that is already over.
 */
export function isLoopLimitExhausted(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	if (!limit) return false;
	if (limit.kind === "duration") return nowMs >= limit.deadlineMs;
	return limit.remaining <= 0;
}

export function describeLoopLimit(config: LoopLimitConfig): string {
	if (config.kind === "iterations") {
		return `${config.iterations} ${config.iterations === 1 ? "repeat" : "repeats"} after the first turn`;
	}
	return formatLoopBudget(config.durationMs);
}

export function describeLoopLimitRuntime(limit: LoopLimitRuntime): string {
	if (limit.kind === "iterations") {
		return `${limit.remaining} of ${limit.initial} ${limit.initial === 1 ? "repeat" : "repeats"} remaining`;
	}
	return `${formatLoopBudget(limit.durationMs)} limit`;
}

// Budget descriptions retain full precision in one spelled-out unit, unlike compact elapsed times.
function formatLoopBudget(durationMs: number): string {
	if (durationMs % 3_600_000 === 0) {
		const hours = durationMs / 3_600_000;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	if (durationMs % 60_000 === 0) {
		const minutes = durationMs / 60_000;
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	const seconds = durationMs / 1_000;
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

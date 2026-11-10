/** Host-driven daily coding loop. Adapters must enforce their own capabilities and isolation. */
export type DailyModel = "terra" | "luna" | "sol" | "astra";
export type DailyThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type DailyCheck = "test" | "typecheck" | "check";

export interface DailyInput {
	task: string;
	facts: string;
	userWords: string;
	workspace: string;
	coder: { model: "terra" | "luna" | "sol"; thinking: DailyThinking };
	reviewer: { model: "sol" | "astra"; thinking: DailyThinking };
	checks: DailyCheck[];
	maxRounds: number;
}

export interface DailyEvidence {
	check: DailyCheck;
	command: string;
	exitCode: number | null;
	output: string;
}

export interface DailyAdapters {
	/** A fresh role invocation with read/write only, no command execution. */
	code(input: DailyInput, feedback: string | null): Promise<string>;
	/** A fresh role invocation with read/write only. Review and directly fix findings. */
	review(
		input: DailyInput,
		implementation: string,
	): Promise<{ status: "ready" | "rework" | "blocked"; report: string }>;
	/** Execute the host's fixed mapping for this check, never a model-provided command. */
	check(check: DailyCheck): Promise<DailyEvidence>;
	/** Persist completed transitions; a persistence failure blocks further work. */
	checkpoint?(rounds: DailyRound[]): Promise<void>;
}

export interface DailyRound {
	implementation?: string;
	review?: { status: "ready" | "rework" | "blocked"; report: string };
	evidence: DailyEvidence[];
}

export interface DailyResult {
	status: "passed" | "blocked";
	reason: string;
	rounds: DailyRound[];
}

export function validateDailyInput(input: DailyInput): void {
	if (!input.task.trim() || !input.facts.trim() || !input.userWords.trim())
		throw new Error("task, facts and userWords are required");
	if (typeof input.workspace !== "string" || !input.workspace.trim()) throw new Error("workspace is required");
	if (!["terra", "luna", "sol"].includes(input.coder.model) || !["sol", "astra"].includes(input.reviewer.model))
		throw new Error("unsupported model");
	const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (!thinking.includes(input.coder.thinking) || !thinking.includes(input.reviewer.thinking))
		throw new Error("unsupported thinking level");
	if (!Number.isSafeInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 64)
		throw new Error("maxRounds must be between 1 and 64");
	if (
		!input.checks.length ||
		new Set(input.checks).size !== input.checks.length ||
		input.checks.some(check => !["test", "typecheck", "check"].includes(check))
	)
		throw new Error("choose at least one distinct supported check");
}

/** No retry of an interrupted/unknown invocation: return the evidence available so far. */
export async function runDailyCodeWorkflow(input: DailyInput, adapters: DailyAdapters): Promise<DailyResult> {
	validateDailyInput(input);

	const rounds: DailyRound[] = [];
	let feedback: string | null = null;
	for (let index = 0; index < input.maxRounds; index++) {
		const round: DailyRound = { evidence: [] };
		rounds.push(round);
		try {
			round.implementation = await adapters.code(input, feedback);
			await adapters.checkpoint?.(rounds);
			if (!round.implementation.trim()) return { status: "blocked", reason: "Empty implementation report", rounds };
			round.review = await adapters.review(input, round.implementation);
			await adapters.checkpoint?.(rounds);
			if (
				!round.review ||
				!["ready", "rework", "blocked"].includes(round.review.status) ||
				!round.review.report?.trim()
			)
				return { status: "blocked", reason: "Invalid review report", rounds };
			if (round.review.status === "blocked") return { status: "blocked", reason: round.review.report, rounds };
			if (round.review.status === "rework") {
				feedback = `Review requires rework:\n${round.review.report}`;
				continue;
			}
			for (const check of input.checks) {
				const evidence = await adapters.check(check);
				if (
					!evidence ||
					evidence.check !== check ||
					!evidence.command?.trim() ||
					typeof evidence.output !== "string" ||
					(evidence.exitCode !== null && (!Number.isSafeInteger(evidence.exitCode) || evidence.exitCode < 0))
				)
					return { status: "blocked", reason: `Invalid evidence for ${check}`, rounds };
				round.evidence.push(evidence);
				await adapters.checkpoint?.(rounds);
				if (evidence.exitCode === null)
					return { status: "blocked", reason: `Unknown outcome for ${check}`, rounds };
				if (evidence.exitCode !== 0) break;
			}
			if (round.evidence.length === input.checks.length && round.evidence.every(item => item.exitCode === 0))
				return { status: "passed", reason: "All selected checks passed", rounds };
			feedback = `Acceptance failed; fix the cause and report changes:\n${JSON.stringify(round.evidence)}`;
		} catch (error) {
			return {
				status: "blocked",
				reason: `Invocation failed or outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
				rounds,
			};
		}
	}
	return { status: "blocked", reason: "Round limit reached before acceptance", rounds };
}

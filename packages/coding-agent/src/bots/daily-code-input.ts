import { type DailyInput, type DailyModel, type DailyThinking, validateDailyInput } from "./daily-code-workflow";

export interface DailyBinding {
	provider: string;
	model: string;
}
export interface DailyExecutionInput extends DailyInput {
	bindings: Partial<Record<DailyModel, DailyBinding>>;
	read: string[];
	write: string[];
	timeoutMs: number;
}

/** Discovery is data only: neither listing nor reading this grants execution authority. */
export const DAILY_CODE_WORKFLOW = {
	id: "daily-code",
	kind: "bot-host-workflow",
	version: 1,
	summary: "Headless coding, independent direct-fix review, restricted acceptance, and bounded rework",
	discover: ["omp", "bot", "workflows", "--json"],
	command: [
		"omp",
		"bot",
		"daily-code",
		"--input",
		"FILE",
		"--request-key",
		"KEY",
		"--accept-workspace-code",
		"--json",
	],
	inputs: {
		task: "required nonempty text",
		facts: "required nonempty text",
		userWords: "required verbatim user text",
		workspace: "required absolute existing directory",
		coder: "optional {model: terra|luna|sol, thinking: off|minimal|low|medium|high|xhigh|max}; default terra/low",
		reviewer: "optional {model: sol|astra, thinking: off|minimal|low|medium|high|xhigh|max}; default sol/high",
		bindings: "required alias -> {provider, model}, exact authenticated model identities for both roles",
		read: "optional workspace-relative grant patterns; default [**]",
		write: "required nonempty workspace-relative grant patterns",
		checks: "required distinct test|typecheck|check; fixed host commands, never model commands",
		maxRounds: "optional integer 1..64; default 3",
		timeoutMs: "optional integer 1000..86400000; default 1800000",
	},
	outputs: [
		"status: passed|blocked",
		"reason",
		"rounds with implementation, review and command evidence",
		"journal path",
	],
	exit_codes: { passed: 0, blocked: 4, invalid_input: 1 },
	permissions: {
		model: ["read", "grep", "glob", "write", "edit"],
		acceptance: ["bun test", "bun run check:types", "bun run check"],
	},
	graph: { supported: false, reason: "The bounded loop is owned by the Bot host, not the Graph DAG executor" },
	recovery: "Same key replays a terminal report only; an unfinished invocation blocks without replaying side effects",
} as const;

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error(`${label} contains unknown fields`);
	return result;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`);
	return value;
}
function patterns(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a nonempty array`);
	return value.map(item => text(item, label));
}
function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
	const result = value === undefined ? fallback : value;
	if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max)
		throw new Error(`${label} must be an integer between ${min} and ${max}`);
	return result;
}
function role(
	value: unknown,
	fallback: { model: string; thinking: string },
): { model: string; thinking: DailyThinking } {
	const raw = value === undefined ? fallback : object(value, ["model", "thinking"], "role");
	const thinking = text(raw.thinking === undefined ? fallback.thinking : raw.thinking, "thinking");
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))
		throw new Error("Unsupported thinking level");
	return {
		model: text(raw.model === undefined ? fallback.model : raw.model, "model"),
		thinking: thinking as DailyThinking,
	};
}

export function parseDailyExecutionInput(value: unknown): DailyExecutionInput {
	const raw = object(
		value,
		[
			"task",
			"facts",
			"userWords",
			"workspace",
			"coder",
			"reviewer",
			"bindings",
			"read",
			"write",
			"checks",
			"maxRounds",
			"timeoutMs",
		],
		"input",
	);
	const coder = role(raw.coder, { model: "terra", thinking: "low" });
	const reviewer = role(raw.reviewer, { model: "sol", thinking: "high" });
	if (!["terra", "luna", "sol"].includes(coder.model) || !["sol", "astra"].includes(reviewer.model))
		throw new Error("Unsupported role model alias");
	const bindings: Partial<Record<DailyModel, DailyBinding>> = {};
	for (const [alias, value] of Object.entries(object(raw.bindings, ["terra", "luna", "sol", "astra"], "bindings"))) {
		const binding = object(value, ["provider", "model"], `binding ${alias}`);
		bindings[alias as DailyModel] = {
			provider: text(binding.provider, "provider"),
			model: text(binding.model, "model"),
		};
	}
	const checks = patterns(raw.checks, "checks");
	if (checks.some(check => !["test", "typecheck", "check"].includes(check))) throw new Error("Unsupported check");
	const input: DailyExecutionInput = {
		task: text(raw.task, "task"),
		facts: text(raw.facts, "facts"),
		userWords: text(raw.userWords, "userWords"),
		workspace: text(raw.workspace, "workspace"),
		coder: coder as DailyInput["coder"],
		reviewer: reviewer as DailyInput["reviewer"],
		bindings,
		read: patterns(raw.read === undefined ? ["**"] : raw.read, "read"),
		write: patterns(raw.write, "write"),
		checks: checks as DailyInput["checks"],
		maxRounds: integer(raw.maxRounds, 3, 1, 64, "maxRounds"),
		timeoutMs: integer(raw.timeoutMs, 1_800_000, 1000, 86_400_000, "timeoutMs"),
	};
	validateDailyInput(input);
	for (const alias of [input.coder.model, input.reviewer.model]) {
		if (!bindings[alias]) throw new Error(`Missing exact model binding: ${alias}`);
	}
	return input;
}

export function parseDailyReview(content: string): { status: "ready" | "rework" | "blocked"; report: string } {
	const raw = object(JSON.parse(content), ["status", "report"], "review report");
	if (raw.status !== "ready" && raw.status !== "rework" && raw.status !== "blocked")
		throw new Error("Invalid review status");
	return { status: raw.status, report: text(raw.report, "report") };
}

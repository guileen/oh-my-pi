import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { prompt, toError } from "@oh-my-pi/pi-utils";
import checkpointDescription from "../prompts/tools/checkpoint.md" with { type: "text" };
import rewindDescription from "../prompts/tools/rewind.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { estimateFold, keepWindowTurns, type PriceCard, priceFactors } from "../session/fold-economics";
import { annotateSearchResult, type SearchRewindInput } from "../session/search-rewind";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import type { WorkPackageOutcome, WorkPackageTodoBinding } from "./todo";

export interface CheckpointState {
	/** Number of in-memory messages at checkpoint (AFTER checkpoint tool result is appended) */
	checkpointMessageCount: number;
	/** Session entry ID at checkpoint (for session tree branching) */
	checkpointEntryId: string | null;
	/** Timestamp */
	startedAt: string;
	/** Opaque work-package identifier; absent only in older journals. */
	checkpointId?: string;
	goal?: string;
	finishWhen?: string;
	carryForward?: string;
	parent?: CheckpointState;
	todoBinding?: WorkPackageTodoBinding;
}

export interface CompletedRewindState {
	/** Report retained after a successful rewind. */
	report: string;
	/** Timestamp for the checkpoint that was rewound. */
	startedAt: string;
	/** Timestamp when the rewind completed. */
	rewoundAt: string;
	checkpointId?: string;
	nextAction?: string;
	parent?: CheckpointState;
	contextChanged?: boolean;
	outcome?: WorkPackageOutcome;
}

const checkpointSchema = type({
	goal: type("string").describe("bounded work package; keep the overall task and plan before this checkpoint"),
	finishWhen: type("string").describe("future observable completion condition, specified BEFORE doing this work"),
	carryForward: type("string").describe(
		"future handoff checklist: questions or evidence categories to fill AFTER working; not findings to gather before checkpoint",
	),
	"todo?": type({ "phase?": "string", "task?": "string" })
		.or("false")
		.describe("exact task, phase-only parent, or false for an unbound package; omitted binds the active todo"),
});

type CheckpointParams = typeof checkpointSchema.infer;

const rewindSchema = type({
	"checkpointId?": type("string").describe("work-package checkpoint; mutually exclusive with observationId"),
	"observationId?": type("string").describe("completed tool observation to retire; no checkpoint needed"),
	"note?": type("string").describe(
		"brief decision: replaces report on an instruction point, or a scoped exclusion on an observation",
	),
	"keep?": type({ observationId: "string", "text?": "string", "images?": "number[]" })
		.array()
		.describe("exact delivered text substring and/or zero-based image indexes to retain"),
	"read?": type("string")
		.array()
		.describe("read these paths with inline selectors in this same call; nextAction follows the reads"),
	"report?": type("string").describe("work-package facts/evidence; not needed for a small observation"),
	"outcome?": type('"completed" | "blocked" | "in_progress"').describe(
		"explicit work result for the bound todo; does not apply to small observations",
	),
	"reason?": type("string").describe("required blocker reason when outcome is blocked"),
	"retain?": type({ readId: "string", path: "string", from: "number", to: "number" })
		.array()
		.describe("exact displayed source ranges to carry verbatim from read snapshots"),
	"release?": type("string").array().describe("active material references to remove"),
	"demote?": type({ ref: "string", note: "string" })
		.array()
		.describe("replace retained source with a concise fact and its location"),
	"nextAction?": type("string").describe(
		"one concrete continuation, e.g. Located the entry point; follow its caller; omit on an instruction fold that ends the turn",
	),
});

type RewindParams = typeof rewindSchema.infer;

export interface CheckpointToolDetails {
	goal: string;
	startedAt: string;
	checkpointId: string;
	finishWhen: string;
	carryForward: string;
	parent?: CheckpointState;
	todoBinding?: WorkPackageTodoBinding;
	meta?: OutputMeta;
}

export interface RewindContextEstimate {
	beforeTokens: number;
	afterTokens: number;
	/** Unchanged prefix eligible for caching, not an observed cache hit. */
	reusablePrefixTokens: number;
	/** False records the outcome without replacing context when no reduction is possible. */
	willCompact?: boolean;
}

interface RewindSourceRead {
	call: ToolCall;
	result: ToolResultMessage;
}

export interface RewindToolDetails {
	report: string;
	rewound: boolean;
	checkpointId?: string;
	nextAction?: string;
	estimate?: RewindContextEstimate;
	search?: SearchRewindInput;
	instructionAnchor?: boolean;
	sourceReads?: RewindSourceRead[];
	outcome?: WorkPackageOutcome;
	reason?: string;
	meta?: OutputMeta;
}

export class CheckpointTool implements AgentTool<typeof checkpointSchema, CheckpointToolDetails> {
	readonly name = "checkpoint";
	readonly approval = "read" as const;
	readonly label = "Checkpoint";
	readonly summary = "Plan a bounded work package before research or implementation";
	readonly description: string;
	readonly parameters = checkpointSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = (args: Partial<CheckpointParams>) => (args.goal ? `checkpointing: ${args.goal}` : "checkpointing");

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(checkpointDescription);
	}

	static createIf(session: ToolSession): CheckpointTool | null {
		return new CheckpointTool(session);
	}

	async execute(
		toolCallId: string,
		params: CheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CheckpointToolDetails>> {
		const parent = this.session.getCheckpointState?.();
		let depth = 0;
		for (let scope = parent; scope; scope = scope.parent) depth++;
		if (depth >= 32) throw new ToolError("At most 32 nested work packages may be active.");
		const todoBinding = params.todo === false ? undefined : this.session.bindCheckpointTodo?.(params.todo);
		if (params.todo && !this.session.bindCheckpointTodo) throw new ToolError("Todo binding requires a live session.");
		for (let scope = parent; scope; scope = scope.parent) {
			if (
				scope.todoBinding &&
				todoBinding &&
				scope.todoBinding.phase === todoBinding.phase &&
				scope.todoBinding.task === todoBinding.task
			) {
				throw new ToolError(
					"This todo already has an active package; use a small observation rewind or bind a distinct child task.",
				);
			}
		}
		if (![params.goal, params.finishWhen, params.carryForward].every(value => value.trim().length > 0)) {
			throw new ToolError("goal, finishWhen and carryForward must be nonempty.");
		}
		const startedAt = new Date().toISOString();
		return toolResult<CheckpointToolDetails>({
			goal: params.goal.trim(),
			finishWhen: params.finishWhen.trim(),
			carryForward: params.carryForward.trim(),
			checkpointId: toolCallId,
			startedAt,
			parent,
			todoBinding,
		})
			.text(`Checkpoint ${toolCallId}: ${params.goal.trim()}`)
			.done();
	}
}

export class RewindTool implements AgentTool<typeof rewindSchema, RewindToolDetails> {
	readonly name = "rewind";
	readonly approval = "read" as const;
	readonly label = "Rewind";
	readonly summary = "Clear a decided observation or close a work package, then continue";
	readonly description: string;
	readonly parameters = rewindSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = (): string => "rewinding";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(rewindDescription);
	}

	static createIf(session: ToolSession): RewindTool | null {
		return new RewindTool(session);
	}

	async execute(
		toolCallId: string,
		params: RewindParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RewindToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<RewindToolDetails>> {
		// Callers may serialize unused optionals as `null`; treat them as absent so
		// every presence check below behaves as if the field were omitted.
		for (const [key, value] of Object.entries(params)) {
			if (value === null) delete (params as Record<string, unknown>)[key];
		}
		if (params.observationId !== undefined) {
			if (
				params.checkpointId !== undefined ||
				params.report !== undefined ||
				params.outcome !== undefined ||
				params.reason !== undefined
			) {
				throw new ToolError("Choose either an observation decision or a work-package handoff, not both.");
			}
			if (!this.session.validateSearchRewind) throw new ToolError("Observation rewind requires a live session.");
			const search: SearchRewindInput = {
				observationId: params.observationId,
				note: params.note,
				keep: params.keep,
				retain: params.retain,
				release: params.release,
				demote: params.demote,
				// Observation folds still require an action at runtime; validateSearchRewind rejects empty.
				nextAction: params.nextAction?.trim() ?? "",
			};
			if (
				params.read &&
				(params.read.length < 1 || params.read.length > 32 || params.read.some(path => !path.trim()))
			)
				throw new ToolError("Select between 1 and 32 nonempty read paths with inline selectors.");
			let estimate = this.session.validateSearchRewind(search);
			const sourceReads: RewindSourceRead[] | undefined = params.read ? [] : undefined;
			if (params.read && sourceReads) {
				const reader = this.session.getToolForEvalBridge?.("read");
				if (!reader) throw new ToolError("Read is not available in this session; no rewind was applied.");
				for (const [index, path] of params.read.entries()) {
					signal?.throwIfAborted();
					const call: ToolCall = {
						type: "toolCall",
						id: `${toolCallId}:read:${index}`,
						name: "read",
						arguments: { path },
					};
					let result: AgentToolResult;
					try {
						result = await reader.execute(call.id, call.arguments, signal, undefined, context);
					} catch (error) {
						signal?.throwIfAborted();
						result = { content: [{ type: "text", text: toError(error).message }], isError: true };
					}
					const message: ToolResultMessage = {
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: result.content,
						details: result.details,
						isError: result.isError === true,
						timestamp: Date.now(),
					};
					annotateSearchResult(message);
					sourceReads.push({ call, result: message });
				}
				estimate = this.session.validateSearchRewind(search);
			}
			const compact = estimate.willCompact !== false;
			const summary = compact
				? `Observation rewind requested: ${estimate.beforeTokens} → ${estimate.afterTokens} estimated tokens.`
				: "Observation decision recorded; context will be retained because a cut has no net benefit.";
			return toolResult<RewindToolDetails>({
				report: "",
				rewound: compact,
				search,
				estimate,
				sourceReads,
			})
				.text(summary)
				.done();
		}
		const instructionAnchor = this.session.getInstructionAnchor?.(params.checkpointId);
		if (
			params.checkpointId &&
			instructionAnchor?.id === params.checkpointId &&
			this.session.getCheckpointState?.()?.checkpointId !== params.checkpointId
		) {
			if (
				params.keep ||
				params.read ||
				params.retain ||
				params.release ||
				params.demote ||
				params.outcome !== undefined ||
				params.reason !== undefined
			)
				throw new ToolError("Instruction rewind accepts only report or note, plus optional nextAction.");
			if (params.report !== undefined && params.note !== undefined)
				throw new ToolError("Instruction rewind accepts report or note, not both.");
			const report = (params.note ?? params.report)?.trim() ?? "";
			// An instruction fold may be the turn's final act: the answer is already
			// delivered, so requiring a "next concrete action" would fabricate one.
			const nextAction = params.nextAction?.trim() ?? "";
			if (!report) throw new ToolError("report (or note) must be nonempty.");
			if (!this.session.validateInstructionRewind)
				throw new ToolError("Instruction rewind requires a live session.");
			const estimate = this.session.validateInstructionRewind(params.checkpointId, report, nextAction);
			return toolResult<RewindToolDetails>({
				report,
				rewound: estimate.willCompact !== false,
				checkpointId: params.checkpointId,
				nextAction,
				estimate,
				instructionAnchor: true,
			})
				.text(
					estimate.willCompact === false
						? `Instruction decision recorded; context retained because a cut has no net benefit (${estimate.beforeTokens} tokens).`
						: `Instruction rewind requested: estimated context ${estimate.beforeTokens} → ${estimate.afterTokens} tokens; the used point stays as its own boundary and a fresh one opens after it.`,
				)
				.done();
		}
		if (
			!params.checkpointId ||
			params.report === undefined ||
			params.retain ||
			params.release ||
			params.demote ||
			params.note !== undefined ||
			params.keep ||
			params.read
		) {
			throw new ToolError("Use observationId with nextAction, or checkpointId with report and nextAction.");
		}
		const state = this.session.getCheckpointState?.();
		if (!state) {
			if (params.checkpointId && /^R\d+$/.test(params.checkpointId)) {
				if (!this.session.getInstructionAnchor)
					throw new ToolError(
						"Instruction rewind requires a host session bridge this runtime did not provide; the advertised point cannot be resolved.",
					);
				throw new ToolError(
					`Instruction rewind point ${params.checkpointId} is stale or unavailable. Rewind to a point advertised in the current request.`,
				);
			}
			if (this.session.getLastCompletedRewind?.()) {
				throw new ToolError(
					"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
				);
			}
			const anchor = this.session.getInstructionAnchor?.();
			throw new ToolError(
				anchor
					? `No active checkpoint. Use the instruction rewind point ${anchor.id} advertised for this request.`
					: "No active checkpoint. Create a checkpoint before calling rewind.",
			);
		}
		if (params.checkpointId !== state.checkpointId) {
			throw new ToolError("Checkpoint ID does not match the active work package. Use its returned checkpointId.");
		}
		const report = params.report.trim();
		const nextAction = params.nextAction?.trim() ?? "";
		if (!report || !nextAction) {
			throw new ToolError("report and nextAction must be nonempty.");
		}
		if (params.outcome === "blocked" && !params.reason?.trim())
			throw new ToolError("Blocked outcome requires a reason.");
		const estimate = this.session.validateRewind?.(
			params.checkpointId,
			report,
			nextAction,
			params.outcome,
			params.reason,
		);
		return toolResult<RewindToolDetails>({
			checkpointId: params.checkpointId,
			report,
			nextAction,
			estimate,
			outcome: params.outcome,
			reason: params.reason,
			rewound: estimate?.willCompact !== false,
		})
			.text(
				estimate
					? estimate.willCompact === false
						? "Work outcome requested; context will be retained because a cut has no net benefit."
						: `Rewind requested: estimated context ${estimate.beforeTokens} → ${estimate.afterTokens} tokens; unchanged prefix ${estimate.reusablePrefixTokens} tokens (cache eligibility, not guaranteed hits).${this.#foldPayback(estimate)}`
					: "Rewind requested. Report captured for context replacement.",
			)
			.done();
	}

	/**
	 * What the fold costs versus what it saves, in price-card terms. A local fold
	 * pays the re-cached suffix once and then saves the folded tokens every turn;
	 * the break-even turn count is the only number that decides whether folding
	 * again is worth it.
	 */
	#foldPayback(estimate: RewindContextEstimate): string {
		if (estimate.willCompact === false) return "";
		const model = this.session.getActiveModel?.();
		const economics = estimateFold({
			liveTokens: estimate.beforeTokens,
			foldedTokens: Math.max(0, estimate.beforeTokens - estimate.afterTokens),
			reportTokens: 0,
			factors: priceFactors((model as { cost?: PriceCard } | undefined)?.cost),
			oneshotSummary: false,
		});
		if (!Number.isFinite(economics.breakEvenTurns)) return "";
		// The keep window makes the trade readable: carrying a block for this many
		// turns already costs one re-read, so anything not needed inside it belongs
		// in the fold.
		const keepWindow = Math.max(1, Math.round(keepWindowTurns(economics.factors)));
		return ` Fold pays back after ~${Math.ceil(economics.breakEvenTurns)} more turns of this session (a re-read costs ~${keepWindow} turns of carrying it).`;
	}
}

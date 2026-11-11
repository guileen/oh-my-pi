import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import contextNotesDescription from "../prompts/tools/context-notes.md" with { type: "text" };
import contextNotesTextDescription from "../prompts/tools/context-notes-text.md" with { type: "text" };
import newContextDescription from "../prompts/tools/new-context.md" with { type: "text" };
import newContextQaDescription from "../prompts/tools/new-context-qa.md" with { type: "text" };
import qaCheckpointDescription from "../prompts/tools/new-context-qa-checkpoint.md" with { type: "text" };
import qaCycleIdDescription from "../prompts/tools/new-context-qa-cycle-id.md" with { type: "text" };
import qaDispositionDescription from "../prompts/tools/new-context-qa-disposition.md" with { type: "text" };
import qaNextActionDescription from "../prompts/tools/new-context-qa-next-action.md" with { type: "text" };
import qaSummaryDescription from "../prompts/tools/new-context-qa-summary.md" with { type: "text" };
import {
	CONTEXT_NOTES_ENTRY_TYPE,
	type ContextNotesEntry,
	getContextNotes,
	MAX_CONTEXT_NOTES_BYTES,
} from "../session/context-notes";
import { cfgCompactionExperimentalContextManagement } from "../session/context-settings";
import { type QaCheckpointAcceptance, qaCheckpointError } from "../session/qa-rollover";
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

const contextNotesSchema = type({
	"text?": type("string").describe(prompt.render(contextNotesTextDescription, { maxBytes: MAX_CONTEXT_NOTES_BYTES })),
});

const newContextSchema = type({ "+": "reject" });
// QA keeps one checkpoint shape; execute owns disposition-specific requirements.
// QA stays non-strict so omitted nextAction never acquires a null placeholder.
const qaNewContextSchema = type({
	checkpoint: type({
		cycleId: type("string > 0").describe(qaCycleIdDescription),
		summary: type("string > 0").describe(qaSummaryDescription),
		disposition: type("'continue' | 'complete' | 'blocked'").describe(qaDispositionDescription),
		"nextAction?": type("string > 0").describe(qaNextActionDescription),
		"+": "reject",
	}).describe(qaCheckpointDescription),
	"+": "reject",
});

export type ContextNotesParams = typeof contextNotesSchema.infer;
export type NewContextParams = typeof newContextSchema.infer | typeof qaNewContextSchema.infer;

export interface ContextNotesToolDetails {
	entryId?: string;
	text: string;
	bytes?: number;
}

export interface NewContextToolDetails {
	requested: true;
	checkpoint?: QaCheckpointAcceptance["checkpoint"];
}

type ExperimentalContextSessionManager = NonNullable<ToolSession["sessionManager"]>;

function resolveExperimentalContextSession(session: ToolSession): ExperimentalContextSessionManager | undefined {
	if (cfgCompactionExperimentalContextManagement.get(session.settings) !== true || session.isDisposed?.()) {
		return undefined;
	}
	const manager = session.sessionManager;
	const ownerId = session.getSessionId?.();
	if (!manager || !ownerId || manager.getSessionId?.() !== ownerId) return undefined;
	return manager;
}

function supportsQaContext(session: ToolSession, manualReport = false): boolean {
	if (
		(!manualReport && cfgCompactionExperimentalContextManagement.get(session.settings)) ||
		session.isDisposed?.() ||
		!session.qaRollover?.isEnabled()
	) {
		return false;
	}
	const ownerId = session.getSessionId?.();
	return !!ownerId && session.sessionManager?.getSessionId?.() === ownerId;
}

function checkpointCycleId(params: unknown): string | undefined {
	if (!isRecord(params) || !isRecord(params.checkpoint)) return undefined;
	return typeof params.checkpoint.cycleId === "string" ? params.checkpoint.cycleId : undefined;
}

/**
 * Resolves the live session journal only when experimental context management is enabled and
 * owned by this ToolSession. The identity comparison prevents advisor tools from writing the
 * parent agent's notebook or resolving its raw history.
 */
export function getExperimentalContextSession(session: ToolSession): ExperimentalContextSessionManager {
	const manager = resolveExperimentalContextSession(session);
	if (manager) return manager;
	if (cfgCompactionExperimentalContextManagement.get(session.settings) !== true) {
		throw new ToolError("Experimental context management is disabled.");
	}
	if (session.isDisposed?.()) {
		throw new ToolError("Experimental context management is unavailable because this session is disposed.");
	}
	throw new ToolError("Experimental context management is unavailable for this session.");
}

/** Reads or replaces the current branch's durable experimental notebook. */
export class ContextNotesTool implements AgentTool<typeof contextNotesSchema, ContextNotesToolDetails> {
	readonly name = "context_notes";
	readonly approval = (args: unknown): ToolApprovalDecision =>
		args !== null && typeof args === "object" && Object.hasOwn(args, "text") ? "write" : "read";
	readonly label = "Context Notes";
	readonly description = contextNotesDescription;
	readonly parameters = contextNotesSchema;
	// Strict-mode providers mark every property required, so an optional `text`
	// would force models to send `""` (a clear) just to read. Stay non-strict
	// so omitted `text` keeps meaning "read" while an explicit empty string clears.
	readonly strict = false;
	readonly loadMode = "essential" as const;
	readonly summary = "Read or replace persistent experimental context notes";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ContextNotesTool | null {
		return resolveExperimentalContextSession(session) ? new ContextNotesTool(session) : null;
	}

	async execute(
		_id: string,
		params: ContextNotesParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ContextNotesToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ContextNotesToolDetails>> {
		const manager = getExperimentalContextSession(this.session);
		throwIfAborted(signal);
		if (params.text !== undefined && typeof params.text !== "string") {
			throw new ToolError("context_notes text must be a string.");
		}
		if (params.text === undefined) {
			const notes = getContextNotes(manager.getBranch());
			return {
				content: [{ type: "text", text: notes?.text ?? "No context notes are stored for this session branch." }],
				details: notes ? { entryId: notes.entryId, text: notes.text } : { entryId: undefined, text: "" },
			};
		}

		const bytes = Buffer.byteLength(params.text, "utf8");
		if (bytes > MAX_CONTEXT_NOTES_BYTES) {
			throw new ToolError(
				`Context notes are ${bytes} bytes; the limit is ${MAX_CONTEXT_NOTES_BYTES} UTF-8 bytes. Shorten the notebook and use history://current/full to recover raw detail.`,
			);
		}

		const ownerId = this.session.getSessionId?.();
		const branchLeafId = manager.getBranch().at(-1)?.id;
		await manager.ensureOnDisk();
		throwIfAborted(signal);
		const currentManager = getExperimentalContextSession(this.session);
		if (
			currentManager !== manager ||
			this.session.isDisposed?.() ||
			!ownerId ||
			this.session.getSessionId?.() !== ownerId ||
			manager.getSessionId?.() !== ownerId ||
			manager.getBranch().at(-1)?.id !== branchLeafId
		) {
			throw new ToolError("Experimental context notes were not saved because the session branch changed.");
		}

		const data: ContextNotesEntry = { version: 1, text: params.text };
		const entryId = manager.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, data);
		await manager.flush();
		return {
			content: [{ type: "text", text: "Context notes saved." }],
			details: { entryId, text: params.text, bytes },
		};
	}
}

/** Requests a fresh context window; the owning lifecycle consumes this turn-local signal. */
export class NewContextTool implements AgentTool<
	typeof newContextSchema | typeof qaNewContextSchema,
	NewContextToolDetails
> {
	readonly name = "new_context";
	readonly approval = "write" as const;
	readonly label = "New Context";
	readonly description: string;
	readonly parameters: typeof newContextSchema | typeof qaNewContextSchema;
	readonly strict: boolean;
	// Validation owns typed QA refusals and must never heal away checkpoint data.
	readonly lenientArgValidation = "raw" as const;
	readonly loadMode = "essential" as const;
	readonly summary = "Request a fresh context window";

	readonly #mode: "experimental" | "qa";
	readonly #manualReport: boolean;

	constructor(
		private readonly session: ToolSession,
		options?: { manualReport?: boolean },
	) {
		this.#manualReport = options?.manualReport === true;
		this.#mode =
			!this.#manualReport && cfgCompactionExperimentalContextManagement.get(session.settings)
				? "experimental"
				: "qa";
		this.description = this.#mode === "experimental" ? newContextDescription : newContextQaDescription;
		this.parameters = this.#mode === "experimental" ? newContextSchema : qaNewContextSchema;
		this.strict = this.#mode === "experimental";
	}

	static isSupported(session: ToolSession): boolean {
		return !!resolveExperimentalContextSession(session) || supportsQaContext(session);
	}

	static createIf(session: ToolSession): NewContextTool | null {
		return NewContextTool.isSupported(session) ? new NewContextTool(session) : null;
	}

	async execute(
		_id: string,
		params: unknown,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<NewContextToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<NewContextToolDetails>> {
		throwIfAborted(signal);
		const cycleId = checkpointCycleId(params);
		if (this.#mode === "qa") {
			const rollover = this.session.qaRollover;
			if (!rollover || !supportsQaContext(this.session, this.#manualReport)) {
				throw qaCheckpointError("QA_NOT_ACTIVE", "QA rollover is unavailable for this session.", cycleId);
			}
			if (!qaNewContextSchema.allows(params)) {
				throw qaCheckpointError("QA_INVALID_CHECKPOINT", "Invalid QA checkpoint fields or disposition.", cycleId);
			}
			const { checkpoint } = qaNewContextSchema.assert(params);
			if (!checkpoint.cycleId.trim() || !checkpoint.summary.trim()) {
				throw qaCheckpointError("QA_INVALID_CHECKPOINT", "QA checkpoint fields must not be blank.", cycleId);
			}
			if (checkpoint.disposition === "continue" && !checkpoint.nextAction?.trim()) {
				throw qaCheckpointError(
					"QA_INVALID_CHECKPOINT",
					"A continuing QA checkpoint requires a nonblank nextAction.",
					cycleId,
				);
			}
			if (checkpoint.disposition !== "continue" && Object.hasOwn(checkpoint, "nextAction")) {
				throw qaCheckpointError(
					"QA_INVALID_CHECKPOINT",
					"Complete or blocked QA checkpoints must omit nextAction.",
					cycleId,
				);
			}
			const details = await rollover.accept(checkpoint, signal);
			return {
				content: [{ type: "text", text: "QA checkpoint recorded. Context rollover is pending." }],
				details,
			};
		}
		if (isRecord(params) && Object.hasOwn(params, "checkpoint")) {
			throw qaCheckpointError(
				"QA_NOT_ACTIVE",
				"QA checkpoints are unavailable in experimental notes mode.",
				cycleId,
			);
		}
		getExperimentalContextSession(this.session);
		if (!newContextSchema.allows(params)) {
			throw new ToolError("Experimental new_context accepts only an empty object.");
		}
		return {
			content: [{ type: "text", text: "New context window requested." }],
			details: { requested: true },
		};
	}
}

import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Model-supplied continuation state for one maintenance-owned QA cycle. */
export interface QaCheckpointInput {
	cycleId: string;
	summary: string;
	disposition: "continue" | "complete" | "blocked";
	nextAction?: string;
}

export const QA_CHECKPOINT_ENTRY_TYPE = "qa-rollover-checkpoint";

/** Journal identity and timestamps belong to the enclosing custom entry. */
export interface QaCheckpointData extends QaCheckpointInput {
	version: 1;
}

/** Acknowledges durable recording only, not a successful context rewrite. */
export interface QaCheckpointAcceptance {
	requested: true;
	checkpoint: {
		cycleId: string;
		entryId: string;
		status: "accepted" | "already-accepted";
	};
}

export type QaCheckpointErrorCode =
	| "QA_NOT_ACTIVE"
	| "QA_STALE_CYCLE"
	| "QA_INVALID_CHECKPOINT"
	| "QA_CHECKPOINT_CONFLICT"
	| "QA_PERSIST_FAILED";

export interface QaCheckpointErrorDetails extends Record<string, unknown> {
	code: QaCheckpointErrorCode;
	cycleId?: string;
}

/** Uses the ordinary tool failure envelope so callers never parse error prose. */
export function qaCheckpointError(code: QaCheckpointErrorCode, message: string, cycleId?: string): ToolError {
	const details: QaCheckpointErrorDetails = cycleId === undefined ? { code } : { code, cycleId };
	return new ToolError(message, details);
}

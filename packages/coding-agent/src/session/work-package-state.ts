import { isRecord } from "@oh-my-pi/pi-utils";
import type { CheckpointState } from "../tools/checkpoint";
import type { TodoSnapshotIdentity, WorkPackageTodoBinding } from "../tools/todo";

export const WORK_PACKAGE_REWIND_KIND = "work-package-rewind";
export const WORK_PACKAGE_STATE_TYPE = "work-package-state";

/** Decode persisted parent scopes without accepting cyclic or unbounded state. */
export function checkpointStateFromValue(value: unknown, depth = 0): CheckpointState | undefined {
	if (
		!isRecord(value) ||
		depth >= 32 ||
		typeof value.startedAt !== "string" ||
		typeof value.checkpointEntryId !== "string" ||
		typeof value.checkpointMessageCount !== "number" ||
		!Number.isSafeInteger(value.checkpointMessageCount) ||
		value.checkpointMessageCount < 0
	)
		return undefined;
	const todo = checkpointTodoFromValue(value.todoBinding);
	if (value.todoBinding !== undefined && !todo) return undefined;
	const parent = value.parent === undefined ? undefined : checkpointStateFromValue(value.parent, depth + 1);
	if (value.parent !== undefined && !parent) return undefined;
	return {
		checkpointEntryId: value.checkpointEntryId,
		checkpointMessageCount: value.checkpointMessageCount,
		checkpointId: typeof value.checkpointId === "string" ? value.checkpointId : undefined,
		startedAt: value.startedAt,
		goal: typeof value.goal === "string" ? value.goal : undefined,
		finishWhen: typeof value.finishWhen === "string" ? value.finishWhen : undefined,
		carryForward: typeof value.carryForward === "string" ? value.carryForward : undefined,
		todoBinding: todo,
		parent,
	};
}

export function checkpointTodoFromValue(value: unknown): WorkPackageTodoBinding | undefined {
	if (
		!isRecord(value) ||
		typeof value.phase !== "string" ||
		(value.task !== undefined && typeof value.task !== "string") ||
		!isRecord(value.identity) ||
		typeof value.identity.sourceEntryId !== "string" ||
		typeof value.identity.fingerprint !== "string"
	)
		return undefined;
	return {
		phase: value.phase,
		task: typeof value.task === "string" ? value.task : undefined,
		identity: { sourceEntryId: value.identity.sourceEntryId, fingerprint: value.identity.fingerprint },
	};
}

/** Only our own committed todo transition may advance ancestor binding identities. */
export function refreshCheckpointTodoIdentity(
	state: CheckpointState | undefined,
	identity: TodoSnapshotIdentity | undefined,
	expected?: TodoSnapshotIdentity,
): CheckpointState | undefined {
	if (!state) return undefined;
	const binding = state.todoBinding;
	const matches =
		!expected ||
		(binding?.identity.sourceEntryId === expected.sourceEntryId &&
			binding.identity.fingerprint === expected.fingerprint);
	return {
		...state,
		todoBinding: binding && identity && matches ? { ...binding, identity: { ...identity } } : binding,
		parent: refreshCheckpointTodoIdentity(state.parent, identity, expected),
	};
}

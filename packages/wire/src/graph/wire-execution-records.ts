import { canonicalJson } from "../canonical-json";
import type { GraphRef } from "./scalars";
import {
	graphWireExecutionStateSupported,
	type GraphWireExecutionAttempt,
	type GraphWireExecutionImageRecord,
	type GraphWireExecutionInvocation,
	type GraphWireExecutionMember,
	type GraphWireExecutionRecord,
	type GraphWireExecutionRun,
} from "./wire-execution-types";
import { GraphWireError, type GraphSourceRef, type GraphWireRun } from "./wire-types";

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const id = (value: unknown): value is string => text(value) && value.length > 0;
const nullableId = (value: unknown) => value === null || id(value);
const nullableText = (value: unknown) => value === null || text(value);
const ordinal = (value: unknown) => text(value) && /^(0|[1-9][0-9]*)$/.test(value);
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown) => nonnegative(value) && value >= 1;
const strings = (value: unknown) => Array.isArray(value) && value.every(id);
const source = (value: unknown): value is GraphSourceRef =>
	object(value) && id(value.source_id) && id(value.profile_id) && id(value.bot_id);
const ref = (value: unknown): value is GraphRef => object(value) && id(value.id) && id(value.digest);
const nodeKinds = ["bot", "program", "queue", "human", "subgraph"];
const duties = ["research", "guide", "spec", "review", "consult", "code-only", "test-only", "general"];
const oneOf = (value: unknown, values: readonly string[]) => text(value) && values.includes(value);
const timestamp = (value: unknown) =>
	text(value) &&
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value) &&
	Number.isFinite(Date.parse(value));

function fail(message: string): never {
	throw new GraphWireError("invalid_input", message);
}

/** Validate producer records without rewriting them; additive fields participate in conflict checks. */
export function validateGraphWireExecutionRecord(record: unknown): asserts record is GraphWireExecutionRecord {
	if (!object(record) || !object(record.value)) fail("Expected a complete Graph execution record");
	const value = record.value;
	if (!id(value.graph_run_id) || !ordinal(value.revision)) fail("Invalid Graph execution identity or revision");
	switch (record.kind) {
		case "execution_run":
			if (
				!graphWireExecutionStateSupported(record.kind, value.state) ||
				!nullableText(value.reason) ||
				!ref(value.snapshot_ref) ||
				!strings(value.budget_refs) ||
				!strings(value.decision_refs)
			)
				fail("Invalid Graph execution Run");
			break;
		case "execution_member":
			if (
				!id(value.member_id) ||
				!text(value.label) ||
				!(value.bot === null || source(value.bot)) ||
				!oneOf(value.duty, duties) ||
				!ref(value.model_binding_ref) ||
				!ref(value.base_snapshot_ref) ||
				!strings(value.communication_targets)
			)
				fail("Invalid Graph execution member");
			break;
		case "execution_invocation":
			if (
				!id(value.node_id) ||
				!id(value.invocation_id) ||
				!nullableId(value.member_id) ||
				!oneOf(value.kind, nodeKinds) ||
				!oneOf(value.origin, ["executed", "imported"]) ||
				!nonnegative(value.iteration) ||
				!id(value.scope_id) ||
				!nullableId(value.parent_invocation_id) ||
				!graphWireExecutionStateSupported(record.kind, value.state) ||
				!nullableId(value.selected_outcome) ||
				!strings(value.input_refs) ||
				!strings(value.upstream_attempt_ids) ||
				!nullableText(value.wait_reason) ||
				!nullableId(value.current_attempt_id)
			)
				fail("Invalid Graph execution invocation");
			if (value.origin === "imported" && value.current_attempt_id !== null)
				fail("Imported invocation cannot invent an execution attempt");
			break;
		case "execution_attempt":
			if (
				!id(value.attempt_id) ||
				!id(value.invocation_id) ||
				!positive(value.number) ||
				!oneOf(value.executor_kind, nodeKinds) ||
				!graphWireExecutionStateSupported(record.kind, value.state) ||
				!nullableId(value.execution_ref) ||
				!nullableId(value.result_ref) ||
				!(value.job === null || (source(value.job) && object(value.job) && id(value.job.job_id)))
			)
				fail("Invalid Graph execution attempt");
			if (value.executor_kind !== "bot" && value.job !== null) fail("Non-Bot execution cannot invent a Bot Job");
			break;
		case "execution_conversation":
			if (
				!id(value.conversation_id) ||
				!id(value.requester_member) ||
				!id(value.responder_member) ||
				!graphWireExecutionStateSupported(record.kind, value.state) ||
				!nonnegative(value.remaining_rounds) ||
				!timestamp(value.deadline) ||
				!id(value.content_ref) ||
				!strings(value.message_refs)
			)
				fail("Invalid Graph execution conversation");
			break;
		case "execution_budget":
			if (
				!id(value.budget_id) ||
				!id(value.scope_key) ||
				!positive(value.limit) ||
				!nonnegative(value.consumed) ||
				(value.consumed as number) > (value.limit as number)
			)
				fail("Invalid Graph execution budget");
			break;
		default:
			fail("Unsupported Graph execution record kind");
	}
}

/** Members and other execution IDs are resolved within their Run, never across filtered projections. */
export function graphWireExecutionRecordKey(record: GraphWireExecutionRecord): string {
	const value = record.value;
	switch (record.kind) {
		case "execution_run":
			return canonicalJson([record.kind, value.graph_run_id]);
		case "execution_member":
			return canonicalJson([record.kind, value.graph_run_id, record.value.member_id]);
		case "execution_invocation":
			return canonicalJson([record.kind, value.graph_run_id, record.value.invocation_id]);
		case "execution_attempt":
			return canonicalJson([record.kind, value.graph_run_id, record.value.attempt_id]);
		case "execution_conversation":
			return canonicalJson([record.kind, value.graph_run_id, record.value.conversation_id]);
		case "execution_budget":
			return canonicalJson([record.kind, value.graph_run_id, record.value.budget_id]);
	}
}

const sourceIdentity = (value: GraphSourceRef | null) => value && [value.source_id, value.profile_id, value.bot_id];
const refIdentity = (value: GraphRef) => [value.id, value.digest];
function immutable(record: GraphWireExecutionRecord): unknown {
	const run = record.value.graph_run_id;
	switch (record.kind) {
		case "execution_run":
			return [run, refIdentity(record.value.snapshot_ref)];
		case "execution_member": {
			const value = record.value;
			return [
				run,
				value.member_id,
				value.label,
				sourceIdentity(value.bot),
				value.duty,
				refIdentity(value.model_binding_ref),
				refIdentity(value.base_snapshot_ref),
				value.communication_targets,
			];
		}
		case "execution_invocation": {
			const value = record.value;
			return [
				run,
				value.invocation_id,
				value.node_id,
				value.member_id,
				value.kind,
				value.origin,
				value.iteration,
				value.scope_id,
				value.parent_invocation_id,
			];
		}
		case "execution_attempt": {
			const value = record.value;
			return [run, value.attempt_id, value.invocation_id, value.number, value.executor_kind];
		}
		case "execution_conversation": {
			const value = record.value;
			return [
				run,
				value.conversation_id,
				value.requester_member,
				value.responder_member,
				value.deadline,
				value.content_ref,
			];
		}
		case "execution_budget":
			return [run, record.value.budget_id, record.value.scope_key, record.value.limit];
	}
}

export function assertGraphWireExecutionReplacement(
	previous: GraphWireExecutionRecord,
	next: GraphWireExecutionRecord,
): void {
	validateGraphWireExecutionRecord(previous);
	validateGraphWireExecutionRecord(next);
	if (graphWireExecutionRecordKey(previous) !== graphWireExecutionRecordKey(next))
		fail("Graph execution replacement changes record identity");
	if (previous.value.revision === next.value.revision && canonicalJson(previous) !== canonicalJson(next))
		throw new GraphWireError("protocol_error", "Conflicting Graph execution values at the same revision");
	if (canonicalJson(immutable(previous)) !== canonicalJson(immutable(next)))
		throw new GraphWireError("binding_conflict", "Graph execution replacement changes immutable identity");
	if (
		previous.kind === "execution_run" &&
		next.kind === "execution_run" &&
		["succeeded", "failed", "cancelled"].includes(previous.value.state) &&
		previous.value.state !== next.value.state
	)
		throw new GraphWireError("binding_conflict", "A terminal Graph Run cannot restart");
	if (
		previous.kind === "execution_budget" &&
		next.kind === "execution_budget" &&
		next.value.consumed < previous.value.consumed
	)
		throw new GraphWireError("binding_conflict", "A fixed Graph budget cannot replenish consumed allowance");
	if (previous.kind === "execution_conversation" && next.kind === "execution_conversation") {
		if (next.value.remaining_rounds > previous.value.remaining_rounds)
			throw new GraphWireError("binding_conflict", "A Graph consultation cannot replenish round allowance");
		if (
			["answered", "timed_out", "cancelled"].includes(previous.value.state) &&
			previous.value.state !== next.value.state
		)
			throw new GraphWireError("binding_conflict", "A closed Graph consultation cannot restart");
	}
	if (previous.kind === "execution_attempt" && next.kind === "execution_attempt") {
		if (
			previous.value.job !== null &&
			canonicalJson([sourceIdentity(previous.value.job), previous.value.job.job_id]) !==
				canonicalJson([sourceIdentity(next.value.job), next.value.job?.job_id ?? null])
		)
			throw new GraphWireError("binding_conflict", "Graph execution replacement changes immutable attempt Job");
		for (const field of ["execution_ref", "result_ref"] as const) {
			if (previous.value[field] !== null && previous.value[field] !== next.value[field])
				throw new GraphWireError(
					"binding_conflict",
					"Graph execution replacement changes immutable attempt reference",
				);
		}
		if (
			["succeeded", "failed", "cancelled"].includes(previous.value.state) &&
			previous.value.state !== next.value.state
		)
			throw new GraphWireError("binding_conflict", "A terminal execution attempt cannot revive or change outcome");
	}
	if (previous.kind === "execution_invocation" && next.kind === "execution_invocation") {
		if (
			previous.value.state !== "pending" &&
			canonicalJson([previous.value.input_refs, previous.value.upstream_attempt_ids]) !==
				canonicalJson([next.value.input_refs, next.value.upstream_attempt_ids])
		)
			throw new GraphWireError("binding_conflict", "Graph execution replacement changes frozen invocation inputs");
		if (
			previous.value.state === "succeeded" &&
			(next.value.state !== "succeeded" ||
				previous.value.current_attempt_id !== next.value.current_attempt_id ||
				previous.value.selected_outcome !== next.value.selected_outcome)
		)
			throw new GraphWireError(
				"binding_conflict",
				"A succeeded invocation cannot revive or change its accepted result",
			);
		if (
			previous.value.state === "failed" &&
			next.value.state !== "failed" &&
			(next.value.state !== "ready" ||
				next.value.current_attempt_id === null ||
				next.value.current_attempt_id === previous.value.current_attempt_id)
		)
			throw new GraphWireError("binding_conflict", "A failed invocation requires a new ready attempt");
	}
}

const scopedKey = (run: string, entity: string) => canonicalJson([run, entity]);

/** Base Runs are validated by wire-records first. No runtime import of wire-records is needed. */
export function validateGraphWireExecutionImage(records: readonly GraphWireExecutionImageRecord[]): void {
	const runs = new Map<string, GraphWireRun>();
	const executionRuns = new Map<string, GraphWireExecutionRun>();
	const members = new Map<string, GraphWireExecutionMember>();
	const invocations = new Map<string, GraphWireExecutionInvocation>();
	const attempts = new Map<string, GraphWireExecutionAttempt>();
	const budgets = new Set<string>();
	const keys = new Set<string>();
	for (const record of records) {
		if (record.kind === "run") {
			if (runs.has(record.value.graph_run_id)) fail("Duplicate base Graph Run");
			runs.set(record.value.graph_run_id, record.value);
			continue;
		}
		validateGraphWireExecutionRecord(record);
		const key = graphWireExecutionRecordKey(record);
		if (keys.has(key)) fail("Duplicate Graph execution record identity");
		keys.add(key);
		const run = record.value.graph_run_id;
		switch (record.kind) {
			case "execution_run":
				executionRuns.set(run, record.value);
				break;
			case "execution_member":
				members.set(scopedKey(run, record.value.member_id), record.value);
				break;
			case "execution_invocation":
				invocations.set(scopedKey(run, record.value.invocation_id), record.value);
				break;
			case "execution_attempt":
				attempts.set(scopedKey(run, record.value.attempt_id), record.value);
				break;
			case "execution_budget":
				budgets.add(scopedKey(run, record.value.budget_id));
				break;
		}
	}
	const numbers = new Set<string>();
	const jobs = new Set<string>();
	for (const record of records) {
		if (record.kind === "run") continue;
		const value = record.value;
		const run = runs.get(value.graph_run_id);
		if (!run) fail("Graph execution record refers to an unknown base Run");
		if (!executionRuns.has(value.graph_run_id)) fail("Graph execution record refers to an unknown execution Run");
		switch (record.kind) {
			case "execution_run":
				for (const budget of record.value.budget_refs)
					if (!budgets.has(scopedKey(value.graph_run_id, budget)))
						fail("Execution Run refers to an unknown budget in this Run");
				break;
			case "execution_member":
				for (const target of record.value.communication_targets)
					if (!members.has(scopedKey(value.graph_run_id, target)))
						fail("Member refers to an unknown communication target in this Run");
				break;
			case "execution_invocation": {
				const invocation = record.value;
				const node = run.definition.nodes.find(node => node.node_id === invocation.node_id);
				if (!node) fail("Invocation refers to an unknown frozen node in this Run");
				const member =
					invocation.member_id === null ? null : members.get(scopedKey(value.graph_run_id, invocation.member_id));
				if (invocation.member_id !== null && !member) fail("Invocation refers to an unknown member in this Run");
				if ((invocation.kind === "bot" || invocation.kind === "subgraph") !== (invocation.member_id !== null))
					fail("Invocation member does not match its node kind");
				if (invocation.kind !== "bot" && node.bot !== null)
					fail("Non-Bot invocation cannot invent a frozen Bot identity");
				if (
					invocation.kind === "bot" &&
					node.bot &&
					member?.bot &&
					canonicalJson(sourceIdentity(node.bot)) !== canonicalJson(sourceIdentity(member.bot))
				)
					fail("Invocation member does not match the frozen Bot node");
				if (
					invocation.parent_invocation_id !== null &&
					(invocation.parent_invocation_id === invocation.invocation_id ||
						!invocations.has(scopedKey(value.graph_run_id, invocation.parent_invocation_id)))
				)
					fail("Invocation refers to an unknown or self parent in this Run");
				if (invocation.current_attempt_id !== null) {
					const attempt = attempts.get(scopedKey(value.graph_run_id, invocation.current_attempt_id));
					if (!attempt || attempt.invocation_id !== invocation.invocation_id)
						fail("Invocation current attempt does not belong to this invocation in this Run");
				}
				for (const upstream of invocation.upstream_attempt_ids) {
					const attempt = attempts.get(scopedKey(value.graph_run_id, upstream));
					if (!attempt || attempt.invocation_id === invocation.invocation_id)
						fail("Invocation refers to an unknown or self upstream attempt in this Run");
				}
				break;
			}
			case "execution_attempt": {
				const attempt = record.value;
				const invocation = invocations.get(scopedKey(value.graph_run_id, attempt.invocation_id));
				if (!invocation || invocation.origin === "imported" || invocation.kind !== attempt.executor_kind)
					fail("Attempt does not match an executed invocation in this Run");
				const number = canonicalJson([value.graph_run_id, attempt.invocation_id, attempt.number]);
				if (numbers.has(number))
					throw new GraphWireError("binding_conflict", "An invocation attempt number has more than one execution");
				numbers.add(number);
				if (attempt.job !== null) {
					const node = run.definition.nodes.find(node => node.node_id === invocation.node_id);
					const member =
						invocation.member_id === null
							? null
							: members.get(scopedKey(value.graph_run_id, invocation.member_id));
					if (
						!node?.bot ||
						canonicalJson(sourceIdentity(node.bot)) !== canonicalJson(sourceIdentity(attempt.job)) ||
						(member?.bot &&
							canonicalJson(sourceIdentity(member.bot)) !== canonicalJson(sourceIdentity(attempt.job)))
					)
						fail("Attempt Job does not match the frozen Bot identity");
					const job = canonicalJson([sourceIdentity(attempt.job), attempt.job.job_id]);
					if (jobs.has(job))
						throw new GraphWireError("binding_conflict", "A Bot Job has more than one execution attempt");
					jobs.add(job);
				}
				break;
			}
			case "execution_conversation":
				if (
					!members.has(scopedKey(value.graph_run_id, record.value.requester_member)) ||
					!members.has(scopedKey(value.graph_run_id, record.value.responder_member))
				)
					fail("Conversation refers to an unknown member in this Run");
				break;
		}
	}
}

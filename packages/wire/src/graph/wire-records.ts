import { canonicalJson } from "../canonical-json";
import {
	assertGraphWireExecutionReplacement,
	graphWireExecutionRecordKey,
	validateGraphWireExecutionImage,
	validateGraphWireExecutionRecord,
} from "./wire-execution-records";
import {
	isGraphWireExecutionKind,
	type GraphWireExecutionImageRecord,
	type GraphWireExecutionRecord,
} from "./wire-execution-types";
import { GraphWireError, type GraphSourceRef, type GraphWireRecord } from "./wire-types";

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const id = (value: unknown): value is string => text(value) && value.length > 0;
const nullableId = (value: unknown) => value === null || id(value);
const ordinal = (value: unknown): value is string => text(value) && /^(0|[1-9][0-9]*)$/.test(value);
const attempt = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;
const strings = (value: unknown) => Array.isArray(value) && value.every(id);
const nullableText = (value: unknown) => value === null || text(value);
const timestamp = (value: unknown) =>
	text(value) &&
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value) &&
	Number.isFinite(Date.parse(value));
const oneOf = (value: unknown, options: readonly string[]) => text(value) && options.includes(value);
const source = (value: unknown): value is GraphSourceRef =>
	object(value) && id(value.source_id) && id(value.profile_id) && id(value.bot_id);
const evidence = (value: unknown) =>
	object(value) &&
	source(value.source) &&
	id(value.job_id) &&
	nullableId(value.artifact_id) &&
	nullableId(value.ref) &&
	(value.artifact_id !== null || value.ref !== null);
function fail(message: string): never {
	throw new GraphWireError("invalid_input", message);
}

/** Unknown additive fields survive; required fields and identity-bearing values are never guessed. */
export function validateGraphWireRecord(record: unknown): asserts record is GraphWireRecord {
	if (!object(record) || !object(record.value)) fail("Expected a complete Graph record");
	if (isGraphWireExecutionKind(record.kind)) return validateGraphWireExecutionRecord(record);
	const value = record.value;
	if (!id(value.graph_run_id) || !ordinal(value.revision)) fail("Invalid Graph record identity or revision");
	switch (record.kind) {
		case "run": {
			if (
				!id(value.graph_id) ||
				!ordinal(value.definition_revision) ||
				!timestamp(value.created_at) ||
				!object(value.definition) ||
				!Array.isArray(value.definition.nodes) ||
				!Array.isArray(value.definition.edges)
			)
				fail("Invalid Graph Run definition");
			const nodes = new Set<string>();
			for (const node of value.definition.nodes) {
				if (
					!object(node) ||
					!id(node.node_id) ||
					!text(node.label) ||
					!(node.bot === null || source(node.bot)) ||
					!nullableId(node.config_revision) ||
					!nullableId(node.acceptance_ref)
				)
					fail("Invalid Graph node");
				if (nodes.has(node.node_id)) fail("Duplicate Graph node");
				nodes.add(node.node_id);
			}
			const edges = new Set<string>();
			for (const edge of value.definition.edges) {
				if (
					!object(edge) ||
					!id(edge.edge_id) ||
					!id(edge.from_node_id) ||
					!id(edge.to_node_id) ||
					!nullableId(edge.condition_ref) ||
					!nodes.has(edge.from_node_id) ||
					!nodes.has(edge.to_node_id)
				)
					fail("Invalid Graph edge");
				if (edges.has(edge.edge_id)) fail("Duplicate Graph edge");
				edges.add(edge.edge_id);
			}
			break;
		}
		case "binding":
			if (
				!id(value.binding_id) ||
				!id(value.node_id) ||
				!id(value.invocation_id) ||
				!attempt(value.attempt) ||
				!object(value.job) ||
				!source(value.job) ||
				!id(value.job.job_id) ||
				!id(value.config_revision) ||
				!oneOf(value.acceptance, ["pending", "accepted", "rejected", "unknown"]) ||
				!strings(value.evidence_refs) ||
				!nullableText(value.reason)
			)
				fail("Invalid Graph Binding");
			break;
		case "dependency":
			if (
				!id(value.dependency_id) ||
				!id(value.edge_id) ||
				!id(value.target_invocation_id) ||
				!attempt(value.target_attempt) ||
				!oneOf(value.state, ["waiting", "satisfied", "rejected", "unknown"]) ||
				!nullableText(value.reason) ||
				!Array.isArray(value.evidence) ||
				!value.evidence.every(evidence)
			)
				fail("Invalid Graph Dependency");
			break;
		case "transfer":
			if (
				!id(value.transfer_id) ||
				!id(value.edge_id) ||
				!id(value.from_binding_id) ||
				!id(value.to_binding_id) ||
				!evidence(value.artifact) ||
				!oneOf(value.state, ["pending", "delivered", "failed", "unknown"]) ||
				!nullableText(value.reason) ||
				!timestamp(value.occurred_at)
			)
				fail("Invalid Graph Transfer");
			break;
		default:
			fail("Unsupported Graph record kind");
	}
}

export function graphWireRecordKey(record: GraphWireRecord): string {
	switch (record.kind) {
		case "run":
			return canonicalJson([record.kind, record.value.graph_run_id]);
		case "binding":
			return canonicalJson([record.kind, record.value.binding_id]);
		case "dependency":
			return canonicalJson([record.kind, record.value.dependency_id]);
		case "transfer":
			return canonicalJson([record.kind, record.value.transfer_id]);
		default:
			return graphWireExecutionRecordKey(record);
	}
}

/** Canonical unsigned decimal comparison without converting unbounded revisions to numbers. */
export function compareGraphWireRevisions(left: string, right: string): number {
	if (!ordinal(left) || !ordinal(right)) fail("Invalid Graph revision");
	return left.length === right.length ? (left < right ? -1 : left > right ? 1 : 0) : left.length - right.length;
}

const sourceIdentity = (value: GraphSourceRef) => [value.source_id, value.profile_id, value.bot_id];
function immutable(record: Exclude<GraphWireRecord, GraphWireExecutionRecord>): unknown {
	const runId = record.value.graph_run_id;
	switch (record.kind) {
		case "run": {
			const value = record.value;
			return [
				runId,
				value.graph_id,
				value.definition_revision,
				value.created_at,
				value.definition.nodes.map(node => [
					node.node_id,
					node.label,
					node.bot && sourceIdentity(node.bot),
					node.config_revision,
					node.acceptance_ref,
				]),
				value.definition.edges.map(edge => [edge.edge_id, edge.from_node_id, edge.to_node_id, edge.condition_ref]),
			];
		}
		case "binding": {
			const value = record.value;
			return [
				runId,
				value.binding_id,
				value.node_id,
				value.invocation_id,
				value.attempt,
				sourceIdentity(value.job),
				value.job.job_id,
				value.config_revision,
			];
		}
		case "dependency": {
			const value = record.value;
			return [runId, value.dependency_id, value.edge_id, value.target_invocation_id, value.target_attempt];
		}
		case "transfer": {
			const value = record.value;
			return [
				runId,
				value.transfer_id,
				value.edge_id,
				value.from_binding_id,
				value.to_binding_id,
				sourceIdentity(value.artifact.source),
				value.artifact.job_id,
				value.artifact.artifact_id,
				value.artifact.ref,
			];
		}
	}
}

export function assertGraphWireReplacement(previous: GraphWireRecord, next: GraphWireRecord): void {
	validateGraphWireRecord(previous);
	validateGraphWireRecord(next);
	if (graphWireRecordKey(previous) !== graphWireRecordKey(next)) fail("Graph replacement changes record identity");
	if (previous.value.revision === next.value.revision && canonicalJson(previous) !== canonicalJson(next))
		throw new GraphWireError("protocol_error", "Conflicting Graph values at the same revision");
	if (isGraphWireExecutionKind(previous.kind)) {
		assertGraphWireExecutionReplacement(previous as GraphWireExecutionRecord, next as GraphWireExecutionRecord);
		return;
	}
	if (
		canonicalJson(immutable(previous as Exclude<GraphWireRecord, GraphWireExecutionRecord>)) !==
		canonicalJson(immutable(next as Exclude<GraphWireRecord, GraphWireExecutionRecord>))
	)
		throw new GraphWireError("binding_conflict", "Graph replacement changes immutable identity or definition");
}

/** Check the complete source image, not just a batch: its records can arrive in either order. */
export function validateGraphWireImage(records: readonly GraphWireRecord[]): void {
	const runs = new Map<string, Extract<GraphWireRecord, { kind: "run" }>["value"]>();
	const bindings = new Map<string, Extract<GraphWireRecord, { kind: "binding" }>["value"]>();
	const keys = new Set<string>();
	const attempts = new Set<string>();
	const jobs = new Set<string>();
	for (const record of records) {
		validateGraphWireRecord(record);
		const key = graphWireRecordKey(record);
		if (keys.has(key)) fail("Duplicate Graph record identity");
		keys.add(key);
		if (record.kind === "run") runs.set(record.value.graph_run_id, record.value);
		if (record.kind === "binding") bindings.set(record.value.binding_id, record.value);
	}
	for (const record of records) {
		const run = runs.get(record.value.graph_run_id);
		if (!run) fail("Graph record refers to an unknown Run");
		if (record.kind === "binding") {
			const binding = record.value;
			const node = run.definition.nodes.find(node => node.node_id === binding.node_id);
			if (
				!node?.bot ||
				canonicalJson(sourceIdentity(node.bot)) !== canonicalJson(sourceIdentity(binding.job)) ||
				(node.config_revision !== null && node.config_revision !== binding.config_revision)
			)
				fail("Binding does not match the frozen Bot node");
			const tuple = canonicalJson([binding.graph_run_id, binding.node_id, binding.invocation_id, binding.attempt]);
			const job = canonicalJson([
				binding.job.source_id,
				binding.job.profile_id,
				binding.job.bot_id,
				binding.job.job_id,
			]);
			if (attempts.has(tuple) || jobs.has(job))
				throw new GraphWireError("binding_conflict", "A Graph attempt or Job has more than one binding");
			attempts.add(tuple);
			jobs.add(job);
		}
		if (record.kind === "dependency" || record.kind === "transfer") {
			const edge = run.definition.edges.find(edge => edge.edge_id === record.value.edge_id);
			if (!edge) fail("Graph record refers to an unknown edge");
			if (record.kind === "transfer") {
				const from = bindings.get(record.value.from_binding_id);
				const to = bindings.get(record.value.to_binding_id);
				if (
					!from ||
					!to ||
					from.graph_run_id !== run.graph_run_id ||
					to.graph_run_id !== run.graph_run_id ||
					from.node_id !== edge.from_node_id ||
					to.node_id !== edge.to_node_id
				)
					fail("Transfer does not match the Run's edge bindings");
			}
		}
	}
	if (records.some(record => isGraphWireExecutionKind(record.kind)))
		validateGraphWireExecutionImage(
			records.filter(
				record => record.kind === "run" || isGraphWireExecutionKind(record.kind),
			) as GraphWireExecutionImageRecord[],
		);
}

import type { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { Consultation, ConsultationMessage } from "./consultation";
import type { GraphDefinition } from "./contracts";
import { queueRecordMatchesExecution, type QueueRecord } from "./executors/queue";
import type { GraphHumanDecision } from "./human";
import type { GraphBotHandoffRecord } from "./handoff";
import type { GraphDispatchIntent, GraphRunRecord, GraphRunSnapshot, GraphScheduleState } from "./store";
import { graphReadyEdgeSelected } from "./scheduler";
import { hasTable } from "./schema";
import { GraphWireLedger } from "./wire-ledger";
import { graphWireFrozenRun } from "./wire-publication";
import { graphWireRecordKey } from "@oh-my-pi/pi-wire/graph/wire-records";
import {
	GraphWireError,
	type GraphWireBinding,
	type GraphWireEvidence,
	type GraphWireExecutionAttempt,
	type GraphWireRecord,
} from "@oh-my-pi/pi-wire/graph";

const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const identity = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** Same-connection producer, never a polling reconstruction or a source capability grant. */
export function publishGraphWireLifecycle(
	db: Database,
	ledger: GraphWireLedger,
	run: GraphRunRecord,
	snapshot: GraphRunSnapshot,
	definition: GraphDefinition,
	state: GraphScheduleState,
	intents: GraphDispatchIntent[],
	initial = false,
): void {
	const binding = snapshot.observation;
	if (!binding) return;
	if (!db.inTransaction)
		throw new GraphWireError("invalid_input", "Lifecycle publication requires the Host transaction");
	const rows = db
		.query("SELECT data FROM graph_wire_current WHERE source_id=? AND run_id=?")
		.all(binding.source_id, run.id) as { data: string }[];
	const previous = new Map(
		rows.map(row => {
			const record = JSON.parse(row.data) as GraphWireRecord;
			return [graphWireRecordKey(record), record] as const;
		}),
	);
	// Upgrading must not manufacture execution history for topology-only legacy Runs.
	if (!initial && !previous.has(canonicalJson(["execution_run", run.id]))) return;
	const changes: GraphWireRecord[] = [];
	const add = (record: GraphWireRecord): void => {
		const old = previous.get(graphWireRecordKey(record));
		if (old && canonicalJson({ ...old.value, revision: "0" }) === canonicalJson({ ...record.value, revision: "0" }))
			return;
		record.value.revision = old ? (BigInt(old.value.revision) + 1n).toString() : "1";
		changes.push(record);
	};
	if (initial) {
		ledger.registerSource(binding.source_id);
		changes.push({ kind: "run", value: graphWireFrozenRun(run, definition, binding) });
	}
	const budgetLimits = new Map<string, number>();
	for (const [name, budget] of Object.entries(definition.budgets ?? {})) {
		const prefix = `budget:${name}:${budget.scope}:`;
		const scope =
			budget.scope === "run" ? "run" : budget.scope === "stage" ? budget.stage : state.cycles[budget.loop ?? ""];
		if (scope) budgetLimits.set(`${prefix}${scope}`, budget.limit);
		for (const counter of state.counters)
			if (counter.key.startsWith(prefix)) budgetLimits.set(counter.key, budget.limit);
	}
	for (const [name, loop] of Object.entries(definition.loops ?? {})) {
		const prefix = `loop:${name}:${loop.scope}:`;
		const scope = loop.scope === "stage" ? loop.stage : state.cycles[name];
		if (scope) {
			budgetLimits.set(`${prefix}${scope}`, loop.max_reviews);
			budgetLimits.set(`final:${prefix}${scope}`, 1);
		}
		for (const counter of state.counters) {
			if (counter.key.startsWith(prefix)) budgetLimits.set(counter.key, loop.max_reviews);
			if (counter.key.startsWith(`final:${prefix}`)) budgetLimits.set(counter.key, 1);
		}
	}
	const consumed = new Map(state.counters.map(counter => [counter.key, counter.consumed]));
	for (const [key, limit] of budgetLimits)
		add({
			kind: "execution_budget",
			value: {
				graph_run_id: run.id,
				budget_id: key,
				revision: "1",
				scope_key: key,
				limit,
				consumed: consumed.get(key) ?? 0,
			},
		});
	const decisions = hasTable(db, "graph_human_decisions")
		? (
				db
					.query("SELECT data FROM graph_human_decisions WHERE json_extract(data,'$.run_id')=? ORDER BY rowid")
					.all(run.id) as { data: string }[]
			).map(row => JSON.parse(row.data) as GraphHumanDecision)
		: [];
	add({
		kind: "execution_run",
		value: {
			graph_run_id: run.id,
			revision: "1",
			state: run.state,
			reason: run.reason,
			snapshot_ref: run.snapshot_ref,
			budget_refs: [...budgetLimits.keys()],
			decision_refs: decisions.flatMap(decision => (decision.evidence_ref ? [decision.evidence_ref.id] : [])),
		},
	});
	for (const [memberId, member] of Object.entries(definition.members))
		add({
			kind: "execution_member",
			value: {
				graph_run_id: run.id,
				member_id: memberId,
				revision: "1",
				label: memberId,
				bot: binding.members[memberId].bot,
				duty: member.duty,
				model_binding_ref: binding.members[memberId].model_binding_ref,
				base_snapshot_ref: snapshot.members[memberId].base_snapshot_ref,
				communication_targets: [
					...new Set(
						(definition.communications ?? []).filter(grant => grant.from === memberId).map(grant => grant.to),
					),
				],
			},
		});
	const byInvocation = new Map<string, GraphDispatchIntent[]>();
	for (const intent of intents) {
		const list = byInvocation.get(intent.invocation_id);
		if (list) list.push(intent);
		else byInvocation.set(intent.invocation_id, [intent]);
	}
	const bindings = new Map<string, GraphWireBinding>();
	for (const record of previous.values())
		if (record.kind === "binding") bindings.set(record.value.binding_id, record.value);
	for (const invocation of state.invocations) {
		// Consultation executions can use another member under the same node ID. They are not topology nodes.
		if (invocation.consultation) continue;
		const node = definition.nodes[invocation.node];
		if (!node) throw new GraphWireError("invalid_input", "Invocation is absent from its frozen definition");
		const attempts = byInvocation.get(invocation.id) ?? [];
		const currentIntent = attempts.find(intent => intent.attempt_id === invocation.attempt_id);
		let queueWaitReason: string | null = null;
		if (
			node.kind === "queue" &&
			currentIntent &&
			!invocation.superseded &&
			["submitting", "accepted", "unknown"].includes(currentIntent.state) &&
			hasTable(db, "graph_queue_records")
		) {
			const row = db
				.query("SELECT data FROM graph_queue_records WHERE request_key=?")
				.get(currentIntent.request_key) as { data: string } | null;
			if (row) {
				const queued = JSON.parse(row.data) as QueueRecord;
				if (!queueRecordMatchesExecution(queued, currentIntent, node.executor))
					throw new GraphWireError("binding_conflict", "Queue observation differs from its frozen attempt");
				// Remote terminal state is still awaiting Host verification, not dependency success.
				queueWaitReason = `queue:${queued.state}`;
			}
		}
		add({
			kind: "execution_invocation",
			value: {
				graph_run_id: run.id,
				node_id: invocation.node,
				invocation_id: invocation.id,
				revision: "1",
				member_id: node.member ?? null,
				kind: node.kind,
				origin: invocation.origin ?? "executed",
				iteration: invocation.iteration,
				scope_id: invocation.scope_id,
				parent_invocation_id: null,
				state: invocation.state,
				selected_outcome: invocation.outcome ?? null,
				input_refs: [
					...new Set(
						Object.values(invocation.ready?.inputs ?? {}).flatMap(value =>
							typeof value === "string" ? [] : [value.id],
						),
					),
				],
				upstream_attempt_ids: invocation.ready?.upstream_attempt_ids ?? [],
				wait_reason: invocation.consultation_wait
					? "consultation"
					: currentIntent?.state === "unknown"
						? "dispatch_unknown"
						: invocation.state === "waiting" && node.kind === "human"
							? "human"
							: queueWaitReason,
				current_attempt_id: invocation.origin === "imported" ? null : (invocation.attempt_id ?? null),
			},
		});
		for (const [index, intent] of attempts.entries()) {
			const key = canonicalJson(["execution_attempt", run.id, intent.attempt_id]);
			const priorRecord = previous.get(key);
			const prior = priorRecord?.kind === "execution_attempt" ? priorRecord.value : null;
			const observation = object(intent.observation);
			const bot = node.kind === "bot" ? binding.members[node.member!].bot : null;
			const recovery = object(observation?.recovery);
			const jobId = identity(observation?.job_id) ?? identity(recovery?.job_id);
			const botId = identity(observation?.bot_id) ?? identity(recovery?.bot_id);
			if (jobId && bot && botId !== bot.bot_id)
				throw new GraphWireError("binding_conflict", "Observed Job differs from frozen Bot identity");
			if (jobId && prior?.job && jobId !== prior.job.job_id)
				throw new GraphWireError("binding_conflict", "Attempt cannot replace its admitted Bot Job");
			const executionRef = identity(observation?.execution_ref);
			if (executionRef && prior?.execution_ref && executionRef !== prior.execution_ref)
				throw new GraphWireError("binding_conflict", "Attempt cannot replace its admitted execution");
			const terminal = object(observation?.completion) ?? observation;
			const terminalState = terminal?.state;
			let attemptState: GraphWireExecutionAttempt["state"];
			if (intent.state === "cancelled") attemptState = "cancelled";
			else if (intent.state === "unknown") attemptState = "unknown";
			else if (
				intent.state === "finished" &&
				(terminalState === "succeeded" || terminalState === "failed" || terminalState === "cancelled")
			)
				attemptState = terminalState;
			else if (
				intent.attempt_id === invocation.attempt_id &&
				["succeeded", "failed", "cancelled", "unknown", "waiting"].includes(invocation.state)
			)
				attemptState = invocation.state as GraphWireExecutionAttempt["state"];
			else if (run.state === "cancelling") attemptState = "cancelling";
			else attemptState = "running";
			const job = prior?.job ?? (jobId && bot ? { ...bot, job_id: jobId } : null);
			add({
				kind: "execution_attempt",
				value: {
					graph_run_id: run.id,
					attempt_id: intent.attempt_id,
					invocation_id: invocation.id,
					revision: "1",
					number: index + 1,
					executor_kind: node.kind,
					state: attemptState,
					execution_ref: prior?.execution_ref ?? executionRef,
					// Completion outputs are an artifact map, not an invented singular result envelope.
					result_ref: prior?.result_ref ?? null,
					job,
				},
			});
			if (job) {
				const oldBinding = bindings.get(intent.attempt_id);
				const value: GraphWireBinding = {
					binding_id: intent.attempt_id,
					graph_run_id: run.id,
					node_id: invocation.node,
					invocation_id: invocation.id,
					attempt: index + 1,
					job,
					config_revision: binding.members[node.member!].config_revision,
					revision: "1",
					acceptance:
						attemptState === "succeeded"
							? "accepted"
							: attemptState === "unknown"
								? "unknown"
								: attemptState === "failed" || attemptState === "cancelled"
									? "rejected"
									: "pending",
					evidence_refs:
						intent.attempt_id === invocation.attempt_id
							? Object.values(invocation.outputs ?? {}).map(ref => ref.id)
							: (oldBinding?.evidence_refs ?? []),
					reason: null,
				};
				bindings.set(intent.attempt_id, value);
				add({ kind: "binding", value });
			}
		}
	}
	const invocations = new Map(state.invocations.map(invocation => [invocation.id, invocation]));
	for (const target of state.invocations) {
		if (target.consultation || !target.ready || !target.attempt_id) continue;
		const attempts = byInvocation.get(target.id) ?? [];
		const number = attempts.findIndex(intent => intent.attempt_id === target.attempt_id) + 1;
		if (!number) throw new GraphWireError("invalid_input", "Dependency target has no persisted attempt");
		for (const [edgeId, sourceId] of Object.entries(target.upstream)) {
			const source = invocations.get(sourceId);
			if (!source) throw new GraphWireError("invalid_input", "Dependency source invocation is missing");
			const sourceBinding = source.attempt_id ? bindings.get(source.attempt_id) : null;
			const evidence: GraphWireEvidence[] = sourceBinding
				? Object.values(source.outputs ?? {}).map(ref => ({
						source: {
							source_id: sourceBinding.job.source_id,
							profile_id: sourceBinding.job.profile_id,
							bot_id: sourceBinding.job.bot_id,
						},
						job_id: sourceBinding.job.job_id,
						artifact_id: ref.id,
						ref: ref.id,
					}))
				: [];
			const edge = definition.edges?.find(edge => edge.id === edgeId);
			if (!edge) throw new GraphWireError("invalid_input", "Dependency edge is missing from its frozen definition");
			const selected = graphReadyEdgeSelected(definition, target, source, edge);
			add({
				kind: "dependency",
				value: {
					dependency_id: canonicalJson([run.id, target.attempt_id, edgeId]),
					graph_run_id: run.id,
					edge_id: edgeId,
					target_invocation_id: target.id,
					target_attempt: number,
					revision: "1",
					state: selected ? "satisfied" : "rejected",
					reason: selected ? null : "not_selected",
					evidence: selected ? evidence : [],
				},
			});
		}
	}
	if (hasTable(db, "graph_bot_handoffs")) {
		const rows = db.query("SELECT data FROM graph_bot_handoffs WHERE run_id=? ORDER BY rowid").all(run.id) as {
			data: string;
		}[];
		const published = new Set<string>();
		for (const row of rows) {
			const handoff = JSON.parse(row.data) as GraphBotHandoffRecord;
			const target = bindings.get(handoff.attempt_id);
			const targetNode = target && definition.nodes[target.node_id];
			if (!target || targetNode?.kind !== "bot" || target.job.bot_id !== handoff.bot_id) continue;
			if (
				handoff.receipt &&
				(handoff.receipt.job_id !== target.job.job_id || handoff.receipt.bot_id !== target.job.bot_id)
			)
				throw new GraphWireError("binding_conflict", "Handoff receipt differs from its target Binding");
			for (const mapped of handoff.handoffs) {
				const source = bindings.get(mapped.from_binding_id);
				if (!source || definition.nodes[source.node_id]?.kind !== "bot") continue;
				const edge = definition.edges?.find(edge => edge.id === mapped.edge_id);
				if (
					!edge ||
					edge.from !== source.node_id ||
					edge.to !== target.node_id ||
					canonicalJson(mapped.artifact.source) !==
						canonicalJson({
							source_id: source.job.source_id,
							profile_id: source.job.profile_id,
							bot_id: source.job.bot_id,
						}) ||
					mapped.artifact.job_id !== source.job.job_id
				)
					throw new GraphWireError("binding_conflict", "Handoff differs from its frozen source Binding");
				const transferId = canonicalJson([
					run.id,
					mapped.edge_id,
					source.binding_id,
					target.binding_id,
					mapped.reference,
				]);
				if (published.has(transferId)) continue;
				published.add(transferId);
				add({
					kind: "transfer",
					value: {
						transfer_id: transferId,
						graph_run_id: run.id,
						edge_id: mapped.edge_id,
						from_binding_id: source.binding_id,
						to_binding_id: target.binding_id,
						artifact: mapped.artifact,
						revision: "1",
						state: handoff.receipt ? "delivered" : "unknown",
						reason: handoff.receipt ? null : "mailbox_admission_unconfirmed",
						occurred_at: handoff.occurred_at ?? run.created_at,
					},
				});
			}
		}
	}
	if (hasTable(db, "consultations")) {
		const conversations = db.query("SELECT data FROM consultations WHERE run_id=? ORDER BY rowid").all(run.id) as {
			data: string;
		}[];
		for (const row of conversations) {
			const conversation = JSON.parse(row.data) as Consultation;
			const messages = (
				db
					.query("SELECT data FROM consultation_messages WHERE conversation_id=? ORDER BY seq")
					.all(conversation.id) as { data: string }[]
			).map(message => JSON.parse(message.data) as ConsultationMessage);
			if (!messages.length) throw new GraphWireError("invalid_input", "Conversation has no persisted request");
			add({
				kind: "execution_conversation",
				value: {
					graph_run_id: run.id,
					conversation_id: conversation.id,
					revision: "1",
					requester_member: conversation.requester,
					responder_member: conversation.responder,
					state: conversation.state,
					remaining_rounds: conversation.remaining_rounds,
					deadline: new Date(conversation.deadline).toISOString(),
					content_ref: messages[0].content_ref.id,
					message_refs: messages.map(message => message.content_ref.id),
				},
			});
		}
	}
	if (changes.length) ledger.publish(binding.source_id, changes, new Date().toISOString());
}

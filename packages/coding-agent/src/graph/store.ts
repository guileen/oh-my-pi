import { Database } from "bun:sqlite";
import * as path from "node:path";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import { isPidAlive, tryAcquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils";
import type { BotStore } from "../bots/store";
import {
	GraphArtifactRegistry,
	type GraphArtifactRegistryOptions,
	type PreparedArtifactRegistration,
} from "./artifacts";
import { GraphAuthoringService, type GraphOperation } from "./authoring";
import {
	createChildExecution,
	hasRunningChildExecution,
	hasUnaggregatedChildExecution,
	installChildExecutionSchema,
	reconcileChildExecution,
	recoverChildExecutions,
	type ChildExecutionHost,
	type ChildExecutionRecovery,
	type ChildExecutionRecord,
	type ChildCreateResult,
	type ChildIdentity,
	type ChildIsolation,
	type ChildParentAuthority,
} from "./child-execution";
import { resolveChildOutputCandidates, validateChildOutputBindings, type ChildOutputBindings } from "./child-outputs";
import {
	GRAPH_DEFAULT_STALL_THRESHOLD_MS,
	GRAPH_NOTIFICATION_FORMAT,
	GraphWireError,
	type GraphNotification,
	type GraphNotificationKind,
	type GraphNotificationOutput,
	type GraphRef,
	type GraphRunState,
} from "@oh-my-pi/pi-wire/graph";
import type { GraphDefinition, GraphOutput } from "./contracts";
import { type GraphLimits, validateGraphForStart } from "./definition";
import {
	queueRecordMatchesExecution,
	type QueueObservation,
	type QueueRecord,
	type QueueStateStore,
} from "./executors/queue";
import { verifyFinalReview, type FinalReviewAuthority, type FinalReviewClaim } from "./final-review";
import { GraphGrantError, GraphGrants, installGraphGrantSchema, type GraphGrantOptions } from "./grants";
import { renderGraphBotHandoff, selectGraphBotHandoffs, type GraphBotHandoffRecord } from "./handoff";
import {
	GraphHumanDecisions,
	GraphHumanError,
	type GraphHumanAnswer,
	type GraphHumanDecision,
	type GraphHumanDecisionOptions,
	type GraphHumanEvidence,
	type GraphHumanEvidenceScope,
	type GraphHumanQuestion,
} from "./human";
import { graphRecordedView } from "./observation-record";
import { readDeclaredContract } from "./contract-meta";
import {
	type GraphInvocationActivity,
	readGraphFrozenDefinition,
	readGraphInvocationActivity,
	readGraphRun,
	readGraphRunSnapshot,
	readGraphScheduleState,
} from "./read-profile";
import { validateGraphOutputContent } from "./output-validation";
import { prepareGraphRewind } from "./rewind";
import {
	graphCompletionError,
	graphReservationRequirements,
	planGraphSchedule,
	type SchedulerAction,
	type SchedulerInvocation,
	type SchedulerState,
} from "./scheduler";
import type { GraphCompletionCandidate, GraphCompletionReceipt } from "../tools/graph-complete";
import { GraphConsultationStore, type ConsultationAuthority, type ConsultationIdentity } from "./consultation";
import {
	GraphScreenwritingPublications,
	type PreparedScreenwritingPublication,
	type ScreenwritingPublicationAuthority,
	type ScreenwritingPublicationTarget,
} from "./screenwriting-publication";
import { GraphStartDescriptors, type GraphStartDescriptorPolicy } from "./start-descriptor";
import { GraphTextPublications, GraphTextPublicationError, type GraphTextPublicationPolicy } from "./text-publication";
import {
	acceptanceApplies,
	freezeIntegration,
	integrationVersion,
	runFrozenAcceptance,
	type AcceptanceEvidence,
	type AcceptanceExecutionIdentity,
	type AcceptanceExecutionReceipt,
	type AcceptanceExecutionStopped,
	type AcceptanceHost,
	type AcceptanceRequest,
	type FrozenIntegration,
	type IntegrationSnapshot,
	type RecordedAcceptanceExecution,
} from "./subgraph-freeze";
import { GraphUsageLedger, installGraphUsageSchema, type GraphUsageSummary } from "./usage";
import { publishGraphWireLifecycle } from "./wire-lifecycle";
import { GraphWireLedger } from "./wire-ledger";
import {
	installGraphWirePublicationSchema,
	registerGraphObservationSources,
	validateGraphPreparedObservation,
	type GraphPreparedObservation,
} from "./wire-publication";

interface ChildOutputProof {
	outputs: Record<string, GraphRef>;
	sources: Record<string, { declaration: GraphOutput; producer_attempt_id: string }>;
	version: string;
}

/** Trusted preflight certifies provenance, authorization and applicability to the exact definition,
 * run inputs and imported-output set. Caller-provided refs alone are not evidence. */
export interface GraphPreparedImport {
	outputs: Record<string, GraphRef>;
	source_ref: GraphRef;
	definition_digest: string;
	authorization_ref: GraphRef;
	run_inputs: Record<string, GraphRef>;
	provided_outputs: Record<string, Record<string, GraphRef>>;
}

/** All values are identities or immutable refs resolved by the trusted preflight, never credentials. */
export interface GraphPreparedRun {
	graph_id: string;
	definition_revision: string;
	definition_digest: string;
	authorization_ref: GraphRef;
	inputs: Record<string, GraphRef>;
	members: Record<
		string,
		{
			provider: string;
			model: string;
			configuration_revision: string;
			base: "omp-default" | "isolated";
			base_snapshot_ref: GraphRef;
			role_ref: GraphRef;
			skill_refs: GraphRef[];
			rule_refs: GraphRef[];
		}
	>;
	executors: Record<string, GraphRef>;
	imports?: Record<string, GraphPreparedImport>;
	/** Optional trusted deployment binding. Absence means no wire publication, not unknown Bot identity. */
	observation?: GraphPreparedObservation;
	/** Caller-supplied task label echoed by the Run index and the notification outbox. */
	title?: string;
	/** Caller-declared address for delivery agents; never interpreted as authority. */
	report_to?: string;
}

export interface GraphRunSnapshot extends GraphPreparedRun {
	definition: string;
}

export interface GraphStartRequest {
	version: 1;
	request_key: string;
	operation: "start";
	target_id: string;
	if_revision: string;
	payload: {
		inputs: Record<string, GraphRef>;
		authorization_ref: GraphRef;
		entry_nodes?: string[];
		provided_outputs?: Record<string, Record<string, GraphRef>>;
	};
}
export type GraphLifecycleRequest = {
	version: 1;
	request_key: string;
	target_id: string;
	if_revision: string;
} & (
	| { operation: "cancel"; payload: { reason: string } }
	/** `operator` is a scheduling pause the same principal may lift; `gate` (default) needs a
	 * resolved decision reference. */
	| { operation: "hold"; payload: { reason: string; kind?: GraphHoldKind } }
	| { operation: "resume"; payload: { decision_ref: GraphRef } | { kind: "operator" } }
);

export type GraphHoldKind = "operator" | "gate";

/** Trusted synchronous policy, called inside the transaction. Authentication is required even on
 * receipt replay. The resume verifier must resolve the immutable decision and verify that it
 * resolves every current hold reason for this exact run revision and scheduling evidence. */
export interface GraphLifecyclePolicy {
	authorize(principal: string, request: GraphLifecycleRequest): boolean;
	verifyResume(
		principal: string,
		request: Extract<GraphLifecycleRequest, { operation: "resume" }>,
		context: { run: GraphRunRecord; schedule: GraphScheduleState; intents: GraphDispatchIntent[] },
	): boolean;
}

export interface GraphRunRecord {
	id: string;
	revision: string;
	created_at: string;
	updated_at: string;
	graph_id: string;
	definition_revision: string;
	definition_digest: string;
	snapshot_ref: GraphRef;
	state: GraphRunState;
	reason: string | null;
	/** Why the Run is held; `operator` pauses are resumable by the principal that held them. */
	hold_kind?: GraphHoldKind;
	/** Principal that last held the Run; readers may show it, policies gate resume on it. */
	held_by?: string;
	authorization_ref: GraphRef;
	/** Sampled cumulative Bot usage including contained Runs; excludes unobserved and non-Bot costs. */
	observed_bot_usage?: GraphUsageSummary;
	/** Frozen definition name at start; readers never re-parse the definition for a label. */
	graph_name?: string;
	/** Caller-supplied task label; absent when the caller dispatched without one. */
	title?: string;
	/** Caller-declared notification address; the outbox itself delivers nothing. */
	report_to?: string;
}

/** Trusted policy, never supplied by Graph content. Callbacks run synchronously in
 * the owner's transaction and must not launch work or consume another budget. */
export interface GraphChildDispatchPolicy {
	authorize(
		db: Database,
		context: {
			phase: "reserve" | "dispatch" | "create";
			run: GraphRunRecord;
			snapshot: GraphRunSnapshot;
			invocation: SchedulerInvocation;
		},
	): boolean;
}

export interface GraphDispatchIntent {
	id: string;
	run_id: string;
	invocation_id: string;
	attempt_id: string;
	request_key: string;
	fence: string;
	state: "pending" | "submitting" | "accepted" | "unknown" | "finished" | "cancelled";
	request: unknown;
	observation: unknown | null;
}

export interface GraphProgramStopped {
	identity: Pick<GraphDispatchIntent, "run_id" | "invocation_id" | "attempt_id" | "fence" | "request_key"> & {
		intent_id: string;
	};
	if_revision: string;
	termination_ref: GraphRef;
	observed: string;
}

export interface GraphUnstartedChildStopped {
	parent: ChildIdentity;
	if_revision: string;
	termination_ref: GraphRef;
	observed: string;
}

export interface GraphProgramRecoveryReceipt {
	identity: GraphProgramStopped["identity"];
	completion: GraphAttemptCompletion;
	revision: string;
}

/** Trusted operator attestation that this exact Bot attempt stopped. A local Bot
 * attempt has no executor reference to query, so the observation is the evidence. */
export interface GraphBotStopped {
	identity: GraphProgramStopped["identity"];
	if_revision: string;
	termination_ref: GraphRef;
	observed: string;
}

export interface GraphBotRecoveryReceipt {
	identity: GraphBotStopped["identity"];
	completion: GraphAttemptCompletion;
	revision: string;
}

export interface GraphProfileWriterAdmission {
	run_id: string;
	admission_id: string;
}

export interface GraphProfileWriterStopped {
	identity: GraphProfileWriterAdmission;
	if_revision: string;
	termination_ref: GraphRef;
	observed: string;
}

export interface GraphProfileWriterReceipt {
	identity: GraphProfileWriterAdmission;
	revision: string;
}

/** Trusted whole-parent quiescence observation before lending its writer scope to a
 * serial child. This is not OS isolation and is never accepted from Graph content. */
export interface GraphSerialChildWriterRequest {
	parent: ChildIdentity;
	child_run_id: string;
	if_parent_revision: string;
	if_child_revision: string;
	termination_ref: GraphRef;
	observed: string;
}

export interface GraphSerialChildLaunchAuthority {
	policy: GraphChildDispatchPolicy;
	stopped: Pick<GraphSerialChildWriterRequest, "if_parent_revision" | "termination_ref" | "observed">;
}

export interface GraphSerialChildWriterAdmission {
	scope_id: string;
	child_run_id: string;
}

export interface GraphSerialChildWriterStopped {
	identity: GraphSerialChildWriterAdmission;
	if_revision: string;
	termination_ref: GraphRef;
	observed: string;
}

export interface GraphSerialChildAggregation {
	parent: ChildIdentity;
	principal: string;
	stopped: GraphSerialChildWriterStopped;
	outcome: string;
	verdict?: string;
	integration_ref: GraphRef;
	observed: string;
}

export interface GraphSerialChildSettlement {
	parent: ChildIdentity;
	stopped: GraphSerialChildWriterStopped;
}

interface SerialChildWriterRecord {
	request: GraphSerialChildWriterRequest;
	admission: GraphSerialChildWriterAdmission;
	writer: GraphProfileWriterAdmission;
}

export interface GraphAttemptCompletion {
	run_id: string;
	invocation_id: string;
	attempt_id: string;
	fence: string;
	state: "succeeded" | "failed" | "cancelled";
	error?: string | null;
	outcome?: string | null;
	verdict?: string | null;
	outputs?: Record<string, GraphRef>;
}

export interface GraphScheduleResult {
	action: SchedulerAction | null;
	intent: GraphDispatchIntent | null;
	run: GraphRunRecord;
}

/** The store constructs this binding from the persisted invocation, never from the reviewer. */
export interface GraphFinalReviewContext {
	run: GraphRunRecord;
	invocation_id: string;
	attempt_id: string;
	activation_source: NonNullable<GraphStoredInvocation["activation_source"]>;
	inputs: NonNullable<GraphStoredInvocation["ready"]>["inputs"];
	outputs: Record<string, GraphRef>;
	binding: Pick<FinalReviewAuthority, "invocation_id" | "input_digest" | "artifacts">;
}

export interface GraphFinalReviewResolution {
	blocker_ids: string[];
	inventory_evidence: GraphRef;
	submission: unknown;
}

/** Trusted host callbacks must resolve the complete inventory and immutable review submission.
 * They run synchronously within the same transaction as routing. */
export interface GraphFinalReviewPolicy {
	resolve(context: GraphFinalReviewContext): GraphFinalReviewResolution | null;
	verifyEvidence(claim: FinalReviewClaim, context: GraphFinalReviewContext): boolean;
}

export type GraphStoredInvocation = SchedulerInvocation & {
	ready?: Extract<SchedulerAction, { type: "ready" }>;
	terminal_disposition?: "succeed" | "fail";
	import_evidence?: GraphPreparedImport;
	final_review_evidence?: { authority: FinalReviewAuthority; submission: unknown; attempt_id: string };
	activation_source?: { invocation_id: string; attempt_id?: string; reason: "loop_exhausted" | "budget_exhausted" };
};

export interface GraphScheduleState extends Omit<SchedulerState, "invocations"> {
	invocations: GraphStoredInvocation[];
}

/** A raised `run.stalled` alarm: which Run, for which liveness instant, at which threshold. */
export interface GraphStallAlarm {
	run_id: string;
	activity_at: string;
	threshold_ms: number;
}

const TERMINAL_RUN_STATES: ReadonlySet<GraphRunState> = new Set(["succeeded", "failed", "cancelled", "unknown"]);

/** Terminal and attention transitions that a dispatcher must observe; nothing else is notified. */
const RUN_NOTIFICATION_KINDS: Partial<Record<GraphRunState, GraphNotificationKind>> = {
	succeeded: "run.succeeded",
	failed: "run.failed",
	cancelled: "run.cancelled",
	held: "run.held",
};

/** Read through a call so control-flow narrowing cannot assume a pre-transition state. */
const runStateOf = (run: GraphRunRecord): GraphRunState => run.state;

/** Profile-local Graph run state. External side effects must occur after committing an intent. */
export class GraphRunStore implements QueueStateStore {
	readonly definitions: GraphAuthoringService;
	readonly #db: Database;
	readonly #limits: GraphLimits;
	readonly #wire: GraphWireLedger;
	#artifacts: GraphArtifactRegistry | undefined;
	#consultation: GraphConsultationStore | undefined;
	#human: GraphHumanDecisions | undefined;
	#lifecycle: GraphLifecyclePolicy | undefined;
	#grants: GraphGrants | undefined;
	#screenwriting: GraphScreenwritingPublications | undefined;
	#startDescriptors: GraphStartDescriptors | undefined;
	#textPublications: GraphTextPublications | undefined;
	#ownerLock: FileLockHandle | null = null;
	#ownerId: string | null = null;
	#ownerEpoch: string | null = null;

	constructor(limits: GraphLimits, root?: string) {
		this.#limits = { ...limits };
		this.definitions = new GraphAuthoringService(limits, root);
		let opened: Database | undefined;
		try {
			opened = this.#db = new Database(path.join(this.definitions.root, "graphs.sqlite"));
			this.#db.exec(
				"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
			);
			this.#db.exec(`
CREATE TABLE IF NOT EXISTS graph_runs (id TEXT PRIMARY KEY, revision TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_run_snapshots (id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_run_budgets (run_id TEXT NOT NULL REFERENCES graph_runs(id), scope_key TEXT NOT NULL, budget_key TEXT NOT NULL, limit_count INTEGER NOT NULL, consumed INTEGER NOT NULL, PRIMARY KEY(run_id,scope_key,budget_key));
CREATE TABLE IF NOT EXISTS graph_budget_reservations (run_id TEXT NOT NULL, scope_key TEXT NOT NULL, budget_key TEXT NOT NULL, reservation_key TEXT NOT NULL, PRIMARY KEY(run_id,scope_key,budget_key,reservation_key), FOREIGN KEY(run_id,scope_key,budget_key) REFERENCES graph_run_budgets(run_id,scope_key,budget_key));
CREATE TABLE IF NOT EXISTS graph_dispatch_intents (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES graph_runs(id), request_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_program_reconciliations (intent_id TEXT PRIMARY KEY REFERENCES graph_dispatch_intents(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_bot_reconciliations (intent_id TEXT PRIMARY KEY REFERENCES graph_dispatch_intents(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_bot_handoffs (intent_id TEXT PRIMARY KEY REFERENCES graph_dispatch_intents(id), run_id TEXT NOT NULL REFERENCES graph_runs(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_queue_records (request_key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_queue_quarantine (id INTEGER PRIMARY KEY, data TEXT NOT NULL, reason TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_host_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL, owner_id TEXT, pid INTEGER);
INSERT OR IGNORE INTO graph_host_owner VALUES (1,'0',NULL,NULL);
CREATE TABLE IF NOT EXISTS graph_journals (run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), journal_id TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS graph_notifications (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES graph_runs(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,seq));
CREATE INDEX IF NOT EXISTS graph_notifications_created ON graph_notifications(created_at,seq);
CREATE TABLE IF NOT EXISTS graph_invocation_activity (run_id TEXT NOT NULL REFERENCES graph_runs(id), invocation_id TEXT NOT NULL, node TEXT NOT NULL, started_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, turns INTEGER NOT NULL, summary TEXT, PRIMARY KEY(run_id,invocation_id));
CREATE TABLE IF NOT EXISTS graph_events (journal_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(journal_id,seq));
CREATE TABLE IF NOT EXISTS graph_observation_replacements (journal_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(journal_id,seq), FOREIGN KEY(journal_id,seq) REFERENCES graph_events(journal_id,seq) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS graph_bot_completions (attempt_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_schedule_states (run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_attempt_history (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, invocation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, fence TEXT NOT NULL, accepted INTEGER NOT NULL, data TEXT NOT NULL, recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_schedule_sequences (run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), completion_order INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS graph_integration_freezes (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES graph_runs(id), data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_acceptance_evidence (id TEXT PRIMARY KEY, freeze_id TEXT NOT NULL REFERENCES graph_integration_freezes(id), data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_acceptance_executions (id TEXT PRIMARY KEY REFERENCES graph_acceptance_evidence(id), run_id TEXT NOT NULL REFERENCES graph_runs(id), state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS graph_acceptance_executions_run ON graph_acceptance_executions(run_id,state);
CREATE TABLE IF NOT EXISTS graph_acceptance_reconciliations (id TEXT PRIMARY KEY REFERENCES graph_acceptance_executions(id), data TEXT NOT NULL);
-- Legacy pending receipts have no execution state. Treat them as unresolved, never as stopped.
INSERT OR IGNORE INTO graph_acceptance_executions
SELECT evidence.id,freeze.run_id,'unknown' FROM graph_acceptance_evidence evidence
JOIN graph_integration_freezes freeze ON freeze.id=evidence.freeze_id
WHERE json_extract(evidence.data,'$.status')='hold'
AND json_extract(evidence.data,'$.reason')='Acceptance started but its result is not durably recorded';
CREATE TABLE IF NOT EXISTS graph_granted_runs (run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), owner TEXT NOT NULL, grant_id TEXT NOT NULL, grant_digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_child_output_bindings (child_run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_child_plan_inputs (child_run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_child_aggregation_receipts (child_run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_child_settlement_receipts (child_run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_unstarted_child_receipts (invocation_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_profile_writers (run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), admission_id TEXT NOT NULL UNIQUE, receipt TEXT);
CREATE TABLE IF NOT EXISTS graph_profile_writer_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS graph_start_descriptors (request_key TEXT PRIMARY KEY, graph_id TEXT NOT NULL, artifact_id TEXT NOT NULL, artifact_digest TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS graph_start_descriptors_graph ON graph_start_descriptors(graph_id,created_at);
CREATE TABLE IF NOT EXISTS graph_serial_child_writers (child_run_id TEXT PRIMARY KEY REFERENCES graph_runs(id), parent_run_id TEXT NOT NULL REFERENCES graph_runs(id), data TEXT NOT NULL, receipt TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS graph_serial_child_writer_active ON graph_serial_child_writers(parent_run_id) WHERE receipt IS NULL;
`);
			installChildExecutionSchema(this.#db);
			installGraphGrantSchema(this.#db);
			installGraphUsageSchema(this.#db);
			this.#wire = new GraphWireLedger(this.#db);
			installGraphWirePublicationSchema(this.#db);
			this.#migrateProfileWriters();
		} catch (error) {
			opened?.close();
			this.definitions.close();
			throw error;
		}
	}

	/** Hold the OS lock for the entire owner lifetime; a live previous PID is never preempted. */
	claimHost(): { owner_id: string; epoch: string } | null {
		this.definitions.assertProfileAccess();
		if (this.#ownerLock && this.#ownerId && this.#ownerEpoch)
			return { owner_id: this.#ownerId, epoch: this.#ownerEpoch };
		const lock = tryAcquireFileLock(path.join(this.definitions.root, "host-owner"));
		if (!lock) return null;
		try {
			const claim = this.#db
				.transaction(() => {
					const row = this.#db
						.query("SELECT epoch,owner_id,pid FROM graph_host_owner WHERE singleton=1")
						.get() as {
						epoch: string;
						owner_id: string | null;
						pid: number | null;
					};
					if (row.owner_id && row.pid !== null && isPidAlive(row.pid)) return null;
					const owner_id = crypto.randomUUID();
					const epoch = (BigInt(row.epoch) + 1n).toString();
					this.#db
						.query("UPDATE graph_host_owner SET epoch=?,owner_id=?,pid=? WHERE singleton=1")
						.run(epoch, owner_id, process.pid);
					return { owner_id, epoch };
				})
				.immediate();
			if (!claim) {
				lock.release();
				return null;
			}
			this.#ownerLock = lock;
			this.#ownerId = claim.owner_id;
			this.#ownerEpoch = claim.epoch;
			return claim;
		} catch (error) {
			lock.release();
			throw error;
		}
	}

	assertHostOwner(ownerId: string, epoch: string): void {
		this.definitions.assertProfileAccess();
		const row = this.#db.query("SELECT owner_id,epoch FROM graph_host_owner WHERE singleton=1").get() as {
			owner_id: string | null;
			epoch: string;
		};
		if (
			!this.#ownerLock ||
			this.#ownerId !== ownerId ||
			this.#ownerEpoch !== epoch ||
			row.owner_id !== ownerId ||
			row.epoch !== epoch
		) {
			throw new Error("Graph host ownership is stale");
		}
	}

	close(): void {
		try {
			if (this.#ownerLock)
				this.#db
					.query("UPDATE graph_host_owner SET owner_id=NULL,pid=NULL WHERE singleton=1 AND owner_id=? AND epoch=?")
					.run(this.#ownerId, this.#ownerEpoch);
		} finally {
			this.#ownerLock?.release();
			this.#ownerLock = null;
			this.#db.close();
			this.definitions.close();
		}
	}

	/** Configure once from trusted host policy; registrations share the run transaction. */
	configureArtifacts(options: Pick<GraphArtifactRegistryOptions, "maxBytes" | "authorize">): GraphArtifactRegistry {
		this.definitions.assertProfileAccess();
		if (this.#artifacts) throw new Error("Graph artifact policy is already configured");
		this.#artifacts = new GraphArtifactRegistry({ ...options, root: this.definitions.root, database: this.#db });
		return this.#artifacts;
	}

	/**
	 * Host-only start descriptor supply. A descriptor narrows what a dispatcher may start; it
	 * grants nothing on its own, and the worker still re-validates the same bytes it receives.
	 */
	configureStartDescriptors(policy: GraphStartDescriptorPolicy): GraphStartDescriptors {
		this.definitions.assertProfileAccess();
		if (this.#startDescriptors) throw new Error("Graph start descriptor policy is already configured");
		// A second registry over the same database and artifact directory: the tables and files
		// are shared, and the descriptor policy never widens the artifact policy of a Run.
		const artifacts = new GraphArtifactRegistry({
			root: this.definitions.root,
			database: this.#db,
			maxBytes: policy.maxBytes,
			authorize: policy.authorizeArtifact,
		});
		const descriptors = new GraphStartDescriptors({
			database: this.#db,
			artifacts,
			policy,
			assertAccess: () => this.definitions.assertProfileAccess(),
		});
		this.#startDescriptors = descriptors;
		return descriptors;
	}

	/** Dedicated trusted text policy; existing artifact policy cannot be silently replaced or widened. */
	configureTextPublications(policy: GraphTextPublicationPolicy): GraphTextPublications {
		this.definitions.assertProfileAccess();
		if (this.#textPublications || this.#artifacts)
			throw new GraphTextPublicationError(
				"capability_unavailable",
				"Text publication requires a fresh artifact policy",
			);
		if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 0)
			throw new GraphTextPublicationError("definition_invalid", "Invalid text publication size limit");
		const artifacts = new GraphArtifactRegistry({
			root: this.definitions.root,
			database: this.#db,
			maxBytes: policy.maxBytes,
			authorize: policy.authorizeArtifact,
		});
		const publications = new GraphTextPublications({
			database: this.#db,
			artifacts,
			policy,
			assertAccess: () => this.definitions.assertProfileAccess(),
		});
		this.#artifacts = artifacts;
		this.#textPublications = publications;
		return publications;
	}

	/** Host-only bounded publication. Approval history is insufficient: each publication is
	 * fenced against the current owner, Run revision and exact approved invocation inputs. */
	configureScreenwritingPublications(): GraphScreenwritingPublications {
		this.definitions.assertProfileAccess();
		if (this.#screenwriting) throw new Error("Graph screenwriting publication is already configured");
		const artifacts = this.#artifacts;
		const human = this.#human;
		if (!artifacts || !human) throw new Error("Graph artifact and human policies must be configured first");
		this.#screenwriting = new GraphScreenwritingPublications({
			database: this.#db,
			artifacts,
			human: { getHumanEvidence: (principal, reference, scope) => human.getEvidence(principal, reference, scope) },
			assertOwner: () => {
				if (!this.#ownerId || !this.#ownerEpoch) throw new Error("Graph host ownership is unavailable");
				this.assertHostOwner(this.#ownerId, this.#ownerEpoch);
			},
			checkCurrent: (proposal, revision) => {
				const run = this.getRun(proposal.run_id);
				const invocation = this.getScheduleState(proposal.run_id)?.invocations.find(
					item => item.id === proposal.invocation_id,
				);
				if (
					!run ||
					run.state !== "running" ||
					run.revision !== revision ||
					run.definition_digest !== proposal.source_revision ||
					!invocation?.ready ||
					invocation.superseded ||
					invocation.state !== "succeeded" ||
					invocation.origin !== "executed" ||
					invocation.outcome !== "approve" ||
					invocation.verdict !== "APPROVE" ||
					this.getFrozenDefinition(run.id)?.nodes[invocation.node]?.kind !== "human"
				)
					throw new GraphHumanError("input_stale", "Screenwriting approval is not currently applicable");
				const inputs = invocation.ready.inputs;
				const hasRef = (ref: GraphRef) =>
					Object.values(inputs).some(
						value => typeof value !== "string" && value.id === ref.id && value.digest === ref.digest,
					);
				if (
					proposal.input_digest !== `sha256:${Bun.SHA256.hash(canonicalJson(inputs), "hex")}` ||
					!hasRef(proposal.subject) ||
					!hasRef(proposal.change_scope)
				)
					throw new GraphHumanError("input_stale", "Screenwriting proposal does not match the approved inputs");
			},
		});
		return this.#screenwriting;
	}

	issueScreenwritingPublication(
		ownerId: string,
		epoch: string,
		authority: ScreenwritingPublicationAuthority,
	): GraphRef {
		const publications = this.#screenwriting;
		if (!publications) throw new Error("Graph screenwriting publication is not configured");
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				return publications.issue(authority);
			})
			.immediate();
	}

	revokeScreenwritingPublication(ownerId: string, epoch: string, authority: GraphRef): void {
		const publications = this.#screenwriting;
		if (!publications) throw new Error("Graph screenwriting publication is not configured");
		this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				publications.revoke(authority);
			})
			.immediate();
	}

	/** Trusted completion only, after executor termination has been independently confirmed.
	 * Does not dispatch protected revisions or infer author permission from model text. */
	completeScreenwritingPublication(
		ownerId: string,
		epoch: string,
		publication: PreparedScreenwritingPublication,
		target: ScreenwritingPublicationTarget,
	): GraphRef {
		const publications = this.#screenwriting;
		if (!publications || !this.#artifacts) throw new Error("Graph screenwriting publication is not configured");
		const captured = structuredClone(target);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				return publications.commitToAttempt(publication, captured, (result, registration, proposal) => {
					const invocation = this.getScheduleState(captured.run_id)?.invocations.find(
						item => item.id === captured.invocation_id,
					);
					const node = invocation && this.getFrozenDefinition(captured.run_id)?.nodes[invocation.node];
					const output = node?.outputs?.[captured.output];
					const artifact = this.#artifacts!.lookup(result);
					const hasInput = (ref: GraphRef) =>
						Object.values(invocation?.ready?.inputs ?? {}).some(
							value => typeof value !== "string" && value.id === ref.id && value.digest === ref.digest,
						);
					if (
						!node ||
						(node.kind !== "bot" && node.kind !== "program") ||
						!output ||
						output.schema_ref ||
						!artifact ||
						artifact.availability !== "available" ||
						output.media_type !== artifact.media_type ||
						!hasInput(proposal.subject) ||
						!hasInput(proposal.change_scope)
					)
						throw new GraphHumanError("permission_denied", "Task is not bound to this approved revision");
					if (
						!this.completeAttempt(
							ownerId,
							epoch,
							{
								run_id: captured.run_id,
								invocation_id: captured.invocation_id,
								attempt_id: captured.attempt_id,
								fence: captured.fence,
								state: "succeeded",
								outcome: captured.outcome,
								...(captured.verdict === undefined ? {} : { verdict: captured.verdict }),
								outputs: { [captured.output]: result },
							},
							registration,
						)
					)
						throw new GraphHumanError("input_stale", "Publication task attempt is not current");
				});
			})
			.immediate();
	}

	/** Install a trusted grant authority; current definition identity is verified by this store. */
	configureGrants(authorize: GraphGrantOptions["authorize"]): GraphGrants {
		this.definitions.assertProfileAccess();
		if (this.#grants) throw new Error("Graph grant authority is already configured");
		this.#grants = new GraphGrants({
			database: this.#db,
			authorize,
			definitionCurrent: (db, scope) => {
				const row = db
					.query(
						"SELECT s.revision,s.digest FROM graph_definitions d JOIN graph_snapshots s ON s.graph_id=d.graph_id AND s.revision=d.revision WHERE d.graph_id=?",
					)
					.get(scope.graph_id) as { revision: string; digest: string } | null;
				return !!row && row.revision === scope.definition_revision && row.digest === scope.definition_digest;
			},
		});
		return this.#grants;
	}

	/** Install deployment authority constrained by this Run's immutable communication grants. */
	configureConsultation(authority: ConsultationAuthority): GraphConsultationStore {
		this.definitions.assertProfileAccess();
		if (this.#consultation) throw new Error("Graph consultation policy is already configured");
		const reserve = authority.reserve?.bind(authority);
		this.#consultation = new GraphConsultationStore(
			this.#db,
			{
				validate: authority.validate.bind(authority),
				artifacts: authority.artifacts.bind(authority),
				reserve: reserve
					? (db, identity, key, policy) => reserve(db, structuredClone(identity), key, { ...policy })
					: undefined,
				delivery: authority.delivery?.bind(authority),
				participant: authority.participant?.bind(authority),
				policy: (db, identity, recipient, refs) => {
					const definition = this.getFrozenDefinition(identity.run_id);
					const grants = definition?.communications?.filter(
						grant => grant.from === identity.member_id && grant.to === recipient,
					);
					if (!definition || !grants?.length) return null;
					const policy = authority.policy(db, structuredClone(identity), recipient, structuredClone(refs));
					if (
						!policy ||
						!Number.isSafeInteger(policy.max_rounds) ||
						policy.max_rounds < 0 ||
						!Number.isSafeInteger(policy.timeout_ms) ||
						policy.timeout_ms <= 0
					)
						return null;
					let maxRounds = policy.max_rounds;
					let timeoutMs = policy.timeout_ms;
					for (const grant of grants) {
						maxRounds = Math.min(maxRounds, grant.max_rounds ?? definition.policy?.max_consultation_rounds ?? 6);
						timeoutMs = Math.min(
							timeoutMs,
							grant.timeout_ms ?? definition.policy?.consultation_timeout_ms ?? 600000,
						);
					}
					return { max_rounds: maxRounds, timeout_ms: timeoutMs };
				},
			},
			Date.now,
			runId => {
				const run = this.getRun(runId);
				const state = this.getScheduleState(runId);
				if (!run || !state) throw new Error("Consultation Run state is missing");
				this.#publishWireLifecycle(run, state);
			},
		);
		return this.#consultation;
	}

	/** The adapter is trusted host code and all its callbacks share this store's transaction.
	 * These entrypoints do not enable subgraph scheduling or supply isolation by themselves. */
	createChildExecution(
		ownerId: string,
		epoch: string,
		host: ChildExecutionHost,
		identity: ChildIdentity,
		source: string,
		isolation: ChildIsolation,
		authorizeCreation?: () => boolean,
	) {
		this.assertHostOwner(ownerId, epoch);
		return createChildExecution(
			this.#db,
			this.#fencedChildHost(ownerId, epoch, host, "dispatch"),
			identity,
			source,
			isolation,
			() => this.assertHostOwner(ownerId, epoch),
			authorizeCreation,
		);
	}

	/** Store-backed creation for a trusted child adapter. Isolation and aggregation remain
	 * host responsibilities; this does not enable automatic child dispatch. The coordinator
	 * validates the candidate and commits its containment record in the same transaction. */
	createInheritedChildExecution(
		ownerId: string,
		epoch: string,
		host: Omit<ChildExecutionHost, "createRun">,
		identity: ChildIdentity,
		source: string,
		isolation: ChildIsolation,
		outputBindings: ChildOutputBindings = {},
		authorizeCreation?: () => boolean,
	) {
		outputBindings = structuredClone(outputBindings);
		return this.#db
			.transaction(() => {
				const result = this.createChildExecution(
					ownerId,
					epoch,
					{
						parent: (db, current) => host.parent(db, current),
						authorizeIsolation: (db, current, disclosure) => host.authorizeIsolation(db, current, disclosure),
						cancelRun: (db, childId) => host.cancelRun(db, childId),
						childState: (db, childId) => host.childState(db, childId),
						verifyAggregation: (db, childId, current) => host.verifyAggregation(db, childId, current),
						completeParent: (db, current, outputs) => host.completeParent(db, current, outputs),
						createRun: (db, input) => {
							if (db !== this.#db || !db.inTransaction)
								throw new Error("Child creation requires its store transaction");
							const authority = this.resolveChildParent(ownerId, epoch, input.identity, "dispatch");
							if (authority?.state !== "active" || !authority.reserved)
								throw new Error("Child parent authority changed before creation");
							validateChildOutputBindings(
								authority.authority.parent.nodes[authority.authority.parentNode],
								input.definition,
								outputBindings,
							);
							const parent = this.getRun(input.identity.run_id)!;
							const snapshot = this.getSnapshot(parent.snapshot_ref)!;
							const invocation = this.getScheduleState(parent.id)!.invocations.find(
								item => item.id === input.identity.invocation_id,
							)!;
							const inputs: Record<string, GraphRef> = {};
							const members: GraphPreparedRun["members"] = {};
							const executors: Record<string, GraphRef> = {};
							for (const key of Object.keys(input.definition.members)) {
								const binding = snapshot.members[key];
								if (!binding) throw new Error(`Missing frozen child member '${key}'`);
								members[key] = structuredClone(binding);
							}
							for (const node of Object.values(input.definition.nodes)) {
								if (node.kind === "program" || node.kind === "queue") {
									const binding = snapshot.executors[node.executor!];
									if (!binding) throw new Error(`Missing frozen child executor '${node.executor}'`);
									executors[node.executor!] = { ...binding };
								}
								for (const binding of Object.values(node.inputs ?? {})) {
									if (binding.run_input === undefined) continue;
									const value = invocation.ready!.inputs[binding.run_input];
									if (!value || typeof value === "string")
										throw new Error(
											`Child run input '${binding.run_input}' requires a frozen parent artifact`,
										);
									inputs[binding.run_input] = { ...value };
								}
							}
							const graphId = crypto.randomUUID();
							const prepared: GraphPreparedRun = {
								graph_id: graphId,
								definition_revision: "1",
								definition_digest: `sha256:${Bun.SHA256.hash(input.source, "hex")}`,
								authorization_ref: { ...snapshot.authorization_ref },
								inputs,
								members,
								executors,
								...(snapshot.observation
									? {
											observation: {
												source_id: snapshot.observation.source_id,
												members: Object.fromEntries(
													Object.keys(members).map(key => [
														key,
														structuredClone(snapshot.observation!.members[key]),
													]),
												),
											},
										}
									: {}),
							};
							const result = this.#createRun(
								{
									version: 1,
									request_key: `child:${input.identity.run_id}:${input.identity.invocation_id}`,
									operation: "start",
									target_id: graphId,
									if_revision: "1",
									payload: { inputs, authorization_ref: prepared.authorization_ref },
								},
								prepared,
								input.definition,
								input.source,
							);
							if (result.state !== "accepted" || !result.target_id)
								throw new Error(result.error?.message ?? "Child run creation failed");
							db.query("INSERT INTO graph_child_output_bindings VALUES (?,?)").run(
								result.target_id,
								canonicalJson(outputBindings),
							);
							return result.target_id;
						},
					},
					identity,
					source,
					isolation,
					authorizeCreation,
				);
				if (result.status !== "rejected") {
					const row = this.#db
						.query("SELECT data FROM graph_child_output_bindings WHERE child_run_id=?")
						.get(result.record.child_run_id) as { data: string } | null;
					if (!row || row.data !== canonicalJson(outputBindings))
						throw new Error("Parent invocation already owns different child output bindings");
				}
				return result;
			})
			.immediate();
	}

	/** Consume a planner's Markdown artifact from an already-frozen parent input.
	 * Creation alone is not execution. An optional trusted serial authority atomically
	 * admits the child writer and accepts its parent dispatch with the creation. */
	async createChildExecutionFromArtifact(
		ownerId: string,
		epoch: string,
		host: Omit<ChildExecutionHost, "createRun">,
		identity: ChildIdentity,
		inputName: string,
		principal: string,
		isolation: ChildIsolation,
		outputBindings: ChildOutputBindings = {},
		serial?: GraphSerialChildLaunchAuthority,
	): Promise<ChildCreateResult> {
		identity = { ...identity };
		isolation = structuredClone(isolation);
		outputBindings = structuredClone(outputBindings);
		if (serial) serial = { policy: serial.policy, stopped: structuredClone(serial.stopped) };
		const rejected = (): ChildCreateResult => ({
			status: "rejected",
			issues: [{ path: "", message: "Child plan requires an unchanged, readable frozen Markdown input" }],
		});
		const artifacts = this.#artifacts;
		if (!artifacts) throw new Error("Graph artifact registry is not configured");
		const proof = this.#childPlanProof(ownerId, epoch, identity, inputName);
		if (!proof) return rejected();
		const bytes = await artifacts.store.read(principal, proof.ref);
		if (bytes.byteLength > this.#limits.maxBytes) return rejected();
		let source: string;
		try {
			source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			return rejected();
		}
		return this.#db
			.transaction((): ChildCreateResult => {
				const current = this.#childPlanProof(ownerId, epoch, identity, inputName);
				if (!current || current.version !== proof.version) return rejected();
				if (
					serial &&
					(isolation.mode !== "serial" || !this.#authorizeChildCreation(ownerId, epoch, identity, serial.policy))
				)
					return rejected();
				const result = this.createInheritedChildExecution(
					ownerId,
					epoch,
					host,
					identity,
					source,
					isolation,
					outputBindings,
					serial ? () => this.#authorizeChildCreation(ownerId, epoch, identity, serial.policy) : undefined,
				);
				if (result.status === "rejected") return result;
				const data = canonicalJson({ input: inputName, ref: proof.ref });
				if (result.status === "created") {
					this.#db.query("INSERT INTO graph_child_plan_inputs VALUES (?,?)").run(result.record.child_run_id, data);
				} else {
					const prior = this.#db
						.query("SELECT data FROM graph_child_plan_inputs WHERE child_run_id=?")
						.get(result.record.child_run_id) as { data: string } | null;
					if (prior?.data !== data) throw new Error("Parent invocation already owns a different child plan input");
				}
				const after = this.#childPlanProof(ownerId, epoch, identity, inputName);
				if (!after || after.version !== proof.version) throw new Error("Child plan changed during child creation");
				if (serial) {
					this.admitSerialChildWriter(ownerId, epoch, {
						parent: identity,
						child_run_id: result.record.child_run_id,
						if_child_revision: this.getRun(result.record.child_run_id)!.revision,
						...serial.stopped,
					});
					const intent = this.getDispatchIntents(identity.run_id).find(
						item => item.invocation_id === identity.invocation_id && item.attempt_id === identity.attempt_id,
					);
					if (
						!intent ||
						!this.observeDispatch(ownerId, epoch, intent.id, "accepted", {
							child_run_id: result.record.child_run_id,
						})
					)
						throw new Error("Child dispatch acceptance could not be committed");
				}
				return result;
			})
			.immediate();
	}

	#authorizeChildCreation(
		ownerId: string,
		epoch: string,
		identity: ChildIdentity,
		policy: GraphChildDispatchPolicy,
	): boolean {
		const parent = this.resolveChildParent(ownerId, epoch, identity, "dispatch");
		const run = this.getRun(identity.run_id);
		const state = this.getScheduleState(identity.run_id);
		const invocation = state?.invocations.find(item => item.id === identity.invocation_id);
		const snapshot = run && this.getSnapshot(run.snapshot_ref);
		return !!(
			parent?.state === "active" &&
			parent.reserved &&
			run &&
			state &&
			invocation &&
			snapshot &&
			this.#authorizeChildDispatch(ownerId, epoch, policy, "create", run, state, invocation, snapshot) === true
		);
	}

	#childPlanProof(
		ownerId: string,
		epoch: string,
		identity: ChildIdentity,
		inputName: string,
	): { ref: GraphRef; version: string } | null {
		return this.#db
			.transaction(() => {
				const parent = this.resolveChildParent(ownerId, epoch, identity, "dispatch");
				if (parent?.state !== "active" || !parent.reserved) return null;
				const run = this.getRun(identity.run_id)!;
				const invocation = this.getScheduleState(run.id)!.invocations.find(
					item => item.id === identity.invocation_id,
				)!;
				const inputs = invocation.ready!.inputs;
				const ref = Object.hasOwn(inputs, inputName) ? inputs[inputName] : undefined;
				if (!ref || typeof ref === "string") return null;
				const artifact = this.#artifacts?.lookup(ref);
				if (
					!artifact ||
					artifact.availability !== "available" ||
					artifact.media_type !== "text/markdown" ||
					artifact.size_bytes > this.#limits.maxBytes
				)
					return null;
				return { ref: { ...ref }, version: canonicalJson({ run, ready: invocation.ready, artifact }) };
			})
			.immediate();
	}

	/** Scheduler candidates only: these refs do not prove artifact or integration validity. */
	getChildOutputCandidates(ownerId: string, epoch: string, identity: ChildIdentity): Record<string, GraphRef> | null {
		return this.#childOutputProof(ownerId, epoch, identity)?.outputs ?? null;
	}

	/** Verify exact producer, media type, readable bytes and declared schema. This is not
	 * integration acceptance, an execution grant or permission to complete the parent.
	 * A caller must consume it under its own current aggregation/acceptance fence. */
	async verifyChildOutputCandidates(
		ownerId: string,
		epoch: string,
		identity: ChildIdentity,
		principal: string,
	): Promise<Record<string, GraphRef> | null> {
		identity = { ...identity };
		const artifacts = this.#artifacts;
		if (!artifacts) throw new Error("Graph artifact registry is not configured");
		const proof = this.#childOutputProof(ownerId, epoch, identity);
		if (!proof) return null;
		const metadata = new Map<string, string>();
		for (const [name, ref] of Object.entries(proof.outputs)) {
			const source = proof.sources[name];
			const artifact = artifacts.lookup(ref);
			if (
				!artifact ||
				artifact.producer_attempt_id !== source.producer_attempt_id ||
				artifact.source_ref !== null ||
				artifact.media_type !== source.declaration.media_type
			)
				throw new Error(`Child output '${name}' does not match its declared producer and media type`);
			metadata.set(name, canonicalJson(artifact));
			const bytes = await artifacts.store.read(principal, ref);
			await validateGraphOutputContent(source.declaration, bytes, principal, artifacts.store);
		}
		return this.#db
			.transaction(() => {
				const current = this.#childOutputProof(ownerId, epoch, identity);
				if (!current || current.version !== proof.version) return null;
				for (const [name, ref] of Object.entries(current.outputs)) {
					const artifact = artifacts.lookup(ref);
					if (!artifact || artifact.availability !== "available" || canonicalJson(artifact) !== metadata.get(name))
						return null;
					const schema = current.sources[name].declaration.schema_ref;
					if (schema && artifacts.lookup(schema)?.availability !== "available") return null;
				}
				return current.outputs;
			})
			.immediate();
	}

	#childOutputProof(ownerId: string, epoch: string, identity: ChildIdentity): ChildOutputProof | null {
		return this.#db
			.transaction(() => {
				const parent = this.resolveChildParent(ownerId, epoch, identity, "recovery");
				if (parent?.state !== "active" || !parent.reserved) return null;
				const row = this.#db
					.query(`SELECT c.child_run_id,c.data AS containment,b.data AS bindings
				FROM graph_child_executions c JOIN graph_child_output_bindings b ON b.child_run_id=c.child_run_id
				WHERE c.parent_run_id=? AND c.parent_invocation_id=?`)
					.get(identity.run_id, identity.invocation_id) as {
					child_run_id: string;
					containment: string;
					bindings: string;
				} | null;
				if (!row) return null;
				const containment = JSON.parse(row.containment) as { source: string; state: string };
				const run = this.getRun(row.child_run_id);
				const snapshot = run && this.getSnapshot(run.snapshot_ref);
				const definition = run && this.getFrozenDefinition(run.id);
				const state = run && this.getScheduleState(run.id);
				if (
					!run ||
					run.state !== "succeeded" ||
					!snapshot ||
					snapshot.definition !== containment.source ||
					!definition ||
					!state ||
					state.run_state !== "succeeded" ||
					!["running", "held"].includes(containment.state) ||
					this.#hasAcceptanceEffects(run.id) ||
					this.getDispatchIntents(run.id).some(intent => !["finished", "cancelled"].includes(intent.state))
				)
					return null;
				const bindings = JSON.parse(row.bindings) as ChildOutputBindings;
				const parentNode = parent.authority.parent.nodes[parent.authority.parentNode];
				validateChildOutputBindings(parentNode, definition, bindings);
				const outputs = resolveChildOutputCandidates(bindings, state.invocations);
				if (!outputs) return null;
				const sources: ChildOutputProof["sources"] = {};
				for (const [name, binding] of Object.entries(bindings)) {
					const producer = state.invocations.find(
						item => !item.superseded && !item.consultation && item.node === binding.node,
					)!;
					// Validate both declarations: a child may add a schema where the parent has none.
					const declaration = definition.nodes[binding.node].outputs![binding.output];
					Object.defineProperty(sources, name, {
						value: { declaration, producer_attempt_id: producer.attempt_id! },
						enumerable: true,
					});
				}
				const version = canonicalJson({
					parent_revision: this.getRun(identity.run_id)!.revision,
					child: run,
					schedule: state,
					bindings,
					containment: row.containment,
				});
				return { outputs, sources, version };
			})
			.immediate();
	}

	/** Trusted integration gate. Artifact validity alone is insufficient: the embedding
	 * verifies actual integration synchronously against this transaction's exact proof.
	 * Stop observation, containment and parent result commit or roll back together. */
	async aggregateSerialChildExecution(
		ownerId: string,
		epoch: string,
		request: GraphSerialChildAggregation,
		verifyIntegration: (
			db: Database,
			proof: GraphSerialChildAggregation & { outputs: Record<string, GraphRef> },
		) => boolean,
	): Promise<boolean> {
		request = structuredClone(request);
		this.#assertWriterStopObservation({ termination_ref: request.integration_ref, observed: request.observed });
		const prior = this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const row = this.#db
					.query("SELECT data FROM graph_child_aggregation_receipts WHERE child_run_id=?")
					.get(request.stopped.identity.child_run_id) as { data: string } | null;
				if (!row) return null;
				const receipt = JSON.parse(row.data) as { request: GraphSerialChildAggregation };
				return canonicalJson(receipt.request) === canonicalJson(request);
			})
			.immediate();
		// Historical application receipt, not a fresh artifact read or execution grant.
		if (prior !== null) return prior;
		const proof = this.#childOutputProof(ownerId, epoch, request.parent);
		if (!proof || !this.#artifacts) return false;
		const outputs = await this.verifyChildOutputCandidates(ownerId, epoch, request.parent, request.principal);
		if (!outputs || canonicalJson(outputs) !== canonicalJson(proof.outputs)) return false;
		const refs = [
			...Object.values(outputs),
			...Object.values(proof.sources).flatMap(source =>
				source.declaration.schema_ref ? [source.declaration.schema_ref] : [],
			),
		];
		const metadata = refs.map(ref => canonicalJson(this.#artifacts!.lookup(ref)));
		const stale = Symbol("stale child aggregation");
		try {
			return this.#db
				.transaction(() => {
					this.assertHostOwner(ownerId, epoch);
					const current = this.#childOutputProof(ownerId, epoch, request.parent);
					const scope = this.#db
						.query("SELECT data FROM graph_serial_child_writers WHERE child_run_id=? AND receipt IS NULL")
						.get(request.stopped.identity.child_run_id) as { data: string } | null;
					if (!current || current.version !== proof.version || !scope) throw stale;
					const record = JSON.parse(scope.data) as SerialChildWriterRecord;
					if (
						canonicalJson(record.request.parent) !== canonicalJson(request.parent) ||
						this.#serialChildWriterParent(record.admission.child_run_id) !== request.parent.run_id ||
						verifyIntegration(this.#db, structuredClone({ ...request, outputs })) !== true
					)
						throw stale;
					// Trusted callbacks may synchronously reenter the Store; reject stale facts.
					if (
						this.#childOutputProof(ownerId, epoch, request.parent)?.version !== proof.version ||
						refs.some((ref, index) => {
							const artifact = this.#artifacts!.lookup(ref);
							return (
								!artifact ||
								artifact.availability !== "available" ||
								canonicalJson(artifact) !== metadata[index]
							);
						})
					)
						throw stale;
					this.#releaseSerialChildWriter(ownerId, epoch, request.stopped, true);
					if (
						!this.#completeAttempt(
							ownerId,
							epoch,
							{
								...request.parent,
								state: "succeeded",
								outcome: request.outcome,
								...(request.verdict !== undefined ? { verdict: request.verdict } : {}),
								outputs,
							},
							undefined,
							true,
						)
					)
						throw stale;
					const row = this.#db
						.query("SELECT data FROM graph_child_executions WHERE child_run_id=?")
						.get(record.admission.child_run_id) as { data: string };
					const containment = JSON.parse(row.data) as ChildExecutionRecord;
					containment.state = "completed";
					this.#db
						.query("UPDATE graph_child_executions SET data=? WHERE child_run_id=?")
						.run(JSON.stringify(containment), containment.child_run_id);
					this.#db
						.query("INSERT INTO graph_child_aggregation_receipts VALUES (?,?)")
						.run(containment.child_run_id, canonicalJson({ request, outputs }));
					return true;
				})
				.immediate();
		} catch (error) {
			if (error === stale) return false;
			throw error;
		}
	}

	/** Settle failure/cancellation only after trusted whole-child stop observation.
	 * A late child success may be retained under parent cancellation, never promoted. */
	settleSerialChildExecution(ownerId: string, epoch: string, request: GraphSerialChildSettlement): boolean {
		request = structuredClone(request);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				this.#assertWriterStopObservation(request.stopped);
				const childId = request.stopped.identity.child_run_id;
				const prior = this.#db
					.query("SELECT data FROM graph_child_settlement_receipts WHERE child_run_id=?")
					.get(childId) as { data: string } | null;
				if (prior) return prior.data === canonicalJson(request);
				const row = this.#db
					.query("SELECT data FROM graph_serial_child_writers WHERE child_run_id=? AND receipt IS NULL")
					.get(childId) as { data: string } | null;
				if (!row) return false;
				const scope = JSON.parse(row.data) as SerialChildWriterRecord;
				const parent = this.resolveChildParent(ownerId, epoch, request.parent, "recovery");
				const parentRun = this.getRun(request.parent.run_id);
				const child = this.getRun(childId);
				if (
					!parent ||
					!parentRun ||
					!child ||
					canonicalJson(scope.request.parent) !== canonicalJson(request.parent) ||
					!["queued", "running", "held", "cancelling"].includes(parentRun.state) ||
					(!["failed", "cancelled"].includes(child.state) &&
						!(parentRun.state === "cancelling" && child.state === "succeeded"))
				)
					return false;
				const containmentRow = this.#db
					.query("SELECT data FROM graph_child_executions WHERE child_run_id=?")
					.get(childId) as { data: string } | null;
				if (!containmentRow) return false;
				const containment = JSON.parse(containmentRow.data) as ChildExecutionRecord;
				if (
					containment.parent_run_id !== request.parent.run_id ||
					containment.parent_invocation_id !== request.parent.invocation_id ||
					containment.state === "completed"
				)
					return false;
				this.#releaseSerialChildWriter(ownerId, epoch, request.stopped, false);
				containment.state = parentRun.state === "cancelling" ? "cancelled" : "completed";
				this.#db
					.query("UPDATE graph_child_executions SET data=? WHERE child_run_id=?")
					.run(JSON.stringify(containment), childId);
				if (
					!this.#completeAttempt(
						ownerId,
						epoch,
						{
							...request.parent,
							state: parentRun.state === "cancelling" ? "cancelled" : "failed",
							error: `Child Run ${child.state}; whole-child stop confirmed`,
						},
						undefined,
						true,
					)
				)
					throw new Error("Stopped child parent completion could not be committed");
				this.#db
					.query("INSERT INTO graph_child_settlement_receipts VALUES (?,?)")
					.run(childId, canonicalJson(request));
				return true;
			})
			.immediate();
	}

	/** Recovery-only: independently confirm an unknown parent dispatch never left
	 * untracked effects. This cannot adopt a contained child, replay or report success. */
	reconcileUnstartedChildDispatch(ownerId: string, epoch: string, request: GraphUnstartedChildStopped): boolean {
		request = structuredClone(request);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				this.#assertWriterStopObservation(request);
				const prior = this.#db
					.query("SELECT data FROM graph_unstarted_child_receipts WHERE invocation_id=?")
					.get(request.parent.invocation_id) as { data: string } | null;
				if (prior) return prior.data === canonicalJson(request);
				const parent = this.resolveChildParent(ownerId, epoch, request.parent, "recovery");
				const run = this.getRun(request.parent.run_id);
				const intent = this.getDispatchIntents(request.parent.run_id).find(
					item =>
						item.invocation_id === request.parent.invocation_id && item.attempt_id === request.parent.attempt_id,
				);
				if (
					!parent ||
					!run ||
					run.revision !== request.if_revision ||
					!["held", "cancelling"].includes(run.state) ||
					intent?.state !== "unknown" ||
					this.#db
						.query("SELECT 1 FROM graph_child_executions WHERE parent_run_id=? AND parent_invocation_id=?")
						.get(run.id, request.parent.invocation_id)
				)
					return false;
				if (
					!this.#completeAttempt(
						ownerId,
						epoch,
						{
							...request.parent,
							state: run.state === "cancelling" ? "cancelled" : "failed",
							error: "Unstarted child dispatch reconciled with independent stop evidence",
						},
						undefined,
						true,
					)
				)
					throw new Error("Unstarted child reconciliation could not be committed");
				this.#db
					.query("INSERT INTO graph_unstarted_child_receipts VALUES (?,?)")
					.run(request.parent.invocation_id, canonicalJson(request));
				return true;
			})
			.immediate();
	}

	reconcileChildExecution(ownerId: string, epoch: string, host: ChildExecutionHost, identity: ChildIdentity) {
		this.assertHostOwner(ownerId, epoch);
		return reconcileChildExecution(this.#db, this.#fencedChildHost(ownerId, epoch, host, "recovery"), identity, () =>
			this.assertHostOwner(ownerId, epoch),
		);
	}

	recoverChildExecutions(
		ownerId: string,
		epoch: string,
		host: ChildExecutionHost,
		resolveIdentity: (runId: string, invocationId: string) => ChildIdentity | null,
	) {
		this.assertHostOwner(ownerId, epoch);
		return recoverChildExecutions(
			this.#db,
			this.#fencedChildHost(ownerId, epoch, host, "recovery"),
			resolveIdentity,
			() => this.assertHostOwner(ownerId, epoch),
		);
	}

	/** Resolve frozen authority and committed reservations, never executor/role/isolation grants.
	 * Recovery may authenticate an older fence; it cannot authorize a new dispatch. */
	resolveChildParent(
		ownerId: string,
		epoch: string,
		identity: ChildIdentity,
		purpose: "dispatch" | "recovery",
	): ChildParentAuthority | null {
		return this.#db
			.transaction((): ChildParentAuthority | null => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(identity.run_id);
				const state = this.getScheduleState(identity.run_id);
				const invocation = state?.invocations.find(item => item.id === identity.invocation_id);
				const intents = this.getDispatchIntents(identity.run_id).filter(
					item => item.invocation_id === identity.invocation_id && item.attempt_id === identity.attempt_id,
				);
				const intent = intents.length === 1 ? intents[0] : undefined;
				const snapshot = run && this.getSnapshot(run.snapshot_ref);
				if (
					!run ||
					!state ||
					!invocation ||
					!intent ||
					!snapshot ||
					!identity.attempt_id ||
					!identity.fence ||
					invocation.superseded ||
					invocation.consultation ||
					!invocation.ready ||
					invocation.attempt_id !== identity.attempt_id ||
					intent.run_id !== run.id ||
					intent.fence !== identity.fence ||
					(purpose === "dispatch" && (identity.fence !== epoch || intent.state !== "submitting")) ||
					(purpose === "recovery" && intent.state === "pending") ||
					snapshot.graph_id !== run.graph_id ||
					snapshot.definition_revision !== run.definition_revision ||
					snapshot.definition_digest !== run.definition_digest ||
					canonicalJson(snapshot.authorization_ref) !== canonicalJson(run.authorization_ref)
				)
					return null;
				const validated = validateGraphForStart(snapshot.definition, this.#limits);
				if (validated.issues.length) return null;
				const definition = validated.source.frontmatter.frontmatter as unknown as GraphDefinition;
				const node = definition.nodes[invocation.node];
				if (node?.kind !== "subgraph" || !node.member || !snapshot.members[node.member]) return null;
				const request = intent.request as
					| (Partial<Extract<SchedulerAction, { type: "ready" }>> & {
							node?: string;
							snapshot_ref?: GraphRef;
					  })
					| null;
				if (
					!request ||
					request.node !== invocation.node ||
					request.type !== "ready" ||
					request.invocation_id !== invocation.id ||
					canonicalJson(request.snapshot_ref ?? null) !== canonicalJson(run.snapshot_ref) ||
					canonicalJson(request.inputs ?? null) !== canonicalJson(invocation.ready.inputs) ||
					canonicalJson(request.upstream_invocation_ids ?? null) !==
						canonicalJson(invocation.ready.upstream_invocation_ids) ||
					canonicalJson(request.upstream_attempt_ids ?? null) !==
						canonicalJson(invocation.ready.upstream_attempt_ids)
				)
					return null;
				const requirements = graphReservationRequirements(definition, state, invocation);
				const reserved =
					Array.isArray(requirements) &&
					requirements.every(requirement => {
						const counters = state.counters.filter(counter => counter.key === requirement.key);
						if (counters.length !== 1) return false;
						const counter = counters[0];
						return (
							Number.isSafeInteger(counter.consumed) &&
							counter.consumed > 0 &&
							counter.consumed <= requirement.limit &&
							counter.consumed === counter.reservations.length &&
							new Set(counter.reservations).size === counter.reservations.length &&
							counter.reservations.includes(requirement.reservation)
						);
					});
				const active =
					["queued", "running", "held"].includes(run.state) &&
					["running", "waiting"].includes(invocation.state) &&
					["submitting", "accepted"].includes(intent.state) &&
					!this.#hasAcceptanceEffects(run.id) &&
					!this.#db.query("SELECT 1 FROM graph_granted_runs WHERE run_id=?").get(run.id);
				return {
					state:
						run.state === "cancelling"
							? "cancelling"
							: active
								? run.state === "held"
									? "held"
									: "active"
								: "inactive",
					reserved,
					authority: { parent: definition, parentNode: invocation.node, limits: { ...this.#limits } },
				};
			})
			.immediate();
	}

	/** Obtain the persisted attempt/fence for reconciliation, including revoked reservations
	 * so that the coordinator can cancel rather than silently orphan existing child work. */
	resolveChildRecoveryIdentity(
		ownerId: string,
		epoch: string,
		runId: string,
		invocationId: string,
	): ChildIdentity | null {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const invocation = this.getScheduleState(runId)?.invocations.find(item => item.id === invocationId);
				if (!invocation?.attempt_id || invocation.superseded) return null;
				const intents = this.getDispatchIntents(runId).filter(
					item => item.invocation_id === invocationId && item.attempt_id === invocation.attempt_id,
				);
				if (intents.length !== 1) return null;
				const identity = {
					run_id: runId,
					invocation_id: invocationId,
					attempt_id: invocation.attempt_id,
					fence: intents[0].fence,
				};
				return this.resolveChildParent(ownerId, epoch, identity, "recovery") ? identity : null;
			})
			.immediate();
	}

	#fencedChildHost(
		ownerId: string,
		epoch: string,
		host: ChildExecutionHost,
		purpose: "dispatch" | "recovery",
	): ChildExecutionHost {
		return {
			parent: (db, identity) => {
				const claimed = host.parent(db, structuredClone(identity));
				const actual = this.resolveChildParent(ownerId, epoch, identity, purpose);
				if (
					!claimed ||
					!actual ||
					claimed.authority.parentNode !== actual.authority.parentNode ||
					canonicalJson(claimed.authority.parent) !== canonicalJson(actual.authority.parent)
				)
					return null;
				return {
					state: actual.state === "active" ? claimed.state : actual.state,
					reserved: actual.reserved && claimed.reserved === true,
					authority: {
						...claimed.authority,
						parent: actual.authority.parent,
						limits: {
							maxBytes: Math.min(actual.authority.limits.maxBytes, claimed.authority.limits.maxBytes),
							maxDepth: Math.min(actual.authority.limits.maxDepth, claimed.authority.limits.maxDepth),
							maxAliases: Math.min(actual.authority.limits.maxAliases, claimed.authority.limits.maxAliases),
							maxNodes: Math.min(actual.authority.limits.maxNodes, claimed.authority.limits.maxNodes),
						},
					},
				};
			},
			authorizeIsolation: (db, identity, isolation) => host.authorizeIsolation(db, identity, isolation),
			createRun: (db, input) => host.createRun(db, input),
			cancelRun: (db, runId) => host.cancelRun(db, runId),
			childState: (db, runId) => host.childState(db, runId),
			verifyAggregation: (db, runId, identity) => host.verifyAggregation(db, runId, identity),
			completeParent: (db, identity, outputs) => host.completeParent(db, identity, outputs),
		};
	}

	/** No lifecycle mutation is enabled until a trusted host installs this policy. */
	configureLifecycle(policy: GraphLifecyclePolicy): void {
		this.definitions.assertProfileAccess();
		if (this.#lifecycle) throw new Error("Graph lifecycle policy is already configured");
		this.#lifecycle = policy;
	}

	/** Atomically authorize, compare the revision, persist the transition and journal its receipt.
	 * Cancellation is an intent, not confirmation that any previously submitted work stopped. */
	mutateLifecycle(principal: string, request: GraphLifecycleRequest): GraphOperation {
		this.definitions.assertProfileAccess();
		const policy = this.#lifecycle;
		if (!policy) throw new Error("Graph lifecycle policy is not configured");
		const fingerprint = canonicalJson(request);
		const reject = (code: string, message: string): GraphOperation => ({
			request_key: request.request_key,
			state: "rejected",
			target_id: request.target_id,
			revision: null,
			result_ref: null,
			error: { code, message, location: null, retryable: false, details: null },
		});
		return this.#db
			.transaction(() => {
				if (
					typeof principal !== "string" ||
					!principal ||
					policy.authorize(principal, structuredClone(request)) !== true
				)
					return reject("permission_denied", "Lifecycle mutation is not authorized");
				const prior = this.#db
					.query("SELECT canonical,result FROM graph_requests WHERE request_key=?")
					.get(request.request_key) as { canonical: string; result: string } | null;
				if (prior)
					return prior.canonical === fingerprint
						? (JSON.parse(prior.result) as GraphOperation)
						: reject("idempotency_conflict", "Request key was already used for a different mutation");
				const payload = request.payload;
				const isRef = (value: unknown): boolean =>
					!!value &&
					typeof value === "object" &&
					typeof (value as GraphRef).id === "string" &&
					!!(value as GraphRef).id &&
					typeof (value as GraphRef).digest === "string" &&
					!!(value as GraphRef).digest &&
					Object.keys(value).every(key => key === "id" || key === "digest");
				const keysAre = (value: object, allowed: string[]): boolean =>
					Object.keys(value).every(key => allowed.includes(key));
				const validPayload =
					payload &&
					typeof payload === "object" &&
					!Array.isArray(payload) &&
					(request.operation === "resume"
						? keysAre(payload, ["decision_ref", "kind"]) &&
							(("decision_ref" in payload && isRef(payload.decision_ref)) ||
								(Object.keys(payload).length === 1 && "kind" in payload && payload.kind === "operator"))
						: request.operation === "hold"
							? keysAre(payload, ["reason", "kind"]) &&
								"reason" in payload &&
								typeof payload.reason === "string" &&
								!!payload.reason.trim() &&
								(!("kind" in payload) || payload.kind === "operator" || payload.kind === "gate")
							: Object.keys(payload).length === 1 &&
								"reason" in payload &&
								typeof payload.reason === "string" &&
								!!payload.reason.trim());
				let result: GraphOperation;
				if (
					request.version !== 1 ||
					typeof request.request_key !== "string" ||
					!request.request_key ||
					typeof request.target_id !== "string" ||
					!request.target_id ||
					typeof request.if_revision !== "string" ||
					!/^(0|[1-9][0-9]*)$/.test(request.if_revision) ||
					!validPayload ||
					Object.keys(request).some(
						key => !["version", "request_key", "target_id", "if_revision", "operation", "payload"].includes(key),
					)
				) {
					result = reject("definition_invalid", "Invalid lifecycle request");
				} else {
					const run = this.getRun(request.target_id);
					const state = run && this.getScheduleState(run.id);
					if (!run) result = reject("unknown_reference", "Run does not exist");
					else if (!state) throw new Error("Graph scheduling state is missing");
					else if (run.revision !== request.if_revision)
						result = reject("revision_conflict", "Run revision has changed");
					else if (
						(request.operation === "hold" && !["queued", "running"].includes(run.state)) ||
						(request.operation === "resume" && run.state !== "held") ||
						(request.operation === "cancel" && !["queued", "running", "held", "unknown"].includes(run.state))
					)
						result = reject("invalid_state", "Lifecycle transition is not valid for the current run");
					else if (request.operation === "resume" && "kind" in request.payload && run.hold_kind !== "operator")
						// A recovery hold has no hold kind: the Run stopped on an uncertain side effect and
						// needs reconciliation, so an operator pause must not lift it.
						result = reject(
							"gate_unsatisfied",
							run.hold_kind === "gate"
								? "Run is not held by an operator pause"
								: `Run is held for reconciliation (${run.reason ?? "no recorded reason"}); use graph recover`,
						);
					else if (
						request.operation === "resume" &&
						policy.verifyResume(principal, structuredClone(request), {
							run: structuredClone(run),
							schedule: structuredClone(state),
							intents: structuredClone(this.getDispatchIntents(run.id)),
						}) !== true
					)
						result = reject("gate_unsatisfied", "Decision does not resolve the current hold");
					else {
						if (request.operation === "hold") {
							run.state = "held";
							run.reason = request.payload.reason;
							run.hold_kind = request.payload.kind ?? "gate";
							run.held_by = principal;
						} else if (request.operation === "resume") {
							run.state = "running";
							run.reason = null;
							run.hold_kind = undefined;
							run.held_by = undefined;
						} else {
							const intents = this.getDispatchIntents(run.id);
							for (const intent of intents) {
								const invocation = state.invocations.find(
									item =>
										item.id === intent.invocation_id &&
										item.attempt_id === intent.attempt_id &&
										!item.superseded,
								);
								if (!invocation) continue;
								const withdraw =
									(intent.state === "pending" && invocation.state === "running") ||
									this.#isOpenHumanWait(intent, run, invocation);
								if (withdraw) {
									invocation.state = "cancelled";
									intent.state = "cancelled";
									this.#db
										.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
										.run(JSON.stringify(intent), intent.id);
								}
							}
							for (const invocation of state.invocations) {
								if (!invocation.superseded && ["pending", "ready"].includes(invocation.state))
									invocation.state = "cancelled";
							}
							const hasEffects =
								run.state === "unknown" ||
								this.#hasAcceptanceEffects(run.id) ||
								intents.some(intent => !["pending", "cancelled", "finished"].includes(intent.state)) ||
								state.invocations.some(
									item =>
										!item.superseded &&
										(item.state === "unknown" ||
											(item.state === "running" &&
												!intents.some(
													intent =>
														intent.invocation_id === item.id &&
														intent.attempt_id === item.attempt_id &&
														intent.state === "pending",
												))),
								);
							const hasWaiting = state.invocations.some(item => !item.superseded && item.state === "waiting");
							const hasConsultations = this.#hasConsultationEffects(run.id);
							for (const intent of intents.filter(item => item.state === "pending")) {
								intent.state = "cancelled";
								this.#db
									.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
									.run(JSON.stringify(intent), intent.id);
							}
							run.state = hasEffects || hasWaiting || hasConsultations ? "cancelling" : "cancelled";
							run.reason = request.payload.reason;
						}
						this.#saveSchedule(run, state, `run.${request.operation}`);
						result = {
							request_key: request.request_key,
							state: "completed",
							target_id: run.id,
							revision: run.revision,
							result_ref: null,
							error: null,
						};
					}
				}
				this.#db
					.query("INSERT INTO graph_requests VALUES (?,?,?)")
					.run(request.request_key, fingerprint, JSON.stringify(result));
				return result;
			})
			.immediate();
	}

	/** The trusted policy must authenticate the human and authorize every referenced artifact,
	 * including that question_ref is the frozen node's actual question. */
	configureHuman(authorize: GraphHumanDecisionOptions["authorize"]): void {
		this.definitions.assertProfileAccess();
		if (this.#human) throw new Error("Graph human policy is already configured");
		this.#human = new GraphHumanDecisions({
			database: this.#db,
			authorize,
			fence: (action, question, answer) => {
				const run = this.getRun(question.run_id);
				const state = this.getScheduleState(question.run_id);
				const invocation = state?.invocations.find(item => item.id === question.invocation_id);
				if (!run || !invocation || invocation.superseded || !invocation.ready) return "input_stale";
				const digest = `sha256:${Bun.SHA256.hash(canonicalJson(invocation.ready.inputs), "hex")}`;
				if (question.input_digest !== digest || question.source_revision !== run.definition_digest)
					return "input_stale";
				if (answer && answer.if_revision !== run.revision) return "revision_conflict";
				if (
					(action === "create" && invocation.state !== "running") ||
					(action === "answer" && invocation.state !== "waiting") ||
					!["running", "held"].includes(run.state)
				)
					return "revision_conflict";
				return true;
			},
		});
	}

	/** Host-only creation: question and scheduling state commit together. */
	createHumanQuestion(
		ownerId: string,
		epoch: string,
		principal: string,
		runId: string,
		invocationId: string,
		questionRef: GraphRef,
	): GraphHumanDecision {
		this.definitions.assertProfileAccess();
		if (!this.#human) throw new Error("Graph human policy is not configured");
		const human = this.#human;
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(runId);
				const state = this.getScheduleState(runId);
				const invocation = state?.invocations.find(item => item.id === invocationId);
				const snapshot = run && this.getSnapshot(run.snapshot_ref);
				if (!run || !state || !invocation || !snapshot || !invocation.ready || invocation.superseded)
					throw new GraphHumanError("input_stale", "Human invocation is unavailable");
				const validated = validateGraphForStart(snapshot.definition, this.#limits);
				if (validated.issues.length) throw new Error("Frozen graph definition is invalid");
				const node = (validated.source.frontmatter.frontmatter as unknown as GraphDefinition).nodes[
					invocation.node
				];
				if (!node || node.kind !== "human") throw new GraphHumanError("invalid", "Invocation is not a human node");
				const intent = this.getDispatchIntents(runId).find(
					item =>
						item.invocation_id === invocation.id &&
						item.attempt_id === invocation.attempt_id &&
						(invocation.state === "waiting" || item.fence === epoch) &&
						item.state !== "finished" &&
						item.state !== "cancelled",
				);
				if (!intent) throw new GraphHumanError("revision_conflict", "Human attempt is not owned by this host");
				const question: GraphHumanQuestion = {
					id: `human:${invocation.id}`,
					run_id: runId,
					invocation_id: invocationId,
					input_digest: `sha256:${Bun.SHA256.hash(canonicalJson(invocation.ready.inputs), "hex")}`,
					source_revision: run.definition_digest,
					question_ref: questionRef,
					outcomes: node.outcomes ?? ["done"],
					verdicts: node.verdicts ?? null,
					decisions: node.decisions ?? null,
				};
				const result = human.create(principal, question);
				if (invocation.state === "waiting") return result;
				invocation.state = "waiting";
				intent.state = "accepted";
				intent.observation = { decision_id: result.id };
				this.#db
					.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
					.run(JSON.stringify(intent), intent.id);
				this.#saveSchedule(run, state, "human.question");
				return result;
			})
			.immediate();
	}

	getHumanQuestion(principal: string, decisionId: string): GraphHumanDecision | null {
		this.definitions.assertProfileAccess();
		if (!this.#human) throw new Error("Graph human policy is not configured");
		return this.#human.get(principal, decisionId);
	}
	/** Historical decision evidence is not a grant; callers must independently check its
	 * current applicability and authorize the requested action against host-owned state. */
	getHumanEvidence(principal: string, reference: GraphRef, scope: GraphHumanEvidenceScope): GraphHumanEvidence {
		this.definitions.assertProfileAccess();
		if (!this.#human) throw new Error("Graph human policy is not configured");
		return this.#human.getEvidence(principal, reference, scope);
	}

	/** An authorized answer, global receipt, invocation, intent and journal are one transaction. */
	answerHuman(input: GraphHumanAnswer): GraphOperation {
		this.definitions.assertProfileAccess();
		if (!this.#human) throw new Error("Graph human policy is not configured");
		const human = this.#human;
		const { principal: _principal, request_key, run_id, if_revision, ...payload } = input;
		const request = { version: 1, request_key, operation: "answer", target_id: run_id, if_revision, payload };
		const fingerprint = canonicalJson(request);
		const rejected = (code: string, message: string): GraphOperation => ({
			request_key,
			state: "rejected",
			target_id: run_id,
			revision: null,
			result_ref: null,
			error: { code, message, location: null, retryable: false, details: null },
		});
		return this.#db
			.transaction(() => {
				try {
					human.authorizeAnswer(input);
				} catch (error) {
					if (error instanceof GraphHumanError)
						return rejected(error.code === "invalid" ? "definition_invalid" : error.code, error.message);
					throw error;
				}
				const prior = this.#db
					.query("SELECT canonical,result FROM graph_requests WHERE request_key=?")
					.get(request_key) as { canonical: string; result: string } | null;
				if (prior)
					return prior.canonical === fingerprint
						? (JSON.parse(prior.result) as GraphOperation)
						: rejected("idempotency_conflict", "Request key was already used for a different mutation");
				let result: GraphOperation;
				try {
					const currentRun = this.getRun(run_id);
					const currentState = this.getScheduleState(run_id);
					const currentInvocation = currentState?.invocations.find(item => item.id === input.invocation_id);
					const snapshot = currentRun && this.getSnapshot(currentRun.snapshot_ref);
					const validated = snapshot && validateGraphForStart(snapshot.definition, this.#limits);
					const node =
						validated && !validated.issues.length && currentInvocation
							? (validated.source.frontmatter.frontmatter as unknown as GraphDefinition).nodes[
									currentInvocation.node
								]
							: null;
					const approvedOutputs: Record<string, GraphRef> = {};
					if (node?.kind === "human") {
						const mappings = node.approved_outputs ?? {};
						for (const [name, declaration] of Object.entries(node.outputs ?? {}))
							if (declaration.required && !Object.hasOwn(mappings, name))
								throw new GraphHumanError("invalid", `Human output ${name} has no approved input binding`);
						const hasRegistry = !!this.#db
							.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_artifacts'")
							.get();
						for (const [name, binding] of Object.entries(mappings)) {
							if (!binding.on.includes(input.outcome)) continue;
							const inputName = binding.input;
							const declaration = node.outputs?.[name];
							const value = currentInvocation?.ready?.inputs[inputName];
							if (!declaration || declaration.schema_ref || !value || typeof value === "string" || !hasRegistry)
								throw new GraphHumanError("invalid", `Invalid approved artifact binding ${name}`);
							const row = this.#db
								.query("SELECT digest,data,availability FROM graph_artifacts WHERE id=?")
								.get(value.id) as { digest: string; data: string; availability: string } | null;
							const artifact =
								row && (JSON.parse(row.data) as { media_type: string; expires_at?: string | null });
							if (
								!row ||
								row.digest !== value.digest ||
								row.availability !== "available" ||
								artifact?.media_type !== declaration.media_type ||
								(artifact.expires_at && Date.parse(artifact.expires_at) <= Date.now())
							)
								throw new GraphHumanError(
									"invalid",
									`Approved artifact ${inputName} is unavailable or does not match ${name}`,
								);
							approvedOutputs[name] = { id: value.id, digest: value.digest };
						}
					}
					const decision = human.answer(input);
					const run = this.getRun(run_id);
					const state = this.getScheduleState(run_id);
					const invocation = state?.invocations.find(item => item.id === decision.invocation_id);
					const intent = this.getDispatchIntents(run_id).find(
						item =>
							item.invocation_id === decision.invocation_id &&
							item.attempt_id === invocation?.attempt_id &&
							item.state === "accepted",
					);
					if (!run || !state || !invocation || !intent) throw new Error("Human attempt state is missing");
					const sequence = this.#db
						.query(
							"UPDATE graph_schedule_sequences SET completion_order=completion_order+1 WHERE run_id=? RETURNING completion_order",
						)
						.get(run_id) as { completion_order: number } | null;
					if (!sequence) throw new Error("Graph completion sequence is missing");
					invocation.state = "succeeded";
					invocation.origin = "executed";
					invocation.completion_order = String(sequence.completion_order);
					invocation.outcome = decision.answer!.outcome;
					invocation.verdict = decision.answer!.verdict;
					invocation.outputs = approvedOutputs;
					intent.state = "finished";
					intent.observation = { decision_id: decision.id, answer: decision.answer };
					this.#db
						.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
						.run(JSON.stringify(intent), intent.id);
					this.#saveSchedule(run, state, "human.answered");
					result = {
						request_key,
						state: "completed",
						target_id: run_id,
						revision: run.revision,
						result_ref: decision.answer!.content_ref,
						error: null,
					};
				} catch (error) {
					if (!(error instanceof GraphHumanError)) throw error;
					result = rejected(error.code === "invalid" ? "definition_invalid" : error.code, error.message);
				}
				this.#db
					.query("INSERT INTO graph_requests VALUES (?,?,?)")
					.run(request_key, fingerprint, JSON.stringify(result));
				return result;
			})
			.immediate();
	}

	getRun(id: string): GraphRunRecord | null {
		this.definitions.assertProfileAccess();
		return readGraphRun(this.#db, id);
	}

	/**
	 * Persist liveness facts reported by a live executor. This is observation data, never a
	 * completion or success signal: a Run is still judged by its own committed transitions.
	 * A `turn` increments the Run's model/tool turn count; the summary labels the latest one.
	 */
	recordInvocationActivity(
		runId: string,
		invocationId: string,
		node: string,
		update: { summary?: string | null; turn?: boolean } = {},
	): void {
		this.definitions.assertProfileAccess();
		const at = new Date().toISOString();
		this.#db
			.query(
				`INSERT INTO graph_invocation_activity VALUES (?,?,?,?,?,?,?)
				 ON CONFLICT(run_id,invocation_id) DO UPDATE SET
				   last_activity_at=excluded.last_activity_at,
				   turns=graph_invocation_activity.turns+excluded.turns,
				   summary=COALESCE(excluded.summary,graph_invocation_activity.summary)`,
			)
			.run(runId, invocationId, node, at, at, update.turn ? 1 : 0, update.summary ?? null);
	}

	/**
	 * Raise `run.stalled` alarms for idle non-terminal Runs, at most one per idle window.
	 * A stall is inferred from committed liveness data (`graph_invocation_activity` and the
	 * Run's last transition). It is never a failure signal and never changes Run state, so
	 * the sweep is safe while a detached host owns the profile. The declared threshold comes
	 * from each frozen definition; the default applies only when that definition is silent.
	 * Observation authorization may be async, so it is resolved before the write transaction:
	 * an unauthorized Run is never even evaluated, and no await happens on an open transaction.
	 */
	async emitStallNotifications(
		options: {
			now?: number;
			defaultThresholdMs?: number;
			authorize?: (runId: string) => boolean | Promise<boolean>;
		} = {},
	): Promise<GraphStallAlarm[]> {
		this.definitions.assertProfileAccess();
		const now = options.now ?? Date.now();
		const fallback = options.defaultThresholdMs ?? GRAPH_DEFAULT_STALL_THRESHOLD_MS;
		const visible = new Set<string>();
		for (const run of this.listHostRuns()) {
			if (TERMINAL_RUN_STATES.has(run.state)) continue;
			if (options.authorize && (await options.authorize(run.id)) !== true) continue;
			visible.add(run.id);
		}
		return this.#db.transaction(() => {
			const raised: GraphStallAlarm[] = [];
			for (const run of this.listHostRuns()) {
				if (!visible.has(run.id)) continue;
				const latest = readGraphInvocationActivity(this.#db, run.id).at(-1);
				const marker =
					latest && Date.parse(latest.last_activity_at) > Date.parse(run.updated_at)
						? latest.last_activity_at
						: run.updated_at;
				const idle = now - Date.parse(marker);
				if (!Number.isFinite(idle)) continue;
				const frozen = this.getFrozenDefinition(run.id);
				// A declared threshold belongs to the frozen definition, so editing the source
				// later cannot shorten the idle window of a Run already in flight.
				const threshold = (frozen ? readDeclaredContract(frozen)?.stall_threshold_ms : null) ?? fallback;
				if (idle <= threshold) continue;
				const journal = this.#db
					.query("SELECT CAST(seq AS TEXT) AS seq FROM graph_journals WHERE run_id=?")
					.get(run.id) as { seq: string } | null;
				if (!journal) continue;
				const alarms = this.#db
					.query("SELECT data FROM graph_notifications WHERE run_id=? AND kind='run.stalled'")
					.all(run.id) as { data: string }[];
				// One alarm per idle window: a resume that advances liveness re-arms the alarm.
				if (alarms.some(row => (JSON.parse(row.data) as GraphNotification).stall?.activity_at === marker)) continue;
				// Alarms live in their own sub-sequence so they can never collide with a
				// transition notification, which owns the Run's journal sequence.
				const base = Number(journal.seq) * 1_000_000;
				const lastAlarm = this.#db
					.query("SELECT MAX(seq) AS seq FROM graph_notifications WHERE run_id=? AND kind='run.stalled'")
					.get(run.id) as { seq: number | null };
				const sequence = lastAlarm.seq !== null && lastAlarm.seq >= base ? lastAlarm.seq + 1 : base + 1;
				const notification: GraphNotification = {
					format: GRAPH_NOTIFICATION_FORMAT,
					id: `${run.id}:${sequence}`,
					sequence,
					kind: "run.stalled",
					state: run.state,
					occurred_at: new Date(now).toISOString(),
					run_id: run.id,
					graph_id: run.graph_id,
					graph_name: run.graph_name ?? null,
					title: run.title ?? null,
					report_to: run.report_to ?? null,
					reason: null,
					last_event: null,
					outputs: [],
					stall: { activity_at: marker, threshold_ms: threshold },
				};
				this.#db
					.query("INSERT OR IGNORE INTO graph_notifications VALUES (?,?,?,?,?,?)")
					.run(
						notification.id,
						run.id,
						sequence,
						notification.kind,
						notification.occurred_at,
						JSON.stringify(notification),
					);
				raised.push({ run_id: run.id, activity_at: marker, threshold_ms: threshold });
			}
			return raised;
		})();
	}

	getSnapshot(ref: GraphRef): GraphRunSnapshot | null {
		this.definitions.assertProfileAccess();
		return readGraphRunSnapshot(this.#db, ref);
	}

	/** Persist a trusted, quiescent integration capture under the current host fence. */
	freezeIntegration(
		ownerId: string,
		epoch: string,
		runId: string,
		expectedRevision: string,
		snapshot: IntegrationSnapshot,
		handoff: Omit<FrozenIntegration, "version">,
	): { id: string; frozen: FrozenIntegration; revision: string } {
		const frozen = freezeIntegration(snapshot, handoff);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(runId);
				const state = this.getScheduleState(runId);
				if (!run || !state || run.revision !== expectedRevision || !["queued", "running"].includes(run.state))
					throw new Error("Run changed or is not active");
				const id = crypto.randomUUID();
				this.#db
					.query("INSERT INTO graph_integration_freezes VALUES (?,?,?,?)")
					.run(id, runId, JSON.stringify(frozen), new Date().toISOString());
				this.#saveSchedule(run, state, "integration.frozen");
				return { id, frozen, revision: run.revision };
			})
			.immediate();
	}

	getIntegrationFreeze(runId: string): { id: string; frozen: FrozenIntegration } | null {
		this.definitions.assertProfileAccess();
		const row = this.#db
			.query("SELECT id,data FROM graph_integration_freezes WHERE run_id=? ORDER BY rowid DESC LIMIT 1")
			.get(runId) as { id: string; data: string } | null;
		return row ? { id: row.id, frozen: JSON.parse(row.data) as FrozenIntegration } : null;
	}

	/** Current-owner inspection only. Unknown remains unknown; inspection never probes or relaunches work. */
	getPendingIntegrationAcceptanceExecutions(
		ownerId: string,
		epoch: string,
		runId: string,
	): RecordedAcceptanceExecution[] {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const rows = this.#db
					.query(`SELECT execution.id,execution.state,evidence.freeze_id,evidence.data,freeze.data AS frozen
						FROM graph_acceptance_executions execution
						JOIN graph_acceptance_evidence evidence ON evidence.id=execution.id
						JOIN graph_integration_freezes freeze ON freeze.id=evidence.freeze_id AND freeze.run_id=execution.run_id
						WHERE execution.run_id=? AND execution.state IN ('active','unknown') ORDER BY execution.rowid`)
					.all(runId) as {
					id: string;
					state: "active" | "unknown";
					freeze_id: string;
					data: string;
					frozen: string;
				}[];
				return rows.map(row => {
					const evidence = JSON.parse(row.data) as AcceptanceEvidence;
					return {
						identity: { run_id: runId, execution_id: row.id, freeze_id: row.freeze_id },
						request: evidence.request,
						frozen: JSON.parse(row.frozen) as FrozenIntegration,
						isolation: evidence.isolation,
						state: row.state,
					};
				});
			})
			.immediate();
	}

	/**
	 * Explicit trusted embedding boundary, not a termination verifier or model tool.
	 * Submit only independently established stop knowledge bound to the inspected
	 * durable identity, including the execution's effects, not just its leader.
	 * No new test runs here and no recovered result can become passing evidence.
	 */
	reconcileIntegrationAcceptanceExecution(
		ownerId: string,
		epoch: string,
		stopped: AcceptanceExecutionStopped,
	): AcceptanceExecutionReceipt {
		stopped = structuredClone(stopped);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				if (
					!stopped.observed?.trim() ||
					!stopped.termination_ref?.id ||
					!/^sha256:[0-9a-f]{64}$/.test(stopped.termination_ref.digest)
				)
					throw new Error("A durable, execution-bound stop observation is required");
				const identity = stopped.identity;
				const row = this.#db
					.query(`SELECT execution.state,evidence.data FROM graph_acceptance_executions execution
						JOIN graph_acceptance_evidence evidence ON evidence.id=execution.id
						JOIN graph_integration_freezes freeze ON freeze.id=evidence.freeze_id AND freeze.run_id=execution.run_id
						WHERE execution.id=? AND execution.run_id=? AND evidence.freeze_id=?`)
					.get(identity.execution_id, identity.run_id, identity.freeze_id) as {
					state: string;
					data: string;
				} | null;
				if (!row) throw new Error("Acceptance execution identity does not match its durable record");
				const prior = this.#db
					.query("SELECT data FROM graph_acceptance_reconciliations WHERE id=?")
					.get(identity.execution_id) as { data: string } | null;
				if (prior) {
					const receipt = JSON.parse(prior.data) as {
						stopped: AcceptanceExecutionStopped;
						result: AcceptanceExecutionReceipt;
					};
					if (canonicalJson(receipt.stopped) !== canonicalJson(stopped))
						throw new Error("Acceptance execution reconciliation conflicts with its durable result");
					return receipt.result;
				}
				if (!["active", "unknown"].includes(row.state)) throw new Error("Acceptance execution is already finished");
				const run = this.getRun(identity.run_id);
				const state = this.getScheduleState(identity.run_id);
				if (!run || !state) throw new Error("Acceptance Run is unavailable");
				const evidence: AcceptanceEvidence = {
					...(JSON.parse(row.data) as AcceptanceEvidence),
					status: "hold",
					reason: "Acceptance execution reconciled as stopped; independent validation result unavailable",
					observed: stopped.observed,
				};
				this.#db
					.query("UPDATE graph_acceptance_evidence SET data=? WHERE id=?")
					.run(JSON.stringify(evidence), identity.execution_id);
				this.#db
					.query("UPDATE graph_acceptance_executions SET state='finished' WHERE id=?")
					.run(identity.execution_id);
				if (["queued", "running"].includes(run.state)) {
					run.state = "held";
					run.reason = evidence.reason;
				}
				this.#settleCancellation(run, state);
				this.#saveSchedule(run, state, "integration.acceptance_reconciled");
				const result = { id: identity.execution_id, evidence, revision: run.revision };
				this.#db
					.query("INSERT INTO graph_acceptance_reconciliations VALUES (?,?)")
					.run(identity.execution_id, JSON.stringify({ stopped, result }));
				return result;
			})
			.immediate();
	}

	/** Run through trusted host capabilities, then commit only if neither Run nor freeze changed. */
	async runIntegrationAcceptance(
		ownerId: string,
		epoch: string,
		runId: string,
		expectedRevision: string,
		request: AcceptanceRequest,
		host: AcceptanceHost,
	): Promise<AcceptanceExecutionReceipt> {
		request = structuredClone(request);
		const started = this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(runId);
				const state = this.getScheduleState(runId);
				const freeze = this.getIntegrationFreeze(runId);
				if (
					!run ||
					!state ||
					run.revision !== expectedRevision ||
					!["queued", "running"].includes(run.state) ||
					!freeze ||
					this.#hasAcceptanceEffects(runId)
				)
					throw new Error("Run changed or frozen integration is unavailable");
				if (!this.#claimProfileWriter(runId)) throw new Error("Another Run retains the profile writer admission");
				const id = crypto.randomUUID();
				const pending: AcceptanceEvidence = {
					request,
					version: freeze.frozen.version,
					status: "hold",
					reason: "Acceptance started but its result is not durably recorded",
					isolation: host.isolationDescription,
				};
				this.#db
					.query("INSERT INTO graph_acceptance_evidence VALUES (?,?,?,?)")
					.run(id, freeze.id, JSON.stringify(pending), new Date().toISOString());
				this.#db.query("INSERT INTO graph_acceptance_executions VALUES (?,?,'active')").run(id, runId);
				this.#saveSchedule(run, state, "integration.acceptance_started");
				return { id, freeze, revision: run.revision };
			})
			.immediate();
		const identity: AcceptanceExecutionIdentity = {
			run_id: runId,
			execution_id: started.id,
			freeze_id: started.freeze.id,
		};
		let executionStarted = false;
		let executionSettled = false;
		const evidence = await runFrozenAcceptance(started.freeze.frozen, request, {
			sourceIsolation: host.sourceIsolation,
			isolationDescription: host.isolationDescription,
			authorizeIsolationLimitation: host.authorizeIsolationLimitation?.bind(host),
			authorize: (input, frozen) => host.authorize(input, frozen),
			capture: () => host.capture(),
			run: async input => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(runId);
				if (
					!run ||
					run.revision !== started.revision ||
					!["queued", "running"].includes(run.state) ||
					this.getIntegrationFreeze(runId)?.id !== started.freeze.id ||
					!this.#db
						.query("SELECT 1 FROM graph_acceptance_executions WHERE id=? AND state='active'")
						.get(started.id)
				)
					throw new Error("Run or frozen integration changed before acceptance execution");
				executionStarted = true;
				const result = await host.run(input, structuredClone(identity));
				executionSettled = true;
				return result;
			},
		});
		const recorded = this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				// A recovery decision is terminal. A late original callback cannot replace it.
				const reconciled = this.#db
					.query("SELECT data FROM graph_acceptance_reconciliations WHERE id=?")
					.get(started.id) as { data: string } | null;
				if (reconciled) {
					const receipt = JSON.parse(reconciled.data) as {
						result: AcceptanceExecutionReceipt;
					};
					return { ...receipt.result, changed: false, cancelled: false };
				}
				const current = this.getRun(runId);
				const state = this.getScheduleState(runId);
				if (!current || !state) throw new Error("Acceptance Run is unavailable");
				const cancelled = current.state === "cancelling" || current.state === "cancelled";
				const changed =
					current.revision !== started.revision ||
					!["queued", "running"].includes(current.state) ||
					this.getIntegrationFreeze(runId)?.id !== started.freeze.id;
				const unknown = executionStarted && !executionSettled;
				const committed: AcceptanceEvidence =
					changed || unknown
						? {
								...evidence,
								status: "hold",
								reason: unknown
									? "Acceptance execution termination is unconfirmed"
									: "Run or frozen integration changed during acceptance",
							}
						: evidence;
				this.#db
					.query("UPDATE graph_acceptance_executions SET state=? WHERE id=?")
					.run(unknown ? "unknown" : "finished", started.id);
				this.#db
					.query("UPDATE graph_acceptance_evidence SET data=? WHERE id=?")
					.run(JSON.stringify(committed), started.id);
				if (unknown && ["queued", "running"].includes(current.state)) {
					current.state = "held";
					current.reason = committed.reason;
				}
				this.#settleCancellation(current, state);
				this.#saveSchedule(current, state, "integration.acceptance");
				return { id: started.id, evidence: committed, revision: current.revision, changed, cancelled };
			})
			.immediate();
		if (recorded.changed && !recorded.cancelled)
			throw new Error("Run or frozen integration changed during acceptance");
		return { id: recorded.id, evidence: recorded.evidence, revision: recorded.revision };
	}

	/**
	 * Inspect the latest receipt against a trusted current capture. This is not a
	 * delivery gate: callers must keep the protected view stable and check again
	 * atomically with their own authorization and delivery decision.
	 */
	getApplicableIntegrationAcceptance(runId: string, snapshot: IntegrationSnapshot): AcceptanceEvidence | null {
		const freeze = this.getIntegrationFreeze(runId);
		if (!freeze) return null;
		const row = this.#db
			.query("SELECT data FROM graph_acceptance_evidence WHERE freeze_id=? ORDER BY rowid DESC LIMIT 1")
			.get(freeze.id) as { data: string } | null;
		if (!row) return null;
		const evidence = JSON.parse(row.data) as AcceptanceEvidence;
		const version = integrationVersion(snapshot);
		return acceptanceApplies(evidence, version) ? evidence : null;
	}

	/** Resolve only from the immutable, revalidated run snapshot. */
	getFrozenDefinition(runId: string): GraphDefinition | null {
		this.definitions.assertProfileAccess();
		return readGraphFrozenDefinition(this.#db, runId, this.#limits);
	}

	/** Only outgoing guidance from the immutable source; shared sections are emitted once. */
	getFrozenCommunicationInstructions(
		runId: string,
		memberId: string,
	): { grants: { to: string; when: string }[]; sections: { id: string; text: string }[] } | null {
		const run = this.getRun(runId);
		const snapshot = run && this.getSnapshot(run.snapshot_ref);
		if (!snapshot) return null;
		const validated = validateGraphForStart(snapshot.definition, this.#limits);
		if (validated.issues.length) return null;
		const definition = validated.source.frontmatter.frontmatter as unknown as GraphDefinition;
		if (!definition.members[memberId]) return null;
		const grants: { to: string; when: string }[] = [];
		const sections = new Map<string, string>();
		const seen = new Set<string>();
		for (const grant of definition.communications ?? []) {
			if (grant.from !== memberId) continue;
			const key = `${grant.to}:${grant.when}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const text = validated.source.sections.get(grant.when.slice(1));
			if (text === undefined) return null;
			grants.push({ to: grant.to, when: grant.when });
			sections.set(grant.when, text);
		}
		return { grants, sections: Array.from(sections, ([id, text]) => ({ id, text })) };
	}

	getScheduleState(runId: string): GraphScheduleState | null {
		this.definitions.assertProfileAccess();
		return readGraphScheduleState(this.#db, runId);
	}

	/** Per-invocation liveness the executor recorded; empty when nothing has reported yet. */
	getInvocationActivity(runId: string): GraphInvocationActivity[] {
		this.definitions.assertProfileAccess();
		return readGraphInvocationActivity(this.#db, runId);
	}

	getDispatchIntents(runId: string): GraphDispatchIntent[] {
		this.definitions.assertProfileAccess();
		const rows = this.#db
			.query("SELECT data FROM graph_dispatch_intents WHERE run_id=? ORDER BY rowid")
			.all(runId) as {
			data: string;
		}[];
		return rows.map(row => JSON.parse(row.data) as GraphDispatchIntent);
	}

	/** Suspend an exact live attempt without changing its dispatch or attempt identity. */
	waitForConsultation(
		ownerId: string,
		epoch: string,
		identity: ConsultationIdentity,
		conversationId: string,
		messageId: string,
	): boolean {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(identity.run_id);
				const state = this.getScheduleState(identity.run_id);
				const definition = this.getFrozenDefinition(identity.run_id);
				const invocation = state?.invocations.find(item => item.id === identity.invocation_id);
				const intent = this.getDispatchIntents(identity.run_id).find(
					item =>
						item.invocation_id === identity.invocation_id &&
						item.attempt_id === identity.attempt_id &&
						item.fence === identity.fence &&
						item.state === "accepted",
				);
				const row = this.#db
					.query(`SELECT m.data FROM consultation_messages m
				JOIN consultations c ON c.id=m.conversation_id
				WHERE c.run_id=? AND m.conversation_id=? AND m.message_id=?`)
					.get(identity.run_id, conversationId, messageId) as { data: string } | null;
				const message = row && JSON.parse(row.data);
				if (
					!run ||
					!state ||
					!invocation ||
					invocation.superseded ||
					identity.fence !== epoch ||
					!["queued", "running", "held"].includes(run.state) ||
					!intent ||
					(invocation.consultation?.member_id ?? definition?.nodes[invocation.node]?.member) !==
						identity.member_id ||
					invocation.attempt_id !== identity.attempt_id ||
					!message ||
					message.sender_member !== identity.member_id ||
					message.sender_attempt_id !== identity.attempt_id
				)
					return false;
				if (invocation.state === "waiting")
					return (
						invocation.consultation_wait?.conversation_id === conversationId &&
						invocation.consultation_wait.message_id === messageId
					);
				if (invocation.state !== "running") return false;
				invocation.state = "waiting";
				invocation.consultation_wait = { conversation_id: conversationId, message_id: messageId };
				this.#saveSchedule(run, state, "consultation.waiting");
				return true;
			})
			.immediate();
	}

	/** Reacquire a compute slot for the retained continuation, never a new attempt. */
	resumeConsultation(
		ownerId: string,
		epoch: string,
		identity: ConsultationIdentity,
		conversationId: string,
		messageId: string,
	): boolean {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(identity.run_id);
				const state = this.getScheduleState(identity.run_id);
				const definition = this.getFrozenDefinition(identity.run_id);
				const invocation = state?.invocations.find(item => item.id === identity.invocation_id);
				const intent = this.getDispatchIntents(identity.run_id).find(
					item =>
						item.invocation_id === identity.invocation_id &&
						item.attempt_id === identity.attempt_id &&
						item.fence === identity.fence &&
						item.state === "accepted",
				);
				if (
					!run ||
					!state ||
					!definition ||
					!invocation ||
					invocation.superseded ||
					identity.fence !== epoch ||
					!["queued", "running", "held"].includes(run.state) ||
					!intent ||
					(invocation.consultation?.member_id ?? definition.nodes[invocation.node]?.member) !==
						identity.member_id ||
					invocation.attempt_id !== identity.attempt_id ||
					invocation.state !== "waiting" ||
					invocation.consultation_wait?.conversation_id !== conversationId ||
					invocation.consultation_wait.message_id !== messageId ||
					state.invocations.filter(item => !item.superseded && item.state === "running").length >=
						(definition.policy?.max_parallel ?? 1) ||
					state.invocations.some(
						item =>
							!item.superseded &&
							item.state === "running" &&
							(item.consultation?.member_id ?? definition.nodes[item.node]?.member) === identity.member_id,
					)
				)
					return false;
				invocation.state = "running";
				delete invocation.consultation_wait;
				this.#saveSchedule(run, state, "consultation.resumed");
				return true;
			})
			.immediate();
	}

	/** Create one independent recipient execution, without reopening any completed node. */
	startConsultationInvocation(
		ownerId: string,
		epoch: string,
		runId: string,
		memberId: string,
		conversationId: string,
		messageId: string,
	): GraphDispatchIntent | null {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(runId);
				const state = this.getScheduleState(runId);
				const definition = this.getFrozenDefinition(runId);
				if (!run || !state || !definition || !["queued", "running"].includes(run.state)) return null;
				if (this.#holdCostLimitedRun(run, state, definition)) return null;
				const row = this.#db
					.query(`SELECT m.data AS message,c.data AS conversation FROM consultation_messages m
				JOIN consultations c ON c.id=m.conversation_id
				LEFT JOIN consultation_deliveries d ON d.message_id=m.message_id
				WHERE c.id=? AND c.run_id=? AND m.message_id=? AND d.message_id IS NULL
				AND c.state IN ('queued','active')`)
					.get(conversationId, runId, messageId) as { message: string; conversation: string } | null;
				const message = row && JSON.parse(row.message);
				const conversation = row && JSON.parse(row.conversation);
				if (
					!message ||
					!conversation ||
					message.recipient_member !== memberId ||
					typeof conversation.deadline !== "number" ||
					!Number.isFinite(conversation.deadline) ||
					conversation.deadline <= Date.now() ||
					state.invocations.some(
						item =>
							item.consultation?.conversation_id === conversationId && item.consultation.member_id === memberId,
					) ||
					state.invocations.filter(item => !item.superseded && item.state === "running").length >=
						(definition.policy?.max_parallel ?? 1) ||
					state.invocations.some(
						item =>
							!item.superseded &&
							item.state === "running" &&
							(item.consultation?.member_id ?? definition.nodes[item.node]?.member) === memberId,
					)
				)
					return null;
				if (!Object.hasOwn(definition.members, memberId)) return null;
				if (!this.#claimProfileWriter(runId)) return null;
				const node =
					Object.entries(definition.nodes).find(
						([, value]) => value.kind === "bot" && value.member === memberId,
					)?.[0] ?? `consultation:${memberId}`;
				const invocationId = crypto.randomUUID();
				const attemptId = crypto.randomUUID();
				const consultation = { conversation_id: conversationId, message_id: messageId, member_id: memberId };
				state.invocations.push({
					id: invocationId,
					node,
					iteration: 0,
					scope_id: "run",
					state: "running",
					upstream: {},
					attempt_id: attemptId,
					consultation,
				});
				const intent: GraphDispatchIntent = {
					id: crypto.randomUUID(),
					run_id: runId,
					invocation_id: invocationId,
					attempt_id: attemptId,
					request_key: crypto.randomUUID(),
					fence: epoch,
					state: "pending",
					request: { node, snapshot_ref: run.snapshot_ref, consultation },
					observation: null,
				};
				this.#db
					.query("INSERT INTO graph_dispatch_intents VALUES (?,?,?,?)")
					.run(intent.id, runId, intent.request_key, JSON.stringify(intent));
				this.#saveSchedule(run, state, "consultation.dispatched");
				return intent;
			})
			.immediate();
	}

	/** Complete only the auxiliary consultation record; graph outputs remain untouched. */
	finishConsultationInvocation(
		ownerId: string,
		epoch: string,
		intentId: string,
		result: "succeeded" | "failed" | "cancelled",
	): boolean {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const row = this.#db.query("SELECT data FROM graph_dispatch_intents WHERE id=?").get(intentId) as {
					data: string;
				} | null;
				const intent = row && (JSON.parse(row.data) as GraphDispatchIntent | null);
				const run = intent && this.getRun(intent.run_id);
				const state = intent && this.getScheduleState(intent.run_id);
				const invocation = state?.invocations.find(item => item.id === intent?.invocation_id);
				if (
					!intent ||
					!run ||
					!state ||
					!invocation?.consultation ||
					invocation.superseded ||
					intent.fence !== epoch ||
					invocation.attempt_id !== intent.attempt_id ||
					!["running", "waiting"].includes(invocation.state) ||
					!(result === "cancelled" ? ["submitting", "accepted", "unknown"] : ["accepted"]).includes(
						intent.state,
					) ||
					(result === "cancelled"
						? run.state !== "cancelling"
						: !["queued", "running", "held"].includes(run.state))
				)
					return false;
				invocation.state = result;
				invocation.routed = result === "succeeded";
				delete invocation.consultation_wait;
				intent.state = "finished";
				this.#db
					.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
					.run(JSON.stringify(intent), intent.id);
				this.#settleCancellation(run, state);
				this.#saveSchedule(run, state, "consultation.completed");
				return true;
			})
			.immediate();
	}

	/** Enumerate active runs for the single fenced host, not an authorization boundary for clients. */
	listHostRuns(): GraphRunRecord[] {
		this.definitions.assertProfileAccess();
		const rows = this.#db.query("SELECT data FROM graph_runs ORDER BY rowid").all() as { data: string }[];
		return rows
			.map(row => JSON.parse(row.data) as GraphRunRecord)
			.filter(run => run.state === "queued" || run.state === "running");
	}

	listHostIntents(): GraphDispatchIntent[] {
		this.definitions.assertProfileAccess();
		const rows = this.#db.query("SELECT data FROM graph_dispatch_intents ORDER BY rowid").all() as { data: string }[];
		return rows
			.map(row => JSON.parse(row.data) as GraphDispatchIntent)
			.filter(intent => {
				if (!["pending", "submitting", "accepted", "unknown"].includes(intent.state)) return false;
				// Only a committed, still-open question can account for an accepted human attempt.
				// Incomplete or ambiguous evidence remains visible for ordinary reconciliation.
				const run = this.getRun(intent.run_id);
				const invocation = this.getScheduleState(intent.run_id)?.invocations.find(
					item => item.id === intent.invocation_id,
				);
				return !this.#isOpenHumanWait(intent, run, invocation);
			});
	}

	#isOpenHumanWait(
		intent: GraphDispatchIntent,
		run: GraphRunRecord | null,
		invocation: GraphStoredInvocation | undefined,
	): boolean {
		if (
			intent.state !== "accepted" ||
			!run ||
			!invocation ||
			invocation.superseded ||
			invocation.state !== "waiting" ||
			invocation.attempt_id !== intent.attempt_id ||
			!invocation.ready ||
			this.getFrozenDefinition(run.id)?.nodes[invocation.node]?.kind !== "human" ||
			(intent.observation as { decision_id?: unknown } | null)?.decision_id !== `human:${invocation.id}` ||
			!this.#db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_human_decisions'").get()
		)
			return false;
		const row = this.#db.query("SELECT data FROM graph_human_decisions WHERE id=?").get(`human:${invocation.id}`) as {
			data: string;
		} | null;
		const decision = row && (JSON.parse(row.data) as GraphHumanDecision);
		return !!(
			decision &&
			decision.id === `human:${invocation.id}` &&
			decision.run_id === run.id &&
			decision.invocation_id === invocation.id &&
			decision.answer === null &&
			decision.source_revision === run.definition_digest &&
			decision.input_digest === `sha256:${Bun.SHA256.hash(canonicalJson(invocation.ready.inputs), "hex")}`
		);
	}

	/** Accounting-only reconciliation: reads the durable Bot admission, never a model-supplied amount.
	 * Old attempts may still accrue cost; accepting usage does not accept completion or authorize work. */
	recordBotUsage(ownerId: string, epoch: string, intentId: string, bots: BotStore, botId: string): void {
		this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const row = this.#db.query("SELECT data FROM graph_dispatch_intents WHERE id=?").get(intentId) as {
					data: string;
				} | null;
				if (!row) throw new Error("Graph usage dispatch is unavailable");
				const intent = JSON.parse(row.data) as GraphDispatchIntent;
				const run = this.getRun(intent.run_id);
				const state = this.getScheduleState(intent.run_id);
				const invocation = state?.invocations.find(item => item.id === intent.invocation_id);
				const definition = this.getFrozenDefinition(intent.run_id);
				const hosted = bots.graphHostedByKey(botId, intent.request_key);
				const job = hosted?.job;
				const context = job?.graph_context;
				const prior = intent.observation as { bot_id?: unknown; job_id?: unknown } | null;
				if (
					!run ||
					!state ||
					!invocation ||
					!definition ||
					!job ||
					!context ||
					invocation.attempt_id !== intent.attempt_id ||
					(!invocation.consultation && definition.nodes[invocation.node]?.kind !== "bot") ||
					context.graph_id !== run.graph_id ||
					context.graph_run_id !== run.id ||
					context.invocation_id !== invocation.id ||
					context.node_id !== invocation.node ||
					(prior?.job_id !== undefined && prior.job_id !== job.job_id) ||
					(prior?.bot_id !== undefined && prior.bot_id !== job.bot_id)
				)
					throw new Error("Graph usage does not match the durable Bot admission");
				const ledger = new GraphUsageLedger(this.#db);
				const recorded = ledger.record({
					run_id: run.id,
					invocation_id: invocation.id,
					attempt_id: intent.attempt_id,
					source_id: `bot:${job.bot_id}:${job.job_id}`,
					revision: job.revision,
					usage: job.usage,
				});
				if (recorded.status !== "recorded") return;
				const ancestors = this.#db
					.query(`WITH RECURSIVE ancestors(id) AS (
						SELECT ? UNION SELECT c.parent_run_id FROM graph_child_executions c
						JOIN ancestors a ON c.child_run_id=a.id
					) SELECT id FROM ancestors`)
					.all(run.id) as { id: string }[];
				for (const { id } of ancestors) {
					const target = id === run.id ? run : this.getRun(id);
					const schedule = id === run.id ? state : this.getScheduleState(id);
					if (!target || !schedule) throw new Error("Contained usage owner is unavailable");
					const descendants = this.#db
						.query(`WITH RECURSIVE descendants(id) AS (
							SELECT ? UNION SELECT c.child_run_id FROM graph_child_executions c
							JOIN descendants d ON c.parent_run_id=d.id
						) SELECT id FROM descendants WHERE id<>?`)
						.all(id, id) as { id: string }[];
					const summary = ledger.summary(
						id,
						descendants.map(child => child.id),
					);
					if (canonicalJson(target.observed_bot_usage ?? null) === canonicalJson(summary)) continue;
					target.observed_bot_usage = summary;
					this.#saveSchedule(target, schedule, "usage.observed");
				}
			})
			.immediate();
	}

	/** Lend, never release, the parent's profile reservation. The embedding must prove
	 * all previous parent/sibling effects stopped; SQLite additionally excludes known
	 * active effects and prevents new parent/sibling admissions until child release. */
	admitSerialChildWriter(
		ownerId: string,
		epoch: string,
		request: GraphSerialChildWriterRequest,
	): GraphSerialChildWriterAdmission {
		request = structuredClone(request);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				this.#assertWriterStopObservation(request);
				const prior = this.#db
					.query("SELECT data FROM graph_serial_child_writers WHERE child_run_id=?")
					.get(request.child_run_id) as { data: string } | null;
				if (prior) {
					const record = JSON.parse(prior.data) as SerialChildWriterRecord;
					if (canonicalJson(record.request) !== canonicalJson(request))
						throw new Error("Serial child writer request conflicts with its durable admission");
					return record.admission;
				}
				const parent = this.resolveChildParent(ownerId, epoch, request.parent, "recovery");
				const parentRun = this.getRun(request.parent.run_id);
				const child = this.getRun(request.child_run_id);
				const state = child && this.getScheduleState(child.id);
				const definition = child && this.getFrozenDefinition(child.id);
				const row = this.#db
					.query(
						"SELECT data FROM graph_child_executions WHERE child_run_id=? AND parent_run_id=? AND parent_invocation_id=?",
					)
					.get(request.child_run_id, request.parent.run_id, request.parent.invocation_id) as {
					data: string;
				} | null;
				const containment = row ? (JSON.parse(row.data) as ChildExecutionRecord) : null;
				if (
					parent?.state !== "active" ||
					!parent.reserved ||
					!parentRun ||
					parentRun.revision !== request.if_parent_revision ||
					!child ||
					child.revision !== request.if_child_revision ||
					child.state !== "queued" ||
					!state ||
					!definition ||
					(definition.policy?.max_parallel ?? 1) !== 1 ||
					!containment ||
					containment.state !== "running" ||
					containment.isolation.mode !== "serial" ||
					this.getSnapshot(child.snapshot_ref)?.definition !== containment.source ||
					this.#db
						.query("SELECT 1 FROM graph_child_executions WHERE child_run_id=? OR parent_run_id=?")
						.get(parentRun.id, child.id) ||
					this.#hasAcceptanceEffects(parentRun.id) ||
					this.#hasAcceptanceEffects(child.id) ||
					this.getDispatchIntents(child.id).length ||
					state.invocations.some(
						item => !item.superseded && ["running", "waiting", "unknown"].includes(item.state),
					) ||
					this.getScheduleState(parentRun.id)!.invocations.some(
						item =>
							item.id !== request.parent.invocation_id &&
							!item.superseded &&
							parent.authority.parent.nodes[item.node]?.kind !== "human" &&
							["running", "waiting", "unknown"].includes(item.state),
					) ||
					this.getDispatchIntents(parentRun.id).some(
						intent =>
							intent.invocation_id !== request.parent.invocation_id &&
							["submitting", "accepted", "unknown"].includes(intent.state),
					) ||
					!this.#claimProfileWriter(parentRun.id)
				)
					throw new Error("Serial child requires an exact ready child, reserved parent and quiescent family");
				const writer = this.getProfileWriterAdmissions(ownerId, epoch).find(item => item.run_id === parentRun.id);
				if (!writer) throw new Error("Parent profile writer admission is unavailable");
				const admission = { scope_id: crypto.randomUUID(), child_run_id: child.id };
				const record: SerialChildWriterRecord = { request, admission, writer };
				this.#db
					.query("INSERT INTO graph_serial_child_writers VALUES (?,?,?,NULL)")
					.run(child.id, parentRun.id, canonicalJson(record));
				this.#saveSchedule(parentRun, this.getScheduleState(parentRun.id)!, "writer.child_admitted");
				this.#saveSchedule(child, state, "writer.parent_scope_inherited");
				return admission;
			})
			.immediate();
	}

	/** Keep terminal containment visible until its lent scope is atomically settled. */
	listSerialChildExecutions(
		ownerId: string,
		epoch: string,
	): { parent: ChildIdentity; record: ChildExecutionRecord; admission: GraphSerialChildWriterAdmission }[] {
		this.assertHostOwner(ownerId, epoch);
		const rows = this.#db
			.query(`SELECT w.data AS writer,c.data AS child FROM graph_serial_child_writers w
				JOIN graph_child_executions c ON c.child_run_id=w.child_run_id WHERE w.receipt IS NULL ORDER BY w.rowid`)
			.all() as { writer: string; child: string }[];
		return rows.map(row => {
			const scope = JSON.parse(row.writer) as SerialChildWriterRecord;
			return {
				parent: scope.request.parent,
				record: JSON.parse(row.child) as ChildExecutionRecord,
				admission: scope.admission,
			};
		});
	}

	/** A terminal child is insufficient: the trusted caller independently establishes
	 * that every child effect stopped. Release restores only parent-family admission,
	 * not another Run's access and not successful parent completion. */
	releaseSerialChildWriter(
		ownerId: string,
		epoch: string,
		stopped: GraphSerialChildWriterStopped,
	): GraphSerialChildWriterAdmission {
		return this.#releaseSerialChildWriter(ownerId, epoch, stopped, false);
	}

	#releaseSerialChildWriter(
		ownerId: string,
		epoch: string,
		stopped: GraphSerialChildWriterStopped,
		aggregating: boolean,
	): GraphSerialChildWriterAdmission {
		stopped = structuredClone(stopped);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				this.#assertWriterStopObservation(stopped);
				const row = this.#db
					.query("SELECT data,receipt FROM graph_serial_child_writers WHERE child_run_id=?")
					.get(stopped.identity.child_run_id) as { data: string; receipt: string | null } | null;
				if (!row) throw new Error("Serial child writer admission is unavailable");
				const record = JSON.parse(row.data) as SerialChildWriterRecord;
				if (canonicalJson(record.admission) !== canonicalJson(stopped.identity))
					throw new Error("Serial child writer admission identity does not match");
				if (row.receipt !== null) {
					if (row.receipt !== canonicalJson(stopped))
						throw new Error("Serial child writer release conflicts with its durable receipt");
					return record.admission;
				}
				const child = this.getRun(record.admission.child_run_id);
				const parent = this.getRun(record.request.parent.run_id);
				if (
					!child ||
					!parent ||
					child.revision !== stopped.if_revision ||
					!["succeeded", "failed", "cancelled"].includes(child.state) ||
					this.#hasAcceptanceEffects(child.id) ||
					this.getDispatchIntents(child.id).some(intent => !["finished", "cancelled"].includes(intent.state)) ||
					this.getScheduleState(child.id)?.invocations.some(
						item => !item.superseded && ["running", "waiting", "unknown"].includes(item.state),
					) ||
					!this.getProfileWriterAdmissions(ownerId, epoch).some(
						item => item.run_id === record.writer.run_id && item.admission_id === record.writer.admission_id,
					)
				)
					throw new Error("Serial child is not terminal and reconciled at the expected revision");
				if (child.state === "succeeded" && ["queued", "running", "held"].includes(parent.state) && !aggregating)
					throw new Error("Successful child requires atomic aggregation before releasing its writer scope");
				this.#db
					.query("UPDATE graph_serial_child_writers SET receipt=? WHERE child_run_id=?")
					.run(canonicalJson(stopped), child.id);
				this.#saveSchedule(child, this.getScheduleState(child.id)!, "writer.child_quiescent");
				this.#saveSchedule(parent, this.getScheduleState(parent.id)!, "writer.parent_scope_restored");
				return record.admission;
			})
			.immediate();
	}

	#assertWriterStopObservation(value: { observed: string; termination_ref: GraphRef }): void {
		if (
			!value.observed?.trim() ||
			!value.termination_ref?.id ||
			!/^sha256:[0-9a-f]{64}$/.test(value.termination_ref.digest)
		)
			throw new Error("Whole-scope quiescence observation and durable reference are required");
	}

	#serialChildWriterParent(runId: string): string | null {
		const row = this.#db
			.query("SELECT data FROM graph_serial_child_writers WHERE child_run_id=? AND receipt IS NULL")
			.get(runId) as { data: string } | null;
		if (!row || !this.#ownerId || !this.#ownerEpoch) return null;
		const record = JSON.parse(row.data) as SerialChildWriterRecord;
		const parent = this.resolveChildParent(this.#ownerId, this.#ownerEpoch, record.request.parent, "recovery");
		if (!parent || !["active", "held"].includes(parent.state) || !parent.reserved) return null;
		const containment = this.#db
			.query(
				"SELECT data FROM graph_child_executions WHERE child_run_id=? AND parent_run_id=? AND parent_invocation_id=?",
			)
			.get(runId, record.request.parent.run_id, record.request.parent.invocation_id) as { data: string } | null;
		if (!containment) return null;
		const containmentState = (JSON.parse(containment.data) as ChildExecutionRecord).state;
		if (containmentState !== "running" && !(containmentState === "held" && this.getRun(runId)?.state === "succeeded"))
			return null;
		const writer = this.#db
			.query("SELECT admission_id FROM graph_profile_writers WHERE run_id=? AND receipt IS NULL")
			.get(record.writer.run_id) as { admission_id: string } | null;
		if (writer?.admission_id !== record.writer.admission_id) return null;
		return record.writer.run_id;
	}

	/** Trusted owner inspection; these reservations outlive Host ownership and Run termination. */
	getProfileWriterAdmissions(ownerId: string, epoch: string): GraphProfileWriterAdmission[] {
		this.assertHostOwner(ownerId, epoch);
		return this.#db
			.query("SELECT run_id,admission_id FROM graph_profile_writers WHERE receipt IS NULL ORDER BY rowid")
			.all() as GraphProfileWriterAdmission[];
	}

	/**
	 * Trusted embedding only: the caller must independently establish quiescence of
	 * the entire Run's writable scope, including descendants and remote effects.
	 * A terminal Run, expired lease, PID or leader exit alone is not that proof.
	 * This records the caller's observation; it does not verify OS containment.
	 */
	reconcileProfileWriter(
		ownerId: string,
		epoch: string,
		stopped: GraphProfileWriterStopped,
	): GraphProfileWriterReceipt {
		stopped = structuredClone(stopped);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				if (
					!stopped.observed?.trim() ||
					!stopped.termination_ref?.id ||
					!/^sha256:[0-9a-f]{64}$/.test(stopped.termination_ref.digest)
				)
					throw new Error("Run-scope quiescence observation and durable reference are required");
				const row = this.#db
					.query("SELECT receipt FROM graph_profile_writers WHERE run_id=? AND admission_id=?")
					.get(stopped.identity.run_id, stopped.identity.admission_id) as { receipt: string | null } | null;
				if (!row) throw new Error("Profile writer admission identity does not match");
				if (row.receipt) {
					const prior = JSON.parse(row.receipt) as {
						stopped: GraphProfileWriterStopped;
						result: GraphProfileWriterReceipt;
					};
					if (canonicalJson(prior.stopped) !== canonicalJson(stopped))
						throw new Error("Profile writer reconciliation conflicts with its durable receipt");
					return prior.result;
				}
				const run = this.getRun(stopped.identity.run_id);
				const state = run && this.getScheduleState(run.id);
				if (
					!run ||
					!state ||
					run.revision !== stopped.if_revision ||
					!["succeeded", "failed", "cancelled"].includes(run.state) ||
					this.#hasAcceptanceEffects(run.id) ||
					this.getDispatchIntents(run.id).some(intent => !["finished", "cancelled"].includes(intent.state)) ||
					this.#db
						.query("SELECT 1 FROM graph_serial_child_writers WHERE parent_run_id=? AND receipt IS NULL")
						.get(run.id) ||
					this.#db
						.query(`WITH RECURSIVE descendants(id) AS (
						SELECT child_run_id FROM graph_child_executions WHERE parent_run_id=?
						UNION SELECT c.child_run_id FROM graph_child_executions c JOIN descendants d ON c.parent_run_id=d.id)
						SELECT 1 FROM descendants d JOIN graph_runs r ON r.id=d.id
						WHERE json_extract(r.data,'$.state') NOT IN ('succeeded','failed','cancelled')
						OR EXISTS (SELECT 1 FROM graph_dispatch_intents i WHERE i.run_id=d.id
							AND json_extract(i.data,'$.state') NOT IN ('finished','cancelled'))
						OR EXISTS (SELECT 1 FROM graph_acceptance_executions a WHERE a.run_id=d.id AND a.state!='finished')
						LIMIT 1`)
						.get(run.id)
				)
					throw new Error("Profile writer Run is not terminal and reconciled at the expected revision");
				this.#saveSchedule(run, state, "writer.quiescent");
				const result: GraphProfileWriterReceipt = { identity: stopped.identity, revision: run.revision };
				this.#db
					.query("UPDATE graph_profile_writers SET receipt=? WHERE run_id=? AND admission_id=?")
					.run(JSON.stringify({ stopped, result }), run.id, stopped.identity.admission_id);
				return result;
			})
			.immediate();
	}

	/** Root Run reservation survives serial child lending and Host restart. */
	#claimProfileWriter(runId: string): boolean {
		if (!this.#db.inTransaction) throw new Error("Profile writer admission requires a transaction");
		const parentId = this.#serialChildWriterParent(runId);
		if (this.#db.query("SELECT 1 FROM graph_child_executions WHERE child_run_id=?").get(runId) && !parentId)
			return false;
		if (
			this.#db.query("SELECT 1 FROM graph_serial_child_writers WHERE parent_run_id=? AND receipt IS NULL").get(runId)
		)
			return false;
		const rootId = parentId ?? runId;
		// Effect-free Runs never write the profile, so serializing them behind another
		// writer reservation protects nothing. The verdict is derived from the frozen
		// definition, never from a caller-supplied flag.
		if (!parentId && this.#isEffectFree(rootId)) return true;
		if (this.#db.query("SELECT 1 FROM graph_profile_writers WHERE run_id<>? AND receipt IS NULL LIMIT 1").get(rootId))
			return false;
		const own = this.#db.query("SELECT receipt FROM graph_profile_writers WHERE run_id=?").get(rootId) as {
			receipt: string | null;
		} | null;
		if (own) return own.receipt === null;
		this.#db.query("INSERT INTO graph_profile_writers VALUES (?,?,NULL)").run(rootId, crypto.randomUUID());
		return true;
	}

	/**
	 * Frozen-content verdict: no member may write or execute and every node is a Bot or a
	 * human gate. Program, queue and subgraph nodes keep the whole-Run reservation because
	 * member grants do not bound their side effects.
	 */
	#isEffectFree(runId: string): boolean {
		const definition = this.getFrozenDefinition(runId);
		if (!definition) return false;
		for (const member of Object.values(definition.members))
			if (member.permissions.write.length || member.permissions.execute.length) return false;
		for (const node of Object.values(definition.nodes))
			if (node.kind !== "bot" && node.kind !== "human") return false;
		return !this.#db.query("SELECT 1 FROM graph_child_executions WHERE parent_run_id=? LIMIT 1").get(runId);
	}

	/** Old terminal results do not prove that their writable effects stopped. */
	#migrateProfileWriters(): void {
		this.#db
			.transaction(() => {
				if (this.#db.query("SELECT 1 FROM graph_profile_writer_migrations WHERE version=1").get()) return;
				const rows = this.#db
					.query(
						"SELECT DISTINCT run_id FROM graph_dispatch_intents WHERE json_extract(data,'$.state') NOT IN ('pending','cancelled') UNION SELECT run_id FROM graph_acceptance_executions",
					)
					.all() as { run_id: string }[];
				for (const { run_id } of rows) {
					const definition = this.getFrozenDefinition(run_id);
					const effects = this.getDispatchIntents(run_id).some(intent => {
						if (["pending", "cancelled"].includes(intent.state)) return false;
						const invocation = this.getScheduleState(run_id)?.invocations.find(
							item => item.id === intent.invocation_id,
						);
						return (
							invocation?.consultation || !invocation || definition?.nodes[invocation.node]?.kind !== "human"
						);
					});
					if (effects || this.#db.query("SELECT 1 FROM graph_acceptance_executions WHERE run_id=?").get(run_id))
						this.#db
							.query("INSERT OR IGNORE INTO graph_profile_writers VALUES (?,?,NULL)")
							.run(run_id, crypto.randomUUID());
				}
				this.#db.query("INSERT INTO graph_profile_writer_migrations VALUES (1)").run();
			})
			.immediate();
	}

	/** null means a callback changed durable state; callers must not overwrite it. */
	#authorizeChildDispatch(
		ownerId: string,
		epoch: string,
		policy: GraphChildDispatchPolicy | undefined,
		phase: "reserve" | "dispatch" | "create",
		run: GraphRunRecord,
		state: GraphScheduleState,
		invocation: SchedulerInvocation,
		snapshot: GraphRunSnapshot,
	): boolean | null {
		if (!policy) return false;
		const { authorize } = policy;
		let allowed = false;
		try {
			allowed = authorize(this.#db, structuredClone({ phase, run, snapshot, invocation })) === true;
		} catch {
			// Unavailable policy is never authority.
		}
		this.assertHostOwner(ownerId, epoch);
		if (
			canonicalJson(this.getRun(run.id)) !== canonicalJson(run) ||
			canonicalJson(this.getScheduleState(run.id)) !== canonicalJson(state)
		)
			return null;
		return allowed;
	}

	/** Persist the submission boundary before making an external call. */
	claimDispatch(
		ownerId: string,
		epoch: string,
		intentId: string,
		childPolicy?: GraphChildDispatchPolicy,
	): GraphDispatchIntent | null {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const row = this.#db.query("SELECT data FROM graph_dispatch_intents WHERE id=?").get(intentId) as {
					data: string;
				} | null;
				if (!row) return null;
				const intent = JSON.parse(row.data) as GraphDispatchIntent;
				if (
					this.#db.query("SELECT 1 FROM graph_child_executions WHERE child_run_id=?").get(intent.run_id) &&
					!this.#serialChildWriterParent(intent.run_id)
				)
					return null;
				const run = this.getRun(intent.run_id);
				const state = this.getScheduleState(intent.run_id);
				const invocation = state?.invocations.find(item => item.id === intent.invocation_id);
				if (
					!run ||
					!state ||
					(run.state !== "queued" && run.state !== "running") ||
					intent.state !== "pending" ||
					intent.fence !== epoch ||
					invocation?.state !== "running" ||
					invocation.attempt_id !== intent.attempt_id
				)
					return null;
				const definition = this.getFrozenDefinition(run.id);
				if (!definition || this.#holdCostLimitedRun(run, state, definition)) return null;
				if (definition.nodes[invocation.node]?.kind === "subgraph") {
					const snapshot = this.getSnapshot(run.snapshot_ref);
					const allowed = snapshot
						? this.#authorizeChildDispatch(
								ownerId,
								epoch,
								childPolicy,
								"dispatch",
								run,
								state,
								invocation,
								snapshot,
							)
						: false;
					if (allowed !== true) {
						if (allowed === false) {
							run.state = "held";
							run.reason = "Subgraph dispatch requires current trusted admission";
							this.#saveSchedule(run, state, "dispatch.held");
						}
						return null;
					}
					const current = this.getDispatchIntents(run.id).find(item => item.id === intent.id);
					if (canonicalJson(current) !== canonicalJson(intent)) return null;
				}
				if (
					(invocation.consultation || definition.nodes[invocation.node]?.kind !== "human") &&
					!this.#claimProfileWriter(run.id)
				)
					return null;
				intent.state = "submitting";
				this.#db
					.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
					.run(JSON.stringify(intent), intent.id);
				this.#saveSchedule(run, state, "dispatch.submitting");
				return intent;
			})
			.immediate();
	}

	/** Freeze selected Bot references before admitting the exact envelope to a durable mailbox. */
	prepareBotHandoff(ownerId: string, epoch: string, intentId: string, input: string): string {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const row = this.#db.query("SELECT data FROM graph_dispatch_intents WHERE id=?").get(intentId) as {
					data: string;
				} | null;
				if (!row) throw new Error("Graph dispatch is unavailable");
				const intent = JSON.parse(row.data) as GraphDispatchIntent;
				const run = this.getRun(intent.run_id);
				const state = this.getScheduleState(intent.run_id);
				const target = state?.invocations.find(item => item.id === intent.invocation_id);
				if (
					!run ||
					!target ||
					intent.fence !== epoch ||
					intent.state !== "submitting" ||
					target.attempt_id !== intent.attempt_id ||
					target.state !== "running" ||
					!["queued", "running"].includes(run.state)
				)
					throw new Error("Graph handoff preparation lost its dispatch fence");
				const snapshot = this.getSnapshot(run.snapshot_ref);
				const definition = this.getFrozenDefinition(run.id);
				if (
					!snapshot?.observation ||
					!definition ||
					definition.nodes[target.node]?.kind !== "bot" ||
					target.consultation
				)
					return input;
				const records = this.#wire.snapshot(snapshot.observation.source_id, run.id).records;
				// Legacy topology-only Runs cannot acquire newly manufactured handoff history.
				if (!records.some(record => record.kind === "execution_run")) return input;
				const existing = this.#db.query("SELECT data FROM graph_bot_handoffs WHERE intent_id=?").get(intent.id) as {
					data: string;
				} | null;
				if (existing) {
					const frozen = JSON.parse(existing.data) as GraphBotHandoffRecord;
					const { input: _input, receipt: _receipt, occurred_at: _time, ...envelope } = frozen;
					if (renderGraphBotHandoff(input, envelope) !== frozen.input)
						throw new Error("Graph handoff input conflicts with its frozen envelope");
					return frozen.input;
				}
				const bindings = new Map(
					records.flatMap(record =>
						record.kind === "binding" ? [[record.value.binding_id, record.value] as const] : [],
					),
				);
				const handoffs = selectGraphBotHandoffs(
					definition,
					target,
					intent,
					bindings,
					this.getAttemptHistory(run.id)
						.filter(entry => entry.accepted)
						.map(entry => entry.completion),
					state!.invocations,
				);
				if (!handoffs.length) return input;
				const envelope = {
					intent_id: intent.id,
					run_id: run.id,
					invocation_id: target.id,
					attempt_id: intent.attempt_id,
					request_key: intent.request_key,
					fence: intent.fence,
					bot_id: snapshot.observation.members[definition.nodes[target.node].member!].bot.bot_id,
					handoffs,
				};
				const frozen: GraphBotHandoffRecord = {
					...envelope,
					input: renderGraphBotHandoff(input, envelope),
					receipt: null,
					occurred_at: null,
				};
				this.#db
					.query("INSERT INTO graph_bot_handoffs VALUES (?,?,?)")
					.run(intent.id, run.id, JSON.stringify(frozen));
				return frozen.input;
			})
			.immediate();
	}

	/** Confirm admission, not consumption: receipt and Transfer publication share this Host transaction. */
	confirmBotHandoff(
		ownerId: string,
		epoch: string,
		intentId: string,
		bots: BotStore,
		jobId: string,
		observation: Record<string, unknown>,
	): boolean {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const row = this.#db.query("SELECT data FROM graph_bot_handoffs WHERE intent_id=?").get(intentId) as {
					data: string;
				} | null;
				if (!row) return this.observeDispatch(ownerId, epoch, intentId, "accepted", observation);
				const frozen = JSON.parse(row.data) as GraphBotHandoffRecord;
				const intent = this.getDispatchIntents(frozen.run_id).find(item => item.id === intentId);
				const run = this.getRun(frozen.run_id);
				const state = this.getScheduleState(frozen.run_id);
				const target = state?.invocations.find(item => item.id === frozen.invocation_id);
				if (
					!intent ||
					!run ||
					!state ||
					!target ||
					intent.fence !== epoch ||
					frozen.fence !== epoch ||
					intent.attempt_id !== frozen.attempt_id ||
					target.attempt_id !== frozen.attempt_id ||
					target.state !== "running" ||
					!["submitting", "accepted"].includes(intent.state) ||
					!["queued", "running"].includes(run.state)
				)
					return false;
				if (frozen.receipt) return frozen.receipt.job_id === jobId;
				const admitted = bots.graphHostedByKey(frozen.bot_id, intent.request_key);
				if (
					!admitted ||
					admitted.receipt.job_id !== jobId ||
					!admitted.receipt.accepted ||
					admitted.job.bot_id !== frozen.bot_id
				)
					return false;
				const context = admitted.job.graph_context;
				const attempt =
					this.getDispatchIntents(run.id)
						.filter(item => item.invocation_id === target.id)
						.findIndex(item => item.id === intent.id) + 1;
				if (
					!context ||
					context.graph_run_id !== run.id ||
					context.graph_id !== run.graph_id ||
					context.invocation_id !== target.id ||
					context.node_id !== target.node ||
					context.attempt !== attempt
				)
					return false;
				const queued = admitted.job.inputs.find(item => item.request_id === admitted.receipt.request_id);
				if (!queued || queued.input !== frozen.input || queued.reply_to || queued.steer) return false;
				frozen.receipt = admitted.receipt;
				frozen.occurred_at = new Date().toISOString();
				intent.state = "accepted";
				intent.observation = { ...observation, job_id: jobId, bot_id: frozen.bot_id };
				this.#db
					.query("UPDATE graph_bot_handoffs SET data=? WHERE intent_id=?")
					.run(JSON.stringify(frozen), intentId);
				this.#db.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?").run(JSON.stringify(intent), intentId);
				this.#saveSchedule(run, state, "dispatch.handoff_admitted");
				return true;
			})
			.immediate();
	}

	/** Unknown submissions never become dispatchable again without explicit reconciliation. */
	observeDispatch(
		ownerId: string,
		epoch: string,
		intentId: string,
		next: "accepted" | "unknown",
		observation: unknown,
	): boolean {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const row = this.#db.query("SELECT data FROM graph_dispatch_intents WHERE id=?").get(intentId) as {
					data: string;
				} | null;
				if (!row) return false;
				const intent = JSON.parse(row.data) as GraphDispatchIntent;
				const run = this.getRun(intent.run_id);
				const state = this.getScheduleState(intent.run_id);
				if (!run || !state || !["pending", "submitting", "accepted"].includes(intent.state)) return false;
				if (
					next === "accepted" &&
					(intent.fence !== epoch ||
						intent.state === "pending" ||
						(run.state !== "queued" && run.state !== "running"))
				)
					return false;
				intent.state = next;
				intent.observation = observation;
				this.#db
					.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
					.run(JSON.stringify(intent), intent.id);
				if (next === "unknown" && (run.state === "queued" || run.state === "running")) {
					run.state = "held";
					run.reason = "Dispatch result unknown; reconciliation required";
				}
				this.#saveSchedule(run, state, `dispatch.${next}`);
				return true;
			})
			.immediate();
	}

	/**
	 * Trusted embedding only. Independently establish that this exact execution
	 * and its effects have stopped before submitting a durable observation.
	 * Records failure/cancellation, never success, replay or whole-Run quiescence.
	 */
	reconcileProgramExecution(
		ownerId: string,
		epoch: string,
		stopped: GraphProgramStopped,
	): GraphProgramRecoveryReceipt {
		stopped = structuredClone(stopped);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				if (
					!stopped.observed?.trim() ||
					!stopped.termination_ref?.id ||
					!/^sha256:[0-9a-f]{64}$/.test(stopped.termination_ref.digest)
				)
					throw new Error("A durable execution-bound stop observation is required");
				const identity = stopped.identity;
				const row = this.#db
					.query("SELECT data FROM graph_dispatch_intents WHERE id=?")
					.get(identity.intent_id) as { data: string } | null;
				const intent = row && (JSON.parse(row.data) as GraphDispatchIntent);
				if (
					!intent ||
					intent.run_id !== identity.run_id ||
					intent.invocation_id !== identity.invocation_id ||
					intent.attempt_id !== identity.attempt_id ||
					intent.fence !== identity.fence ||
					intent.request_key !== identity.request_key
				)
					throw new Error("Program execution identity does not match its durable dispatch");
				const prior = this.#db
					.query("SELECT data FROM graph_program_reconciliations WHERE intent_id=?")
					.get(intent.id) as { data: string } | null;
				if (prior) {
					const receipt = JSON.parse(prior.data) as {
						stopped: GraphProgramStopped;
						result: GraphProgramRecoveryReceipt;
					};
					if (canonicalJson(receipt.stopped) !== canonicalJson(stopped))
						throw new Error("Program execution reconciliation conflicts with its durable receipt");
					return receipt.result;
				}
				const run = this.getRun(intent.run_id);
				const state = this.getScheduleState(intent.run_id);
				const invocation = state?.invocations.find(item => item.id === intent.invocation_id);
				const node = invocation && this.getFrozenDefinition(intent.run_id)?.nodes[invocation.node];
				if (!node || node.kind !== "program" || invocation?.consultation)
					throw new Error("Stop reconciliation requires a program node");
				if (
					!run ||
					!state ||
					run.revision !== stopped.if_revision ||
					!["held", "cancelling"].includes(run.state) ||
					!invocation ||
					invocation.superseded ||
					invocation.attempt_id !== intent.attempt_id ||
					!["running", "waiting", "unknown"].includes(invocation.state) ||
					intent.state !== "unknown"
				)
					throw new Error("Program execution is not unknown at the expected Run revision");
				const completion: GraphAttemptCompletion = {
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
					state: run.state === "cancelling" ? "cancelled" : "failed",
					error: "Program execution stopped; original result unavailable, no replay performed",
				};
				invocation.state = completion.state;
				invocation.routed = false;
				intent.state = "finished";
				intent.observation = { previous: intent.observation, recovery: stopped, completion };
				this.#db
					.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
					.run(JSON.stringify(intent), intent.id);
				this.#db
					.query(
						"INSERT INTO graph_attempt_history (run_id,invocation_id,attempt_id,fence,accepted,data,recorded_at) VALUES (?,?,?,?,?,?,?)",
					)
					.run(
						intent.run_id,
						intent.invocation_id,
						intent.attempt_id,
						intent.fence,
						1,
						JSON.stringify(completion),
						new Date().toISOString(),
					);
				if (run.state !== "cancelling") run.reason = completion.error!;
				this.#settleCancellation(run, state);
				this.#saveSchedule(run, state, "program.recovery_confirmed");
				const result: GraphProgramRecoveryReceipt = { identity, completion, revision: run.revision };
				this.#db
					.query("INSERT INTO graph_program_reconciliations VALUES (?,?)")
					.run(intent.id, JSON.stringify({ stopped, result }));
				return result;
			})
			.immediate();
	}

	/**
	 * Trusted embedding only. Records that an unconfirmed Bot attempt stopped and
	 * failed; it never accepts success, replays the attempt or proves whole-Run
	 * quiescence. `observed` is the operator's evidence for that claim.
	 */
	reconcileBotExecution(ownerId: string, epoch: string, stopped: GraphBotStopped): GraphBotRecoveryReceipt {
		stopped = structuredClone(stopped);
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				if (
					!stopped.observed?.trim() ||
					!stopped.termination_ref?.id ||
					!/^sha256:[0-9a-f]{64}$/.test(stopped.termination_ref.digest)
				)
					throw new Error("A durable Bot attempt stop observation is required");
				const identity = stopped.identity;
				const row = this.#db
					.query("SELECT data FROM graph_dispatch_intents WHERE id=?")
					.get(identity.intent_id) as { data: string } | null;
				const intent = row && (JSON.parse(row.data) as GraphDispatchIntent);
				if (
					!intent ||
					intent.run_id !== identity.run_id ||
					intent.invocation_id !== identity.invocation_id ||
					intent.attempt_id !== identity.attempt_id ||
					intent.fence !== identity.fence ||
					intent.request_key !== identity.request_key
				)
					throw new Error("Bot attempt identity does not match its durable dispatch");
				const prior = this.#db
					.query("SELECT data FROM graph_bot_reconciliations WHERE intent_id=?")
					.get(intent.id) as { data: string } | null;
				if (prior) {
					const receipt = JSON.parse(prior.data) as {
						stopped: GraphBotStopped;
						result: GraphBotRecoveryReceipt;
					};
					if (canonicalJson(receipt.stopped) !== canonicalJson(stopped))
						throw new Error("Bot execution reconciliation conflicts with its durable receipt");
					return receipt.result;
				}
				const run = this.getRun(intent.run_id);
				const state = this.getScheduleState(intent.run_id);
				const invocation = state?.invocations.find(item => item.id === intent.invocation_id);
				const node = invocation && this.getFrozenDefinition(intent.run_id)?.nodes[invocation.node];
				if (!node || node.kind !== "bot" || invocation?.consultation)
					throw new Error("Stop reconciliation requires a Bot node");
				if (
					!run ||
					!state ||
					run.revision !== stopped.if_revision ||
					!["held", "cancelling"].includes(run.state) ||
					!invocation ||
					invocation.superseded ||
					invocation.attempt_id !== intent.attempt_id ||
					!["running", "waiting", "unknown"].includes(invocation.state) ||
					intent.state !== "unknown"
				)
					throw new Error("Bot execution is not unknown at the expected Run revision");
				const completion: GraphAttemptCompletion = {
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
					state: run.state === "cancelling" ? "cancelled" : "failed",
					error: "Bot attempt stopped; original result unavailable, no replay performed",
				};
				invocation.state = completion.state;
				invocation.routed = false;
				intent.state = "finished";
				intent.observation = { previous: intent.observation, recovery: stopped, completion };
				this.#db
					.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
					.run(JSON.stringify(intent), intent.id);
				this.#db
					.query(
						"INSERT INTO graph_attempt_history (run_id,invocation_id,attempt_id,fence,accepted,data,recorded_at) VALUES (?,?,?,?,?,?,?)",
					)
					.run(
						intent.run_id,
						intent.invocation_id,
						intent.attempt_id,
						intent.fence,
						1,
						JSON.stringify(completion),
						new Date().toISOString(),
					);
				if (run.state !== "cancelling") run.reason = completion.error!;
				this.#settleCancellation(run, state);
				this.#saveSchedule(run, state, "bot.recovery_confirmed");
				const result: GraphBotRecoveryReceipt = { identity, completion, revision: run.revision };
				this.#db
					.query("INSERT INTO graph_bot_reconciliations VALUES (?,?)")
					.run(intent.id, JSON.stringify({ stopped, result }));
				return result;
			})
			.immediate();
	}

	/**
	 * Trusted embedding only. Closes a held local Run after every unconfirmed attempt
	 * and dispatch intent has been reconciled. A Run that is already cancelling settles
	 * through that same reconciliation instead. It records cancellation; it does not
	 * prove that anything outside this profile stopped.
	 */
	closeHeldRun(
		ownerId: string,
		epoch: string,
		request: { run_id: string; if_revision: string; reason: string },
	): GraphRunRecord {
		if (!request.reason.trim()) throw new Error("A cancellation reason is required");
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(request.run_id);
				const state = this.getScheduleState(request.run_id);
				if (!run || !state) throw new Error("Run is unavailable");
				if (run.revision !== request.if_revision) throw new Error("Run changed at an unexpected revision");
				if (run.state !== "held") throw new Error("Only a held Run can be closed this way");
				if (this.#hasAcceptanceEffects(run.id)) throw new Error("Run has integration acceptance effects");
				if (
					this.getDispatchIntents(run.id).some(
						intent => intent.state !== "finished" && intent.state !== "cancelled",
					)
				)
					throw new Error("Every dispatch intent of the Run must be settled first");
				if (
					state.invocations.some(
						item => !item.superseded && ["running", "waiting", "unknown"].includes(item.state),
					)
				)
					throw new Error("Every attempt of the Run must be settled first");
				run.state = "cancelling";
				run.reason = request.reason;
				this.#settleCancellation(run, state);
				if (runStateOf(run) !== "cancelled") throw new Error("Run cancellation could not be settled");
				this.#saveSchedule(run, state, "run.recovery_cancelled");
				return run;
			})
			.immediate();
	}

	getAttemptHistory(runId: string): { accepted: boolean; completion: GraphAttemptCompletion; recorded_at: string }[] {
		this.definitions.assertProfileAccess();
		const rows = this.#db
			.query("SELECT accepted,data,recorded_at FROM graph_attempt_history WHERE run_id=? ORDER BY id")
			.all(runId) as { accepted: number; data: string; recorded_at: string }[];
		return rows.map(row => ({
			accepted: row.accepted === 1,
			completion: JSON.parse(row.data) as GraphAttemptCompletion,
			recorded_at: row.recorded_at,
		}));
	}

	/** Computes and commits one scheduler decision. The returned intent is not an external submission. */
	schedule(
		runId: string,
		ownerId: string,
		epoch: string,
		finalReview?: GraphFinalReviewPolicy,
		childRecovery?: ChildExecutionRecovery,
		childPolicy?: GraphChildDispatchPolicy,
	): GraphScheduleResult {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(runId);
				const state = this.getScheduleState(runId);
				if (!run || !state) throw new Error("Graph run or scheduling state not found");
				// A child may only use the root writer reservation under an explicit,
				// current serial-family transfer; creation alone cannot authorize work.
				if (
					(run.state === "queued" || run.state === "running") &&
					this.#db.query("SELECT 1 FROM graph_child_executions WHERE child_run_id=?").get(runId) &&
					!this.#serialChildWriterParent(runId)
				) {
					run.state = "held";
					run.reason = "Child Run requires enforcing child dispatch and aggregation";
					this.#saveSchedule(run, state, "schedule.held");
					return { action: null, intent: null, run };
				}
				if (this.#hasAcceptanceEffects(runId)) return { action: null, intent: null, run };
				const snapshot = this.getSnapshot(run.snapshot_ref);
				if (!snapshot) throw new Error("Graph run snapshot is unavailable");
				const validated = validateGraphForStart(snapshot.definition, this.#limits);
				if (validated.issues.length) throw new Error("Frozen graph definition is invalid");
				const definition = validated.source.frontmatter.frontmatter as unknown as GraphDefinition;
				if ((run.state === "queued" || run.state === "running") && this.#holdCostLimitedRun(run, state, definition))
					return { action: null, intent: null, run };
				if (run.state === "queued" || run.state === "running") {
					const intents = this.getDispatchIntents(runId);
					const recoveredQueue = (intent: GraphDispatchIntent, nodeId: string): boolean => {
						const node = definition.nodes[nodeId];
						if (node?.kind !== "queue" || !["submitting", "accepted"].includes(intent.state)) return false;
						const row = this.#db
							.query("SELECT data FROM graph_queue_records WHERE request_key=?")
							.get(intent.request_key) as { data: string } | null;
						if (!row) return false;
						const record = JSON.parse(row.data) as QueueRecord;
						return queueRecordMatchesExecution(record, intent, node.executor);
					};
					const recoveredChild = (intent: GraphDispatchIntent, nodeId: string): boolean => {
						if (
							!childRecovery ||
							definition.nodes[nodeId]?.kind !== "subgraph" ||
							!["submitting", "accepted"].includes(intent.state)
						)
							return false;
						const identity = childRecovery.resolveIdentity(runId, intent.invocation_id);
						const serial = this.#db
							.query(
								"SELECT child_run_id FROM graph_serial_child_writers WHERE parent_run_id=? AND receipt IS NULL",
							)
							.get(runId) as { child_run_id: string } | null;
						return (
							identity?.run_id === runId &&
							identity.invocation_id === intent.invocation_id &&
							identity.attempt_id === intent.attempt_id &&
							identity.fence === intent.fence &&
							(hasRunningChildExecution(
								this.#db,
								this.#fencedChildHost(ownerId, epoch, childRecovery.host, "recovery"),
								identity,
							) ||
								(serial &&
									this.#serialChildWriterParent(serial.child_run_id) === runId &&
									hasUnaggregatedChildExecution(
										this.#db,
										this.#fencedChildHost(ownerId, epoch, childRecovery.host, "recovery"),
										identity,
									)) === true)
						);
					};
					const orphan = state.invocations.find(
						item =>
							!item.superseded &&
							item.state === "running" &&
							!intents.some(
								intent =>
									intent.invocation_id === item.id &&
									intent.attempt_id === item.attempt_id &&
									(intent.fence === epoch ||
										recoveredQueue(intent, item.node) ||
										recoveredChild(intent, item.node)) &&
									intent.state !== "finished" &&
									intent.state !== "cancelled",
							),
					);
					// Recovery callbacks can reenter lifecycle mutations within this transaction.
					// Preserve their committed state instead of saving the pre-callback snapshot.
					this.assertHostOwner(ownerId, epoch);
					const currentRun = this.getRun(runId)!;
					if (
						canonicalJson(currentRun) !== canonicalJson(run) ||
						canonicalJson(this.getScheduleState(runId)) !== canonicalJson(state)
					)
						return { action: null, intent: null, run: currentRun };
					if (orphan) {
						run.state = "held";
						run.reason = "Running attempt requires reconciliation under the current host fence";
						const error = { code: "invalid_state" as const, message: run.reason, invocation_id: orphan.id };
						this.#saveSchedule(run, state, "schedule.held");
						return { action: { type: "hold" as const, invocation_id: orphan.id, error }, intent: null, run };
					}
				}
				state.run_state = run.state;
				const virtual = new Set([
					...Object.values(definition.loops ?? {}).map(loop => loop.final_node),
					...Object.values(definition.nodes).flatMap(node =>
						node.on_budget_exhausted && node.on_budget_exhausted !== "hold" ? [node.on_budget_exhausted] : [],
					),
				]);
				const settle = (): boolean => {
					const terminal = state.invocations.filter(item => !item.superseded && item.terminal_disposition);
					if (
						!terminal.length ||
						state.invocations.some(
							item =>
								!item.superseded &&
								!(
									item.state === "skipped" ||
									(item.state === "succeeded" && item.routed) ||
									(item.state === "pending" && virtual.has(item.node) && !item.activated)
								),
						)
					)
						return false;
					run.state = terminal.some(item => item.terminal_disposition === "fail") ? "failed" : "succeeded";
					run.reason = null;
					return true;
				};
				const plan = planGraphSchedule(definition, state);
				const action = plan.action;
				let intent: GraphDispatchIntent | null = null;
				let returnedAction: SchedulerAction | null = action;
				if (!action) {
					if ((run.state === "queued" || run.state === "running") && plan.errors.length) {
						const error = plan.errors[0];
						run.state = "held";
						run.reason = error.message;
						this.#saveSchedule(run, state, "schedule.held");
						const invocationId = error.invocation_id ?? state.invocations[0]?.id;
						return {
							action: invocationId ? { type: "hold" as const, invocation_id: invocationId, error } : null,
							intent,
							run,
						};
					}
					if (
						(run.state === "queued" || run.state === "running") &&
						state.invocations.some(
							item => !item.superseded && ["failed", "blocked", "cancelled", "unknown"].includes(item.state),
						)
					) {
						const quiescent =
							state.invocations.every(
								item =>
									item.superseded ||
									["succeeded", "failed", "blocked", "skipped", "cancelled"].includes(item.state) ||
									(item.state === "pending" && virtual.has(item.node) && !item.activated),
							) &&
							this.getDispatchIntents(runId).every(intent => ["finished", "cancelled"].includes(intent.state)) &&
							!this.#hasConsultationEffects(runId);
						const uncertainOrCancelled = state.invocations.some(
							item => !item.superseded && ["unknown", "cancelled"].includes(item.state),
						);
						if (quiescent && !uncertainOrCancelled) {
							run.state = "failed";
							run.reason = "Graph has terminal failed or blocked invocations";
							this.#saveSchedule(run, state, "schedule.failed");
						} else if (uncertainOrCancelled) {
							run.state = "held";
							run.reason = "Graph has unknown or externally cancelled invocations";
							this.#saveSchedule(run, state, "schedule.held");
						}
					} else if ((run.state === "queued" || run.state === "running") && settle()) {
						this.#saveSchedule(run, state, "schedule.finished");
					}
					return { action, intent, run };
				}
				const invocation = state.invocations.find(item => item.id === action.invocation_id);
				if (!invocation) throw new Error("Scheduler selected an unknown invocation");
				if (
					action.type !== "hold" &&
					invocation.state === "succeeded" &&
					Object.values(definition.loops ?? {}).some(
						loop => loop.final_node === invocation.node && loop.final_outcomes.go === invocation.outcome,
					)
				) {
					let evidence: GraphStoredInvocation["final_review_evidence"];
					try {
						if (
							finalReview &&
							invocation.ready &&
							invocation.attempt_id &&
							invocation.activation_source?.reason === "loop_exhausted"
						) {
							const inputs = structuredClone(invocation.ready.inputs);
							const outputs = structuredClone(invocation.outputs ?? {});
							const artifacts: Record<string, GraphRef> = {};
							for (const [name, value] of Object.entries(inputs))
								if (typeof value !== "string") artifacts[`input:${name}`] = value;
							for (const [name, value] of Object.entries(outputs)) artifacts[`output:${name}`] = value;
							const binding = {
								invocation_id: invocation.id,
								input_digest: `sha256:${Bun.SHA256.hash(canonicalJson(inputs), "hex")}`,
								artifacts,
							};
							const context: GraphFinalReviewContext = {
								run: structuredClone(run),
								invocation_id: invocation.id,
								attempt_id: invocation.attempt_id,
								activation_source: structuredClone(invocation.activation_source),
								inputs,
								outputs,
								binding,
							};
							const resolved = finalReview.resolve(structuredClone(context));
							if (resolved) {
								// Normalize before verification so exactly what is checked is what is persisted.
								const data = JSON.parse(JSON.stringify(resolved)) as GraphFinalReviewResolution;
								const authority: FinalReviewAuthority = {
									...binding,
									blocker_ids: data.blocker_ids,
									inventory_evidence: data.inventory_evidence,
								};
								const result = verifyFinalReview(authority, data.submission, claim =>
									finalReview.verifyEvidence(claim, structuredClone(context)),
								);
								if (result.allowed)
									evidence = { authority, submission: data.submission, attempt_id: invocation.attempt_id };
							}
						}
					} catch {
						// Unavailable or malformed authority is never approval.
					}
					if (!evidence) {
						run.state = "held";
						run.reason = "Final approval requires blocker evidence validation";
						const error = {
							code: "gate_unsatisfied" as const,
							message: run.reason,
							invocation_id: invocation.id,
						};
						this.#saveSchedule(run, state, "schedule.hold");
						return { action: { type: "hold" as const, invocation_id: invocation.id, error }, intent, run };
					}
					invocation.final_review_evidence = evidence;
				}
				switch (action.type) {
					case "ready":
						invocation.state = "ready";
						invocation.ready = action;
						if (action.winner_edge) invocation.winner_edge = action.winner_edge;
						break;
					case "authorize": {
						if (this.#db.query("SELECT 1 FROM graph_granted_runs WHERE run_id=?").get(runId)) {
							run.state = "held";
							run.reason = "Owner-granted execution requires enforced process containment and revocation fences";
							const error = {
								code: "gate_unsatisfied" as const,
								message: run.reason,
								invocation_id: invocation.id,
							};
							this.#saveSchedule(run, state, "schedule.held");
							return {
								action: { type: "hold" as const, invocation_id: invocation.id, error },
								intent: null,
								run,
							};
						}
						if (definition.nodes[invocation.node]?.kind === "subgraph") {
							if (
								state.invocations.some(
									item =>
										item.id !== invocation.id &&
										!item.superseded &&
										definition.nodes[item.node]?.kind !== "human" &&
										["running", "waiting", "unknown"].includes(item.state),
								)
							)
								return { action: null, intent: null, run };
							const allowed = this.#authorizeChildDispatch(
								ownerId,
								epoch,
								childPolicy,
								"reserve",
								run,
								state,
								invocation,
								snapshot,
							);
							if (allowed === null) return { action: null, intent: null, run: this.getRun(runId)! };
							if (!allowed) {
								run.state = "held";
								run.reason = "Subgraph execution requires an enforcing child executor and verified aggregation";
								const error = {
									code: "gate_unsatisfied" as const,
									message: run.reason,
									invocation_id: invocation.id,
								};
								this.#saveSchedule(run, state, "schedule.held");
								return {
									action: { type: "hold" as const, invocation_id: invocation.id, error },
									intent: null,
									run,
								};
							}
						}
						if (definition.nodes[invocation.node]?.kind !== "human") {
							if (!this.#claimProfileWriter(runId)) {
								const reason = "Waiting for another Run's profile writer scope to become quiescent";
								if (run.reason !== reason) {
									run.reason = reason;
									this.#saveSchedule(run, state, "writer.waiting");
								}
								return { action: null, intent: null, run };
							}
							run.reason = null;
						}
						if (!invocation.ready) throw new Error("Ready invocation lacks persisted inputs");
						for (const reservation of action.reservations) {
							let counter = state.counters.find(item => item.key === reservation.key);
							if (!counter) {
								counter = { key: reservation.key, consumed: 0, reservations: [] };
								state.counters.push(counter);
							}
							if (!counter.reservations.includes(reservation.reservation)) {
								if (counter.consumed >= reservation.limit)
									throw new Error("Scheduler reservation exceeds limit");
								counter.reservations.push(reservation.reservation);
								counter.consumed++;
							}
						}
						const attemptId = crypto.randomUUID();
						invocation.attempt_id = attemptId;
						invocation.state = "running";
						intent = {
							id: crypto.randomUUID(),
							run_id: runId,
							invocation_id: invocation.id,
							attempt_id: attemptId,
							request_key: crypto.randomUUID(),
							fence: epoch,
							state: "pending",
							request: {
								node: invocation.node,
								snapshot_ref: run.snapshot_ref,
								activation_source: invocation.activation_source,
								...invocation.ready,
							},
							observation: null,
						};
						this.#db
							.query("INSERT INTO graph_dispatch_intents VALUES (?,?,?,?)")
							.run(intent.id, runId, intent.request_key, JSON.stringify(intent));
						run.state = "running";
						break;
					}
					case "skip":
					case "block":
						invocation.state = action.type === "skip" ? "skipped" : "blocked";
						break;
					case "routed":
						invocation.routed = true;
						invocation.suppressed_edges = action.suppressed_edges ?? [];
						break;
					case "hold":
						run.state = "held";
						run.reason = action.error.message;
						break;
					case "route": {
						const targets = state.invocations.filter(item => !item.superseded && item.node === action.target);
						const target = targets[0];
						const hasIncoming = (definition.edges ?? []).some(edge => edge.to === action.target && !edge.loop);
						if (
							targets.length !== 1 ||
							!target ||
							target.state !== "pending" ||
							target.activated ||
							hasIncoming ||
							(invocation.state !== "ready" && invocation.state !== "succeeded")
						) {
							run.state = "held";
							run.reason =
								"Virtual route requires an unambiguous dormant target without ordinary incoming edges";
							returnedAction = {
								type: "hold",
								invocation_id: invocation.id,
								error: { code: "invalid_state", message: run.reason, invocation_id: invocation.id },
							};
							break;
						}
						target.activated = true;
						target.activation_source = {
							invocation_id: invocation.id,
							attempt_id: invocation.attempt_id,
							reason: action.reason,
						};
						if (invocation.state === "ready") invocation.state = "skipped";
						else invocation.routed = true;
						invocation.suppressed_edges = action.suppressed_edges ?? [];
						break;
					}
					case "rewind":
						try {
							const next = prepareGraphRewind(definition, state, action, () => crypto.randomUUID());
							const previous = next.invocations.find(item => item.id === invocation.id);
							if (!previous) throw new Error("Rewind source is missing from history");
							previous.suppressed_edges = action.suppressed_edges ?? [];
							state.invocations = next.invocations;
							state.cycles = next.cycles;
						} catch (error) {
							run.state = "held";
							run.reason = error instanceof Error ? error.message : "Rewind could not be safely applied";
							returnedAction = {
								type: "hold",
								invocation_id: invocation.id,
								error: { code: "invalid_state", message: run.reason, invocation_id: invocation.id },
							};
						}
						break;
					case "finish":
						invocation.routed = true;
						invocation.terminal_disposition = action.disposition;
						if (!settle()) returnedAction = { type: "routed", invocation_id: invocation.id };
						break;
				}
				this.#saveSchedule(run, state, `schedule.${returnedAction?.type ?? action.type}`);
				return { action: returnedAction, intent, run };
			})
			.immediate();
	}

	/**
	 * Record a Bot's validated candidate and its global receipt together. A candidate
	 * is not a settled execution; the host must confirm cleanup and commit it later.
	 * Authentication is required even on receipt replay.
	 */
	submitBotCompletion(
		ownerId: string,
		epoch: string,
		identity: ConsultationIdentity,
		candidate: GraphCompletionCandidate,
		authorize: (db: Database, identity: ConsultationIdentity) => boolean,
		artifacts?: PreparedArtifactRegistration,
	): GraphCompletionReceipt {
		identity = structuredClone(identity);
		candidate = structuredClone(candidate);
		const reject = (code: string, message: string): GraphCompletionReceipt => ({
			request_key: candidate.request_key,
			state: "rejected",
			error: { code, message, location: null, retryable: false, details: null },
		});
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				if (identity.fence !== epoch || authorize(this.#db, structuredClone(identity)) !== true)
					return reject("permission_denied", "Graph attempt authorization is unavailable");
				const fingerprint = canonicalJson({ operation: "bot_complete", identity, candidate });
				const prior = this.#db
					.query("SELECT canonical,result FROM graph_requests WHERE request_key=?")
					.get(candidate.request_key) as { canonical: string; result: string } | null;
				if (prior)
					return prior.canonical === fingerprint
						? (JSON.parse(prior.result) as GraphCompletionReceipt)
						: reject("idempotency_conflict", "Request key was already used for a different request");
				const run = this.getRun(identity.run_id);
				const state = run && this.getScheduleState(run.id);
				const invocation = state?.invocations.find(item => item.id === identity.invocation_id);
				const intent =
					run &&
					this.getDispatchIntents(run.id).find(
						item =>
							item.invocation_id === identity.invocation_id &&
							item.attempt_id === identity.attempt_id &&
							item.fence === identity.fence,
					);
				const snapshot = run && this.getSnapshot(run.snapshot_ref);
				const validated = snapshot && validateGraphForStart(snapshot.definition, this.#limits);
				const definition =
					validated && !validated.issues.length
						? (validated.source.frontmatter.frontmatter as unknown as GraphDefinition)
						: null;
				const node = invocation && definition?.nodes[invocation.node];
				const completionError = node && graphCompletionError(node, candidate);
				let receipt: GraphCompletionReceipt;
				if (
					!candidate.request_key?.trim() ||
					!candidate.outcome?.trim() ||
					!candidate.outputs ||
					typeof candidate.outputs !== "object" ||
					Array.isArray(candidate.outputs)
				) {
					receipt = reject("invalid_request", "Invalid completion candidate");
				} else if (
					!node ||
					node.kind !== "bot" ||
					node.member !== identity.member_id ||
					invocation?.state !== "running" ||
					invocation.attempt_id !== identity.attempt_id ||
					!intent ||
					intent.state !== "accepted" ||
					!run ||
					(run.state !== "running" && run.state !== "queued" && run.state !== "held")
				) {
					receipt = reject("permission_denied", "Graph attempt is not current");
				} else if (completionError) {
					receipt = reject("invalid_request", completionError);
				} else if (Object.keys(candidate.outputs).length && !artifacts) {
					receipt = reject("permission_denied", "Output artifacts require verified registration");
				} else if (
					this.#db.query("SELECT 1 FROM graph_bot_completions WHERE attempt_id=?").get(identity.attempt_id)
				) {
					receipt = reject("invalid_state", "This attempt already has an accepted candidate");
				} else {
					this.#db
						.query("INSERT INTO graph_bot_completions VALUES (?,?)")
						.run(identity.attempt_id, JSON.stringify({ identity, candidate }));
					receipt = { request_key: candidate.request_key, state: "accepted", error: null };
				}
				this.#db
					.query("INSERT INTO graph_requests VALUES (?,?,?)")
					.run(candidate.request_key, fingerprint, JSON.stringify(receipt));
				return receipt;
			})
			.immediate();
	}
	/** Candidate lookup is host-only; its identity is fixed at admission. */
	getBotCompletion(attemptId: string): { identity: ConsultationIdentity; candidate: GraphCompletionCandidate } | null {
		this.definitions.assertProfileAccess();
		const row = this.#db.query("SELECT data FROM graph_bot_completions WHERE attempt_id=?").get(attemptId) as {
			data: string;
		} | null;
		return row ? JSON.parse(row.data) : null;
	}

	/**
	 * A current Host may acknowledge an old Bot only through authenticated cleanup,
	 * never by accepting an old executor completion or replaying its model turn.
	 * confirmStopped runs synchronously while the recovery worker still owns its lease.
	 */
	confirmBotRecovery(
		ownerId: string,
		epoch: string,
		intentId: string,
		confirmStopped: (intent: GraphDispatchIntent) => { bot_id: string; job_id: string } | null,
	): boolean {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const row = this.#db.query("SELECT data FROM graph_dispatch_intents WHERE id=?").get(intentId) as {
					data: string;
				} | null;
				const intent = row && (JSON.parse(row.data) as GraphDispatchIntent);
				if (!intent) return false;
				const run = this.getRun(intent.run_id);
				const state = this.getScheduleState(intent.run_id);
				const invocation = state?.invocations.find(item => item.id === intent.invocation_id);
				const node = invocation && this.getFrozenDefinition(intent.run_id)?.nodes[invocation.node];
				if (
					!run ||
					!state ||
					!invocation ||
					invocation.superseded ||
					invocation.attempt_id !== intent.attempt_id ||
					(!invocation.consultation && node?.kind !== "bot")
				)
					return false;
				if (intent.state === "finished") {
					const observation = intent.observation as {
						recovery?: { bot_id: string; job_id: string };
						completion?: GraphAttemptCompletion;
					} | null;
					if (
						!observation?.recovery ||
						!observation.completion ||
						observation.completion.invocation_id !== invocation.id ||
						observation.completion.attempt_id !== intent.attempt_id ||
						observation.completion.fence !== intent.fence ||
						observation.completion.state !== invocation.state ||
						!["failed", "cancelled"].includes(invocation.state)
					)
						return false;
					const proof = confirmStopped(structuredClone(intent));
					this.assertHostOwner(ownerId, epoch);
					return !!proof && canonicalJson(proof) === canonicalJson(observation.recovery);
				}
				if (
					!["submitting", "accepted", "unknown"].includes(intent.state) ||
					!["running", "waiting", "unknown"].includes(invocation.state) ||
					!["queued", "running", "held", "cancelling"].includes(run.state)
				)
					return false;
				const proof = confirmStopped(structuredClone(intent));
				this.assertHostOwner(ownerId, epoch);
				if (!proof?.bot_id || !proof.job_id) return false;
				const completion: GraphAttemptCompletion = {
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
					state: run.state === "cancelling" ? "cancelled" : "failed",
					error: "Bot runtime lost; cleanup confirmed without replay",
				};
				invocation.state = completion.state;
				invocation.routed = false;
				delete invocation.consultation_wait;
				intent.state = "finished";
				intent.observation = { recovery: proof, completion };
				this.#db
					.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
					.run(JSON.stringify(intent), intent.id);
				this.#db
					.query(
						"INSERT INTO graph_attempt_history (run_id,invocation_id,attempt_id,fence,accepted,data,recorded_at) VALUES (?,?,?,?,?,?,?)",
					)
					.run(
						intent.run_id,
						intent.invocation_id,
						intent.attempt_id,
						intent.fence,
						1,
						JSON.stringify(completion),
						new Date().toISOString(),
					);
				if (run.state !== "cancelling") {
					run.state = "held";
					run.reason = completion.error!;
				}
				this.#settleCancellation(run, state);
				this.#saveSchedule(run, state, "bot.recovery_confirmed");
				return true;
			})
			.immediate();
	}

	/** Record every observation, but mutate current state only for its current attempt and fence. */
	completeAttempt(
		ownerId: string,
		epoch: string,
		completion: GraphAttemptCompletion,
		artifacts?: PreparedArtifactRegistration,
	): boolean {
		return this.#completeAttempt(ownerId, epoch, completion, artifacts, false);
	}

	#completeAttempt(
		ownerId: string,
		epoch: string,
		completion: GraphAttemptCompletion,
		artifacts: PreparedArtifactRegistration | undefined,
		childAggregation: boolean,
	): boolean {
		return this.#db
			.transaction(() => {
				this.assertHostOwner(ownerId, epoch);
				const run = this.getRun(completion.run_id);
				const state = this.getScheduleState(completion.run_id);
				const invocation = state?.invocations.find(item => item.id === completion.invocation_id);
				const row = this.#db
					.query("SELECT id,data FROM graph_dispatch_intents WHERE run_id=?")
					.all(completion.run_id) as { id: string; data: string }[];
				const found = row
					.map(item => ({ id: item.id, intent: JSON.parse(item.data) as GraphDispatchIntent }))
					.find(
						item =>
							item.intent.invocation_id === completion.invocation_id &&
							item.intent.attempt_id === completion.attempt_id &&
							item.intent.fence === completion.fence,
					);
				const snapshot = run && this.getSnapshot(run.snapshot_ref);
				const validated = snapshot && validateGraphForStart(snapshot.definition, this.#limits);
				const node =
					validated && !validated.issues.length && invocation
						? (validated.source.frontmatter.frontmatter as unknown as GraphDefinition).nodes[invocation.node]
						: null;
				const queueRow =
					node?.kind === "queue" && found
						? (this.#db
								.query("SELECT data FROM graph_queue_records WHERE request_key=?")
								.get(found.intent.request_key) as { data: string } | null)
						: null;
				const queueRecord = queueRow ? (JSON.parse(queueRow.data) as QueueRecord) : null;
				const confirmedQueue = !!(
					queueRecord &&
					found &&
					node?.kind === "queue" &&
					["submitting", "accepted", "unknown"].includes(found.intent.state) &&
					queueRecord.state === completion.state &&
					queueRecordMatchesExecution(queueRecord, found.intent, node.executor)
				);
				// A trusted live Bot worker calls this only after stop and cleanup are confirmed.
				// Older-epoch runtime loss is not itself evidence that effects have stopped.
				const stoppedBot =
					node?.kind === "bot" &&
					completion.state === "cancelled" &&
					completion.fence === epoch &&
					run?.state === "cancelling";
				const stoppedChild =
					node?.kind === "subgraph" &&
					childAggregation &&
					completion.state === "cancelled" &&
					run?.state === "cancelling";
				const accepted = !!(
					run &&
					state &&
					invocation &&
					node &&
					node.kind !== "human" &&
					(node.kind !== "subgraph" || childAggregation) &&
					(completion.state !== "succeeded" || graphCompletionError(node, completion) === null) &&
					found &&
					(completion.fence === epoch || confirmedQueue || childAggregation) &&
					(run.state === "running" ||
						run.state === "queued" ||
						(run.state === "held" && childAggregation && completion.state === "failed") ||
						(run.state === "cancelling" && (confirmedQueue || stoppedBot || stoppedChild))) &&
					(invocation.state === "running" ||
						(invocation.state === "waiting" && (stoppedBot || confirmedQueue || stoppedChild))) &&
					!invocation.superseded &&
					invocation.attempt_id === completion.attempt_id &&
					found.intent.state !== "finished" &&
					found.intent.state !== "cancelled" &&
					(completion.state === "succeeded" ||
						completion.state === "failed" ||
						(completion.state === "cancelled" && (confirmedQueue || stoppedBot || stoppedChild)))
				);
				this.#db
					.query(
						"INSERT INTO graph_attempt_history (run_id,invocation_id,attempt_id,fence,accepted,data,recorded_at) VALUES (?,?,?,?,?,?,?)",
					)
					.run(
						completion.run_id,
						completion.invocation_id,
						completion.attempt_id,
						completion.fence,
						accepted ? 1 : 0,
						JSON.stringify(completion),
						new Date().toISOString(),
					);
				if (!accepted || !run || !state || !invocation || !found) return false;
				if (artifacts) {
					if (!this.#artifacts) throw new Error("Graph artifact registry is not configured");
					this.#artifacts.commitPrepared(artifacts, Object.values(completion.outputs ?? {}));
				} else if (!childAggregation && this.#artifacts && Object.keys(completion.outputs ?? {}).length) {
					throw new Error("Output artifacts require verified registration");
				}
				const sequence = this.#db
					.query(
						"UPDATE graph_schedule_sequences SET completion_order=completion_order+1 WHERE run_id=? RETURNING completion_order",
					)
					.get(run.id) as { completion_order: number } | null;
				if (!sequence) throw new Error("Graph completion sequence is missing");
				invocation.state = completion.state;
				invocation.completion_order = String(sequence.completion_order);
				invocation.origin = "executed";
				invocation.outcome = completion.outcome;
				invocation.verdict = completion.verdict;
				invocation.outputs = completion.outputs;
				found.intent.state = "finished";
				found.intent.observation = completion;
				this.#db
					.query("UPDATE graph_dispatch_intents SET data=? WHERE id=?")
					.run(JSON.stringify(found.intent), found.id);
				this.#settleCancellation(run, state);
				this.#saveSchedule(run, state, "attempt.completed");
				return true;
			})
			.immediate();
	}

	#hasAcceptanceEffects(runId: string): boolean {
		return !!this.#db
			.query("SELECT 1 FROM graph_acceptance_executions WHERE run_id=? AND state!='finished' LIMIT 1")
			.get(runId);
	}

	#hasConsultationEffects(runId: string): boolean {
		return !!(
			this.#db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='consultations'").get() &&
			this.#db
				.query("SELECT 1 FROM consultations WHERE run_id=? AND state IN ('queued','active') LIMIT 1")
				.get(runId)
		);
	}

	/** Called only in the transaction that confirms an executor's terminal observation. */
	#settleCancellation(run: GraphRunRecord, state: GraphScheduleState): void {
		if (run.state !== "cancelling") return;
		if (this.#hasAcceptanceEffects(run.id)) return;
		if (this.getDispatchIntents(run.id).some(intent => intent.state !== "finished" && intent.state !== "cancelled"))
			return;
		if (state.invocations.some(item => !item.superseded && ["running", "waiting", "unknown"].includes(item.state)))
			return;
		if (this.#hasConsultationEffects(run.id)) return;
		for (const item of state.invocations) {
			if (!item.superseded && ["pending", "ready"].includes(item.state)) item.state = "cancelled";
		}
		run.state = "cancelled";
	}

	/** Usage observations alone cannot reserve the price of the next model/tool/external effect. */
	#holdCostLimitedRun(run: GraphRunRecord, state: GraphScheduleState, definition: GraphDefinition): boolean {
		if (definition.policy?.cost_limit === undefined) return false;
		run.state = "held";
		run.reason =
			"Monetary cost ceilings require a trusted cost reservation authority; observed usage is not a hard limit";
		this.#saveSchedule(run, state, "cost.capability_unavailable");
		return true;
	}

	#saveSchedule(run: GraphRunRecord, state: GraphScheduleState, event: string): void {
		const previous = state.run_state;
		run.revision = (BigInt(run.revision) + 1n).toString();
		run.updated_at = new Date().toISOString();
		state.run_state = run.state;
		this.#db
			.query("UPDATE graph_runs SET revision=?,data=? WHERE id=?")
			.run(run.revision, JSON.stringify(run), run.id);
		this.#db.query("UPDATE graph_schedule_states SET data=? WHERE run_id=?").run(JSON.stringify(state), run.id);
		const journal = this.#db
			.query("UPDATE graph_journals SET seq=seq+1 WHERE run_id=? RETURNING journal_id,seq")
			.get(run.id) as { journal_id: string; seq: number };
		this.#db
			.query("INSERT INTO graph_events VALUES (?,?,?)")
			.run(
				journal.journal_id,
				journal.seq,
				JSON.stringify({ type: event, run_id: run.id, revision: run.revision, at: run.updated_at }),
			);
		this.#db
			.query("INSERT INTO graph_observation_replacements VALUES (?,?,?)")
			.run(journal.journal_id, journal.seq, JSON.stringify(graphRecordedView(run, state.invocations)));
		this.#appendNotification(run, state, previous, event, journal.seq);
		this.#publishWireLifecycle(run, state);
	}

	/**
	 * Persist the outbox record in the same transaction as the transition it reports.
	 * Re-crossing the same state (for example a second hold after resume) appends a new
	 * sequence; replaying the same transition cannot, because the Run revision moves on.
	 */
	#appendNotification(
		run: GraphRunRecord,
		state: GraphScheduleState,
		previous: GraphRunState,
		event: string,
		sequence: number,
	): void {
		const kind = RUN_NOTIFICATION_KINDS[run.state];
		if (!kind || previous === run.state) return;
		const outputs: GraphNotificationOutput[] = [];
		for (const invocation of state.invocations) {
			if (invocation.superseded) continue;
			for (const [name, ref] of Object.entries(invocation.outputs ?? {})) {
				if (outputs.length >= 256) break;
				outputs.push({ node: invocation.node, name, ref });
			}
		}
		const notification: GraphNotification = {
			format: GRAPH_NOTIFICATION_FORMAT,
			id: `${run.id}:${sequence}`,
			sequence,
			kind,
			state: run.state,
			occurred_at: run.updated_at,
			run_id: run.id,
			graph_id: run.graph_id,
			graph_name: run.graph_name ?? null,
			title: run.title ?? null,
			report_to: run.report_to ?? null,
			reason: run.reason,
			last_event: event,
			outputs,
			...(run.observed_bot_usage ? { observed_bot_usage: run.observed_bot_usage } : {}),
		};
		this.#db
			.query("INSERT OR IGNORE INTO graph_notifications VALUES (?,?,?,?,?,?)")
			.run(notification.id, run.id, sequence, kind, run.updated_at, JSON.stringify(notification));
	}

	#publishWireLifecycle(run: GraphRunRecord, state: GraphScheduleState, initial = false): void {
		const snapshot = this.getSnapshot(run.snapshot_ref);
		if (!snapshot) throw new Error("Graph Run snapshot is missing");
		if (!snapshot.observation) return;
		const definition = this.getFrozenDefinition(run.id);
		if (!definition) throw new Error("Graph frozen definition is missing");
		publishGraphWireLifecycle(
			this.#db,
			this.#wire,
			run,
			snapshot,
			definition,
			state,
			this.getDispatchIntents(run.id),
			initial,
		);
	}

	async transact<T>(
		requestKey: string,
		update: (record: QueueRecord | null) => { record: QueueRecord | null; value: T },
	): Promise<T> {
		this.definitions.assertProfileAccess();
		return this.#db
			.transaction(() => {
				const row = this.#db.query("SELECT data FROM graph_queue_records WHERE request_key=?").get(requestKey) as {
					data: string;
				} | null;
				const result = update(row ? (JSON.parse(row.data) as QueueRecord) : null);
				if (result.record && result.record.request_key !== requestKey)
					throw new Error("Queue transaction changed request identity");
				if (result.record) {
					const data = JSON.stringify(result.record);
					if (data !== row?.data) {
						this.#db
							.query(
								"INSERT INTO graph_queue_records VALUES (?,?) ON CONFLICT(request_key) DO UPDATE SET data=excluded.data",
							)
							.run(requestKey, data);
						const run = this.getRun(result.record.request.run_id);
						const state = run && this.getScheduleState(run.id);
						if (run && state) {
							const intent = this.getDispatchIntents(run.id).find(item => item.request_key === requestKey);
							const invocation = intent && state.invocations.find(item => item.id === intent.invocation_id);
							const node = invocation && this.getFrozenDefinition(run.id)?.nodes[invocation.node];
							if (intent && invocation && node?.kind === "queue") {
								if (!queueRecordMatchesExecution(result.record, intent, node.executor))
									throw new Error("Queue record differs from its frozen execution");
								if (
									!invocation.superseded &&
									invocation.attempt_id === intent.attempt_id &&
									invocation.state === "running" &&
									["submitting", "accepted", "unknown"].includes(intent.state) &&
									result.record.state !== "submitting"
								) {
									invocation.state = "waiting";
									this.#saveSchedule(run, state, "queue.waiting");
								} else this.#publishWireLifecycle(run, state);
							}
						}
					}
				} else if (row) {
					throw new Error("Queue records cannot be deleted");
				}
				return result.value;
			})
			.immediate();
	}

	async quarantine(observation: QueueObservation, reason: string): Promise<void> {
		this.definitions.assertProfileAccess();
		this.#db
			.query("INSERT INTO graph_queue_quarantine (data,reason,recorded_at) VALUES (?,?,?)")
			.run(JSON.stringify(observation), reason, new Date().toISOString());
	}

	/** Read only after the caller has authorized the start request, including replays. */
	getStartReceipt(request: GraphStartRequest): GraphOperation | null {
		this.definitions.assertProfileAccess();
		const prior = this.#db
			.query("SELECT canonical,result FROM graph_requests WHERE request_key=?")
			.get(request.request_key) as { canonical: string; result: string } | null;
		if (!prior) return null;
		return prior.canonical === canonicalJson(request)
			? (JSON.parse(prior.result) as GraphOperation)
			: this.#rejected(request, "idempotency_conflict", "Request key was already used for a different mutation");
	}

	/**
	 * Trusted owner-grant admission. It is deliberately limited to program/queue graphs,
	 * whose registered configurations can be matched exactly; other executors require
	 * their own binding rules. Granted runs cannot dispatch until containment exists.
	 */
	startGranted(principal: string, request: GraphStartRequest, prepared: GraphPreparedRun): GraphOperation {
		this.definitions.assertProfileAccess();
		const grants = this.#grants;
		if (!grants) return this.#rejected(request, "capability_unavailable", "Grant authority is not configured");
		return this.#db
			.transaction(() => {
				const row = this.#db
					.query(
						"SELECT s.revision,s.digest,s.content FROM graph_definitions d JOIN graph_snapshots s ON s.graph_id=d.graph_id AND s.revision=d.revision WHERE d.graph_id=?",
					)
					.get(request.target_id) as { revision: string; digest: string; content: string } | null;
				if (!row || !prepared || !request.payload)
					return this.#rejected(
						request,
						"permission_denied",
						"Grant admission requires a current definition and preflight",
					);
				if (
					prepared.graph_id !== request.target_id ||
					prepared.definition_revision !== row.revision ||
					prepared.definition_digest !== row.digest ||
					request.if_revision !== row.revision ||
					canonicalJson(prepared.authorization_ref) !== canonicalJson(request.payload.authorization_ref)
				)
					return this.#rejected(request, "input_stale", "Grant preflight does not match the current definition");
				const validated = validateGraphForStart(row.content, this.#limits);
				if (validated.issues.length)
					return this.#rejected(request, "definition_invalid", validated.issues[0].message);
				const definition = validated.source.frontmatter.frontmatter as unknown as GraphDefinition;
				const nodes = Object.values(definition.nodes);
				if (
					!nodes.length ||
					nodes.some(node => (node.kind !== "program" && node.kind !== "queue") || !node.executor)
				)
					return this.#rejected(
						request,
						"capability_unavailable",
						"Grant admission requires explicitly bound program or queue executors",
					);
				try {
					for (const node of nodes) {
						const id = node.executor!;
						grants.assertUsable(principal, request.payload.authorization_ref, {
							owner: principal,
							graph_id: request.target_id,
							definition_revision: row.revision,
							definition_digest: row.digest,
							executor: { kind: node.kind, id, configuration: prepared.executors?.[id] },
						});
					}
				} catch (error) {
					if (error instanceof GraphGrantError)
						return this.#rejected(
							request,
							"permission_denied",
							"Owner grant is unavailable or does not cover this execution",
						);
					throw error;
				}
				const prior = this.getStartReceipt(request);
				if (prior?.state === "accepted") {
					const bound = this.#db
						.query("SELECT owner,grant_id,grant_digest FROM graph_granted_runs WHERE run_id=?")
						.get(prior.target_id) as { owner: string; grant_id: string; grant_digest: string } | null;
					if (
						!bound ||
						bound.owner !== principal ||
						bound.grant_id !== request.payload.authorization_ref.id ||
						bound.grant_digest !== request.payload.authorization_ref.digest
					)
						return this.#rejected(request, "permission_denied", "Existing run is not bound to this grant");
					return prior;
				}
				const result = this.#start(request, prepared, true);
				if (result.state === "accepted") {
					this.#db
						.query("INSERT INTO graph_granted_runs VALUES (?,?,?,?)")
						.run(
							result.target_id,
							principal,
							request.payload.authorization_ref.id,
							request.payload.authorization_ref.digest,
						);
				}
				return result;
			})
			.immediate();
	}

	/** Commit a preflighted immutable run with its receipt and first event in one transaction. */
	start(request: GraphStartRequest, prepared: GraphPreparedRun | null): GraphOperation {
		return this.#start(request, prepared, false);
	}

	#start(request: GraphStartRequest, prepared: GraphPreparedRun | null, granted: boolean): GraphOperation {
		this.definitions.assertProfileAccess();
		const fingerprint = canonicalJson(request);
		return this.#db
			.transaction(() => {
				const grantId = request.payload?.authorization_ref?.id;
				if (
					!granted &&
					typeof grantId === "string" &&
					this.#db.query("SELECT 1 FROM graph_owner_grants WHERE id=?").get(grantId)
				)
					return this.#rejected(request, "permission_denied", "Owner grants require grant admission");
				const prior = this.#db
					.query("SELECT canonical,result FROM graph_requests WHERE request_key=?")
					.get(request.request_key) as { canonical: string; result: string } | null;
				if (prior) {
					if (prior.canonical === fingerprint) return JSON.parse(prior.result) as GraphOperation;
					return this.#rejected(
						request,
						"idempotency_conflict",
						"Request key was already used for a different mutation",
					);
				}
				let receipt: GraphOperation;
				if (
					request.version !== 1 ||
					request.operation !== "start" ||
					!request.request_key ||
					!request.target_id ||
					!/^(0|[1-9][0-9]*)$/.test(request.if_revision) ||
					!request.payload ||
					typeof request.payload !== "object" ||
					Array.isArray(request.payload)
				) {
					receipt = this.#rejected(request, "definition_invalid", "Invalid start request");
				} else if (
					Object.keys(request.payload).some(
						key => !["inputs", "authorization_ref", "entry_nodes", "provided_outputs"].includes(key),
					)
				) {
					receipt = this.#rejected(request, "definition_invalid", "Unknown start payload field");
				} else {
					const row = this.#db
						.query(
							"SELECT s.revision,s.digest,s.content FROM graph_definitions d JOIN graph_snapshots s ON s.graph_id=d.graph_id AND s.revision=d.revision WHERE d.graph_id=?",
						)
						.get(request.target_id) as { revision: string; digest: string; content: string } | null;
					if (!row) receipt = this.#rejected(request, "unknown_graph", "Graph does not exist");
					else if (row.revision !== request.if_revision)
						receipt = this.#rejected(request, "revision_conflict", "Definition revision has changed");
					else if (!prepared)
						receipt = this.#rejected(request, "capability_unavailable", "Trusted start preflight is unavailable");
					else if (
						prepared.graph_id !== request.target_id ||
						prepared.definition_revision !== row.revision ||
						prepared.definition_digest !== row.digest ||
						canonicalJson(prepared.authorization_ref) !== canonicalJson(request.payload.authorization_ref) ||
						canonicalJson(prepared.inputs) !== canonicalJson(request.payload.inputs)
					)
						receipt = this.#rejected(
							request,
							"input_stale",
							"Preflight does not match the requested definition or inputs",
						);
					else {
						const validated = validateGraphForStart(row.content, this.#limits);
						if (validated.issues.length)
							receipt = this.#rejected(
								request,
								"definition_invalid",
								validated.issues[0].message,
								validated.issues[0].location,
							);
						else
							receipt = this.#createRun(
								request,
								prepared,
								validated.source.frontmatter.frontmatter as unknown as GraphDefinition,
								row.content,
							);
					}
				}
				this.#db
					.query("INSERT INTO graph_requests VALUES (?,?,?)")
					.run(request.request_key, fingerprint, JSON.stringify(receipt));
				return receipt;
			})
			.immediate();
	}

	#createRun(
		request: GraphStartRequest,
		prepared: GraphPreparedRun,
		definition: GraphDefinition,
		content: string,
	): GraphOperation {
		if (definition.policy?.cost_limit !== undefined)
			return this.#rejected(
				request,
				"capability_unavailable",
				"Monetary cost ceilings require a trusted cost reservation authority; observed usage is not a hard limit",
			);
		const admissionError = this.#checkImports(request, prepared, definition);
		if (admissionError) return admissionError;
		const ref = (value: unknown): value is GraphRef =>
			!!value &&
			typeof value === "object" &&
			"id" in value &&
			typeof value.id === "string" &&
			!!value.id &&
			"digest" in value &&
			typeof value.digest === "string" &&
			!!value.digest;
		for (const [key, member] of Object.entries(definition.members)) {
			const binding = prepared.members[key];
			if (
				!binding ||
				!binding.provider ||
				!binding.model ||
				!binding.configuration_revision ||
				binding.base !== member.base ||
				!ref(binding.base_snapshot_ref) ||
				!ref(binding.role_ref) ||
				!Array.isArray(binding.skill_refs) ||
				!binding.skill_refs.every(ref) ||
				!Array.isArray(binding.rule_refs) ||
				!binding.rule_refs.every(ref)
			)
				return this.#rejected(request, "model_unavailable", `Member '${key}' has no complete frozen binding`);
		}
		for (const [key, node] of Object.entries(definition.nodes)) {
			if (
				(node.kind === "program" || node.kind === "queue") &&
				(!prepared.executors[node.executor!]?.id || !prepared.executors[node.executor!].digest)
			)
				return this.#rejected(request, "capability_unavailable", `Node '${key}' has no frozen executor`);
		}
		if (prepared.observation !== undefined) {
			try {
				validateGraphPreparedObservation(prepared.observation, definition);
				registerGraphObservationSources(this.#db, prepared.observation);
			} catch (error) {
				if (!(error instanceof GraphWireError)) throw error;
				return this.#rejected(
					request,
					error.code === "binding_conflict" ? "input_stale" : "capability_unavailable",
					error.message,
				);
			}
		}
		const label = (value: unknown): string | null | undefined => {
			if (value === undefined) return null;
			if (typeof value !== "string") return undefined;
			const trimmed = value.trim();
			if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
			return trimmed;
		};
		const title = label(prepared.title);
		const reportTo = label(prepared.report_to);
		if (title === undefined || reportTo === undefined)
			return this.#rejected(
				request,
				"definition_invalid",
				"Run title and report_to must be single-line labels of at most 200 characters",
			);
		const now = new Date().toISOString();
		const snapshotData = canonicalJson({ ...prepared, definition: content });
		const snapshot: GraphRef = { id: crypto.randomUUID(), digest: `sha256:${Bun.SHA256.hash(snapshotData, "hex")}` };
		const run: GraphRunRecord = {
			id: crypto.randomUUID(),
			revision: "1",
			created_at: now,
			updated_at: now,
			graph_id: request.target_id,
			definition_revision: request.if_revision,
			definition_digest: prepared.definition_digest,
			snapshot_ref: snapshot,
			state: "queued",
			reason: null,
			authorization_ref: prepared.authorization_ref,
			graph_name: definition.name,
			...(title ? { title } : {}),
			...(reportTo ? { report_to: reportTo } : {}),
		};
		this.#db.query("INSERT INTO graph_run_snapshots VALUES (?,?,?)").run(snapshot.id, snapshot.digest, snapshotData);
		this.#db.query("INSERT INTO graph_runs VALUES (?,?,?)").run(run.id, run.revision, JSON.stringify(run));
		const ids = Object.fromEntries(Object.keys(definition.nodes).map(node => [node, crypto.randomUUID()]));
		let importedCount = 0;
		const state: GraphScheduleState = {
			run_state: "queued",
			invocations: Object.keys(definition.nodes).map(node => {
				const evidence = prepared.imports?.[node];
				return {
					id: ids[node],
					node,
					iteration: 0,
					scope_id: run.id,
					state: evidence ? "succeeded" : "pending",
					upstream: Object.fromEntries(
						(definition.edges ?? [])
							.filter(edge => edge.to === node && !edge.loop)
							.map(edge => [edge.id, ids[edge.from]]),
					),
					...(evidence
						? {
								origin: "imported" as const,
								import_evidence: evidence,
								outputs: evidence.outputs,
								outcome: "done",
								verdict: "done",
								completion_order: String(++importedCount),
								routed: true,
							}
						: {}),
				};
			}),
			cycles: Object.fromEntries(
				Object.entries(definition.loops ?? {})
					.filter(([, loop]) => loop.scope === "cycle")
					.map(([name]) => [name, crypto.randomUUID()]),
			),
			counters: [],
			run_inputs: prepared.inputs,
		};
		this.#db.query("INSERT INTO graph_schedule_states VALUES (?,?)").run(run.id, JSON.stringify(state));
		this.#db.query("INSERT INTO graph_schedule_sequences VALUES (?,?)").run(run.id, importedCount);
		for (const [key, budget] of Object.entries(definition.budgets ?? {})) {
			if (budget.scope === "run")
				this.#db.query("INSERT INTO graph_run_budgets VALUES (?,?,?,?,0)").run(run.id, "run", key, budget.limit);
		}
		const journal = crypto.randomUUID();
		this.#db.query("INSERT INTO graph_journals VALUES (?,?,1)").run(run.id, journal);
		this.#db
			.query("INSERT INTO graph_events VALUES (?,1,?)")
			.run(journal, JSON.stringify({ type: "run.created", run_id: run.id, revision: run.revision, at: now }));
		this.#db
			.query("INSERT INTO graph_observation_replacements VALUES (?,1,?)")
			.run(journal, JSON.stringify(graphRecordedView(run, state.invocations)));
		this.#publishWireLifecycle(run, state, true);
		return {
			request_key: request.request_key,
			state: "accepted",
			target_id: run.id,
			revision: run.revision,
			result_ref: snapshot,
			error: null,
		};
	}

	/** Only a complete unconditional prefix can be imported. Other shapes fail closed. */
	#checkImports(
		request: GraphStartRequest,
		prepared: GraphPreparedRun,
		definition: GraphDefinition,
	): GraphOperation | null {
		const { entry_nodes: entries, provided_outputs: provided } = request.payload;
		if (entries === undefined && provided === undefined && prepared.imports === undefined) return null;
		const reject = (message: string) => this.#rejected(request, "gate_unsatisfied", message);
		const record = (value: unknown): value is Record<string, unknown> =>
			!!value && typeof value === "object" && !Array.isArray(value);
		const ref = (value: unknown): value is GraphRef =>
			record(value) &&
			typeof value.id === "string" &&
			!!value.id &&
			typeof value.digest === "string" &&
			!!value.digest;
		if (
			!Array.isArray(entries) ||
			!entries.length ||
			entries.some(entry => typeof entry !== "string") ||
			new Set(entries).size !== entries.length ||
			(provided !== undefined && !record(provided)) ||
			(prepared.imports !== undefined && !record(prepared.imports))
		)
			return reject("Invalid entry nodes or imported outputs");
		const outputs = provided ?? {};
		const imports = prepared.imports ?? {};
		const keys = Object.keys(outputs).sort();
		if (canonicalJson(keys) !== canonicalJson(Object.keys(imports).sort()))
			return reject("Imported outputs require matching trusted preflight evidence");
		if (keys.length && Object.keys(definition.loops ?? {}).length)
			return reject("Importing loop history is not supported");
		const imported = new Set(keys);
		const edges = (definition.edges ?? []).filter(edge => !edge.loop);
		const virtual = new Set(Object.values(definition.loops ?? {}).map(loop => loop.final_node));
		for (const node of Object.values(definition.nodes))
			if (node.on_budget_exhausted && node.on_budget_exhausted !== "hold") virtual.add(node.on_budget_exhausted);
		for (const key of keys) {
			const node = definition.nodes[key];
			const evidence = imports[key];
			const supplied = outputs[key];
			if (
				!node ||
				!record(supplied) ||
				!evidence ||
				!record(evidence.outputs) ||
				!record(evidence.run_inputs) ||
				!record(evidence.provided_outputs) ||
				!ref(evidence.source_ref) ||
				!ref(evidence.authorization_ref) ||
				evidence.definition_digest !== prepared.definition_digest ||
				canonicalJson(evidence.authorization_ref) !== canonicalJson(prepared.authorization_ref) ||
				canonicalJson(evidence.run_inputs) !== canonicalJson(prepared.inputs) ||
				canonicalJson(evidence.provided_outputs) !== canonicalJson(outputs) ||
				canonicalJson(evidence.outputs) !== canonicalJson(supplied)
			)
				return reject(`Imported node '${key}' lacks matching authorized provenance`);
			if (
				node.required_gate ||
				node.kind === "human" ||
				virtual.has(key) ||
				node.consume?.length ||
				canonicalJson(node.outcomes ?? ["done"]) !== canonicalJson(["done"]) ||
				(node.verdicts && canonicalJson(node.verdicts) !== canonicalJson(["done"])) ||
				(node.decisions && !node.decisions.some(item => item.outcome === "done" && item.verdict === "done"))
			)
				return reject(`Node '${key}' cannot be safely imported`);
			for (const [name, value] of Object.entries(supplied))
				if (!Object.hasOwn(node.outputs ?? {}, name) || !ref(value))
					return reject(`Invalid imported output '${key}.${name}'`);
			for (const [name, declaration] of Object.entries(node.outputs ?? {}))
				if (declaration.required && !ref(supplied[name]))
					return reject(`Missing required imported output '${key}.${name}'`);
			const incoming = edges.filter(edge => edge.to === key);
			if (incoming.some(edge => !imported.has(edge.from)))
				return reject(`Imported node '${key}' has an unverified prerequisite`);
			const available = new Set(
				Object.entries(node.inputs ?? {})
					.filter(
						([, input]) =>
							input.text !== undefined ||
							input.artifact !== undefined ||
							(input.run_input !== undefined && ref(prepared.inputs[input.run_input])),
					)
					.map(([name]) => name),
			);
			for (const edge of incoming)
				for (const name of Object.keys(edge.bind ?? {})) {
					if (available.has(name)) return reject(`Duplicate input '${key}.${name}'`);
					available.add(name);
				}
			if ((node.required_inputs ?? []).some(name => !available.has(name)))
				return reject(`Imported node '${key}' has a missing required input`);
			const outgoing = edges.filter(edge => edge.from === key);
			if (
				!outgoing.length ||
				outgoing.some(
					edge =>
						!(edge.on ?? ["done"]).includes("done") ||
						Object.values(edge.bind ?? {}).some(name => !ref(supplied[name])),
				)
			)
				return reject(`Imported node '${key}' has an unsatisfied outgoing dependency`);
		}
		const frontier = Object.keys(definition.nodes)
			.filter(
				key =>
					!imported.has(key) &&
					!virtual.has(key) &&
					edges.filter(edge => edge.to === key).every(edge => imported.has(edge.from)),
			)
			.sort();
		if (canonicalJson([...entries].sort()) !== canonicalJson(frontier))
			return reject("Entry nodes must be the complete frontier after the imported prefix");
		for (const key of frontier) {
			const node = definition.nodes[key];
			const available = new Set(
				Object.entries(node.inputs ?? {})
					.filter(
						([, input]) =>
							input.text !== undefined ||
							input.artifact !== undefined ||
							(input.run_input !== undefined && ref(prepared.inputs[input.run_input])),
					)
					.map(([name]) => name),
			);
			for (const edge of edges.filter(edge => edge.to === key))
				for (const name of Object.keys(edge.bind ?? {})) {
					if (available.has(name)) return reject(`Duplicate input '${key}.${name}'`);
					available.add(name);
				}
			if ((node.required_inputs ?? []).some(name => !available.has(name)))
				return reject(`Entry node '${key}' has a missing required input`);
		}
		return null;
	}

	#rejected(
		request: GraphStartRequest,
		code: string,
		message: string,
		location: { file: string; path: string; line: number; column: number } | null = null,
	): GraphOperation {
		return {
			request_key: request.request_key,
			state: "rejected",
			target_id: request.target_id,
			revision: null,
			result_ref: null,
			error: { code, message, location, retryable: false, details: null },
		};
	}
}

export const JOB_STATES = [
	"queued",
	"running",
	"waiting_input",
	"idle",
	"paused",
	"stopped",
	"interrupted",
	"failed",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export type JobPhase =
	| "queued"
	| "model"
	| "tool"
	| "background"
	| "input"
	| "compacting"
	| "retry_wait"
	| "cancelling"
	| "none";
export type BotAction = "send" | "steer" | "interrupt" | "resume" | "compact" | "set-model" | "stop";
export type BotErrorCode =
	| "invalid_input"
	| "unknown_bot"
	| "unknown_job"
	| "unknown_request"
	| "permission_denied"
	| "idempotency_conflict"
	| "request_expired"
	| "revision_conflict"
	| "input_request_closed"
	| "invalid_state"
	| "incompatible_model"
	| "invalid_cursor"
	| "cursor_expired"
	| "slow_consumer"
	| "unsupported_version"
	| "cleanup_failed"
	| "internal_error";
export interface BotFailure {
	code: string;
	message: string;
	retryable: boolean;
	details?: Record<string, unknown>;
}
export interface ErrorProjection {
	schema_version: 1;
	kind: "error";
	request_id: string | null;
	accepted: false;
	error: Omit<BotFailure, "details"> & { details: Record<string, unknown> | null };
}
export class BotError extends Error {
	readonly code: BotErrorCode;
	readonly details: Record<string, unknown> | undefined;
	readonly retryable: boolean;
	constructor(code: BotErrorCode, message: string, details?: Record<string, unknown>, retryable = false) {
		super(message);
		this.name = "BotError";
		this.code = code;
		this.details = details;
		this.retryable = retryable;
	}
	toJSON(): ErrorProjection {
		return {
			schema_version: 1,
			kind: "error",
			request_id: null,
			accepted: false,
			error: { code: this.code, message: this.message, retryable: this.retryable, details: this.details ?? null },
		};
	}
}
export interface Cursor {
	journal_id: string;
	seq: string;
}
export interface GraphContext {
	graph_id: string;
	graph_run_id: string;
	node_id: string;
	invocation_id: string;
	attempt: number;
	trace_id?: string | null;
	upstream: Array<{ edge_id: string; job_id?: string | null; artifact_id?: string | null }>;
}
export interface BotConfig {
	cwd: string;
	system_prompt: string;
	tools: string[];
	/** Absolute, profile-private snapshots, never the caller's mutable source directories. */
	skills_dirs: string[];
	model: string | null;
}
export interface CreateBotInput {
	bot_name: string;
	cwd?: string;
	system_prompt?: string;
	tools?: string[];
	skills_dirs?: string[];
	model?: string | null;
}
export interface BotDefinition {
	bot_id: string;
	bot_name: string;
	config_revision: string;
	config: BotConfig;
	created_at: string;
}
export interface WorkerProjection {
	state: "online" | "offline" | "unknown";
	last_seen_at: string | null;
}
export interface BotProjection {
	bot_id: string;
	bot_name: string;
	config_revision: string;
	worker: WorkerProjection;
	counts: Record<JobState, number>;
	jobs_total: number;
}
export interface JobActivity {
	kind: "model" | "tool" | "background" | "control";
	label: string;
	span_id: string | null;
}
export interface JobWait {
	kind: "input" | "approval" | "capacity" | "provider" | "retry";
	message: string;
	request_id: string | null;
	retry_at: string | null;
}
export interface JobProgress {
	source: "todo" | "tool";
	completed: number;
	total: number;
	unit: string;
}
export interface JobUsage {
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	cost_usd: string | null;
	completeness: "complete" | "partial" | "unknown";
	measured_at: string | null;
}
export interface JobProjection {
	job_id: string;
	bot_id: string;
	config_revision: string;
	revision: string;
	goal_preview: string;
	goal_ref: string | null;
	cwd: string;
	graph_context: GraphContext | null;
	state: JobState;
	phase: JobPhase;
	settled: boolean;
	input_requests: InputRequestProjection[];
	ownership: { state: "none" | "active" | "uncertain"; activation_ref: string | null };
	execution_id: string | null;
	pending_input_count: number;
	pending_background_count: number;
	pending_delivery_count: number;
	activity: JobActivity | null;
	wait: JobWait | null;
	progress: JobProgress | null;
	model: { current: string | null; pending: string | null };
	context: { used_tokens: number | null; limit_tokens: number | null };
	usage: JobUsage;
	created_at: string;
	updated_at: string;
	last_activity_at: string;
	elapsed_ms: number;
	active_ms: number;
	output_ref: string | null;
	artifact_ids: string[];
	error: BotFailure | null;
	controls: Array<{ action: BotAction; enabled: boolean; reason: string | null }>;
}
export interface QueuedInput {
	request_id: string;
	input: string;
	steer?: boolean;
	reply_to?: string;
}
export interface BotInputRequest {
	input_request_id: string;
	kind: "text" | "approval";
	prompt: unknown;
}
export interface InputRequestProjection {
	input_request_id: string;
	kind: "text" | "approval";
	prompt_ref: string;
	status: "open" | "reply_queued" | "completion_queued";
	reply_request_id: string | null;
	completion_reason: "reply" | "timeout" | "dialog_cancel" | null;
}
export interface StoredInputRequest extends BotInputRequest, InputRequestProjection {}
export interface BotActivation {
	activation_ref: string;
	bot_id: string;
	job_id: string;
	owner_id: string;
	owner_epoch: string;
	execution_id: string | null;
	request_id: string | null;
	input_ref: string | null;
	parent_activation_ref: string | null;
	stage: "initializing" | "executing" | "waiting_input" | "background" | "interrupted" | "closed";
	recovery: "not_required" | "inspection_required" | "cleanup_required";
	error: BotFailure | null;
}
export interface StoredLaunchIntent {
	launch_intent_id: string;
	session_owner_id: string;
	owner_epoch: string;
	payload: unknown;
	disposition: {
		state: "pending" | "running" | "terminal" | "cancelled_before_launch" | "unknown";
		service: { id: string; generation: string } | null;
		outcome: "ok" | "error" | "cancelled" | null;
		final: boolean;
		error: BotFailure | null;
	} | null;
}
/** Private recovery evidence; not part of the Graph projection. */
export interface OwnedBotService {
	id: string;
	name: string;
	started_at: number | null;
	generation?: string;
}
export interface BotJob extends JobProjection {
	config: BotConfig;
	session_file: string | null;
	inputs: QueuedInput[];
	input_requests: StoredInputRequest[];
	owned_services?: OwnedBotService[];
	session_owner_id: string | null;
	owner_epoch: string | null;
	launch_intents: StoredLaunchIntent[];
}
export interface BotCommand {
	command: "submit" | BotAction;
	job_id?: string;
	input?: string;
	model?: string;
	mode?: "qaonly";
	cwd?: string;
	graph_context?: GraphContext | null;
	key?: string;
	if_revision?: string;
	reply_to?: string;
	all?: boolean;
}
export interface Receipt {
	schema_version: 1;
	kind: "receipt";
	bot_id: string;
	job_id: string | null;
	request_id: string;
	accepted: true;
	cursor: Cursor;
}
export type RequestOutcome = "pending" | "applied" | "rejected" | "cancelled";
export interface RequestProjection {
	schema_version: 1;
	kind: "request";
	receipt: Receipt;
	outcome: RequestOutcome;
	effective_at: string | null;
	error: BotFailure | null;
	/** Present for stop --all; independent child results expose partial failure. */
	children?: RequestProjection[];
}
export interface StoredRequest {
	request_id: string;
	command: BotCommand;
	receipt: Receipt;
	outcome: RequestOutcome;
	parent_request_id: string | null;
}
export interface BotEvent {
	schema_version: 1;
	kind: "event";
	profile_id: string;
	bot_id: string;
	job_id: string | null;
	execution_id: string | null;
	request_id: string | null;
	event_id: string;
	cursor: Cursor;
	occurred_at: string;
	type: string;
	cause_event_id: string | null;
	data: unknown;
}
export interface Snapshot {
	schema_version: 1;
	kind: "snapshot";
	profile_id: string;
	capabilities: string[];
	bot: BotProjection;
	jobs: JobProjection[];
	cursor: Cursor;
	next_page_token: string | null;
}
export interface Page<T> {
	items: T[];
	next_page_token: string | null;
}
export interface RefProjection {
	ref: string;
	availability: "available" | "redacted" | "expired" | "missing";
	media_type: string | null;
	content: unknown | null;
	next_page_token: string | null;
}
export interface EventOptions {
	after?: Cursor;
	job_id?: string;
	limit?: number;
	page_token?: string;
}
export interface SnapshotOptions {
	job_id?: string;
	graph_run_id?: string;
	limit?: number;
	page_token?: string;
}
export interface EventIds {
	job_id?: string;
	execution_id?: string;
	request_id?: string;
	cause_event_id?: string;
}
export interface WorkerLease {
	owner_id: string;
	owner_epoch: string;
	pid: number;
	last_seen_at: string;
	expires_at: string;
}

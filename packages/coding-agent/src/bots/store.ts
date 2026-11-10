import { Database } from "bun:sqlite";
import type {} from "./bun-sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isFileLockHeld, sanitizeText } from "@oh-my-pi/pi-utils";
import { redactMemorySecrets } from "../memory-backend/redact";
import { builtinCredentialSecretEntries, collectEnvSecrets } from "../secrets";
import { StreamRedactor } from "../stream/redactor";
import { describeBotQuestion, normalizeBotReply } from "./input";
import {
	BotError,
	JOB_STATES,
	type BotAction,
	type BotActivation,
	type BotCommand,
	type BotConfig,
	type BotDefinition,
	type BotEvent,
	type BotFailure,
	type BotInputRequest,
	type BotJob,
	type BotProjection,
	type CreateBotInput,
	type Cursor,
	type EventIds,
	type EventOptions,
	type GraphContext,
	type JobProjection,
	type OwnedBotService,
	type Page,
	type QueuedInput,
	type Receipt,
	type RefProjection,
	type RequestOutcome,
	type RequestProjection,
	type Snapshot,
	type SnapshotOptions,
	type StoredRequest,
	type StoredLaunchIntent,
	type WorkerLease,
} from "./types";

interface JsonRow {
	data: string;
}
interface BotRow extends JsonRow {
	journal_id: string;
	seq: string;
	floor: string;
	worker: string;
	lease: string | null;
}
interface JobRow extends JsonRow {
	active_since: string | null;
	active_accum: number;
}
interface RequestRow extends JsonRow {
	payload: string;
	expired: number;
	parent_id: string | null;
	outcome: RequestOutcome;
}
interface RefRow {
	content: string | null;
	media_type: string;
	availability: RefProjection["availability"];
	job_id: string | null;
}
interface TokenRow {
	kind: string;
	bot_id: string;
	scope: string;
	data: string;
}
interface EventRow {
	data: string;
}
const ACTIONS: BotAction[] = ["send", "steer", "interrupt", "resume", "compact", "set-model", "stop"];
const COMMANDS = new Set(["submit", ...ACTIONS]);
const REF_PAGE_SIZE = 16_384;
const MAX_PAGE_SIZE = 1000;
const SUMMARY_LIMIT = 240;

function id(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}
function now(): string {
	return new Date().toISOString();
}
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}
function invalid(message: string): never {
	throw new BotError("invalid_input", message);
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0"))
		invalid(`${name} must be a nonempty string`);
	return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${name} contains unknown fields`);
}
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}
function pageLimit(limit = 100): number {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
		invalid(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
	return limit;
}
function list(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) invalid(`${name} must be an array`);
	return value.map(item => text(item, name));
}
function directory(value: string): string {
	const absolute = path.resolve(value);
	try {
		if (!fs.statSync(absolute).isDirectory()) invalid("cwd must be a directory");
	} catch (error) {
		if (error instanceof BotError) throw error;
		invalid("cwd must be an accessible directory");
	}
	return absolute;
}

/** Strict normalization gives absent optional correlation fields one canonical representation. */
export function validateGraphContext(value: unknown): GraphContext | null {
	if (value === undefined || value === null) return null;
	if (!record(value)) invalid("graph_context must be an object or null");
	keys(
		value,
		["graph_id", "graph_run_id", "node_id", "invocation_id", "attempt", "trace_id", "upstream"],
		"graph_context",
	);
	if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1) invalid("attempt must be an integer >= 1");
	const upstream = value.upstream ?? [];
	if (!Array.isArray(upstream)) invalid("upstream must be an array");
	return {
		graph_id: text(value.graph_id, "graph_id"),
		graph_run_id: text(value.graph_run_id, "graph_run_id"),
		node_id: text(value.node_id, "node_id"),
		invocation_id: text(value.invocation_id, "invocation_id"),
		attempt: Number(value.attempt),
		trace_id: value.trace_id == null ? null : text(value.trace_id, "trace_id"),
		upstream: upstream.map(item => {
			if (!record(item)) invalid("upstream entries must be objects");
			keys(item, ["edge_id", "job_id", "artifact_id"], "upstream entry");
			return {
				edge_id: text(item.edge_id, "edge_id"),
				job_id: item.job_id == null ? null : text(item.job_id, "job_id"),
				artifact_id: item.artifact_id == null ? null : text(item.artifact_id, "artifact_id"),
			};
		}),
	};
}

export function validateCommand(value: BotCommand): BotCommand {
	if (!record(value) || !COMMANDS.has(value.command)) invalid("Unknown Bot command");
	keys(
		value,
		["command", "job_id", "input", "model", "mode", "cwd", "graph_context", "key", "if_revision", "reply_to", "all"],
		"command",
	);
	const command: BotCommand = { command: value.command };
	if (value.key !== undefined) command.key = text(value.key, "request key");
	if (value.if_revision !== undefined) {
		if (typeof value.if_revision !== "string" || !/^(0|[1-9]\d*)$/.test(value.if_revision))
			invalid("if_revision must be a decimal string");
		command.if_revision = value.if_revision;
	}
	if (value.command === "submit") {
		if (
			value.job_id !== undefined ||
			value.all !== undefined ||
			value.reply_to !== undefined ||
			value.if_revision !== undefined
		)
			invalid("submit does not target an existing Job");
		command.input = text(value.input, "input");
		command.graph_context = validateGraphContext(value.graph_context);
		if (value.cwd !== undefined) command.cwd = path.resolve(text(value.cwd, "cwd"));
		if (value.model !== undefined) invalid("Use set-model to change a Job model");
	} else {
		if (value.all === true) {
			if (value.command !== "stop" || value.job_id !== undefined || value.if_revision !== undefined)
				invalid("Only stop supports an unguarded --all scope");
			command.all = true;
		} else {
			if (value.all !== undefined && value.all !== false) invalid("all must be boolean");
			command.job_id = text(value.job_id, "job_id");
		}
		if (value.command === "send" || value.command === "steer") {
			command.input = text(value.input, "input");
			if (value.reply_to !== undefined) command.reply_to = text(value.reply_to, "reply_to");
		} else if (value.input !== undefined || value.reply_to !== undefined)
			invalid("Only input commands accept input/reply_to");
		if (value.command === "set-model") command.model = text(value.model, "model");
		else if (value.model !== undefined) invalid("Only set-model accepts model");
		if (value.cwd !== undefined || value.graph_context !== undefined)
			invalid("Job configuration is frozen at submission");
	}
	if (value.mode !== undefined) {
		if (value.command !== "compact" || value.mode !== "qaonly") invalid("compact supports only mode qaonly");
		command.mode = "qaonly";
	} else if (value.command === "compact") command.mode = "qaonly";
	return command;
}

/** Reasoning is never an inspectable observability payload, including nested tool/message blocks. */
function withoutReasoning(value: unknown): unknown {
	if (Array.isArray(value))
		return value
			.filter(item => !record(item) || !["thinking", "reasoning", "redacted_thinking"].includes(String(item.type)))
			.map(withoutReasoning);
	if (!record(value)) return value;
	if (["thinking", "reasoning", "redacted_thinking"].includes(String(value.type))) return null;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !/^(thinking|reasoning|reasoning_content|signature|encrypted_content)$/i.test(key))
			.map(([key, item]) => [key, withoutReasoning(item)]),
	);
}

let summaryRedactor: StreamRedactor | undefined;
/** Safe bounded telemetry; full caller content belongs only in a protected reference. */
export function summaryPreview(value: string): string {
	summaryRedactor ??= new StreamRedactor(
		builtinCredentialSecretEntries().map(
			entry => new RegExp(entry.content, entry.flags?.includes("g") ? entry.flags : `${entry.flags ?? ""}g`),
		),
		collectEnvSecrets()
			.filter(entry => entry.content.length >= 8)
			.map(entry => ({ value: entry.content, prefix: entry.content.slice(0, 6) })),
	);
	let safe = summaryRedactor.redactRow(sanitizeText(value));
	safe = redactMemorySecrets(safe)
		.replace(/(?:[A-Za-z]:\\|\/)[^\s<>"']+/g, "[path]")
		.replace(/[\t\r\n]+/g, " ")
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
	const points = Array.from(safe);
	return points.length > SUMMARY_LIMIT ? `${points.slice(0, SUMMARY_LIMIT - 1).join("")}…` : safe;
}

/** Profile-private durable admission, projections and per-Bot append-only journals. */
export class BotStore {
	readonly root: string;
	readonly profile_id: string;
	#db: Database;
	constructor(root = path.join(getAgentDir(), "bots")) {
		this.root = path.resolve(root);
		let opened: Database | undefined;
		try {
			fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
			const stat = fs.lstatSync(this.root);
			if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
				throw new BotError("permission_denied", "Bot profile is not owned by this user");
			fs.chmodSync(this.root, 0o700);
			const dbPath = path.join(this.root, "bots.sqlite");
			if (fs.existsSync(dbPath)) {
				const dbStat = fs.lstatSync(dbPath);
				if (dbStat.isSymbolicLink() || (process.getuid && dbStat.uid !== process.getuid()))
					throw new BotError("permission_denied", "Bot database is not owned by this user");
			}
			opened = this.#db = new Database(dbPath, { create: true });
			this.#db.function("omp_bot_writer_version", () => 2);
			this.#db.exec("PRAGMA busy_timeout=5000");
			this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
			this.#db.exec(`
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bots (bot_id TEXT PRIMARY KEY, bot_name TEXT NOT NULL UNIQUE, data TEXT NOT NULL, journal_id TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0, worker TEXT NOT NULL, lease TEXT, owner_epoch TEXT NOT NULL DEFAULT '0');
CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(bot_id), data TEXT NOT NULL, active_since TEXT, active_accum INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS jobs_bot ON jobs(bot_id);
CREATE TABLE IF NOT EXISTS graph_hosted_jobs (job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE, bot_id TEXT NOT NULL REFERENCES bots(bot_id));
CREATE TABLE IF NOT EXISTS graph_handoffs (bot_id TEXT PRIMARY KEY REFERENCES bots(bot_id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(bot_id), job_id TEXT, key TEXT, payload TEXT NOT NULL, data TEXT NOT NULL, outcome TEXT NOT NULL, expired INTEGER NOT NULL DEFAULT 0, parent_id TEXT, UNIQUE(bot_id,key));
CREATE INDEX IF NOT EXISTS requests_pending ON requests(bot_id,outcome);
CREATE TABLE IF NOT EXISTS events (bot_id TEXT NOT NULL REFERENCES bots(bot_id), seq INTEGER NOT NULL, job_id TEXT, data TEXT NOT NULL, PRIMARY KEY(bot_id,seq));
CREATE TABLE IF NOT EXISTS refs (ref TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(bot_id), job_id TEXT, media_type TEXT NOT NULL, content TEXT, availability TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(bot_id), job_id TEXT NOT NULL, message_id TEXT, data TEXT NOT NULL, UNIQUE(job_id,message_id));
CREATE TABLE IF NOT EXISTS page_tokens (token TEXT PRIMARY KEY, kind TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(bot_id), scope TEXT NOT NULL, data TEXT NOT NULL);
`);
			this.#db
				.transaction(() => {
					this.#db.query("INSERT OR IGNORE INTO metadata VALUES ('schema_version','2')").run();
					const version = this.#db.query("SELECT value FROM metadata WHERE key='schema_version'").get() as {
						value: string;
					};
					if (!["1", "2"].includes(version.value))
						throw new BotError("unsupported_version", "Unsupported Bot database version");
					if (version.value === "1") {
						const bots = this.#db.query("SELECT bot_id,lease FROM bots").all() as Array<{
							bot_id: string;
							lease: string | null;
						}>;
						for (const bot of bots) {
							const lease = bot.lease ? (JSON.parse(bot.lease) as WorkerLease) : null;
							if (
								(lease && processExists(lease.pid)) ||
								isFileLockHeld(path.join(this.root, `${bot.bot_id}.worker`))
							)
								throw new BotError(
									"invalid_state",
									"Stop legacy Bot workers before upgrading the Bot database",
								);
						}
						const image = this.#db.serialize();
						// A serialized WAL snapshot is complete, but its header still requires WAL sidecars.
						// SQLite documents rollback-mode header normalization: sqlite.org/c3ref/deserialize.html.
						image[18] = 1;
						image[19] = 1;
						const backup = fs.openSync(`${dbPath}.schema1-${crypto.randomUUID()}.backup`, "wx", 0o600);
						try {
							fs.writeFileSync(backup, image);
							fs.fsyncSync(backup);
						} finally {
							fs.closeSync(backup);
						}
						this.#db.exec("ALTER TABLE bots ADD COLUMN owner_epoch TEXT NOT NULL DEFAULT '0'");
						this.#db.exec("ALTER TABLE jobs ADD COLUMN active_accum INTEGER NOT NULL DEFAULT 0");
						this.#db
							.query("UPDATE jobs SET active_accum=CAST(json_extract(data,'$.active_ms') AS INTEGER)")
							.run();
						this.#db.query("UPDATE metadata SET value='2' WHERE key='schema_version'").run();
					}
					this.#db.exec(
						"CREATE TABLE IF NOT EXISTS activations (activation_ref TEXT PRIMARY KEY REFERENCES refs(ref), bot_id TEXT NOT NULL REFERENCES bots(bot_id), job_id TEXT NOT NULL, data TEXT NOT NULL)",
					);
					for (const table of [
						"bots",
						"jobs",
						"requests",
						"events",
						"refs",
						"messages",
						"page_tokens",
						"activations",
						"graph_hosted_jobs",
						"graph_handoffs",
					])
						for (const operation of ["INSERT", "UPDATE", "DELETE"])
							this.#db.exec(
								`CREATE TRIGGER IF NOT EXISTS bot_writer_guard_${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT CASE WHEN omp_bot_writer_version()<>2 THEN RAISE(ABORT,'Unsupported Bot writer') END; END`,
							);
					this.#db.query("INSERT OR IGNORE INTO metadata VALUES ('profile_id',?)").run(id("p"));
				})
				.immediate();
			const profile = this.#db.query("SELECT value FROM metadata WHERE key='profile_id'").get() as { value: string };
			this.profile_id = profile.value;
			this.#migrateJobs();
			for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
				if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
		} catch (error) {
			opened?.close();
			if (error instanceof BotError) throw error;
			const denied =
				error instanceof Error && "code" in error && ["EACCES", "EPERM", "EROFS"].includes(String(error.code));
			throw new BotError(
				denied ? "permission_denied" : "internal_error",
				"Cannot open the profile-local Bot database",
				undefined,
				!denied,
			);
		}
	}
	close(): void {
		this.#db.close();
	}
	#access(): void {
		try {
			const stat = fs.lstatSync(this.root);
			if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
				throw new Error();
		} catch {
			throw new BotError("permission_denied", "Bot profile permissions do not allow access");
		}
	}
	#atomic<T>(fn: () => T): T {
		this.#access();
		return this.#db.transaction(fn).immediate();
	}
	#bot(botId: string): BotRow {
		this.#access();
		const row = this.#db
			.query(
				"SELECT data,journal_id,CAST(seq AS TEXT) AS seq,CAST(floor AS TEXT) AS floor,worker,lease FROM bots WHERE bot_id=?",
			)
			.get(botId) as BotRow | null;
		if (!row) throw new BotError("unknown_bot", "Unknown Bot");
		return row;
	}
	#job(botId: string, jobId: string): JobRow {
		this.#bot(botId);
		const row = this.#db
			.query("SELECT data,active_since,active_accum FROM jobs WHERE bot_id=? AND job_id=?")
			.get(botId, jobId) as JobRow | null;
		if (!row) throw new BotError("unknown_job", "Unknown Job for this Bot");
		return row;
	}
	#request(botId: string, requestId: string): RequestRow {
		this.#bot(botId);
		const row = this.#db
			.query("SELECT data,payload,expired,parent_id,outcome FROM requests WHERE bot_id=? AND request_id=?")
			.get(botId, requestId) as RequestRow | null;
		if (!row) throw new BotError("unknown_request", "Unknown request for this Bot");
		if (row.expired) throw new BotError("request_expired", "Request content has expired");
		return row;
	}
	#saveJob(job: BotJob, activeSince?: string | null): void {
		if (activeSince === undefined)
			this.#db
				.query("UPDATE jobs SET data=? WHERE bot_id=? AND job_id=?")
				.run(JSON.stringify(job), job.bot_id, job.job_id);
		else
			this.#db
				.query("UPDATE jobs SET data=?,active_since=? WHERE bot_id=? AND job_id=?")
				.run(JSON.stringify(job), activeSince, job.bot_id, job.job_id);
	}
	#migrateJobs(): void {
		this.#atomic(() => {
			const rows = this.#db.query("SELECT bot_id,job_id,data FROM jobs").all() as Array<
				JsonRow & { bot_id: string; job_id: string }
			>;
			for (const row of rows) {
				const job = JSON.parse(row.data) as BotJob;
				if (job.ownership !== undefined) continue;
				job.ownership = { state: "none", activation_ref: null };
				job.session_owner_id = null;
				job.owner_epoch = null;
				job.launch_intents = [];
				job.input_requests = (job.input_requests ?? []).map(item => {
					const legacy = item as typeof item & { resolved_by?: string | null };
					const { resolved_by, ...question } = legacy;
					return {
						...question,
						prompt_ref: this.putRef(
							row.bot_id,
							row.job_id,
							describeBotQuestion(question),
							"application/vnd.omp.bot-question+json",
						),
						status: resolved_by ? "reply_queued" : "open",
						reply_request_id: resolved_by ?? null,
						completion_reason: resolved_by ? "reply" : null,
					};
				});
				this.#saveJob(job);
				if (
					["running", "waiting_input", "interrupted"].includes(job.state) ||
					job.pending_background_count ||
					job.pending_delivery_count
				) {
					const activation = this.#createActivation(job, "legacy", "0", null, null, null);
					this.updateActivation(activation.activation_ref, {
						stage: "interrupted",
						recovery: "inspection_required",
						error: {
							code: "worker_lost",
							message: "Legacy execution ownership requires reconciliation",
							retryable: false,
						},
					});
					this.updateJob(job.bot_id, job.job_id, {
						state: "interrupted",
						phase: "none",
						execution_id: null,
						settled: false,
						ownership: { state: "uncertain", activation_ref: activation.activation_ref },
					});
				} else this.updateJob(job.bot_id, job.job_id, {});
			}
		});
	}
	#copySkills(sourceDirs: string[], target: string): string[] {
		const result: string[] = [];
		const profileReal = fs.realpathSync(this.root);
		const copy = (source: string, dest: string, ancestors: Set<string>): void => {
			const real = fs.realpathSync(source);
			const stat = fs.statSync(real);
			if (stat.isDirectory()) {
				if (ancestors.has(real)) invalid("Skill directories contain a symbolic-link cycle");
				const destination = path.join(profileReal, path.relative(this.root, dest));
				if (destination.startsWith(`${real}${path.sep}`) || destination === real)
					invalid("A skill snapshot cannot be stored inside its source directory");
				fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
				const next = new Set(ancestors).add(real);
				for (const entry of fs.readdirSync(real).sort()) copy(path.join(real, entry), path.join(dest, entry), next);
			} else if (stat.isFile()) {
				fs.copyFileSync(real, dest);
				fs.chmodSync(dest, 0o600);
			} else invalid("Skills must contain only regular files and directories");
		};
		try {
			for (const [index, source] of sourceDirs.entries()) {
				if (!fs.statSync(source).isDirectory()) invalid("skills_dirs must contain directories");
				const dest = path.join(target, String(index));
				copy(source, dest, new Set());
				result.push(dest);
			}
		} catch (error) {
			fs.rmSync(target, { recursive: true, force: true });
			if (error instanceof BotError) throw error;
			invalid("Cannot capture skill directory contents");
		}
		return result;
	}
	createBot(input: CreateBotInput): BotDefinition {
		return this.#atomic(() => {
			if (!record(input)) invalid("Bot definition must be an object");
			keys(input, ["bot_name", "cwd", "system_prompt", "tools", "skills_dirs", "model"], "Bot definition");
			const name = text(input.bot_name, "bot_name");
			if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(name))
				invalid("bot_name must contain only letters, digits, underscores, dots and hyphens");
			if (["create", "list"].includes(name)) invalid("Bot name is reserved by the CLI");
			if (this.#db.query("SELECT 1 FROM bots WHERE bot_name=?").get(name))
				throw new BotError("invalid_input", "Bot name is already in use");
			if (input.system_prompt !== undefined && typeof input.system_prompt !== "string")
				invalid("system_prompt must be a string");
			const botId = id("b");
			const config: BotConfig = {
				cwd: directory(input.cwd ?? process.cwd()),
				system_prompt: input.system_prompt ?? "",
				tools: [...new Set(list(input.tools ?? [], "tools"))].sort(),
				skills_dirs: [],
				model: input.model == null ? null : text(input.model, "model"),
			};
			config.skills_dirs = this.#copySkills(
				list(input.skills_dirs ?? [], "skills_dirs").map(item => path.resolve(item)),
				path.join(this.root, "definitions", botId, "skills"),
			);
			const bot: BotDefinition = {
				bot_id: botId,
				bot_name: name,
				config_revision: id("v"),
				config,
				created_at: now(),
			};
			this.#db
				.query("INSERT INTO bots(bot_id,bot_name,data,journal_id,worker) VALUES (?,?,?,?,?)")
				.run(botId, name, JSON.stringify(bot), id("bj"), JSON.stringify({ state: "offline", last_seen_at: null }));
			this.#emitBot(botId);
			return bot;
		});
	}
	withBot<T>(name: string, expectBotId: string | undefined, operation: (bot: BotDefinition) => T): T {
		return this.#atomic(() => operation(this.getBot(name, expectBotId)));
	}
	getBot(name: string, expectBotId?: string): BotDefinition {
		this.#access();
		const row = this.#db
			.query("SELECT data FROM bots WHERE (bot_name=? OR bot_id=?) AND bot_name NOT LIKE 'deleted:%'")
			.get(name, name) as JsonRow | null;
		if (!row) throw new BotError("unknown_bot", "Unknown Bot");
		const bot = JSON.parse(row.data) as BotDefinition;
		if (expectBotId !== undefined && bot.bot_id !== expectBotId) throw new BotError("unknown_bot", "Unknown Bot");
		return bot;
	}
	listBots(): BotDefinition[] {
		this.#access();
		return (
			this.#db
				.query("SELECT data FROM bots WHERE bot_name NOT LIKE 'deleted:%' ORDER BY bot_name")
				.all() as JsonRow[]
		).map(row => JSON.parse(row.data) as BotDefinition);
	}
	deleteBot(botId: string): void {
		this.#atomic(() => {
			this.#bot(botId);
			if (this.hasLiveWorker(botId))
				throw new BotError("invalid_state", "Stop the Bot worker before deleting the definition");
			// Historical identity and request keys remain durable. Only the display name is released.
			this.#db.query("UPDATE bots SET bot_name=? WHERE bot_id=?").run(`deleted:${botId}`, botId);
		});
	}
	getJob(botId: string, jobId: string): BotJob {
		const row = this.#job(botId, jobId);
		const job = JSON.parse(row.data) as BotJob;
		// Durations are materialized at updated_at, never recomputed by readers.
		job.controls = this.#controls(job);
		return job;
	}
	jobs(botId: string): BotJob[] {
		this.#bot(botId);
		return (
			this.#db.query("SELECT job_id FROM jobs WHERE bot_id=? ORDER BY rowid").all(botId) as { job_id: string }[]
		).map(row => this.getJob(botId, row.job_id));
	}
	#projection(job: BotJob): JobProjection {
		const {
			config: _config,
			session_file: _session,
			inputs: _inputs,
			input_requests: _questions,
			owned_services: _services,
			session_owner_id: _sessionOwner,
			owner_epoch: _epoch,
			launch_intents: _intents,
			...projection
		} = job;
		return {
			...projection,
			input_requests: job.input_requests.map(
				({ input_request_id, kind, prompt_ref, status, reply_request_id, completion_reason }) => ({
					input_request_id,
					kind,
					prompt_ref,
					status,
					reply_request_id,
					completion_reason,
				}),
			),
			cwd: this.preview(path.basename(projection.cwd)) || path.parse(projection.cwd).root,
		};
	}
	#controls(job: BotJob): JobProjection["controls"] {
		return ACTIONS.map(action => {
			let reason: string | null = null;
			if (action === "steer" && !job.execution_id) reason = "No foreground execution";
			if (action === "resume" && !["paused", "interrupted", "failed", "stopped"].includes(job.state))
				reason = "Job is not suspended";
			if (action === "interrupt" && ["paused", "stopped"].includes(job.state)) reason = "Job is already suspended";
			if (action === "stop" && job.state === "stopped" && job.settled) reason = "Job is already stopped";
			if (
				["send", "steer", "compact", "set-model"].includes(action) &&
				["stopped", "failed", "interrupted"].includes(job.state)
			)
				reason = "Resume the suspended Job first";
			if (job.phase === "cancelling" && action !== "stop") reason = "Cancellation is still unwinding";
			return { action, enabled: reason === null, reason };
		});
	}
	#botProjection(botId: string, jobs?: BotJob[]): BotProjection {
		const row = this.#bot(botId);
		const bot = JSON.parse(row.data) as BotDefinition;
		const scope = jobs ?? this.jobs(botId);
		const counts = Object.fromEntries(JOB_STATES.map(state => [state, 0])) as BotProjection["counts"];
		for (const job of scope) counts[job.state]++;
		const worker = JSON.parse(row.worker) as BotProjection["worker"];
		return {
			bot_id: botId,
			bot_name: bot.bot_name,
			config_revision: bot.config_revision,
			worker,
			counts,
			jobs_total: scope.length,
		};
	}
	#emitBot(botId: string): void {
		this.emit(botId, "bot.changed", { bot: this.#botProjection(botId) });
	}
	preview(value: string): string {
		return summaryPreview(value);
	}
	#failure(error: BotFailure): BotFailure {
		return {
			code: error.code,
			message: this.preview(error.message),
			retryable: error.retryable,
			...(error.details ? { details: this.#safeData(error.details) as Record<string, unknown> } : {}),
		};
	}
	#safeData(value: unknown): unknown {
		if (typeof value === "string") return this.preview(value);
		if (Array.isArray(value)) return value.map(item => this.#safeData(item));
		if (record(value))
			return Object.fromEntries(
				Object.entries(value)
					.filter(([key]) => !/^(thinking|reasoning|arguments|raw_input|raw_output)$/i.test(key))
					.map(([key, item]) => [key, this.#safeData(item)]),
			);
		return value;
	}
	#newJob(botId: string, command: BotCommand): BotJob {
		const bot = JSON.parse(this.#bot(botId).data) as BotDefinition;
		const jobId = id("j");
		const timestamp = now();
		const config: BotConfig = { ...bot.config, cwd: directory(command.cwd ?? bot.config.cwd) };
		fs.mkdirSync(path.join(this.root, "sessions"), { recursive: true, mode: 0o700 });
		const job: BotJob = {
			job_id: jobId,
			bot_id: botId,
			config_revision: bot.config_revision,
			revision: "1",
			goal_preview: this.preview(command.input!),
			goal_ref: this.putRef(botId, jobId, command.input!, "text/plain"),
			cwd: config.cwd,
			graph_context: command.graph_context ?? null,
			state: "queued",
			phase: "queued",
			settled: false,
			execution_id: null,
			pending_input_count: 0,
			pending_background_count: 0,
			pending_delivery_count: 0,
			activity: null,
			wait: null,
			progress: null,
			model: { current: config.model, pending: null },
			context: { used_tokens: null, limit_tokens: null },
			usage: {
				input_tokens: null,
				output_tokens: null,
				cache_read_tokens: null,
				cache_write_tokens: null,
				cost_usd: null,
				completeness: "unknown",
				measured_at: null,
			},
			created_at: timestamp,
			updated_at: timestamp,
			last_activity_at: timestamp,
			elapsed_ms: 0,
			active_ms: 0,
			output_ref: null,
			artifact_ids: [],
			error: null,
			controls: [],
			config,
			session_file: path.join(this.root, "sessions", `${jobId}.jsonl`),
			inputs: [],
			input_requests: [],
			owned_services: [],
			ownership: { state: "none", activation_ref: null },
			session_owner_id: null,
			owner_epoch: null,
			launch_intents: [],
		};
		job.controls = this.#controls(job);
		this.#db.query("INSERT INTO jobs(job_id,bot_id,data) VALUES (?,?,?)").run(jobId, botId, JSON.stringify(job));
		return job;
	}
	/** Atomically mark hosted work so an ordinary Bot worker can never dispatch it. */
	admitGraph(botId: string, input: BotCommand, ownerId: string, ownerEpoch: string): Receipt {
		return this.#atomic(() => {
			this.assertWorker(botId, ownerId, ownerEpoch);
			if (input.command !== "submit" || !input.graph_context)
				throw new BotError("invalid_input", "Graph admission requires a submit with graph context");
			const existing =
				input.key === undefined
					? null
					: (this.#db.query("SELECT job_id FROM requests WHERE bot_id=? AND key=?").get(botId, input.key) as {
							job_id: string | null;
						} | null);
			const receipt = this.admit(botId, input);
			if (!receipt.job_id) throw new BotError("invalid_state", "Graph admission did not create a Job");
			if (existing && !this.isGraphHosted(botId, receipt.job_id))
				throw new BotError("idempotency_conflict", "Request key belongs to a non-hosted Job");
			this.#db
				.query("INSERT OR IGNORE INTO graph_hosted_jobs(job_id,bot_id) VALUES (?,?)")
				.run(receipt.job_id, botId);
			return receipt;
		});
	}

	isGraphHosted(botId: string, jobId: string): boolean {
		this.#access();
		return !!this.#db.query("SELECT 1 FROM graph_hosted_jobs WHERE bot_id=? AND job_id=?").get(botId, jobId);
	}

	/** Recover the exact hosted submit associated with a durable request key. */
	graphHostedByKey(botId: string, key: string): { receipt: Receipt; job: BotJob } | null {
		return this.#atomic(() => {
			this.#bot(botId);
			const row = this.#db
				.query("SELECT data,expired FROM requests WHERE bot_id=? AND key=?")
				.get(botId, text(key, "key")) as { data: string; expired: number } | null;
			if (!row) return null;
			if (row.expired) throw new BotError("request_expired", "Graph admission history has expired");
			const request = JSON.parse(row.data) as StoredRequest;
			if (
				request.command.command !== "submit" ||
				!request.receipt.job_id ||
				!this.isGraphHosted(botId, request.receipt.job_id)
			)
				return null;
			return { receipt: request.receipt, job: this.getJob(botId, request.receipt.job_id) };
		});
	}

	/** Inspect a hosted control key before deciding whether a failed cleanup can be retried. */
	graphControlByKey(botId: string, jobId: string, key: string): RequestProjection | null {
		return this.#atomic(() => {
			if (!this.isGraphHosted(botId, jobId)) throw new BotError("permission_denied", "Job is not Graph-hosted");
			const row = this.#db
				.query("SELECT data,expired FROM requests WHERE bot_id=? AND key=?")
				.get(botId, text(key, "key")) as { data: string; expired: number } | null;
			if (!row) return null;
			if (row.expired) throw new BotError("request_expired", "Graph control history has expired");
			const request = JSON.parse(row.data) as StoredRequest;
			if (request.receipt.job_id !== jobId || request.command.command !== "stop")
				throw new BotError("idempotency_conflict", "Graph cleanup key belongs to another operation");
			return this.request(botId, request.request_id);
		});
	}

	admit(botId: string, input: BotCommand): Receipt {
		return this.#admit(botId, input);
	}

	/** Only the scoped owner can place controls in a hosted Job mailbox. */
	admitGraphControl(botId: string, jobId: string, input: BotCommand, ownerId: string, ownerEpoch: string): Receipt {
		return this.#atomic(() => {
			this.assertWorker(botId, ownerId, ownerEpoch);
			if (!this.isGraphHosted(botId, jobId) || input.command === "submit" || input.all || input.job_id !== jobId)
				throw new BotError("permission_denied", "Graph control must target the hosted Job");
			return this.#admit(botId, input, jobId);
		});
	}

	#admit(botId: string, input: BotCommand, hostedJobId?: string): Receipt {
		return this.#atomic(() => {
			this.#bot(botId);
			const command = validateCommand(input);
			if (
				command.command !== "submit" &&
				!command.all &&
				command.job_id &&
				this.isGraphHosted(botId, command.job_id) &&
				command.job_id !== hostedJobId
			)
				throw new BotError("permission_denied", "Graph-hosted Jobs require Graph-authorized controls");
			if (command.all && this.jobs(botId).some(job => this.isGraphHosted(botId, job.job_id) && !job.settled))
				throw new BotError("permission_denied", "Stop active Graph-hosted Jobs through Graph");
			const { key: _key, ...payload } = command;
			const signature = canonical(payload);
			if (command.key !== undefined) {
				const existing = this.#db
					.query("SELECT data,payload,expired FROM requests WHERE bot_id=? AND key=?")
					.get(botId, command.key) as RequestRow | null;
				if (existing) {
					if (existing.expired)
						throw new BotError("request_expired", "This request key is reserved by expired history");
					if (existing.payload !== signature)
						throw new BotError(
							"idempotency_conflict",
							"Request key was already used with a different operation or payload",
						);
					return (JSON.parse(existing.data) as StoredRequest).receipt;
				}
			}
			let job: BotJob | undefined;
			if (command.command === "submit") job = this.#newJob(botId, command);
			else if (!command.all) {
				job = this.getJob(botId, command.job_id!);
				if (command.if_revision !== undefined && command.if_revision !== job.revision)
					throw new BotError("revision_conflict", "Refresh Job state before applying this control", {
						current_revision: job.revision,
					});
				if (command.reply_to) {
					const question = job.input_requests.find(
						item => item.input_request_id === command.reply_to && item.status === "open",
					);
					if (
						!question ||
						job.ownership.state === "uncertain" ||
						["paused", "stopped", "interrupted", "failed"].includes(job.state)
					)
						throw new BotError("input_request_closed", "Input request is missing or already resolved");
					normalizeBotReply(question, command.input);
				} else {
					const control = job.controls.find(control => control.action === command.command);
					if (control && !control.enabled) throw new BotError("invalid_state", control.reason!);
				}
			}
			const receipt = this.#insertRequest(botId, command, signature, job?.job_id ?? null, null);
			if (command.all) {
				const children = this.jobs(botId).filter(child => !this.isGraphHosted(botId, child.job_id));
				for (const child of children)
					this.#insertRequest(
						botId,
						{ command: "stop", job_id: child.job_id },
						canonical({ command: "stop", job_id: child.job_id }),
						child.job_id,
						receipt.request_id,
					);
				if (children.length === 0) this.finishRequest(botId, receipt.request_id, "applied");
			} else if (job) {
				if (command.reply_to) this.reserveInputRequest(botId, job.job_id, command.reply_to, receipt.request_id);
				// Admission and queue counts commit together, before any worker has to be online.
				if (command.input !== undefined)
					this.enqueueInput(botId, job.job_id, {
						request_id: receipt.request_id,
						input: command.input,
						steer: command.command === "steer",
						...(command.reply_to ? { reply_to: command.reply_to } : {}),
					});
				// Controls claim the observed revision atomically, before worker application.
				else this.updateJob(botId, job.job_id, {});
			}
			return receipt;
		});
	}
	#insertRequest(
		botId: string,
		command: BotCommand,
		signature: string,
		jobId: string | null,
		parentId: string | null,
	): Receipt {
		const requestId = id("q");
		const event = this.emit(
			botId,
			"request.accepted",
			{ command: command.command, key: command.key ?? null },
			{ request_id: requestId, ...(jobId ? { job_id: jobId } : {}) },
		);
		const receipt: Receipt = {
			schema_version: 1,
			kind: "receipt",
			bot_id: botId,
			job_id: jobId,
			request_id: requestId,
			accepted: true,
			cursor: event.cursor,
		};
		const stored: StoredRequest = {
			request_id: requestId,
			command,
			receipt,
			outcome: "pending",
			parent_request_id: parentId,
		};
		this.#db
			.query(
				"INSERT INTO requests(request_id,bot_id,job_id,key,payload,data,outcome,parent_id) VALUES (?,?,?,?,?,?,?,?)",
			)
			.run(requestId, botId, jobId, command.key ?? null, signature, JSON.stringify(stored), "pending", parentId);
		return receipt;
	}
	hasUncertainOwnership(botId: string): boolean {
		this.#access();
		return (
			this.#db
				.query("SELECT 1 FROM jobs WHERE bot_id=? AND json_extract(data,'$.ownership.state')='uncertain' LIMIT 1")
				.get(botId) !== null
		);
	}
	hasPendingCancellation(botId: string, jobId: string): boolean {
		this.#access();
		return (
			this.#db
				.query(
					"SELECT 1 FROM requests WHERE bot_id=? AND job_id=? AND outcome='pending' AND json_extract(data,'$.command.command') IN ('stop','interrupt') LIMIT 1",
				)
				.get(botId, jobId) !== null
		);
	}
	pendingRequests(botId: string): StoredRequest[] {
		this.#bot(botId);
		return (
			this.#db
				.query("SELECT data FROM requests WHERE bot_id=? AND outcome='pending' AND expired=0 ORDER BY rowid")
				.all(botId) as JsonRow[]
		).map(row => JSON.parse(row.data) as StoredRequest);
	}
	request(botId: string, requestId: string): RequestProjection {
		const row = this.#request(botId, requestId);
		const stored = JSON.parse(row.data) as StoredRequest & {
			effective_at?: string | null;
			error?: BotFailure | null;
		};
		const result: RequestProjection = {
			schema_version: 1,
			kind: "request",
			receipt: stored.receipt,
			outcome: stored.outcome,
			effective_at: stored.effective_at ?? null,
			error: stored.error ?? null,
		};
		if (stored.command.all)
			result.children = (
				this.#db
					.query("SELECT request_id FROM requests WHERE bot_id=? AND parent_id=? ORDER BY rowid")
					.all(botId, requestId) as { request_id: string }[]
			).map(child => this.request(botId, child.request_id));
		return result;
	}
	finishRequest(
		botId: string,
		requestId: string,
		outcome: Exclude<RequestOutcome, "pending">,
		error?: BotFailure,
	): void {
		this.#atomic(() => {
			const row = this.#request(botId, requestId);
			if (row.outcome !== "pending") return;
			const stored = JSON.parse(row.data) as StoredRequest;
			const effectiveAt = outcome === "applied" ? now() : null;
			const failure = error ? this.#failure(error) : null;
			this.#db
				.query("UPDATE requests SET outcome=?,data=? WHERE bot_id=? AND request_id=? AND outcome='pending'")
				.run(
					outcome,
					JSON.stringify({ ...stored, outcome, effective_at: effectiveAt, error: failure }),
					botId,
					requestId,
				);
			this.emit(
				botId,
				"request.finished",
				{ command: stored.command.command, outcome, effective_at: effectiveAt, error: failure },
				{ request_id: requestId, ...(stored.receipt.job_id ? { job_id: stored.receipt.job_id } : {}) },
			);
			if (
				outcome !== "applied" &&
				stored.receipt.job_id &&
				["submit", "send", "steer"].includes(stored.command.command)
			) {
				this.releaseInputReservation(botId, stored.receipt.job_id, requestId);
				this.consumeInput(botId, stored.receipt.job_id, requestId);
			}
			if (row.parent_id) {
				const children = this.#db
					.query("SELECT outcome FROM requests WHERE bot_id=? AND parent_id=?")
					.all(botId, row.parent_id) as { outcome: RequestOutcome }[];
				if (children.every(child => child.outcome !== "pending")) {
					const rejected = children.some(child => child.outcome !== "applied");
					this.finishRequest(
						botId,
						row.parent_id,
						rejected ? "rejected" : "applied",
						rejected
							? {
									code: "cleanup_failed",
									message: "One or more Jobs could not be stopped; inspect child outcomes",
									retryable: true,
								}
							: undefined,
					);
				}
			}
		});
	}
	/** A failed launcher cannot overwrite work already owned or applied by a worker. */
	rejectPendingLaunch(botId: string, requestId: string, error: BotFailure): boolean {
		return this.#atomic(() => {
			const row = this.#request(botId, requestId);
			if (
				row.outcome !== "pending" ||
				this.hasLiveWorker(botId) ||
				isFileLockHeld(path.join(this.root, `${botId}.worker`))
			)
				return false;
			const request = JSON.parse(row.data) as StoredRequest;
			this.finishRequest(botId, requestId, "rejected", error);
			if (request.command.command === "submit" && request.receipt.job_id) {
				const job = this.getJob(botId, request.receipt.job_id);
				if (
					job.state === "queued" &&
					!job.execution_id &&
					!job.pending_background_count &&
					!job.pending_delivery_count
				) {
					this.updateJob(botId, job.job_id, { state: "failed", phase: "none", settled: true, error });
				}
			}
			return true;
		});
	}
	updateJob(botId: string, jobId: string, patch: Partial<JobProjection>): BotJob {
		return this.#atomic(() => {
			const row = this.#job(botId, jobId);
			const previous = JSON.parse(row.data) as BotJob;
			for (const key of [
				"job_id",
				"bot_id",
				"config_revision",
				"revision",
				"goal_ref",
				"goal_preview",
				"cwd",
				"graph_context",
				"created_at",
			] as const)
				if (patch[key] !== undefined && canonical(patch[key]) !== canonical(previous[key]))
					invalid(`Job ${key} is immutable`);
			keys(patch, Object.keys(this.#projection(previous)), "Job patch");
			const timestamp = now();
			const job: BotJob = {
				...previous,
				...patch,
				config: previous.config,
				inputs: previous.inputs,
				input_requests: previous.input_requests,
				session_file: previous.session_file,
				revision: (BigInt(previous.revision) + 1n).toString(),
				updated_at: timestamp,
				elapsed_ms: Math.max(0, Date.parse(timestamp) - Date.parse(previous.created_at)),
			};
			if (patch.activity?.label) job.activity = { ...patch.activity, label: this.preview(patch.activity.label) };
			if (patch.wait) job.wait = { ...patch.wait, message: this.preview(patch.wait.message) };
			if (patch.error) job.error = this.#failure(patch.error);
			if (patch.progress) job.progress = { ...patch.progress, unit: this.preview(patch.progress.unit) };
			job.pending_input_count = job.inputs.length;
			if (!JOB_STATES.includes(job.state)) invalid("Unknown Job state");
			for (const value of [job.pending_background_count, job.pending_delivery_count, job.active_ms])
				if (!Number.isSafeInteger(value) || value < 0)
					invalid("Job counts and durations must be nonnegative integers");
			if (
				![
					"queued",
					"model",
					"tool",
					"background",
					"input",
					"compacting",
					"retry_wait",
					"cancelling",
					"none",
				].includes(job.phase)
			)
				invalid("Unknown Job phase");
			for (const count of [
				job.context.used_tokens,
				job.context.limit_tokens,
				job.usage.input_tokens,
				job.usage.output_tokens,
				job.usage.cache_read_tokens,
				job.usage.cache_write_tokens,
			])
				if (count !== null && (!Number.isSafeInteger(count) || count < 0))
					invalid("Token counts must be nonnegative integers or null");
			if (job.usage.cost_usd !== null && !/^\d+(?:\.\d+)?$/.test(job.usage.cost_usd))
				invalid("Cost must be a nonnegative decimal string or null");
			if (!["complete", "partial", "unknown"].includes(job.usage.completeness))
				invalid("Invalid usage completeness");
			if (
				job.progress &&
				(!Number.isSafeInteger(job.progress.completed) ||
					!Number.isSafeInteger(job.progress.total) ||
					job.progress.completed < 0 ||
					job.progress.total < job.progress.completed ||
					!job.progress.unit.trim())
			)
				invalid("Invalid progress measurement");
			if (
				job.state === "idle" &&
				(!job.settled ||
					job.execution_id ||
					job.inputs.length ||
					job.pending_background_count ||
					job.pending_delivery_count)
			)
				invalid("idle requires no runnable or owned work");
			if (
				job.settled &&
				(job.execution_id ||
					job.pending_background_count ||
					job.pending_delivery_count ||
					job.ownership.state !== "none" ||
					(job.inputs.length > 0 && !["paused", "stopped", "failed", "interrupted"].includes(job.state)))
			)
				invalid("settled requires no runnable or owned work");
			if (job.state === "failed" && (job.execution_id || job.pending_background_count || job.pending_delivery_count))
				invalid("failed requires completed execution cleanup");
			let activeSince = row.active_since;
			let activeAccum = row.active_accum;
			if (activeSince && previous.execution_id !== job.execution_id) {
				activeAccum += Math.max(0, Date.parse(timestamp) - Date.parse(activeSince));
				activeSince = null;
			}
			if (!activeSince && job.execution_id) activeSince = timestamp;
			job.active_ms = activeAccum + (activeSince ? Math.max(0, Date.parse(timestamp) - Date.parse(activeSince)) : 0);
			this.#db.query("UPDATE jobs SET active_accum=? WHERE bot_id=? AND job_id=?").run(activeAccum, botId, jobId);
			if (
				patch.last_activity_at === undefined &&
				(patch.activity !== undefined ||
					patch.phase !== undefined ||
					patch.execution_id !== undefined ||
					patch.output_ref !== undefined ||
					patch.state !== undefined)
			)
				job.last_activity_at = timestamp;
			job.controls = this.#controls(job);
			this.#saveJob(job, activeSince);
			this.emit(
				botId,
				"job.changed",
				{ job: this.#projection(job) },
				{ job_id: jobId, ...(job.execution_id ? { execution_id: job.execution_id } : {}) },
			);
			if (!previous.settled && job.settled)
				this.emit(botId, "job.settled", { revision: job.revision }, { job_id: jobId });
			this.#emitBot(botId);
			return this.getJob(botId, jobId);
		});
	}
	enqueueInput(botId: string, jobId: string, input: QueuedInput): BotJob {
		return this.#atomic(() => {
			const row = this.#job(botId, jobId);
			const job = JSON.parse(row.data) as BotJob;
			const request = this.#request(botId, input.request_id);
			const stored = JSON.parse(request.data) as StoredRequest;
			if (stored.receipt.job_id !== jobId || !["submit", "send", "steer"].includes(stored.command.command))
				invalid("Input does not belong to this Job request");
			if (request.outcome !== "pending" || job.inputs.some(item => item.request_id === input.request_id))
				return this.getJob(botId, jobId);
			if (input.input !== stored.command.input) invalid("Queued input differs from admitted input");
			job.inputs.push({ ...input, input: text(input.input, "input") });
			this.#saveJob(job);
			const suspended = ["paused", "stopped", "failed", "interrupted"].includes(job.state);
			return this.updateJob(botId, jobId, {
				settled: suspended ? job.settled : false,
				...(job.state === "idle" ? { state: "queued", phase: "queued" } : {}),
			});
		});
	}
	consumeInput(botId: string, jobId: string, requestId: string): QueuedInput | null {
		return this.#atomic(() => {
			const job = JSON.parse(this.#job(botId, jobId).data) as BotJob;
			const index = job.inputs.findIndex(input => input.request_id === requestId);
			if (index < 0) return null;
			const [input] = job.inputs.splice(index, 1);
			this.#saveJob(job);
			this.updateJob(botId, jobId, {});
			return input!;
		});
	}
	assertWorker(botId: string, ownerId: string, ownerEpoch: string): void {
		const lease = this.workerLease(botId);
		if (!lease || lease.owner_id !== ownerId || lease.owner_epoch !== ownerEpoch)
			throw new BotError("invalid_state", "Worker ownership has been fenced");
	}
	#createActivation(
		job: BotJob,
		ownerId: string,
		ownerEpoch: string,
		requestId: string | null,
		inputRef: string | null,
		parent: string | null,
	): BotActivation {
		const activationRef = this.putRef(job.bot_id, job.job_id, null, "application/vnd.omp.bot-activation+json");
		const activation: BotActivation = {
			activation_ref: activationRef,
			bot_id: job.bot_id,
			job_id: job.job_id,
			owner_id: ownerId,
			owner_epoch: ownerEpoch,
			execution_id: null,
			request_id: requestId,
			input_ref: inputRef,
			parent_activation_ref: parent,
			stage: "initializing",
			recovery: "not_required",
			error: null,
		};
		this.#db
			.query("INSERT INTO activations VALUES (?,?,?,?)")
			.run(activationRef, job.bot_id, job.job_id, JSON.stringify(activation));
		this.updateActivation(activationRef, {});
		return activation;
	}
	activation(ref: string): BotActivation {
		const row = this.#db.query("SELECT data FROM activations WHERE activation_ref=?").get(ref) as JsonRow | null;
		if (!row) throw new BotError("invalid_state", "Unknown activation");
		return JSON.parse(row.data) as BotActivation;
	}
	updateActivation(
		ref: string,
		patch: Partial<Pick<BotActivation, "execution_id" | "stage" | "recovery" | "error">>,
	): BotActivation {
		return this.#atomic(() => {
			const activation = {
				...this.activation(ref),
				...patch,
				...(patch.error ? { error: this.#failure(patch.error) } : {}),
			};
			this.#db.query("UPDATE activations SET data=? WHERE activation_ref=?").run(JSON.stringify(activation), ref);
			const { execution_id, request_id, input_ref, parent_activation_ref, stage, recovery, error } = activation;
			this.#db.query("UPDATE refs SET content=? WHERE ref=?").run(
				JSON.stringify({
					schema_version: 1,
					execution_id,
					request_id,
					input_ref,
					parent_activation_ref,
					stage,
					recovery,
					error,
				}),
				ref,
			);
			return activation;
		});
	}
	/** The retained input and initializing owner commit before the runtime factory is entered. */
	claimInput(
		botId: string,
		jobId: string,
		requestId: string,
		ownerId: string,
		ownerEpoch: string,
		injected = false,
	): { input: QueuedInput; activation: BotActivation } | null {
		return this.#atomic(() => {
			this.assertWorker(botId, ownerId, ownerEpoch);
			const job = this.getJob(botId, jobId);
			if (["paused", "stopped", "interrupted", "failed"].includes(job.state) || job.phase === "cancelling")
				return null;
			if (this.request(botId, requestId).outcome !== "applied") return null;
			const index = job.inputs.findIndex(item => item.request_id === requestId);
			if (index < 0) return null;
			const input = job.inputs[index]!;
			const inputRef = this.putRef(botId, jobId, input.input, "text/plain");
			const activation = this.#createActivation(
				job,
				ownerId,
				ownerEpoch,
				requestId,
				inputRef,
				job.ownership.activation_ref,
			);
			job.inputs.splice(index, 1);
			this.#saveJob(job);
			this.updateJob(
				botId,
				jobId,
				injected
					? {}
					: {
							state: "running",
							phase: "queued",
							settled: false,
							ownership: { state: "active", activation_ref: activation.activation_ref },
							wait: null,
						},
			);
			return { input, activation };
		});
	}
	claimContinuation(
		botId: string,
		jobId: string,
		ownerId: string,
		ownerEpoch: string,
		parent: string | null,
		requestId: string | null,
		payload: unknown,
	): BotActivation {
		return this.#atomic(() => {
			this.assertWorker(botId, ownerId, ownerEpoch);
			const job = this.getJob(botId, jobId);
			if (["paused", "stopped", "interrupted", "failed"].includes(job.state) || job.phase === "cancelling")
				throw new BotError("invalid_state", "Continuation was cancelled");
			const activation = this.#createActivation(
				job,
				ownerId,
				ownerEpoch,
				requestId,
				payload === undefined ? null : this.putRef(botId, jobId, payload),
				parent,
			);
			this.updateJob(botId, jobId, {
				ownership: { state: "active", activation_ref: activation.activation_ref },
				settled: false,
				...(["idle", "queued"].includes(job.state) ? { state: "running", phase: "queued" } : {}),
			});
			return activation;
		});
	}
	interruptOwnership(botId: string, jobId: string, error: BotFailure): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			if (!job.ownership.activation_ref) {
				const lease = this.workerLease(botId);
				job.ownership.activation_ref = this.#createActivation(
					job,
					lease?.owner_id ?? "lost",
					lease?.owner_epoch ?? "0",
					null,
					null,
					null,
				).activation_ref;
			}
			if (job.ownership.activation_ref)
				this.updateActivation(job.ownership.activation_ref, {
					stage: "interrupted",
					recovery: job.session_owner_id ? "cleanup_required" : "inspection_required",
					error,
				});
			this.updateJob(botId, jobId, {
				state: "interrupted",
				phase: "none",
				execution_id: null,
				activity: null,
				settled: false,
				ownership: { state: "uncertain", activation_ref: job.ownership.activation_ref },
				error,
			});
		});
	}
	closeOwnership(botId: string, jobId: string, error?: BotFailure): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			if (job.launch_intents.some(intent => !intent.disposition?.final))
				throw new BotError("cleanup_failed", "Launch intent cleanup has not been confirmed", undefined, true);
			if (job.ownership.state === "none") return;
			if (job.ownership.activation_ref)
				this.updateActivation(job.ownership.activation_ref, {
					stage: "closed",
					recovery: "not_required",
					error: error ?? null,
				});
			this.updateJob(botId, jobId, { ownership: { state: "none", activation_ref: job.ownership.activation_ref } });
		});
	}
	setSessionOwner(botId: string, jobId: string, sessionOwnerId: string, ownerEpoch: string): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			job.session_owner_id = text(sessionOwnerId, "session_owner_id");
			job.owner_epoch = ownerEpoch;
			this.#saveJob(job);
		});
	}
	recordLaunchIntent(botId: string, jobId: string, intent: Omit<StoredLaunchIntent, "disposition">): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			const businessPayload =
				record(intent.payload) && intent.payload.op === "start"
					? Object.fromEntries(
							Object.entries({ ...intent.payload, owner: intent.session_owner_id }).filter(
								([key]) => key !== "awaitReady" && key !== "launch",
							),
						)
					: intent.payload;
			// Store the JSON wire image, so omitted optional fields compare identically after restart.
			const normalized = JSON.parse(JSON.stringify({ ...intent, payload: businessPayload })) as Omit<
				StoredLaunchIntent,
				"disposition"
			>;
			const existing = job.launch_intents.find(item => item.launch_intent_id === intent.launch_intent_id);
			if (existing) {
				const { disposition: _disposition, ...payload } = existing;
				if (canonical(payload) !== canonical(normalized))
					throw new BotError("idempotency_conflict", "Launch intent identity was reused");
				return;
			}
			if (job.session_owner_id !== intent.session_owner_id || job.owner_epoch !== intent.owner_epoch)
				throw new BotError("invalid_state", "Launch intent belongs to a fenced session");
			job.launch_intents.push({ ...normalized, disposition: null });
			this.#saveJob(job);
			this.updateJob(botId, jobId, { settled: false });
		});
	}
	launchIntents(botId: string, jobId: string): StoredLaunchIntent[] {
		return this.getJob(botId, jobId).launch_intents;
	}
	updateLaunchIntent(
		botId: string,
		jobId: string,
		intentId: string,
		disposition: StoredLaunchIntent["disposition"],
	): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			const intent = job.launch_intents.find(item => item.launch_intent_id === intentId);
			if (!intent) throw new BotError("invalid_state", "Unknown durable launch intent");
			if (intent.disposition?.final) return;
			intent.disposition = disposition;
			this.#saveJob(job);
		});
	}
	setSessionFile(botId: string, jobId: string, file: string): void {
		this.#atomic(() => {
			const job = JSON.parse(this.#job(botId, jobId).data) as BotJob;
			const resolved = path.resolve(file);
			if (!resolved.startsWith(`${this.root}${path.sep}`))
				throw new BotError("permission_denied", "Session must remain inside its Bot profile");
			job.session_file = resolved;
			this.#saveJob(job);
		});
	}
	/** Publish confirmed cleanup and its durable request outcome in one fenced commit. */
	finishCancellation(
		botId: string,
		jobId: string,
		requestId: string,
		ownerId: string,
		ownerEpoch: string,
		command: "stop" | "interrupt",
	): void {
		this.#atomic(() => {
			this.assertWorker(botId, ownerId, ownerEpoch);
			const request = JSON.parse(this.#request(botId, requestId).data) as StoredRequest;
			if (request.receipt.job_id !== jobId || request.command.command !== command)
				throw new BotError("invalid_state", "Cancellation does not match the Job request");
			this.closeOwnership(botId, jobId);
			this.closeInputRequests(botId, jobId, requestId);
			this.finishRequest(botId, requestId, "applied");
			this.updateRuntimeState(
				botId,
				jobId,
				{
					state: command === "stop" ? "stopped" : "paused",
					phase: "none",
					settled: true,
					execution_id: null,
					activity: null,
					wait: null,
					pending_background_count: 0,
					pending_delivery_count: 0,
				},
				[],
			);
		});
	}

	/** Commit recovery identities with their observed counts, never in a separate window. */
	updateRuntimeState(
		botId: string,
		jobId: string,
		patch: Partial<JobProjection>,
		services?: OwnedBotService[],
	): BotJob {
		return this.#atomic(() => {
			if (services !== undefined) {
				const job = JSON.parse(this.#job(botId, jobId).data) as BotJob;
				job.owned_services = services;
				this.#saveJob(job);
			}
			return this.updateJob(botId, jobId, patch);
		});
	}
	setJobModel(botId: string, jobId: string, model: string): BotJob {
		return this.#atomic(() => {
			const job = JSON.parse(this.#job(botId, jobId).data) as BotJob;
			job.config.model = text(model, "model");
			this.#saveJob(job);
			return this.updateJob(botId, jobId, { model: { current: model, pending: null } });
		});
	}
	registerInputRequest(botId: string, jobId: string, question: BotInputRequest): string {
		return this.#atomic(() => {
			const job = JSON.parse(this.#job(botId, jobId).data) as BotJob;
			text(question.input_request_id, "input_request_id");
			if (!["text", "approval"].includes(question.kind)) invalid("Invalid input request kind");
			const existing = job.input_requests.find(item => item.input_request_id === question.input_request_id);
			if (existing) return existing.prompt_ref;
			const promptRef = this.putRef(
				botId,
				jobId,
				describeBotQuestion(question),
				"application/vnd.omp.bot-question+json",
			);
			job.input_requests.push({
				input_request_id: question.input_request_id,
				kind: question.kind,
				prompt: question.prompt,
				prompt_ref: promptRef,
				status: "open",
				reply_request_id: null,
				completion_reason: null,
			});
			this.#saveJob(job);
			this.updateJob(botId, jobId, {});
			this.emit(
				botId,
				"input.required",
				{ input_request_id: question.input_request_id, kind: question.kind, prompt_ref: promptRef },
				{ job_id: jobId, ...(job.execution_id ? { execution_id: job.execution_id } : {}) },
			);
			return promptRef;
		});
	}
	reserveInputRequest(botId: string, jobId: string, questionId: string, requestId: string): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			const question = job.input_requests.find(item => item.input_request_id === questionId);
			if (!question || (question.status !== "open" && question.reply_request_id !== requestId))
				throw new BotError("input_request_closed", "Input request is missing or reserved");
			question.status = "reply_queued";
			question.reply_request_id = requestId;
			question.completion_reason = "reply";
			this.#saveJob(job);
			this.updateJob(botId, jobId, {});
		});
	}
	reserveCompletion(botId: string, jobId: string, questionId: string, reason: "timeout" | "dialog_cancel"): boolean {
		return this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			const question = job.input_requests.find(item => item.input_request_id === questionId);
			if (!question || question.status !== "open") return false;
			question.status = "completion_queued";
			question.completion_reason = reason;
			this.#saveJob(job);
			this.updateJob(botId, jobId, {});
			return true;
		});
	}
	releaseInputReservation(botId: string, jobId: string, requestId: string): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			const question = job.input_requests.find(item => item.reply_request_id === requestId);
			if (!question || this.request(botId, requestId).outcome === "applied") return;
			question.status = "open";
			question.reply_request_id = null;
			question.completion_reason = null;
			if (
				job.ownership.state === "uncertain" ||
				["paused", "stopped", "interrupted", "failed"].includes(job.state)
			) {
				job.input_requests = job.input_requests.filter(item => item !== question);
				this.emit(
					botId,
					"input.cancelled",
					{ input_request_id: question.input_request_id, reason: "runtime_not_live" },
					{ job_id: jobId, request_id: requestId },
				);
			}
			this.#saveJob(job);
			this.updateJob(botId, jobId, {});
		});
	}
	resolveInputRequest(botId: string, jobId: string, questionId: string, requestId?: string): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			const question = job.input_requests.find(item => item.input_request_id === questionId);
			if (!question) return;
			if (requestId && question.reply_request_id !== requestId)
				throw new BotError("input_request_closed", "Another completion owns this question");
			job.input_requests = job.input_requests.filter(item => item !== question);
			this.#saveJob(job);
			this.emit(
				botId,
				"input.resolved",
				{ input_request_id: questionId, reason: question.completion_reason },
				{ job_id: jobId, ...(requestId ? { request_id: requestId } : {}) },
			);
			this.updateJob(botId, jobId, {});
		});
	}
	cancelInputRequest(botId: string, jobId: string, questionId: string, reason: string, requestId?: string): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			if (!job.input_requests.some(question => question.input_request_id === questionId)) return;
			job.input_requests = job.input_requests.filter(question => question.input_request_id !== questionId);
			this.#saveJob(job);
			this.emit(
				botId,
				"input.cancelled",
				{ input_request_id: questionId, reason },
				{ job_id: jobId, ...(requestId ? { request_id: requestId } : {}) },
			);
			this.updateJob(botId, jobId, {});
		});
	}
	closeInputRequests(botId: string, jobId: string, requestId: string): void {
		this.#atomic(() => {
			const job = JSON.parse(this.#job(botId, jobId).data) as BotJob;
			for (const question of job.input_requests)
				this.emit(
					botId,
					"input.cancelled",
					{ input_request_id: question.input_request_id, reason: "question_closed" },
					{ job_id: jobId, request_id: requestId },
				);
			job.input_requests = [];
			this.#saveJob(job);
			for (const input of job.inputs) {
				if (!input.reply_to) continue;
				const outcome = this.request(botId, input.request_id).outcome;
				if (outcome === "pending") this.finishRequest(botId, input.request_id, "cancelled");
				else this.consumeInput(botId, jobId, input.request_id);
				this.emit(
					botId,
					"input.cancelled",
					{ input_request_id: input.reply_to, reason: "question_closed" },
					{ job_id: jobId, request_id: input.request_id },
				);
			}
			this.updateJob(botId, jobId, {});
		});
	}
	emit(botId: string, type: string, data: unknown, ids: EventIds = {}): BotEvent {
		return this.#atomic(() => {
			const bot = this.#bot(botId);
			if (ids.job_id) this.#job(botId, ids.job_id);
			const seq = this.#db
				.query("UPDATE bots SET seq=seq+1 WHERE bot_id=? RETURNING CAST(seq AS TEXT) AS seq")
				.get(botId) as { seq: string };
			const event: BotEvent = {
				schema_version: 1,
				kind: "event",
				profile_id: this.profile_id,
				bot_id: botId,
				job_id: ids.job_id ?? null,
				execution_id: ids.execution_id ?? null,
				request_id: ids.request_id ?? null,
				event_id: id("e"),
				cursor: { journal_id: bot.journal_id, seq: seq.seq },
				occurred_at: now(),
				type,
				cause_event_id: ids.cause_event_id ?? null,
				data: this.#eventData(type, data),
			};
			this.#db
				.query("INSERT INTO events(bot_id,seq,job_id,data) VALUES (?,CAST(? AS INTEGER),?,?)")
				.run(botId, seq.seq, event.job_id, JSON.stringify(event));
			return event;
		});
	}
	#eventData(type: string, data: unknown): unknown {
		// Projection identifiers/cursors/opaque correlation are never truncated or rewritten.
		if (["job.changed", "bot.changed"].includes(type)) return data;
		if (!record(data)) return withoutReasoning(data);
		const safe = { ...data };
		for (const field of ["label", "preview", "name", "message"] as const)
			if (typeof safe[field] === "string") safe[field] = this.preview(safe[field]);
		if (record(safe.error)) safe.error = this.#failure(safe.error as unknown as BotFailure);
		return withoutReasoning(safe);
	}
	#validateCursor(botId: string, cursor: Cursor): void {
		const bot = this.#bot(botId);
		if (
			!record(cursor) ||
			Object.keys(cursor).some(key => !["journal_id", "seq"].includes(key)) ||
			cursor.journal_id !== bot.journal_id ||
			typeof cursor.seq !== "string" ||
			!/^(0|[1-9]\d*)$/.test(cursor.seq) ||
			BigInt(cursor.seq) > BigInt(bot.seq)
		)
			throw new BotError("invalid_cursor", "Cursor does not belong to this Bot journal");
		if (BigInt(cursor.seq) < BigInt(bot.floor))
			throw new BotError("cursor_expired", "Cursor history has expired; obtain a fresh snapshot", {
				reset_required: true,
			});
	}
	#token(kind: string, botId: string, scope: string, data: unknown): string {
		const token = id("page");
		this.#db
			.query("INSERT INTO page_tokens(token,kind,bot_id,scope,data) VALUES (?,?,?,?,?)")
			.run(token, kind, botId, scope, JSON.stringify(data));
		return token;
	}
	#readToken(kind: string, botId: string, scope: string, token: string): unknown {
		const row = this.#db
			.query("SELECT kind,bot_id,scope,data FROM page_tokens WHERE token=?")
			.get(token) as TokenRow | null;
		if (!row || row.kind !== kind || row.bot_id !== botId || row.scope !== scope)
			throw new BotError("invalid_cursor", "Invalid or foreign page token");
		return JSON.parse(row.data) as unknown;
	}
	snapshot(botId: string, jobOrOptions?: string | SnapshotOptions): Snapshot {
		return this.#atomic(() => {
			const bot = this.#bot(botId);
			const options = typeof jobOrOptions === "string" ? { job_id: jobOrOptions } : (jobOrOptions ?? {});
			const scope = canonical({ job_id: options.job_id ?? null, graph_run_id: options.graph_run_id ?? null });
			if (options.page_token) return this.#readToken("snapshot", botId, scope, options.page_token) as Snapshot;
			const limit = options.limit === undefined ? MAX_PAGE_SIZE : pageLimit(options.limit);
			let scopedJobs = this.jobs(botId);
			if (options.graph_run_id)
				scopedJobs = scopedJobs.filter(job => job.graph_context?.graph_run_id === options.graph_run_id);
			const projection = this.#botProjection(botId, scopedJobs);
			if (options.job_id) this.getJob(botId, options.job_id);
			const jobs = options.job_id ? scopedJobs.filter(job => job.job_id === options.job_id) : scopedJobs;
			const cursor = { journal_id: bot.journal_id, seq: bot.seq };
			const pages: Snapshot[] = [];
			for (let index = 0; index < Math.max(1, jobs.length); index += limit)
				pages.push({
					schema_version: 1,
					kind: "snapshot",
					profile_id: this.profile_id,
					capabilities: ["bot.questions.v1", "bot.ownership.v1", "bot.identity-guard.v1", "bot.scoped-refs.v1"],
					bot: projection,
					jobs: jobs.slice(index, index + limit).map(job => this.#projection(job)),
					cursor,
					next_page_token: null,
				});
			for (let index = pages.length - 2; index >= 0; index--)
				pages[index]!.next_page_token = this.#token("snapshot", botId, scope, pages[index + 1]);
			return pages[0]!;
		});
	}
	snapshotPages(botId: string, jobId?: string, pageSize = 100): Snapshot[] {
		return this.#atomic(() => {
			const pages = [this.snapshot(botId, { job_id: jobId, limit: pageLimit(pageSize) })];
			while (pages[pages.length - 1]!.next_page_token)
				pages.push(this.snapshot(botId, { job_id: jobId, page_token: pages[pages.length - 1]!.next_page_token! }));
			return pages;
		});
	}
	events(botId: string, options: EventOptions = {}): Page<BotEvent> {
		return this.#atomic(() => {
			const bot = this.#bot(botId);
			if (options.job_id) this.#job(botId, options.job_id);
			const scope = canonical({ job_id: options.job_id ?? null });
			const limit = pageLimit(options.limit);
			let after = options.after ?? { journal_id: bot.journal_id, seq: "0" };
			let watermark = bot.seq;
			if (options.page_token) {
				const saved = this.#readToken("events", botId, scope, options.page_token) as {
					after: Cursor;
					watermark: string;
				};
				if (options.after && canonical(options.after) !== canonical(saved.after))
					throw new BotError("invalid_cursor", "after conflicts with page token");
				after = saved.after;
				watermark = saved.watermark;
			}
			this.#validateCursor(botId, after);
			const rows = this.#db
				.query(
					`SELECT data FROM events WHERE bot_id=? AND seq>CAST(? AS INTEGER) AND seq<=CAST(? AS INTEGER) ${options.job_id ? "AND (job_id=? OR (job_id IS NULL AND json_extract(data,'$.type')='bot.changed'))" : ""} ORDER BY seq LIMIT ?`,
				)
				.all(
					...(options.job_id
						? [botId, after.seq, watermark, options.job_id, limit + 1]
						: [botId, after.seq, watermark, limit + 1]),
				) as EventRow[];
			const items = rows.slice(0, limit).map(row => JSON.parse(row.data) as BotEvent);
			const token =
				rows.length > limit
					? this.#token("events", botId, scope, { after: items[items.length - 1]!.cursor, watermark })
					: null;
			return { items, next_page_token: token };
		});
	}
	putRef(botId: string, jobId: string | null, content: unknown, mediaType = "application/json"): string {
		return this.#atomic(() => {
			this.#bot(botId);
			const ref = id("ref");
			let availability: RefProjection["availability"] = "available";
			if (record(content) && ["thinking", "reasoning", "redacted_thinking"].includes(String(content.type)))
				availability = "redacted";
			const clean = withoutReasoning(content);
			const binary = content instanceof Uint8Array || content instanceof ArrayBuffer;
			const stored = binary ? { size_bytes: content.byteLength, binary: true } : clean;
			this.#db
				.query("INSERT INTO refs(ref,bot_id,job_id,media_type,content,availability) VALUES (?,?,?,?,?,?)")
				.run(
					ref,
					botId,
					jobId,
					mediaType,
					availability === "available" ? JSON.stringify(stored) : null,
					availability,
				);
			return ref;
		});
	}
	inspect(botId: string, ref: string, pageToken?: string, jobId?: string): RefProjection {
		return this.#atomic(() => {
			this.#bot(botId);
			if (jobId && !this.#db.query("SELECT 1 FROM jobs WHERE bot_id=? AND job_id=?").get(botId, jobId))
				throw new BotError("permission_denied", "Reference does not belong to this Bot and Job");
			const scope = canonical({ ref, job_id: jobId ?? null });
			let offset = 0;
			if (pageToken) {
				const saved = this.#readToken("ref", botId, scope, pageToken) as { offset: number };
				offset = saved.offset;
			}
			const row = this.#db
				.query("SELECT content,media_type,availability,job_id FROM refs WHERE bot_id=? AND ref=?")
				.get(botId, ref) as RefRow | null;
			if (jobId && (!row || row.job_id !== jobId))
				throw new BotError("permission_denied", "Reference does not belong to this Bot and Job");
			if (!row) return { ref, availability: "missing", media_type: null, content: null, next_page_token: null };
			if (row.availability !== "available" || row.content === null)
				return {
					ref,
					availability: row.availability,
					media_type: row.media_type,
					content: null,
					next_page_token: null,
				};
			const content: unknown = JSON.parse(row.content);
			// Large structured detail is paginated as JSON text; joining all chunks recovers its exact JSON.
			const serialized = typeof content !== "string" && row.content.length > REF_PAGE_SIZE;
			const body = serialized ? row.content : content;
			const sequence = typeof body === "string" ? Array.from(body) : Array.isArray(body) ? body : null;
			if (sequence) {
				const end = offset + (typeof body === "string" ? REF_PAGE_SIZE : 100);
				return {
					ref,
					availability: "available",
					media_type: row.media_type,
					content: typeof body === "string" ? sequence.slice(offset, end).join("") : sequence.slice(offset, end),
					next_page_token: end < sequence.length ? this.#token("ref", botId, scope, { offset: end }) : null,
				};
			}
			if (pageToken) throw new BotError("invalid_cursor", "Reference does not support pagination");
			return { ref, availability: "available", media_type: row.media_type, content, next_page_token: null };
		});
	}
	expireRef(botId: string, ref: string): void {
		this.#atomic(() => {
			this.#bot(botId);
			this.#db.query("UPDATE refs SET content=NULL,availability='expired' WHERE bot_id=? AND ref=?").run(botId, ref);
		});
	}
	recordMessage(botId: string, jobId: string, message: unknown): void {
		this.#atomic(() => {
			this.#job(botId, jobId);
			const clean = withoutReasoning(message);
			const messageId = record(clean) && typeof clean.message_id === "string" ? clean.message_id : null;
			this.#db
				.query(
					"INSERT INTO messages(bot_id,job_id,message_id,data) VALUES (?,?,?,?) ON CONFLICT(job_id,message_id) DO UPDATE SET data=excluded.data",
				)
				.run(botId, jobId, messageId, JSON.stringify(clean));
		});
	}
	messages(botId: string, jobId: string, pageToken?: string, limit = 100): Page<unknown> {
		return this.#atomic(() => {
			this.#job(botId, jobId);
			pageLimit(limit);
			let after = "0";
			const latest = this.#db
				.query("SELECT CAST(COALESCE(MAX(seq),0) AS TEXT) AS seq FROM messages WHERE bot_id=? AND job_id=?")
				.get(botId, jobId) as { seq: string };
			let watermark = latest.seq;
			if (pageToken) {
				const saved = this.#readToken("messages", botId, jobId, pageToken) as { after: string; watermark: string };
				after = saved.after;
				watermark = saved.watermark;
			}
			const rows = this.#db
				.query(
					"SELECT CAST(seq AS TEXT) AS seq,data FROM messages WHERE bot_id=? AND job_id=? AND seq>CAST(? AS INTEGER) AND seq<=CAST(? AS INTEGER) ORDER BY seq LIMIT ?",
				)
				.all(botId, jobId, after, watermark, limit + 1) as Array<JsonRow & { seq: string }>;
			return {
				items: rows.slice(0, limit).map(row => JSON.parse(row.data) as unknown),
				next_page_token:
					rows.length > limit
						? this.#token("messages", botId, jobId, { after: rows[limit - 1]!.seq, watermark })
						: null,
			};
		});
	}
	pruneEvents(botId: string, through: Cursor): void {
		this.#atomic(() => {
			this.#validateCursor(botId, through);
			this.#db.query("DELETE FROM events WHERE bot_id=? AND seq<=CAST(? AS INTEGER)").run(botId, through.seq);
			this.#db.query("UPDATE bots SET floor=CAST(? AS INTEGER) WHERE bot_id=?").run(through.seq, botId);
		});
	}
	pruneJob(botId: string, jobId: string): void {
		this.#atomic(() => {
			const job = this.getJob(botId, jobId);
			if (!job.settled) throw new BotError("invalid_state", "Cannot prune unsettled Job history");
			if (this.pendingRequests(botId).some(request => request.receipt.job_id === jobId))
				throw new BotError("invalid_state", "Cannot prune pending requests");
			this.#db
				.query("UPDATE requests SET expired=1,data='{}',payload='' WHERE bot_id=? AND job_id=?")
				.run(botId, jobId);
			this.#db
				.query("UPDATE refs SET content=NULL,availability='expired' WHERE bot_id=? AND job_id=?")
				.run(botId, jobId);
			this.#db.query("DELETE FROM messages WHERE bot_id=? AND job_id=?").run(botId, jobId);
			this.#db.query("DELETE FROM jobs WHERE bot_id=? AND job_id=?").run(botId, jobId);
			this.#emitBot(botId);
		});
	}
	workerLease(botId: string): WorkerLease | null {
		const lease = this.#bot(botId).lease;
		return lease ? (JSON.parse(lease) as WorkerLease) : null;
	}
	workerSample(botId: string): BotProjection["worker"] {
		return JSON.parse(this.#bot(botId).worker) as BotProjection["worker"];
	}
	reconcileOffline(
		botId: string,
		observedLease: WorkerLease | null,
		observedWorker: BotProjection["worker"],
	): boolean {
		return this.#atomic(() => {
			const row = this.#bot(botId);
			if (
				canonical(this.workerLease(botId)) !== canonical(observedLease) ||
				canonical(this.workerSample(botId)) !== canonical(observedWorker) ||
				observedWorker.state === "offline"
			)
				return false;
			if (observedLease) {
				if (Date.parse(observedLease.expires_at) > Date.now()) return false;
				if (processExists(observedLease.pid)) return false;
			}
			if (isFileLockHeld(path.join(this.root, `${botId}.worker`))) return false;
			this.#db
				.query("UPDATE bots SET worker=? WHERE bot_id=? AND worker=? AND lease IS ?")
				.run(JSON.stringify({ ...observedWorker, state: "offline" }), botId, row.worker, row.lease);
			for (const job of this.jobs(botId))
				if (job.ownership.state !== "none" || ["running", "waiting_input"].includes(job.state))
					this.interruptOwnership(botId, job.job_id, {
						code: "worker_lost",
						message: "Worker ownership was lost; inspect before resuming",
						retryable: false,
					});
			this.#emitBot(botId);
			return true;
		});
	}
	hasLiveWorker(botId: string): boolean {
		const lease = this.workerLease(botId);
		if (!lease || Date.parse(lease.expires_at) <= Date.now()) return false;
		return processExists(lease.pid);
	}
	/** A bounded handoff request never preempts live or suspended Bot work. */
	requestGraphHandoff(botId: string): void {
		this.#atomic(() => {
			this.#bot(botId);
			this.#db
				.query(
					"INSERT INTO graph_handoffs VALUES (?,?) ON CONFLICT(bot_id) DO UPDATE SET expires_at=excluded.expires_at",
				)
				.run(botId, Date.now() + 10_000);
		});
	}

	hasGraphHandoff(botId: string): boolean {
		this.#access();
		return !!this.#db.query("SELECT 1 FROM graph_handoffs WHERE bot_id=? AND expires_at>?").get(botId, Date.now());
	}

	clearGraphHandoff(botId: string): void {
		this.#atomic(() => {
			this.#db.query("DELETE FROM graph_handoffs WHERE bot_id=?").run(botId);
		});
	}

	claimWorker(botId: string, ownerId: string, pid: number, ttlMs = 15_000, ownsLock = false): boolean {
		return this.#atomic(() => {
			text(ownerId, "owner_id");
			if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
				invalid("Invalid worker lease");
			const current = this.workerLease(botId);
			if (current && current.owner_id !== ownerId) {
				if (processExists(current.pid)) return false;
				if (!ownsLock && isFileLockHeld(path.join(this.root, `${botId}.worker`))) return false;
			}
			const epochRow = this.#db.query("SELECT owner_epoch FROM bots WHERE bot_id=?").get(botId) as {
				owner_epoch: string;
			};
			const epoch = (BigInt(epochRow.owner_epoch) + 1n).toString();
			const timestamp = now();
			const lease: WorkerLease = {
				owner_id: ownerId,
				owner_epoch: epoch,
				pid,
				last_seen_at: timestamp,
				expires_at: new Date(Date.now() + ttlMs).toISOString(),
			};
			this.#db
				.query("UPDATE bots SET lease=?,worker=?,owner_epoch=? WHERE bot_id=?")
				.run(JSON.stringify(lease), JSON.stringify({ state: "online", last_seen_at: timestamp }), epoch, botId);
			this.#emitBot(botId);
			return true;
		});
	}
	heartbeatWorker(botId: string, ownerId: string, ttlMs = 15_000): boolean {
		return this.#atomic(() => {
			const lease = this.workerLease(botId);
			if (!lease || lease.owner_id !== ownerId) return false;
			lease.last_seen_at = now();
			lease.expires_at = new Date(Date.now() + ttlMs).toISOString();
			this.#db.query("UPDATE bots SET lease=? WHERE bot_id=?").run(JSON.stringify(lease), botId);
			return true;
		});
	}
	publishWorker(botId: string, ownerId: string): boolean {
		return this.#atomic(() => {
			const lease = this.workerLease(botId);
			if (!lease || lease.owner_id !== ownerId) return false;
			const sample = this.workerSample(botId);
			if (sample.state !== "online" || sample.last_seen_at !== lease.last_seen_at) {
				this.#db
					.query("UPDATE bots SET worker=? WHERE bot_id=?")
					.run(JSON.stringify({ state: "online", last_seen_at: lease.last_seen_at }), botId);
				this.#emitBot(botId);
			}
			return true;
		});
	}
	releaseWorker(botId: string, ownerId: string): void {
		this.#atomic(() => {
			const lease = this.workerLease(botId);
			if (lease?.owner_id !== ownerId) return;
			this.#db
				.query("UPDATE bots SET lease=NULL,worker=? WHERE bot_id=?")
				.run(JSON.stringify({ state: "offline", last_seen_at: lease.last_seen_at }), botId);
			this.#emitBot(botId);
		});
	}
	setWorker(botId: string, state: "online" | "offline" | "unknown"): void {
		this.#atomic(() => {
			const previous = JSON.parse(this.#bot(botId).worker) as BotProjection["worker"];
			if (previous.state === state) return;
			this.#db
				.query("UPDATE bots SET worker=? WHERE bot_id=?")
				.run(JSON.stringify({ state, last_seen_at: state === "online" ? now() : previous.last_seen_at }), botId);
			this.#emitBot(botId);
		});
	}
}

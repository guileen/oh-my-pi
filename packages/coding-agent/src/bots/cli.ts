import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import { Args, type CommandMetadata, Flags } from "@oh-my-pi/pi-utils/cli";
import { botHelp as commandHelp } from "../cli/command-help";
import type { BotService as BotServiceType } from "./service";
import type * as BotServiceModule from "./service";
import type * as BotStoreModule from "./store";
import { BotError, type BotCommand, type BotDefinition, type Cursor, type GraphContext } from "./types";

export const botHelp = {
	...commandHelp,
	args: {
		bot: Args.string({ description: "Bot name, create, or list", required: false }),
		action: Args.string({
			description:
				"submit/send/status/watch/messages/events/inspect/request/interrupt/resume/compact/set-model/stop",
			required: false,
		}),
		parameters: Args.string({
			description: "Action-specific NAME, JOB, TEXT, REF, REQUEST_ID, or MODEL",
			multiple: true,
		}),
	},
	flags: {
		json: Flags.boolean({ description: "Emit one JSON object, or JSONL for watch" }),
		"system-prompt": Flags.string({ description: "Read the creation system prompt from FILE" }),
		tools: Flags.string({ description: "Comma-separated explicit tool capabilities (default: none)" }),
		"skills-dir": Flags.string({ description: "Snapshot explicitly configured skills directory", multiple: true }),
		cwd: Flags.string({ description: "Absolute or relative working directory (create/submit)" }),
		model: Flags.string({ description: "Creation model as provider/model (default: resolve when executing)" }),
		context: Flags.string({ description: "Read exact Graph placement JSON from FILE (submit)" }),
		"request-key": Flags.string({ description: "Idempotency key for submission, send, or control" }),
		"if-revision": Flags.string({ description: "Reject controls unless the Job revision matches" }),
		"expect-bot-id": Flags.string({
			description: "Reject a named operation unless its immutable Bot identity matches",
		}),
		job: Flags.string({ description: "Restrict inspected reference ownership to this Job" }),
		"reply-to": Flags.string({ description: "Resolve the exact runtime input request (send)" }),
		steer: Flags.boolean({ description: "Deliver send at a safe current-execution boundary" }),
		since: Flags.string({ description: "Replay watch after a JSON or base64url cursor" }),
		after: Flags.string({ description: "Read events after a JSON or base64url cursor" }),
		"page-token": Flags.string({ description: "Opaque next-page token for detail or snapshot reads" }),
		limit: Flags.integer({ description: "Positive page size for status/messages/events" }),
		mode: Flags.string({ description: "Compaction mode", options: ["qaonly"] }),
		all: Flags.boolean({ description: "Explicitly stop every Job of the named Bot" }),
	},
	examples: [
		"omp bot create reviewer --system-prompt ./reviewer.md --tools read,grep --skills-dir ./skills/review",
		'omp bot reviewer submit "Review cancellation" --request-key review-1 --context ./placement.json --json',
		"printf '%s' 'Review cancellation' | omp bot reviewer submit --json",
		"omp bot list --json",
		"omp bot reviewer status [JOB] --json",
		"omp bot reviewer watch [JOB] --since '<cursor>' --json",
		"omp bot reviewer messages JOB --limit 50 --page-token TOKEN --json",
		"omp bot reviewer events JOB --after '<cursor>' --limit 50 --json",
		"omp bot reviewer inspect REF --job JOB --expect-bot-id BOT_ID --json",
		"omp bot reviewer request REQUEST_ID --json",
		'omp bot reviewer send JOB "Check cleanup" --reply-to INPUT_REQUEST_ID --json',
		'omp bot reviewer send JOB "Do not modify files" --steer --json',
		"omp bot reviewer interrupt JOB --if-revision REV --json",
		"omp bot reviewer resume JOB --json",
		"omp bot reviewer compact JOB --mode qaonly --json",
		"omp bot reviewer set-model JOB provider/model --json",
		"omp bot reviewer stop JOB --json",
		"omp bot reviewer stop --all --json",
	],
} satisfies CommandMetadata;

const MUTATION_FLAGS = ["request-key", "if-revision"];
const IDENTITY_FLAGS = ["expect-bot-id"];
const COMMAND_FLAGS: Record<string, readonly string[]> = {
	create: ["system-prompt", "tools", "skills-dir", "cwd", "model"],
	list: [],
	submit: [...IDENTITY_FLAGS, "context", "cwd", "request-key"],
	send: [...IDENTITY_FLAGS, ...MUTATION_FLAGS, "reply-to", "steer"],
	status: [...IDENTITY_FLAGS, "page-token", "limit"],
	watch: [...IDENTITY_FLAGS, "since"],
	messages: [...IDENTITY_FLAGS, "page-token", "limit"],
	events: [...IDENTITY_FLAGS, "after", "page-token", "limit"],
	inspect: [...IDENTITY_FLAGS, "page-token", "job"],
	request: IDENTITY_FLAGS,
	interrupt: [...IDENTITY_FLAGS, ...MUTATION_FLAGS],
	resume: [...IDENTITY_FLAGS, ...MUTATION_FLAGS],
	compact: [...IDENTITY_FLAGS, ...MUTATION_FLAGS, "mode"],
	"set-model": [...IDENTITY_FLAGS, ...MUTATION_FLAGS],
	stop: [...IDENTITY_FLAGS, ...MUTATION_FLAGS, "all"],
};

interface ParsedCommand {
	action: string;
	name: string;
	args: string[];
	flags: Map<string, string[]>;
	json: boolean;
}

function invalid(message: string): never {
	throw new BotError("invalid_input", message);
}

function parse(argv: readonly string[]): ParsedCommand {
	const positional: string[] = [];
	const flags = new Map<string, string[]>();
	let literal = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (literal || !token.startsWith("-")) {
			positional.push(token);
			continue;
		}
		if (token === "--") {
			literal = true;
			continue;
		}
		if (!token.startsWith("--")) invalid(`Unknown flag: ${token}`);
		const equals = token.indexOf("=");
		const name = token.slice(2, equals < 0 ? undefined : equals);
		if (!Object.hasOwn(botHelp.flags, name)) invalid(`Unknown flag: --${name}`);
		if (flags.has(name) && name !== "skills-dir") invalid(`Flag --${name} may only be supplied once`);
		let value = "true";
		if (botHelp.flags[name as keyof typeof botHelp.flags].kind === "boolean") {
			if (equals >= 0) invalid(`Flag --${name} does not take a value`);
		} else {
			if (equals >= 0) value = token.slice(equals + 1);
			else {
				if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) invalid(`Flag --${name} requires a value`);
				value = argv[++i];
			}
			if (!value.trim()) invalid(`Flag --${name} requires a nonempty value`);
		}
		flags.set(name, [...(flags.get(name) ?? []), value]);
	}
	let action: string;
	let name: string;
	let args: string[];
	if (positional[0] === "create" || positional[0] === "list") {
		action = positional[0];
		name = positional[1] ?? "";
		args = positional.slice(1);
	} else {
		[name = "", action = ""] = positional;
		args = positional.slice(2);
		if (action === "create" || action === "list")
			invalid("create and list are top-level Bot commands, not named-Bot actions");
	}
	if (!action || !Object.hasOwn(COMMAND_FLAGS, action))
		invalid("Expected bot create NAME, bot list, or bot NAME SUBCOMMAND; use omp bot --help");
	if (action !== "list" && !name.trim()) invalid("A nonempty Bot name is required");
	if (action === "create" && (name === "create" || name === "list"))
		invalid("Bot names create and list are reserved CLI commands");
	for (const flag of flags.keys()) {
		if (flag !== "json" && !COMMAND_FLAGS[action].includes(flag))
			invalid(`Flag --${flag} is not supported by ${action}`);
	}
	const expected = action === "list" ? 0 : action === "set-model" ? 2 : 1;
	const optional =
		action === "submit" || action === "status" || action === "watch" || (action === "stop" && flags.has("all"));
	if (action === "send") {
		if (args.length < 1 || args.length > 2 || !args[0].trim())
			invalid("send requires JOB and optional TEXT (or stdin)");
	} else if (args.length > expected || (!optional && args.length !== expected)) {
		invalid(
			`${action} ${expected === 0 ? "takes no positional arguments" : `requires ${action === "create" ? "NAME" : action === "set-model" ? "JOB MODEL" : action === "inspect" ? "REF" : action === "request" ? "REQUEST_ID" : "JOB"}`}`,
		);
	}
	if (args.some(arg => !arg.trim())) invalid("Positional arguments must not be empty");
	if (action === "stop" && flags.has("all") && args.length) invalid("stop --all cannot also select a Job");
	if (flags.has("all") && flags.has("if-revision")) invalid("--if-revision requires one explicit Job, not --all");
	if (flags.has("if-revision") && !/^\d+$/.test(flags.get("if-revision")![0]))
		invalid("--if-revision must be a decimal revision string");
	if (flags.has("limit") && !/^[1-9]\d*$/.test(flags.get("limit")![0])) invalid("--limit must be a positive integer");
	if (flags.has("limit") && !Number.isSafeInteger(Number(flags.get("limit")![0])))
		invalid("--limit exceeds the safe integer range");
	if (flags.has("mode") && flags.get("mode")![0] !== "qaonly") invalid("--mode must be qaonly");
	return { action, name, args, flags, json: flags.has("json") };
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cursor(text: string): Cursor {
	let value: unknown;
	try {
		if (text.trim().startsWith("{")) value = JSON.parse(text);
		else {
			if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) throw new Error("encoding");
			value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
		}
	} catch {
		throw new BotError("invalid_cursor", "Cursor must be a JSON object or base64url-encoded JSON object");
	}
	if (
		!object(value) ||
		Object.keys(value).some(key => key !== "journal_id" && key !== "seq") ||
		typeof value.journal_id !== "string" ||
		!value.journal_id.trim() ||
		typeof value.seq !== "string" ||
		!/^\d+$/.test(value.seq)
	) {
		throw new BotError("invalid_cursor", "Cursor requires journal_id and a decimal-string seq");
	}
	return { journal_id: value.journal_id, seq: value.seq };
}

async function file(filePath: string, label: string): Promise<string> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		throw new BotError(
			(error as NodeJS.ErrnoException).code === "EACCES" ? "permission_denied" : "invalid_input",
			`Cannot read ${label} file`,
		);
	}
}

function safe(value: unknown): string {
	return sanitizeText(String(value ?? "—")).replace(/[\t\n\u202a-\u202e\u2066-\u2069]/g, " ");
}

/** Definition summaries never expose raw prompts or complete capability paths. */
function definitionSummary(bot: BotDefinition) {
	const { bot_id, bot_name, config_revision, created_at } = bot;
	return { bot_id, bot_name, config_revision, created_at };
}

function plain(value: unknown): string {
	if (!object(value)) return `${safe(value)}\n`;
	if (value.kind === "bot" && object(value.bot))
		return `Created Bot ${safe(value.bot.bot_name)} (${safe(value.bot.bot_id)})\n`;
	if (value.kind === "bots" && Array.isArray(value.bots))
		return value.bots.length
			? value.bots
					.map(bot =>
						object(bot) ? `${safe(bot.bot_name)}\t${safe(bot.bot_id)}\t${safe(bot.config_revision)}\n` : "",
					)
					.join("")
			: "No Bots defined.\n";
	if (value.kind === "receipt")
		return `Accepted ${safe(value.request_id)}${value.job_id ? ` for Job ${safe(value.job_id)}` : " (Bot-wide)"}\n`;
	if (value.kind === "snapshot" && object(value.bot) && Array.isArray(value.jobs)) {
		let text = `Bot ${safe(value.bot.bot_name)} (${safe(value.bot.bot_id)}) · worker ${object(value.bot.worker) ? safe(value.bot.worker.state) : "unknown"} · ${safe(value.bot.jobs_total)} Jobs\n`;
		for (const job of value.jobs)
			if (object(job))
				text += `${safe(job.job_id)}\t${safe(job.state)}/${safe(job.phase)}\trev ${safe(job.revision)}\t${safe(job.goal_preview)}\n`;
		if (!value.jobs.length) text += "No Jobs in this scope.\n";
		if (value.next_page_token) text += `Next page: ${safe(value.next_page_token)}\n`;
		return text;
	}
	if (value.kind === "event")
		return `${safe(value.occurred_at)} ${safe(value.type)}${value.job_id ? ` ${safe(value.job_id)}` : ""}\n`;
	if (value.kind === "heartbeat") return `Heartbeat · cursor ${object(value.cursor) ? safe(value.cursor.seq) : "—"}\n`;
	if (value.kind === "request") {
		let text = `Request ${object(value.receipt) ? safe(value.receipt.request_id) : "—"}: ${safe(value.outcome)}${object(value.error) ? ` · ${safe(value.error.code)}: ${safe(value.error.message)}` : ""}\n`;
		if (Array.isArray(value.children)) {
			for (const child of value.children)
				if (object(child)) {
					text += `  Job ${object(child.receipt) ? safe(child.receipt.job_id) : "—"}: ${safe(child.outcome)}${object(child.error) ? ` · ${safe(child.error.code)}: ${safe(child.error.message)}` : ""}\n`;
				}
		}
		return text;
	}
	// JSON escaping keeps untrusted detail and multiline messages terminal-safe.
	return `${JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

export interface BotCliOptions {
	/** Test isolation only; production uses the bootstrapped profile root. */
	root?: string;
	cwd?: string;
	stdin?: () => Promise<string>;
	stdout?: (text: string) => void | Promise<void>;
	stderr?: (text: string) => void | Promise<void>;
	signal?: AbortSignal;
}

async function writeStdout(text: string, signal: AbortSignal): Promise<void> {
	if (process.stdout.write(text)) return;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const done = () => {
		cleanup();
		resolve();
	};
	const error = (cause: Error) => {
		cleanup();
		reject(cause);
	};
	const cleanup = () => {
		process.stdout.off("drain", done);
		process.stdout.off("error", error);
		signal.removeEventListener("abort", done);
	};
	process.stdout.once("drain", done);
	process.stdout.once("error", error);
	signal.addEventListener("abort", done, { once: true });
	if (signal.aborted) done();
	await promise;
}

/** Real CLI seam: parse, validate, and call the durable service; no model loads for reads or creation. */
export async function runBotCommand(argv: readonly string[], options: BotCliOptions = {}): Promise<number> {
	const controller = new AbortController();
	const stdout = options.stdout ?? ((text: string) => writeStdout(text, controller.signal));
	const stderr =
		options.stderr ??
		((text: string) => {
			process.stderr.write(text);
		});
	let json = false;
	for (const token of argv) {
		if (token === "--") break;
		if (token === "--json" || token.startsWith("--json=")) json = true;
	}
	let service: BotServiceType | undefined;
	const abort = () => controller.abort();
	let watching = false;
	try {
		const parsed = parse(argv);
		json = parsed.json;
		const { action, name, args, flags } = parsed;
		const flag = (key: string) => flags.get(key)?.[0];
		const cwd = options.cwd ?? process.cwd();
		const guard = { expect_bot_id: flag("expect-bot-id") };
		const page = {
			...guard,
			page_token: flag("page-token"),
			limit: flag("limit") ? Number(flag("limit")) : undefined,
		};
		const after = flag("after") ? cursor(flag("after")!) : undefined;
		const since = flag("since") ? cursor(flag("since")!) : undefined;
		let input: string | undefined;
		if (action === "submit" || action === "send") {
			const positional = action === "submit" ? args[0] : args[1];
			const stdin = options.stdin ? await options.stdin() : process.stdin.isTTY ? "" : await Bun.stdin.text();
			if (positional !== undefined && stdin.trim()) invalid("Provide input as positional TEXT or stdin, not both");
			input = positional ?? stdin;
			if (!input.trim()) invalid(`${action} requires nonempty TEXT or stdin`);
		}
		let context: GraphContext | null = null;
		if (flag("context")) {
			const text = await file(path.resolve(cwd, flag("context")!), "Graph context");
			let value: unknown;
			try {
				value = JSON.parse(text);
			} catch {
				invalid("Graph context file must contain valid JSON");
			}
			if (!object(value)) invalid("Graph context file must contain a JSON object");
			// Keep SQLite out of command metadata/help/completion loading.
			const storeModule: typeof BotStoreModule = require("./store");
			context = storeModule.validateGraphContext(value);
		}
		const systemPrompt = flag("system-prompt")
			? await file(path.resolve(cwd, flag("system-prompt")!), "system prompt")
			: "";
		const tools = flag("tools")
			? flag("tools")!
					.split(",")
					.map(tool => tool.trim())
			: [];
		if (tools.some(tool => !tool)) invalid("--tools requires comma-separated nonempty tool names");
		// Command metadata is loaded by native-free completions; SQLite is needed only when executing.
		const serviceModule: typeof BotServiceModule = require("./service");
		service = new serviceModule.BotService(options.root);
		let result: unknown;
		if (action === "create") {
			const bot = await service.create({
				bot_name: name,
				cwd: path.resolve(cwd, flag("cwd") ?? "."),
				system_prompt: systemPrompt,
				tools,
				skills_dirs: (flags.get("skills-dir") ?? []).map(dir => path.resolve(cwd, dir)),
				model: flag("model") ?? null,
			});
			result = { schema_version: 1, kind: "bot", bot: definitionSummary(bot) };
		} else if (action === "list") {
			result = { schema_version: 1, kind: "bots", bots: service.list().map(definitionSummary) };
		} else if (action === "status") {
			result = service.status(name, args[0], page);
		} else if (action === "request") {
			result = service.request(name, args[0], guard);
		} else if (action === "messages") {
			result = service.messages(name, args[0], page);
		} else if (action === "events") {
			result = service.events(name, { ...page, after, job_id: args[0] });
		} else if (action === "inspect") {
			result = service.inspect(name, args[0], { ...guard, page_token: flag("page-token"), job_id: flag("job") });
		} else if (action === "watch") {
			watching = true;
			process.once("SIGINT", abort);
			process.once("SIGTERM", abort);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			for await (const frame of service.watch(name, {
				...guard,
				job_id: args[0],
				since,
				signal: controller.signal,
			})) {
				await stdout(json ? `${JSON.stringify(frame)}\n` : plain(frame));
				if (controller.signal.aborted) break;
			}
			return 0;
		} else {
			const command: BotCommand = {
				command: action === "send" && flags.has("steer") ? "steer" : (action as BotCommand["command"]),
			};
			if (action !== "submit" && args[0]) command.job_id = args[0];
			if (input !== undefined) command.input = input;
			if (action === "submit") {
				command.graph_context = context;
				if (flag("cwd")) command.cwd = path.resolve(cwd, flag("cwd")!);
			}
			if (flag("request-key")) command.key = flag("request-key");
			if (flag("if-revision")) command.if_revision = flag("if-revision");
			if (flag("reply-to")) command.reply_to = flag("reply-to");
			if (action === "set-model") command.model = args[1];
			if (flag("mode")) command.mode = "qaonly";
			if (flags.has("all")) command.all = true;
			result = await service.submit(name, command, guard);
		}
		await stdout(json ? `${JSON.stringify(result)}\n` : plain(result));
		return 0;
	} catch (error) {
		if (watching && controller.signal.aborted && error instanceof Error && error.name === "AbortError") return 0;
		if (watching && (error as NodeJS.ErrnoException)?.code === "EPIPE") return 0;
		const botError =
			error instanceof BotError ? error : new BotError("internal_error", "Bot command failed unexpectedly");
		if (json) await stdout(`${JSON.stringify(botError.toJSON())}\n`);
		else await stderr(`error [${safe(botError.code)}]: ${safe(botError.message)}\n`);
		return 1;
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
		options.signal?.removeEventListener("abort", abort);
		await service?.close();
	}
}

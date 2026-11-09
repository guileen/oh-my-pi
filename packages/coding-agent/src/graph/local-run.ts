import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import { getAgentDir, stableStringifyJson } from "@oh-my-pi/pi-utils";
import { parseStrictFrontmatter } from "@oh-my-pi/pi-utils/strict-frontmatter";
import { readBoundedUtf8 } from "@oh-my-pi/pi-utils/stream";
import { BotStore } from "../bots/store";
import type { BotDefinition, BotJob } from "../bots/types";
import type { BotRuntime, BotRuntimeEvent } from "../bots/agent-runtime";
import { loadCapability } from "../capability";
import { ruleCapability, type Rule } from "../capability/rule";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import {
	createAgentSession,
	discoverAuthStorage,
	discoverContextFiles,
	type CreateAgentSessionOptions,
	type Skill,
} from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import type { ArtifactPublication, GraphArtifact } from "./artifacts";
import { reportAddressProblem } from "./address";
import { graphInputContract } from "./catalog";
import type { GraphDefinition } from "./contracts";
import { validateGraphForStart } from "./definition";
import {
	createGraphBotRuntime,
	createGraphBotTools,
	prepareGraphBot,
	type GraphBotModelBinding,
	type PreparedGraphBot,
} from "./executors/bot";
import { TrustedProgramExecutor } from "./executors/program";
import { ForegroundPause } from "./foreground-pause";
import { GraphHost } from "./host";
import { assertLocalRunSupported } from "./local-support";
import { formatNodeProgressLine, projectNodeProgress } from "./observation";
import { assertGrantedToolCall, EXECUTE_GRANTS, grantedToolNames, HARNESS_TOOLS } from "./workspace-grants";
import { GraphRunStore, type GraphPreparedRun, type GraphRunRecord, type GraphDispatchIntent } from "./store";
import publicationDescription from "./local-publish.md" with { type: "text" };
import executionInstructions from "./local-run-prompt.md" with { type: "text" };
import workspaceInstructions from "./local-code-prompt.md" with { type: "text" };

const LIMITS = { maxBytes: 1024 * 1024, maxDepth: 64, maxAliases: 100, maxNodes: 10000 };
/** Ask-only consultants receive one bounded question and return one bounded answer. */
const CONSULT_LIMITS = { maxInputBytes: 64 * 1024, maxOutputBytes: 32 * 1024 };
const PRINCIPAL = "local-foreground-cli";
const TOOL_NAMES = ["graph_publish", "graph_complete"];
/** A member that may touch the workspace needs different instructions than a text-only one. */
const hasWorkspaceGrants = (member: GraphDefinition["members"][string]): boolean =>
	member.permissions.read.length + member.permissions.write.length + member.permissions.execute.length > 0;
/** Graph capability tools are always present; workspace tools follow the member's grants. */
const memberToolNames = (member: GraphDefinition["members"][string]): string[] => [
	...TOOL_NAMES,
	...grantedToolNames(member.permissions),
	...(hasWorkspaceGrants(member) ? [...HARNESS_TOOLS] : []),
];
/** Text-only members must ignore the frozen harness prompt; granted members must use it. */
const instructionsFor = (member: GraphDefinition["members"][string]): string =>
	hasWorkspaceGrants(member) ? workspaceInstructions : executionInstructions;
const publishSchema = type({ output: "string", content: "string" });
const publicationTool = {
	name: "graph_publish",
	label: "Publish Graph Text",
	description: publicationDescription,
	parameters: publishSchema,
	approval: "read",
	loadMode: "essential",
} as const;
const SAFE_SETTINGS = {
	// A foreground Run has no terminal to answer an approval prompt, and the member's grants are the
	// real boundary: every tool call is checked against them before execution. Prompting would park a
	// coding Run forever, so approval is satisfied up front and grants decide what may run.
	"tools.approvalMode": "yolo",
	"advisor.enabled": false,
	"autolearn.enabled": false,
	"autolearn.autoContinue": false,
	"memory.backend": "off",
	"compaction.enabled": false,
	"compaction.midTurnEnabled": false,
	"compaction.asyncEnabled": false,
	"compaction.idleEnabled": false,
	"compaction.autoContinue": false,
	"prewalk.enabled": false,
	"prewalk.auto": "off",
	"ttsr.judge": "off",
	"async.widgets": false,
	"images.describeForTextModels": false,
	"speech.enabled": false,
	"retry.enabled": false,
	"ask.notify": "off",
	"ask.timeout": 0,
	"tools.speculativeExecution.enabled": false,
	"todo.reminders": false,
	"power.sleepPrevention": "off",
} as const;

class LocalRunError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "LocalRunError";
	}
}

function digest(text: string): string {
	return `sha256:${Bun.SHA256.hash(text, "hex")}`;
}
function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...names].sort().join("\0");
}
function required(condition: unknown, message: string, code = "invalid_input"): asserts condition {
	if (!condition) throw new LocalRunError(code, message);
}

/**
 * Local foreground execution is single-host: one process owns the profile while a Run executes.
 * A second dispatch waits for that host instead of failing, so queued dispatches are not dropped.
 */
async function acquireHost(
	store: GraphRunStore,
	timeoutMs: number,
	signal: AbortSignal,
	onWait?: () => void,
): Promise<{ owner_id: string; epoch: string } | null> {
	const deadline = Date.now() + timeoutMs;
	let announced = false;
	for (;;) {
		let owner: { owner_id: string; epoch: string } | null = null;
		try {
			owner = store.claimHost();
		} catch (error) {
			// A concurrent writer can hold the profile database; that is contention, not a failure.
			if (!/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(error))) throw error;
		}
		if (owner) return owner;
		if (!announced) {
			announced = true;
			onWait?.();
		}
		if (signal.aborted) throw signal.reason;
		if (Date.now() >= deadline) return null;
		await Bun.sleep(250);
	}
}

function argumentsFor(argv: readonly string[]): {
	graphId: string;
	bindings: string;
	calls: number;
	timeout: number;
	key: string;
	inputs: Map<string, string>;
	title: string | undefined;
	reportTo: string | undefined;
	waitForHost: number;
	acceptanceCheck: string | undefined;
	acceptWorkspaceCode: boolean;
	acceptWorkspaceWrite: boolean;
	json: boolean;
} {
	const flags = new Map<string, string>();
	const inputs = new Map<string, string>();
	let acceptWorkspaceCode = false;
	let acceptWorkspaceWrite = false;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const equal = token.indexOf("=");
		const name = token.slice(2, equal < 0 ? undefined : equal);
		if (name === "accept-workspace-code") {
			required(equal < 0 && !acceptWorkspaceCode, "--accept-workspace-code is a single explicit flag");
			acceptWorkspaceCode = true;
			continue;
		}
		if (name === "accept-workspace-write") {
			required(equal < 0 && !acceptWorkspaceWrite, "--accept-workspace-write is a single explicit flag");
			acceptWorkspaceWrite = true;
			continue;
		}
		required(
			[
				"bindings",
				"max-model-calls",
				"timeout-ms",
				"request-key",
				"input",
				"title",
				"report-to",
				"wait-for-host",
				"acceptance-check",
				"format",
			].includes(name),
			`Unsupported graph run flag: --${name}`,
		);
		const value = equal < 0 ? argv[++i] : token.slice(equal + 1);
		required(value && !value.startsWith("--"), `--${name} requires a value`);
		if (name === "input") {
			const split = value.indexOf("=");
			required(split > 0, "--input requires NAME=FILE");
			const inputName = value.slice(0, split);
			const file = value.slice(split + 1);
			required(/^[A-Za-z][A-Za-z0-9_-]*$/.test(inputName), "--input NAME must be a Graph key");
			required(!inputs.has(inputName), `Duplicate --input ${inputName}`);
			required(file && file !== "-", "--input FILE must be a readable path; stdin is unsupported");
			inputs.set(inputName, file);
			continue;
		}
		required(!flags.has(name), `Duplicate --${name}`);
		flags.set(name, value);
	}
	required(
		positional.length === 1,
		"Usage: omp graph dispatch GRAPH_ID --bindings FILE --max-model-calls N --timeout-ms N --request-key KEY [--input NAME=FILE] [--title T] [--report-to ADDR] [--format json]",
	);
	const positive = (name: string, max: number): number => {
		const value = flags.get(name);
		required(value && /^[1-9]\d*$/.test(value), `--${name} is required and must be a positive integer`);
		const number = Number(value);
		required(Number.isSafeInteger(number) && number <= max, `--${name} must not exceed ${max}`);
		return number;
	};
	const bindings = flags.get("bindings");
	const key = flags.get("request-key");
	required(bindings && bindings !== "-", "--bindings FILE is required; stdin is unsupported");
	required(
		key && key.trim() === key && key.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(key),
		"--request-key KEY is required (1..512 printable characters)",
	);
	const label = (name: "title" | "report-to"): string | undefined => {
		const value = flags.get(name);
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		required(
			trimmed.length > 0 && trimmed.length <= 200 && !/[\u0000-\u001f\u007f]/.test(trimmed),
			`--${name} must be a single-line label of at most 200 characters`,
		);
		if (name === "report-to") {
			const problem = reportAddressProblem(trimmed);
			required(problem === null, `--report-to ${problem}`);
		}
		return trimmed;
	};
	const format = flags.get("format");
	required(format === undefined || format === "json", "--format accepts only json");
	return {
		graphId: positional[0],
		bindings,
		calls: positive("max-model-calls", 64),
		timeout: positive("timeout-ms", 600000),
		key,
		inputs,
		title: label("title"),
		reportTo: label("report-to"),
		// A second dispatch queues behind the live local host instead of failing.
		waitForHost: flags.has("wait-for-host") ? positive("wait-for-host", 3_600_000) : 900_000,
		acceptanceCheck: flags.get("acceptance-check"),
		acceptWorkspaceCode,
		acceptWorkspaceWrite,
		json: format === "json",
	};
}

function modelBindings(content: string): GraphBotModelBinding[] {
	let frontmatter: unknown;
	try {
		frontmatter = parseStrictFrontmatter(content, LIMITS).frontmatter;
	} catch (error) {
		throw new LocalRunError(
			"invalid_input",
			`Invalid bindings frontmatter: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	required(
		object(frontmatter) && exact(frontmatter, ["models"]) && object(frontmatter.models),
		"Bindings require Markdown frontmatter containing only models: {binding: {provider, model}}",
	);
	return Object.entries(frontmatter.models)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([name, raw]) => {
			required(object(raw) && exact(raw, ["provider", "model"]), `Invalid model binding: ${name}`);
			required(
				typeof raw.provider === "string" &&
					raw.provider.trim() === raw.provider &&
					raw.provider &&
					typeof raw.model === "string" &&
					raw.model.trim() === raw.model &&
					raw.model,
				`Binding ${name} requires exact provider and model identities`,
			);
			return { name, provider: raw.provider, model: raw.model, revision: digest(canonicalJson(raw)) };
		});
}

/** Admission is deliberately narrower than the general Graph schema. Graph prose grants no tools. */
function supported(definition: GraphDefinition, availableInputs: ReadonlySet<string> | null = null): void {
	try {
		assertLocalRunSupported(definition, availableInputs);
	} catch (error) {
		throw new LocalRunError("capability_unavailable", error instanceof Error ? error.message : String(error));
	}
}

export { localRunSupport } from "./local-support";

function safeSessionOptions(settings: Settings, toolNames: readonly string[] = TOOL_NAMES): CreateAgentSessionOptions {
	return {
		settings,
		disableExtensionDiscovery: true,
		extensions: [],
		additionalExtensionPaths: [],
		preloadedExtensionPaths: [],
		preloadedPreparedExtensions: [],
		disableAuxiliaryInference: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		skipPythonPreflight: true,
		suppressAutoPrewalk: true,
		promptTemplates: [],
		slashCommands: [],
		toolNames: [...toolNames],
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		requireYieldTool: false,
		requireExactToolArguments: true,
		cacheWarming: false,
		autoTitle: false,
		bindProcessState: false,
		settingsApproval: false,
		interactivePrompts: false,
		hasUI: false,
		allowSessionModelFallback: false,
		disableModelFallback: true,
		disableServerSideFallback: true,
	};
}

/** Only the Bot identity/config and Graph envelope are consumed by GraphBotWorker.admit. */
function jobTemplate(bot: BotDefinition, intent: GraphDispatchIntent, node: string, graphId: string): BotJob {
	const now = new Date().toISOString();
	return {
		job_id: `local-template-${intent.attempt_id}`,
		bot_id: bot.bot_id,
		config_revision: bot.config_revision,
		revision: "1",
		goal_preview: "Local Graph attempt",
		goal_ref: null,
		cwd: bot.config.cwd,
		graph_context: {
			graph_id: graphId,
			graph_run_id: intent.run_id,
			node_id: node,
			invocation_id: intent.invocation_id,
			attempt: 1,
			upstream: [],
		},
		state: "queued",
		phase: "queued",
		settled: false,
		ownership: { state: "none", activation_ref: null },
		execution_id: null,
		pending_input_count: 0,
		pending_background_count: 0,
		pending_delivery_count: 0,
		activity: null,
		wait: null,
		progress: null,
		model: { current: bot.config.model, pending: null },
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
		created_at: now,
		updated_at: now,
		last_activity_at: now,
		elapsed_ms: 0,
		active_ms: 0,
		output_ref: null,
		artifact_ids: [],
		error: null,
		controls: [],
		config: bot.config,
		session_file: null,
		inputs: [],
		input_requests: [],
		owned_services: [],
		session_owner_id: null,
		owner_epoch: null,
		launch_intents: [],
	};
}

function report(store: GraphRunStore, run: GraphRunRecord, out: (text: string) => void, replay: boolean): number {
	out(`Run: ${run.id}${replay ? " (request replay; no model calls launched)" : ""}\nState: ${run.state}\n`);
	if (run.title) out(`Title: ${run.title}\n`);
	if (run.report_to) out(`Report to: ${run.report_to}\n`);
	if (run.reason) out(`Reason: ${run.reason}\n`);
	const snapshot = store.getSnapshot(run.snapshot_ref);
	for (const [name, binding] of Object.entries(snapshot?.members ?? {}))
		out(`Model ${name}: ${binding.provider}/${binding.model} (${binding.configuration_revision})\n`);
	for (const invocation of store.getScheduleState(run.id)?.invocations ?? []) {
		out(
			`Node ${invocation.node}: ${invocation.state}${invocation.attempt_id ? ` (attempt ${invocation.attempt_id})` : ""}\n`,
		);
		for (const [name, ref] of Object.entries(invocation.outputs ?? {}))
			out(
				`Artifact ${invocation.node}.${name}: ${ref.id}@${ref.digest}\n  ${path.join(store.definitions.root, "artifacts", ref.id)}\n`,
			);
	}
	const usage = run.observed_bot_usage;
	out(
		`Observed usage: input=${usage?.input_tokens ?? "unknown"} output=${usage?.output_tokens ?? "unknown"} cache-read=${usage?.cache_read_tokens ?? "unknown"} cache-write=${usage?.cache_write_tokens ?? "unknown"} cost-usd=${usage?.cost_usd ?? "unknown"} completeness=${usage?.completeness ?? "unknown"}\n`,
	);
	if (replay && !["succeeded", "failed", "cancelled"].includes(run.state))
		out("Prior foreground execution is unfinished/unknown; it is not automatically resumed.\n");
	return runExitCode(run);
}

/** One exit-code contract for text and JSON spokes; a Run that is neither finished nor failed is 4. */
function runExitCode(run: GraphRunRecord): number {
	return run.state === "succeeded" ? 0 : ["failed", "cancelled"].includes(run.state) ? 3 : 4;
}

const MAX_RESULT_JSON_BYTES = 4 * 1024 * 1024;

/**
 * Machine-readable result for headless callers (MCP adapters, CI). It reports what the Run
 * committed — nodes, artifact refs, usage — and never invents a business outcome: `state` is the
 * Run state, while whether the deliverable is ready stays a separate observation.
 */
function emitRunJson(
	store: GraphRunStore,
	run: GraphRunRecord,
	out: (text: string) => void,
	replay: boolean,
	modelCallsStarted?: number,
): void {
	const invocations = store.getScheduleState(run.id)?.invocations ?? [];
	const { nodes } = projectNodeProgress({
		invocations,
		activity: store.getInvocationActivity(run.id),
		runState: run.state,
	});
	const artifacts: { node: string; name: string; id: string; digest: string }[] = [];
	for (const invocation of invocations)
		for (const [name, ref] of Object.entries(invocation.outputs ?? {}))
			artifacts.push({ node: invocation.node, name, id: ref.id, digest: ref.digest });
	const line = `${JSON.stringify({
		schema_version: 1,
		kind: "graph.run",
		run_id: run.id,
		graph_id: run.graph_id,
		...(run.graph_name ? { graph_name: run.graph_name } : {}),
		state: run.state,
		...(run.title ? { title: run.title } : {}),
		...(run.report_to ? { report_to: run.report_to } : {}),
		...(run.reason ? { reason: run.reason } : {}),
		replay,
		...(modelCallsStarted === undefined ? {} : { model_calls_started: modelCallsStarted }),
		nodes,
		artifacts,
		usage: run.observed_bot_usage ?? null,
	})}\n`;
	required(
		Buffer.byteLength(line, "utf8") <= MAX_RESULT_JSON_BYTES,
		"Graph run JSON result exceeds limit",
		"resource_limit",
	);
	out(line);
}

/** Explicit local-user admission, not a daemon, remote service or process sandbox. */
export async function runLocalGraphCommand(
	argv: readonly string[],
	options: { root?: string; out?: (text: string) => void; err?: (text: string) => void } = {},
): Promise<number> {
	const stdout = options.out ?? (text => process.stdout.write(text));
	let out = stdout;
	const err = options.err ?? (text => process.stderr.write(text));
	let json = false;
	let store: GraphRunStore | undefined;
	let bots: BotStore | undefined;
	let host: GraphHost | undefined;
	let authStorage: AuthStorage | undefined;
	let timer: NodeJS.Timeout | undefined;
	let interrupted = false;
	let runId: string | undefined;
	let calls = 0;
	let stopReason: string | undefined;
	const abort = new AbortController();
	const runtimes = new Set<BotRuntime>();
	const stop = (reason: string, code = "budget_exhausted"): void => {
		stopReason ??= reason;
		abort.abort(new LocalRunError(code, reason));
		for (const runtime of runtimes) void runtime.abort().catch(() => {});
	};
	const onInterrupt = (): void => {
		interrupted = true;
		stop("Foreground Graph run interrupted", "interrupted");
	};
	try {
		const args = argumentsFor(argv);
		// JSON callers get exactly one object on stdout; progress and error prose stay off their parser.
		json = args.json;
		if (json) out = () => {};
		process.on("SIGINT", onInterrupt);
		timer = setTimeout(
			() => stop("Local foreground deadline exceeded", "deadline_exceeded"),
			args.timeout + args.waitForHost,
		);
		const bindings = modelBindings(await readBoundedUtf8(Bun.file(args.bindings).stream(), LIMITS.maxBytes));
		const inputContent: Record<string, string> = {};
		for (const [name, file] of [...args.inputs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			try {
				inputContent[name] = await readBoundedUtf8(Bun.file(file).stream(), LIMITS.maxBytes);
			} catch (error) {
				throw new LocalRunError(
					"invalid_input",
					`--input ${name}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		abort.signal.throwIfAborted();
		store = new GraphRunStore(LIMITS, options.root);
		const imported = store.definitions.get(args.graphId);
		required(imported, "Imported Graph does not exist");
		const validated = validateGraphForStart(imported.content, LIMITS);
		required(!validated.issues.length, validated.issues[0]?.message ?? "Graph is invalid");
		const definition = validated.source.frontmatter.frontmatter as unknown as GraphDefinition;
		const needsAcceptance = Object.values(definition.nodes).some(node => node.kind === "program");
		if (needsAcceptance) {
			required(
				args.acceptWorkspaceWrite,
				"Coding members may read and modify the workspace with your OS permissions; pass --accept-workspace-write to approve",
			);
			required(
				args.acceptWorkspaceCode,
				"Workspace checks run code with your OS permissions; pass --accept-workspace-code to approve",
			);
			required(
				args.acceptanceCheck && Object.hasOwn(EXECUTE_GRANTS, args.acceptanceCheck),
				"--acceptance-check must be test, typecheck or check",
			);
		} else {
			required(
				!args.acceptanceCheck && !args.acceptWorkspaceCode && !args.acceptWorkspaceWrite,
				"Acceptance flags require a supported program Graph",
			);
		}
		// The Graph contract, not the caller, decides which inputs exist. An unknown name is a
		// caller mistake: reject it before any bytes are frozen or a Run is recorded.
		const acceptedInputs = new Set(graphInputContract(definition).map(input => input.name));
		for (const name of Object.keys(inputContent))
			required(
				acceptedInputs.has(name),
				`Graph does not accept input: ${name}${acceptedInputs.size ? ` (accepts ${[...acceptedInputs].join(", ")})` : ""}`,
				"definition_invalid",
			);
		const workspaceAccess = Object.values(definition.members).some(hasWorkspaceGrants);
		// A Run that may touch the workspace is a different decision than a read-only text Run, so the
		// grants and their root are part of the frozen authorization. Text-only graphs keep the
		// historical payload exactly, so receipts written before grants existed still replay.
		const authorization = canonicalJson({
			mode: workspaceAccess ? "local-foreground-workspace-grants" : "local-foreground-read-only-text",
			graph_id: args.graphId,
			definition_revision: imported.revision,
			definition_digest: imported.digest,
			max_model_calls: args.calls,
			timeout_ms: args.timeout,
			bindings,
			title: args.title ?? null,
			report_to: args.reportTo ?? null,
			...(needsAcceptance
				? { acceptance_check: args.acceptanceCheck, accept_workspace_code: true, accept_workspace_write: true }
				: {}),
			...(workspaceAccess
				? {
						workspace_root: process.cwd(),
						member_permissions: Object.fromEntries(
							Object.entries(definition.members).map(([name, member]) => [name, member.permissions]),
						),
					}
				: {}),
			input_digests: Object.fromEntries(
				Object.entries(inputContent).map(([name, content]) => [name, digest(content)]),
			),
		});
		// A key already used for another graph or another operation is a caller
		// mistake, not an authorization failure. Name the owner instead of letting
		// the receipt gate answer with a blanket permission denial.
		const keyOwner = store.definitions.requestKeySummary(args.key);
		if (keyOwner && (keyOwner.operation !== "start" || keyOwner.target_id !== args.graphId)) {
			throw new LocalRunError(
				"idempotency_conflict",
				`Request key "${args.key}" already belongs to ${keyOwner.operation} on ${
					keyOwner.target_id ? `graph ${keyOwner.target_id}` : "another target"
				}; choose a new key`,
			);
		}
		const prior = keyOwner
			? store.definitions.requestGetAuthorized(
					args.key,
					request =>
						request.operation === "start" &&
						request.target_id === args.graphId &&
						request.request_key === args.key,
				)
			: null;
		if (prior) {
			required(
				prior.kind === "execution" && prior.receipt.state === "accepted" && prior.receipt.target_id,
				"Request key is already reserved by another operation or rejected start",
			);
			const run = store.getRun(prior.receipt.target_id);
			required(
				run && run.authorization_ref.digest === digest(authorization),
				"Request key conflicts with different local run authorization",
			);
			if (json) {
				emitRunJson(store, run, stdout, true);
				return runExitCode(run);
			}
			return report(store, run, out, true);
		}
		try {
			supported(definition, new Set(Object.keys(inputContent)));
		} catch (error) {
			throw new LocalRunError("capability_unavailable", error instanceof Error ? error.message : String(error));
		}
		// Own the profile before preparing: preparation writes frozen artifacts and Bot definitions to
		// the same database, so a second process must wait rather than race the first one's writer.
		const owner = await acquireHost(store, args.waitForHost, abort.signal, () =>
			out("Waiting for the local Graph host (another Run owns this profile)...\n"),
		);
		required(owner, "Another Graph foreground host owns this profile", "capability_unavailable");
		// The execution budget begins when this process actually owns the host. Held time is not
		// execution time, so the budget is tracked through `pause` rather than a bare timestamp.
		clearTimeout(timer);
		timer = setTimeout(() => stop("Local foreground deadline exceeded", "deadline_exceeded"), args.timeout);
		const pause = new ForegroundPause(Date.now() + args.timeout);
		const cwd = process.cwd();
		const settings = await Settings.loadReadOnly({ cwd, agentDir: getAgentDir(), overrides: SAFE_SETTINGS });
		authStorage = await discoverAuthStorage(getAgentDir(), { cwd, settings });
		const registry = new ModelRegistry(authStorage, undefined, { settings });
		const frozenRules = structuredClone(
			(await loadCapability<Rule>(ruleCapability.id, { cwd, agentDir: getAgentDir() })).items,
		);
		const frozenContext = await discoverContextFiles(cwd, getAgentDir());
		const scope = `local-graph:${args.graphId}:${imported.digest}`;
		const artifacts = store.configureArtifacts({
			maxBytes: LIMITS.maxBytes,
			authorize: async (principal, action, scopes) =>
				principal === PRINCIPAL &&
				["read", "publish"].includes(action) &&
				scopes.length === 1 &&
				scopes[0] === scope,
		});
		const bun = needsAcceptance ? Bun.which("bun") : null;
		if (needsAcceptance) required(bun, "The approved check requires bun on PATH");
		const checkArgv = needsAcceptance ? EXECUTE_GRANTS[args.acceptanceCheck!]! : [];
		const programExecutor = new TrustedProgramExecutor(
			needsAcceptance
				? {
						"daily-code-acceptance": {
							executable: bun!,
							workspaceRoot: cwd,
							workspaceCheck: { cwd, label: args.acceptanceCheck!, failureOutcome: "revise" },
							env: Object.fromEntries(
								["PATH", "HOME", "TMPDIR"].flatMap(key =>
									process.env[key] === undefined ? [] : [[key, process.env[key]!]],
								),
							),
							argv: checkArgv.slice(1).map(literal => ({ literal })),
							outputs: { evidence: { filename: "evidence.txt", media_type: "text/plain" } },
							outcome: "pass",
							timeoutMs: args.timeout,
						},
					}
				: {},
			{
				store: artifacts.store,
				authorize: async request => {
					if (
						!runId ||
						request.run_id !== runId ||
						request.executor !== "daily-code-acceptance" ||
						request.principal !== PRINCIPAL ||
						request.output_scope.length !== 1 ||
						request.output_scope[0] !== scope
					)
						return false;
					const invocation = store!
						.getScheduleState(runId)
						?.invocations.find(item => item.id === request.invocation_id);
					const intent = store!.getDispatchIntents(runId).find(item => item.attempt_id === request.attempt_id);
					return (
						invocation?.node === "acceptance" &&
						invocation.state === "running" &&
						invocation.attempt_id === request.attempt_id &&
						intent?.fence === request.fence &&
						intent.request_key === request.request_key &&
						["submitting", "accepted"].includes(intent.state) &&
						ForegroundPause.dispatchable(store!.getRun(runId)?.state) &&
						!abort.signal.aborted
					);
				},
			},
		);
		const sourceRef = { id: args.graphId, digest: imported.digest };
		const publishFrozen = async (content: string): Promise<GraphRef> => {
			const publication: ArtifactPublication = {
				media_type: "text/plain",
				producer_attempt_id: null,
				source_ref: sourceRef,
				access_scope: [scope],
			};
			const artifact = await artifacts.store.publish(PRINCIPAL, Buffer.from(content), publication);
			await artifacts.register([{ artifact, expected: publication }]);
			return { id: artifact.id, digest: artifact.digest };
		};
		const runInputs: Record<string, GraphRef> = {};
		for (const [name, content] of Object.entries(inputContent)) runInputs[name] = await publishFrozen(content);
		const rulesRef = frozenRules.length ? await publishFrozen(stableStringifyJson(frozenRules)) : undefined;
		const members: GraphPreparedRun["members"] = {};
		const basePrompts = new Map<string, string[]>();
		const frozenSkills = new Map<string, Skill[]>();
		const selected = new Map<string, PreparedGraphBot>();
		// These are real SDK sessions, but are never prompted and cannot dispatch a model request.
		for (const [name, member] of Object.entries(definition.members)) {
			const role = validated.source.sections.get(member.role!.slice(1));
			required(role !== undefined, `Missing frozen role: ${member.role}`);
			const prepared = prepareGraphBot({
				member,
				role,
				task: "",
				bindings,
				modelRegistry: registry,
				baseAvailable: true,
				assertToolCall: () => {
					throw new Error("Preflight cannot invoke tools");
				},
			});
			selected.set(name, prepared);
			abort.signal.throwIfAborted();
			const preflight = await createAgentSession({
				...safeSessionOptions(settings),
				cwd,
				agentDir: getAgentDir(),
				model: prepared.model,
				modelRegistry: registry,
				rules: frozenRules,
				contextFiles: frozenContext,
				sessionManager: SessionManager.inMemory(),
				customTools: [
					{
						...publicationTool,
						execute: async () => {
							throw new Error("Preflight cannot publish text");
						},
					},
					...createGraphBotTools({
						completion: {
							submit: async () => {
								throw new Error("Preflight cannot complete attempts");
							},
						},
					}),
				],
				assertDispatchModel: () => {
					throw new Error("Preflight cannot dispatch models");
				},
			});
			try {
				abort.signal.throwIfAborted();
				const base = [...preflight.session.systemPrompt];
				required(
					base.some(text => text.trim()),
					"omp-default prompt construction returned no prompt",
				);
				basePrompts.set(name, base);
				frozenSkills.set(name, structuredClone([...preflight.session.skills]));
				const baseRef = await publishFrozen(canonicalJson({ base: "omp-default", system_prompt: base }));
				const skillsRef = preflight.session.skills.length
					? await publishFrozen(stableStringifyJson(preflight.session.skills))
					: undefined;
				members[name] = {
					provider: prepared.binding.provider,
					model: prepared.binding.model,
					configuration_revision: prepared.binding.revision,
					base: "omp-default",
					base_snapshot_ref: baseRef,
					role_ref: await publishFrozen(role),
					skill_refs: skillsRef ? [skillsRef] : [],
					rule_refs: rulesRef ? [rulesRef] : [],
				};
			} finally {
				await preflight.session.dispose();
			}
		}
		const authorizationRef = await publishFrozen(authorization);
		const acceptanceTaskRef = needsAcceptance
			? await publishFrozen(validated.source.sections.get(definition.nodes.acceptance.task.slice(1))!)
			: null;
		bots = new BotStore(path.join(store.definitions.root, "local-bots"));
		const botDefinitions = new Map<string, BotDefinition>();
		const observation: NonNullable<GraphPreparedRun["observation"]> = {
			source_id: `local-graph:${digest(store.definitions.root)}`,
			members: {},
		};
		for (const name of Object.keys(definition.members)) {
			const bot = bots.createBot({
				bot_name: `local-${crypto.randomUUID()}`,
				cwd,
				tools: memberToolNames(definition.members[name]!),
				model: `${members[name].provider}/${members[name].model}`,
			});
			botDefinitions.set(name, bot);
			observation.members[name] = {
				bot: {
					source_id: `local-bot:${bots.profile_id}:${bot.bot_id}`,
					profile_id: bots.profile_id,
					bot_id: bot.bot_id,
				},
				config_revision: bot.config_revision,
				model_binding_ref: await publishFrozen(
					canonicalJson({
						binding: selected.get(name)!.binding,
						configuration_digest: digest(stableStringifyJson(selected.get(name)!.model)),
					}),
				),
			};
		}
		const result = store.start(
			{
				version: 1,
				request_key: args.key,
				operation: "start",
				target_id: args.graphId,
				if_revision: imported.revision,
				payload: { inputs: runInputs, authorization_ref: authorizationRef },
			},
			{
				graph_id: args.graphId,
				definition_revision: imported.revision,
				definition_digest: imported.digest,
				authorization_ref: authorizationRef,
				inputs: runInputs,
				members,
				executors: needsAcceptance
					? { "daily-code-acceptance": programExecutor.registrationRef("daily-code-acceptance")! }
					: {},
				observation,
				...(args.title ? { title: args.title } : {}),
				...(args.reportTo ? { report_to: args.reportTo } : {}),
			},
		);
		required(result.state === "accepted" && result.target_id, result.error?.message ?? "Graph start did not commit");
		runId = result.target_id;
		const currentRunId = runId;
		// Lifecycle must be authorized before contending for the host: a committed Run that never gets
		// the host has to be holdable, otherwise it would stay queued forever.
		store.configureLifecycle({
			authorize: (principal, request) =>
				principal === PRINCIPAL &&
				["cancel", "hold"].includes(request.operation) &&
				request.target_id === currentRunId,
			verifyResume: () => false,
		});
		out(`Run: ${runId}\n`);
		const ownedStore = store;
		// Whoever dispatches a Run needs to see it advance, not just its exit code. This
		// process owns the writer, so node transitions are printed from committed schedule
		// state as they land; nothing here is a prediction.
		const printedNodes = new Map<string, string>();
		const printNodeProgress = (): void => {
			const state = ownedStore.getScheduleState(currentRunId);
			if (!state) return;
			// Same projection the CLI and the headless read tool use, so a foreground run and
			// `omp graph status` can never disagree about which node is executing.
			const { nodes } = projectNodeProgress({
				invocations: state.invocations,
				activity: ownedStore.getInvocationActivity(currentRunId),
				order: Object.keys(definition.nodes),
				runState: ownedStore.getRun(currentRunId)?.state ?? "running",
			});
			for (const node of nodes) {
				const marker = `${node.state}${node.current ? "*" : ""}`;
				if (printedNodes.get(node.node) === marker) continue;
				printedNodes.set(node.node, marker);
				out(`${formatNodeProgressLine(node)}  ${new Date().toISOString()}\n`);
			}
		};
		const published = new Map<
			string,
			Map<string, { artifact: GraphArtifact; expected: ArtifactPublication; content: string }>
		>();
		// A hold pauses scheduling; it never turns an attempt that already started into a failure.
		// Work already paid for may settle its attempt, while `assertDispatchable` still forbids
		// beginning a new one until the Run resumes.
		const assertLive = (): void => {
			const state = ownedStore.getRun(currentRunId)?.state;
			// A hold parks the executor without ending it, so held time must not consume the
			// foreground budget: work already in flight stays able to settle its own attempt.
			if (state !== "held" && pause.remaining(Date.now()) <= 0) {
				stop("Local foreground deadline exceeded", "deadline_exceeded");
			}
			if (abort.signal.aborted) throw abort.signal.reason;
			required(ForegroundPause.settlable(state), "Local attempt can no longer settle");
		};
		const assertDispatchable = (): void => {
			assertLive();
			required(
				ForegroundPause.dispatchable(ownedStore.getRun(currentRunId)?.state),
				"Local run is no longer dispatchable",
			);
		};
		const attemptNode = (intent: GraphDispatchIntent) => {
			required(intent.run_id === currentRunId, "Local admission cannot execute another Run");
			const invocation = ownedStore
				.getScheduleState(currentRunId)
				?.invocations.find(item => item.id === intent.invocation_id);
			required(
				invocation?.ready && invocation.attempt_id === intent.attempt_id,
				"Frozen serial invocation is unavailable",
			);
			return { invocation, node: definition.nodes[invocation.node] };
		};
		// Liveness only: recorded activity never completes an attempt or satisfies a dependency.
		const recordRuntimeActivity = (job: BotJob, event: BotRuntimeEvent): void => {
			const context = job.graph_context;
			if (!context) return;
			try {
				if (event.type === "span_start") {
					const label = `${event.kind}: ${event.label}`;
					ownedStore.recordInvocationActivity(context.graph_run_id, context.invocation_id, context.node_id, {
						summary: label.length > 120 ? `${label.slice(0, 119)}…` : label,
						turn: event.kind === "model",
					});
				} else if (event.type === "artifact") {
					ownedStore.recordInvocationActivity(context.graph_run_id, context.invocation_id, context.node_id, {
						summary: `artifact: ${event.name}`.slice(0, 120),
					});
				}
			} catch {
				// A closed store or concurrent cleanup must not fail the attempt for a liveness write.
			}
		};
		host = new GraphHost({
			store: {
				claimHost: ownedStore.claimHost.bind(ownedStore),
				assertHostOwner: ownedStore.assertHostOwner.bind(ownedStore),
				getRun: ownedStore.getRun.bind(ownedStore),
				listHostRuns: () => ownedStore.listHostRuns().filter(run => run.id === currentRunId),
				listHostIntents: () => ownedStore.listHostIntents().filter(intent => intent.run_id === currentRunId),
				claimDispatch: ownedStore.claimDispatch.bind(ownedStore),
				observeDispatch: ownedStore.observeDispatch.bind(ownedStore),
				schedule: ownedStore.schedule.bind(ownedStore),
				completeAttempt: ownedStore.completeAttempt.bind(ownedStore),
				createHumanQuestion: ownedStore.createHumanQuestion.bind(ownedStore),
				getSnapshot: ownedStore.getSnapshot.bind(ownedStore),
				getFrozenDefinition: ownedStore.getFrozenDefinition.bind(ownedStore),
				getScheduleState: ownedStore.getScheduleState.bind(ownedStore),
				getDispatchIntents: ownedStore.getDispatchIntents.bind(ownedStore),
				submitBotCompletion: ownedStore.submitBotCompletion.bind(ownedStore),
				getBotCompletion: ownedStore.getBotCompletion.bind(ownedStore),
				recordBotUsage: ownedStore.recordBotUsage.bind(ownedStore),
				prepareBotHandoff: ownedStore.prepareBotHandoff.bind(ownedStore),
				confirmBotHandoff: ownedStore.confirmBotHandoff.bind(ownedStore),
				confirmBotRecovery: ownedStore.confirmBotRecovery.bind(ownedStore),
			},
			program: programExecutor,
			resolveProgram: async intent => {
				assertDispatchable();
				const { invocation, node } = attemptNode(intent);
				required(
					node.kind === "program" && node.executor === "daily-code-acceptance" && acceptanceTaskRef,
					"Unsupported local program",
				);
				return {
					version: 1,
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
					request_key: intent.request_key,
					executor: node.executor,
					inputs: invocation.ready!.inputs,
					task_ref: acceptanceTaskRef,
					authorization_ref: authorizationRef,
					model_binding_ref: null,
					base_snapshot_ref: null,
					duty: "acceptance",
					deadline: null,
					parameters: {},
					outputs: node.outputs ?? {},
					principal: PRINCIPAL,
					output_scope: [scope],
				};
			},
			verifyProgramResult: async (intent, result) => {
				const { node } = attemptNode(intent);
				required(
					node.kind === "program" && result.attempt_id === intent.attempt_id && result.fence === intent.fence,
					"Program result identity mismatch",
				);
				required(result.state === "succeeded" || result.state === "failed", "Program result is not settled");
				if (result.state === "succeeded")
					required(
						["pass", "revise"].includes(result.outcome ?? "") &&
							Object.keys(result.outputs).length === 1 &&
							result.outputs.evidence?.producer_attempt_id === intent.attempt_id,
						"Invalid acceptance result",
					);
				return {
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
					state: result.state,
					outcome: result.outcome,
					verdict: result.verdict,
					error: result.error,
					outputs: Object.fromEntries(
						Object.entries(result.outputs).map(([name, artifact]) => [
							name,
							{ id: artifact.id, digest: artifact.digest },
						]),
					),
				};
			},
			prepareProgramArtifacts: async (intent, result) =>
				artifacts.prepareRegistration(
					Object.values(result.outputs).map(artifact => ({
						artifact,
						expected: {
							media_type: "text/plain",
							producer_attempt_id: intent.attempt_id,
							source_ref: null,
							access_scope: [scope],
						},
					})),
				),
			bot: {
				store: bots,
				authorize: (_db, identity) =>
					identity.run_id === currentRunId &&
					ownedStore
						.getDispatchIntents(currentRunId)
						.some(
							intent =>
								intent.invocation_id === identity.invocation_id &&
								intent.attempt_id === identity.attempt_id &&
								intent.fence === identity.fence &&
								["submitting", "accepted"].includes(intent.state),
						) &&
					definition.nodes[
						ownedStore
							.getScheduleState(currentRunId)!
							.invocations.find(invocation => invocation.id === identity.invocation_id)!.node
					].member === identity.member_id,
				prepareArtifacts: async (intent, candidate) => {
					const records = published.get(intent.attempt_id);
					const entries = Object.entries(candidate.outputs).map(([name, ref]) => {
						const record = records?.get(name);
						required(
							record &&
								record.artifact.id === ref.id &&
								record.artifact.digest === ref.digest &&
								record.artifact.producer_attempt_id === intent.attempt_id,
							"Completion must reference this attempt's exact published outputs",
						);
						return { artifact: record.artifact, expected: record.expected };
					});
					return artifacts.prepareRegistration(entries);
				},
				resolve: async intent => {
					assertDispatchable();
					const { invocation, node } = attemptNode(intent);
					const memberName = node.member!;
					const member = definition.members[memberName];
					const assertAttempt = (): void => {
						assertLive();
						const current = ownedStore.getDispatchIntents(currentRunId).find(item => item.id === intent.id);
						const active = ownedStore
							.getScheduleState(currentRunId)
							?.invocations.find(item => item.id === intent.invocation_id);
						required(
							current &&
								current.attempt_id === intent.attempt_id &&
								current.fence === intent.fence &&
								["submitting", "accepted"].includes(current.state) &&
								active?.state === "running" &&
								active.attempt_id === intent.attempt_id,
							"Local text capability lost its attempt fence",
						);
					};
					const inputValues: Record<string, { ref?: GraphRef; text: string }> = {};
					for (const [name, input] of Object.entries(invocation.ready!.inputs)) {
						inputValues[name] =
							typeof input === "string"
								? { text: input }
								: {
										ref: input,
										text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
											await artifacts.store.read(PRINCIPAL, input),
										),
									};
					}
					if (member.duty === "consult") {
						const bytes = Object.values(inputValues).reduce(
							(sum, value) => sum + Buffer.byteLength(value.text, "utf8"),
							0,
						);
						required(
							bytes <= CONSULT_LIMITS.maxInputBytes,
							`Consult input exceeds ${CONSULT_LIMITS.maxInputBytes} bytes`,
						);
					}
					const publishTool: CustomTool<typeof publishSchema> = {
						...publicationTool,
						execute: async (_id, request) => {
							assertAttempt();
							required(
								node.outputs && Object.hasOwn(node.outputs, request.output),
								"Unknown generated text output",
							);
							if (member.duty === "consult")
								required(
									Buffer.byteLength(request.content, "utf8") <= CONSULT_LIMITS.maxOutputBytes,
									`Consult answer exceeds ${CONSULT_LIMITS.maxOutputBytes} bytes`,
								);
							const declaration = node.outputs[request.output];
							required(
								typeof request.content === "string" &&
									!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
										request.content,
									),
								"Generated text must be well-formed Unicode",
							);
							let records = published.get(intent.attempt_id);
							if (!records) {
								records = new Map();
								published.set(intent.attempt_id, records);
							}
							let record = records.get(request.output);
							if (record)
								required(record.content === request.content, "An output is immutable after publication");
							else {
								const expected: ArtifactPublication = {
									media_type: declaration.media_type,
									producer_attempt_id: intent.attempt_id,
									source_ref: null,
									access_scope: [scope],
								};
								const artifact = await artifacts.store.publish(
									PRINCIPAL,
									Buffer.from(request.content, "utf8"),
									expected,
								);
								assertAttempt();
								record = { artifact, expected, content: request.content };
								records.set(request.output, record);
							}
							const ref = { id: record.artifact.id, digest: record.artifact.digest };
							return { content: [{ type: "text", text: JSON.stringify(ref) }], details: ref };
						},
					};
					return {
						job: jobTemplate(botDefinitions.get(memberName)!, intent, invocation.node, args.graphId),
						member_id: memberName,
						assignment: {
							member,
							role: validated.source.sections.get(member.role!.slice(1))!,
							task: validated.source.sections.get(node.task.slice(1))!,
							bindings,
							modelRegistry: registry,
							baseAvailable: true,
							customTools: [publishTool],
							assertToolCall: async ({ toolCall, args: toolArgs }) => {
								assertAttempt();
								if (TOOL_NAMES.includes(toolCall.name)) return;
								await assertGrantedToolCall({ toolCall, args: toolArgs }, member.permissions, cwd);
							},
						},
						input: canonicalJson({
							node: invocation.node,
							task: validated.source.sections.get(node.task.slice(1)),
							inputs: inputValues,
							outputs: node.outputs,
							outcomes: node.outcomes ?? ["done"],
							instructions: instructionsFor(member),
						}),
						// The runtime calls this at every tool boundary and before each model turn. A hold
						// parks admission, never settlement: failing this gate killed the in-flight job and
						// the host then recorded `dispatch.unknown` for an attempt that was still alive.
						callbacks: { onEvent: () => {}, assertDispatch: assertLive },
					};
				},
				createRuntime: async (job, callbacks, assignment, runtimeOptions) => {
					const observed: typeof callbacks = {
						...callbacks,
						onEvent: event => {
							callbacks.onEvent(event);
							recordRuntimeActivity(job, event);
						},
					};
					const frozen = selected.get(definition.nodes[job.graph_context!.node_id].member!)!;
					frozen.assertAvailable();
					const { runtime, binding } = await createGraphBotRuntime(job, observed, assignment, {
						...runtimeOptions,
						createSession: async sessionOptions => {
							// Booting an admitted attempt is settlement too: a hold that lands between
							// admission and runtime creation must not fail the job it just accepted.
							assertLive();
							const name = job.graph_context!.node_id;
							const base = basePrompts.get(definition.nodes[name].member!)!;
							const session = await createAgentSession({
								...sessionOptions,
								...safeSessionOptions(settings, job.config.tools),
								rules: frozenRules,
								contextFiles: frozenContext,
								skills: frozenSkills.get(definition.nodes[name].member!),
								systemPrompt: [...base, sessionOptions.appendSystemPrompt ?? ""],
								appendSystemPrompt: undefined,
							});
							const stream = session.session.agent.streamFn;
							session.session.agent.streamFn = (model, context, streamOptions) => {
								assertLive();
								return stream(model, context, {
									...streamOptions,
									maxHttpAttempts: 1,
									signal: streamOptions?.signal
										? AbortSignal.any([streamOptions.signal, abort.signal])
										: abort.signal,
									beforeProviderRequest: async (requestModel, signal) => {
										assertLive();
										frozen.assertAvailable();
										required(
											Bun.deepEquals(requestModel, frozen.model),
											"Provider request changed the frozen model configuration",
										);
										await streamOptions?.beforeProviderRequest?.(requestModel, signal);
										assertLive();
										if (calls >= args.calls) {
											stop("Local model-call budget exhausted");
											throw abort.signal.reason;
										}
										calls++;
									},
								});
							};
							return session;
						},
					});
					runtimes.add(runtime);
					const dispose = runtime.dispose.bind(runtime);
					runtime.dispose = async () => {
						await dispose();
						runtimes.delete(runtime);
					};
					return { runtime, binding };
				},
			},
		});
		required(host.start(), "Another Graph foreground host owns this profile");
		out(
			`Nodes: ${Object.keys(definition.nodes).join(" → ")}\nModel-call ceiling: ${args.calls}; deadline-ms: ${args.timeout}\n`,
		);
		printNodeProgress();
		// A hold is a scheduling pause, not an exit. Leaving here used to strand the in-flight
		// attempt with no executor: resume flipped the Run back to `running` and nothing ever
		// dispatched again. The executor parks instead, and held time does not consume the
		// foreground deadline.
		const armDeadline = (): void => {
			clearTimeout(timer);
			timer = setTimeout(
				() => stop("Local foreground deadline exceeded", "deadline_exceeded"),
				pause.remaining(Date.now()),
			);
		};
		let printedRevision = store.getRun(runId)!.revision;
		let exhausted = false;
		while (!abort.signal.aborted) {
			await host.tick();
			const run = store.getRun(runId)!;
			// Any committed transition may have moved a node; resync the progress lines.
			if (run.revision !== printedRevision) {
				printedRevision = run.revision;
				printNodeProgress();
			}
			if (ForegroundPause.terminal(run.state)) break;
			// Exhaustion cannot resume successfully; close it as non-success after
			// the host has settled, rather than parking or retaining the writer forever.
			if (
				needsAcceptance &&
				run.state === "held" &&
				store
					.getScheduleState(runId)
					?.invocations.some(item => item.node === "exhausted" && item.state === "succeeded")
			) {
				exhausted = true;
				clearTimeout(timer);
				break;
			}
			const observation = pause.observe(run.state, Date.now());
			if (observation.transition === "held") {
				clearTimeout(timer);
				out("Run held; executor parked until resume.\n");
			} else if (observation.transition === "resumed") {
				armDeadline();
				out("Run resumed; executor continues.\n");
			}
			await Bun.sleep(10);
		}
		if (stopReason) {
			const run = store.getRun(runId)!;
			if (!["succeeded", "failed", "cancelled"].includes(run.state)) {
				const cancellation = store.mutateLifecycle(PRINCIPAL, {
					version: 1,
					request_key: `local-stop:${run.id}`,
					operation: "cancel",
					target_id: run.id,
					if_revision: run.revision,
					payload: { reason: stopReason },
				});
				required(cancellation.state !== "rejected", cancellation.error?.message ?? "Stop request was rejected");
				await host.tick();
			}
		}
		await host.shutdown();
		host = undefined;
		if (exhausted) {
			const held = store.getRun(runId)!;
			store.closeHeldRun(owner.owner_id, owner.epoch, {
				run_id: runId,
				if_revision: held.revision,
				reason: "Acceptance did not pass within the bounded attempts",
			});
		}
		const terminal = store.getRun(runId)!;
		if (["succeeded", "failed", "cancelled"].includes(terminal.state)) {
			required(runtimes.size === 0, "Runtime disposal is not confirmed", "result_unknown");
			const settledJobs: string[] = [];
			for (const intent of store.getDispatchIntents(runId)) {
				const invocation = store
					.getScheduleState(runId)!
					.invocations.find(item => item.id === intent.invocation_id)!;
				if (definition.nodes[invocation.node].kind === "program") {
					required(
						intent.state === "finished" || intent.state === "cancelled",
						"Workspace check termination is not confirmed",
						"result_unknown",
					);
					continue;
				}
				const bot = botDefinitions.get(definition.nodes[invocation.node].member!)!;
				const hosted = bots.graphHostedByKey(bot.bot_id, intent.request_key);
				if (!hosted) continue; // A cancelled dispatch may never have reached mailbox admission.
				const job = hosted.job;
				required(
					job.settled &&
						job.ownership.state === "none" &&
						!job.pending_background_count &&
						!job.pending_delivery_count &&
						!job.input_requests.length &&
						!job.owned_services?.length &&
						job.launch_intents.every(launch => launch.disposition?.final === true),
					"Local Bot cleanup is not independently confirmed",
					"result_unknown",
				);
				settledJobs.push(job.job_id);
			}
			const admission = store
				.getProfileWriterAdmissions(owner.owner_id, owner.epoch)
				.find(item => item.run_id === runId);
			if (admission) {
				const observed = needsAcceptance
					? "All retained local runtimes disposed; admitted Bot jobs settled and workspace check dispatches finished or cancelled. Workspace checks run as the current user and are not a process sandbox."
					: "All retained local runtimes disposed; admitted mailbox jobs settled with no ownership, pending work, owned services or unresolved launches. Frozen serial text-only definition and host tool allowlist forbid descendants and external effects.";
				const terminationRef = await publishFrozen(
					canonicalJson({ run_id: runId, observed, settled_jobs: settledJobs, model_calls_started: calls }),
				);
				store.reconcileProfileWriter(owner.owner_id, owner.epoch, {
					identity: admission,
					if_revision: terminal.revision,
					termination_ref: terminationRef,
					observed,
				});
			}
		}
		const finished = store.getRun(runId)!;
		if (json) {
			emitRunJson(store, finished, stdout, false, calls);
		} else {
			out(`Model calls started: ${calls}\n`);
			report(store, finished, out, false);
		}
		return interrupted ? 130 : runExitCode(finished);
	} catch (error) {
		stop("Local foreground execution stopped after an error", "internal_error");
		err(`Graph run: ${error instanceof Error ? error.message : String(error)}\n`);
		if (runId && store) {
			try {
				await host?.shutdown();
				host = undefined;
				const run = store.getRun(runId)!;
				if (run.state === "queued" || run.state === "running") {
					const held = store.mutateLifecycle(PRINCIPAL, {
						version: 1,
						request_key: `local-error:${run.id}`,
						operation: "hold",
						target_id: run.id,
						if_revision: run.revision,
						payload: {
							reason:
								"Local foreground execution stopped after an error; prior effects are unknown and automatic retry is forbidden",
						},
					});
					required(
						held.state !== "rejected",
						held.error?.message ?? "Failed to hold interrupted Run",
						"result_unknown",
					);
				}
				const failed = store.getRun(runId)!;
				if (json) emitRunJson(store, failed, stdout, false, calls);
				else {
					out(`Model calls started: ${calls}\n`);
					report(store, failed, out, false);
				}
			} catch {
				err("Graph cleanup could not be confirmed; prior execution remains unknown.\n");
			}
		}
		if (interrupted) return 130;
		if (runId) return 4;
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (
			[
				"invalid_input",
				"definition_invalid",
				"unknown_graph",
				"unknown_reference",
				"idempotency_conflict",
				"revision_conflict",
				"ENOENT",
				"invalid_utf8",
			].includes(String(code))
		)
			return 2;
		if (
			[
				"capability_unavailable",
				"policy_unavailable",
				"model_unavailable",
				"base_unavailable",
				"permission_denied",
				"resource_limit",
				"budget_exhausted",
				"deadline_exceeded",
				"too_large",
				"EACCES",
			].includes(String(code))
		)
			return 3;
		return 1;
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", onInterrupt);
		try {
			await host?.shutdown();
		} catch {
			err("Graph host cleanup remains unconfirmed; no automatic restart is permitted.\n");
		} finally {
			bots?.close();
			store?.close();
			authStorage?.close();
		}
	}
}

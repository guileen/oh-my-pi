import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolCall } from "@oh-my-pi/pi-ai";
import { cloneModel } from "@oh-my-pi/pi-catalog/model-snapshot";
import { editInspect } from "@oh-my-pi/pi-natives";
import { getAgentDir, prompt } from "@oh-my-pi/pi-utils";
import { isClosedTodo } from "@oh-my-pi/pi-tui/tools/todo";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { formatModelString } from "../config/model-resolver";
import type { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type {
	ExtensionApprovalAnswer,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIDialogOptions,
	ExtensionUIContext,
} from "../extensibility/extensions/types";
import { timedOutAskDialogResult } from "../extensibility/extensions/types";
import { loadSkillsFromDir, type Skill } from "../extensibility/skills";
import { daemonClientForProject, type DaemonBrokerClient } from "../launch/client";
import type { DaemonLaunchMetadata, DaemonOperation, LaunchDisposition } from "../launch/protocol";
import { initializeExtensions } from "../modes/runtime-init";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession, type CreateAgentSessionOptions, type CreateAgentSessionResult } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { SessionManager } from "../session/session-manager";
import { resolveEditMode } from "../utils/edit-mode";
import { normalizeBotReply } from "./input";
import { BotError, type BotInputRequest, type BotJob, type JobProgress, type OwnedBotService } from "./types";
import skillsPrompt from "./skills-prompt.md" with { type: "text" };

export type BotSpanKind = "model" | "tool" | "background" | "compaction";
export type BotSpanOutcome = "ok" | "error" | "cancelled" | "unknown";
export type BotRuntimeEvent =
	| { type: "output"; text: string; final: boolean; message_id: string }
	| {
			type: "span_start";
			span_id: string;
			kind: BotSpanKind;
			label: string;
			parent_span_id?: string;
			started_at?: string;
			detail?: unknown;
	  }
	| {
			type: "span_end";
			span_id: string;
			kind: BotSpanKind;
			label: string;
			outcome: BotSpanOutcome;
			detail?: unknown;
			ended_at?: string;
	  }
	| {
			type: "usage";
			input_tokens: number | null;
			output_tokens: number | null;
			cache_read_tokens: number | null;
			cache_write_tokens: number | null;
			cost_usd: string | null;
	  }
	| { type: "state" }
	| {
			type: "artifact";
			name: string;
			media_type: string;
			content: unknown;
			producer_span_id?: string;
			size_bytes?: number;
	  }
	| ({ type: "input_required" } & BotInputRequest)
	| { type: "input_resolved"; input_request_id: string }
	| { type: "execution_start" }
	| { type: "execution_end"; outcome: "returned" | "cancelled" | "error" }
	| { type: "retry"; attempt: number; delay_ms: number; error: string }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string }
	| { type: "error"; error: unknown };

export interface BotContinuation {
	continuation_id: string;
	origin: "reply" | "timeout" | "dialog_cancel" | "background";
	input_request_id: string | null;
	request_id?: string | null;
	payload?: unknown;
}
export interface BotLaunchIntent extends DaemonLaunchMetadata {
	payload: Extract<DaemonOperation, { op: "start" }>;
}
export interface BotRuntimeCallbacks {
	onEvent(event: BotRuntimeEvent): void;
	/** A host may answer directly, or retain the question and use reply() after obtaining capacity. */
	onInput?(question: BotInputRequest): Promise<unknown>;
	/** Resolve only after durable admission, cancellation fencing and foreground capacity. */
	onContinuation?(continuation: BotContinuation, signal?: AbortSignal): Promise<void>;
	onSessionOwner?(sessionOwnerId: string, ownerEpoch: string): void;
	onLaunchIntent?(intent: BotLaunchIntent): Promise<void>;
	onLaunchDisposition?(launchIntentId: string, disposition: LaunchDisposition, cleanup?: boolean): void;
	assertDispatch?(): void;
}
export interface BotRuntimeState {
	pending_background_count: number;
	pending_delivery_count: number;
	waiting_input_count: number;
	waiting_input_requests: BotInputRequest[];
	is_streaming: boolean;
	context: { used_tokens: number | null; limit_tokens: number | null };
	model: string;
	progress: JobProgress | null;
	session_file: string | null;
	owned_services?: OwnedBotService[];
}
export interface BotRuntime {
	/** Returns at a foreground yield or a runtime-issued input request, not necessarily settlement. */
	prompt(input: string): Promise<void>;
	/** Ask replies use a JSON object keyed by question ID for multiple questions; generic text remains literal. */
	reply(inputRequestId: string, input: string): Promise<void>;
	/** Graph host-only suspension; resolved through reply() and the normal continuation gate. */
	waitForGraphConsultation?(conversationId: string, messageId: string): Promise<string>;
	steer(input: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
	compact(): Promise<void>;
	setModel(model: string): Promise<void>;
	messages(): unknown[];
	state(): BotRuntimeState;
	dispose(): Promise<void>;
}

/** Data-only authorization snapshot; changes never rewrite the executing call or session. */
export interface BotGraphToolCallContext {
	toolCall: ToolCall;
	args: Record<string, unknown>;
	/** Host-inspected edit targets, including every move destination. Never supplied by the model. */
	editTargets?: readonly string[];
}

/** Explicit Graph-only session options. Ordinary Bot callers must omit this. */
export interface BotGraphRuntimeOptions {
	base: "omp-default" | "isolated";
	model: Model;
	appendPrompt: string;
	customTools?: CreateAgentSessionOptions["customTools"];
	/** Host-injected Graph capabilities that must be active before any dispatch. */
	requiredToolNames?: readonly string[];
	/** Trusted host policy over an independent prepared-call snapshot. Throwing denies; not a process sandbox. */
	assertToolCall: (context: BotGraphToolCallContext, signal?: AbortSignal) => void | Promise<void>;
}

/** Internal dependency injection: production always constructs a real AgentSession. No CLI fake mode. */
export interface BotRuntimeOptions {
	session_dir?: string;
	agent_dir?: string;
	model?: Model;
	modelRegistry?: ModelRegistry;
	/** Host-selected concrete effort; fail closed if the session cannot preserve it. */
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	stream?: StreamFn;
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	owner_epoch?: string;
	session_owner_id?: string | null;
	graph?: BotGraphRuntimeOptions;
}

type OpenSpan = { span_id: string; kind: BotSpanKind; label: string };
type PendingQuestion = {
	question: BotInputRequest;
	resolve(value: unknown): Promise<void>;
	reject(error: unknown): void;
	cleanup(): void;
	completing: boolean;
};
const DIALOG_TIMEOUT = Symbol("bot-dialog-timeout");

const ISOLATED_SETTINGS = {
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
	"ttsr.enabled": false,
	"ttsr.builtinRules": false,
	"ttsr.judge": "off",
	"async.widgets": false,
	"images.describeForTextModels": false,
	"edit.autoRepair.enabled": false,
	"lsp.formatOnWrite": false,
	"lsp.diagnosticsOnWrite": false,
	"lsp.diagnosticsOnEdit": false,
	"speech.enabled": false,
	"ask.notify": "off",
	"ask.timeout": 0,
	includeWorkspaceTree: false,
	inlineToolDescriptors: "off",
	"tools.speculativeExecution.enabled": false,
	"task.maxRecursionDepth": 0,
	"todo.reminders": false,
	"tools.intentTracing": true,
	"power.sleepPrevention": "off",
} as const;

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function modelSelector(model: Model): string {
	return `${model.provider}/${model.id}`;
}
function decimalCost(value: number): string {
	const [coefficient, exponent] = String(value).split("e");
	if (exponent === undefined) return coefficient!;
	const [integer, fraction = ""] = coefficient!.split(".");
	const digits = integer! + fraction;
	const point = integer!.length + Number(exponent);
	if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) return digits + "0".repeat(point - digits.length);
	return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

async function frozenSkills(directories: readonly string[]): Promise<Skill[]> {
	const names = new Set<string>();
	const skills: Skill[] = [];
	for (const dir of directories) {
		const loaded = await loadSkillsFromDir({ dir, source: "bot:project" });
		if (loaded.warnings.length) {
			throw new BotError("invalid_input", "Invalid frozen Bot skills", { warnings: loaded.warnings });
		}
		for (const skill of loaded.skills) {
			if (names.has(skill.name)) throw new BotError("invalid_input", `Duplicate Bot skill: ${skill.name}`);
			names.add(skill.name);
			skills.push(skill);
		}
	}
	return skills;
}

function isolatedPrompt(job: BotJob, skills: readonly Skill[]): string[] {
	const blocks = job.config.system_prompt ? [job.config.system_prompt] : [];
	if (skills.length) blocks.push(prompt.render(skillsPrompt, { skills }));
	return blocks;
}

export async function createBotRuntime(
	job: BotJob,
	callbacks: BotRuntimeCallbacks,
	options: BotRuntimeOptions = {},
): Promise<BotRuntime> {
	ensureThemeSync();
	const agentDir = options.agent_dir ?? getAgentDir();
	const sessionFile =
		job.session_file ??
		path.join(options.session_dir ?? path.join(agentDir, "bots", "sessions"), `${job.job_id}.jsonl`);
	await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
	const sessionManager = await SessionManager.open(sessionFile, path.dirname(sessionFile), undefined, {
		initialCwd: job.cwd,
		suppressBreadcrumb: true,
	});
	let result: CreateAgentSessionResult | undefined;
	const sessionOwnerId = options.session_owner_id ?? job.session_owner_id ?? sessionManager.getSessionId();
	const previousEpoch = BigInt(job.owner_epoch ?? "0");
	const ownerEpoch = String(
		options.owner_epoch && BigInt(options.owner_epoch) > previousEpoch
			? BigInt(options.owner_epoch)
			: previousEpoch + 1n,
	);
	let runtime: AgentBotRuntime | undefined;
	try {
		await sessionManager.ensureOnDisk();
		callbacks.onSessionOwner?.(sessionOwnerId, ownerEpoch);
		await sessionManager.flush();
		const graph = options.graph;
		const graphModel = graph ? cloneModel(graph.model) : undefined;
		const assertDispatchModel = (model: Model): void => {
			if (graphModel && !Bun.deepEquals(model, graphModel))
				throw new BotError("incompatible_model", "Graph model configuration changed before dispatch");
			runtime?.assertDispatchAllowed();
		};
		const skills = graph?.base === "omp-default" ? undefined : await frozenSkills(job.config.skills_dirs);
		const settings = graph?.base === "omp-default" ? undefined : Settings.isolated(ISOLATED_SETTINGS);
		// Reuse model preference/credentials, never the ambient capability configuration for ordinary Bots.
		if (settings && !graph && !job.config.model && !job.model.current && !options.model) {
			const profileSettings = await Settings.loadReadOnly({ cwd: job.cwd, agentDir });
			const preferred = profileSettings.getModelRole("default");
			if (preferred) settings.setModelRole("default", preferred);
		}
		const isolated = graph?.base !== "omp-default";
		result = await (options.createSession ?? createAgentSession)({
			cwd: job.cwd,
			agentDir,
			sessionManager,
			settings,
			model: graph?.model ?? options.model,
			thinkingLevel: options.thinkingLevel,
			modelRegistry: options.modelRegistry,
			...(graph ? { requireExactToolArguments: true } : {}),
			...(graph
				? { customTools: graph.customTools, ...(isolated ? { allowRestrictedCustomTools: true } : {}) }
				: {}),
			...(isolated
				? {
						modelPattern:
							graph || options.model ? undefined : (job.model.current ?? job.config.model ?? undefined),
						systemPrompt: [...isolatedPrompt(job, skills!), ...(graph ? [graph.appendPrompt] : [])],
						skills,
						rules: [],
						contextFiles: [],
						noContextFiles: true,
						additionalDirectories: [],
						promptTemplates: [],
						slashCommands: [],
						disableExtensionDiscovery: true,
						disableAuxiliaryInference: true,
						enableMCP: false,
						enableLsp: false,
						enableIrc: false,
						toolNames: [...new Set([...job.config.tools, ...(graph?.requiredToolNames ?? [])])],
						restrictToolNames: true,
						spawns: "",
						inheritedSessionAgents: [],
					}
				: { appendSystemPrompt: graph!.appendPrompt }),
			requireYieldTool: false,
			interactivePrompts: true,
			hasUI: false,
			allowSessionModelFallback: false,
			settingsApproval: false,
			...(isolated ? { skipPythonPreflight: true, suppressAutoPrewalk: true } : {}),
			disableModelFallback: true,
			disableServerSideFallback: true,
			cacheWarming: false,
			assertDispatchModel,
			prepareServiceLaunch: async operation => {
				if (!runtime) throw new BotError("invalid_state", "Bot runtime is not initialized");
				return runtime.prepareServiceLaunch(operation);
			},
			autoTitle: false,
			bindProcessState: false,
			agentId: `Bot_${job.job_id}`,
			agentRegistry: new AgentRegistry(),
		});
		if (graph && !result.prepareToolArguments)
			throw new BotError("invalid_state", "Graph tool argument preparation is unavailable");
		if (!result.session.model) throw new BotError("invalid_input", "No model is available for this Bot");
		if (graphModel) assertDispatchModel(result.session.model);
		if (
			options.thinkingLevel !== undefined &&
			(result.session.thinkingLevel ?? "off") !== options.thinkingLevel
		) {
			throw new BotError("incompatible_model", "Requested thinking level could not be applied exactly");
		}
		const expected = new Set([...job.config.tools, ...(graph?.requiredToolNames ?? [])]);
		const actual = result.session.getActiveToolNames();
		if (
			isolated &&
			(actual.some(name => !expected.has(name)) || [...expected].some(name => !actual.includes(name)))
		) {
			throw new BotError("invalid_input", "Configured Bot tools could not be loaded exactly", {
				configured: [...expected],
				loaded: actual,
			});
		}
		if (graph?.requiredToolNames?.some(name => !actual.includes(name))) {
			throw new BotError("invalid_input", "Required Graph capabilities could not be loaded", {
				required: graph.requiredToolNames,
				loaded: actual,
			});
		}
		if (options.stream) {
			const stream = options.stream;
			result.session.agent.streamFn = (model, context, streamOptions) => {
				assertDispatchModel(model);
				return stream(model, context, streamOptions);
			};
		}
		runtime = new AgentBotRuntime(result, callbacks, job, sessionOwnerId, ownerEpoch, graph);
		await runtime.initialize();
		return runtime;
	} catch (error) {
		if (runtime) await runtime.releaseLocalResources();
		else if (result) await result.session.dispose();
		else await sessionManager.close();
		throw error;
	}
}

class AgentBotRuntime implements BotRuntime {
	readonly #session: AgentSession;
	readonly #callbacks: BotRuntimeCallbacks;
	readonly #unsubscribe: () => void;
	readonly #unsubscribeJobs: (() => void) | undefined;
	readonly #timer: NodeJS.Timeout;
	readonly #questions = new Map<string, PendingQuestion>();
	readonly #spans = new Map<string, OpenSpan>();
	readonly #toolSpans = new Map<string, string>();
	readonly #backgroundSpans = new Map<string, string>();
	readonly #seenBackground = new Set<string>();
	readonly #messageIds = new Map<string, string>();
	readonly #accountedMessages = new Set<string>();
	readonly #artifactIds = new Set<string>();
	readonly #artifactTasks = new Set<Promise<void>>();
	readonly #launchDeliveries = new Set<Promise<void>>();
	readonly #boundaries = new Set<() => void>();
	#modelSpan: OpenSpan | undefined;
	#compactionSpan: string | undefined;
	#activeMessageId: string | undefined;
	#lastAssistant: AssistantMessage | undefined;
	#run: Promise<void> | undefined;
	#runError: unknown;
	#executionOpen = false;
	#cancelled = true;
	#stopped = false;
	#disposed = false;
	#stateFingerprint = "";
	#cleanup: Promise<void> | undefined;
	#unrecoveredBackground: number;
	readonly #unrecoveredDeliveries: number;
	readonly #services = new Map<string, DaemonSnapshot>();
	readonly #seenServices = new Set<string>();
	readonly #observedServices = new Map<string, number | null>();
	readonly #recoverableServices: readonly OwnedBotService[];
	readonly #serviceCalls = new Set<string>();
	readonly #serviceNames = new Set<string>();
	#serviceClient: DaemonBrokerClient | undefined;
	#unregisterServiceCompletion: (() => void) | undefined;
	#serviceRefresh: Promise<void> | undefined;
	#serviceDiscovery = false;
	#serviceError: unknown;
	#trackServices = false;
	#servicePollAt = 0;
	readonly #canLaunch: boolean;
	readonly #uiContext: ExtensionUIContext;
	readonly #sessionOwnerId: string;
	readonly #graphModel: Model | undefined;
	readonly #launchIntents = new Map<string, BotLaunchIntent>();
	readonly #launchPreparations = new Set<Promise<void>>();
	#ownerEpoch: string;
	#epochFenced = false;
	#continuations = new AbortController();

	constructor(
		result: CreateAgentSessionResult,
		callbacks: BotRuntimeCallbacks,
		job: BotJob,
		sessionOwnerId: string,
		ownerEpoch: string,
		graph?: BotGraphRuntimeOptions,
	) {
		this.#session = result.session;
		this.#callbacks = callbacks;
		this.#sessionOwnerId = sessionOwnerId;
		this.#graphModel = graph?.model;
		this.#ownerEpoch = ownerEpoch;
		for (const intent of job.launch_intents ?? []) {
			if (!intent.disposition?.final)
				this.#launchIntents.set(intent.launch_intent_id, {
					launch_intent_id: intent.launch_intent_id,
					session_owner_id: intent.session_owner_id,
					owner_epoch: intent.owner_epoch,
					payload: intent.payload as BotLaunchIntent["payload"],
				});
		}
		this.#canLaunch = (graph ? this.#session.getActiveToolNames() : job.config.tools).includes("bash");
		this.#trackServices =
			this.#canLaunch &&
			(!!job.session_owner_id ||
				!!job.session_file ||
				this.#launchIntents.size > 0 ||
				job.pending_background_count > 0);
		this.#unrecoveredBackground = job.pending_background_count;
		this.#unrecoveredDeliveries = job.pending_delivery_count;
		this.#recoverableServices = job.owned_services ?? [];
		this.#unsubscribe = this.#session.subscribe(event => this.#onEvent(event));
		this.#unsubscribeJobs = this.#session.asyncJobManager?.onJobSettled(() => this.#sync());
		this.#timer = setInterval(() => {
			this.#sync();
			if (this.#trackServices && !this.#serviceCalls.size && Date.now() >= this.#servicePollAt)
				void this.#refreshServices();
		}, 100);
		this.#timer.unref();
		this.#uiContext = this.#ui();
		result.setToolUIContext(this.#uiContext, true);
		const beforeToolCall = this.#session.agent.beforeToolCall;
		this.#session.agent.beforeToolCall = graph
			? async (context, signal) => {
					this.assertDispatchAllowed();
					const hookResult = await beforeToolCall?.call(this.#session.agent, context, signal);
					this.assertDispatchAllowed();
					if (hookResult?.block) return hookResult;
					// The agent revalidates replacements after this hook, potentially changing
					// their meaning after authorization. Reject them rather than authorize
					// arguments that are not the ones ultimately dispatched.
					if (hookResult?.args !== undefined)
						throw new BotError("invalid_state", "Graph tool argument replacement is not supported");
					const additionalContext = hookResult?.additionalContext;
					const args = result.prepareToolArguments!(context.args);
					if (args !== context.args) {
						for (const key of Object.keys(context.args)) delete context.args[key];
						Object.assign(context.args, args);
					}
					const policyArgs = structuredClone(args);
					const assertToolCall = graph.assertToolCall;
					const inspection = context.toolCall.name === "edit"
						? editInspect(resolveEditMode({
								settings: this.#session.settings,
								getActiveModelString: () => this.#session.model ? formatModelString(this.#session.model) : undefined,
							}), JSON.stringify(policyArgs))
						: undefined;
					await assertToolCall(
						{
							args: policyArgs,
							...(inspection ? {
								editTargets: [
									...inspection.paths,
									...inspection.fileOps.flatMap(op => op.kind === "move" && op.to !== undefined ? [op.to] : []),
								],
							} : {}),
							toolCall: {
								type: "toolCall",
								id: context.toolCall.id,
								name: context.toolCall.name,
								arguments: policyArgs,
							},
						},
						signal,
					);
					this.assertDispatchAllowed();
					return additionalContext === undefined ? undefined : { additionalContext };
				}
			: (context, signal) => {
					this.assertDispatchAllowed();
					return beforeToolCall?.call(this.#session.agent, context, signal);
				};
		this.#session.yieldQueue.setIdleDeliveryGate(async () => {
			this.assertDispatchAllowed();
			await this.#permit("background", null);
			this.assertDispatchAllowed();
		});
		const queueLaunchCompletion = this.#session.queueLaunchCompletion.bind(this.#session);
		this.#session.queueLaunchCompletion = notification => {
			let delivered: Promise<void>;
			if (this.#cancelled) {
				this.#session.sessionManager.appendCustomEntry("bot-service-completion", notification);
				this.#emit({
					type: "artifact",
					name: "service-completion.json",
					media_type: "application/json",
					content: notification,
				});
				delivered = this.#session.sessionManager.flush();
			} else delivered = queueLaunchCompletion(notification);
			this.#launchDeliveries.add(delivered);
			this.#recordService(notification.daemon);
			const settled = (error?: unknown): void => {
				this.#launchDeliveries.delete(delivered);
				if (error && !this.#cancelled) this.#emit({ type: "error", error });
				this.#sync();
			};
			delivered.then(() => settled(), settled);
			this.#sync();
			return delivered;
		};
	}
	async initialize(): Promise<void> {
		await initializeExtensions(this.#session, {
			mode: "rpc",
			uiContext: this.#uiContext,
			reportSendError: (_action, error) => this.#emit({ type: "error", error }),
			reportRuntimeError: error => this.#emit({ type: "error", error: new Error(error.error) }),
			onShutdown: () => {
				void this.stop();
			},
		});
		await this.recoverServices();
	}
	async recoverServices(): Promise<void> {
		if (!this.#canLaunch || !this.#trackServices) return;
		this.#trackServices = true;
		await this.#refreshServices();
		if (!this.#serviceError) {
			const recovered = this.#recoverableServices.filter(
				service =>
					this.#observedServices.has(service.id) && this.#observedServices.get(service.id) === service.started_at,
			).length;
			this.#unrecoveredBackground = Math.max(0, this.#unrecoveredBackground - recovered);
			const unregister = this.#serviceClient!.onCompletion(this.#sessionOwnerId, notification => {
				const delivered = this.#session.queueLaunchCompletion(notification);
				this.#recordService(notification.daemon);
				this.#sync();
				return delivered;
			});
			this.#unregisterServiceCompletion = () => unregister({ preservePending: true });
		}
	}
	async prepareServiceLaunch(operation: Extract<DaemonOperation, { op: "start" }>): Promise<DaemonLaunchMetadata> {
		this.assertDispatchAllowed();
		const intent: BotLaunchIntent = {
			launch_intent_id: randomUUID(),
			session_owner_id: this.#sessionOwnerId,
			owner_epoch: this.#ownerEpoch,
			payload: { ...operation, owner: this.#sessionOwnerId },
		};
		const prepared = Promise.resolve(this.#callbacks.onLaunchIntent?.(intent)).then(() => {
			this.#launchIntents.set(intent.launch_intent_id, intent);
			this.#trackServices = true;
		});
		this.#launchPreparations.add(prepared);
		try {
			await prepared;
			this.assertDispatchAllowed();
			return {
				launch_intent_id: intent.launch_intent_id,
				session_owner_id: intent.session_owner_id,
				owner_epoch: intent.owner_epoch,
			};
		} finally {
			this.#launchPreparations.delete(prepared);
		}
	}

	async #permit(origin: BotContinuation["origin"], inputRequestId: string | null, payload?: unknown): Promise<void> {
		this.assertDispatchAllowed();
		await this.#callbacks.onContinuation?.(
			{ continuation_id: randomUUID(), origin, input_request_id: inputRequestId, payload },
			this.#continuations.signal,
		);
		this.#continuations.signal.throwIfAborted();
		this.assertDispatchAllowed();
	}

	async #cancelServices(): Promise<void> {
		this.#serviceClient ??= await daemonClientForProject(this.#session.sessionManager.getCwd());
		const fenced = await this.#serviceClient.request({
			op: "fence_owner",
			session_owner_id: this.#sessionOwnerId,
			through_epoch: this.#ownerEpoch,
		});
		if (fenced.op !== "fence_owner" || BigInt(fenced.fenced_through_epoch) < BigInt(this.#ownerEpoch))
			throw new BotError("cleanup_failed", "Bot service owner fence was not confirmed");
		this.#epochFenced = true;
		await Promise.allSettled(this.#launchPreparations);
		for (const intent of this.#launchIntents.values()) {
			if (intent.session_owner_id !== this.#sessionOwnerId || BigInt(intent.owner_epoch) > BigInt(this.#ownerEpoch))
				throw new BotError("cleanup_failed", "Bot launch belongs to a newer or different owner");
			const result = await this.#serviceClient.request({
				op: "reconcile_launch",
				launch_intent_id: intent.launch_intent_id,
				session_owner_id: intent.session_owner_id,
				owner_epoch: intent.owner_epoch,
				mode: "cancel",
			});
			if (result.op !== "reconcile_launch")
				throw new BotError("cleanup_failed", "Unexpected Bot launch reconciliation response");
			this.#callbacks.onLaunchDisposition?.(intent.launch_intent_id, result.disposition, true);
			if (!result.disposition.final)
				throw new BotError("cleanup_failed", "Bot launch cleanup remains uncertain", {
					launch_intent_id: intent.launch_intent_id,
				});
			this.#launchIntents.delete(intent.launch_intent_id);
		}
		await this.#refreshServices();
		if (this.#serviceError) throw new BotError("cleanup_failed", "Could not establish owned Bot service state");
		for (const daemon of this.#services.values()) {
			const stopped = await this.#serviceClient.request({
				op: "stop_owned",
				name: daemon.name,
				id: daemon.id,
				generation: String(daemon.startedAt),
				session_owner_id: this.#sessionOwnerId,
				through_epoch: this.#ownerEpoch,
				timeoutMs: 5_000,
			});
			if (
				stopped.op !== "stop_owned" ||
				stopped.daemon.id !== daemon.id ||
				stopped.daemon.startedAt !== daemon.startedAt ||
				(stopped.daemon.state !== "exited" && stopped.daemon.state !== "failed")
			)
				throw new BotError("cleanup_failed", "Owned Bot service did not stop", { service_id: daemon.id });
			this.#recordService(stopped.daemon);
		}
	}
	assertDispatchAllowed(): void {
		if (this.#cancelled || this.#stopped || this.#disposed)
			throw new BotError("invalid_state", "This Bot activation is cancelled");
		if (this.#sessionOwnerId !== this.#session.sessionManager.getSessionId())
			throw new BotError("cleanup_failed", "Bot session identity changed; prior work must be reconciled");
		if (this.#serviceError || this.#unrecoveredBackground || this.#unrecoveredDeliveries)
			throw new BotError("cleanup_failed", "Prior Bot work has unconfirmed ownership");
		this.#callbacks.assertDispatch?.();
	}

	#emit(event: BotRuntimeEvent): void {
		this.#callbacks.onEvent(event);
	}
	#assertOpen(): void {
		if (this.#stopped || this.#disposed) throw new BotError("invalid_state", "Bot runtime is stopped");
		if (this.#cleanup) throw new BotError("invalid_state", "Bot runtime is cancelling");
	}
	#boundary(): void {
		for (const resolve of this.#boundaries) resolve();
		this.#boundaries.clear();
	}
	async #untilBoundary(start: () => void | Promise<void>): Promise<void> {
		const boundary = Promise.withResolvers<void>();
		this.#boundaries.add(boundary.resolve);
		try {
			await start();
			await boundary.promise;
			await this.#session.settleInFlightMessagePersistence();
			await this.#session.sessionManager.flush();
			await Promise.all(this.#artifactTasks);
			await this.#serviceRefresh;
			if (this.#runError !== undefined) throw this.#runError;
		} finally {
			this.#boundaries.delete(boundary.resolve);
			this.#sync();
		}
	}

	async prompt(input: string): Promise<void> {
		this.#assertOpen();
		if (this.#questions.size || this.#run || this.#session.isStreaming)
			throw new BotError("invalid_state", "Bot already has an active conversation turn");
		this.#cancelled = false;
		if (this.#continuations.signal.aborted) this.#continuations = new AbortController();
		if (this.#epochFenced) {
			this.#ownerEpoch = String(BigInt(this.#ownerEpoch) + 1n);
			this.#callbacks.onSessionOwner?.(this.#sessionOwnerId, this.#ownerEpoch);
			this.#epochFenced = false;
		}
		this.#runError = undefined;
		await this.#untilBoundary(() => {
			const run = this.#session
				.prompt(input, { expandPromptTemplates: false, runCommands: false, throwOnDrop: true })
				.then(() => {});
			this.#run = run;
			run.then(
				() => {
					if (this.#run === run) this.#run = undefined;
					this.#boundary();
					this.#sync();
				},
				error => {
					if (this.#run === run) this.#run = undefined;
					this.#runError = error;
					this.#emit({ type: "error", error });
					this.#boundary();
					this.#sync();
				},
			);
		});
	}

	async reply(inputRequestId: string, input: string): Promise<void> {
		this.#assertOpen();
		const pending = this.#questions.get(inputRequestId);
		if (!pending) throw new BotError("input_request_closed", "This Bot input request is closed");
		const answer = normalizeBotReply(pending.question, input);
		await this.#untilBoundary(() => pending.resolve(answer));
	}

	async waitForGraphConsultation(conversationId: string, messageId: string): Promise<string> {
		this.#assertOpen();
		if (!conversationId || !messageId) throw new BotError("invalid_input", "Graph wait identity is required");
		const value = await this.#request(
			"text",
			{
				graph_consultation: { conversation_id: conversationId, message_id: messageId },
			},
			undefined,
			true,
		);
		return String(value);
	}

	async steer(input: string): Promise<void> {
		this.#assertOpen();
		if (!this.#session.isStreaming || this.#questions.size)
			throw new BotError("invalid_state", "Steering requires an active foreground execution");
		await this.#session.steer(input);
		this.#sync();
	}

	abort(): Promise<void> {
		if (!this.#cleanup) {
			this.#cleanup = this.#cancel().finally(() => {
				this.#cleanup = undefined;
			});
		}
		return this.#cleanup;
	}
	async #cancel(): Promise<void> {
		this.#cancelled = true;
		this.#continuations.abort(new BotError("invalid_state", "Bot continuation cancelled"));
		const services =
			this.#canLaunch && (this.#trackServices || this.#launchIntents.size > 0)
				? this.#cancelServices().then(
						() => null,
						error => error,
					)
				: undefined;
		const manager = this.#session.asyncJobManager;
		const owner = this.#session.getAgentId();
		if (manager && owner) {
			manager.acknowledgeDeliveries(manager.getAllJobs({ ownerId: owner }).map(job => job.id));
			manager.cancelAll({ ownerId: owner });
		}
		this.#session.clearQueue();
		for (const pending of this.#questions.values()) pending.reject(new Error("Bot input cancelled"));
		await this.#session.abort({ reason: "Bot interrupted" });
		const serviceError = await services;
		if (serviceError)
			throw new BotError("cleanup_failed", "Bot service cleanup could not be confirmed", {
				reason: serviceError instanceof Error ? serviceError.message : String(serviceError),
			});
		if (manager && owner && !(await manager.waitForOwnerJobs(owner, { timeoutMs: 30_000 }))) {
			throw new BotError("cleanup_failed", "Owned Bot background work did not stop", {
				pending_jobs: manager
					.getAllJobs({ ownerId: owner })
					.filter(job => job.endTime === undefined)
					.map(job => job.id),
			});
		}
		this.#session.yieldQueue.clear();
		if (this.#run) await this.#run.catch(() => {});
		await this.#session.settleInFlightMessagePersistence();
		await this.#session.sessionManager.flush();
		await Promise.all(this.#artifactTasks);
		await Promise.allSettled(this.#launchDeliveries);
		for (const span of this.#spans.values()) this.#finish(span.span_id, "cancelled");
		this.#sync();
		if (this.#unrecoveredBackground || this.#unrecoveredDeliveries) {
			throw new BotError(
				"cleanup_failed",
				"Previous worker ownership cannot be recovered from the session transcript",
				{
					pending_background_count: this.#unrecoveredBackground,
					pending_delivery_count: this.#unrecoveredDeliveries,
				},
			);
		}
	}
	async stop(): Promise<void> {
		this.#stopped = true;
		await this.abort();
	}

	async compact(): Promise<void> {
		this.#assertOpen();
		const state = this.state();
		if (
			state.is_streaming ||
			state.waiting_input_count ||
			state.pending_background_count ||
			state.pending_delivery_count
		) {
			throw new BotError("invalid_state", "Compaction requires a settled Bot boundary");
		}
		await this.#session.compact(undefined, { mode: "qaonly", suppressContinuation: true });
		await this.#session.sessionManager.flush();
		this.#sync();
	}

	async setModel(selector: string): Promise<void> {
		this.#assertOpen();
		if (this.#graphModel) throw new BotError("incompatible_model", "Graph model bindings cannot be changed in place");
		if (this.#session.isStreaming || this.#questions.size)
			throw new BotError("invalid_state", "Model changes require a foreground boundary");
		const slash = selector.indexOf("/");
		const target =
			slash > 0 ? this.#session.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1)) : undefined;
		if (!target) throw new BotError("incompatible_model", "Requested Bot model is unavailable", { model: selector });
		const limit = count(target.contextWindow);
		if (limit === null || limit === 0)
			throw new BotError("incompatible_model", "Requested model has no known context limit");
		const context = this.#session.getContextUsage({ contextWindow: limit });
		if (context && context.tokens >= limit) {
			throw new BotError("incompatible_model", "Bot conversation exceeds the requested model context", {
				used_tokens: context.tokens,
				limit_tokens: target.contextWindow,
			});
		}
		if (
			!target.input.includes("image") &&
			this.#session.messages.some(
				message =>
					"content" in message &&
					Array.isArray(message.content) &&
					message.content.some(block => block.type === "image"),
			)
		) {
			throw new BotError(
				"incompatible_model",
				"Bot conversation contains images unsupported by the requested model",
			);
		}
		try {
			await this.#session.setModel(target, "default", { persist: false });
		} catch (error) {
			throw new BotError(
				"incompatible_model",
				error instanceof Error ? error.message : "Requested model cannot serve this Bot",
			);
		}
		await this.#session.sessionManager.flush();
		this.#sync();
	}

	messages(): unknown[] {
		return [...this.#session.messages];
	}
	state(): BotRuntimeState {
		const snapshot = this.#session.getAsyncJobSnapshot({ recentLimit: 0 });
		const owner = this.#session.getAgentId();
		const jobs = this.#session.asyncJobManager?.getAllJobs(owner ? { ownerId: owner } : undefined) ?? [];
		const context = this.#session.getContextUsage();
		const todos = this.#session.getTodoPhases().flatMap(phase => phase.tasks);
		const queued = this.#session.getQueuedMessages();
		return {
			owned_services: Array.from(this.#services.values(), service => ({
				id: service.id,
				name: service.name,
				started_at: service.startedAt ?? null,
			})),
			pending_background_count:
				this.#unrecoveredBackground +
				jobs.filter(job => job.endTime === undefined).length +
				Math.max(this.#services.size, this.#serviceDiscovery ? 1 : 0),
			pending_delivery_count:
				this.#unrecoveredDeliveries +
				(snapshot?.delivery.queued ?? 0) +
				queued.steering.length +
				queued.followUp.length +
				this.#artifactTasks.size +
				this.#launchDeliveries.size,
			waiting_input_count: this.#questions.size,
			waiting_input_requests: [...this.#questions.values()].map(pending => pending.question),
			is_streaming: this.#session.isStreaming && this.#questions.size === 0,
			context: { used_tokens: count(context?.tokens), limit_tokens: count(this.#session.model?.contextWindow) },
			model: modelSelector(this.#session.model!),
			progress: todos.length
				? { source: "todo", completed: todos.filter(isClosedTodo).length, total: todos.length, unit: "tasks" }
				: null,
			session_file: this.#session.sessionManager.getSessionFile() ?? null,
		};
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		await this.stop();
		await this.releaseLocalResources();
	}

	/** Release local listeners after confirmed stop, or when initialization never completed. */
	async releaseLocalResources(): Promise<void> {
		if (this.#disposed) return;
		clearInterval(this.#timer);
		this.#unsubscribeJobs?.();
		this.#unregisterServiceCompletion?.();
		this.#unsubscribe();
		await this.#session.dispose();
		this.#disposed = true;
	}

	#start(
		kind: BotSpanKind,
		label: string,
		key: string = randomUUID(),
		startedAt?: number,
		detail?: unknown,
	): OpenSpan {
		const span = { span_id: key, kind, label };
		this.#spans.set(key, span);
		this.#emit({
			type: "span_start",
			...span,
			detail,
			...(startedAt === undefined ? {} : { started_at: new Date(startedAt).toISOString() }),
		});
		return span;
	}
	#finish(key: string, outcome: BotSpanOutcome, detail?: unknown, endedAt?: number): void {
		const span = this.#spans.get(key);
		if (!span) return;
		this.#spans.delete(key);
		this.#emit({
			type: "span_end",
			...span,
			outcome,
			detail,
			...(endedAt === undefined ? {} : { ended_at: new Date(endedAt).toISOString() }),
		});
	}
	#messageId(message: AssistantMessage): string {
		const key = JSON.stringify([message.provider, message.model, message.timestamp, message.responseId]);
		const id = this.#activeMessageId ?? this.#messageIds.get(key) ?? randomUUID();
		this.#messageIds.set(key, id);
		return id;
	}
	#usage(message: AssistantMessage): void {
		const id = this.#messageId(message);
		if (this.#accountedMessages.has(id)) return;
		this.#accountedMessages.add(id);
		const usage = message.usage;
		const cost = usage?.cost?.total;
		// Normalized provider errors can contain an initialized zero Usage without a usage report.
		// No provenance flag exists in that API; retain real returned zeros, but not synthetic failed-call zeros.
		const reported =
			(message.stopReason !== "error" && message.stopReason !== "aborted") ||
			[
				usage?.input,
				usage?.output,
				usage?.cacheRead,
				usage?.cacheWrite,
				usage?.totalTokens,
				usage?.contextTokens,
				cost,
			].some(value => typeof value === "number" && Number.isFinite(value) && value > 0);
		this.#emit({
			type: "usage",
			input_tokens: reported ? count(usage?.input) : null,
			output_tokens: reported ? count(usage?.output) : null,
			cache_read_tokens: reported ? count(usage?.cacheRead) : null,
			cache_write_tokens: reported ? count(usage?.cacheWrite) : null,
			cost_usd:
				reported && typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? decimalCost(cost) : null,
		});
	}
	#onEvent(event: AgentSessionEvent): void {
		if (this.#disposed) return;
		switch (event.type) {
			case "agent_start":
				this.#lastAssistant = undefined;
				if (!this.#executionOpen) {
					this.#executionOpen = true;
					this.#emit({ type: "execution_start" });
				}
				break;
			case "turn_start":
				this.#modelSpan = this.#start("model", modelSelector(this.#session.model!));
				break;
			case "message_start":
			case "message_update":
			case "message_end":
				if (event.message.role === "assistant") {
					const message = event.message;
					if (event.type === "message_start")
						this.#activeMessageId = this.#modelSpan?.span_id ?? this.#messageId(message);
					const text = message.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("");
					const final = event.type === "message_end";
					if (text) this.#emit({ type: "output", text, final, message_id: this.#messageId(message) });
					if (final) {
						this.#lastAssistant = message;
						this.#usage(message);
						if (this.#modelSpan)
							this.#finish(
								this.#modelSpan.span_id,
								message.stopReason === "aborted"
									? "cancelled"
									: message.stopReason === "error"
										? "error"
										: "ok",
							);
						this.#modelSpan = undefined;
						this.#activeMessageId = undefined;
						if (message.stopReason === "error")
							this.#emit({
								type: "error",
								error: new Error(message.errorMessage ?? "Bot model request failed"),
							});
					}
				}
				break;
			case "tool_execution_start":
				this.#toolSpans.set(
					event.toolCallId,
					this.#start("tool", event.toolName, undefined, undefined, { arguments: event.args }).span_id,
				);
				if (
					event.toolName === "bash" &&
					typeof record(event.args)?.name === "string" &&
					String(record(event.args)?.name).trim()
				) {
					this.#trackServices = true;
					this.#serviceDiscovery = true;
					this.#serviceCalls.add(event.toolCallId);
					this.#serviceNames.add(String(record(event.args)?.name));
				}
				break;
			case "tool_execution_end": {
				const span = this.#toolSpans.get(event.toolCallId);
				if (span) {
					this.#finish(span, this.#cancelled ? "cancelled" : event.isError ? "error" : "ok", event.result);
					if (!event.isError) this.#artifacts(event.result, span);
					this.#toolSpans.delete(event.toolCallId);
				}
				if (this.#serviceCalls.delete(event.toolCallId)) {
					this.#serviceDiscovery = true;
					void this.#refreshServices();
				}
				break;
			}
			case "manual_compaction_start":
				this.#compactionSpan = this.#start("compaction", "qaonly").span_id;
				break;
			case "manual_compaction_end":
				if (this.#compactionSpan)
					this.#finish(
						this.#compactionSpan,
						event.aborted ? "cancelled" : event.errorMessage ? "error" : "ok",
						event.result ?? event.errorMessage,
					);
				this.#compactionSpan = undefined;
				break;
			case "auto_retry_start":
				this.#emit({ type: "retry", attempt: event.attempt, delay_ms: event.delayMs, error: event.errorMessage });
				break;
			case "agent_end":
				if (event.yielded !== false) {
					const outcome = this.#cancelled
						? "cancelled"
						: this.#lastAssistant?.stopReason === "error"
							? "error"
							: "returned";
					if (this.#executionOpen) {
						this.#executionOpen = false;
						this.#emit({ type: "execution_end", outcome });
					}
					this.#boundary();
				}
				break;
		}
		if (event.type !== "message_update") this.#sync();
	}

	#sync(): void {
		if (this.#disposed) return;
		const owner = this.#session.getAgentId();
		for (const job of this.#session.asyncJobManager?.getAllJobs(owner ? { ownerId: owner } : undefined) ?? []) {
			if (!this.#seenBackground.has(job.id)) {
				this.#seenBackground.add(job.id);
				this.#backgroundSpans.set(job.id, this.#start("background", job.type, undefined, job.startTime).span_id);
			}
			const span = this.#backgroundSpans.get(job.id);
			if (span && job.endTime !== undefined) {
				this.#finish(
					span,
					job.status === "completed" ? "ok" : job.status === "cancelled" ? "cancelled" : "error",
					{ result: job.resultText, error: job.errorText, details: job.latestDetails },
					job.endTime,
				);
				this.#backgroundSpans.delete(job.id);
				if (job.status === "completed") this.#artifacts({ details: job.latestDetails }, span);
			}
		}
		const fingerprint = JSON.stringify(this.state());
		if (fingerprint !== this.#stateFingerprint) {
			this.#stateFingerprint = fingerprint;
			this.#emit({ type: "state" });
		}
	}
	#recordService(daemon: DaemonSnapshot): void {
		this.#observedServices.set(daemon.id, daemon.startedAt ?? null);
		const key = `service_${daemon.id}_${daemon.startedAt}`;
		const terminal = daemon.state === "exited" || daemon.state === "failed";
		if (!this.#seenServices.has(key)) {
			if (
				terminal &&
				!this.#serviceNames.has(daemon.name) &&
				!this.#recoverableServices.some(
					service => service.id === daemon.id && service.started_at === (daemon.startedAt ?? null),
				)
			)
				return;
			this.#seenServices.add(key);
			this.#start("background", "bash service", key, daemon.startedAt);
		}
		if (terminal) {
			this.#services.delete(daemon.id);
			this.#finish(
				key,
				this.#cancelled && (this.#stopped || this.#cleanup !== undefined)
					? "cancelled"
					: daemon.state === "failed"
						? "error"
						: daemon.exitCode === undefined
							? "unknown"
							: daemon.exitCode === 0
								? "ok"
								: "error",
				daemon,
				daemon.exitedAt,
			);
		} else this.#services.set(daemon.id, daemon);
	}
	#refreshServices(): Promise<void> {
		if (this.#serviceRefresh) return this.#serviceRefresh;
		this.#servicePollAt = Date.now() + 500;
		const refresh = Promise.resolve()
			.then(async () => {
				this.#serviceClient ??= await daemonClientForProject(this.#session.sessionManager.getCwd());
				const result = await this.#serviceClient.request({ op: "list" });
				if (result.op !== "list") throw new Error("Unexpected owned-service listing response");
				for (const daemon of result.daemons) if (daemon.owner === this.#sessionOwnerId) this.#recordService(daemon);
				for (const intent of this.#launchIntents.values()) {
					const inspected = await this.#serviceClient.request({
						op: "reconcile_launch",
						launch_intent_id: intent.launch_intent_id,
						session_owner_id: intent.session_owner_id,
						owner_epoch: intent.owner_epoch,
						mode: "inspect",
					});
					if (inspected.op !== "reconcile_launch")
						throw new BotError("cleanup_failed", "Unexpected Bot launch observation");
					this.#callbacks.onLaunchDisposition?.(
						intent.launch_intent_id,
						inspected.disposition,
						this.#cancelled && this.#epochFenced,
					);
					if (inspected.disposition.state === "unknown")
						throw new BotError("cleanup_failed", "Bot launch ownership is uncertain");
					if (inspected.disposition.final) this.#launchIntents.delete(intent.launch_intent_id);
				}
				this.#serviceError = undefined;
				this.#serviceDiscovery = this.#launchIntents.size > 0 && this.#services.size === 0;
				if (!this.#services.size && !this.#serviceCalls.size && !this.#launchIntents.size)
					this.#trackServices = false;
			})
			.catch(error => {
				this.#serviceError = error;
				this.#serviceDiscovery = true;
				this.#emit({
					type: "error",
					error: new BotError("cleanup_failed", "Could not observe owned Bot services"),
				});
			})
			.finally(() => {
				this.#serviceRefresh = undefined;
				this.#sync();
			});
		this.#serviceRefresh = refresh;
		return refresh;
	}
	#artifacts(result: unknown, span: string): void {
		const details = record(record(result)?.details);
		const meta = record(details?.meta);
		const truncation = record(meta?.truncation);
		const id = truncation?.artifactId;
		if (typeof id !== "string" || this.#artifactIds.has(id)) return;
		this.#artifactIds.add(id);
		const task = this.#publishArtifact(id, span)
			.catch(error => {
				this.#emit({ type: "error", error });
			})
			.finally(() => {
				this.#artifactTasks.delete(task);
				this.#sync();
			});
		this.#artifactTasks.add(task);
	}
	async #publishArtifact(id: string, span: string): Promise<void> {
		const artifactPath = await this.#session.sessionManager.getArtifactManager()?.getPath(id);
		if (!artifactPath)
			throw new BotError("internal_error", "Tool published an unavailable artifact", { artifact_id: id });
		const content = await fs.readFile(artifactPath, "utf8");
		this.#emit({
			type: "artifact",
			name: path.basename(artifactPath),
			media_type: "text/plain",
			content,
			producer_span_id: span,
			size_bytes: Buffer.byteLength(content),
		});
	}

	#request(
		kind: BotInputRequest["kind"],
		prompt: unknown,
		options?: ExtensionUIDialogOptions,
		graphOnly = false,
	): Promise<unknown> {
		if (this.#cancelled || this.#stopped || options?.signal?.aborted)
			return Promise.reject(new Error("Bot input cancelled"));
		const question: BotInputRequest = { input_request_id: randomUUID(), kind, prompt };
		const deferred = Promise.withResolvers<unknown>();
		let timer: NodeJS.Timeout | undefined;
		const finish = (value: unknown, error: boolean): void => {
			const pending = this.#questions.get(question.input_request_id);
			if (!pending) return;
			this.#questions.delete(question.input_request_id);
			pending.cleanup();
			this.#emit({ type: "input_resolved", input_request_id: question.input_request_id });
			if (error) deferred.reject(value);
			else deferred.resolve(value);
			this.#sync();
		};
		const complete = async (value: unknown, error: boolean, origin: BotContinuation["origin"]): Promise<void> => {
			const pending = this.#questions.get(question.input_request_id);
			if (!pending || pending.completing)
				throw new BotError("input_request_closed", "Bot question completion is already reserved");
			if (this.#cancelled) {
				finish(value, true);
				return;
			}
			pending.completing = true;
			try {
				await this.#permit(origin, question.input_request_id, value === DIALOG_TIMEOUT ? null : value);
				if (this.#questions.get(question.input_request_id) !== pending) return;
				if (!this.#executionOpen) {
					this.#executionOpen = true;
					this.#emit({ type: "execution_start" });
				}
				if (origin === "timeout") options?.onTimeout?.();
				finish(value, error);
			} catch (cause) {
				if (this.#cancelled) finish(cause, true);
				else pending.completing = false;
				throw cause;
			}
		};
		const automatic = (value: unknown, error: boolean, origin: BotContinuation["origin"]): void => {
			void complete(value, error, origin).catch(cause => {
				if (!this.#cancelled && !(cause instanceof BotError && cause.code === "input_request_closed"))
					this.#emit({
						type: "notice",
						level: "error",
						message: cause instanceof Error ? cause.message : String(cause),
					});
			});
		};
		const abort = (): void => automatic(new Error("Bot dialog cancelled"), true, "dialog_cancel");
		this.#questions.set(question.input_request_id, {
			question,
			completing: false,
			resolve: value => complete(value, false, "reply"),
			reject: error => finish(error, true),
			cleanup: () => {
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", abort);
			},
		});
		options?.signal?.addEventListener("abort", abort, { once: true });
		this.#emit({ type: "input_required", ...question });
		this.#executionOpen = false;
		this.#boundary();
		this.#sync();
		if (options?.timeout !== undefined && options.timeout > 0) {
			options.onTimeoutStart?.();
			timer = setTimeout(() => automatic(DIALOG_TIMEOUT, false, "timeout"), options.timeout);
			timer.unref();
		}
		if (!graphOnly && this.#callbacks.onInput) {
			Promise.resolve()
				.then(() => this.#callbacks.onInput!(question))
				.then(
					value => {
						if (value !== undefined) {
							try {
								automatic(normalizeBotReply(question, value), false, "reply");
							} catch (error) {
								this.#emit({
									type: "notice",
									level: "error",
									message: error instanceof Error ? error.message : "Invalid Bot reply",
								});
							}
						}
					},
					error => automatic(error, true, "dialog_cancel"),
				);
		}
		return deferred.promise;
	}
	#ui(): ExtensionUIContext {
		const ui: Partial<ExtensionUIContext> = {
			supportsEditor: true,
			askDialog: async (questions, options) => this.#ask(questions, options),
			input: async (title, placeholder, options) => {
				const answer = await this.#request("text", { title, placeholder }, options);
				return answer === DIALOG_TIMEOUT ? undefined : String(answer);
			},
			editor: async (title, prefill, options) => {
				const answer = await this.#request("text", { title, prefill }, options);
				return answer === DIALOG_TIMEOUT ? undefined : String(answer);
			},
			select: async (title, choices, options) => {
				const value = await this.#request("text", { title, options: choices }, options);
				if (value === DIALOG_TIMEOUT) return undefined;
				const answer = String(value);
				const labels = choices.map(choice => (typeof choice === "string" ? choice : choice.label));
				if (!labels.includes(answer))
					throw new BotError("invalid_input", "Reply does not match a configured selection");
				return answer;
			},
			confirm: async (title, message, options) => {
				const answer = await this.#request("approval", { title, message }, options);
				return answer === "once";
			},
			approve: async (prompt, options) => {
				const answer = await this.#request("approval", prompt, options);
				return answer === DIALOG_TIMEOUT ? "deny" : (answer as ExtensionApprovalAnswer);
			},
			notify: (message, level = "info") => this.#emit({ type: "notice", level, message }),
			getLinkClicksAvailable: () => false,
		};
		return new Proxy(ui, {
			get(target, key) {
				if (key in target) return Reflect.get(target, key);
				if (key === "openTerminal" || key === "timeoutStartsOnPresentation") return undefined;
				return () => {
					throw new BotError("invalid_state", `Bot runtimes do not support terminal UI operation ${String(key)}`);
				};
			},
		}) as ExtensionUIContext;
	}
	async #ask(
		questions: ExtensionAskDialogQuestion[],
		options?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult> {
		const response = await this.#request("text", { questions }, options);
		if (response === DIALOG_TIMEOUT) return timedOutAskDialogResult(questions);
		const answers = record(response);
		return {
			kind: "submit",
			results: questions.map(question => {
				const value = answers?.[question.id] ?? response;
				const values = Array.isArray(value) ? value : [value];
				const labels = question.options.map(option => option.label);
				const selected = values.filter((item): item is string => typeof item === "string" && labels.includes(item));
				const custom = values
					.filter(item => typeof item !== "string" || !labels.includes(item))
					.map(item => (typeof item === "string" ? item : JSON.stringify(item)))
					.join("\n");
				return {
					id: question.id,
					question: question.question,
					options: labels,
					multi: question.multi ?? false,
					selectedOptions: selected,
					customInput: custom || undefined,
					timedOut: false,
				};
			}),
		};
	}
}

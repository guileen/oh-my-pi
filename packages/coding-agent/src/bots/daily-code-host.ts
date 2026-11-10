import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { parseThinkingLevel, resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDir, prompt, stableStringifyJson, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { exec } from "@oh-my-pi/pi-utils/ptree";
import { readBoundedUtf8 } from "@oh-my-pi/pi-utils/stream";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { assertGrantedToolCall, EXECUTE_GRANTS, validateGrantPattern } from "../graph/workspace-grants";
import { discoverAuthStorage } from "../sdk";
import { writeFileAtomically } from "../utils/atomic-file";
import { createBotRuntime } from "./agent-runtime";
import { parseDailyExecutionInput, parseDailyReview, type DailyExecutionInput } from "./daily-code-input";
import { runDailyCodeWorkflow, type DailyResult, type DailyRound } from "./daily-code-workflow";
import { BotService } from "./service";
import { BotWorker } from "./worker";
import coderPrompt from "../../examples/bots/daily-code/coder.md" with { type: "text" };
import reviewerPrompt from "../../examples/bots/daily-code/reviewer.md" with { type: "text" };
import assignmentPrompt from "./daily-code-assignment.md" with { type: "text" };

interface DailyJournal {
	version: 1;
	digest: string;
	input: DailyExecutionInput;
	phase: string;
	jobs: Array<{ bot: string; job: string }>;
	rounds: DailyRound[];
	result?: DailyResult;
}
export interface DailyHostOptions {
	root?: string;
	cwd?: string;
	signal?: AbortSignal;
	out?: (text: string) => void;
}

function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** No prompt-controlled argv, shell, model fallback, auto-resume, or repository reset. */
export async function executeDailyCode(
	input: DailyExecutionInput,
	key: string,
	options: DailyHostOptions = {},
): Promise<DailyResult & { journal: string }> {
	input = parseDailyExecutionInput(input);
	if (!key.trim() || key.length > 256) throw new Error("request-key must contain 1..256 characters");
	if (!path.isAbsolute(input.workspace)) throw new Error("workspace must be absolute");
	const workspace = await fs.realpath(input.workspace);
	if (!(await fs.stat(workspace)).isDirectory()) throw new Error("workspace must be a directory");
	input = { ...input, workspace };
	for (const [label, patterns] of [
		["read", input.read],
		["write", input.write],
	] as const)
		for (const pattern of patterns) validateGrantPattern(pattern, label);
	const root = path.resolve(options.root ?? path.join(getAgentDir(), "daily-code"));
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const realRoot = await fs.realpath(root);
	if (inside(workspace, realRoot)) throw new Error("Daily-code state must be outside the writable workspace");
	const runDir = path.join(realRoot, Bun.SHA256.hash(key, "hex"));
	await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
	const journalPath = path.join(runDir, "result.json");
	const runLock = tryAcquireFileLock(journalPath);
	if (!runLock)
		return { status: "blocked", reason: "This request key is already running", rounds: [], journal: journalPath };
	try {
		const digest = Bun.SHA256.hash(stableStringifyJson(input), "hex");
		let prior: DailyJournal | undefined;
		try {
			const stored: unknown = await Bun.file(journalPath).json();
			if (!stored || typeof stored !== "object" || Array.isArray(stored))
				throw new Error("Malformed daily-code journal");
			const candidate = stored as Partial<DailyJournal>;
			if (
				candidate.version !== 1 ||
				typeof candidate.digest !== "string" ||
				typeof candidate.phase !== "string" ||
				!Array.isArray(candidate.rounds) ||
				(candidate.result !== undefined &&
					(!candidate.result ||
						!["passed", "blocked"].includes(candidate.result.status) ||
						typeof candidate.result.reason !== "string" ||
						!Array.isArray(candidate.result.rounds)))
			)
				throw new Error("Malformed daily-code journal");
			prior = candidate as DailyJournal;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return {
					status: "blocked",
					reason: `Cannot read prior journal; no work replayed: ${String(error)}`,
					rounds: [],
					journal: journalPath,
				};
			}
		}
		if (prior) {
			if (prior.digest !== digest) throw new Error("request-key conflicts with different input");
			if (prior.result?.status === "passed") {
				const last = prior.result.rounds.at(-1);
				if (
					!last ||
					last.review?.status !== "ready" ||
					!Array.isArray(last.evidence) ||
					last.evidence.length !== input.checks.length ||
					input.checks.some(
						(check, index) => last.evidence[index]?.check !== check || last.evidence[index]?.exitCode !== 0,
					)
				) {
					return {
						status: "blocked",
						reason: "Prior success has no complete acceptance evidence; no work replayed",
						rounds: prior.rounds,
						journal: journalPath,
					};
				}
			}
			return {
				...(prior.result ?? {
					status: "blocked",
					reason: `Unfinished invocation (${prior.phase}); inspect the journal and workspace. No side effects were replayed.`,
					rounds: prior.rounds,
				}),
				journal: journalPath,
			};
		}
		const workspaceLock = tryAcquireFileLock(path.join(realRoot, `workspace-${Bun.SHA256.hash(workspace, "hex")}`));
		if (!workspaceLock)
			return {
				status: "blocked",
				reason: "Another daily-code invocation owns this workspace",
				rounds: [],
				journal: journalPath,
			};
		try {
			return await runHost(input, digest, runDir, journalPath, options);
		} finally {
			workspaceLock.release();
		}
	} finally {
		runLock.release();
	}
}

async function runHost(
	input: DailyExecutionInput,
	digest: string,
	runDir: string,
	journalPath: string,
	options: DailyHostOptions,
): Promise<DailyResult & { journal: string }> {
	const journal: DailyJournal = { version: 1, digest, input, phase: "admitted", jobs: [], rounds: [] };
	const save = async (): Promise<void> => {
		await writeFileAtomically(journalPath, JSON.stringify(journal, null, 2), 0o600, true);
	};
	await save();
	const controller = new AbortController();
	const abort = (): void => controller.abort(options.signal?.reason ?? new Error("Daily-code interrupted"));
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const timer = setTimeout(() => controller.abort(new Error("Daily-code deadline exceeded")), input.timeoutMs);
	let service: BotService | undefined;
	let closeAuth: (() => void) | undefined;
	let currentWorker: BotWorker | undefined;
	let result: DailyResult = { status: "blocked", reason: "Host did not complete", rounds: [] };
	try {
		controller.signal.throwIfAborted();
		const settings = await Settings.loadReadOnly({ cwd: input.workspace, agentDir: getAgentDir() });
		const auth = await discoverAuthStorage(getAgentDir(), { cwd: input.workspace, settings });
		closeAuth = () => auth.close();
		const registry = new ModelRegistry(auth, undefined, { settings });
		const resolve = (role: DailyExecutionInput["coder"] | DailyExecutionInput["reviewer"]): Model => {
			const binding = input.bindings[role.model]!;
			const matches = registry
				.getAvailableForProviders(new Set([binding.provider]))
				.filter(model => model.provider === binding.provider && model.id === binding.model);
			if (matches.length !== 1 || !registry.hasConfiguredAuth(matches[0]))
				throw new Error(`Unavailable exact model binding: ${role.model}`);
			const model = matches[0];
			if ((resolveThinkingLevelForModel(model, parseThinkingLevel(role.thinking)) ?? "off") !== role.thinking)
				throw new Error(`Unsupported thinking level for ${role.model}: ${role.thinking}`);
			return model;
		};
		// Resolve both before the first workspace edit; a missing reviewer must not leave half a run.
		const coderModel = resolve(input.coder);
		const reviewerModel = resolve(input.reviewer);
		service = new BotService(path.join(runDir, "bots"), {
			ensure_worker: async () => {
				if (!currentWorker) throw new Error("Daily-code worker unavailable");
				await currentWorker.tick();
			},
		});
		const bots = service;
		let invocation = 0;
		let previousFeedback: string | null = null;
		const invoke = async (
			role: "coder" | "reviewer",
			feedback: string | null,
			implementation?: string,
		): Promise<string> => {
			controller.signal.throwIfAborted();
			journal.phase = `${role}:${++invocation}`;
			await save();
			const selection = role === "coder" ? input.coder : input.reviewer;
			const model = role === "coder" ? coderModel : reviewerModel;
			const tools = ["read", "grep", "glob", "write", "edit"];
			const bot = await bots.create({
				bot_name: `${role}-${invocation}`,
				cwd: input.workspace,
				system_prompt: role === "coder" ? coderPrompt : reviewerPrompt,
				tools,
				model: `${model.provider}/${model.id}`,
			});
			let final = "";
			const worker = new BotWorker(bots.store, bot.bot_id, async (job, callbacks, runtimeOptions) =>
				createBotRuntime(
					job,
					{
						...callbacks,
						assertDispatch: () => {
							controller.signal.throwIfAborted();
							callbacks.assertDispatch?.();
						},
						onEvent: event => {
							callbacks.onEvent(event);
							if (event.type === "span_start" && event.kind === "model") final = "";
							if (event.type === "output" && event.final) final = event.text;
						},
					},
					{
						...runtimeOptions,
						modelRegistry: registry,
						thinkingLevel: parseThinkingLevel(selection.thinking),
						graph: {
							base: "isolated",
							model,
							appendPrompt: "",
							assertToolCall: context => {
								controller.signal.throwIfAborted();
								return assertGrantedToolCall(
									context,
									{ read: input.read, write: input.write, execute: [] },
									input.workspace,
								);
							},
						},
					},
				),
			);
			currentWorker = worker;
			try {
				if (!worker.claim()) throw new Error("Daily-code worker lease unavailable");
				const receipt = await bots.submit(bot.bot_name, {
					command: "submit",
					key: `${role}-${invocation}`,
					input: prompt.render(assignmentPrompt, {
						task: input.task,
						facts: input.facts,
						userWords: input.userWords,
						workspace: input.workspace,
						feedback,
						implementation,
					}),
				});
				if (!receipt.job_id) throw new Error("Bot did not admit a Job");
				journal.jobs.push({ bot: bot.bot_id, job: receipt.job_id });
				await save();
				for (;;) {
					controller.signal.throwIfAborted();
					await worker.tick();
					const job = bots.store.getJob(bot.bot_id, receipt.job_id);
					if (job.state === "waiting_input") throw new Error("Headless Bot requested human input");
					if (["failed", "stopped", "interrupted", "paused"].includes(job.state))
						throw new Error(`Bot ${job.state}: ${job.error?.message ?? "no confirmed completion"}`);
					if (job.settled) {
						if (job.state !== "idle" || !final.trim()) throw new Error("Bot settled without a final report");
						return final;
					}
					await Bun.sleep(25);
				}
			} finally {
				await worker.close();
				currentWorker = undefined;
			}
		};
		result = await runDailyCodeWorkflow(input, {
			code: async (_input, feedback) => {
				previousFeedback = feedback;
				const report = parseDailyReview(await invoke("coder", feedback));
				if (report.status !== "ready") throw new Error(`Coder ${report.status}: ${report.report}`);
				return report.report;
			},
			review: async (_input, implementation) =>
				parseDailyReview(await invoke("reviewer", previousFeedback, implementation)),
			check: async check => {
				controller.signal.throwIfAborted();
				journal.phase = `acceptance:${check}`;
				await save();
				const argv = [...EXECUTE_GRANTS[check]];
				const observed = await exec(argv, {
					cwd: input.workspace,
					env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" },
					signal: controller.signal,
					timeout: input.timeoutMs,
					detached: process.platform !== "win32",
					subreaper: true,
					allowAbort: true,
					allowNonZero: true,
				});
				return {
					check,
					command: argv.join(" "),
					exitCode: observed.exitError?.aborted || controller.signal.aborted ? null : observed.exitCode,
					output: `${observed.stdout}\n${observed.stderr}`,
				};
			},
			checkpoint: async rounds => {
				journal.rounds = rounds;
				await save();
			},
		});
	} catch (error) {
		result = {
			status: "blocked",
			reason: error instanceof Error ? error.message : String(error),
			rounds: journal.rounds,
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		try {
			await currentWorker?.close();
			await service?.close();
		} catch (error) {
			result = {
				status: "blocked",
				reason: `Cleanup not confirmed: ${error instanceof Error ? error.message : String(error)}; ${result.reason}`,
				rounds: result.rounds,
			};
		} finally {
			try {
				closeAuth?.();
			} catch (error) {
				result = { status: "blocked", reason: `Auth cleanup failed: ${String(error)}`, rounds: result.rounds };
			}
		}
	}
	journal.phase = result.status;
	journal.rounds = result.rounds;
	journal.result = result;
	try {
		await save();
	} catch (error) {
		result = {
			status: "blocked",
			reason: `Final report could not be persisted: ${String(error)}; ${result.reason}`,
			rounds: result.rounds,
		};
	}
	return { ...result, journal: journalPath };
}

export async function runDailyCodeCommand(argv: readonly string[], options: DailyHostOptions = {}): Promise<number> {
	const out = options.out ?? (text => process.stdout.write(text));
	const controller = new AbortController();
	const interrupt = (): void => controller.abort(new Error("Daily-code interrupted"));
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		if (argv[0] !== "daily-code") throw new Error("Unknown daily-code command");
		let file: string | undefined;
		let key: string | undefined;
		let accepted = false;
		const seen = new Set<string>();
		for (let index = 1; index < argv.length; index++) {
			const flag = argv[index];
			if (seen.has(flag)) throw new Error(`Duplicate flag: ${flag}`);
			seen.add(flag);
			if (flag === "--json") continue;
			if (flag === "--accept-workspace-code") {
				accepted = true;
				continue;
			}
			if (flag !== "--input" && flag !== "--request-key") throw new Error(`Unknown flag: ${flag}`);
			const value = argv[++index];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
			if (flag === "--input") file = value;
			else key = value;
		}
		if (!file || !key || !accepted)
			throw new Error(
				"Require --input FILE --request-key KEY --accept-workspace-code; acceptance executes trusted workspace code with your user's authority",
			);
		const input = parseDailyExecutionInput(
			JSON.parse(
				await readBoundedUtf8(Bun.file(path.resolve(options.cwd ?? process.cwd(), file)).stream(), 1024 * 1024),
			),
		);
		const result = await executeDailyCode(input, key, {
			...options,
			signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
		});
		out(`${JSON.stringify(result)}\n`);
		return result.status === "passed" ? 0 : 4;
	} catch (error) {
		out(
			`${JSON.stringify({ status: "blocked", reason: error instanceof Error ? error.message : String(error), rounds: [] })}\n`,
		);
		return 1;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}

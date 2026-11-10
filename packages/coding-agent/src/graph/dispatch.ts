import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isCompiledBinary, workerHostEntry } from "@oh-my-pi/pi-utils";
import { GRAPH_CLI_LIMITS } from "./limits";
import { reportAddressProblem } from "./address";
import { graphInputContract } from "./catalog";
import { validateGraphForStart } from "./definition";
import type { GraphDefinition } from "./contracts";
import { localRunSupport } from "./local-support";
import { GraphRunStore } from "./store";

/** A background dispatch request. Every field is bounded by the policy, not by the caller. */
export interface GraphDispatchRequest {
	request_key: string;
	graph_id: string;
	title: string;
	/** Model bindings file, resolved under the policy workspace. */
	bindings: string;
	/** Run inputs as literal text, keyed by declared input name. */
	inputs: Record<string, string>;
	max_model_calls: number;
	timeout_ms: number;
	report_to?: string;
}

export interface GraphDispatchResult {
	run_id: string;
	request_key: string;
	log_path: string;
}

export class GraphDispatchError extends Error {
	constructor(
		readonly code:
			| "permission_denied"
			| "capability_unavailable"
			| "definition_invalid"
			| "resource_limit"
			| "idempotency_conflict"
			| "internal_error",
		message: string,
	) {
		super(message);
		this.name = "GraphDispatchError";
	}
}

/**
 * Trusted dispatch authority. A Graph definition, a tool call, or an environment
 * variable never grants this: only the host that owns the local profile installs it.
 * Execution stays outside this process so a chat turn never blocks on a Run.
 */
export interface GraphDispatchPolicy {
	principal: string;
	maxModelCalls: number;
	maxTimeoutMs: number;
	dispatch(request: GraphDispatchRequest): Promise<GraphDispatchResult>;
}

const BINDINGS_BYTES = 1024 * 1024;
const INPUTS_BYTES = 1024 * 1024;
const TITLE_CHARS = 200;
const REPORT_CHARS = 200;
const KEY_CHARS = 200;
const INPUT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const START_TIMEOUT_MS = 20_000;

interface LocalDispatchOptions {
	root?: string;
	cwd: string;
	principal?: string;
	maxModelCalls?: number;
	maxTimeoutMs?: number;
	/** Test seam; production resolves the running CLI entrypoint. */
	command?: readonly string[];
	spawn?: typeof Bun.spawn;
}

function ompCommand(): readonly string[] {
	const host = workerHostEntry();
	if (isCompiledBinary()) return [process.execPath];
	if (host) return [process.execPath, host];
	return [process.execPath, path.join(import.meta.dir, "..", "cli.ts")];
}

function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function positive(value: number, limit: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new GraphDispatchError("resource_limit", `${label} must be a positive integer`);
	if (value > limit)
		throw new GraphDispatchError("resource_limit", `${label} exceeds the dispatch ceiling (${limit})`);
	return value;
}

/** Local owner policy: dispatch runs the same foreground CLI in a detached process. */
export function createLocalDispatchPolicy(options: LocalDispatchOptions): GraphDispatchPolicy {
	const principal = options.principal ?? "local-user";
	const maxModelCalls = Math.min(options.maxModelCalls ?? 16, 64);
	const maxTimeoutMs = Math.min(options.maxTimeoutMs ?? 10 * 60_000, 60 * 60_000);
	const cwd = path.resolve(options.cwd);
	const command = options.command ?? ompCommand();
	const spawn = options.spawn ?? Bun.spawn;

	return {
		principal,
		maxModelCalls,
		maxTimeoutMs,
		async dispatch(request) {
			if (!request.request_key || request.request_key.length > KEY_CHARS)
				throw new GraphDispatchError("definition_invalid", "A bounded dispatch request key is required");
			const title = request.title.trim();
			if (!title || title.length > TITLE_CHARS)
				throw new GraphDispatchError("definition_invalid", `A title of 1..${TITLE_CHARS} characters is required`);
			const reportTo = request.report_to?.trim();
			if (reportTo !== undefined && (!reportTo || reportTo.length > REPORT_CHARS))
				throw new GraphDispatchError("definition_invalid", "report_to must be 1..200 characters");
			const addressProblem = reportTo === undefined ? null : reportAddressProblem(reportTo);
			if (addressProblem) throw new GraphDispatchError("definition_invalid", addressProblem);
			const calls = positive(request.max_model_calls, maxModelCalls, "max_model_calls");
			const timeout = positive(request.timeout_ms, maxTimeoutMs, "timeout_ms");

			const entries = Object.entries(request.inputs);
			let bytes = 0;
			for (const [name, content] of entries) {
				if (!INPUT_NAME.test(name))
					throw new GraphDispatchError("definition_invalid", `Invalid input name: ${name}`);
				if (typeof content !== "string")
					throw new GraphDispatchError("definition_invalid", `Input ${name} must be text`);
				bytes += Buffer.byteLength(content, "utf8");
			}
			if (bytes > INPUTS_BYTES) throw new GraphDispatchError("resource_limit", "Dispatch inputs exceed 1 MiB");

			const bindings = path.resolve(cwd, request.bindings);
			if (!within(cwd, bindings))
				throw new GraphDispatchError("permission_denied", "Bindings must live inside the session workspace");
			const staged = await Bun.file(bindings)
				.arrayBuffer()
				.catch(() => {
					throw new GraphDispatchError(
						"definition_invalid",
						`Bindings file is unreadable: ${request.bindings} (resolved ${bindings}; workspace ${cwd})`,
					);
				});
			if (staged.byteLength === 0 || staged.byteLength > BINDINGS_BYTES)
				throw new GraphDispatchError("resource_limit", "Bindings file must be 1 byte..1 MiB");

			const store = new GraphRunStore(GRAPH_CLI_LIMITS, options.root);
			const imported = store.definitions.get(request.graph_id);
			store.close();
			if (!imported) throw new GraphDispatchError("definition_invalid", "Graph is not imported in this profile");
			const validated = validateGraphForStart(imported.content, GRAPH_CLI_LIMITS);
			if (validated.issues.length > 0)
				throw new GraphDispatchError("definition_invalid", validated.issues[0]!.message);
			const definition = validated.source.frontmatter.frontmatter as unknown as GraphDefinition;
			// The Graph contract, not the caller, decides which inputs exist. A Graph with no
			// declared inputs is dispatchable; a missing required input fails before spawn.
			const declared = graphInputContract(definition);
			const known = new Set(declared.map(input => input.name));
			for (const [name] of entries)
				if (!known.has(name))
					throw new GraphDispatchError(
						"definition_invalid",
						`Graph does not accept input: ${name}${known.size ? ` (accepts ${[...known].join(", ")})` : ""}`,
					);
			const missing = declared.filter(input => input.required !== false && !(input.name in request.inputs));
			if (missing.length > 0)
				throw new GraphDispatchError(
					"definition_invalid",
					`Missing required input: ${missing.map(input => input.name).join(", ")}`,
				);
			const support = localRunSupport(definition);
			if (!support.supported)
				throw new GraphDispatchError("capability_unavailable", support.reason ?? "Graph is unsupported locally");
			if (Object.values(definition.nodes).some(node => node.kind === "program"))
				throw new GraphDispatchError(
					"capability_unavailable",
					"Program Graphs require explicit workspace-write and workspace-code approval via the local Graph CLI",
				);

			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-graph-dispatch-"));
			const argv = [
				...command,
				"graph",
				"run",
				request.graph_id,
				"--bindings",
				bindings,
				"--max-model-calls",
				String(calls),
				"--timeout-ms",
				String(timeout),
				"--request-key",
				request.request_key,
				"--title",
				title,
			];
			if (reportTo) argv.push("--report-to", reportTo);
			for (const [name, content] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
				const file = path.join(directory, `${name}.md`);
				await Bun.write(file, content);
				argv.push("--input", `${name}=${file}`);
			}
			const logPath = path.join(directory, "dispatch.log");
			// The child owns the log file descriptor, not a pipe: this process may exit or
			// stop reading without blocking the Run on a full pipe buffer.
			const handle = await fs.open(logPath, "a");
			const child = spawn(argv, {
				cwd,
				stdin: "ignore",
				stdout: handle.fd,
				stderr: handle.fd,
				env: process.env,
				detached: true,
			});
			await handle.close();

			const deadline = Date.now() + START_TIMEOUT_MS;
			let runId: string | null = null;
			while (Date.now() < deadline) {
				const text = await Bun.file(logPath)
					.text()
					.catch(() => "");
				const match = /^Run: (\S+)$/m.exec(text);
				if (match) {
					runId = match[1]!;
					break;
				}
				if (child.exitCode !== null && child.exitCode !== 0) break;
				await Bun.sleep(50);
			}
			if (runId === null) {
				child.kill();
				const tail = await Bun.file(logPath)
					.text()
					.catch(() => "");
				throw new GraphDispatchError(
					"internal_error",
					tail.trim()
						? `Dispatch did not report a Run: ${tail.trim().split("\n").slice(-8).join("\n")}`
						: "Dispatch did not report a Run",
				);
			}
			// The child has already consumed the staged inputs by the time it prints the Run.
			await Promise.all(entries.map(([name]) => fs.rm(path.join(directory, `${name}.md`), { force: true })));
			return { run_id: runId, request_key: request.request_key, log_path: logPath };
		},
	};
}

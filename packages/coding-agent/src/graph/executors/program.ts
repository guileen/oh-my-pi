import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import type { GraphOutput } from "../contracts";
import { LocalArtifactStore, type GraphArtifact } from "../artifacts";
import { readGraphOutputSchema, validateGraphOutputContent } from "../output-validation";

export type ProgramParameter = string | number | boolean | GraphRef;
export type ProgramArg = { literal: string } | { parameter: string; type: "string" | "number" | "boolean" | "ref" };
export interface TrustedProgram {
	executable: string;
	/** Each invocation gets a new private working directory beneath this host-configured directory. */
	workspaceRoot: string;
	/** Complete child environment; explicitly include PATH or other required values. Do not put secrets here. */
	env: Record<string, string>;
	argv: ProgramArg[];
	stdinInput?: string;
	outputs: Record<string, { filename: string; media_type: string }>;
	outcome: string;
	timeoutMs: number;
	/** Host-only workspace check: nonzero exit is a review outcome, not executor failure. */
	workspaceCheck?: { cwd: string; label: string; failureOutcome: string };
}
export interface ProgramExecutionRequest {
	version: 1;
	run_id: string;
	invocation_id: string;
	attempt_id: string;
	fence: string;
	request_key: string;
	executor: string;
	inputs: Record<string, GraphRef | string>;
	task_ref: GraphRef;
	authorization_ref: GraphRef;
	model_binding_ref: null;
	base_snapshot_ref: null;
	duty: string;
	deadline: string | null;
	parameters: Record<string, ProgramParameter>;
	outputs: Record<string, GraphOutput>;
	principal: string;
	output_scope: string[];
	timeout_ms?: number;
}
export type ProgramState = "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface ProgramResult {
	attempt_id: string;
	fence: string;
	state: ProgramState;
	outcome: string | null;
	verdict: null;
	outputs: Record<string, GraphArtifact>;
	error: string | null;
	usage: { tokens: null; cost: null; currency: null };
}
export interface ProgramAccept {
	execution_ref: string | null;
	state: "accepted" | "unknown" | "rejected";
	error: string | null;
}
export interface ProgramExecutorOptions {
	store: LocalArtifactStore;
	/** Host checks the execution grant and all requested output scopes before dispatch. */
	authorize(request: ProgramExecutionRequest): Promise<boolean>;
}
interface Execution {
	result: ProgramResult;
	child: Bun.Subprocess | null;
	stop: "cancel" | "timeout" | null;
	timer: NodeJS.Timeout | null;
	killTimer: NodeJS.Timeout | null;
	done: Promise<void> | null;
}

/** Drain continuously while retaining only the most recent bounded diagnostic bytes. */
function captureCheckOutput(stream: ReadableStream<Uint8Array>): {
	done: Promise<string>;
	cancel: () => void;
} {
	const reader = stream.getReader();
	const limit = 32 * 1024;
	const buffer = Buffer.alloc(limit);
	let length = 0;
	let cursor = 0;
	let truncated = false;
	const done = (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			let chunk = value;
			if (chunk.length >= limit) {
				chunk = chunk.subarray(chunk.length - limit);
				truncated = true;
			}
			if (length + chunk.length > limit) truncated = true;
			const first = Math.min(chunk.length, limit - cursor);
			buffer.set(chunk.subarray(0, first), cursor);
			buffer.set(chunk.subarray(first), 0);
			cursor = (cursor + chunk.length) % limit;
			length = Math.min(limit, length + chunk.length);
		}
		const bytes =
			length < limit
				? buffer.subarray(0, length)
				: Buffer.concat([buffer.subarray(cursor), buffer.subarray(0, cursor)]);
		return `${truncated ? "[Earlier output truncated]\n" : ""}${bytes.toString("utf8")}`;
	})();
	return {
		done,
		cancel: () => {
			void reader.cancel().catch(() => {});
		},
	};
}

/** Registry is constructed only from trusted host configuration; it provides no graph-facing registration API. */
export class TrustedProgramExecutor {
	readonly #registry = new Map<string, TrustedProgram>();
	readonly #executions = new Map<string, Execution>();
	readonly #attempts = new Set<string>();
	constructor(
		programs: Readonly<Record<string, TrustedProgram>>,
		private readonly options: ProgramExecutorOptions,
	) {
		for (const [name, entry] of Object.entries(programs)) {
			if (
				!name ||
				!path.isAbsolute(entry.executable) ||
				!path.isAbsolute(entry.workspaceRoot) ||
				!entry.outcome ||
				!Number.isSafeInteger(entry.timeoutMs) ||
				entry.timeoutMs <= 0
			)
				throw new Error(`Invalid trusted program ${name}`);
			if (
				entry.workspaceCheck &&
				(!path.isAbsolute(entry.workspaceCheck.cwd) ||
					!entry.workspaceCheck.label ||
					!entry.workspaceCheck.failureOutcome)
			)
				throw new Error(`Invalid workspace check ${name}`);
			if (
				!entry.env ||
				typeof entry.env !== "object" ||
				Array.isArray(entry.env) ||
				Object.entries(entry.env).some(
					([key, value]) => !key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0"),
				)
			)
				throw new Error(`Invalid environment for trusted program ${name}`);
			const filenames = new Set<string>();
			for (const output of Object.values(entry.outputs)) {
				if (
					!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(output.filename) ||
					filenames.has(output.filename) ||
					!output.media_type
				)
					throw new Error(`Invalid output configuration for ${name}`);
				filenames.add(output.filename);
			}
			this.#registry.set(name, structuredClone(entry));
		}
	}

	/**
	 * Identify the registered configuration for a trusted preflight to freeze.
	 * This covers configuration values only, not executable or script bytes, and
	 * is neither an authorization grant nor proof of process isolation.
	 */
	registrationRef(name: string): GraphRef | null {
		const program = this.#registry.get(name);
		if (!program) return null;
		const content = canonicalJson({ kind: "graph-program-registration-v1", name, program });
		return { id: name, digest: `sha256:${Bun.SHA256.hash(content, "hex")}` };
	}

	/** Compare a frozen reference with the current host-owned registration. */
	verifyRegistration(name: string, frozen: GraphRef): boolean {
		const current = this.registrationRef(name);
		return current !== null && frozen?.id === current.id && frozen?.digest === current.digest;
	}

	async accept(request: ProgramExecutionRequest): Promise<ProgramAccept> {
		request = structuredClone(request);
		const program = this.#registry.get(request.executor);
		if (!program) return { execution_ref: null, state: "rejected", error: "Unknown program executor" };
		if ((await this.options.authorize(structuredClone(request))) !== true)
			return { execution_ref: null, state: "rejected", error: "Program execution denied" };
		const attemptKey = JSON.stringify([request.run_id, request.attempt_id]);
		if (this.#attempts.has(attemptKey))
			return {
				execution_ref: null,
				state: "unknown",
				error: "Attempt already dispatched; reconcile the original execution",
			};
		let argv: string[];
		try {
			if (request.version !== 1 || request.model_binding_ref !== null || request.base_snapshot_ref !== null)
				throw new Error("Invalid program execution envelope");
			if (typeof request.fence !== "string" || !/^[0-9]+$/.test(request.fence))
				throw new Error("Invalid execution fence");
			if (request.timeout_ms !== undefined && (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms <= 0))
				throw new Error("Invalid timeout");
			if (request.deadline !== null && !Number.isFinite(Date.parse(request.deadline)))
				throw new Error("Invalid deadline");
			for (const [name, declaration] of Object.entries(request.outputs)) {
				const configured = program.outputs[name];
				if (!configured || configured.media_type !== declaration.media_type)
					throw new Error(`Output ${name} is not registered with its declared media type`);
				await readGraphOutputSchema(declaration, request.principal, this.options.store);
			}
			argv = program.argv.map(slot => {
				if ("literal" in slot) return slot.literal;
				const value = request.parameters[slot.parameter];
				if (slot.type === "ref") {
					if (
						!value ||
						typeof value !== "object" ||
						typeof value.id !== "string" ||
						typeof value.digest !== "string"
					)
						throw new Error(`Invalid parameter ${slot.parameter}`);
					return `${value.id}@${value.digest}`;
				}
				if (typeof value !== slot.type || (typeof value === "number" && !Number.isFinite(value)))
					throw new Error(`Invalid parameter ${slot.parameter}`);
				return String(value);
			});
			const allowed = new Set(program.argv.flatMap(slot => ("parameter" in slot ? [slot.parameter] : [])));
			if (Object.keys(request.parameters).some(key => !allowed.has(key)))
				throw new Error("Unregistered program parameter");
		} catch (error) {
			return { execution_ref: null, state: "rejected", error: String(error) };
		}
		// The host must persist dispatch intent before calling accept. This in-memory ledger is not a recovery broker.
		this.#attempts.add(attemptKey);
		const id = crypto.randomUUID();
		const execution: Execution = {
			result: {
				attempt_id: request.attempt_id,
				fence: request.fence,
				state: "accepted",
				outcome: null,
				verdict: null,
				outputs: {},
				error: null,
				usage: { tokens: null, cost: null, currency: null },
			},
			child: null,
			stop: null,
			timer: null,
			killTimer: null,
			done: null,
		};
		this.#executions.set(id, execution);
		execution.done = this.#run(execution, program, request, argv);
		return { execution_ref: id, state: "accepted", error: null };
	}

	query(executionRef: string): ProgramResult | null {
		const execution = this.#executions.get(executionRef);
		return execution ? structuredClone(execution.result) : null;
	}

	/** Waits for local process observation and output publication, not recovery after a host restart. */
	async wait(executionRef: string): Promise<ProgramResult | null> {
		const execution = this.#executions.get(executionRef);
		if (!execution) return null;
		await execution.done;
		return structuredClone(execution.result);
	}

	cancel(executionRef: string): ProgramState {
		const execution = this.#executions.get(executionRef);
		if (!execution) return "unknown";
		if (execution.result.state !== "accepted" && execution.result.state !== "running") return execution.result.state;
		this.#stop(execution, "cancel");
		return execution.result.state;
	}

	#stop(execution: Execution, reason: "cancel" | "timeout"): void {
		if (execution.stop) return;
		execution.stop = reason;
		if (!execution.child) {
			execution.result.state = "unknown";
			execution.result.error = "Cancellation or timeout is pending local reconciliation";
			return;
		}
		try {
			execution.child.kill("SIGTERM");
		} catch {
			/* close or the uncertainty timer decides */
		}
		execution.killTimer = setTimeout(() => {
			try {
				execution.child?.kill("SIGKILL");
			} catch {
				/* process state remains unconfirmed */
			}
			execution.killTimer = setTimeout(() => {
				if (execution.child) {
					execution.result.state = "unknown";
					execution.result.error = "Process termination not confirmed";
				}
			}, 5000);
		}, 1000);
	}

	async #run(
		execution: Execution,
		program: TrustedProgram,
		request: ProgramExecutionRequest,
		argv: string[],
	): Promise<void> {
		let workspace: string | null = null;
		let cleanup = true;
		try {
			const timeout = Math.min(
				program.timeoutMs,
				request.timeout_ms ?? Infinity,
				request.deadline === null ? Infinity : Date.parse(request.deadline) - Date.now(),
			);
			if (timeout <= 0) throw new Error("Program deadline elapsed");
			execution.timer = setTimeout(() => this.#stop(execution, "timeout"), Math.min(timeout, 2_147_483_647));
			let stdin: Uint8Array = new Uint8Array();
			if (program.stdinInput) {
				const input = request.inputs[program.stdinInput];
				if (input === undefined) throw new Error(`Missing stdin input ${program.stdinInput}`);
				stdin =
					typeof input === "string" ? Buffer.from(input) : await this.options.store.read(request.principal, input);
			}
			workspace =
				program.workspaceCheck?.cwd ?? (await fsp.mkdtemp(path.join(program.workspaceRoot, "graph-program-")));
			// Preparation can await I/O; recheck grants before invoking an external program.
			// The trusted host must still fence revocation against spawn and contain processes.
			if ((await this.options.authorize(structuredClone(request))) !== true)
				throw new Error("Program execution denied");
			if (execution.stop) {
				execution.result.state = execution.stop === "cancel" ? "cancelled" : "failed";
				execution.result.error = execution.stop === "timeout" ? "Program timed out" : null;
				return;
			}
			const child = Bun.spawn([program.executable, ...argv], {
				cwd: workspace,
				env: program.env,
				stdin,
				stdout: program.workspaceCheck ? "pipe" : "ignore",
				stderr: program.workspaceCheck ? "pipe" : "ignore",
			});
			const captures = program.workspaceCheck
				? [
						captureCheckOutput(child.stdout as ReadableStream<Uint8Array>),
						captureCheckOutput(child.stderr as ReadableStream<Uint8Array>),
					]
				: [];
			const captured = Promise.all(captures.map(capture => capture.done)).then(
				values => ({ values, error: null }),
				error => ({ values: null, error: String(error) }),
			);
			execution.child = child;
			execution.result.state = "running";
			const code = await child.exited;
			const signal = child.signalCode;
			execution.child = null;
			if (execution.stop) {
				for (const capture of captures) capture.cancel();
				execution.result.state = signal ? (execution.stop === "cancel" ? "cancelled" : "failed") : "unknown";
				execution.result.error =
					execution.result.state === "unknown"
						? "Process completed concurrently with termination; reconcile effects"
						: execution.stop === "timeout"
							? "Program timed out"
							: null;
				return;
			}
			if (signal) {
				for (const capture of captures) capture.cancel();
				throw new Error(`Program terminated by signal ${signal}`);
			}
			if (code !== 0 && !program.workspaceCheck) throw new Error(`Program exited with code ${code}`);
			if (program.workspaceCheck) {
				const timeout = Promise.withResolvers<null>();
				const outputTimer = setTimeout(() => timeout.resolve(null), 1000);
				const output = await Promise.race([captured, timeout.promise]);
				clearTimeout(outputTimer);
				if (!output || output.error || !output.values || execution.stop) {
					for (const capture of captures) capture.cancel();
					execution.result.state = "unknown";
					execution.result.error = output?.error ?? "Check output could not be fully observed";
					return;
				}
				const declaration = request.outputs.evidence;
				if (!declaration || Object.keys(request.outputs).length !== 1)
					throw new Error("Workspace check requires exactly one evidence output");
				const artifact = await this.options.store.publish(
					request.principal,
					Buffer.from(
						`Approved workspace check: ${program.workspaceCheck.label}\nWorkspace: ${program.workspaceCheck.cwd}\nExit code: ${code}\n\nStdout (untrusted workspace output):\n${output.values[0]}\n\nStderr (untrusted workspace output):\n${output.values[1]}\n`,
					),
					{
						media_type: declaration.media_type,
						producer_attempt_id: request.attempt_id,
						source_ref: null,
						access_scope: request.output_scope,
					},
				);
				if (execution.stop) {
					execution.result.state = "unknown";
					execution.result.error = "Termination requested during output publication";
					return;
				}
				execution.result.outputs = { evidence: artifact };
				execution.result.outcome = code === 0 ? program.outcome : program.workspaceCheck.failureOutcome;
				execution.result.state = "succeeded";
				return;
			}
			const outputs: Record<string, GraphArtifact> = {};
			for (const [name, declaration] of Object.entries(request.outputs)) {
				const configured = program.outputs[name];
				let file;
				try {
					file = await fsp.open(
						path.join(workspace, configured.filename),
						fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
					);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT" && !declaration.required) continue;
					throw new Error(`Output ${name} unavailable: ${String(error)}`);
				}
				try {
					if (!(await file.stat()).isFile()) throw new Error(`Output ${name} is not a regular file`);
					outputs[name] = await this.options.store.publish(
						request.principal,
						file.createReadStream({ autoClose: false }),
						{
							media_type: declaration.media_type,
							producer_attempt_id: request.attempt_id,
							source_ref: null,
							access_scope: request.output_scope,
						},
						declaration.schema_ref
							? bytes => validateGraphOutputContent(declaration, bytes, request.principal, this.options.store)
							: undefined,
					);
				} finally {
					await file.close();
				}
			}
			if (execution.stop) {
				execution.result.state = "unknown";
				execution.result.error = "Termination requested during output publication";
				return;
			}
			execution.result.outputs = outputs;
			execution.result.outcome = program.outcome;
			execution.result.state = "succeeded";
		} catch (error) {
			execution.result.state = execution.child ? "unknown" : "failed";
			execution.result.error = String(error);
			cleanup = !execution.child;
		} finally {
			clearTimeout(execution.timer ?? undefined);
			clearTimeout(execution.killTimer ?? undefined);
			if (workspace && cleanup && !program.workspaceCheck)
				await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
		}
	}
}

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileLock, IpcConnection } from "@oh-my-pi/pi-natives";
import { OWNED_SUPERVISOR_WORKER_ARG } from "../cli/worker-selectors";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import {
	authenticateConfig,
	configPath,
	hasStarted,
	normalizeSpec,
	OWNED_SUPERVISOR_DIR_ENV,
	OWNED_SUPERVISOR_MAX_FRAME_BYTES,
	parseOperation,
	parseStatus,
	readConfig,
	readTerminal,
	record,
	supervisorEndpoint,
	validateRef,
	writeDurableJson,
	type OwnedSupervisorConfig,
	type OwnedSupervisorIdentity,
	type OwnedSupervisorOperation,
	type OwnedSupervisorRef,
	type OwnedSupervisorSpec,
	type OwnedSupervisorStatus,
} from "./owned-supervisor-protocol";

export type {
	OwnedSupervisorIdentity,
	OwnedSupervisorRef,
	OwnedSupervisorSpec,
	OwnedSupervisorStatus,
} from "./owned-supervisor-protocol";

export interface OwnedSupervisorSignalResult {
	delivered: boolean;
	status: OwnedSupervisorStatus;
}

export interface OwnedSupervisorClient {
	status(): Promise<OwnedSupervisorStatus>;
	signal(signal: number, group?: boolean): Promise<OwnedSupervisorSignalResult>;
	input(data: string): Promise<OwnedSupervisorStatus>;
	close(): void;
}

/** Parse private broker metadata without retaining unrelated untrusted fields. */
export function parseOwnedSupervisorRef(value: unknown): OwnedSupervisorRef {
	validateRef(value);
	return { dir: value.dir, generation: value.generation, token: value.token, endpoint: value.endpoint };
}

/** Persist capability and immutable launch spec before the broker publishes its reference. */
export async function prepareOwnedSupervisor(
	dir: string,
	spec: OwnedSupervisorSpec,
	identity: OwnedSupervisorIdentity,
): Promise<OwnedSupervisorRef> {
	dir = path.resolve(dir);
	const token = randomBytes(32).toString("hex");
	const ref = { dir, generation: identity.generation, token, endpoint: supervisorEndpoint(dir) };
	validateRef(ref);
	const normalized = normalizeSpec(dir, spec);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
	const lock = FileLock.tryAcquire(path.join(dir, "owned-supervisor.prepare.lock"));
	if (!lock.acquired) throw new Error("Owned supervisor preparation is already in progress");
	try {
		if (fs.existsSync(configPath(dir))) {
			const existing = readConfig(dir);
			if (
				existing.generation !== identity.generation ||
				JSON.stringify(existing.spec) !== JSON.stringify(normalized)
			) {
				throw new Error("Owned supervisor generation specification conflict");
			}
			return { dir, generation: existing.generation, token: existing.token, endpoint: existing.endpoint };
		}
		if (hasStarted(dir)) throw new Error("Owned supervisor intent exists without its configuration");
		const config: OwnedSupervisorConfig = { ...ref, version: 1, spec: normalized };
		writeDurableJson(configPath(dir), config);
		return ref;
	} finally {
		lock.release();
	}
}

/**
 * Starts only the owner worker, never adopts a PID. Repeated calls before its
 * durable intent are fenced by the worker lock; an existing intent is never
 * restarted, even when the owner disappeared and the outcome is unknown.
 */
export function launchOwnedSupervisor(ref: OwnedSupervisorRef): void {
	authenticateConfig(ref);
	if (process.platform === "win32") throw new Error("Owned application supervision is unsupported on Windows");
	if (hasStarted(ref.dir)) return;
	const launch = resolveWorkerSpawnCmd(OWNED_SUPERVISOR_WORKER_ARG);
	const child = Bun.spawn(launch.cmd, {
		cwd: launch.cwd,
		env: workerEnvFromParent({ [OWNED_SUPERVISOR_DIR_ENV]: ref.dir }),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
		windowsHide: true,
	});
	child.unref();
}

function boundedTimeout(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		throw new Error("Owned supervisor timeout must be between 1 and 30000ms");
	}
	return Math.ceil(timeoutMs);
}

interface PendingRequest {
	resolve: (result: OwnedSupervisorSignalResult) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** Connection and every request have independent bounded timeouts; no reconnect starts an application. */
export async function connectOwnedSupervisor(
	ref: OwnedSupervisorRef,
	timeoutMs = 1000,
): Promise<OwnedSupervisorClient> {
	validateRef(ref);
	timeoutMs = boundedTimeout(timeoutMs);
	const socket = await IpcConnection.connect(ref.endpoint, {
		framing: "lines",
		maxFrameBytes: OWNED_SUPERVISOR_MAX_FRAME_BYTES,
		timeoutMs,
	});
	const pending = new Map<string, PendingRequest>();
	let closed = false;
	const close = (): void => {
		closed = true;
		socket.destroy();
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("Owned supervisor connection closed"));
		}
		pending.clear();
	};
	socket.start(line => {
		try {
			const message: unknown = JSON.parse(line);
			if (!record(message) || typeof message.id !== "string") throw new Error("Invalid supervisor reply");
			const request = pending.get(message.id);
			if (!request) return;
			if (message.ok !== true) {
				pending.delete(message.id);
				clearTimeout(request.timer);
				request.reject(
					new Error(typeof message.error === "string" ? message.error : "Owned supervisor rejected request"),
				);
				return;
			}
			const status = parseStatus(message.status, ref.generation);
			if (typeof message.delivered !== "boolean") throw new Error("Invalid supervisor signal result");
			pending.delete(message.id);
			clearTimeout(request.timer);
			request.resolve({ status, delivered: message.delivered });
		} catch {
			close();
		}
	}, close);
	const request = (operation: OwnedSupervisorOperation): Promise<OwnedSupervisorSignalResult> => {
		parseOperation(operation);
		if (closed) return Promise.reject(new Error("Owned supervisor connection closed"));
		const id = crypto.randomUUID();
		const frame = JSON.stringify({ version: 1, id, generation: ref.generation, token: ref.token, operation });
		if (Buffer.byteLength(frame) > OWNED_SUPERVISOR_MAX_FRAME_BYTES) {
			return Promise.reject(new Error("Owned supervisor request exceeds the frame limit"));
		}
		const { promise, resolve, reject } = Promise.withResolvers<OwnedSupervisorSignalResult>();
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error("Owned supervisor request timed out; outcome is unknown"));
			// Do not retry writes/signals: a timed-out operation may have been delivered.
			close();
		}, timeoutMs);
		pending.set(id, { resolve, reject, timer });
		if (!socket.send(frame)) close();
		return promise;
	};
	const client: OwnedSupervisorClient = {
		status: async () => (await request({ op: "status" })).status,
		signal: (signal, group = false) => request({ op: "signal", signal, group }),
		input: async data => (await request({ op: "input", data })).status,
		close,
	};
	try {
		// Authenticate before handing a usable connection to the caller.
		await client.status();
		return client;
	} catch (error) {
		close();
		throw error;
	}
}

/** Live authenticated state, or capability-bound durable outcome. Never proves exit from a PID probe. */
export async function queryOwnedSupervisor(ref: OwnedSupervisorRef, timeoutMs = 1000): Promise<OwnedSupervisorStatus> {
	boundedTimeout(timeoutMs);
	const config = authenticateConfig(ref);
	let client: OwnedSupervisorClient | undefined;
	try {
		client = await connectOwnedSupervisor(ref, timeoutMs);
		return await client.status();
	} catch {
		try {
			const terminal = readTerminal(config);
			if (terminal) return terminal;
		} catch {
			return {
				generation: ref.generation,
				state: "unknown",
				pid: null,
				exitCode: null,
				signal: null,
				error: "Owned supervisor terminal record is unavailable or unauthenticated",
			};
		}
		return {
			generation: ref.generation,
			state: hasStarted(ref.dir) ? "unknown" : "prepared",
			pid: null,
			exitCode: null,
			signal: null,
		};
	} finally {
		client?.close();
	}
}

export async function signalOwnedSupervisor(
	ref: OwnedSupervisorRef,
	signal: number,
	group = false,
	timeoutMs = 1000,
): Promise<OwnedSupervisorSignalResult> {
	parseOperation({ op: "signal", signal, group });
	boundedTimeout(timeoutMs);
	const config = authenticateConfig(ref);
	const terminal = readTerminal(config);
	if (terminal?.state === "exited") return { delivered: false, status: terminal };
	let client: OwnedSupervisorClient | undefined;
	try {
		client = await connectOwnedSupervisor(ref, timeoutMs);
		return await client.signal(signal, group);
	} catch (error) {
		// Completion may race connection/signal delivery. Only authenticated
		// durable exit proves there is no longer an owned child to signal.
		const completed = readTerminal(config);
		if (completed?.state === "exited") return { delivered: false, status: completed };
		throw error;
	} finally {
		client?.close();
	}
}

export async function sendOwnedSupervisorInput(
	ref: OwnedSupervisorRef,
	data: string,
	timeoutMs = 1000,
): Promise<OwnedSupervisorStatus> {
	parseOperation({ op: "input", data });
	boundedTimeout(timeoutMs);
	authenticateConfig(ref);
	const client = await connectOwnedSupervisor(ref, timeoutMs);
	try {
		return await client.input(data);
	} finally {
		client.close();
	}
}

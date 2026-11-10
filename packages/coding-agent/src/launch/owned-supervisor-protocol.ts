import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { writeFileAtomicallySync } from "../utils/atomic-file";

export const OWNED_SUPERVISOR_DIR_ENV = "OMP_OWNED_SUPERVISOR_DIR";
export const OWNED_SUPERVISOR_MAX_FRAME_BYTES = 64 * 1024;
export const OWNED_SUPERVISOR_MAX_INPUT_BYTES = 16 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const CONFIG_FILE = "owned-supervisor.json";
const INTENT_FILE = "owned-supervisor.started";
const TERMINAL_FILE = "owned-supervisor.exit.json";

export interface OwnedSupervisorIdentity {
	generation: string;
}

export interface OwnedSupervisorSpec {
	application: string;
	args: string[];
	cwd: string;
	/** Exact application environment; supervisor credentials are never overlaid. */
	env: Record<string, string>;
	outputPath?: string;
	/** Optional native rotating-output pair; both fields must be supplied together. */
	maxOutputBytes?: number;
	previousOutputPath?: string;
}

export interface OwnedSupervisorRef extends OwnedSupervisorIdentity {
	dir: string;
	token: string;
	endpoint: string;
}

export interface OwnedSupervisorStatus extends OwnedSupervisorIdentity {
	/** prepared is nonterminal: an already-launched supervisor may still start the application. */
	state: "prepared" | "running" | "exited" | "unknown";
	/** Diagnostic only. Never use this PID to adopt or signal a process. */
	pid: number | null;
	exitCode: number | null;
	signal: number | null;
	error?: string;
}

export interface OwnedSupervisorLaunchSpec extends OwnedSupervisorSpec {
	outputPath: string;
}

export interface OwnedSupervisorConfig extends OwnedSupervisorRef {
	version: 1;
	spec: OwnedSupervisorLaunchSpec;
}

export type OwnedSupervisorOperation =
	| { op: "status" }
	| { op: "signal"; signal: number; group: boolean }
	| { op: "input"; data: string };

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 1024 * 1024): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

export function capabilityEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function supervisorEndpoint(dir: string): string {
	return ipcEndpoint(dir, "owned-supervisor");
}

export function validateRef(value: unknown): asserts value is OwnedSupervisorRef {
	if (
		!record(value) ||
		!text(value.dir) ||
		!path.isAbsolute(value.dir) ||
		!text(value.generation, 256) ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.token) ||
		value.endpoint !== supervisorEndpoint(value.dir)
	) {
		throw new Error("Invalid owned supervisor identity");
	}
}

export function normalizeSpec(dir: string, spec: OwnedSupervisorSpec): OwnedSupervisorLaunchSpec {
	if (
		!record(spec) ||
		!text(spec.application) ||
		!Array.isArray(spec.args) ||
		!spec.args.every(arg => typeof arg === "string" && !arg.includes("\0")) ||
		!text(spec.cwd) ||
		!record(spec.env) ||
		(spec.outputPath !== undefined && !text(spec.outputPath)) ||
		(spec.maxOutputBytes === undefined) !== (spec.previousOutputPath === undefined) ||
		(spec.maxOutputBytes !== undefined && (!Number.isSafeInteger(spec.maxOutputBytes) || spec.maxOutputBytes <= 0)) ||
		(spec.previousOutputPath !== undefined && !text(spec.previousOutputPath))
	) {
		throw new Error("Invalid owned supervisor application specification");
	}
	const env: Record<string, string> = Object.create(null);
	for (const key of Object.keys(spec.env).sort()) {
		const value = spec.env[key];
		if (!text(key) || key.includes("=") || typeof value !== "string" || value.includes("\0")) {
			throw new Error("Invalid owned supervisor application environment");
		}
		env[key] = value;
	}
	const normalized: OwnedSupervisorLaunchSpec = {
		application: spec.application,
		args: [...spec.args],
		cwd: path.resolve(spec.cwd),
		env,
		outputPath: path.resolve(spec.outputPath ?? path.join(dir, "output.log")),
	};
	if (spec.maxOutputBytes !== undefined && spec.previousOutputPath !== undefined) {
		normalized.maxOutputBytes = spec.maxOutputBytes;
		normalized.previousOutputPath = path.resolve(spec.previousOutputPath);
		if (normalized.previousOutputPath === normalized.outputPath) {
			throw new Error("Owned supervisor output paths must be distinct");
		}
	}
	if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_CONFIG_BYTES - 4096) {
		throw new Error("Owned supervisor application specification is too large");
	}
	return normalized;
}

export function readJsonBounded(file: string, maxBytes: number): unknown {
	const fd = fs.openSync(file, "r");
	try {
		const sizeLimit = fs.fstatSync(fd).size;
		if (sizeLimit > maxBytes) throw new Error("Owned supervisor file exceeds size limit");
		const buffer = Buffer.alloc(sizeLimit + 1);
		let size = 0;
		while (size < buffer.length) {
			const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
			if (count === 0) break;
			size += count;
		}
		if (size > sizeLimit) throw new Error("Owned supervisor file changed while reading");
		return JSON.parse(buffer.toString("utf8", 0, size));
	} finally {
		fs.closeSync(fd);
	}
}

function syncDirectory(dir: string): void {
	// node:fs cannot fsync a Windows directory. OwnedChild rejects spawn there.
	if (process.platform === "win32") return;
	const fd = fs.openSync(dir, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/** Private replace writes share the central atomic-file publication semantics. */
export function writeDurableJson(file: string, value: unknown): void {
	writeFileAtomicallySync(file, JSON.stringify(value), 0o600, true);
}

export function configPath(dir: string): string {
	return path.join(dir, CONFIG_FILE);
}

export function readConfig(dir: string): OwnedSupervisorConfig {
	const value = readJsonBounded(configPath(dir), MAX_CONFIG_BYTES);
	validateRef(value);
	if (!record(value) || value.version !== 1 || value.dir !== path.resolve(dir) || !record(value.spec)) {
		throw new Error("Invalid owned supervisor configuration");
	}
	const spec = normalizeSpec(dir, value.spec as unknown as OwnedSupervisorSpec);
	return { ...value, version: 1, spec };
}

export function authenticateConfig(ref: OwnedSupervisorRef): OwnedSupervisorConfig {
	validateRef(ref);
	const config = readConfig(ref.dir);
	if (config.generation !== ref.generation || !capabilityEqual(config.token, ref.token)) {
		throw new Error("Owned supervisor authentication failed");
	}
	return config;
}

export function hasStarted(dir: string): boolean {
	for (const name of [INTENT_FILE, TERMINAL_FILE]) {
		try {
			fs.lstatSync(path.join(dir, name));
			return true;
		} catch (error) {
			if (!record(error) || error.code !== "ENOENT") throw error;
		}
	}
	return false;
}

function signature(config: OwnedSupervisorRef, value: unknown): string {
	return createHmac("sha256", config.token).update(JSON.stringify(value)).digest("hex");
}

export function writeStarted(config: OwnedSupervisorConfig): void {
	const intent = { version: 1, generation: config.generation };
	const file = path.join(config.dir, INTENT_FILE);
	const fd = fs.openSync(file, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify({ ...intent, signature: signature(config, intent) }));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	// Even a torn intent remains a permanent fence against a second spawn.
	syncDirectory(config.dir);
}

export function parseStatus(value: unknown, generation: string): OwnedSupervisorStatus {
	if (
		!record(value) ||
		value.generation !== generation ||
		!["prepared", "running", "exited", "unknown"].includes(String(value.state)) ||
		!(value.pid === null || (Number.isSafeInteger(value.pid) && Number(value.pid) > 0)) ||
		!(value.exitCode === null || Number.isSafeInteger(value.exitCode)) ||
		!(value.signal === null || (Number.isSafeInteger(value.signal) && Number(value.signal) > 0)) ||
		!(value.error === undefined || (typeof value.error === "string" && value.error.length <= 4096)) ||
		(value.state !== "exited" && (value.exitCode !== null || value.signal !== null)) ||
		(value.state === "exited" && (value.exitCode === null) === (value.signal === null)) ||
		(value.state === "running" && value.pid === null)
	) {
		throw new Error("Invalid owned supervisor status");
	}
	return value as unknown as OwnedSupervisorStatus;
}

export function writeTerminal(config: OwnedSupervisorConfig, status: OwnedSupervisorStatus): void {
	if (status.state !== "exited" && status.state !== "unknown") throw new Error("Supervisor outcome is not terminal");
	const payload = { version: 1, status };
	writeDurableJson(path.join(config.dir, TERMINAL_FILE), { ...payload, signature: signature(config, payload) });
}

export function readTerminal(config: OwnedSupervisorConfig): OwnedSupervisorStatus | undefined {
	let value: unknown;
	try {
		value = readJsonBounded(path.join(config.dir, TERMINAL_FILE), OWNED_SUPERVISOR_MAX_FRAME_BYTES);
	} catch (error) {
		if (record(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
	if (!record(value) || value.version !== 1 || typeof value.signature !== "string") {
		throw new Error("Invalid owned supervisor terminal record");
	}
	const payload = { version: 1, status: value.status };
	if (!capabilityEqual(value.signature, signature(config, payload))) {
		throw new Error("Owned supervisor terminal authentication failed");
	}
	const status = parseStatus(value.status, config.generation);
	if (status.state !== "exited" && status.state !== "unknown") throw new Error("Invalid supervisor terminal state");
	return status;
}

export function parseOperation(value: unknown): OwnedSupervisorOperation {
	if (record(value)) {
		const keys = Object.keys(value).sort().join(",");
		if (value.op === "status" && keys === "op") return { op: "status" };
		if (
			value.op === "signal" &&
			keys === "group,op,signal" &&
			Number.isInteger(value.signal) &&
			Number(value.signal) >= 1 &&
			Number(value.signal) <= 64 &&
			typeof value.group === "boolean"
		)
			return { op: "signal", signal: Number(value.signal), group: value.group };
		if (
			value.op === "input" &&
			keys === "data,op" &&
			typeof value.data === "string" &&
			Buffer.byteLength(value.data) <= OWNED_SUPERVISOR_MAX_INPUT_BYTES
		)
			return { op: "input", data: value.data };
	}
	throw new Error("Invalid owned supervisor operation");
}

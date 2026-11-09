import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	freezeIntegration,
	runFrozenAcceptance,
	type AcceptanceEvidence,
	type AcceptanceHost,
	type AcceptanceRequest,
	type FrozenIntegration,
	type IntegrationEntry,
	type IntegrationSnapshot,
} from "./subgraph-freeze";

/** Trusted host configuration: roots must cover every authoritative file, including
 * tests and checked-in baselines. Runtime output belongs outside these roots. */
export interface LocalIntegrationScope {
	workspace: string;
	source: readonly string[];
	specification: readonly string[];
	upstream: readonly string[];
	maxFiles: number;
	maxBytes: number;
}

function stable(a: fs.Stats, b: fs.Stats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mode === b.mode &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs
	);
}

/**
 * Captures full trees without following symlinks. Special files and symlinks are
 * rejected: hashing link text would not protect the external target actually read
 * by a test. Metadata checks detect ordinary concurrent changes, not an adversary
 * racing filesystem operations; callers still need a quiescent protected view.
 */
export async function captureLocalIntegration(scope: LocalIntegrationScope): Promise<IntegrationSnapshot> {
	if (
		!Number.isSafeInteger(scope.maxFiles) ||
		scope.maxFiles < 1 ||
		!Number.isSafeInteger(scope.maxBytes) ||
		scope.maxBytes < 1
	)
		throw new Error("Invalid snapshot limits");
	if (!path.isAbsolute(scope.workspace)) throw new Error("Workspace must be absolute");
	const workspace = await fsp.realpath(scope.workspace);
	let files = 0;
	let bytes = 0;
	const capture = async (roots: readonly string[]): Promise<IntegrationEntry[]> => {
		const entries: IntegrationEntry[] = [];
		const seen = new Set<string>();
		const visit = async (relative: string): Promise<void> => {
			if (seen.has(relative)) throw new Error(`Overlapping protected roots: ${relative}`);
			seen.add(relative);
			if (++files > scope.maxFiles) throw new Error("Protected snapshot entry limit exceeded");
			const absolute = path.join(workspace, relative);
			const before = await fsp.lstat(absolute);
			if (before.isSymbolicLink()) throw new Error(`Symlink in protected snapshot: ${relative}`);
			if (before.isDirectory()) {
				entries.push({ path: relative, kind: "directory", mode: before.mode, content: new Uint8Array() });
				const names = await fsp.readdir(absolute);
				names.sort();
				for (const name of names) await visit(`${relative}/${name}`);
				if (!stable(before, await fsp.lstat(absolute)))
					throw new Error(`Directory changed during capture: ${relative}`);
				return;
			}
			if (
				!before.isFile() ||
				!Number.isSafeInteger(before.size) ||
				before.size < 0 ||
				bytes + before.size > scope.maxBytes
			)
				throw new Error(`Unsupported or oversized protected file: ${relative}`);
			const file = await fsp.open(
				absolute,
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
			);
			try {
				if (!stable(before, await file.stat())) throw new Error(`File changed before capture: ${relative}`);
				const content = new Uint8Array(before.size);
				let offset = 0;
				while (offset < content.length) {
					const read = await file.read(content, offset, content.length - offset, offset);
					if (!read.bytesRead) throw new Error(`File truncated during capture: ${relative}`);
					offset += read.bytesRead;
				}
				if (!stable(before, await file.stat()) || !stable(before, await fsp.lstat(absolute)))
					throw new Error(`File changed during capture: ${relative}`);
				bytes += content.length;
				entries.push({ path: relative, kind: "file", mode: before.mode, content });
			} finally {
				await file.close();
			}
		};
		for (const root of roots) {
			if (
				!root ||
				root.startsWith("/") ||
				/[\\\x00-\x1f]/.test(root) ||
				root.split("/").some(part => !part || part === "." || part === "..")
			)
				throw new Error("Protected roots must be literal workspace-relative paths");
			// Reject symlinked ancestors too, rather than allowing a root to escape.
			const parts = root.split("/");
			for (let i = 1; i < parts.length; i++) {
				const ancestor = await fsp.lstat(path.join(workspace, ...parts.slice(0, i)));
				if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw new Error(`Unsafe protected root: ${root}`);
			}
			await visit(root);
		}
		return entries;
	};
	return {
		source: await capture(scope.source),
		specification: await capture(scope.specification),
		upstream: await capture(scope.upstream),
	};
}

/** Freeze the captured integrated filesystem. Host must ensure assembly is complete and quiescent. */
export async function freezeLocalIntegration(
	scope: LocalIntegrationScope,
	handoff: Omit<FrozenIntegration, "version">,
): Promise<FrozenIntegration> {
	return freezeIntegration(await captureLocalIntegration(scope), handoff);
}

export interface LocalAcceptanceOptions {
	scope: LocalIntegrationScope;
	frozen: FrozenIntegration;
	request: AcceptanceRequest;
	/** Absolute executable and literal arguments, resolved and authorized by the trusted host. */
	argv: readonly [string, ...string[]];
	env: Record<string, string>;
	timeoutMs: number;
	authorize(request: AcceptanceRequest, frozen: FrozenIntegration): Promise<boolean>;
	/** Explicit approval of the lack of OS isolation and transient-write detection. */
	authorizeIsolationLimitation(request: AcceptanceRequest, frozen: FrozenIntegration): Promise<boolean>;
}

/**
 * Local execution is deliberately not advertised as a sandbox. It cannot prove
 * absence of transient writes or surviving subprocesses. Authorization must cover
 * the exact JSON-encoded argv and the disclosed limitation before spawning.
 */
export function createLocalAcceptanceHost(options: Omit<LocalAcceptanceOptions, "frozen">): AcceptanceHost {
	const argv = [...options.argv];
	const env = { ...options.env };
	const scope = structuredClone(options.scope);
	const timeoutMs = options.timeoutMs;
	const expected = structuredClone(options.request);
	if (
		!path.isAbsolute(argv[0]) ||
		argv.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
		options.request.command !== JSON.stringify(argv) ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 2_147_483_647
	)
		throw new Error("Invalid local acceptance command or timeout");
	return {
		authorize: (request, frozen) =>
			Promise.resolve(
				request.tester === expected.tester &&
					request.command === expected.command &&
					request.scenario === expected.scenario &&
					request.environment === expected.environment,
			).then(matches => matches && options.authorize(request, frozen)),
		sourceIsolation: false,
		isolationDescription:
			"No OS sandbox; commands inherit configured access. Snapshot comparison cannot detect transient writes or surviving subprocesses.",
		authorizeIsolationLimitation: options.authorizeIsolationLimitation,
		capture: () => captureLocalIntegration(scope),
		run: async () => {
			const child = Bun.spawn(argv, {
				cwd: scope.workspace,
				env,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					// Wait for a confirmed exit; an uncertain process cannot produce passing evidence.
				}
			}, timeoutMs);
			try {
				const code = await child.exited;
				return {
					success: !timedOut && code === 0 && !child.signalCode,
					observed: `exit=${code}, signal=${child.signalCode ?? "none"}, timed_out=${timedOut}; output not captured`,
				};
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

export async function runLocalFrozenAcceptance(options: LocalAcceptanceOptions): Promise<AcceptanceEvidence> {
	return runFrozenAcceptance(options.frozen, options.request, createLocalAcceptanceHost(options));
}

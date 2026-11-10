import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { GRAPH_WIRE_EXECUTION_EXTENSION, GraphWireError, type GraphRef } from "@oh-my-pi/pi-wire/graph";
import { GraphAuthoringService, type GraphOperation } from "./authoring";
import { ArtifactError, readProfileArtifact } from "./artifacts";
import { createLocalDispatchPolicy, GraphDispatchError } from "./dispatch";
import { GRAPH_CLI_LIMITS } from "./limits";
import { createLocalLifecyclePolicy } from "./local-lifecycle";
import {
	GraphStartDescriptorError,
	parseStartDescriptor,
	START_DESCRIPTOR_MEDIA_TYPE,
	type StartDescriptor,
} from "./start-descriptor";
import { GraphRunStore, type GraphLifecycleRequest } from "./store";
import {
	type GraphWireAuthoringGrant,
	type GraphWireAuthoringOptions,
	type GraphWireExecutionService,
} from "./wire-authoring";
import { serveGraphWireAuthoringStdio } from "./wire-authoring-stdio";

const PRINCIPAL = "local-user";
const GENERATION = "local-1";
/** Every grant is re-minted per request; the window stays under the bridge's 60 s ceiling. */
const GRANT_WINDOW_MS = 55_000;
const GRANT_BACKDATE_MS = 1_000;
const DESCRIPTOR_BYTES = 1024 * 1024;
const INPUT_BYTES = 1024 * 1024;
const RECEIPT_OPERATIONS = new Set(["start", "hold", "resume", "cancel"]);

export interface GraphWireAuthorWorkerConfig {
	/** Graph profile root; artifacts and the ledger live directly under it. */
	root: string;
	source_id: string;
	/** The only directory a start descriptor may select. Already resolved by the launcher. */
	workspace: string;
	/** Test seam; the launcher always opens its own service. */
	definitions?: GraphAuthoringService;
	now?: () => number;
	command?: readonly string[];
	spawn?: typeof Bun.spawn;
}

export interface GraphWireAuthorWorker {
	options: GraphWireAuthoringOptions;
	close(): void;
}

function within(parent: string, target: string): boolean {
	const relative = path.relative(parent, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const invalid = (message: string): GraphWireError => new GraphWireError("invalid_input", message);

function decode(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw invalid(`${label} is not valid UTF-8`);
	}
}

function graphRef(value: unknown): GraphRef {
	const ref = value as { id?: unknown; digest?: unknown } | null;
	if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw invalid("Invalid artifact reference");
	if (typeof ref.id !== "string" || !ref.id || typeof ref.digest !== "string" || !ref.digest)
		throw invalid("Invalid artifact reference");
	return { id: ref.id, digest: ref.digest };
}

/** One vocabulary for every failure the browser sees: an artifact or spawn problem never becomes
 * an implicit retry, and `idempotency_conflict` stays distinguishable for the bridge. */
function wireError(error: unknown): unknown {
	if (error instanceof GraphWireError) return error;
	if (error instanceof ArtifactError)
		return error.code === "permission_denied"
			? new GraphWireError("scope_denied", "Artifact is not readable by this worker")
			: invalid("The start descriptor is not readable");
	if (error instanceof GraphDispatchError) {
		switch (error.code) {
			case "permission_denied":
				return new GraphWireError("scope_denied", "Dispatch is not permitted in this workspace");
			case "capability_unavailable":
				return new GraphWireError("capability_unavailable", "Graph cannot run locally");
			case "definition_invalid":
			case "resource_limit":
				return invalid(error.message);
			case "idempotency_conflict":
				return error;
			default:
				return new GraphWireError("capability_unavailable", "Dispatch failed before a Run was created");
		}
	}
	return new GraphWireError("capability_unavailable", "Run control is unavailable");
}

/**
 * Profile-local writer for the Graph websocket bridge. It is not a host: it never installs a
 * host, never claims a host lock, never authenticates a browser and never edits definitions.
 *
 * `start` mints no plan of its own. It reads the immutable descriptor artifact and hands the
 * result to the same local dispatch policy a CLI dispatch uses, so a Run created here is
 * indistinguishable from one created by `omp graph dispatch`. `hold`/`cancel` open their own
 * short-lived store and close it before returning. `resume` stays behind the human decision
 * gate, and definition mutations are denied by the grant (`can_author: false`).
 */
export function createGraphWireAuthorWorker(config: GraphWireAuthorWorkerConfig): GraphWireAuthorWorker {
	const root = path.resolve(config.root);
	const workspace = path.resolve(config.workspace);
	if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory())
		throw new Error("Graph authoring workspace is not a directory");
	const definitions = config.definitions ?? new GraphAuthoringService(GRAPH_CLI_LIMITS, root);
	const clock = config.now ?? Date.now;
	const binding = `local:${config.source_id}`;
	// First live frame wins: later frames must declare the same subscription or the bridge
	// denies them, so a browser cannot re-target the grant mid-connection.
	let seen: { subscription_id: string; scope_id: string } | null = null;

	const authorize = (principalId: string, sourceId: string): GraphWireAuthoringGrant | null => {
		if (principalId !== PRINCIPAL || sourceId !== config.source_id) return null;
		const at = clock();
		return {
			generation: GENERATION,
			source_binding: binding,
			subscription_id: seen?.subscription_id ?? "local",
			scope_id: seen?.scope_id ?? "local",
			mode: "live",
			source_ready: true,
			can_author: false,
			can_execute: true,
			graph_ids: null,
			authorized_at: at - GRANT_BACKDATE_MS,
			expires_at: at + GRANT_WINDOW_MS,
		};
	};

	const readArtifact = async (ref: GraphRef, maxBytes: number) =>
		readProfileArtifact(ref, {
			root,
			maxBytes,
			principal: PRINCIPAL,
			authorize: principalId => Promise.resolve(principalId === PRINCIPAL),
		});

	const workspaceFor = async (raw: unknown): Promise<string> => {
		if (raw === undefined) return workspace;
		if (typeof raw !== "string" || raw.length === 0) throw invalid("Descriptor workspace must be a path");
		const candidate = path.resolve(workspace, raw);
		const real = await fsp.realpath(candidate).catch(() => {
			throw invalid("Descriptor workspace is unavailable");
		});
		const stat = await fsp.stat(real).catch(() => {
			throw invalid("Descriptor workspace is unavailable");
		});
		if (!stat.isDirectory()) throw invalid("Descriptor workspace must be a directory");
		if (!within(workspace, real))
			throw new GraphWireError("scope_denied", "Descriptor workspace escapes this worker's workspace");
		return real;
	};

	const start = async (intentId: string, request: { target_id: string | null; payload: Record<string, unknown> }) => {
		if (!request.target_id) throw invalid("A start request requires a graph id");
		// Local runs start at the declared entry node; a caller-chosen entry is a different engine.
		if (Object.hasOwn(request.payload, "entry_nodes") || Object.hasOwn(request.payload, "provided_outputs"))
			throw new GraphWireError("capability_unavailable", "Local execution does not select entry nodes");
		const authorizationRef = graphRef(request.payload.authorization_ref);
		const { artifact, bytes } = await readArtifact(authorizationRef, DESCRIPTOR_BYTES);
		if (artifact.media_type.split(";")[0]!.trim() !== START_DESCRIPTOR_MEDIA_TYPE)
			throw invalid(`The start descriptor must be ${START_DESCRIPTOR_MEDIA_TYPE}`);
		let descriptor: StartDescriptor;
		try {
			descriptor = parseStartDescriptor(bytes, { maxBytes: DESCRIPTOR_BYTES });
		} catch (failure) {
			if (failure instanceof GraphStartDescriptorError) throw invalid(failure.message);
			throw failure;
		}
		const cwd = await workspaceFor(descriptor.workspace);

		const inputs: Record<string, string> = {};
		const declared = request.payload.inputs;
		if (declared && typeof declared === "object" && !Array.isArray(declared)) {
			for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
				const input = await readArtifact(graphRef(value), INPUT_BYTES);
				if (!input.artifact.media_type.startsWith("text/")) throw invalid(`Run input ${name} must be text`);
				inputs[name] = decode(input.bytes, `Run input ${name}`);
			}
		}

		const policy = createLocalDispatchPolicy({
			root,
			cwd,
			principal: PRINCIPAL,
			...(config.command ? { command: config.command } : {}),
			...(config.spawn ? { spawn: config.spawn } : {}),
		});
		const result = await policy.dispatch({
			request_key: intentId,
			graph_id: request.target_id,
			title: descriptor.title,
			bindings: descriptor.bindings,
			inputs,
			max_model_calls: descriptor.max_model_calls,
			timeout_ms: descriptor.timeout_ms,
			...(descriptor.report_to === undefined ? {} : { report_to: descriptor.report_to }),
		});
		return {
			request_key: intentId,
			state: "accepted" as const,
			target_id: result.run_id,
			revision: null,
			result_ref: null,
			error: null,
		};
	};

	const lifecycle = async (
		intentId: string,
		request: {
			operation: "hold" | "cancel";
			target_id: string | null;
			if_revision: string | null;
			payload: Record<string, unknown>;
		},
	): Promise<GraphOperation> => {
		const target = request.target_id;
		const revision = request.if_revision;
		const reason = request.payload.reason;
		if (!target || !revision) throw invalid("A lifecycle request requires target_id and if_revision");
		if (typeof reason !== "string" || reason.length === 0) throw invalid("A lifecycle request requires a reason");
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		try {
			store.configureLifecycle(createLocalLifecyclePolicy({ principal: PRINCIPAL }));
			const mutation: GraphLifecycleRequest =
				request.operation === "hold"
					? {
							version: 1,
							request_key: intentId,
							target_id: target,
							if_revision: revision,
							operation: "hold",
							payload: { reason, kind: "operator" },
						}
					: {
							version: 1,
							request_key: intentId,
							target_id: target,
							if_revision: revision,
							operation: "cancel",
							payload: { reason },
						};
			return store.mutateLifecycle(PRINCIPAL, mutation);
		} finally {
			store.close();
		}
	};

	const execution: GraphWireExecutionService = {
		async apply(principalId, sourceId, intentId, request) {
			if (principalId !== PRINCIPAL || sourceId !== config.source_id)
				throw new GraphWireError("scope_denied", "Run control is scoped to this worker's source");
			try {
				switch (request.operation) {
					case "start":
						return await start(intentId, request);
					case "hold":
					case "cancel":
						return await lifecycle(
							intentId,
							request as {
								operation: "hold" | "cancel";
								target_id: string | null;
								if_revision: string | null;
								payload: Record<string, unknown>;
							},
						);
					case "resume":
						// Gate holds need a resolved decision reference; this worker has no such path.
						throw new GraphWireError("capability_unavailable", "Resuming a Run requires a human decision");
					default:
						throw new GraphWireError("capability_unavailable", "Unsupported Run control");
				}
			} catch (error) {
				throw wireError(error);
			}
		},
		reconcile(principalId, sourceId, intentId) {
			if (principalId !== PRINCIPAL || sourceId !== config.source_id) return null;
			try {
				const resolved = definitions.requestGetAuthorized(intentId, request =>
					RECEIPT_OPERATIONS.has(request.operation),
				);
				// Definition/publication receipts are a different authority surface; only Run control replays here.
				return resolved?.kind === "execution" ? resolved.receipt : null;
			} catch (error) {
				throw wireError(error);
			}
		},
	};

	return {
		close: () => definitions.close(),
		options: {
			principal_id: PRINCIPAL,
			sources: [
				{
					source_id: config.source_id,
					binding,
					definitions,
					capabilities: [GRAPH_WIRE_EXECUTION_EXTENSION],
				},
			],
			extensions: [GRAPH_WIRE_EXECUTION_EXTENSION],
			authorize,
			execution,
			observeRequest: request => {
				const frame = request as { type?: unknown; subscription_id?: unknown; scope_id?: unknown } | null;
				if (!frame || frame.type !== "graph.author" || seen) return;
				if (typeof frame.subscription_id !== "string" || typeof frame.scope_id !== "string") return;
				seen = { subscription_id: frame.subscription_id, scope_id: frame.scope_id };
			},
		},
	};
}

/** Launcher argv contract: exactly ROOT SOURCE_ID WORKSPACE, never flags. Exported so the
 * rejection path is testable without destroying this process's stdio. */
export function parseGraphWireAuthorLauncher(argv: readonly string[]): {
	root: string;
	source_id: string;
	workspace: string;
} {
	const [root, sourceId, workspace, ...rest] = argv;
	if (!root || !sourceId || !workspace || rest.length || argv.some(value => value.startsWith("-")))
		throw new Error("Invalid launcher configuration");
	return { root: path.resolve(root), source_id: sourceId, workspace: path.resolve(workspace) };
}

// Internal trusted launcher only: ROOT SOURCE_ID WORKSPACE. The parent owns browser
// authentication and MUST abort the stream on revocation; see serveGraphWireAuthoringStdio.
// Launching this process confers no authorization, and it never installs a host or claims a lock.
export async function startGraphWireAuthorWorker(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const lifetime = new AbortController();
	const stop = (): void => lifetime.abort();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	let worker: GraphWireAuthorWorker | undefined;
	try {
		const launcher = parseGraphWireAuthorLauncher(argv);
		const resolved = launcher.workspace;
		if (!(await fsp.stat(resolved)).isDirectory()) throw new Error("Invalid launcher workspace");
		worker = createGraphWireAuthorWorker({
			root: launcher.root,
			source_id: launcher.source_id,
			workspace: await fsp.realpath(resolved),
		});
		await serveGraphWireAuthoringStdio({
			...worker.options,
			input: Readable.toWeb(process.stdin),
			output: Writable.toWeb(process.stdout),
			signal: lifetime.signal,
		});
	} catch {
		process.stderr.write("Graph wire authoring unavailable\n");
		process.exitCode = 1;
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		worker?.close();
		// Own process-stream lifetime too: unresolved pipe backpressure cannot retain the source.
		process.stdin.destroy();
		process.stdout.destroy();
	}
}

if (import.meta.main) void startGraphWireAuthorWorker();

import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import { ArtifactError, type GraphArtifactRegistry, type LocalArtifactStoreOptions } from "./artifacts";

/** The descriptor stays JSON: it is machine-admitted metadata, not Graph prose. */
export const START_DESCRIPTOR_MEDIA_TYPE = "application/json";
export const START_DESCRIPTOR_ACCESS_SCOPE = "graph:start-descriptor";
export const START_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set([
	"title",
	"workspace",
	"bindings",
	"max_model_calls",
	"timeout_ms",
	"report_to",
]);
export const DEFAULT_START_MAX_CALLS = 16;
export const DEFAULT_START_TIMEOUT_MS = 10 * 60_000;
const MAX_TITLE = 200;
const MAX_IDENTITY = 1024;

export type StartDescriptorErrorCode =
	| "definition_invalid"
	| "permission_denied"
	| "resource_limit"
	| "unknown_reference"
	| "idempotency_conflict"
	| "capability_unavailable"
	| "internal_error";

export class GraphStartDescriptorError extends Error {
	constructor(
		readonly code: StartDescriptorErrorCode,
		message: string,
	) {
		super(message);
		this.name = "GraphStartDescriptorError";
	}
}

/** Structural admission only. Workspace containment stays with the worker that owns the filesystem. */
export interface StartDescriptor {
	title: string;
	workspace?: string;
	bindings: string;
	max_model_calls: number;
	timeout_ms: number;
	report_to?: string;
}

export interface StartDescriptorLimits {
	maxBytes: number;
}

function invalid(message: string): GraphStartDescriptorError {
	return new GraphStartDescriptorError("definition_invalid", message);
}

function identity(value: unknown, max: number = MAX_IDENTITY): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value, "utf8") <= max &&
		!/[\u0000-\u001f\u007f-\u009f]/.test(value)
	);
}

/** One parser for publisher and worker, so a descriptor accepted at publish is accepted at start. */
export function parseStartDescriptor(bytes: Uint8Array, limits: StartDescriptorLimits): StartDescriptor {
	if (bytes.byteLength > limits.maxBytes)
		throw new GraphStartDescriptorError("resource_limit", "Start descriptor exceeds the size limit");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw invalid("The start descriptor is not valid UTF-8");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw invalid("The start descriptor is not valid JSON");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("The start descriptor must be an object");
	const descriptor = raw as Record<string, unknown>;
	for (const key of Object.keys(descriptor))
		if (!START_DESCRIPTOR_FIELDS.has(key)) throw invalid(`Unknown start descriptor field: ${key}`);
	const { title, bindings } = descriptor;
	if (!identity(title, MAX_TITLE) || title.trim().length === 0) throw invalid("Descriptor title is required");
	if (!identity(bindings)) throw invalid("Descriptor bindings are required");
	const calls = descriptor.max_model_calls ?? DEFAULT_START_MAX_CALLS;
	if (!Number.isSafeInteger(calls) || (calls as number) < 1)
		throw invalid("Descriptor max_model_calls must be a positive integer");
	const timeout = descriptor.timeout_ms ?? DEFAULT_START_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeout) || (timeout as number) < 1)
		throw invalid("Descriptor timeout_ms must be a positive integer");
	const workspace = descriptor.workspace;
	if (workspace !== undefined && !identity(workspace)) throw invalid("Descriptor workspace must be a path");
	const reportTo = descriptor.report_to;
	if (reportTo !== undefined && !identity(reportTo)) throw invalid("Descriptor report_to must be an address");
	return {
		title,
		bindings,
		max_model_calls: calls as number,
		timeout_ms: timeout as number,
		...(workspace === undefined ? {} : { workspace }),
		...(reportTo === undefined ? {} : { report_to: reportTo }),
	};
}

export interface GraphStartDescriptorRequest {
	request_key: string;
	graph_id: string;
	content: string;
	expected_digest?: string | null;
}

export interface GraphStartDescriptorOperation {
	request_key: string;
	state: "completed" | "rejected";
	graph_id: string | null;
	descriptor_ref: GraphRef | null;
	error: { code: string; message: string } | null;
}

export interface GraphStartDescriptorPolicy {
	principal: string;
	maxBytes: number;
	authorizeArtifact: LocalArtifactStoreOptions["authorize"];
	/** Checked before the caller is allowed to read or write a descriptor for this Graph. */
	authorizeTarget(
		principal: string,
		target: { graph_id: string; request_key: string | null },
	): boolean | Promise<boolean>;
}

export interface GraphStartDescriptorsOptions {
	database: Database;
	artifacts: GraphArtifactRegistry;
	policy: GraphStartDescriptorPolicy;
	assertAccess(): void;
}

export interface StartDescriptorReference {
	id: string;
	digest: string;
	created_at: string;
}

function digestOf(content: string): string {
	return `sha256:${new Bun.CryptoHasher("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Publishes host-authored start descriptors and serves the newest one per Graph. Writing a
 * descriptor grants nothing: the worker still needs a live execution source and its own scope.
 */
export class GraphStartDescriptors {
	readonly #db: Database;
	readonly #artifacts: GraphArtifactRegistry;
	readonly #policy: GraphStartDescriptorPolicy;
	readonly #assertAccess: () => void;

	constructor(options: GraphStartDescriptorsOptions) {
		const { policy } = options;
		if (
			!identity(policy.principal) ||
			!Number.isSafeInteger(policy.maxBytes) ||
			policy.maxBytes < 0 ||
			typeof policy.authorizeArtifact !== "function" ||
			typeof policy.authorizeTarget !== "function"
		)
			throw new GraphStartDescriptorError("definition_invalid", "Invalid start descriptor policy");
		options.artifacts.assertDatabase(options.database);
		this.#db = options.database;
		this.#artifacts = options.artifacts;
		this.#policy = policy;
		this.#assertAccess = options.assertAccess;
	}

	async publish(input: GraphStartDescriptorRequest): Promise<GraphStartDescriptorOperation> {
		let request: GraphStartDescriptorRequest;
		try {
			request = structuredClone(input);
		} catch {
			return this.#reject(input, "definition_invalid", "Descriptor request must be JSON data");
		}
		try {
			this.#validateRequest(request);
			const bytes = Buffer.from(request.content, "utf8");
			// Structural admission happens before any write: an unusable descriptor never becomes history.
			parseStartDescriptor(bytes, { maxBytes: this.#policy.maxBytes });
			const digest = digestOf(request.content);
			if (request.expected_digest && request.expected_digest !== digest)
				throw new GraphStartDescriptorError("definition_invalid", "Start descriptor digest mismatch");
			const target = { graph_id: request.graph_id, request_key: request.request_key };
			await this.#authorizeTarget(target);
			const prior = this.#db
				.transaction(() => {
					this.#assertAccess();
					const replay = this.#replay(request, digest);
					if (replay) return replay;
					this.#assertGraph(request.graph_id);
					return null;
				})
				.immediate();
			if (prior) return prior;
			await this.#authorizeArtifact("publish");
			const provenance = this.#provenance(request.graph_id);
			const publication = {
				media_type: START_DESCRIPTOR_MEDIA_TYPE,
				producer_attempt_id: null,
				source_ref: provenance,
				access_scope: [START_DESCRIPTOR_ACCESS_SCOPE],
				expected_digest: request.expected_digest ?? null,
			};
			const artifact = await this.#artifacts.store.publish(this.#policy.principal, bytes, publication);
			const prepared = await this.#artifacts.prepareRegistration([{ artifact, expected: publication }]);
			return this.#db
				.transaction((): GraphStartDescriptorOperation => {
					this.#assertAccess();
					const replay = this.#replay(request, digest);
					if (replay) return replay;
					this.#assertGraph(request.graph_id);
					const result: GraphStartDescriptorOperation = {
						request_key: request.request_key,
						state: "completed",
						graph_id: request.graph_id,
						descriptor_ref: { id: artifact.id, digest: artifact.digest },
						error: null,
					};
					this.#artifacts.commitPrepared(prepared, [result.descriptor_ref!]);
					this.#db
						.query("INSERT INTO graph_start_descriptors VALUES (?,?,?,?,?)")
						.run(request.request_key, request.graph_id, artifact.id, artifact.digest, new Date().toISOString());
					return result;
				})
				.immediate();
		} catch (error) {
			return this.#failure(request, error);
		}
	}

	async get(graph_id: string, request_key: string | null = null): Promise<StartDescriptorReference | null> {
		await this.#authorizeTarget({ graph_id, request_key });
		this.#assertAccess();
		const row = this.#db
			.query(
				"SELECT artifact_id,artifact_digest,created_at FROM graph_start_descriptors WHERE graph_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get(graph_id) as { artifact_id: string; artifact_digest: string; created_at: string } | null;
		if (!row) return null;
		await this.#authorizeArtifact("read");
		return { id: row.artifact_id, digest: row.artifact_digest, created_at: row.created_at };
	}

	async #authorizeTarget(target: { graph_id: string; request_key: string | null }): Promise<void> {
		const allowed = await this.#policy.authorizeTarget(this.#policy.principal, { ...target });
		if (allowed !== true)
			throw new GraphStartDescriptorError("permission_denied", "Start descriptor target is not authorized");
	}

	async #authorizeArtifact(action: "read" | "publish"): Promise<void> {
		const allowed = await this.#policy.authorizeArtifact(this.#policy.principal, action, [
			START_DESCRIPTOR_ACCESS_SCOPE,
		]);
		if (allowed !== true)
			throw new GraphStartDescriptorError("permission_denied", "Start descriptor artifact is not authorized");
	}

	/** Definition identity lives in the snapshot join; `graph_definitions` carries no digest column. */
	#assertGraph(graphId: string): void {
		const row = this.#db
			.query(
				"SELECT s.digest FROM graph_definitions d JOIN graph_snapshots s ON s.graph_id=d.graph_id AND s.revision=d.revision WHERE d.graph_id=?",
			)
			.get(graphId) as { digest?: string } | null;
		if (!row?.digest)
			throw new GraphStartDescriptorError("unknown_reference", "Start descriptor Graph does not exist");
	}

	#provenance(graphId: string): GraphRef {
		const row = this.#db
			.query(
				"SELECT s.digest AS digest FROM graph_snapshots s JOIN graph_definitions d ON d.graph_id=s.graph_id AND d.revision=s.revision WHERE s.graph_id=?",
			)
			.get(graphId) as { digest: string } | null;
		if (!row) throw new GraphStartDescriptorError("unknown_reference", "Start descriptor Graph does not exist");
		return { id: graphId, digest: row.digest };
	}

	#replay(request: GraphStartDescriptorRequest, digest: string): GraphStartDescriptorOperation | null {
		const prior = this.#db
			.query("SELECT graph_id,artifact_id,artifact_digest FROM graph_start_descriptors WHERE request_key=?")
			.get(request.request_key) as {
			graph_id: string;
			artifact_id: string;
			artifact_digest: string;
		} | null;
		if (!prior) return null;
		if (prior.graph_id !== request.graph_id || prior.artifact_digest !== digest)
			throw new GraphStartDescriptorError(
				"idempotency_conflict",
				"Request key was already used for a different descriptor",
			);
		return {
			request_key: request.request_key,
			state: "completed",
			graph_id: prior.graph_id,
			descriptor_ref: { id: prior.artifact_id, digest: prior.artifact_digest },
			error: null,
		};
	}

	#validateRequest(request: GraphStartDescriptorRequest): void {
		const keys = Object.keys(request).sort().join("\0");
		const accepted = ["content", "graph_id", "request_key"].sort().join("\0");
		const acceptedDigest = [...accepted.split("\0"), "expected_digest"].sort().join("\0");
		if ((keys !== accepted && keys !== acceptedDigest) || !identity(request.request_key, MAX_IDENTITY))
			throw new GraphStartDescriptorError("definition_invalid", "Invalid start descriptor request");
		if (!identity(request.graph_id, MAX_IDENTITY) || typeof request.content !== "string")
			throw invalid("Invalid start descriptor request");
		if (
			request.expected_digest !== undefined &&
			request.expected_digest !== null &&
			!/^sha256:[0-9a-f]{64}$/.test(request.expected_digest)
		)
			throw invalid("Invalid start descriptor digest");
	}

	#failure(request: GraphStartDescriptorRequest, error: unknown): GraphStartDescriptorOperation {
		if (error instanceof GraphStartDescriptorError) return this.#reject(request, error.code, error.message);
		if (error instanceof ArtifactError) {
			const code: StartDescriptorErrorCode =
				error.code === "too_large"
					? "resource_limit"
					: error.code === "permission_denied"
						? "permission_denied"
						: error.code === "invalid" || error.code === "digest_mismatch"
							? "definition_invalid"
							: "internal_error";
			return this.#reject(request, code, error.message);
		}
		// The caller learns nothing about internals, but a silent generic code hides real defects.
		logger.error("Graph start descriptor publication failed", { error });
		return this.#reject(request, "internal_error", "Start descriptor did not commit");
	}

	#reject(request: GraphStartDescriptorRequest, code: string, message: string): GraphStartDescriptorOperation {
		return {
			request_key: typeof request?.request_key === "string" ? request.request_key : "",
			state: "rejected",
			graph_id: typeof request?.graph_id === "string" ? request.graph_id : null,
			descriptor_ref: null,
			error: { code, message },
		};
	}
}

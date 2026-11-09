import type { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import {
	ArtifactError,
	type ArtifactPublication,
	type GraphArtifactRegistry,
	type LocalArtifactStoreOptions,
} from "./artifacts";
import type { GraphOperation } from "./authoring";

export interface GraphTextPublicationRequest {
	version: 1;
	request_key: string;
	operation: "artifact.publish";
	target_id: string;
	if_revision: null;
	payload: { content: string; media_type: string; expected_digest: string | null };
}

export interface GraphTextPublicationPolicy {
	principal: string;
	maxBytes: number;
	authorizeArtifact: LocalArtifactStoreOptions["authorize"];
	authorizeRequest(principal: string, request: GraphTextPublicationRequest): boolean;
	resolvePublication(principal: string, request: GraphTextPublicationRequest): Promise<ArtifactPublication>;
}

export class GraphTextPublicationError extends Error {
	constructor(
		readonly code:
			| "definition_invalid"
			| "permission_denied"
			| "resource_limit"
			| "unknown_reference"
			| "idempotency_conflict"
			| "capability_unavailable"
			| "internal_error",
		message: string,
	) {
		super(message);
		this.name = "GraphTextPublicationError";
	}
}

interface GraphTextPublicationsOptions {
	database: Database;
	artifacts: GraphArtifactRegistry;
	policy: GraphTextPublicationPolicy;
	assertAccess(): void;
}

function exactFields(value: unknown, fields: readonly string[]): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join("\0") === [...fields].sort().join("\0")
	);
}

function identity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		!!value &&
		Buffer.byteLength(value, "utf8") <= 1024 &&
		!/[\u0000-\u001f\u007f-\u009f]/.test(value)
	);
}

/** Bounded host-authorized bytes only. Publication never changes a Run or grants execution authority. */
export class GraphTextPublications {
	readonly #db: Database;
	readonly #artifacts: GraphArtifactRegistry;
	readonly #principal: string;
	readonly #maxBytes: number;
	readonly #authorize: GraphTextPublicationPolicy["authorizeRequest"];
	readonly #resolve: GraphTextPublicationPolicy["resolvePublication"];
	readonly #assertAccess: () => void;

	constructor(options: GraphTextPublicationsOptions) {
		const { policy } = options;
		if (
			!identity(policy.principal) ||
			!Number.isSafeInteger(policy.maxBytes) ||
			policy.maxBytes < 0 ||
			typeof policy.authorizeRequest !== "function" ||
			typeof policy.resolvePublication !== "function" ||
			typeof policy.authorizeArtifact !== "function"
		)
			throw new GraphTextPublicationError("definition_invalid", "Invalid text publication policy");
		options.artifacts.assertDatabase(options.database);
		this.#db = options.database;
		this.#artifacts = options.artifacts;
		this.#principal = policy.principal;
		this.#maxBytes = policy.maxBytes;
		this.#authorize = policy.authorizeRequest.bind(policy);
		this.#resolve = policy.resolvePublication.bind(policy);
		this.#assertAccess = options.assertAccess;
	}

	async publish(input: GraphTextPublicationRequest): Promise<GraphOperation> {
		// Capture all model input before the first await, including nested content and identity.
		let request: GraphTextPublicationRequest;
		try {
			request = structuredClone(input);
		} catch {
			return this.#reject(input, "definition_invalid", "Publication request must be JSON data");
		}
		let admitted = false;
		let fingerprint: string | null = null;
		try {
			this.#validateRequest(request);
			if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(request.payload.content))
				throw new GraphTextPublicationError(
					"definition_invalid",
					"Publication content must be well-formed Unicode",
				);
			if (Buffer.byteLength(request.payload.content, "utf8") > this.#maxBytes)
				throw new GraphTextPublicationError("resource_limit", "Artifact exceeds text publication size limit");
			const canonical = canonicalJson(request);
			fingerprint = canonical;
			const prior = this.#db
				.transaction(() => {
					this.#authorizeRequest(request);
					const receipt = this.#replay(request, canonical);
					if (receipt) return receipt;
					admitted = true;
					this.#assertTarget(request.target_id);
					return null;
				})
				.immediate();
			if (prior) return prior;
			// Resolver metadata is trusted, but detached immediately before any subsequent awaits.
			const publication = structuredClone(await this.#resolve(this.#principal, structuredClone(request)));
			this.#validatePublication(publication, request);
			const artifact = await this.#artifacts.store.publish(
				this.#principal,
				Buffer.from(request.payload.content, "utf8"),
				publication,
			);
			const prepared = await this.#artifacts.prepareRegistration([{ artifact, expected: publication }]);
			return this.#db
				.transaction(() => {
					this.#authorizeRequest(request);
					const replay = this.#replay(request, canonical);
					if (replay) return replay;
					this.#assertTarget(request.target_id);
					const result: GraphOperation = {
						request_key: request.request_key,
						state: "completed",
						target_id: request.target_id,
						revision: null,
						result_ref: { id: artifact.id, digest: artifact.digest },
						error: null,
					};
					this.#artifacts.commitPrepared(prepared, [result.result_ref!]);
					this.#db
						.query("INSERT INTO graph_requests VALUES (?,?,?)")
						.run(request.request_key, canonical, JSON.stringify(result));
					return result;
				})
				.immediate();
		} catch (error) {
			const rejected = this.#failure(request, error);
			if (
				!admitted ||
				fingerprint === null ||
				!["definition_invalid", "unknown_reference"].includes(rejected.error!.code)
			)
				return rejected;
			const canonical = fingerprint;
			// Only admitted application failures reserve keys. Authorization and infrastructure
			// failures remain retryable with no receipt; published bytes may remain orphaned.
			try {
				return this.#db
					.transaction(() => {
						this.#authorizeRequest(request);
						const replay = this.#replay(request, canonical);
						if (replay) return replay;
						this.#db
							.query("INSERT INTO graph_requests VALUES (?,?,?)")
							.run(request.request_key, canonical, JSON.stringify(rejected));
						return rejected;
					})
					.immediate();
			} catch (failure) {
				return this.#failure(request, failure);
			}
		}
	}

	#authorizeRequest(request: GraphTextPublicationRequest): void {
		this.#assertAccess();
		const authorized: unknown = this.#authorize(this.#principal, structuredClone(request));
		if (authorized !== true) {
			if (authorized instanceof Promise) void authorized.catch(() => {});
			throw new GraphTextPublicationError("permission_denied", "Text publication is not authorized");
		}
		this.#assertAccess();
	}

	#assertTarget(target: string): void {
		if (
			!this.#db
				.query(
					"SELECT 1 FROM graph_definitions WHERE graph_id=? UNION ALL SELECT 1 FROM graph_runs WHERE id=? LIMIT 1",
				)
				.get(target, target)
		)
			throw new GraphTextPublicationError("unknown_reference", "Publication target does not exist");
	}

	#replay(request: GraphTextPublicationRequest, fingerprint: string): GraphOperation | null {
		const prior = this.#db
			.query("SELECT canonical,result FROM graph_requests WHERE request_key=?")
			.get(request.request_key) as { canonical: string; result: string } | null;
		if (!prior) return null;
		if (prior.canonical !== fingerprint)
			throw new GraphTextPublicationError(
				"idempotency_conflict",
				"Request key was already used for a different mutation",
			);
		return JSON.parse(prior.result) as GraphOperation;
	}

	#validateRequest(request: GraphTextPublicationRequest): void {
		if (
			!exactFields(request, ["version", "request_key", "operation", "target_id", "if_revision", "payload"]) ||
			request.version !== 1 ||
			request.operation !== "artifact.publish" ||
			request.if_revision !== null ||
			!identity(request.request_key) ||
			!identity(request.target_id) ||
			!exactFields(request.payload, ["content", "media_type", "expected_digest"]) ||
			typeof request.payload.content !== "string" ||
			!identity(request.payload.media_type) ||
			(request.payload.expected_digest !== null &&
				(typeof request.payload.expected_digest !== "string" ||
					!/^sha256:[0-9a-f]{64}$/.test(request.payload.expected_digest)))
		)
			throw new GraphTextPublicationError("definition_invalid", "Invalid text publication request");
	}

	#validatePublication(publication: ArtifactPublication, request: GraphTextPublicationRequest): void {
		if (
			!publication ||
			publication.media_type !== request.payload.media_type ||
			(publication.expected_digest ?? null) !== request.payload.expected_digest ||
			!Array.isArray(publication.access_scope) ||
			publication.access_scope.some(scope => !identity(scope)) ||
			(publication.producer_attempt_id !== null && !identity(publication.producer_attempt_id)) ||
			(publication.source_ref !== null &&
				(!publication.source_ref ||
					!identity(publication.source_ref.id) ||
					!identity(publication.source_ref.digest))) ||
			(!publication.producer_attempt_id && !publication.source_ref)
		)
			throw new GraphTextPublicationError(
				"definition_invalid",
				"Publication metadata does not match the authorized request",
			);
	}

	#failure(request: GraphTextPublicationRequest, error: unknown): GraphOperation {
		if (error instanceof GraphTextPublicationError) return this.#reject(request, error.code, error.message);
		if (error instanceof ArtifactError) {
			const code =
				error.code === "too_large"
					? "resource_limit"
					: error.code === "permission_denied"
						? "permission_denied"
						: error.code === "invalid" || error.code === "digest_mismatch"
							? "definition_invalid"
							: "internal_error";
			return this.#reject(request, code, error.message);
		}
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		return this.#reject(
			request,
			code === "permission_denied" ? "permission_denied" : "internal_error",
			"Text publication did not commit",
		);
	}

	#reject(request: GraphTextPublicationRequest, code: string, message: string): GraphOperation {
		return {
			request_key: typeof request?.request_key === "string" ? request.request_key : "",
			state: "rejected",
			target_id: typeof request?.target_id === "string" ? request.target_id : null,
			revision: null,
			result_ref: null,
			error: { code, message, location: null, retryable: false, details: null },
		};
	}
}

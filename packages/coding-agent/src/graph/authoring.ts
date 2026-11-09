import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { isAlias, isMap, isSeq, visit } from "yaml";
import { type GraphLimits, validateGraphDefinition } from "./definition";
import { GraphSourceError } from "./source";
import type { GraphIssue } from "./validation-types";
import type { GraphTextPublicationRequest } from "./text-publication";

type AuthoringOperation = "create" | "import" | "edit" | "member.add" | "node.add" | "connect" | "permit";
export interface GraphMutation {
	version: 1;
	request_key: string;
	operation: AuthoringOperation;
	target_id: string | null;
	if_revision: string | null;
	payload: Record<string, unknown>;
}
/** Original persisted protected request, supplied only to a trusted synchronous read gate. */
export type GraphExecutionReceiptRequest =
	| GraphTextPublicationRequest
	| {
			version: 1;
			request_key: string;
			operation: "start" | "answer" | "hold" | "resume" | "cancel";
			target_id: string;
			if_revision: string;
			payload: Record<string, unknown>;
	  };

export type GraphExecutionReceiptAuthorizer = (request: GraphExecutionReceiptRequest) => boolean;

export interface GraphAuthoringIntent {
	principal_id: string;
	intent_id: string;
	source_id: string;
	source_binding: string;
	request: GraphMutation;
}
export interface GraphError {
	code: string;
	message: string;
	location: { file: string; path: string; line: number | null; column: number | null } | null;
	retryable: boolean;
	details: Record<string, unknown> | null;
}
export interface GraphOperation {
	request_key: string;
	state: "accepted" | "completed" | "unknown" | "rejected";
	target_id: string | null;
	revision: string | null;
	result_ref: { id: string; digest: string } | null;
	error: GraphError | null;
}
export interface GraphSnapshot {
	graph_id: string;
	revision: string;
	digest: string;
	content: string;
}

class AuthoringError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details: Record<string, unknown> | null = null,
	) {
		super(message);
	}
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new AuthoringError("definition_invalid", `${name} must be a string`);
	return value;
}

function payloadFields(payload: Record<string, unknown>, fields: string[]): void {
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		Object.keys(payload).sort().join("\0") !== [...fields].sort().join("\0")
	)
		throw new AuthoringError("definition_invalid", `Payload must contain exactly ${fields.join(", ")}`);
}

function intentIdentity(value: unknown, name: string): string {
	if (
		typeof value !== "string" ||
		!value ||
		Buffer.byteLength(value, "utf8") > 1024 ||
		/[\u0000-\u001f\u007f-\u009f]/.test(value)
	)
		throw new AuthoringError("definition_invalid", `${name} must be nonempty, control-free and at most 1024 bytes`);
	return value;
}

function freezeJson(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}

/** Local definition storage only. Validation does not authorize execution. */
export class GraphAuthoringService {
	readonly root: string;
	readonly limits: GraphLimits;
	#db: Database;

	constructor(limits: GraphLimits, root = path.join(getAgentDir(), "graphs")) {
		this.root = path.resolve(root);
		this.limits = { ...limits };
		let opened: Database | undefined;
		try {
			fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
			const stat = fs.lstatSync(this.root);
			if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
				throw new AuthoringError("permission_denied", "Graph profile is not owned by this user");
			fs.chmodSync(this.root, 0o700);
			const dbPath = path.join(this.root, "graphs.sqlite");
			for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
				if (fs.existsSync(file)) {
					const info = fs.lstatSync(file);
					if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
						throw new AuthoringError("permission_denied", "Graph database is not owned by this user");
				}
			}
			opened = this.#db = new Database(dbPath, { create: true });
			this.#db.exec(
				"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
			);
			this.#db.exec(`
CREATE TABLE IF NOT EXISTS graph_definitions (graph_id TEXT PRIMARY KEY, revision TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_snapshots (graph_id TEXT NOT NULL REFERENCES graph_definitions(graph_id), revision TEXT NOT NULL, digest TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(graph_id, revision));
CREATE TABLE IF NOT EXISTS graph_requests (request_key TEXT PRIMARY KEY, canonical TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_authoring_intents (principal_id TEXT NOT NULL, intent_id TEXT NOT NULL, source_id TEXT NOT NULL, source_binding TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY(principal_id, intent_id));
`);
			for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
				if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
		} catch (error) {
			opened?.close();
			if (error instanceof AuthoringError) throw error;
			const denied =
				error instanceof Error && "code" in error && ["EACCES", "EPERM", "EROFS"].includes(String(error.code));
			throw new AuthoringError(
				denied ? "permission_denied" : "internal_error",
				"Cannot open the profile-local Graph database",
			);
		}
	}

	close(): void {
		this.#db.close();
	}

	assertProfileAccess(): void {
		this.#access();
	}

	#access(): void {
		try {
			const stat = fs.lstatSync(this.root);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				(stat.mode & 0o077) !== 0 ||
				(process.getuid && stat.uid !== process.getuid())
			)
				throw new Error();
		} catch {
			throw new AuthoringError("permission_denied", "Graph profile permissions do not allow access");
		}
	}

	get(graphId: string, revision?: string): GraphSnapshot | null {
		this.#access();
		const row =
			revision === undefined
				? this.#db
						.query(
							"SELECT s.graph_id,s.revision,s.digest,s.content FROM graph_snapshots s JOIN graph_definitions d ON d.graph_id=s.graph_id AND d.revision=s.revision WHERE s.graph_id=?",
						)
						.get(graphId)
				: this.#db
						.query("SELECT graph_id,revision,digest,content FROM graph_snapshots WHERE graph_id=? AND revision=?")
						.get(graphId, revision);
		return (row as GraphSnapshot | null) ?? null;
	}

	/** Current revisions only, in stable Graph order. Read-only discovery, not execution authority. */
	listDefinitions(): GraphSnapshot[] {
		this.#access();
		return this.#db
			.query(
				"SELECT s.graph_id,s.revision,s.digest,s.content FROM graph_snapshots s JOIN graph_definitions d ON d.graph_id=s.graph_id AND d.revision=s.revision ORDER BY s.graph_id",
			)
			.all() as GraphSnapshot[];
	}

	requestGet(requestKey: string, authoringOnly = false): GraphOperation | null {
		this.#access();
		const row = this.#db.query("SELECT canonical,result FROM graph_requests WHERE request_key=?").get(requestKey) as {
			canonical: string;
			result: string;
		} | null;
		if (!row) return null;
		if (authoringOnly) {
			const request = JSON.parse(row.canonical) as { operation?: string };
			if (
				!["create", "import", "edit", "member.add", "node.add", "connect", "permit"].includes(
					request.operation ?? "",
				)
			)
				throw new AuthoringError("permission_denied", "Execution request authorization is unavailable");
		}
		return JSON.parse(row.result) as GraphOperation;
	}

	/** Non-throwing ownership summary: callers turn a key collision into a precise
	 * conflict instead of an authorization denial. Reads only operation and target;
	 * the stored payload and receipt stay unread. */
	requestKeySummary(requestKey: string): { operation: string; target_id: string | null } | null {
		this.#access();
		const row = this.#db.query("SELECT canonical FROM graph_requests WHERE request_key=?").get(requestKey) as {
			canonical: string;
		} | null;
		if (!row) return null;
		let request: { operation?: unknown; target_id?: unknown };
		try {
			request = JSON.parse(row.canonical) as { operation?: unknown; target_id?: unknown };
		} catch {
			return { operation: "unknown", target_id: null };
		}
		return {
			operation: typeof request.operation === "string" ? request.operation : "unknown",
			target_id: typeof request.target_id === "string" ? request.target_id : null,
		};
	}

	/** Read-only reconciliation; observing a Run does not authorize its mutation receipts.
	 * The gate runs synchronously against the original request inside a consistent snapshot. */
	requestGetAuthorized(
		requestKey: string,
		authorizeExecution?: GraphExecutionReceiptAuthorizer,
	): { kind: "definition" | "execution" | "publication"; receipt: GraphOperation } | null {
		this.#access();
		return this.#db.transaction(() => {
			const row = this.#db
				.query("SELECT canonical,result FROM graph_requests WHERE request_key=?")
				.get(requestKey) as {
				canonical: string;
				result: string;
			} | null;
			if (!row) return null;
			const request = JSON.parse(row.canonical) as GraphExecutionReceiptRequest;
			const execution = !["create", "import", "edit", "member.add", "node.add", "connect", "permit"].includes(
				request.operation,
			);
			if (execution) {
				if (
					!authorizeExecution ||
					request.version !== 1 ||
					request.request_key !== requestKey ||
					!["start", "answer", "hold", "resume", "cancel", "artifact.publish"].includes(request.operation) ||
					typeof request.target_id !== "string" ||
					!request.target_id ||
					(request.operation === "artifact.publish"
						? request.if_revision !== null
						: typeof request.if_revision !== "string" || !request.if_revision) ||
					!request.payload ||
					typeof request.payload !== "object" ||
					Array.isArray(request.payload)
				)
					throw new AuthoringError("permission_denied", "Execution receipt read authorization denied");
				const authorization: unknown = authorizeExecution(structuredClone(request));
				if (authorization !== true) {
					if (authorization instanceof Promise) void authorization.catch(() => {});
					throw new AuthoringError("permission_denied", "Execution receipt read authorization denied");
				}
				this.#access();
			}
			return {
				kind:
					request.operation === "artifact.publish"
						? ("publication" as const)
						: execution
							? ("execution" as const)
							: ("definition" as const),
				receipt: JSON.parse(row.result) as GraphOperation,
			};
		})();
	}

	getIntent(principalId: string, intentId: string): GraphAuthoringIntent | null {
		this.#access();
		intentIdentity(principalId, "principal_id");
		intentIdentity(intentId, "intent_id");
		const row = this.#db
			.query(
				"SELECT source_id,source_binding,request FROM graph_authoring_intents WHERE principal_id=? AND intent_id=?",
			)
			.get(principalId, intentId) as { source_id: string; source_binding: string; request: string } | null;
		return row
			? {
					principal_id: principalId,
					intent_id: intentId,
					source_id: row.source_id,
					source_binding: row.source_binding,
					request: JSON.parse(row.request) as GraphMutation,
				}
			: null;
	}

	/** An intent's original mutation must match the request ledger before its receipt is exposed.
	 * A rejected key collision never acquires the other request's successful outcome. */
	getIntentOperation(principalId: string, intentId: string): GraphOperation | null {
		const intent = this.getIntent(principalId, intentId);
		if (!intent) return null;
		const row = this.#db
			.query("SELECT canonical FROM graph_requests WHERE request_key=?")
			.get(intent.request.request_key) as { canonical: string } | null;
		if (!row) return null;
		if (row.canonical !== canonicalJson(intent.request)) return this.#requestConflict(intent.request);
		return this.requestGet(intent.request.request_key, true);
	}

	applyIntent(intent: GraphAuthoringIntent, assertAuthorized: () => void): GraphOperation {
		this.#access();
		const principalId = intentIdentity(intent?.principal_id, "principal_id");
		const intentId = intentIdentity(intent?.intent_id, "intent_id");
		const sourceId = intentIdentity(intent?.source_id, "source_id");
		const sourceBinding = intentIdentity(intent?.source_binding, "source_binding");
		let canonical: string;
		let request: GraphMutation;
		try {
			request = structuredClone(intent.request);
			freezeJson(request);
			canonical = canonicalJson(request);
		} catch (error) {
			throw new AuthoringError(
				"definition_invalid",
				error instanceof Error ? error.message : "Invalid intent mutation",
			);
		}
		return this.#db
			.transaction(() => {
				const existing = this.#db
					.query(
						"SELECT source_id,source_binding,request FROM graph_authoring_intents WHERE principal_id=? AND intent_id=?",
					)
					.get(principalId, intentId) as { source_id: string; source_binding: string; request: string } | null;
				if (
					existing &&
					(existing.source_id !== sourceId ||
						existing.source_binding !== sourceBinding ||
						existing.request !== canonical)
				)
					throw new AuthoringError("idempotency_conflict", "Intent was already used for a different mutation");
				// A pending promise cannot authorize this synchronous write transaction.
				const authorization: unknown = assertAuthorized();
				if (authorization !== undefined) {
					if (authorization instanceof Promise) void authorization.catch(() => {});
					throw new AuthoringError("permission_denied", "Authorization must complete synchronously");
				}
				// Bun nests mutate's transaction as a savepoint inside this immediate transaction.
				const result = this.mutate(request);
				if (!existing)
					this.#db
						.query("INSERT INTO graph_authoring_intents VALUES (?,?,?,?,?)")
						.run(principalId, intentId, sourceId, sourceBinding, canonical);
				return result;
			})
			.immediate();
	}

	mutate(request: GraphMutation): GraphOperation {
		this.#access();
		if (!request || typeof request.request_key !== "string" || !request.request_key)
			return this.#rejected(
				typeof request?.request_key === "string" ? request.request_key : "",
				null,
				new AuthoringError("definition_invalid", "request_key must be nonempty"),
			);
		let fingerprint: string;
		try {
			fingerprint = canonicalJson(request);
		} catch (error) {
			return this.#rejected(request.request_key, request.target_id ?? null, error);
		}
		return this.#db
			.transaction(() => {
				const existing = this.#db
					.query("SELECT canonical,result FROM graph_requests WHERE request_key=?")
					.get(request.request_key) as { canonical: string; result: string } | null;
				if (existing)
					return existing.canonical === fingerprint
						? (JSON.parse(existing.result) as GraphOperation)
						: this.#requestConflict(request);
				let result: GraphOperation;
				try {
					result = this.#apply(request);
				} catch (error) {
					if (!(error instanceof AuthoringError)) throw error;
					result = this.#rejected(request.request_key, request.target_id ?? null, error);
				}
				this.#db
					.query("INSERT INTO graph_requests VALUES (?,?,?)")
					.run(request.request_key, fingerprint, JSON.stringify(result));
				return result;
			})
			.immediate();
	}

	#requestConflict(request: GraphMutation): GraphOperation {
		return this.#rejected(
			request.request_key,
			request.target_id ?? null,
			new AuthoringError("idempotency_conflict", "Request key was already used for a different mutation"),
		);
	}

	#rejected(key: string, target: string | null, error: unknown): GraphOperation {
		const failure =
			error instanceof AuthoringError
				? error
				: new AuthoringError("definition_invalid", error instanceof Error ? error.message : "Invalid definition");
		const issues = failure.details?.issues as (GraphIssue & { location?: GraphError["location"] })[] | undefined;
		const location = issues?.length
			? (issues[0].location ?? { file: "GRAPH.md", path: issues[0].path, line: null, column: null })
			: null;
		return {
			request_key: key,
			state: "rejected",
			target_id: target,
			revision: null,
			result_ref: null,
			error: { code: failure.code, message: failure.message, location, retryable: false, details: failure.details },
		};
	}

	#validate(content: string) {
		try {
			const result = validateGraphDefinition(content, this.limits);
			if (result.issues.length)
				throw new AuthoringError("definition_invalid", "Graph definition is invalid", { issues: result.issues });
			return result;
		} catch (error) {
			if (error instanceof AuthoringError) throw error;
			const message = error instanceof Error ? error.message : "Invalid graph definition";
			throw new AuthoringError(
				/(?:exceeds .*limit|alias count|excessive alias)/i.test(message) ? "resource_limit" : "definition_invalid",
				message,
				error instanceof GraphSourceError
					? { issues: [{ path: error.location.path, message, location: error.location }] }
					: null,
			);
		}
	}

	#apply(request: GraphMutation): GraphOperation {
		if (request.version !== 1) throw new AuthoringError("unsupported_version", "Unsupported mutation version");
		if (
			Object.keys(request).sort().join("\0") !==
			["version", "request_key", "operation", "target_id", "if_revision", "payload"].sort().join("\0")
		)
			throw new AuthoringError("definition_invalid", "Invalid mutation fields");
		const creating = request.operation === "create" || request.operation === "import";
		if (
			creating
				? request.target_id !== null || request.if_revision !== null
				: typeof request.target_id !== "string" ||
					!request.target_id ||
					typeof request.if_revision !== "string" ||
					!/^(0|[1-9][0-9]*)$/.test(request.if_revision)
		)
			throw new AuthoringError("definition_invalid", "Invalid target or revision guard");
		let graphId = request.target_id;
		let current: GraphSnapshot | null = null;
		if (!creating) {
			current = this.get(graphId!);
			if (!current) throw new AuthoringError("unknown_graph", "Graph does not exist");
			if (current.revision !== request.if_revision)
				throw new AuthoringError("revision_conflict", "Definition revision has changed", {
					expected_revision: request.if_revision,
					current_revision: current.revision,
				});
		}
		let content: string;
		switch (request.operation) {
			case "create": {
				payloadFields(request.payload, ["name"]);
				const name = requiredString(request.payload.name, "name");
				if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new AuthoringError("definition_invalid", "Invalid graph name");
				content = `---\nformat: omp.graph/v1\nname: ${name}\nmembers: {}\nnodes: {}\n---\n`;
				break;
			}
			case "import":
			case "edit":
				payloadFields(request.payload, ["content"]);
				content = requiredString(request.payload.content, "content");
				break;
			case "member.add":
			case "node.add":
			case "connect":
			case "permit":
				content = this.#incremental(current!.content, request);
				break;
			default:
				throw new AuthoringError("definition_invalid", "Unsupported authoring operation");
		}
		this.#validate(content);
		const hash = `sha256:${Bun.SHA256.hash(content, "hex")}`;
		// Importing the same bytes twice is a repeat of one intent, not a second Graph. Reusing
		// the existing current definition keeps discovery free of indistinguishable rows and
		// leaves every Run bound to the id it actually started from. A Graph whose current
		// revision differs is a different definition and still imports as a new one.
		if (request.operation === "import") {
			const existing = this.#db
				.query(
					"SELECT s.graph_id AS graph_id, s.revision AS revision FROM graph_snapshots s JOIN graph_definitions d ON d.graph_id=s.graph_id AND d.revision=s.revision WHERE s.digest=? ORDER BY s.rowid DESC LIMIT 1",
				)
				.get(hash) as { graph_id: string; revision: string } | null;
			if (existing) {
				return {
					request_key: request.request_key,
					state: "completed",
					target_id: existing.graph_id,
					revision: existing.revision,
					result_ref: { id: `${existing.graph_id}@${existing.revision}`, digest: hash },
					error: null,
				};
			}
		}
		const revision = current ? (BigInt(current.revision) + 1n).toString() : "1";
		if (!graphId) {
			graphId = crypto.randomUUID();
			this.#db.query("INSERT INTO graph_definitions VALUES (?,?)").run(graphId, revision);
		} else {
			this.#db
				.query("UPDATE graph_definitions SET revision=? WHERE graph_id=? AND revision=?")
				.run(revision, graphId, current!.revision);
		}
		this.#db.query("INSERT INTO graph_snapshots VALUES (?,?,?,?)").run(graphId, revision, hash, content);
		return {
			request_key: request.request_key,
			state: "completed",
			target_id: graphId,
			revision,
			result_ref: { id: `${graphId}@${revision}`, digest: hash },
			error: null,
		};
	}

	#incremental(content: string, request: GraphMutation): string {
		const adding = request.operation === "member.add" || request.operation === "node.add";
		payloadFields(request.payload, adding ? ["key", "value", "body"] : ["value"]);
		const parsed = this.#validate(content).source;
		const doc = parsed.frontmatter.document;
		const section =
			request.operation === "member.add"
				? "members"
				: request.operation === "node.add"
					? "nodes"
					: request.operation === "connect"
						? "edges"
						: "communications";
		// Detach aliases on either side of the edited section before mutating it.
		const target = doc.get(section, true);
		if (isAlias(target)) {
			doc.set(section, doc.createNode(parsed.frontmatter.frontmatter[section]));
		} else if (target) {
			visit(doc, {
				Alias(_key, alias) {
					if (alias.resolve(doc) === target) return doc.createNode(parsed.frontmatter.frontmatter[section]);
				},
			});
		}
		let body = "";
		if (adding) {
			const key = requiredString(request.payload.key, "key");
			body = requiredString(request.payload.body, "body");
			if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new AuthoringError("definition_invalid", "Invalid definition key");
			const map = doc.get(section, true);
			if (!isMap(map) || map.has(key))
				throw new AuthoringError("definition_invalid", `Duplicate or invalid ${section} key`);
			const value = request.payload.value;
			const reference =
				value && typeof value === "object" && !Array.isArray(value)
					? (value as Record<string, unknown>)[request.operation === "member.add" ? "role" : "task"]
					: undefined;
			const heading =
				typeof reference === "string" && /^#[a-z][a-z0-9-]*$/.test(reference) ? reference.slice(1) : key;
			if (parsed.headings.has(heading))
				throw new AuthoringError("definition_invalid", `Body section '${heading}' already exists`);
			map.set(key, doc.createNode(request.payload.value));
			const newline = content.includes("\r\n") ? "\r\n" : "\n";
			body = `${content.endsWith("\n") || content.endsWith("\r") ? "" : newline}${newline}## ${heading}${newline}${body}${body.endsWith("\n") || body.endsWith("\r") ? "" : newline}`;
		} else {
			let sequence = doc.get(section, true);
			if (sequence === undefined) {
				doc.set(section, doc.createNode([]));
				sequence = doc.get(section, true);
			}
			if (!isSeq(sequence)) throw new AuthoringError("definition_invalid", `Invalid ${section}`);
			sequence.add(doc.createNode(request.payload.value));
		}
		const offset = parsed.frontmatter.metadataOffset;
		const bodyStart = content.length - parsed.frontmatter.body.length;
		const metadataAndClosing = content.slice(offset, bodyStart);
		const close = /^---[ \t]*(?:\r\n|\n|\r|$)/m.exec(metadataAndClosing);
		if (!close) throw new AuthoringError("definition_invalid", "Missing closing frontmatter delimiter");
		const newline = content.slice(0, offset).endsWith("\r\n") ? "\r\n" : "\n";
		const metadata = doc.toString().replace(/\n/g, newline);
		return (
			content.slice(0, offset) + metadata + metadataAndClosing.slice(close.index) + content.slice(bodyStart) + body
		);
	}
}

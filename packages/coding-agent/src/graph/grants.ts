import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";

export interface GraphGrantExecutor {
	kind: "bot" | "program" | "queue" | "human" | "subgraph";
	/** Trusted executor identity, not executable text supplied by a Graph. */
	id: string;
	configuration: GraphRef;
}

export interface GraphGrantScope {
	graph_id: string;
	definition_revision: string;
	definition_digest: string;
	executors: GraphGrantExecutor[];
}

export interface GraphGrant {
	id: string;
	owner: string;
	scope: GraphGrantScope;
}

export interface GraphGrantUse {
	owner: string;
	graph_id: string;
	definition_revision: string;
	definition_digest: string;
	executor: GraphGrantExecutor;
}

export interface GraphGrantOptions {
	database: Database;
	/** Trusted authentication/authorization, called in the database transaction. Only literal true grants access. */
	authorize: (db: Database, action: "issue" | "revoke" | "use", principal: string, grant: GraphGrant) => boolean;
	/** Verify the current protected definition revision and digest on issue and every use. */
	definitionCurrent: (db: Database, scope: GraphGrantScope) => boolean;
}

export class GraphGrantError extends Error {
	constructor(
		readonly code: "invalid" | "permission_denied" | "conflict" | "unknown_reference" | "revoked",
		message: string,
	) {
		super(message);
		this.name = "GraphGrantError";
	}
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const revision = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const kinds: Record<string, true> = { bot: true, program: true, queue: true, human: true, subgraph: true };

function executorCopy(value: GraphGrantExecutor): GraphGrantExecutor {
	if (
		!value ||
		!Object.hasOwn(kinds, value.kind) ||
		!nonempty(value.id) ||
		!value.configuration ||
		!nonempty(value.configuration.id) ||
		!digest(value.configuration.digest)
	) {
		throw new GraphGrantError("invalid", "Invalid executor scope");
	}
	return {
		kind: value.kind,
		id: value.id,
		configuration: { id: value.configuration.id, digest: value.configuration.digest },
	};
}

function scopeCopy(value: GraphGrantScope): GraphGrantScope {
	if (
		!value ||
		!nonempty(value.graph_id) ||
		!revision(value.definition_revision) ||
		!digest(value.definition_digest) ||
		!Array.isArray(value.executors) ||
		value.executors.length === 0
	) {
		throw new GraphGrantError("invalid", "Invalid grant scope");
	}
	const executors = value.executors.map(executorCopy);
	executors.sort((a, b) => {
		const left = JSON.stringify(a);
		const right = JSON.stringify(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
	if (new Set(executors.map(item => JSON.stringify(item))).size !== executors.length)
		throw new GraphGrantError("invalid", "Duplicate executor scope");
	return {
		graph_id: value.graph_id,
		definition_revision: value.definition_revision,
		definition_digest: value.definition_digest,
		executors,
	};
}

function fingerprint(data: string): string {
	return `sha256:${Bun.SHA256.hash(data, "hex")}`;
}

type GrantRow = { data: string; digest: string; revoked: number };

export function installGraphGrantSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS graph_owner_grants (id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));
CREATE TABLE IF NOT EXISTS graph_owner_grant_requests (request_key TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, grant_id TEXT NOT NULL UNIQUE REFERENCES graph_owner_grants(id));`);
}

/**
 * Trusted-host primitive only. It neither starts a worker nor provides process containment.
 * The database must be protected against untrusted writes and rollback/restoration. Callbacks
 * must use this database for mutable authority. A future dispatch integration must check a grant
 * inside the same write transaction as its dispatch/fence transition and must independently
 * enforce that fence and stop/contain already-running processes on revocation.
 */
export class GraphGrants {
	readonly #db: Database;
	readonly #authorize: GraphGrantOptions["authorize"];
	readonly #definitionCurrent: GraphGrantOptions["definitionCurrent"];

	constructor(options: GraphGrantOptions) {
		this.#db = options.database;
		this.#authorize = options.authorize;
		this.#definitionCurrent = options.definitionCurrent;
		installGraphGrantSchema(this.#db);
	}

	#load(reference: GraphRef): { grant: GraphGrant; row: GrantRow } {
		if (!reference || !nonempty(reference.id) || !digest(reference.digest))
			throw new GraphGrantError("invalid", "Invalid grant reference");
		const row = this.#db
			.query("SELECT data,digest,revoked FROM graph_owner_grants WHERE id=?")
			.get(reference.id) as GrantRow | null;
		if (!row) throw new GraphGrantError("unknown_reference", "Grant not found");
		if (row.digest !== reference.digest || fingerprint(row.data) !== row.digest)
			throw new GraphGrantError("conflict", "Grant reference or stored content does not match");
		let grant: GraphGrant;
		try {
			const parsed = JSON.parse(row.data) as GraphGrant;
			grant = { id: parsed.id, owner: parsed.owner, scope: scopeCopy(parsed.scope) };
			if (grant.id !== reference.id || !nonempty(grant.owner) || JSON.stringify(grant) !== row.data)
				throw new Error();
		} catch {
			throw new GraphGrantError("conflict", "Invalid stored grant");
		}
		return { grant, row };
	}

	#check(action: "issue" | "revoke" | "use", principal: string, grant: GraphGrant): void {
		if (!nonempty(principal) || this.#authorize(this.#db, action, principal, structuredClone(grant)) !== true)
			throw new GraphGrantError("permission_denied", "Grant authorization denied");
	}

	/** Request keys are retained forever; replay of a revoked issuance can never recreate authority. */
	issue(principal: string, requestKey: string, scope: GraphGrantScope): GraphRef {
		if (!nonempty(principal) || !nonempty(requestKey))
			throw new GraphGrantError("invalid", "Invalid owner or request key");
		const normalized = scopeCopy(scope);
		const encoded = JSON.stringify(normalized);
		return this.#db
			.transaction(() => {
				const prior = this.#db
					.query("SELECT owner,scope,grant_id FROM graph_owner_grant_requests WHERE request_key=?")
					.get(requestKey) as { owner: string; scope: string; grant_id: string } | null;
				if (prior) {
					if (prior.owner !== principal || prior.scope !== encoded)
						throw new GraphGrantError("conflict", "Grant request key already used");
					const row = this.#db.query("SELECT digest FROM graph_owner_grants WHERE id=?").get(prior.grant_id) as {
						digest: string;
					} | null;
					if (!row) throw new GraphGrantError("conflict", "Grant request ledger is inconsistent");
					const reference = { id: prior.grant_id, digest: row.digest };
					const loaded = this.#load(reference);
					if (loaded.grant.owner !== principal || JSON.stringify(loaded.grant.scope) !== encoded)
						throw new GraphGrantError("conflict", "Grant request ledger is inconsistent");
					this.#check("issue", principal, loaded.grant);
					if (loaded.row.revoked !== 0) throw new GraphGrantError("revoked", "Grant was revoked");
					if (this.#definitionCurrent(this.#db, structuredClone(loaded.grant.scope)) !== true)
						throw new GraphGrantError("conflict", "Definition is no longer current");
					return reference;
				}
				const grant: GraphGrant = { id: randomUUID(), owner: principal, scope: normalized };
				this.#check("issue", principal, grant);
				if (this.#definitionCurrent(this.#db, structuredClone(normalized)) !== true)
					throw new GraphGrantError("conflict", "Definition is no longer current");
				const data = JSON.stringify(grant);
				const reference = { id: grant.id, digest: fingerprint(data) };
				this.#db.query("INSERT INTO graph_owner_grants VALUES (?,?,?,0)").run(grant.id, data, reference.digest);
				this.#db
					.query("INSERT INTO graph_owner_grant_requests VALUES (?,?,?,?)")
					.run(requestKey, principal, encoded, grant.id);
				return reference;
			})
			.immediate();
	}

	/** Revocation is permanent for this grant, including after restart and issuance replay. */
	revoke(principal: string, reference: GraphRef): void {
		this.#db
			.transaction(() => {
				const { grant } = this.#load(reference);
				if (principal !== grant.owner)
					throw new GraphGrantError("permission_denied", "Only the owner may revoke a grant");
				this.#check("revoke", principal, grant);
				this.#db.query("UPDATE graph_owner_grants SET revoked=1 WHERE id=?").run(grant.id);
			})
			.immediate();
	}

	/**
	 * Requires the caller's write transaction containing the dispatch/fence transition.
	 * Transaction presence alone cannot prove that transition is included; this is not a launch permit.
	 */
	assertUsable(principal: string, reference: GraphRef, use: GraphGrantUse): void {
		if (!this.#db.inTransaction)
			throw new GraphGrantError("permission_denied", "Grant use requires a caller-owned dispatch transaction");
		const { grant, row } = this.#load(reference);
		this.#check("use", principal, grant);
		if (row.revoked !== 0) throw new GraphGrantError("revoked", "Grant was revoked");
		if (!use || !nonempty(use.owner)) throw new GraphGrantError("invalid", "Invalid grant use");
		const executor = executorCopy(use.executor);
		if (
			use.owner !== grant.owner ||
			use.graph_id !== grant.scope.graph_id ||
			use.definition_revision !== grant.scope.definition_revision ||
			use.definition_digest !== grant.scope.definition_digest ||
			!grant.scope.executors.some(item => JSON.stringify(item) === JSON.stringify(executor))
		) {
			throw new GraphGrantError("permission_denied", "Grant does not cover this execution");
		}
		if (this.#definitionCurrent(this.#db, structuredClone(grant.scope)) !== true)
			throw new GraphGrantError("conflict", "Definition is no longer current");
	}
}

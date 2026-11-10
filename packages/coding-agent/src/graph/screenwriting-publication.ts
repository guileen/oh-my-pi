import type { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { ArtifactPublication, GraphArtifactRegistry, PreparedArtifactRegistration } from "./artifacts";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import { GraphHumanError } from "./human";
import {
	readScreenwritingApprovalEvidence,
	screenwritingApprovalQuestionRef,
	type ScreenwritingApprovalProposal,
} from "./screenwriting-approval";
import { buildScreenwritingRevisionCandidate, type ScreenwritingRevisionPatch } from "./screenwriting-revision-scope";

export interface ScreenwritingPublicationAuthority {
	request_key: string;
	proposal: ScreenwritingApprovalProposal;
	evidence_ref: GraphRef;
	/** Exact current Run revision, captured after the approval answer committed. */
	run_revision: string;
	media_type: string;
	access_scope: string[];
}

export interface ScreenwritingPublicationRequest {
	request_key: string;
	authority_ref: GraphRef;
	patches: readonly ScreenwritingRevisionPatch[];
}

/** Trusted executor completion, never a model-supplied publication permission. */
export interface ScreenwritingPublicationTarget {
	run_id: string;
	invocation_id: string;
	attempt_id: string;
	fence: string;
	output: string;
	outcome: string;
	verdict?: string | null;
}

export interface ScreenwritingPublicationsOptions {
	database: Database;
	human: Parameters<typeof readScreenwritingApprovalEvidence>[0];
	/** Must use the same injected database connection as this ledger. */
	artifacts: GraphArtifactRegistry;
	/** Current Store owner/epoch fence; also required when reconciling historical receipts. */
	assertOwner(): void;
	/** Store-owned synchronous check, called inside issuance/publication write transactions.
	 * Must throw unless the Run is running at this revision, its exact approval invocation is
	 * succeeded/APPROVE/approve and not superseded, source/input commitments are current, and
	 * subject and scope are actual pinned inputs. This is not a model-supplied policy callback. */
	checkCurrent(proposal: ScreenwritingApprovalProposal, runRevision: string): void;
}

declare const preparedPublication: unique symbol;
export interface PreparedScreenwritingPublication {
	readonly [preparedPublication]: true;
}

type Authority = ScreenwritingPublicationAuthority & { id: string };
type AuthorityRow = { data: string; digest: string; revoked: number };
type Prepared = {
	principal: string;
	request_key: string;
	authority_ref: GraphRef;
	canonical: string;
	result: GraphRef;
	registration?: PreparedArtifactRegistration;
};

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const hash = (value: string | Uint8Array) => `sha256:${Bun.SHA256.hash(value, "hex")}`;

function reference(value: GraphRef): GraphRef {
	if (!value || !nonempty(value.id) || !/^sha256:[0-9a-f]{64}$/.test(value.digest))
		throw new GraphHumanError("invalid", "Invalid publication reference");
	return { id: value.id, digest: value.digest };
}

/** Trusted-host-only durable application gate. No worker/CLI dispatch is enabled by this class.
 * Issue/revoke must be wrapped by the Store's authenticated current-owner/epoch transaction.
 * Historical evidence alone cannot publish: authority is separately issued, permanently revocable,
 * single-use, and checked again with live applicability at the artifact registration boundary.
 * Failed/racing preparations can leave unregistered immutable files, never a published reference. */
export class GraphScreenwritingPublications {
	readonly #options: ScreenwritingPublicationsOptions;
	readonly #prepared = new WeakMap<PreparedScreenwritingPublication, Prepared>();

	constructor(options: ScreenwritingPublicationsOptions) {
		this.#options = { ...options };
		options.artifacts.assertDatabase(options.database);
		options.database.exec(`CREATE TABLE IF NOT EXISTS graph_screenwriting_authorities (
	id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL,
	request_key TEXT NOT NULL UNIQUE, evidence_id TEXT NOT NULL UNIQUE,
	revoked INTEGER NOT NULL CHECK(revoked IN (0,1))
);
CREATE TABLE IF NOT EXISTS graph_screenwriting_publications (
	request_key TEXT PRIMARY KEY, authority_id TEXT NOT NULL UNIQUE,
	canonical TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_screenwriting_task_publications (
	request_key TEXT PRIMARY KEY, target TEXT NOT NULL
);`);
	}

	#assertOwner(): void {
		if (!this.#options.database.inTransaction)
			throw new GraphHumanError("permission_denied", "Publication requires the Store owner transaction");
		const result: unknown = this.#options.assertOwner();
		if (result !== undefined)
			throw new GraphHumanError("permission_denied", "Owner fence must complete synchronously");
	}

	#load(ref: GraphRef): { authority: Authority; revoked: boolean } {
		const requested = reference(ref);
		const row = this.#options.database
			.query("SELECT data,digest,revoked FROM graph_screenwriting_authorities WHERE id=?")
			.get(requested.id) as AuthorityRow | null;
		if (!row) throw new GraphHumanError("unknown_reference", "Revision authority not found");
		if (row.digest !== requested.digest || hash(row.data) !== requested.digest)
			throw new GraphHumanError("input_stale", "Revision authority commitment mismatch");
		const authority = JSON.parse(row.data) as Authority;
		if (authority.id !== requested.id)
			throw new GraphHumanError("input_stale", "Revision authority identity mismatch");
		return { authority, revoked: row.revoked !== 0 };
	}

	#evidence(authority: Authority, principal: string): void {
		if (principal !== authority.proposal.principal)
			throw new GraphHumanError("permission_denied", "Only the approved author may publish this revision");
		readScreenwritingApprovalEvidence(this.#options.human, principal, authority.evidence_ref, authority.proposal);
	}

	#current(authority: Authority): void {
		const result: unknown = this.#options.checkCurrent(structuredClone(authority.proposal), authority.run_revision);
		if (result !== undefined)
			throw new GraphHumanError("input_stale", "Current applicability must be checked synchronously");
		for (const ref of [authority.proposal.subject, authority.proposal.change_scope]) {
			if (this.#options.artifacts.lookup(ref)?.availability !== "available")
				throw new GraphHumanError("input_stale", "Approved revision input is no longer available");
		}
	}

	/** Called only in an authenticated Store owner/epoch write transaction; never from Graph input.
	 * An approval can issue only one authority, so neither replay nor a new key revives revocation. */
	issue(value: ScreenwritingPublicationAuthority): GraphRef {
		const db = this.#options.database;
		if (!db.inTransaction)
			throw new GraphHumanError("permission_denied", "Authority issuance requires the Store owner transaction");
		this.#assertOwner();
		const copy = structuredClone(value);
		screenwritingApprovalQuestionRef(copy.proposal);
		if (
			!nonempty(copy.request_key) ||
			!/^(0|[1-9][0-9]*)$/.test(copy.run_revision) ||
			!nonempty(copy.media_type) ||
			!Array.isArray(copy.access_scope) ||
			copy.access_scope.length === 0 ||
			copy.access_scope.some(item => !nonempty(item)) ||
			new Set(copy.access_scope).size !== copy.access_scope.length
		)
			throw new GraphHumanError("invalid", "Invalid revision publication authority");
		const normalized: ScreenwritingPublicationAuthority = {
			request_key: copy.request_key,
			proposal: copy.proposal,
			evidence_ref: reference(copy.evidence_ref),
			run_revision: copy.run_revision,
			media_type: copy.media_type,
			access_scope: copy.access_scope,
		};
		const prior = db
			.query("SELECT id,digest FROM graph_screenwriting_authorities WHERE request_key=?")
			.get(normalized.request_key) as GraphRef | null;
		if (prior) {
			const { authority, revoked } = this.#load(prior);
			const { id: _id, ...original } = authority;
			if (canonicalJson(original) !== canonicalJson(normalized))
				throw new GraphHumanError("idempotency_conflict", "Authority key already used for another proposal");
			this.#evidence(authority, normalized.proposal.principal);
			if (revoked) throw new GraphHumanError("permission_denied", "Revision authority was revoked");
			this.#current(authority);
			return prior;
		}
		if (db.query("SELECT 1 FROM graph_screenwriting_authorities WHERE evidence_id=?").get(normalized.evidence_ref.id))
			throw new GraphHumanError("idempotency_conflict", "Approval already bound to a revision authority");
		const authority: Authority = { ...normalized, id: crypto.randomUUID() };
		this.#evidence(authority, authority.proposal.principal);
		this.#current(authority);
		const data = canonicalJson(authority);
		const result = { id: authority.id, digest: hash(data) };
		db.query("INSERT INTO graph_screenwriting_authorities VALUES (?,?,?,?,?,0)").run(
			result.id,
			data,
			result.digest,
			authority.request_key,
			authority.evidence_ref.id,
		);
		return result;
	}

	/** Permanent and idempotent, including after process restart. Store authenticates the revoker. */
	revoke(ref: GraphRef): void {
		const db = this.#options.database;
		if (!db.inTransaction)
			throw new GraphHumanError("permission_denied", "Authority revocation requires the Store owner transaction");
		this.#assertOwner();
		const { authority } = this.#load(ref);
		db.query("UPDATE graph_screenwriting_authorities SET revoked=1 WHERE id=?").run(authority.id);
	}

	#prior(requestKey: string, canonical: string): GraphRef | null {
		const row = this.#options.database
			.query("SELECT canonical,result FROM graph_screenwriting_publications WHERE request_key=?")
			.get(requestKey) as { canonical: string; result: string } | null;
		if (!row) return null;
		if (row.canonical !== canonical)
			throw new GraphHumanError(
				"idempotency_conflict",
				"Publication key already used for different bytes or authority",
			);
		return JSON.parse(row.result) as GraphRef;
	}

	#unused(ref: GraphRef): void {
		if (
			this.#options.database.query("SELECT 1 FROM graph_screenwriting_publications WHERE authority_id=?").get(ref.id)
		)
			throw new GraphHumanError("permission_denied", "Revision authority has already been applied");
	}

	async prepare(
		principal: string,
		request: ScreenwritingPublicationRequest,
	): Promise<PreparedScreenwritingPublication> {
		if (
			!nonempty(principal) ||
			!nonempty(request?.request_key) ||
			!Array.isArray(request.patches) ||
			request.patches.length > 1024
		)
			throw new GraphHumanError("invalid", "Invalid revision publication request");
		const authorityRef = reference(request.authority_ref);
		const requestKey = request.request_key;
		let total = 0;
		const patches = request.patches.map(patch => {
			if (!patch || !Number.isSafeInteger(patch.range) || !(patch.replacement instanceof Uint8Array))
				throw new GraphHumanError("invalid", "Invalid revision patch");
			total += patch.replacement.byteLength;
			if (total > 16 * 1024 * 1024) throw new GraphHumanError("invalid", "Revision patches exceed size limit");
			return { range: patch.range, replacement: Uint8Array.from(patch.replacement) };
		});
		const canonical = canonicalJson({
			principal,
			request_key: requestKey,
			authority_ref: authorityRef,
			patches: patches.map(patch => [patch.range, patch.replacement.byteLength, hash(patch.replacement)]),
		});
		const { authority, prior } = this.#options.database
			.transaction(() => {
				this.#assertOwner();
				const { authority, revoked } = this.#load(authorityRef);
				this.#evidence(authority, principal);
				const prior = this.#prior(requestKey, canonical);
				if (!prior) {
					if (revoked) throw new GraphHumanError("permission_denied", "Revision authority was revoked");
					this.#unused(authorityRef);
					this.#current(authority);
				}
				return { authority, prior };
			})
			.immediate();
		let result = prior;
		let registration: PreparedArtifactRegistration | undefined;
		if (!result) {
			const artifacts = this.#options.artifacts;
			const subject = await artifacts.store.read(principal, authority.proposal.subject);
			const scope = await artifacts.store.read(principal, authority.proposal.change_scope);
			const bytes = buildScreenwritingRevisionCandidate(
				this.#options.human,
				principal,
				authority.evidence_ref,
				authority.proposal,
				subject,
				scope,
				patches,
			);
			const publication: ArtifactPublication = {
				media_type: authority.media_type,
				producer_attempt_id: null,
				source_ref: authority.proposal.subject,
				access_scope: authority.access_scope,
				expected_digest: hash(bytes),
			};
			const artifact = await artifacts.store.publish(principal, bytes, publication);
			registration = await artifacts.prepareRegistration([{ artifact, expected: publication }]);
			result = { id: artifact.id, digest: artifact.digest };
		}
		const token = {} as PreparedScreenwritingPublication;
		this.#prepared.set(token, {
			principal,
			request_key: requestKey,
			authority_ref: authorityRef,
			canonical,
			result,
			registration,
		});
		return token;
	}

	/** No async gap: live authority, immutable registration, and idempotent application receipt commit
	 * together. May be nested in a Store owner transaction alongside its Run/journal transition. */
	commit(token: PreparedScreenwritingPublication): GraphRef {
		const prepared = this.#prepared.get(token);
		if (!prepared) throw new GraphHumanError("invalid", "Unknown prepared revision publication");
		const db = this.#options.database;
		return db
			.transaction(() => {
				this.#assertOwner();
				const { authority, revoked } = this.#load(prepared.authority_ref);
				this.#evidence(authority, prepared.principal);
				const prior = this.#prior(prepared.request_key, prepared.canonical);
				if (prior) return prior;
				if (revoked) throw new GraphHumanError("permission_denied", "Revision authority was revoked");
				this.#unused(prepared.authority_ref);
				this.#current(authority);
				if (!prepared.registration) throw new GraphHumanError("invalid", "Missing prepared revision bytes");
				this.#options.artifacts.commitPrepared(prepared.registration, [prepared.result]);
				db.query("INSERT INTO graph_screenwriting_publications VALUES (?,?,?,?)").run(
					prepared.request_key,
					authority.id,
					prepared.canonical,
					JSON.stringify(prepared.result),
				);
				return { ...prepared.result };
			})
			.immediate();
	}

	/** Bind publication to one exact task transition in the same database transaction.
	 * The trusted Store callback must synchronously validate and settle the attempt or throw.
	 * Reconciliation returns the original result without running the transition again. */
	commitToAttempt(
		token: PreparedScreenwritingPublication,
		target: ScreenwritingPublicationTarget,
		complete: (
			result: GraphRef,
			registration: PreparedArtifactRegistration,
			proposal: ScreenwritingApprovalProposal,
		) => void,
	): GraphRef {
		const prepared = this.#prepared.get(token);
		if (!prepared) throw new GraphHumanError("invalid", "Unknown prepared revision publication");
		target = structuredClone(target);
		if (
			![target.run_id, target.invocation_id, target.attempt_id, target.fence, target.output, target.outcome].every(
				nonempty,
			) ||
			(target.verdict !== undefined && target.verdict !== null && !nonempty(target.verdict))
		)
			throw new GraphHumanError("invalid", "Invalid publication task target");
		const binding = canonicalJson(target);
		const db = this.#options.database;
		return db
			.transaction(() => {
				this.#assertOwner();
				const { authority } = this.#load(prepared.authority_ref);
				if (authority.proposal.run_id !== target.run_id)
					throw new GraphHumanError("permission_denied", "Publication belongs to another Run");
				const prior = this.#prior(prepared.request_key, prepared.canonical);
				const bound = db
					.query("SELECT target FROM graph_screenwriting_task_publications WHERE request_key=?")
					.get(prepared.request_key) as { target: string } | null;
				if (bound && bound.target !== binding)
					throw new GraphHumanError("idempotency_conflict", "Publication is bound to a different task completion");
				if (prior && !bound)
					throw new GraphHumanError("permission_denied", "Standalone publication cannot settle a task");
				if (bound && !prior) throw new GraphHumanError("invalid", "Publication completion receipt is missing");
				const result = this.commit(token);
				if (prior) return result;
				if (!prepared.registration) throw new GraphHumanError("invalid", "Missing prepared revision bytes");
				const returned: unknown = complete(
					{ ...result },
					prepared.registration,
					structuredClone(authority.proposal),
				);
				if (returned !== undefined)
					throw new GraphHumanError("invalid", "Task completion must finish synchronously");
				db.query("INSERT INTO graph_screenwriting_task_publications VALUES (?,?)").run(
					prepared.request_key,
					binding,
				);
				return result;
			})
			.immediate();
	}
}

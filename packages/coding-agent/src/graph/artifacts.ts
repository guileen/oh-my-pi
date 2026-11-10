import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";

export type ArtifactAvailability = "available" | "expired" | "missing" | "unknown";
export interface GraphArtifact {
	id: string;
	digest: string;
	media_type: string;
	size_bytes: number;
	availability: ArtifactAvailability;
	producer_attempt_id: string | null;
	source_ref: GraphRef | null;
	storage_ref: string;
	access_scope: string[];
	expires_at?: string | null;
}

export interface ArtifactPublication {
	media_type: string;
	producer_attempt_id: string | null;
	source_ref: GraphRef | null;
	access_scope: string[];
	expected_digest?: string | null;
}

/** Metadata and authorization are supplied by the trusted host, not by Graph content. */
export interface LocalArtifactStoreOptions {
	directory: string;
	maxBytes: number;
	lookup(ref: GraphRef): Promise<GraphArtifact | null>;
	authorize(principal: string, action: "read" | "publish", scope: readonly string[]): Promise<boolean>;
}

export class ArtifactError extends Error {
	constructor(
		readonly code:
			| "permission_denied"
			| "missing"
			| "expired"
			| "unknown"
			| "invalid"
			| "too_large"
			| "digest_mismatch",
		message: string,
	) {
		super(message);
		this.name = "ArtifactError";
	}
}

/** Publication returns metadata for the host to commit transactionally; uncommitted files are orphans. */
export class LocalArtifactStore {
	constructor(private readonly options: LocalArtifactStoreOptions) {
		if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
			throw new Error("Invalid artifact size limit");
	}

	async publish(
		principal: string,
		content: AsyncIterable<Uint8Array> | Uint8Array,
		publication: ArtifactPublication,
		/** Host validation of bounded, verified bytes before publication completes; requires read authorization. */
		validate?: (bytes: Uint8Array) => Promise<void>,
	): Promise<GraphArtifact> {
		publication = structuredClone(publication);
		const buffered = content instanceof Uint8Array;
		const oversized = content instanceof Uint8Array && content.byteLength > this.options.maxBytes;
		const chunks = content instanceof Uint8Array ? [oversized ? content : new Uint8Array(content)] : content;
		if ((await this.options.authorize(principal, "publish", [...publication.access_scope])) !== true)
			throw new ArtifactError("permission_denied", "Artifact publication denied");
		if (!publication.media_type || (!publication.producer_attempt_id && !publication.source_ref))
			throw new ArtifactError("invalid", "Artifact requires media type and provenance");
		if (oversized) throw new ArtifactError("too_large", "Artifact exceeds size limit");
		await fsp.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
		const id = crypto.randomUUID();
		const temporary = path.join(this.options.directory, `.${id}.tmp`);
		const destination = path.join(this.options.directory, id);
		const file = await fsp.open(temporary, "wx", 0o600);
		let linked = false;
		try {
			const hash = new Bun.CryptoHasher("sha256");
			let size = 0;
			for await (const value of chunks) {
				size += value.byteLength;
				if (size > this.options.maxBytes) throw new ArtifactError("too_large", "Artifact exceeds size limit");
				const chunk = buffered ? value : new Uint8Array(value);
				hash.update(chunk);
				let offset = 0;
				while (offset < chunk.byteLength) {
					const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
					if (!bytesWritten) throw new Error("Artifact write made no progress");
					offset += bytesWritten;
				}
			}
			const digest = `sha256:${hash.digest("hex")}`;
			if (publication.expected_digest && publication.expected_digest !== digest)
				throw new ArtifactError("digest_mismatch", "Artifact digest mismatch");
			await file.chmod(0o400);
			await file.sync();
			await fsp.link(temporary, destination);
			linked = true;
			const directory = await fsp.open(this.options.directory, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			const artifact: GraphArtifact = {
				id,
				digest,
				media_type: publication.media_type,
				size_bytes: size,
				availability: "available",
				producer_attempt_id: publication.producer_attempt_id,
				source_ref: publication.source_ref,
				storage_ref: id,
				access_scope: [...publication.access_scope],
			};
			if (validate) {
				if ((await this.options.authorize(principal, "read", [...artifact.access_scope])) !== true)
					throw new ArtifactError("permission_denied", "Artifact read denied");
				const bytes = await this.#readContent(artifact);
				if ((await this.options.authorize(principal, "read", [...artifact.access_scope])) !== true)
					throw new ArtifactError("permission_denied", "Artifact read denied");
				await validate(bytes);
				if ((await this.options.authorize(principal, "read", [...artifact.access_scope])) !== true)
					throw new ArtifactError("permission_denied", "Artifact read denied");
			}
			return artifact;
		} catch (error) {
			if (linked) await fsp.unlink(destination).catch(() => {});
			throw error;
		} finally {
			await file.close();
			await fsp.unlink(temporary).catch(() => {});
		}
	}

	async read(principal: string, ref: GraphRef): Promise<Uint8Array> {
		const { id, digest } = ref;
		const found = await this.options.lookup({ id, digest });
		const artifact = found ? structuredClone(found) : null;
		if (!artifact) throw new ArtifactError("missing", "Artifact not found");
		if (artifact.id !== id || artifact.digest !== digest)
			throw new ArtifactError("invalid", "Invalid artifact reference");
		if ((await this.options.authorize(principal, "read", [...artifact.access_scope])) !== true)
			throw new ArtifactError("permission_denied", "Artifact read denied");
		this.#assertAvailable(artifact);
		const content = await this.#readContent(artifact);
		if ((await this.options.authorize(principal, "read", [...artifact.access_scope])) !== true)
			throw new ArtifactError("permission_denied", "Artifact read denied");
		const currentFound = await this.options.lookup({ id, digest });
		const current = currentFound ? structuredClone(currentFound) : null;
		if (!current) throw new ArtifactError("missing", "Artifact not found");
		this.#assertAvailable(current);
		if (
			current.id !== id ||
			current.digest !== digest ||
			current.storage_ref !== artifact.storage_ref ||
			current.media_type !== artifact.media_type ||
			current.size_bytes !== artifact.size_bytes ||
			current.producer_attempt_id !== artifact.producer_attempt_id ||
			current.source_ref?.id !== artifact.source_ref?.id ||
			current.source_ref?.digest !== artifact.source_ref?.digest ||
			current.expires_at !== artifact.expires_at ||
			current.access_scope.length !== artifact.access_scope.length ||
			current.access_scope.some((scope, index) => scope !== artifact.access_scope[index])
		)
			throw new ArtifactError("invalid", "Artifact metadata changed during retrieval");
		return content;
	}

	#assertAvailable(artifact: GraphArtifact): void {
		if (artifact.availability !== "available")
			throw new ArtifactError(artifact.availability, `Artifact is ${artifact.availability}`);
		if (artifact.expires_at && Date.parse(artifact.expires_at) <= Date.now())
			throw new ArtifactError("expired", "Artifact is expired");
	}

	/** Trusted-host recovery check; verified bytes are not returned without read authorization. */
	async verifyPublishedContent(artifact: GraphArtifact): Promise<void> {
		await this.#readContent(artifact);
	}

	async #readContent(artifact: GraphArtifact): Promise<Uint8Array> {
		const { id, storage_ref, size_bytes, digest } = artifact;
		if (
			storage_ref !== id ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
			!/^sha256:[0-9a-f]{64}$/.test(digest)
		)
			throw new ArtifactError("invalid", "Invalid artifact identity");
		if (!Number.isSafeInteger(size_bytes) || size_bytes < 0 || size_bytes > this.options.maxBytes)
			throw new ArtifactError("too_large", "Artifact exceeds size limit");
		let file;
		try {
			file = await fsp.open(
				path.join(this.options.directory, storage_ref),
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new ArtifactError("missing", "Artifact content missing");
			throw error;
		}
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size !== size_bytes)
				throw new ArtifactError("digest_mismatch", "Artifact size mismatch");
			const bytes = Buffer.alloc(size_bytes);
			let offset = 0;
			while (offset < bytes.length) {
				const result = await file.read(bytes, offset, bytes.length - offset, offset);
				if (!result.bytesRead) throw new ArtifactError("digest_mismatch", "Artifact truncated");
				offset += result.bytesRead;
			}
			const after = await file.stat();
			if (after.size !== bytes.length || `sha256:${Bun.SHA256.hash(bytes, "hex")}` !== digest)
				throw new ArtifactError("digest_mismatch", "Artifact digest mismatch");
			return bytes;
		} finally {
			await file.close();
		}
	}
}

export interface ArtifactRegistration {
	artifact: GraphArtifact;
	/** Derived from the authorized host execution/import, never from graph-supplied metadata. */
	expected: ArtifactPublication;
	expires_at?: string | null;
}

export interface GraphArtifactRegistryOptions {
	/** Private, profile-specific Graph directory. */
	root: string;
	maxBytes: number;
	authorize: LocalArtifactStoreOptions["authorize"];
	/** A host-owned connection to the profile database, when sharing its transaction boundary. */
	database?: Database;
}

declare const preparedArtifactRegistration: unique symbol;
export interface PreparedArtifactRegistration {
	readonly [preparedArtifactRegistration]: true;
}

/**
 * Host-only artifact ledger. Registration must be called with independently authorized provenance
 * and scope; neither this class nor a reference turns graph content into an authorization grant.
 */
export class GraphArtifactRegistry {
	readonly store: LocalArtifactStore;
	readonly #root: string;
	readonly #directory: string;
	readonly #db: Database;
	readonly #ownsDatabase: boolean;
	readonly #prepared = new WeakMap<PreparedArtifactRegistration, GraphArtifact[]>();

	constructor(options: GraphArtifactRegistryOptions) {
		this.#root = path.resolve(options.root);
		this.#directory = path.join(this.#root, "artifacts");
		for (const dir of [this.#root, this.#directory]) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			const stat = fs.lstatSync(dir);
			if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
				throw new ArtifactError("permission_denied", "Artifact profile is not owned by this user");
			fs.chmodSync(dir, 0o700);
		}
		const dbPath = path.join(this.#root, "graphs.sqlite");
		if (!options.database) {
			for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
				if (!fs.existsSync(file)) continue;
				const stat = fs.lstatSync(file);
				if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
					throw new ArtifactError("permission_denied", "Artifact database is not owned by this user");
			}
		}
		this.#ownsDatabase = !options.database;
		this.#db = options.database ?? new Database(dbPath, { create: true });
		try {
			if (this.#ownsDatabase)
				this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
			this.#db.exec(`
CREATE TABLE IF NOT EXISTS graph_artifacts (
	id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL,
	availability TEXT NOT NULL CHECK(availability IN ('available','expired','missing','unknown'))
);
`);
			if (this.#ownsDatabase) {
				for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
					if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
			}
			this.store = new LocalArtifactStore({
				directory: this.#directory,
				maxBytes: options.maxBytes,
				authorize: options.authorize,
				lookup: async ref => this.lookup(ref),
			});
		} catch (error) {
			if (this.#ownsDatabase) this.#db.close();
			throw error;
		}
	}

	close(): void {
		if (this.#ownsDatabase) this.#db.close();
	}

	/** Host ledgers must share this exact connection for atomic registration and application. */
	assertDatabase(database: Database): void {
		if (database !== this.#db)
			throw new ArtifactError("invalid", "Artifact registration requires the same host database connection");
	}

	#assertProfile(): void {
		for (const dir of [this.#root, this.#directory]) {
			try {
				const stat = fs.lstatSync(dir);
				if (
					!stat.isDirectory() ||
					stat.isSymbolicLink() ||
					(stat.mode & 0o077) !== 0 ||
					(process.getuid && stat.uid !== process.getuid())
				)
					throw new Error();
			} catch {
				throw new ArtifactError("permission_denied", "Artifact profile permissions do not allow access");
			}
		}
	}

	/** Lookup checks the complete immutable reference; it does not itself authorize reading. */
	lookup(ref: GraphRef): GraphArtifact | null {
		this.#assertProfile();
		const row = this.#db.query("SELECT digest,data,availability FROM graph_artifacts WHERE id=?").get(ref.id) as {
			digest: string;
			data: string;
			availability: ArtifactAvailability;
		} | null;
		if (!row) return null;
		if (row.digest !== ref.digest) throw new ArtifactError("invalid", "Invalid artifact reference");
		const artifact = JSON.parse(row.data) as GraphArtifact;
		artifact.availability = row.availability;
		if (artifact.availability === "available" && artifact.expires_at && Date.parse(artifact.expires_at) <= Date.now())
			artifact.availability = "expired";
		return artifact;
	}

	/**
	 * Verify files first, then atomically register the batch. The caller must derive expected values
	 * from the authorized attempt/import, not the producer's returned metadata. An interrupted commit
	 * can leave only unreferenced files. With an injected connection the insert participates in any
	 * surrounding SQLite transaction; verify before opening a synchronous host transaction.
	 */
	async prepareRegistration(entries: readonly ArtifactRegistration[]): Promise<PreparedArtifactRegistration> {
		const copies = structuredClone(entries);
		this.#assertProfile();
		const records: GraphArtifact[] = [];
		for (const { artifact, expected, expires_at = null } of copies) {
			if (
				artifact.availability !== "available" ||
				typeof artifact.media_type !== "string" ||
				!artifact.media_type ||
				artifact.media_type !== expected.media_type ||
				artifact.producer_attempt_id !== expected.producer_attempt_id ||
				(artifact.source_ref === null) !== (expected.source_ref === null) ||
				artifact.source_ref?.id !== expected.source_ref?.id ||
				artifact.source_ref?.digest !== expected.source_ref?.digest ||
				JSON.stringify(artifact.access_scope) !== JSON.stringify(expected.access_scope) ||
				(!artifact.producer_attempt_id && !artifact.source_ref) ||
				(artifact.producer_attempt_id !== null &&
					(typeof artifact.producer_attempt_id !== "string" || !artifact.producer_attempt_id)) ||
				(artifact.source_ref !== null &&
					(!artifact.source_ref ||
						typeof artifact.source_ref.id !== "string" ||
						!artifact.source_ref.id ||
						typeof artifact.source_ref.digest !== "string" ||
						!artifact.source_ref.digest)) ||
				!Array.isArray(artifact.access_scope) ||
				artifact.access_scope.some(scope => typeof scope !== "string" || !scope) ||
				(expected.expected_digest != null && artifact.digest !== expected.expected_digest) ||
				(expires_at !== null && (typeof expires_at !== "string" || !Number.isFinite(Date.parse(expires_at)))) ||
				(artifact.expires_at != null && artifact.expires_at !== expires_at)
			)
				throw new ArtifactError("invalid", "Artifact metadata does not match authorized publication");
			await this.store.verifyPublishedContent(artifact);
			records.push({
				id: artifact.id,
				digest: artifact.digest,
				media_type: artifact.media_type,
				size_bytes: artifact.size_bytes,
				availability: "available",
				producer_attempt_id: artifact.producer_attempt_id,
				source_ref: artifact.source_ref ? { id: artifact.source_ref.id, digest: artifact.source_ref.digest } : null,
				storage_ref: artifact.storage_ref,
				access_scope: artifact.access_scope,
				expires_at,
			});
		}
		const prepared = {} as PreparedArtifactRegistration;
		this.#prepared.set(prepared, records);
		return prepared;
	}

	/** Synchronous so a host using the same injected connection can commit with its run transition. */
	commitPrepared(prepared: PreparedArtifactRegistration, expectedRefs?: readonly GraphRef[]): void {
		const records = this.#prepared.get(prepared);
		if (!records) throw new ArtifactError("invalid", "Unknown prepared artifact registration");
		if (expectedRefs) {
			const identities = (refs: readonly GraphRef[]) =>
				[...new Set(refs.map(ref => JSON.stringify([ref.id, ref.digest])))].sort();
			if (JSON.stringify(identities(records)) !== JSON.stringify(identities(expectedRefs)))
				throw new ArtifactError("invalid", "Registered artifacts do not match the completion outputs");
		}
		this.#assertProfile();
		this.#db.transaction(() => {
			for (const artifact of records) {
				const data = JSON.stringify(artifact);
				const existing = this.#db.query("SELECT data FROM graph_artifacts WHERE id=?").get(artifact.id) as {
					data: string;
				} | null;
				if (existing) {
					if (existing.data !== data) throw new ArtifactError("invalid", "Artifact identity already registered");
					continue;
				}
				this.#db
					.query("INSERT INTO graph_artifacts (id,digest,data,availability) VALUES (?,?,?,?)")
					.run(artifact.id, artifact.digest, data, "available");
			}
		})();
	}

	async register(entries: readonly ArtifactRegistration[]): Promise<void> {
		this.commitPrepared(await this.prepareRegistration(entries));
	}

	/** Trusted reconciliation can make an object unavailable; it cannot silently revive it. */
	markUnavailable(ref: GraphRef, availability: Exclude<ArtifactAvailability, "available">): void {
		if (!["expired", "missing", "unknown"].includes(availability))
			throw new ArtifactError("invalid", "Invalid artifact availability");
		if (!this.lookup(ref)) throw new ArtifactError("missing", "Artifact not found");
		this.#db
			.query("UPDATE graph_artifacts SET availability=? WHERE id=? AND digest=?")
			.run(availability, ref.id, ref.digest);
	}
}

export interface ProfileArtifactReadOptions {
	/** Graph profile root; artifact content lives under `<root>/artifacts`. */
	root: string;
	/** Ceiling for a stored artifact size; publish-time limits are usually smaller. */
	maxBytes: number;
	principal: string;
	/** Trusted-host decision over the artifact's recorded access scope. */
	authorize(principal: string, action: "read", scope: readonly string[]): Promise<boolean>;
}

export interface ProfileArtifactRead {
	artifact: GraphArtifact;
	bytes: Uint8Array;
}

/**
 * Read verified artifact bytes from an existing profile through a throwaway read-only
 * connection. Nothing is created, repaired or written: a report must not mutate the
 * profile it is only observing, and the ledger may belong to another live process.
 */
export async function readProfileArtifact(
	ref: GraphRef,
	options: ProfileArtifactReadOptions,
): Promise<ProfileArtifactRead> {
	const root = path.resolve(options.root);
	let db: Database | undefined;
	try {
		db = new Database(path.join(root, "graphs.sqlite"), { readonly: true, strict: true });
		db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
		const ledger = db;
		const present = ledger
			.query("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='graph_artifacts'")
			.get() as { present: number } | null;
		if (!present) throw new ArtifactError("unknown", "Artifact ledger is unavailable");
		const lookupArtifact = async (lookupRef: GraphRef): Promise<GraphArtifact | null> => {
			const row = ledger
				.query("SELECT digest,data,availability FROM graph_artifacts WHERE id=?")
				.get(lookupRef.id) as { digest: string; data: string; availability: ArtifactAvailability } | null;
			if (!row) return null;
			if (row.digest !== lookupRef.digest) throw new ArtifactError("invalid", "Invalid artifact reference");
			const artifact = JSON.parse(row.data) as GraphArtifact;
			artifact.availability = row.availability;
			if (
				artifact.availability === "available" &&
				artifact.expires_at &&
				Date.parse(artifact.expires_at) <= Date.now()
			)
				artifact.availability = "expired";
			return artifact;
		};
		const artifact = await lookupArtifact(ref);
		if (!artifact) throw new ArtifactError("missing", "Artifact not found");
		const store = new LocalArtifactStore({
			directory: path.join(root, "artifacts"),
			maxBytes: options.maxBytes,
			// A report only reads; it never gains publication authority from the read grant.
			authorize: (principal, action, scope) =>
				action === "read" ? options.authorize(principal, "read", scope) : Promise.resolve(false),
			lookup: lookupArtifact,
		});
		const bytes = await store.read(options.principal, ref);
		return { artifact, bytes };
	} finally {
		db?.close();
	}
}

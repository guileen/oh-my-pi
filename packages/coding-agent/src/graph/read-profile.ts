import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { ownerPrivateDirError } from "../utils/owner-private-dir";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import type { GraphDefinition } from "./contracts";
import { type GraphLimits, validateGraphForStart } from "./definition";
import type { GraphRunRecord, GraphRunSnapshot, GraphScheduleState } from "./store";

/** Shared queries for the writer and observers; no schema installation or migrations. */
export function readGraphRun(db: Database, id: string): GraphRunRecord | null {
	const row = db.query("SELECT data FROM graph_runs WHERE id=?").get(id) as { data: string } | null;
	return row ? (JSON.parse(row.data) as GraphRunRecord) : null;
}
export function readGraphRunSnapshot(db: Database, ref: GraphRef): GraphRunSnapshot | null {
	const row = db.query("SELECT digest,data FROM graph_run_snapshots WHERE id=?").get(ref.id) as {
		digest: string;
		data: string;
	} | null;
	return row && row.digest === ref.digest && `sha256:${Bun.SHA256.hash(row.data, "hex")}` === ref.digest
		? (JSON.parse(row.data) as GraphRunSnapshot)
		: null;
}
export function readGraphFrozenDefinition(db: Database, runId: string, limits: GraphLimits): GraphDefinition | null {
	const run = readGraphRun(db, runId);
	const snapshot = run && readGraphRunSnapshot(db, run.snapshot_ref);
	if (!snapshot) return null;
	const validated = validateGraphForStart(snapshot.definition, limits);
	return validated.issues.length ? null : (validated.source.frontmatter.frontmatter as unknown as GraphDefinition);
}
export function readGraphScheduleState(db: Database, runId: string): GraphScheduleState | null {
	const row = db.query("SELECT data FROM graph_schedule_states WHERE run_id=?").get(runId) as { data: string } | null;
	return row ? (JSON.parse(row.data) as GraphScheduleState) : null;
}

/** Liveness facts reported by executors. Never a completion or success signal. */
export interface GraphInvocationActivity {
	run_id: string;
	invocation_id: string;
	node: string;
	started_at: string;
	last_activity_at: string;
	turns: number;
	summary: string | null;
}

/** Empty when the profile predates activity recording or no executor reported any. */
export function readGraphInvocationActivity(db: Database, runId: string): GraphInvocationActivity[] {
	const present = db
		.query("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='graph_invocation_activity'")
		.get() as { present: number } | null;
	if (!present) return [];
	return db
		.query(
			"SELECT run_id,invocation_id,node,started_at,last_activity_at,turns,summary FROM graph_invocation_activity WHERE run_id=? ORDER BY last_activity_at,invocation_id",
		)
		.all(runId) as GraphInvocationActivity[];
}

export class GraphReadProfileError extends Error {
	readonly code = "permission_denied";
	constructor() {
		super("Graph profile is unavailable for read-only access");
	}
}

export class GraphObservationRootError extends Error {
	readonly code = "ambiguous_root";
	constructor() {
		super("Graph observation root holds two database layouts");
	}
}

function isGraphDatabase(file: string): boolean {
	try {
		return fs.lstatSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Accepts either a graph data directory (`<root>/graphs.sqlite`) or an agent directory
 * (`<root>/graphs/graphs.sqlite`). When both layouts exist the root is refused: an agent
 * directory that also holds a legacy sibling database must never resolve silently, because
 * reading the stale copy reports Runs as missing instead of failing loudly.
 */
export function resolveGraphObservationRoot(root: string): string {
	const resolved = path.resolve(root);
	const direct = isGraphDatabase(path.join(resolved, "graphs.sqlite"));
	const nestedDirectory = path.join(resolved, "graphs");
	const nested = isGraphDatabase(path.join(nestedDirectory, "graphs.sqlite"));
	if (direct && nested) throw new GraphObservationRootError();
	return nested ? nestedDirectory : resolved;
}

/** Existing private profile only. Access is not principal/Run authorization.
 * Permission checks never chmod/mkdir, and SQLite is opened read-only with query_only.
 * Path identity changes fence this connection; same-UID malicious writers are not sandboxed.
 */
export class GraphReadProfile {
	readonly root: string;
	readonly db: Database;
	readonly #directory: fs.Stats;
	readonly #file: fs.Stats;

	constructor(root = path.join(getAgentDir(), "graphs")) {
		this.root = path.resolve(root);
		let opened: Database | undefined;
		try {
			this.#directory = fs.lstatSync(this.root);
			this.#file = fs.lstatSync(path.join(this.root, "graphs.sqlite"));
			this.assertAccess();
			opened = new Database(path.join(this.root, "graphs.sqlite"), { readonly: true, strict: true });
			opened.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
			this.assertAccess();
			this.db = opened;
		} catch {
			opened?.close();
			throw new GraphReadProfileError();
		}
	}

	assertAccess(): void {
		try {
			const directory = fs.lstatSync(this.root);
			if (
				ownerPrivateDirError(
					{
						isSymlink: directory.isSymbolicLink(),
						isDir: directory.isDirectory(),
						uid: directory.uid,
						mode: directory.mode,
					},
					process.getuid?.(),
				) ||
				directory.dev !== this.#directory.dev ||
				directory.ino !== this.#directory.ino
			)
				throw new Error();
			for (const suffix of ["", "-wal", "-shm"]) {
				let file: fs.Stats;
				try {
					file = fs.lstatSync(path.join(this.root, `graphs.sqlite${suffix}`));
				} catch (error) {
					if (suffix && isEnoent(error)) continue;
					throw error;
				}
				if (
					!file.isFile() ||
					file.isSymbolicLink() ||
					(file.mode & 0o077) !== 0 ||
					(process.getuid && file.uid !== process.getuid()) ||
					(!suffix && (file.dev !== this.#file.dev || file.ino !== this.#file.ino))
				)
					throw new Error();
			}
		} catch {
			throw new GraphReadProfileError();
		}
	}
	close(): void {
		this.db.close();
	}
}

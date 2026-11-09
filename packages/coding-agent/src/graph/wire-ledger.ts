import type { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import {
	assertGraphWireReplacement,
	compareGraphWireRevisions,
	graphWireRecordKey,
	validateGraphWireImage,
	validateGraphWireRecord,
} from "@oh-my-pi/pi-wire/graph/wire-records";
import {
	GraphWireError,
	type GraphCursor,
	type GraphWireHistoryEvent,
	type GraphWireRecord,
} from "@oh-my-pi/pi-wire/graph";

export interface GraphWireSnapshot {
	records: GraphWireRecord[];
	cursor: GraphCursor;
}

export interface GraphWireEventPage {
	events: GraphWireHistoryEvent[];
	/** Consumed boundary; on the final page this is the explicit ready watermark, including filtered events. */
	cursor: GraphCursor;
	/** Supply this unchanged on subsequent pages to exclude later publications. */
	watermark: GraphCursor;
	next_cursor: GraphCursor | null;
}

/** Retention availability is distinct from pagination and from an unknown source/cursor. */
export class GraphWireLedgerError extends GraphWireError {
	constructor(
		code: ConstructorParameters<typeof GraphWireError>[0],
		message: string,
		readonly availability?: "missing" | "expired" | "partial",
	) {
		super(code, message);
		this.name = "GraphWireLedgerError";
	}
}

interface SourceRow {
	journal_id: string;
	seq: string;
}
interface EventRow {
	seq: string;
	event_id: string;
	occurred_at: string;
	data: string;
}

/** Own tables only; installing never adopts a polling adapter's Run journal as a wire source. */
export function installGraphWireLedgerSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS graph_wire_sources (
			source_id TEXT PRIMARY KEY,
			journal_id TEXT NOT NULL UNIQUE,
			seq TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS graph_wire_baselines (
			source_id TEXT PRIMARY KEY REFERENCES graph_wire_sources(source_id),
			seq TEXT NOT NULL,
			data TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS graph_wire_current (
			source_id TEXT NOT NULL REFERENCES graph_wire_sources(source_id),
			record_key TEXT NOT NULL,
			kind TEXT NOT NULL,
			run_id TEXT NOT NULL,
			first_seq TEXT NOT NULL,
			data TEXT NOT NULL,
			PRIMARY KEY (source_id, record_key)
		);
		CREATE INDEX IF NOT EXISTS graph_wire_current_run ON graph_wire_current(source_id, run_id, kind);
		CREATE TABLE IF NOT EXISTS graph_wire_events (
			source_id TEXT NOT NULL REFERENCES graph_wire_sources(source_id),
			seq TEXT NOT NULL,
			event_id TEXT NOT NULL UNIQUE,
			occurred_at TEXT NOT NULL,
			data TEXT NOT NULL,
			PRIMARY KEY (source_id, seq)
		);
		CREATE INDEX IF NOT EXISTS graph_wire_event_order ON graph_wire_events(source_id, length(seq), seq);
	`);
}

function assertId(value: string, name: string): void {
	if (typeof value !== "string" || value.length === 0)
		throw new GraphWireLedgerError("invalid_input", `${name} must be a nonempty identity`);
}

function historyGap(): never {
	throw new GraphWireLedgerError("cursor_expired", "Retained Graph history has a sequence gap", "partial");
}

/**
 * Trusted host storage, not an authorization boundary or a capability advertisement.
 * The caller owns and closes the Database and must explicitly register stable source IDs.
 * publish requires an existing writer transaction on that same connection, so host mutation
 * and feed publication commit together. Its nested savepoint rolls back a failed batch even
 * if the caller catches the error. Returned events are provisional until the caller commits;
 * never deliver them to consumers before that commit. Reads use one consistent transaction.
 */
export class GraphWireLedger {
	readonly #readOnly: boolean;
	constructor(
		private readonly db: Database,
		options: { readOnly?: boolean } = {},
	) {
		this.#readOnly = options.readOnly === true;
		if (this.#readOnly) {
			// An observer must never create an empty ledger over missing Host history.
			try {
				db.query("SELECT source_id,journal_id,seq FROM graph_wire_sources LIMIT 0").all();
				db.query("SELECT source_id,seq,data FROM graph_wire_baselines LIMIT 0").all();
				db.query("SELECT source_id,record_key,kind,run_id,first_seq,data FROM graph_wire_current LIMIT 0").all();
				db.query("SELECT source_id,seq,event_id,occurred_at,data FROM graph_wire_events LIMIT 0").all();
			} catch {
				throw new GraphWireLedgerError(
					"capability_unavailable",
					"Host wire ledger schema is unavailable",
					"missing",
				);
			}
		} else installGraphWireLedgerSchema(db);
	}

	registerSource(sourceId: string): GraphCursor {
		this.#assertWriter();
		assertId(sourceId, "sourceId");
		return this.db
			.transaction(() => {
				const existing = this.db
					.query("SELECT journal_id,seq FROM graph_wire_sources WHERE source_id=?")
					.get(sourceId) as SourceRow | null;
				if (existing) return { journal_id: existing.journal_id, seq: existing.seq };
				const journal = crypto.randomUUID();
				this.db
					.query("INSERT INTO graph_wire_sources(source_id,journal_id,seq) VALUES (?,?,'0')")
					.run(sourceId, journal);
				// This durable empty image is the only baseline. Never repair a missing one from today's image.
				this.db.query("INSERT INTO graph_wire_baselines(source_id,seq,data) VALUES (?,'0','[]')").run(sourceId);
				return { journal_id: journal, seq: "0" };
			})
			.immediate();
	}

	publish(sourceId: string, records: readonly GraphWireRecord[], occurredAt: string): GraphWireHistoryEvent | null {
		this.#assertWriter();
		if (!this.db.inTransaction)
			throw new GraphWireLedgerError("invalid_input", "publish requires the caller's existing writer transaction");
		if (!Array.isArray(records)) throw new GraphWireLedgerError("invalid_input", "records must be an array");
		if (
			typeof occurredAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(occurredAt) ||
			!Number.isFinite(Date.parse(occurredAt))
		)
			throw new GraphWireLedgerError("invalid_input", "occurredAt must be a valid UTC timestamp");
		return this.db.transaction(() => {
			const source = this.#source(sourceId);
			const previous = this.#current(sourceId);
			const image = new Map(previous.map(record => [graphWireRecordKey(record), record]));
			const changed = new Map<string, GraphWireRecord>();
			for (const input of records) {
				validateGraphWireRecord(input);
				let record: GraphWireRecord;
				try {
					record = JSON.parse(canonicalJson(input)) as GraphWireRecord;
				} catch {
					throw new GraphWireLedgerError("invalid_input", "Graph records must contain only JSON values");
				}
				const key = graphWireRecordKey(record);
				const old = image.get(key);
				if (old) {
					const order = compareGraphWireRevisions(record.value.revision, old.value.revision);
					if (order < 0) continue;
					assertGraphWireReplacement(old, record);
					if (order === 0) continue;
				}
				image.set(key, record);
				changed.set(key, record);
			}
			// Validate only the final image: a Binding/Transfer may precede its Run/endpoints in this batch.
			validateGraphWireImage([...image.values()]);
			if (changed.size === 0) return null;
			const seq = (BigInt(source.seq) + 1n).toString();
			const replacements = [...changed.values()];
			const event: GraphWireHistoryEvent = {
				event_id: crypto.randomUUID(),
				cursor: { journal_id: source.journal_id, seq },
				occurred_at: occurredAt,
				records: replacements,
			};
			for (const [key, record] of changed) {
				this.db
					.query(`INSERT INTO graph_wire_current(source_id,record_key,kind,run_id,first_seq,data)
						VALUES (?,?,?,?,?,?) ON CONFLICT(source_id,record_key) DO UPDATE SET data=excluded.data`)
					.run(sourceId, key, record.kind, record.value.graph_run_id, seq, canonicalJson(record));
			}
			this.db
				.query("INSERT INTO graph_wire_events(source_id,seq,event_id,occurred_at,data) VALUES (?,?,?,?,?)")
				.run(sourceId, seq, event.event_id, occurredAt, canonicalJson(replacements));
			this.db.query("UPDATE graph_wire_sources SET seq=? WHERE source_id=?").run(seq, sourceId);
			return event;
		})();
	}

	snapshot(sourceId: string, runId?: string): GraphWireSnapshot {
		return this.db.transaction(() => {
			const source = this.#source(sourceId);
			if (runId !== undefined) this.#requireRun(sourceId, runId, source.seq);
			const records = this.#current(sourceId);
			validateGraphWireImage(records);
			return {
				records: runId === undefined ? records : records.filter(record => record.value.graph_run_id === runId),
				cursor: { journal_id: source.journal_id, seq: source.seq },
			};
		})();
	}

	events(
		sourceId: string,
		options: { after: GraphCursor; watermark?: GraphCursor; runId?: string; limit?: number },
	): GraphWireEventPage {
		const limit = options.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new GraphWireLedgerError("invalid_input", "Event limit must be between 1 and 100");
		return this.db.transaction(() => {
			const source = this.#source(sourceId);
			const after = this.#cursor(sourceId, source, options.after);
			const watermark = this.#cursor(sourceId, source, options.watermark ?? source);
			if (compareGraphWireRevisions(after.seq, watermark.seq) > 0)
				throw new GraphWireLedgerError("invalid_cursor", "Cursor is beyond the requested watermark");
			if (options.runId !== undefined) this.#requireRun(sourceId, options.runId, watermark.seq);
			const events: GraphWireHistoryEvent[] = [];
			let previous = BigInt(after.seq);
			for (const row of this.#eventRows(sourceId, after.seq, watermark.seq)) {
				if (BigInt(row.seq) !== previous + 1n) historyGap();
				previous = BigInt(row.seq);
				const all = this.#eventRecords(row);
				const records =
					options.runId === undefined ? all : all.filter(record => record.value.graph_run_id === options.runId);
				if (records.length === 0) continue;
				if (events.length === limit) {
					const cursor = { ...events[events.length - 1]!.cursor };
					return { events, cursor, watermark: { ...watermark }, next_cursor: { ...cursor } };
				}
				events.push({
					event_id: row.event_id,
					cursor: { journal_id: source.journal_id, seq: row.seq },
					occurred_at: row.occurred_at,
					records,
				});
			}
			if (previous !== BigInt(watermark.seq)) historyGap();
			return { events, cursor: { ...watermark }, watermark: { ...watermark }, next_cursor: null };
		})();
	}

	stateAt(sourceId: string, runId: string, cursor: GraphCursor): GraphWireSnapshot {
		assertId(runId, "runId");
		return this.db.transaction(() => {
			const source = this.#source(sourceId);
			const boundary = this.#cursor(sourceId, source, cursor);
			const baseline = this.db
				.query("SELECT seq,data FROM graph_wire_baselines WHERE source_id=?")
				.get(sourceId) as { seq: string; data: string } | null;
			if (!baseline || baseline.seq !== "0" || baseline.data !== "[]")
				throw new GraphWireLedgerError("cursor_expired", "Retained Graph baseline is missing", "expired");
			const image = new Map<string, GraphWireRecord>();
			let previous = 0n;
			for (const row of this.#eventRows(sourceId, "0", boundary.seq)) {
				if (BigInt(row.seq) !== previous + 1n) historyGap();
				previous = BigInt(row.seq);
				for (const record of this.#eventRecords(row)) {
					const key = graphWireRecordKey(record);
					const old = image.get(key);
					if (old) {
						const order = compareGraphWireRevisions(record.value.revision, old.value.revision);
						if (order < 0) continue;
						assertGraphWireReplacement(old, record);
						if (order === 0) continue;
					}
					image.set(key, record);
				}
				validateGraphWireImage([...image.values()]);
			}
			if (previous !== BigInt(boundary.seq)) historyGap();
			const records = [...image.values()].filter(record => record.value.graph_run_id === runId);
			if (!records.some(record => record.kind === "run")) this.#missingRun();
			return { records, cursor: { ...boundary } };
		})();
	}

	#assertWriter(): void {
		if (this.#readOnly)
			throw new GraphWireLedgerError("scope_denied", "Read-only observation cannot publish or register sources");
	}

	#source(sourceId: string): SourceRow {
		assertId(sourceId, "sourceId");
		const source = this.db
			.query("SELECT journal_id,seq FROM graph_wire_sources WHERE source_id=?")
			.get(sourceId) as SourceRow | null;
		if (!source) throw new GraphWireLedgerError("invalid_cursor", "Unknown Graph source; register it explicitly");
		return source;
	}

	#current(sourceId: string): GraphWireRecord[] {
		const rows = this.db
			.query("SELECT data FROM graph_wire_current WHERE source_id=? ORDER BY record_key")
			.all(sourceId) as {
			data: string;
		}[];
		return rows.map(row => {
			const record: unknown = JSON.parse(row.data);
			validateGraphWireRecord(record);
			return record;
		});
	}

	#cursor(sourceId: string, source: SourceRow, value: GraphCursor): GraphCursor {
		if (
			!value ||
			typeof value !== "object" ||
			value.journal_id !== source.journal_id ||
			typeof value.seq !== "string" ||
			!/^(0|[1-9][0-9]*)$/.test(value.seq) ||
			compareGraphWireRevisions(value.seq, source.seq) > 0
		)
			throw new GraphWireLedgerError("invalid_cursor", "Cursor does not belong to this source journal");
		if (
			value.seq !== "0" &&
			!this.db.query("SELECT 1 FROM graph_wire_events WHERE source_id=? AND seq=?").get(sourceId, value.seq)
		)
			historyGap();
		return { journal_id: value.journal_id, seq: value.seq };
	}

	#requireRun(sourceId: string, runId: string, boundary: string): void {
		assertId(runId, "runId");
		const row = this.db
			.query("SELECT first_seq FROM graph_wire_current WHERE source_id=? AND run_id=? AND kind='run'")
			.get(sourceId, runId) as { first_seq: string } | null;
		if (!row || compareGraphWireRevisions(row.first_seq, boundary) > 0) this.#missingRun();
	}

	#missingRun(): never {
		throw new GraphWireLedgerError("invalid_input", "Graph Run does not exist at the requested boundary", "missing");
	}

	#eventRows(sourceId: string, after: string, through: string): IterableIterator<EventRow> {
		return this.db
			.query(`SELECT seq,event_id,occurred_at,data FROM graph_wire_events WHERE source_id=?
				AND (length(seq)>length(?) OR (length(seq)=length(?) AND seq>?))
				AND (length(seq)<length(?) OR (length(seq)=length(?) AND seq<=?))
				ORDER BY length(seq),seq`)
			.iterate(sourceId, after, after, after, through, through, through) as IterableIterator<EventRow>;
	}

	#eventRecords(row: EventRow): GraphWireRecord[] {
		const records: unknown = JSON.parse(row.data);
		if (!Array.isArray(records) || records.length === 0)
			throw new GraphWireLedgerError(
				"protocol_error",
				"Retained Graph event has no complete replacements",
				"partial",
			);
		for (const record of records) validateGraphWireRecord(record);
		return records;
	}
}

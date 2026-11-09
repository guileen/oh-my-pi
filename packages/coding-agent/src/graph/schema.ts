import type { Database } from "bun:sqlite";

/** Graph tables are created lazily; a missing table is a valid state, never an error. */
export function hasTable(db: Database, name: string): boolean {
	return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * A table can exist from an earlier or foreign schema. Projections that read it
 * degrade to empty instead of failing the whole view: a missing column is not a
 * corruption signal to the observing process, which never owns the writer.
 */
export function hasColumns(db: Database, table: string, columns: readonly string[]): boolean {
	const present = new Set(
		(db.query("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map(row => row.name),
	);
	return columns.every(column => present.has(column));
}

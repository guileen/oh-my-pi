import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JobUsage } from "../src/bots/types";
import { GraphUsageLedger, installGraphUsageSchema, type GraphUsageObservation } from "../src/graph/usage";

const databases = new Set<Database>();
const roots: string[] = [];
const measuredAt = "2026-11-05T12:00:00.000Z";

function open(filename = ":memory:") {
	const db = new Database(filename);
	databases.add(db);
	db.exec("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS graph_runs (id TEXT PRIMARY KEY)");
	db.query("INSERT OR IGNORE INTO graph_runs VALUES (?)").run("run");
	installGraphUsageSchema(db);
	return { db, ledger: new GraphUsageLedger(db) };
}

function observation(
	usage: Partial<JobUsage> = {},
	identity: Partial<GraphUsageObservation> = {},
): GraphUsageObservation {
	return {
		run_id: "run",
		invocation_id: "invocation",
		attempt_id: "attempt",
		source_id: "bot-job",
		revision: "1",
		...identity,
		usage: {
			input_tokens: 10,
			output_tokens: 20,
			cache_read_tokens: 3,
			cache_write_tokens: 4,
			cost_usd: "0.1",
			completeness: "complete",
			measured_at: measuredAt,
			...usage,
		},
	};
}

const unknownUsage: JobUsage = {
	input_tokens: null,
	output_tokens: null,
	cache_read_tokens: null,
	cache_write_tokens: null,
	cost_usd: null,
	completeness: "unknown",
	measured_at: null,
};

afterEach(() => {
	for (const db of databases) db.close();
	databases.clear();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("graph observed usage ledger", () => {
	it("replaces cumulative source snapshots instead of adding them twice", () => {
		const { ledger } = open();
		expect(ledger.record(observation()).status).toBe("recorded");
		ledger.record(observation({ input_tokens: 15, output_tokens: 30, cost_usd: "0.25" }, { revision: "2" }));
		ledger.record(
			observation(
				{ input_tokens: 2, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: "0.05" },
				{ attempt_id: "attempt-2", source_id: "bot-job-2" },
			),
		);
		expect(ledger.summary("run")).toEqual({
			input_tokens: 17,
			output_tokens: 34,
			cache_read_tokens: 3,
			cache_write_tokens: 4,
			cost_usd: "0.3",
			completeness: "complete",
			measured_at: measuredAt,
			observed_sources: 2,
		});
	});

	it("rolls up contained cumulative observations once without absorbing unrelated Runs", () => {
		const { db, ledger } = open();
		for (const id of ["child", "other"]) db.query("INSERT INTO graph_runs VALUES (?)").run(id);
		ledger.record(observation());
		ledger.record(observation({ cost_usd: "0.2", output_tokens: 5 }, { run_id: "child" }));
		ledger.record(observation({ cost_usd: "9" }, { run_id: "other" }));
		expect(ledger.summary("run", ["child", "child", "run"])).toMatchObject({
			cost_usd: "0.3",
			output_tokens: 25,
			observed_sources: 2,
			completeness: "complete",
		});
		ledger.record(observation({ cost_usd: "0.25", output_tokens: 8 }, { run_id: "child", revision: "2" }));
		expect(ledger.summary("run", ["child"])).toMatchObject({
			cost_usd: "0.35",
			output_tokens: 28,
			observed_sources: 2,
		});
		expect(ledger.summary("child").cost_usd).toBe("0.25");
	});

	it("replays exactly and ignores stale revisions without changing stored usage", () => {
		const { db, ledger } = open();
		const current = observation({ cost_usd: "000.1000" }, { revision: "10" });
		const recorded = ledger.record(current).observation;
		expect(recorded.usage.cost_usd).toBe("0.1");
		expect(ledger.record(current)).toEqual({ status: "replayed", observation: recorded });
		const before = db.query("SELECT * FROM graph_usage_sources").all();
		expect(ledger.record(observation({ input_tokens: 0, cost_usd: "0" }, { revision: "9" }))).toEqual({
			status: "stale",
			observation: recorded,
		});
		expect(db.query("SELECT * FROM graph_usage_sources").all()).toEqual(before);
		expect(ledger.summary("run").cost_usd).toBe("0.1");
	});

	it("compares revisions beyond numeric precision and rejects conflicting equal revisions", () => {
		const { ledger } = open();
		ledger.record(observation({}, { revision: "9007199254740992" }));
		expect(ledger.record(observation({}, { revision: "9007199254740993" })).status).toBe("recorded");
		expect(() => ledger.record(observation({ cost_usd: "0.2" }, { revision: "9007199254740993" }))).toThrow(
			"Conflicting",
		);
		expect(ledger.summary("run").cost_usd).toBe("0.1");
	});

	it("binds the source and invocation immutably to each run attempt", () => {
		const { ledger } = open();
		ledger.record(observation());
		for (const identity of [
			{ source_id: "another-source", revision: "2" },
			{ invocation_id: "another-invocation", revision: "2" },
			{ source_id: "another-source", revision: "0" },
			{ attempt_id: "another-attempt", revision: "2" },
		]) {
			expect(() => ledger.record(observation({}, identity))).toThrow("source");
		}
		expect(ledger.summary("run").observed_sources).toBe(1);
	});

	it("rejects any decrease or disappearance of known cumulative components", () => {
		const { ledger } = open();
		ledger.record(observation());
		for (const field of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const) {
			expect(() => ledger.record(observation({ [field]: 0 }, { revision: "2" }))).toThrow("cannot decrease");
			expect(() => ledger.record(observation({ [field]: null }, { revision: "2" }))).toThrow("become unknown");
		}
		expect(() => ledger.record(observation({ cost_usd: "0.099999999999999999999" }, { revision: "2" }))).toThrow(
			"cannot decrease",
		);
		expect(() => ledger.record(observation({ cost_usd: null }, { revision: "2" }))).toThrow("become unknown");
		expect(ledger.summary("run")).toEqual({ ...observation().usage, observed_sources: 1 });
	});

	it("preserves known subtotals when some sources or components are unknown", () => {
		const { ledger } = open();
		expect(ledger.summary("run")).toEqual({ ...unknownUsage, observed_sources: 0 });
		ledger.record(observation(unknownUsage));
		expect(ledger.summary("run")).toEqual({ ...unknownUsage, observed_sources: 1 });
		ledger.record(
			observation(
				{ ...unknownUsage, input_tokens: 7, cost_usd: "0.25", completeness: "partial", measured_at: measuredAt },
				{ attempt_id: "attempt-2", source_id: "bot-job-2" },
			),
		);
		expect(ledger.summary("run")).toEqual({
			...unknownUsage,
			input_tokens: 7,
			cost_usd: "0.25",
			completeness: "partial",
			measured_at: measuredAt,
			observed_sources: 2,
		});
	});

	it("allows unknown components to become known without inventing zero for missing costs", () => {
		const { ledger } = open();
		ledger.record(observation({ cost_usd: null, completeness: "partial" }));
		expect(ledger.summary("run")).toMatchObject({ cost_usd: null, completeness: "partial" });
		ledger.record(observation({}, { revision: "2" }));
		expect(ledger.summary("run")).toMatchObject({ cost_usd: "0.1", completeness: "complete" });
	});

	it("permits completeness to degrade while cumulative known amounts remain", () => {
		const { ledger } = open();
		ledger.record(observation());
		ledger.record(observation({ completeness: "partial" }, { revision: "2" }));
		expect(ledger.summary("run")).toMatchObject({ cost_usd: "0.1", input_tokens: 10, completeness: "partial" });
	});

	it("does not claim completeness for missing amounts or an unmeasured zero snapshot", () => {
		const { ledger } = open();
		ledger.record(observation({ cost_usd: null }));
		expect(ledger.summary("run").completeness).toBe("partial");
		const unmeasured = open().ledger;
		unmeasured.record(
			observation({
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				cost_usd: "0",
				measured_at: null,
			}),
		);
		expect(unmeasured.summary("run")).toMatchObject({ cost_usd: "0", completeness: "partial" });
	});

	it("sums large decimal costs exactly and takes the latest measurement time", () => {
		const { ledger } = open();
		ledger.record(observation({ cost_usd: "9007199254740993123456789.000000000000000001" }));
		const later = "2026-11-05T12:01:00.000Z";
		ledger.record(
			observation(
				{ cost_usd: "0.000000000000000009", measured_at: later },
				{ attempt_id: "attempt-2", source_id: "bot-job-2" },
			),
		);
		expect(ledger.summary("run")).toMatchObject({
			cost_usd: "9007199254740993123456789.00000000000000001",
			measured_at: later,
		});
	});

	it("throws rather than rounding an unsafe aggregate while preserving observations", () => {
		const { db, ledger } = open();
		ledger.record(observation({ input_tokens: Number.MAX_SAFE_INTEGER }));
		ledger.record(observation({}, { attempt_id: "attempt-2", source_id: "bot-job-2" }));
		expect(() => ledger.summary("run")).toThrow("safe integer range");
		expect(db.query("SELECT COUNT(*) AS count FROM graph_usage_sources").get()).toEqual({ count: 2 });
	});

	it("validates every field before any write, including stale snapshots", () => {
		const { db, ledger } = open();
		const invalid: unknown[] = [
			...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined].map(
				input_tokens => observation({ input_tokens } as JobUsage),
			),
			...["-1", "1e2", ".1", "1.", " 1", "Infinity", "", "1".repeat(4097), 1].map(cost_usd =>
				observation({ cost_usd } as JobUsage),
			),
			...["00", "01", "-1", "+1", "1.0", "", 1].map(revision =>
				observation({}, { revision } as GraphUsageObservation),
			),
			observation({ completeness: "estimated" } as unknown as JobUsage),
			observation({ measured_at: "not-a-timestamp" }),
			observation({ measured_at: 1 } as unknown as JobUsage),
			observation({}, { source_id: " " }),
			observation({}, { run_id: "" }),
			observation({}, { invocation_id: "" }),
			observation({}, { attempt_id: "" }),
		];
		for (const value of invalid) expect(() => ledger.record(value as GraphUsageObservation)).toThrow();
		expect(db.query("SELECT COUNT(*) AS count FROM graph_usage_sources").get()).toEqual({ count: 0 });
		ledger.record(observation({}, { revision: "2" }));
		expect(() => ledger.record(observation({ cost_usd: "bad" }, { revision: "1" }))).toThrow();
	});

	it("references graph_runs and participates in the trusted store's transaction", () => {
		const { db, ledger } = open();
		expect(() => ledger.record(observation({}, { run_id: "missing" }))).toThrow();
		expect(() =>
			db.transaction(() => {
				ledger.record(observation());
				throw new Error("Store transaction aborted");
			})(),
		).toThrow("Store transaction aborted");
		expect(ledger.summary("run").observed_sources).toBe(0);
	});

	it("persists cumulative snapshots and their replay identity across reopen", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-usage-"));
		roots.push(root);
		const filename = path.join(root, "graphs.sqlite");
		const first = open(filename);
		first.ledger.record(observation());
		first.ledger.record(observation({ cost_usd: "0.2" }, { revision: "2" }));
		first.db.close();
		databases.delete(first.db);
		const reopened = open(filename);
		expect(reopened.ledger.summary("run")).toMatchObject({ cost_usd: "0.2", observed_sources: 1 });
		expect(reopened.ledger.record(observation({ cost_usd: "0.2" }, { revision: "2" })).status).toBe("replayed");
		expect(reopened.ledger.record(observation()).status).toBe("stale");
		expect(() => reopened.ledger.record(observation({ cost_usd: "0.3" }, { revision: "2" }))).toThrow("Conflicting");
	});
});

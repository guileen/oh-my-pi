import type { Database } from "bun:sqlite";
import { addDecimalCost, compareDecimalAmounts } from "@oh-my-pi/pi-utils";
import type { JobUsage } from "../bots/types";

export interface GraphUsageObservation {
	run_id: string;
	invocation_id: string;
	attempt_id: string;
	source_id: string;
	revision: string;
	usage: JobUsage;
}

export interface GraphUsageSummary extends JobUsage {
	observed_sources: number;
}

export interface GraphUsageRecordResult {
	status: "recorded" | "replayed" | "stale";
	observation: GraphUsageObservation;
}

const tokenFields = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;
const maxAmountLength = 4096;

/** Install under the graph store's schema lock, after graph_runs exists. */
export function installGraphUsageSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS graph_usage_sources (
		run_id TEXT NOT NULL REFERENCES graph_runs(id),
		attempt_id TEXT NOT NULL,
		invocation_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		revision TEXT NOT NULL,
		data TEXT NOT NULL,
		PRIMARY KEY(run_id,attempt_id),
		UNIQUE(run_id,source_id)
	)`);
}

function validate(observation: GraphUsageObservation): GraphUsageObservation {
	if (!observation || typeof observation !== "object") throw new Error("Invalid graph usage observation");
	for (const field of ["run_id", "invocation_id", "attempt_id", "source_id"] as const) {
		if (typeof observation[field] !== "string" || observation[field].trim().length === 0)
			throw new Error(`Invalid graph usage ${field}`);
	}
	if (typeof observation.revision !== "string" || !/^(?:0|[1-9]\d*)$/.test(observation.revision))
		throw new Error("Graph usage revision must be a canonical nonnegative integer string");
	const usage = observation.usage;
	if (!usage || typeof usage !== "object") throw new Error("Invalid graph usage amounts");
	for (const field of tokenFields) {
		if (usage[field] !== null && (!Number.isSafeInteger(usage[field]) || usage[field] < 0))
			throw new Error(`Graph usage ${field} must be a safe nonnegative integer or null`);
	}
	if (
		usage.cost_usd !== null &&
		(typeof usage.cost_usd !== "string" ||
			usage.cost_usd.length > maxAmountLength ||
			!/^\d+(?:\.\d+)?$/.test(usage.cost_usd))
	)
		throw new Error("Graph usage cost_usd must be a nonnegative decimal string of at most 4096 characters or null");
	if (!["complete", "partial", "unknown"].includes(usage.completeness))
		throw new Error("Invalid graph usage completeness");
	if (
		usage.measured_at !== null &&
		(typeof usage.measured_at !== "string" || !Number.isFinite(Date.parse(usage.measured_at)))
	)
		throw new Error("Graph usage measured_at must be a valid timestamp or null");
	return {
		run_id: observation.run_id,
		invocation_id: observation.invocation_id,
		attempt_id: observation.attempt_id,
		source_id: observation.source_id,
		revision: observation.revision,
		usage: {
			input_tokens: usage.input_tokens,
			output_tokens: usage.output_tokens,
			cache_read_tokens: usage.cache_read_tokens,
			cache_write_tokens: usage.cache_write_tokens,
			cost_usd: usage.cost_usd === null ? null : addDecimalCost(usage.cost_usd, "0"),
			completeness: usage.completeness,
			measured_at: usage.measured_at,
		},
	};
}

function compareRevisions(left: string, right: string): number {
	return left.length === right.length ? (left < right ? -1 : left > right ? 1 : 0) : left.length - right.length;
}

function assertCumulative(previous: JobUsage, next: JobUsage): void {
	for (const field of tokenFields) {
		if (previous[field] !== null && (next[field] === null || next[field] < previous[field]))
			throw new Error(`Cumulative graph usage ${field} cannot decrease or become unknown`);
	}
	if (
		previous.cost_usd !== null &&
		(next.cost_usd === null || compareDecimalAmounts(next.cost_usd, previous.cost_usd) < 0)
	)
		throw new Error("Cumulative graph usage cost_usd cannot decrease or become unknown");
}

function sumTokens(left: number | null, right: number | null): number | null {
	if (left === null) return right;
	if (right === null) return left;
	const sum = left + right;
	if (!Number.isSafeInteger(sum)) throw new Error("Graph usage token subtotal exceeds the safe integer range");
	return sum;
}

/**
 * Observed accounting only: this ledger neither authorizes an identity nor enforces a cost limit.
 * The trusted store must authorize the run/attempt/source and call record inside its transaction.
 * Each attempt has one immutable source, whose cumulative snapshot replaces rather than adds to its prior usage.
 */
export class GraphUsageLedger {
	constructor(private readonly db: Database) {}

	record(input: GraphUsageObservation): GraphUsageRecordResult {
		const observation = validate(input);
		const row = this.db
			.query("SELECT data FROM graph_usage_sources WHERE run_id=? AND attempt_id=?")
			.get(observation.run_id, observation.attempt_id) as { data: string } | null;
		if (row) {
			const previous = JSON.parse(row.data) as GraphUsageObservation;
			if (previous.invocation_id !== observation.invocation_id || previous.source_id !== observation.source_id)
				throw new Error("Graph usage source identity cannot change for an attempt");
			const order = compareRevisions(observation.revision, previous.revision);
			if (order < 0) return { status: "stale", observation: previous };
			if (order === 0) {
				if (JSON.stringify(previous) !== JSON.stringify(observation))
					throw new Error("Conflicting graph usage snapshot for the same revision");
				return { status: "replayed", observation: previous };
			}
			assertCumulative(previous.usage, observation.usage);
		} else {
			const source = this.db
				.query("SELECT attempt_id FROM graph_usage_sources WHERE run_id=? AND source_id=?")
				.get(observation.run_id, observation.source_id);
			if (source) throw new Error("Graph usage source cannot move to another attempt");
		}
		this.db
			.query(`INSERT INTO graph_usage_sources (run_id,attempt_id,invocation_id,source_id,revision,data)
				VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,attempt_id) DO UPDATE SET revision=excluded.revision,data=excluded.data`)
			.run(
				observation.run_id,
				observation.attempt_id,
				observation.invocation_id,
				observation.source_id,
				observation.revision,
				JSON.stringify(observation),
			);
		return { status: "recorded", observation };
	}

	/** Include contained Runs by identity, never by adding their already-aggregated totals.
	 * Duplicate Run IDs therefore cannot double-count the same observed source. */
	summary(runId: string, containedRunIds: readonly string[] = []): GraphUsageSummary {
		const rows = this.db
			.query("SELECT data FROM graph_usage_sources WHERE run_id IN (SELECT value FROM json_each(?))")
			.all(JSON.stringify([runId, ...containedRunIds])) as { data: string }[];
		const summary: GraphUsageSummary = {
			input_tokens: null,
			output_tokens: null,
			cache_read_tokens: null,
			cache_write_tokens: null,
			cost_usd: null,
			completeness: "unknown",
			measured_at: null,
			observed_sources: rows.length,
		};
		let complete = rows.length > 0;
		for (const row of rows) {
			const { usage } = JSON.parse(row.data) as GraphUsageObservation;
			for (const field of tokenFields) summary[field] = sumTokens(summary[field], usage[field]);
			summary.cost_usd = addDecimalCost(summary.cost_usd, usage.cost_usd);
			complete &&=
				usage.completeness === "complete" &&
				usage.measured_at !== null &&
				tokenFields.every(field => usage[field] !== null) &&
				usage.cost_usd !== null;
			if (
				usage.measured_at !== null &&
				(summary.measured_at === null || Date.parse(usage.measured_at) > Date.parse(summary.measured_at))
			)
				summary.measured_at = usage.measured_at;
		}
		const anyKnown = summary.cost_usd !== null || tokenFields.some(field => summary[field] !== null);
		summary.completeness = complete ? "complete" : anyKnown ? "partial" : "unknown";
		return summary;
	}
}

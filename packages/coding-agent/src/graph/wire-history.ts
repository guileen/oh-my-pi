import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import {
	GRAPH_WIRE_EXECUTION_EXTENSION,
	GraphWireError,
	isGraphWireExecutionKind,
	type GraphCursor,
	type GraphWireBinding,
	type GraphWireHistoryEvent,
	type GraphWireRecord,
} from "@oh-my-pi/pi-wire/graph";
import { GraphWireLedger, GraphWireLedgerError } from "./wire-ledger";
import { compareGraphWireRevisions, graphWireRecordKey } from "@oh-my-pi/pi-wire/graph/wire-records";

export interface GraphWireRunsOptions {
	graphId: string | null;
	pageToken: string | null;
	limit: number;
	/** Trusted embedding identity: principal + authorization generation + exact authorized scope. */
	scopeKey: string;
}
export interface GraphWireRunSummary {
	graph_id: string;
	graph_run_id: string;
	definition_revision: string;
	created_at: string;
}
export interface GraphWireRunsResult {
	source_id: string;
	items: GraphWireRunSummary[];
	watermark: GraphCursor;
	next_page_token: string | null;
}
export interface GraphWireHistoryFilter {
	node_id?: string;
	invocation_id?: string;
	attempt?: number;
	kind?: string;
}
export interface GraphWireHistoryOptions {
	view: "events" | "state";
	at: GraphCursor | null;
	after: GraphCursor | null;
	filter: GraphWireHistoryFilter;
	pageToken: string | null;
	limit: number;
	scopeKey: string;
	extensions: string[];
}
export interface GraphWireHistoryResult {
	source_id: string;
	graph_run_id: string;
	view: "events" | "state";
	availability: "available" | "partial" | "expired" | "missing";
	items: GraphWireRecord[] | GraphWireHistoryEvent[];
	watermark: GraphCursor | null;
	next_page_token: string | null;
	retained: { from: GraphCursor | null; through: GraphCursor | null };
}

type BindingIdentity = Pick<GraphWireBinding, "node_id" | "invocation_id" | "attempt">;
interface Links {
	bindings: Map<string, BindingIdentity>;
	invocations: Map<string, string>;
	targetNodes: Map<string, string>;
}
interface Pinned {
	key: string;
	expiresAt: number;
	watermark: GraphCursor;
}
interface RunsPage extends Pinned {
	type: "runs";
	items: GraphWireRunSummary[];
	offset: number;
}
interface HistoryPage extends Pinned {
	type: "history";
	from: GraphCursor;
	/** Only a bounded current projection, never an accumulated event journal. */
	records: GraphWireRecord[] | null;
	links: Links;
	offset: number;
	after: GraphCursor;
}
type Page = RunsPage | HistoryPage;

function invalid(message: string): never {
	throw new GraphWireError("invalid_input", message);
}
function identifier(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) invalid(`${name} must be a nonempty identity`);
}
function cursor(value: GraphCursor | null): void {
	if (
		value !== null &&
		(!value ||
			typeof value !== "object" ||
			typeof value.journal_id !== "string" ||
			!value.journal_id ||
			typeof value.seq !== "string" ||
			!/^(0|[1-9][0-9]*)$/.test(value.seq))
	)
		invalid("Expected a canonical Graph cursor or null");
}
function common(sourceId: string, options: GraphWireRunsOptions | GraphWireHistoryOptions): void {
	identifier(sourceId, "sourceId");
	identifier(options.scopeKey, "scopeKey");
	if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
		invalid("Limit must be between 1 and 100");
	if (options.pageToken !== null) identifier(options.pageToken, "pageToken");
}
function historyOptions(options: GraphWireHistoryOptions): void {
	if (options.view !== "events" && options.view !== "state") invalid("Unknown history view");
	cursor(options.at);
	cursor(options.after);
	if (options.view === "state" && options.after !== null) invalid("after applies only to event history");
	if (!Array.isArray(options.extensions) || options.extensions.some(value => typeof value !== "string" || !value))
		invalid("extensions must be an array of extension names");
	const filter = options.filter;
	if (!filter || typeof filter !== "object" || Array.isArray(filter)) invalid("Expected a history filter");
	for (const key of Object.keys(filter)) {
		if (!["node_id", "invocation_id", "attempt", "kind"].includes(key)) invalid("Unknown history filter");
		if (key !== "attempt") identifier(filter[key as "node_id" | "invocation_id" | "kind"], key);
	}
	if (filter.attempt !== undefined) {
		if (!Number.isSafeInteger(filter.attempt) || filter.attempt < 1) invalid("attempt must be a positive integer");
		if (!filter.invocation_id) invalid("attempt requires invocation_id");
	}
	if (filter.kind !== undefined) {
		if (!["run", "binding", "dependency", "transfer"].includes(filter.kind) && !isGraphWireExecutionKind(filter.kind))
			invalid("Unknown canonical Graph entity kind");
		if (isGraphWireExecutionKind(filter.kind) && !options.extensions.includes(GRAPH_WIRE_EXECUTION_EXTENSION))
			invalid("Execution kind requires its negotiated extension");
		const scoped = filter.node_id !== undefined || filter.invocation_id !== undefined || filter.attempt !== undefined;
		if (
			scoped &&
			!["binding", "dependency", "transfer", "execution_invocation", "execution_attempt"].includes(filter.kind)
		)
			invalid("This entity kind has no node, invocation or attempt identity");
		if (filter.kind === "execution_invocation" && filter.attempt !== undefined)
			invalid("An invocation is not an execution attempt");
	}
}
function links(records: readonly GraphWireRecord[]): Links {
	const result: Links = { bindings: new Map(), invocations: new Map(), targetNodes: new Map() };
	for (const record of records) {
		if (record.kind === "binding") {
			const { binding_id, node_id, invocation_id, attempt } = record.value;
			result.bindings.set(binding_id, { node_id, invocation_id, attempt });
		}
		if (record.kind === "execution_invocation")
			result.invocations.set(record.value.invocation_id, record.value.node_id);
		if (record.kind === "run") {
			for (const edge of record.value.definition.edges) result.targetNodes.set(edge.edge_id, edge.to_node_id);
		}
	}
	return result;
}
function matches(record: GraphWireRecord, filter: GraphWireHistoryFilter, context: Links, execution: boolean): boolean {
	if (isGraphWireExecutionKind(record.kind) && !execution) return false;
	if (filter.kind !== undefined && record.kind !== filter.kind) return false;
	if (filter.node_id === undefined && filter.invocation_id === undefined && filter.attempt === undefined) return true;
	const identity = (node: string | undefined, invocation: string | undefined, attempt: number | undefined) =>
		(filter.node_id === undefined || filter.node_id === node) &&
		(filter.invocation_id === undefined || filter.invocation_id === invocation) &&
		(filter.attempt === undefined || filter.attempt === attempt);
	switch (record.kind) {
		case "binding":
			return identity(record.value.node_id, record.value.invocation_id, record.value.attempt);
		case "dependency":
			return identity(
				context.targetNodes.get(record.value.edge_id),
				record.value.target_invocation_id,
				record.value.target_attempt,
			);
		case "transfer":
			return [record.value.from_binding_id, record.value.to_binding_id].some(id => {
				const binding = context.bindings.get(id);
				return binding !== undefined && identity(binding.node_id, binding.invocation_id, binding.attempt);
			});
		case "execution_invocation":
			return identity(record.value.node_id, record.value.invocation_id, undefined);
		case "execution_attempt":
			return identity(
				context.invocations.get(record.value.invocation_id),
				record.value.invocation_id,
				record.value.number,
			);
		default:
			return false;
	}
}

/** Read queries only. The embedding must authorize before AND after calling these methods.
 * scopeKey binds continuation to that authorization, but is not itself proof of permission.
 * Tokens are process-local, opaque, bounded, and expire 60 seconds after the initial query.
 */
export class GraphWireHistoryQueries {
	readonly #pages = new Map<string, Page>();
	readonly #maxTokens: number;
	readonly #clock: () => number;
	#lastNow = -Infinity;

	constructor(
		private readonly ledger: GraphWireLedger,
		options: { maxTokens: number; now?: () => number },
	) {
		if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)
			invalid("maxTokens must be a finite positive integer");
		if (options.now !== undefined && typeof options.now !== "function") invalid("now must be a clock function");
		this.#maxTokens = options.maxTokens;
		this.#clock = options.now ?? Date.now;
	}

	#now(): number {
		const now = this.#clock();
		if (!Number.isFinite(now)) invalid("Clock must return a finite timestamp");
		this.#lastNow = Math.max(this.#lastNow, now);
		for (const [token, page] of this.#pages) if (page.expiresAt <= this.#lastNow) this.#pages.delete(token);
		return this.#lastNow;
	}

	#load(token: string, key: string): Page {
		const page = this.#pages.get(token);
		if (!page) throw new GraphWireError("cursor_expired", "History page token is unknown or expired");
		if (page.key !== key)
			throw new GraphWireError(
				"scope_denied",
				"History page token does not match this query and authorization scope",
			);
		return page;
	}

	#save(page: Page): string {
		while (this.#pages.size >= this.#maxTokens) this.#pages.delete(this.#pages.keys().next().value!);
		const token = crypto.randomUUID();
		this.#pages.set(token, page);
		return token;
	}

	runs(sourceId: string, options: GraphWireRunsOptions): GraphWireRunsResult {
		common(sourceId, options);
		if (options.graphId !== null) identifier(options.graphId, "graphId");
		const now = this.#now();
		const key = canonicalJson(["runs", sourceId, options.graphId, options.limit, options.scopeKey]);
		let page: RunsPage;
		if (options.pageToken !== null) {
			const saved = this.#load(options.pageToken, key);
			if (saved.type !== "runs") invalid("Wrong page token type");
			page = saved;
			const current = this.ledger.snapshot(sourceId).cursor;
			if (
				current.journal_id !== page.watermark.journal_id ||
				compareGraphWireRevisions(current.seq, page.watermark.seq) < 0
			)
				throw new GraphWireError("invalid_cursor", "Run inventory journal changed");
		} else {
			const snapshot = this.ledger.snapshot(sourceId);
			const items: GraphWireRunSummary[] = [];
			for (const record of snapshot.records) {
				if (record.kind !== "run" || (options.graphId !== null && record.value.graph_id !== options.graphId))
					continue;
				const { graph_id, graph_run_id, definition_revision, created_at } = record.value;
				items.push({ graph_id, graph_run_id, definition_revision, created_at });
			}
			items.sort(
				(a, b) =>
					Date.parse(a.created_at) - Date.parse(b.created_at) ||
					(a.graph_run_id < b.graph_run_id ? -1 : a.graph_run_id > b.graph_run_id ? 1 : 0),
			);
			page = { type: "runs", key, expiresAt: now + 60_000, watermark: snapshot.cursor, items, offset: 0 };
		}
		const end = page.offset + options.limit;
		return {
			source_id: sourceId,
			items: structuredClone(page.items.slice(page.offset, end)),
			watermark: { ...page.watermark },
			next_page_token: end < page.items.length ? this.#save({ ...page, offset: end }) : null,
		};
	}

	history(sourceId: string, runId: string, options: GraphWireHistoryOptions): GraphWireHistoryResult {
		common(sourceId, options);
		identifier(runId, "runId");
		historyOptions(options);
		const now = this.#now();
		const key = canonicalJson([
			"history",
			sourceId,
			runId,
			options.view,
			options.at,
			options.after,
			options.filter,
			options.limit,
			options.scopeKey,
			[...new Set(options.extensions)].sort(),
		]);
		let page: HistoryPage | undefined;
		try {
			if (options.pageToken !== null) {
				const saved = this.#load(options.pageToken, key);
				if (saved.type !== "history") invalid("Wrong page token type");
				page = saved;
				// Validate the pinned journal, even for a cached state projection.
				this.ledger.events(sourceId, { after: page.watermark, watermark: page.watermark, runId, limit: 1 });
			} else {
				const watermark = options.at ?? this.ledger.snapshot(sourceId).cursor;
				// Resolve Run existence at the boundary independently of baseline retention.
				this.ledger.events(sourceId, { after: watermark, watermark, runId, limit: 1 });
				const from =
					options.view === "events"
						? (options.after ?? { journal_id: watermark.journal_id, seq: "0" })
						: { journal_id: watermark.journal_id, seq: "0" };
				let records: GraphWireRecord[] | null = null;
				let context = links([]);
				if (options.view === "state") {
					const image = this.ledger.stateAt(sourceId, runId, watermark);
					context = links(image.records);
					records = image.records.sort((a, b) => {
						const left = graphWireRecordKey(a);
						const right = graphWireRecordKey(b);
						return left < right ? -1 : left > right ? 1 : 0;
					});
				} else if (options.filter.node_id !== undefined || options.filter.invocation_id !== undefined) {
					// Only immutable linkage is read from today's image, never historical state.
					// A retained event suffix does not require an earlier reconstruction baseline.
					context = links(this.ledger.snapshot(sourceId, runId).records);
				}
				if (options.view === "events") {
					// Prove completeness of the requested range, not merely of this page.
					// Discard each bounded batch; never retain the complete event journal.
					let after = from;
					for (;;) {
						const batch = this.ledger.events(sourceId, { after, watermark, runId, limit: 100 });
						if (batch.next_cursor === null) break;
						after = batch.next_cursor;
					}
				}
				page = {
					type: "history",
					key,
					expiresAt: now + 60_000,
					watermark: { ...watermark },
					from: { ...from },
					records,
					links: context,
					offset: 0,
					after: { ...from },
				};
			}
			const execution = options.extensions.includes(GRAPH_WIRE_EXECUTION_EXTENSION);
			let items: GraphWireRecord[] | GraphWireHistoryEvent[];
			let next: HistoryPage | null = null;
			if (page.records !== null) {
				const selected: GraphWireRecord[] = [];
				let offset = page.offset;
				while (offset < page.records.length && selected.length < options.limit) {
					const record = page.records[offset++]!;
					if (matches(record, options.filter, page.links, execution)) selected.push(record);
				}
				while (
					offset < page.records.length &&
					!matches(page.records[offset]!, options.filter, page.links, execution)
				)
					offset++;
				items = structuredClone(selected);
				if (offset < page.records.length) next = { ...page, offset };
			} else {
				const selected: GraphWireHistoryEvent[] = [];
				let after = page.after;
				for (;;) {
					const batch = this.ledger.events(sourceId, { after, watermark: page.watermark, runId, limit: 1 });
					const event = batch.events[0];
					if (event) {
						const records = event.records.filter(record =>
							matches(record, options.filter, page!.links, execution),
						);
						if (records.length > 0) {
							if (selected.length === options.limit) {
								next = { ...page, after };
								break;
							}
							selected.push({ ...event, records });
						}
					}
					if (batch.next_cursor === null) break;
					after = batch.next_cursor;
				}
				items = selected;
			}
			return {
				source_id: sourceId,
				graph_run_id: runId,
				view: options.view,
				availability: "available",
				items,
				watermark: { ...page.watermark },
				next_page_token: next === null ? null : this.#save(next),
				retained: { from: { ...page.from }, through: { ...page.watermark } },
			};
		} catch (error) {
			if (!(error instanceof GraphWireLedgerError) || error.availability === undefined) throw error;
			return {
				source_id: sourceId,
				graph_run_id: runId,
				view: options.view,
				availability: error.availability,
				items: [],
				watermark: null,
				next_page_token: null,
				retained: { from: null, through: null },
			};
		}
	}
}

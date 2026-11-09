import { canonicalJson as canonical } from "../canonical-json";
import type { GraphCursor } from "./scalars";
import {
	GRAPH_WIRE_EXECUTION_EXTENSION,
	GRAPH_WIRE_EXECUTION_STATE_POLICIES,
	isGraphWireExecutionKind,
} from "./wire-execution-types";
import {
	assertGraphWireReplacement,
	compareGraphWireRevisions as compareRevision,
	graphWireRecordKey,
	validateGraphWireImage,
	validateGraphWireRecord,
} from "./wire-records";
import {
	GRAPH_WIRE_PROTOCOL,
	GraphWireError,
	type GraphWireCheckpoint,
	type GraphWireRecord,
	type GraphWireSource,
	type GraphWireSourceFrame,
} from "./wire-types";

const frameTypes: Record<string, true> = {
	subscription: true,
	"scope.authorized": true,
	"scope.invalidated": true,
	"source.state": true,
	"snapshot.begin": true,
	"snapshot.page": true,
	"snapshot.end": true,
	"graph.event": true,
	"source.ready": true,
	heartbeat: true,
};
const recordStates: Partial<
	Record<GraphWireRecord["kind"], { field: "acceptance" | "state"; values: readonly string[]; fallback: string }>
> = {
	binding: { field: "acceptance", values: ["pending", "accepted", "rejected", "unknown"], fallback: "unknown" },
	dependency: { field: "state", values: ["waiting", "satisfied", "rejected", "unknown"], fallback: "unknown" },
	transfer: { field: "state", values: ["pending", "delivered", "failed", "unknown"], fallback: "unknown" },
	...GRAPH_WIRE_EXECUTION_STATE_POLICIES,
};

type SourceState = "syncing" | "live" | "stale" | "denied" | "unsupported";
export interface GraphWireSourceStateOptions {
	subscriptionId: string;
	mode: "live" | "history";
	scope: { graph_run_id: string | null; source_ids: string[] };
	/** The transport's negotiated extensions, not a browser-controlled capability assertion. */
	extensions?: string[];
	now?: () => number;
	limits: { maxRecords: number; maxPages: number; maxEvents: number; maxScopes?: number };
}
export interface GraphWireSourceView {
	source: GraphWireSource;
	state: SourceState;
	reason: string | null;
	ready: boolean;
	hasProjection: boolean;
	records: GraphWireRecord[];
	cursor: GraphCursor | null;
	controlsEnabled: boolean;
}
export interface GraphWireSourceStateView {
	subscriptionId: string;
	scopeId: string | null;
	mode: "live" | "history";
	authorizationExpiresAt: string | null;
	transportStale: boolean;
	authorizationPending: boolean;
	invalidated: { scope_id: string; reason: "revoked" | "expired" | "scope_changed" } | null;
	sources: GraphWireSourceView[];
}
interface PendingSnapshot {
	id: string;
	cursor: GraphCursor;
	pageCount: number;
	pages: Map<number, GraphWireRecord[]>;
	recordCount: number;
}
interface SourceImage {
	source: GraphWireSource;
	state: SourceState;
	reason: string | null;
	ready: boolean;
	records: Map<string, GraphWireRecord> | null;
	cursor: GraphCursor | null;
	pending: PendingSnapshot | null;
	events: Map<string, string>;
}

function fail(message: string): never {
	throw new GraphWireError("protocol_error", message);
}
function identifier(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0) fail("Expected a nonempty identifier");
}
function object(value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an object");
}
function cursor(value: unknown): asserts value is GraphCursor {
	object(value);
	identifier(value.journal_id);
	if (typeof value.seq !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.seq)) fail("Invalid cursor sequence");
}
function compareCursor(previous: GraphCursor, next: GraphCursor): number {
	if (previous.journal_id !== next.journal_id)
		throw new GraphWireError("invalid_cursor", "Journal changed without a snapshot");
	return compareRevision(next.seq, previous.seq);
}
function timestamp(value: unknown): number {
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(value))
		fail("Invalid UTC timestamp");
	const time = Date.parse(value);
	if (!Number.isFinite(time)) fail("Invalid UTC timestamp");
	return time;
}

/** Transport-independent, graph-only consumer. All returned projections/checkpoints are detached copies. */
export class GraphWireSourceState {
	readonly #options: GraphWireSourceStateOptions;
	readonly #sources = new Map<string, SourceImage>();
	readonly #retiredScopes = new Set<string>();
	#scopeId: string | null = null;
	#authorizedAt = 0;
	#expiresAt = 0;
	#expiresText: string | null = null;
	#lastNow = -Infinity;
	#lastFrameAt = -Infinity;
	#authorizationPending = false;
	#invalidated: GraphWireSourceStateView["invalidated"] = null;

	constructor(options: GraphWireSourceStateOptions) {
		identifier(options.subscriptionId);
		if (options.mode !== "live" && options.mode !== "history") fail("Invalid subscription mode");
		if (options.scope.graph_run_id !== null) identifier(options.scope.graph_run_id);
		if (!Array.isArray(options.scope.source_ids)) fail("Invalid requested sources");
		for (const id of options.scope.source_ids) identifier(id);
		if (new Set(options.scope.source_ids).size !== options.scope.source_ids.length)
			fail("Duplicate requested source");
		if (options.extensions !== undefined) {
			if (!Array.isArray(options.extensions)) fail("Invalid negotiated extensions");
			for (const extension of options.extensions) identifier(extension);
		}
		for (const limit of [
			options.limits.maxRecords,
			options.limits.maxPages,
			options.limits.maxEvents,
			options.limits.maxScopes ?? options.limits.maxEvents,
		]) {
			if (!Number.isSafeInteger(limit) || limit < 1) fail("Limits must be positive safe integers");
		}
		this.#options = {
			...options,
			scope: structuredClone(options.scope),
			limits: { ...options.limits },
			extensions: [...(options.extensions ?? [])],
		};
	}

	#time(): number {
		const now = (this.#options.now ?? Date.now)();
		if (!Number.isFinite(now)) fail("Clock must return a finite timestamp");
		// Wall-clock rollback must not extend a lease or resurrect expired data.
		this.#lastNow = Math.max(this.#lastNow, now);
		return this.#lastNow;
	}
	#expire(): number {
		const now = this.#time();
		if (this.#scopeId !== null && now >= this.#expiresAt) this.#invalidate("expired");
		return now;
	}
	#invalidate(reason: "revoked" | "expired" | "scope_changed"): void {
		if (this.#scopeId !== null) {
			this.#retiredScopes.add(this.#scopeId);
			this.#invalidated = { scope_id: this.#scopeId, reason };
		}
		this.#scopeId = null;
		this.#sources.clear();
		this.#expiresText = null;
		this.#expiresAt = 0;
		this.#authorizedAt = 0;
		this.#authorizationPending = false;
	}
	#lease(authorizedAt: string, expiresAt: string, now: number): { start: number; end: number } {
		const start = timestamp(authorizedAt);
		const end = timestamp(expiresAt);
		if (end <= start || end - start > 60_000 || start > now || end <= now)
			fail("Invalid or expired authorization lease");
		return { start, end };
	}

	#authorizationConfirmed(): void {
		if (this.#authorizationPending) {
			for (const source of this.#sources.values()) {
				source.ready = false;
				if (source.state === "live") source.state = "syncing";
			}
		}
		this.#authorizationPending = false;
	}
	#membership(sources: GraphWireSource[]): void {
		if (!Array.isArray(sources) || sources.length !== this.#options.scope.source_ids.length) {
			throw new GraphWireError("scope_denied", "Authorized membership differs from requested sources");
		}
		const seen = new Set<string>();
		for (const source of sources) {
			object(source);
			identifier(source.source_id);
			if (!this.#options.scope.source_ids.includes(source.source_id) || seen.has(source.source_id)) {
				throw new GraphWireError("scope_denied", "Unexpected or duplicate authorized source");
			}
			if (source.kind !== "graph" || source.bot_id !== null || source.profile_id !== null) {
				throw new GraphWireError("capability_unavailable", "This consumer supports Graph sources only");
			}
			if (!Array.isArray(source.capabilities) || source.capabilities.some(value => typeof value !== "string"))
				fail("Invalid source capabilities");
			seen.add(source.source_id);
		}
	}
	#subscription(frame: Extract<GraphWireSourceFrame, { type: "subscription" }>, now: number): void {
		identifier(frame.scope_id);
		if (frame.mode !== this.#options.mode) throw new GraphWireError("scope_denied", "Subscription mode changed");
		this.#membership(frame.sources);
		if (this.#retiredScopes.has(frame.scope_id))
			throw new GraphWireError("scope_denied", "Terminated scope cannot be reauthorized");
		const lease = this.#lease(frame.authorized_at, frame.authorization_expires_at, now);
		if (this.#scopeId === frame.scope_id) {
			for (const source of frame.sources) {
				if (canonical(source) !== canonical(this.#sources.get(source.source_id)!.source))
					fail("Scope membership changed without a new scope");
			}
			if (lease.start < this.#authorizedAt || lease.end < this.#expiresAt) return;
		} else {
			if (
				this.#retiredScopes.size + (this.#scopeId === null ? 0 : 1) >=
				(this.#options.limits.maxScopes ?? this.#options.limits.maxEvents)
			) {
				fail("Scope limit exceeded; create a new consumer");
			}
			this.#invalidate("scope_changed");
			this.#scopeId = frame.scope_id;
			this.#invalidated = null;
			for (const source of frame.sources)
				this.#sources.set(source.source_id, {
					source: structuredClone(source),
					state: "syncing",
					reason: null,
					ready: false,
					records: null,
					cursor: null,
					pending: null,
					events: new Map(),
				});
		}
		this.#authorizedAt = lease.start;
		this.#expiresAt = lease.end;
		this.#expiresText = frame.authorization_expires_at;
		this.#authorizationConfirmed();
	}
	#records(records: GraphWireRecord[], source: SourceImage): boolean {
		if (!Array.isArray(records) || records.length > this.#options.limits.maxRecords) fail("Record limit exceeded");
		let supported = true;
		for (const record of records) {
			object(record);
			object(record.value);
			if (
				isGraphWireExecutionKind(record.kind) &&
				(!this.#options.extensions!.includes(GRAPH_WIRE_EXECUTION_EXTENSION) ||
					!source.source.capabilities.includes(GRAPH_WIRE_EXECUTION_EXTENSION))
			)
				throw new GraphWireError(
					"capability_unavailable",
					"Execution records require a negotiated supported extension",
				);
			const policy = Object.hasOwn(recordStates, record.kind) ? recordStates[record.kind] : undefined;
			const value = record.value as unknown as Record<string, unknown>;
			if (
				policy &&
				typeof value[policy.field] === "string" &&
				!policy.values.includes(value[policy.field] as string)
			) {
				// Check all remaining fields without admitting an unrecognized lifecycle value into the image.
				validateGraphWireRecord({ ...record, value: { ...value, [policy.field]: policy.fallback } });
				supported = false;
			} else validateGraphWireRecord(record);
			if (
				this.#options.scope.graph_run_id !== null &&
				record.value.graph_run_id !== this.#options.scope.graph_run_id
			) {
				throw new GraphWireError("scope_denied", "Record belongs to a different Run");
			}
		}
		if (!supported) {
			source.state = "unsupported";
			source.reason = "Unsupported Graph record state";
			source.ready = false;
			source.pending = null;
		}
		return supported;
	}
	#merge(target: Map<string, GraphWireRecord>, records: readonly GraphWireRecord[]): void {
		for (const record of records) {
			const key = graphWireRecordKey(record);
			const previous = target.get(key);
			if (previous) {
				if (compareRevision(record.value.revision, previous.value.revision) < 0) continue;
				assertGraphWireReplacement(previous, record);
				if (compareRevision(record.value.revision, previous.value.revision) <= 0) continue;
			}
			target.set(key, structuredClone(record));
			if (target.size > this.#options.limits.maxRecords) fail("Record limit exceeded");
		}
	}

	apply(frame: GraphWireSourceFrame): void {
		const now = this.#expire();
		object(frame);
		if (frame.protocol !== GRAPH_WIRE_PROTOCOL)
			throw new GraphWireError("unsupported_version", "Unsupported Graph protocol");
		if (!Object.hasOwn(frameTypes, frame.type)) return;
		if (frame.subscription_id !== this.#options.subscriptionId)
			throw new GraphWireError("scope_denied", "Wrong subscription");
		if (frame.in_reply_to !== null && typeof frame.in_reply_to !== "string") fail("Invalid response correlation");
		this.#lastFrameAt = now;
		if (frame.type === "subscription") return this.#subscription(frame, now);
		if (this.#scopeId === null) throw new GraphWireError("scope_denied", "No valid authorization lease");
		if ("scope_id" in frame && frame.scope_id !== this.#scopeId)
			throw new GraphWireError("scope_denied", "Wrong scope");
		switch (frame.type) {
			case "scope.authorized": {
				const lease = this.#lease(frame.authorized_at, frame.authorization_expires_at, now);
				if (lease.start >= this.#authorizedAt && lease.end >= this.#expiresAt) {
					this.#authorizedAt = lease.start;
					this.#expiresAt = lease.end;
					this.#expiresText = frame.authorization_expires_at;
					this.#authorizationConfirmed();
				}
				return;
			}
			case "scope.invalidated":
				if (!["revoked", "expired", "scope_changed"].includes(frame.reason)) fail("Invalid scope invalidation");
				this.#invalidate(frame.reason);
				return;
			case "heartbeat": {
				timestamp(frame.observed_at);
				object(frame.checkpoint);
				if (frame.checkpoint.scope_id !== this.#scopeId)
					throw new GraphWireError("scope_denied", "Wrong heartbeat scope");
				if (!Array.isArray(frame.checkpoint.entries) || frame.checkpoint.entries.length > this.#sources.size)
					fail("Invalid heartbeat checkpoint");
				const seen = new Set<string>();
				for (const entry of frame.checkpoint.entries) {
					object(entry);
					const source = this.#sources.get(entry.source_id);
					if (!source || seen.has(entry.source_id))
						throw new GraphWireError("scope_denied", "Invalid heartbeat source");
					cursor(entry.cursor);
					if (source.cursor) compareCursor(source.cursor, entry.cursor);
					seen.add(entry.source_id);
				}
				return;
			}
		}
		if (!("source_id" in frame)) return; // Unknown additive frames do not establish state or authority.
		const source = this.#sources.get(frame.source_id);
		if (!source) throw new GraphWireError("scope_denied", "Source is not authorized");
		if (this.#options.mode === "history" && ["source.state", "source.ready", "graph.event"].includes(frame.type)) {
			fail("History cannot start a live stream");
		}
		switch (frame.type) {
			case "source.state":
				if (frame.reason !== null && typeof frame.reason !== "string") fail("Invalid source reason");
				if (!["syncing", "live", "stale", "denied", "unsupported"].includes(frame.state)) {
					source.state = "unsupported";
					source.ready = false;
					return;
				}
				if (frame.state !== "live") source.ready = false;
				source.state = frame.state === "live" && !source.ready ? "syncing" : frame.state;
				source.reason = frame.reason;
				if (frame.state === "denied") {
					source.records = null;
					source.cursor = null;
					source.pending = null;
					source.events.clear();
				}
				return;
			case "snapshot.begin": {
				identifier(frame.snapshot_id);
				cursor(frame.cursor);
				if (
					!Number.isSafeInteger(frame.page_count) ||
					frame.page_count < 1 ||
					frame.page_count > this.#options.limits.maxPages
				)
					fail("Page limit exceeded");
				if (source.pending) fail("Snapshot already in progress");
				if (source.cursor?.journal_id === frame.cursor.journal_id && compareCursor(source.cursor, frame.cursor) < 0)
					fail("Snapshot cursor moved backwards");
				source.pending = {
					id: frame.snapshot_id,
					cursor: structuredClone(frame.cursor),
					pageCount: frame.page_count,
					pages: new Map(),
					recordCount: 0,
				};
				source.ready = false;
				source.state = "syncing";
				return;
			}
			case "snapshot.page":
			case "snapshot.end": {
				cursor(frame.cursor);
				const pending = source.pending;
				if (!pending || pending.id !== frame.snapshot_id || canonical(frame.cursor) !== canonical(pending.cursor))
					fail("Snapshot identity or cursor mismatch");
				if (frame.type === "snapshot.page") {
					if (!Number.isSafeInteger(frame.page) || frame.page < 1 || frame.page > pending.pageCount)
						fail("Invalid snapshot page");
					if (!this.#records(frame.records, source)) return;
					const previous = pending.pages.get(frame.page);
					if (previous) {
						if (canonical(previous) !== canonical(frame.records)) fail("Conflicting duplicate snapshot page");
						return;
					}
					if (pending.recordCount + frame.records.length > this.#options.limits.maxRecords)
						fail("Snapshot record limit exceeded");
					pending.pages.set(frame.page, structuredClone(frame.records));
					pending.recordCount += frame.records.length;
					return;
				}
				if (pending.pages.size !== pending.pageCount) fail("Snapshot ended before all pages arrived");
				const image = new Map<string, GraphWireRecord>();
				for (let page = 1; page <= pending.pageCount; page++) this.#merge(image, pending.pages.get(page)!);
				if (source.cursor?.journal_id === pending.cursor.journal_id) {
					for (const [key, record] of image) {
						const previous = source.records?.get(key);
						if (!previous) continue;
						if (compareRevision(record.value.revision, previous.value.revision) < 0) image.set(key, previous);
						else assertGraphWireReplacement(previous, record);
					}
				}
				validateGraphWireImage([...image.values()]);
				if (source.cursor?.journal_id !== pending.cursor.journal_id) source.events.clear();
				source.records = image;
				source.cursor = pending.cursor;
				source.pending = null;
				return;
			}
			case "graph.event": {
				identifier(frame.event_id);
				cursor(frame.cursor);
				timestamp(frame.occurred_at);
				if (typeof frame.replay !== "boolean") fail("Invalid replay flag");
				if (!this.#records(frame.records, source)) return;
				const fingerprint = canonical({
					cursor: frame.cursor,
					occurred_at: frame.occurred_at,
					records: frame.records,
				});
				const duplicate = source.events.get(frame.event_id);
				if (duplicate !== undefined) {
					if (duplicate !== fingerprint) fail("Conflicting duplicate event ID");
					return;
				}
				if (!source.records || !source.cursor || source.pending)
					fail("Event requires a committed projection and no partial snapshot");
				if (!frame.replay && !source.ready) fail("Live event arrived before source ready");
				if (frame.replay && source.ready) fail("Replay event arrived after source ready");
				if (compareCursor(source.cursor, frame.cursor) <= 0) fail("Event cursor must increase");
				if (source.events.size >= this.#options.limits.maxEvents)
					fail("Event limit exceeded; reconnect with a fresh consumer");
				const image = new Map(source.records);
				this.#merge(image, frame.records);
				validateGraphWireImage([...image.values()]);
				source.records = image;
				source.cursor = structuredClone(frame.cursor);
				source.events.set(frame.event_id, fingerprint);
				return;
			}
			case "source.ready":
				cursor(frame.cursor);
				if (!source.records || !source.cursor || source.pending) fail("Ready requires a committed projection");
				if (compareCursor(source.cursor, frame.cursor) < 0) fail("Ready cursor moved backwards");
				if (source.state === "denied" || source.state === "unsupported")
					fail("Unavailable source cannot become ready");
				source.cursor = structuredClone(frame.cursor);
				source.ready = true;
				source.state = "live";
				source.reason = null;
				return;
		}
	}

	/** Reconnect/foreground hides retained content until reauthorization; checkpoints stay recoverable. */
	reconnect(): void {
		this.#expire();
		this.#authorizationPending = this.#scopeId !== null;
		for (const source of this.#sources.values()) {
			source.ready = false;
			source.state = "syncing";
			source.pending = null;
		}
	}
	checkpoint(): GraphWireCheckpoint | null {
		this.#expire();
		if (this.#scopeId === null || this.#options.mode !== "live") return null;
		return {
			scope_id: this.#scopeId,
			entries: [...this.#sources.values()].flatMap(source =>
				source.records && source.cursor
					? [{ source_id: source.source.source_id, cursor: { ...source.cursor } }]
					: [],
			),
		};
	}
	controlsEnabled(sourceId: string): boolean {
		const now = this.#expire();
		const source = this.#sources.get(sourceId);
		return (
			this.#scopeId !== null &&
			!this.#authorizationPending &&
			this.#options.mode === "live" &&
			now - this.#lastFrameAt < 15_000 &&
			source?.ready === true &&
			source.state === "live"
		);
	}
	read(): GraphWireSourceStateView {
		const now = this.#expire();
		const transportStale = now - this.#lastFrameAt >= 15_000;
		return {
			subscriptionId: this.#options.subscriptionId,
			scopeId: this.#scopeId,
			mode: this.#options.mode,
			authorizationExpiresAt: this.#expiresText,
			transportStale,
			authorizationPending: this.#authorizationPending,
			invalidated: this.#invalidated ? { ...this.#invalidated } : null,
			sources: this.#authorizationPending
				? []
				: [...this.#sources.values()].map(source => ({
						source: structuredClone(source.source),
						state: source.state,
						reason: source.reason,
						ready: source.ready,
						hasProjection: source.records !== null,
						records: structuredClone([...(source.records?.values() ?? [])]),
						cursor: source.cursor ? { ...source.cursor } : null,
						controlsEnabled:
							this.#options.mode === "live" && !transportStale && source.ready && source.state === "live",
					})),
		};
	}
}

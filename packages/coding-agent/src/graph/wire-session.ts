import type { GraphWireLedger } from "./wire-ledger";
import { compareGraphWireRevisions } from "@oh-my-pi/pi-wire/graph/wire-records";
import {
	GRAPH_WIRE_EXECUTION_EXTENSION,
	GRAPH_WIRE_PROTOCOL,
	GraphWireError,
	isGraphWireExecutionKind,
	type GraphCursor,
	type GraphWireCheckpoint,
	type GraphWireRecord,
	type GraphWireSource,
	type GraphWireSourceFrame,
} from "@oh-my-pi/pi-wire/graph";

type FramePayload<T = GraphWireSourceFrame> = T extends GraphWireSourceFrame
	? Omit<T, "protocol" | "in_reply_to" | "subscription_id">
	: never;

export interface GraphWireReadScope {
	graph_run_id: string | null;
	source_ids: string[];
}
export interface GraphWireReadGrant {
	/** Must change whenever membership or principal authorization changes. */
	generation: string;
}
export interface GraphWireSessionOptions<Principal> {
	principal: Principal;
	subscription_id: string;
	mode: "live" | "history";
	scope: GraphWireReadScope;
	/** Server-owned source bindings, never browser-supplied executable configuration. */
	sources: GraphWireSource[];
	/** Already negotiated by the authenticated transport; source support is checked independently. */
	extensions?: string[];
	authorize(
		principal: Principal,
		scope: GraphWireReadScope,
	): GraphWireReadGrant | null | Promise<GraphWireReadGrant | null>;
	page_size: number;
	now?: () => number;
}

/** Read-only §4 source delivery. The authenticated transport owns cadence, backpressure and dispatch.
 * This object never authenticates a browser, executes a command or advertises execution capability. */
export class GraphWireReadSession<Principal> {
	readonly #ledger: GraphWireLedger;
	readonly #options: GraphWireSessionOptions<Principal>;
	readonly #scopeId = crypto.randomUUID();
	readonly #cursors = new Map<string, GraphCursor>();
	readonly #ready = new Set<string>();
	#generation: string | null = null;
	#authorizedAt = 0;
	#expiresAt = 0;
	#lastNow = -Infinity;
	#opened = false;
	#closed = false;
	#closedReason: "revoked" | "expired" | "scope_changed" = "revoked";
	#busy = false;

	constructor(ledger: GraphWireLedger, options: GraphWireSessionOptions<Principal>) {
		if (
			!options.subscription_id ||
			!["live", "history"].includes(options.mode) ||
			!Number.isInteger(options.page_size) ||
			options.page_size < 1 ||
			options.page_size > 100 ||
			(options.extensions !== undefined &&
				(!Array.isArray(options.extensions) || options.extensions.some(value => typeof value !== "string"))) ||
			!(
				options.scope.graph_run_id === null ||
				(typeof options.scope.graph_run_id === "string" && options.scope.graph_run_id.length > 0)
			) ||
			!options.scope.source_ids.length ||
			new Set(options.scope.source_ids).size !== options.scope.source_ids.length ||
			options.scope.source_ids.some(id => !id || !options.sources.some(source => source.source_id === id)) ||
			options.sources.length !== options.scope.source_ids.length ||
			new Set(options.sources.map(source => source.source_id)).size !== options.sources.length ||
			options.sources.some(source => source.kind !== "graph" || source.profile_id !== null || source.bot_id !== null)
		)
			throw new GraphWireError("invalid_input", "Invalid authorized Graph source subscription");
		this.#ledger = ledger;
		this.#options = {
			...options,
			scope: structuredClone(options.scope),
			sources: structuredClone(options.sources),
			extensions: [...(options.extensions ?? [])],
		};
	}

	#visible(sourceId: string, records: GraphWireRecord[]): GraphWireRecord[] {
		if (
			this.#options.extensions!.includes(GRAPH_WIRE_EXECUTION_EXTENSION) &&
			this.#options.sources
				.find(source => source.source_id === sourceId)!
				.capabilities.includes(GRAPH_WIRE_EXECUTION_EXTENSION)
		)
			return records;
		return records.filter(record => !isGraphWireExecutionKind(record.kind));
	}

	#now(): number {
		const clock = this.#options.now;
		const now = clock ? clock() : Date.now();
		if (!Number.isFinite(now)) throw new GraphWireError("invalid_input", "Clock must return a finite timestamp");
		this.#lastNow = Math.max(this.#lastNow, now);
		return this.#lastNow;
	}
	#frame(frame: FramePayload): GraphWireSourceFrame {
		return {
			protocol: GRAPH_WIRE_PROTOCOL,
			in_reply_to: null,
			subscription_id: this.#options.subscription_id,
			...frame,
		} as GraphWireSourceFrame;
	}

	async #check(renew = false, force = false): Promise<boolean> {
		if (this.#closed) throw new GraphWireError("scope_denied", "Graph subscription is closed");
		if (this.#opened && this.#now() >= this.#expiresAt) {
			this.invalidate("expired");
			throw new GraphWireError("scope_denied", "Graph authorization lease expired");
		}
		let grant: GraphWireReadGrant | null;
		try {
			const authorize = this.#options.authorize;
			grant = await authorize(this.#options.principal, structuredClone(this.#options.scope));
		} catch {
			this.invalidate("revoked");
			throw new GraphWireError("scope_denied", "Graph authorization could not be verified");
		}
		if (this.#closed) throw new GraphWireError("scope_denied", "Graph subscription is closed");
		if (
			!grant ||
			typeof grant.generation !== "string" ||
			!grant.generation ||
			(this.#generation !== null && this.#generation !== grant.generation) ||
			(this.#opened && this.#now() >= this.#expiresAt)
		) {
			this.invalidate(
				this.#opened && this.#now() >= this.#expiresAt
					? "expired"
					: grant && this.#generation !== null && grant.generation !== this.#generation
						? "scope_changed"
						: "revoked",
			);
			throw new GraphWireError("scope_denied", "Graph subscription authorization changed or was revoked");
		}
		this.#generation = grant.generation;
		const now = this.#now();
		if (!this.#opened || force || (renew && now - this.#authorizedAt >= 30_000)) {
			this.#authorizedAt = now;
			this.#expiresAt = now + 60_000;
			return true;
		}
		return false;
	}

	#lease() {
		return {
			scope_id: this.#scopeId,
			authorized_at: new Date(this.#authorizedAt).toISOString(),
			authorization_expires_at: new Date(this.#expiresAt).toISOString(),
		};
	}

	async *#authorizeDelivery(): AsyncGenerator<GraphWireSourceFrame> {
		if (await this.#check(true)) {
			yield this.#frame({ type: "scope.authorized", ...this.#lease() });
			await this.#check();
		}
	}

	/** The resume checkpoint is accepted only alongside this session's retained committed state.
	 * A new session/tab must request snapshots, not import a cursor without a projection. */
	async *frames(resume: GraphWireCheckpoint | null = null): AsyncGenerator<GraphWireSourceFrame> {
		if (this.#busy) throw new GraphWireError("invalid_input", "Graph subscription delivery is already in progress");
		this.#busy = true;
		try {
			resume = resume === null ? null : structuredClone(resume);
			const renewal = await this.#check(true, resume !== null);
			if (resume !== null) {
				const saved = this.checkpoint();
				if (
					!saved ||
					saved.scope_id !== resume.scope_id ||
					saved.entries.length !== resume.entries.length ||
					new Set(resume.entries.map(entry => entry.source_id)).size !== resume.entries.length ||
					saved.entries.some(
						entry =>
							!resume!.entries.some(
								other =>
									other.source_id === entry.source_id &&
									other.cursor.journal_id === entry.cursor.journal_id &&
									/^(0|[1-9][0-9]*)$/.test(other.cursor.seq) &&
									compareGraphWireRevisions(other.cursor.seq, entry.cursor.seq) <= 0,
							),
					)
				)
					throw new GraphWireError("invalid_cursor", "Resume requires the matching committed subscription image");
				for (const entry of resume.entries) this.#cursors.set(entry.source_id, { ...entry.cursor });
			}
			if (!this.#opened) {
				this.#opened = true;
				yield this.#frame({
					type: "subscription",
					...this.#lease(),
					mode: this.#options.mode,
					sources: structuredClone(this.#options.sources),
				});
			} else if (renewal) {
				yield this.#frame({ type: "scope.authorized", ...this.#lease() });
			}
			if (this.#options.mode === "history") return;
			for (const source of this.#options.sources) {
				const sourceId = source.source_id;
				if (resume !== null) {
					yield* this.#authorizeDelivery();
					yield this.#frame({ type: "source.state", source_id: sourceId, state: "syncing", reason: null });
				}
				let reset = false;
				while (true) {
					if (!this.#cursors.has(sourceId)) {
						yield* this.#authorizeDelivery();
						yield this.#frame({ type: "source.state", source_id: sourceId, state: "syncing", reason: null });
						yield* this.#authorizeDelivery();
						const snapshot = this.#ledger.snapshot(sourceId, this.#options.scope.graph_run_id ?? undefined);
						const records = this.#visible(sourceId, snapshot.records);
						const snapshotId = crypto.randomUUID();
						const pageCount = Math.max(1, Math.ceil(records.length / this.#options.page_size));
						yield this.#frame({
							type: "snapshot.begin",
							source_id: sourceId,
							snapshot_id: snapshotId,
							cursor: { ...snapshot.cursor },
							page_count: pageCount,
						});
						for (let page = 1; page <= pageCount; page++) {
							yield* this.#authorizeDelivery();
							yield this.#frame({
								type: "snapshot.page",
								source_id: sourceId,
								snapshot_id: snapshotId,
								cursor: { ...snapshot.cursor },
								page,
								records: records.slice((page - 1) * this.#options.page_size, page * this.#options.page_size),
							});
						}
						yield* this.#authorizeDelivery();
						this.#cursors.set(sourceId, { ...snapshot.cursor });
						yield this.#frame({
							type: "snapshot.end",
							source_id: sourceId,
							snapshot_id: snapshotId,
							cursor: { ...snapshot.cursor },
						});
					}
					let after = this.#cursors.get(sourceId)!;
					let watermark: GraphCursor | undefined;
					try {
						while (true) {
							yield* this.#authorizeDelivery();
							const page = this.#ledger.events(sourceId, {
								after,
								watermark,
								runId: this.#options.scope.graph_run_id ?? undefined,
								limit: this.#options.page_size,
							});
							watermark = page.watermark;
							for (const event of page.events) {
								const records = this.#visible(sourceId, event.records);
								if (records.length === 0) continue;
								yield* this.#authorizeDelivery();
								this.#cursors.set(sourceId, { ...event.cursor });
								yield this.#frame({
									type: "graph.event",
									source_id: sourceId,
									...event,
									records,
									replay: resume !== null || !this.#ready.has(sourceId),
								});
							}
							after = page.cursor;
							if (!page.next_cursor) break;
						}
					} catch (error) {
						if (
							reset ||
							!(error instanceof GraphWireError) ||
							(error.code !== "cursor_expired" && error.code !== "invalid_cursor")
						)
							throw error;
						// A retained image cannot bridge a journal reset or retention gap. Replace only
						// this source, using the ordinary authorized snapshot and ready barriers.
						this.#cursors.delete(sourceId);
						this.#ready.delete(sourceId);
						reset = true;
						continue;
					}
					yield* this.#authorizeDelivery();
					this.#cursors.set(sourceId, { ...watermark! });
					this.#ready.add(sourceId);
					yield this.#frame({ type: "source.ready", source_id: sourceId, cursor: { ...watermark! } });
					break;
				}
			}
			yield* this.#authorizeDelivery();
			yield this.#frame({
				type: "heartbeat",
				observed_at: new Date(this.#now()).toISOString(),
				checkpoint: this.checkpoint()!,
			});
		} catch (error) {
			if (!(error instanceof GraphWireError) || error.code !== "scope_denied" || !this.#opened) throw error;
			yield this.invalidate(this.#closedReason);
		} finally {
			this.#busy = false;
		}
	}

	checkpoint(): GraphWireCheckpoint | null {
		if (
			!this.#opened ||
			this.#closed ||
			this.#options.mode !== "live" ||
			this.#now() >= this.#expiresAt ||
			this.#options.scope.source_ids.some(sourceId => !this.#cursors.has(sourceId))
		)
			return null;
		return {
			scope_id: this.#scopeId,
			entries: this.#options.scope.source_ids.map(source_id => ({
				source_id,
				cursor: { ...this.#cursors.get(source_id)! },
			})),
		};
	}

	invalidate(reason: "revoked" | "expired" | "scope_changed"): GraphWireSourceFrame {
		this.#closed = true;
		this.#closedReason = reason;
		this.#cursors.clear();
		return this.#frame({ type: "scope.invalidated", scope_id: this.#scopeId, reason });
	}
}

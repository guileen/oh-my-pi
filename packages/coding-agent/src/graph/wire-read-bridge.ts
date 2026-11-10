import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { GraphWireArtifactContentReader } from "./wire-artifact-content";
import type { GraphWireConsultationDetailReader } from "./wire-consultation-detail";
import { GraphWireHistoryQueries, type GraphWireHistoryResult, type GraphWireRunsResult } from "./wire-history";
import type { GraphWireLedger } from "./wire-ledger";
import { GraphWireReadSession, type GraphWireReadGrant, type GraphWireReadScope } from "./wire-session";
import {
	GRAPH_WIRE_EXECUTION_EXTENSION,
	GRAPH_WIRE_PROTOCOL,
	GraphWireError,
	type GraphCursor,
	type GraphWireCheckpoint,
	type GraphWireSource,
	type GraphWireSourceFrame,
} from "@oh-my-pi/pi-wire/graph";

export interface GraphWireReadCatalog {
	/** Change when the principal's permission or any source binding changes. */
	generation: string;
	sources: GraphWireSource[];
}
export interface GraphWireReadBridgeOptions<Principal> {
	/** Authenticated out of band by the embedding transport, never read from a client frame. */
	principal: Principal;
	catalog(principal: Principal): GraphWireReadCatalog | null | Promise<GraphWireReadCatalog | null>;
	authorize(
		principal: Principal,
		scope: GraphWireReadScope,
	): GraphWireReadGrant | null | Promise<GraphWireReadGrant | null>;
	maxSubscriptions: number;
	maxPageTokens: number;
	pageSize: number;
	/** Explicit trusted read support; defaults to legacy records, not execution capability. */
	extensions?: string[];
	consultationDetails?: GraphWireConsultationDetailReader;
	/** Trusted registered input/output reader; does not grant or advertise execution by itself. */
	artifactContents?: Pick<GraphWireArtifactContentReader, "read">;
	now?: () => number;
}
export interface GraphWireReadError {
	code: GraphWireError["code"];
	message: string;
	retryable: boolean;
	details: null;
	reset_required: boolean;
}
export type GraphWireReadFrame =
	| GraphWireSourceFrame
	| ({
			protocol: typeof GRAPH_WIRE_PROTOCOL;
			in_reply_to: string | null;
	  } & (
			| { type: "hello"; capabilities: string[]; sources: GraphWireSource[]; extensions: string[] }
			| { type: "error"; error: GraphWireReadError }
			| ({ type: "graph.runs" } & GraphWireRunsResult)
			| ({ type: "graph.history" } & GraphWireHistoryResult)
			| {
					type: "graph.artifact";
					source_id: string;
					graph_run_id: string;
					ref: string;
					availability: "available" | "expired" | "missing" | "unknown";
					media_type: string | null;
					content: string | null;
					next_page_token: null;
			  }
	  ));
type ReadFramePayload<T = Exclude<GraphWireReadFrame, GraphWireSourceFrame>> = T extends GraphWireReadFrame
	? Omit<T, "protocol" | "in_reply_to">
	: never;
interface Subscription {
	session: GraphWireReadSession<unknown>;
	scope: GraphWireReadScope;
	mode: "live" | "history";
	scopeId: string | null;
	expiresAt: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
function invalid(): never {
	throw new GraphWireError("invalid_input", "Invalid Graph read request");
}
function strings(value: unknown, max: number): value is string[] {
	return Array.isArray(value) && value.length <= max && value.every(id) && new Set(value).size === value.length;
}
function cursor(value: unknown): value is GraphCursor {
	return (
		object(value) &&
		id(value.journal_id) &&
		typeof value.seq === "string" &&
		/^(0|[1-9][0-9]{0,255})$/.test(value.seq)
	);
}
function checkpoint(value: unknown): value is GraphWireCheckpoint {
	return (
		object(value) &&
		id(value.scope_id) &&
		Array.isArray(value.entries) &&
		value.entries.length <= 64 &&
		value.entries.every(entry => object(entry) && id(entry.source_id) && cursor(entry.cursor)) &&
		new Set(value.entries.map(entry => entry.source_id)).size === value.entries.length
	);
}
function scope(value: unknown): value is GraphWireReadScope {
	return (
		object(value) &&
		(value.graph_run_id === null || id(value.graph_run_id)) &&
		strings(value.source_ids, 64) &&
		value.source_ids.length > 0
	);
}
function limit(value: unknown): value is number {
	return Number.isInteger(value) && typeof value === "number" && value >= 1 && value <= 100;
}
function bounded(value: number, max: number): boolean {
	return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/** Authenticated transport adapter, not a listener or an execution service.
 * The embedding owns authentication, origin checks, bounded input/output, <=5s polling,
 * immediate revocation notification and connection lifetime. Mutations are always denied.
 * A new connection has no retained image: it cannot import another connection's checkpoint.
 */
export class GraphWireReadBridge<Principal> {
	readonly #ledger: GraphWireLedger;
	readonly #options: GraphWireReadBridgeOptions<Principal>;
	readonly #queries: GraphWireHistoryQueries;
	readonly #subscriptions = new Map<string, Subscription>();
	readonly #connectionId = crypto.randomUUID();
	#catalog: GraphWireReadCatalog | null = null;
	#extensions: string[] = [];
	#busy = false;
	#closed = false;
	#lastNow = -Infinity;

	constructor(ledger: GraphWireLedger, options: GraphWireReadBridgeOptions<Principal>) {
		if (
			!bounded(options.maxSubscriptions, 64) ||
			!bounded(options.maxPageTokens, 10000) ||
			!bounded(options.pageSize, 100) ||
			(options.extensions !== undefined &&
				(!strings(options.extensions, 1) ||
					options.extensions.some(extension => extension !== GRAPH_WIRE_EXECUTION_EXTENSION))) ||
			(options.extensions?.includes(GRAPH_WIRE_EXECUTION_EXTENSION) &&
				!options.consultationDetails &&
				!options.artifactContents)
		)
			invalid();
		this.#ledger = ledger;
		this.#options = { ...options, extensions: [...(options.extensions ?? [])] };
		this.#queries = new GraphWireHistoryQueries(ledger, { maxTokens: options.maxPageTokens, now: () => this.#now() });
	}

	#now(): number {
		const clock = this.#options.now;
		const value = clock ? clock() : Date.now();
		if (!Number.isFinite(value)) invalid();
		this.#lastNow = Math.max(this.#lastNow, value);
		return this.#lastNow;
	}
	#frame(frame: ReadFramePayload, reply: string | null): GraphWireReadFrame {
		return { protocol: GRAPH_WIRE_PROTOCOL, in_reply_to: reply, ...frame };
	}
	#error(error: unknown, reply: string | null): GraphWireReadFrame {
		const code = error instanceof GraphWireError ? error.code : "capability_unavailable";
		// Exceptions can include profile paths or protected data. Never forward their prose.
		const messages: Record<GraphWireReadError["code"], string> = {
			invalid_input: "Invalid Graph read request",
			invalid_cursor: "Graph cursor or page token is not valid for this scope",
			cursor_expired: "Graph history requires a fresh snapshot",
			binding_conflict: "Graph identity conflicts with its retained binding",
			protocol_error: "Graph source protocol is invalid",
			scope_denied: "Graph observation is not authorized",
			unsupported_version: "Graph protocol version is not supported",
			capability_unavailable: "Graph operation is unavailable on this read-only connection",
		};
		return this.#frame(
			{
				type: "error",
				error: {
					code,
					message: messages[code],
					retryable: false,
					details: null,
					reset_required: code === "cursor_expired",
				},
			},
			reply,
		);
	}
	async #currentCatalog(): Promise<GraphWireReadCatalog> {
		const callback = this.#options.catalog;
		let value: GraphWireReadCatalog | null;
		try {
			value = await callback(this.#options.principal);
		} catch {
			throw new GraphWireError("scope_denied", "Graph catalog authorization unavailable");
		}
		if (
			this.#closed ||
			!value ||
			!id(value.generation) ||
			!Array.isArray(value.sources) ||
			value.sources.length > 64 ||
			value.sources.some(
				source =>
					!object(source) ||
					!id(source.source_id) ||
					source.kind !== "graph" ||
					source.profile_id !== null ||
					source.bot_id !== null ||
					!strings(source.capabilities, 64),
			) ||
			new Set(value.sources.map(source => source.source_id)).size !== value.sources.length
		)
			throw new GraphWireError("scope_denied", "Graph catalog authorization unavailable");
		const result: GraphWireReadCatalog = {
			generation: value.generation,
			sources: value.sources.map(source => ({
				source_id: source.source_id,
				kind: "graph",
				profile_id: null,
				bot_id: null,
				capabilities: [...source.capabilities],
			})),
		};
		if (this.#catalog && canonicalJson(result) !== canonicalJson(this.#catalog))
			throw new GraphWireError("scope_denied", "Graph source authorization changed");
		return result;
	}
	async #authorize(readScope: GraphWireReadScope): Promise<GraphWireReadGrant> {
		const catalog = await this.#currentCatalog();
		if (!readScope.source_ids.every(sourceId => catalog.sources.some(source => source.source_id === sourceId)))
			throw new GraphWireError("scope_denied", "Graph source not authorized");
		const callback = this.#options.authorize;
		let grant: GraphWireReadGrant | null;
		try {
			grant = await callback(this.#options.principal, structuredClone(readScope));
		} catch {
			grant = null;
		}
		if (this.#closed || !grant || grant.generation !== catalog.generation)
			throw new GraphWireError("scope_denied", "Graph scope not authorized");
		return { generation: grant.generation };
	}
	#sources(readScope?: GraphWireReadScope): GraphWireSource[] {
		return this.#catalog!.sources
			.filter(source => !readScope || readScope.source_ids.includes(source.source_id))
			.map(source => ({
				...structuredClone(source),
				capabilities: source.capabilities.filter(
					capability =>
						["graph.runs.v1", "graph.history.v1", "graph.transfers.v1"].includes(capability) ||
						(capability === GRAPH_WIRE_EXECUTION_EXTENSION && this.#extensions.includes(capability)),
				),
			}));
	}
	#capability(sourceId: string, capability: string): void {
		if (!this.#sources().some(source => source.source_id === sourceId && source.capabilities.includes(capability)))
			throw new GraphWireError("capability_unavailable", "Graph source does not support this read");
	}
	#scopeKey(readScope: GraphWireReadScope): string {
		return canonicalJson([this.#connectionId, this.#catalog!.generation, readScope, this.#extensions]);
	}
	async *#deliver(
		subscription: Subscription,
		resume: GraphWireCheckpoint | null,
		reply: string | null,
	): AsyncGenerator<GraphWireReadFrame> {
		for await (const frame of subscription.session.frames(resume)) {
			if (frame.type === "subscription" || frame.type === "scope.authorized") {
				subscription.scopeId = frame.scope_id;
				subscription.expiresAt = Date.parse(frame.authorization_expires_at);
			}
			if (frame.type === "scope.invalidated") this.#subscriptions.delete(frame.subscription_id);
			yield frame.type === "subscription" ? { ...frame, in_reply_to: reply } : frame;
		}
	}
	async #historyScope(input: Record<string, unknown>): Promise<Subscription> {
		if (!id(input.subscription_id) || !id(input.scope_id) || !id(input.source_id) || !id(input.graph_run_id))
			invalid();
		const subscription = this.#subscriptions.get(input.subscription_id);
		if (
			!subscription ||
			subscription.scopeId !== input.scope_id ||
			this.#now() >= subscription.expiresAt ||
			!subscription.scope.source_ids.includes(input.source_id) ||
			(subscription.scope.graph_run_id !== null && subscription.scope.graph_run_id !== input.graph_run_id)
		)
			throw new GraphWireError("scope_denied", "Graph history scope is not current");
		await this.#authorize(subscription.scope);
		return subscription;
	}

	async *handle(value: unknown): AsyncGenerator<GraphWireReadFrame> {
		let reply: string | null = object(value) && id(value.message_id) ? value.message_id : null;
		if (this.#busy) {
			yield this.#error(new GraphWireError("invalid_input", "Concurrent Graph delivery"), reply);
			return;
		}
		this.#busy = true;
		try {
			if (this.#closed || !object(value) || !id(value.message_id) || !id(value.type)) invalid();
			const input = structuredClone(value);
			reply = input.message_id as string;
			if (input.protocol !== GRAPH_WIRE_PROTOCOL)
				throw new GraphWireError("unsupported_version", "Unsupported protocol");
			if (input.type === "hello") {
				if (
					this.#catalog ||
					!strings(input.supported_protocols, 32) ||
					!input.supported_protocols.includes(GRAPH_WIRE_PROTOCOL) ||
					(input.extensions !== undefined && !strings(input.extensions, 32))
				)
					invalid();
				this.#catalog = await this.#currentCatalog();
				this.#extensions = (this.#options.extensions ?? []).filter(
					extension =>
						Array.isArray(input.extensions) &&
						input.extensions.includes(extension) &&
						this.#catalog!.sources.some(source => source.capabilities.includes(extension)),
				);
				const sources = this.#sources();
				yield this.#frame(
					{
						type: "hello",
						sources,
						capabilities: [...new Set(sources.flatMap(source => source.capabilities))],
						extensions: [...this.#extensions],
					},
					reply,
				);
				return;
			}
			if (!this.#catalog) throw new GraphWireError("unsupported_version", "Graph hello required");
			if (input.type === "subscribe") {
				if (
					!id(input.subscription_id) ||
					(input.mode !== "live" && input.mode !== "history") ||
					!scope(input.scope) ||
					!(input.resume === null || checkpoint(input.resume)) ||
					(input.mode === "history" && input.resume !== null)
				)
					invalid();
				const readScope = structuredClone(input.scope);
				await this.#authorize(readScope);
				const existing = this.#subscriptions.get(input.subscription_id);
				if (input.resume !== null) {
					if (
						!existing ||
						existing.mode !== input.mode ||
						canonicalJson(existing.scope) !== canonicalJson(readScope)
					)
						throw new GraphWireError("invalid_cursor", "No matching retained subscription");
					yield* this.#deliver(existing, input.resume, reply);
					return;
				}
				if (existing) {
					yield existing.session.invalidate("scope_changed");
					this.#subscriptions.delete(input.subscription_id);
				}
				if (this.#subscriptions.size >= this.#options.maxSubscriptions) invalid();
				const subscription: Subscription = {
					session: new GraphWireReadSession<unknown>(this.#ledger, {
						principal: null,
						subscription_id: input.subscription_id,
						mode: input.mode,
						scope: readScope,
						sources: this.#sources(readScope),
						extensions: this.#extensions,
						authorize: (_principal, requested) => this.#authorize(requested),
						page_size: this.#options.pageSize,
						now: () => this.#now(),
					}),
					scope: readScope,
					mode: input.mode,
					scopeId: null,
					expiresAt: 0,
				};
				this.#subscriptions.set(input.subscription_id, subscription);
				try {
					yield* this.#deliver(subscription, null, reply);
				} catch (error) {
					this.#subscriptions.delete(input.subscription_id);
					throw error;
				}
				return;
			}
			if (input.type === "unsubscribe") {
				if (!id(input.subscription_id)) invalid();
				const existing = this.#subscriptions.get(input.subscription_id);
				if (existing) {
					this.#subscriptions.delete(input.subscription_id);
					yield existing.session.invalidate("scope_changed");
				}
				return;
			}
			if (input.type === "graph.runs.list") {
				if (
					!id(input.source_id) ||
					!(input.graph_id === null || id(input.graph_id)) ||
					!(input.page_token === null || id(input.page_token)) ||
					!limit(input.limit)
				)
					invalid();
				const readScope = { graph_run_id: null, source_ids: [input.source_id] };
				await this.#authorize(readScope);
				this.#capability(input.source_id, "graph.runs.v1");
				const result = this.#queries.runs(input.source_id, {
					graphId: input.graph_id,
					pageToken: input.page_token,
					limit: input.limit,
					scopeKey: this.#scopeKey(readScope),
				});
				await this.#authorize(readScope);
				yield this.#frame({ type: "graph.runs", ...result }, reply);
				return;
			}
			if (input.type === "graph.history.get") {
				if (
					(input.view !== "state" && input.view !== "events") ||
					!(input.at === null || cursor(input.at)) ||
					!(input.after === null || cursor(input.after)) ||
					!object(input.filter) ||
					!(input.page_token === null || id(input.page_token)) ||
					!limit(input.limit)
				)
					invalid();
				const subscription = await this.#historyScope(input);
				const sourceId = input.source_id as string;
				const runId = input.graph_run_id as string;
				this.#capability(sourceId, "graph.history.v1");
				const source = this.#sources(subscription.scope).find(candidate => candidate.source_id === sourceId)!;
				const result = this.#queries.history(sourceId, runId, {
					view: input.view,
					at: input.at,
					after: input.after,
					filter: input.filter,
					pageToken: input.page_token,
					limit: input.limit,
					scopeKey: this.#scopeKey(subscription.scope),
					extensions: this.#extensions.filter(extension => source.capabilities.includes(extension)),
				});
				await this.#historyScope(input);
				yield this.#frame({ type: "graph.history", ...result }, reply);
				return;
			}
			if (input.type === "graph.artifact.get") {
				if (
					!id(input.source_id) ||
					!id(input.graph_run_id) ||
					!id(input.ref) ||
					input.page_token !== null ||
					!limit(input.limit)
				)
					invalid();
				const readScope = { graph_run_id: input.graph_run_id, source_ids: [input.source_id] };
				await this.#authorize(readScope);
				this.#capability(input.source_id, GRAPH_WIRE_EXECUTION_EXTENSION);
				const reader = input.ref.startsWith("consultation-message:")
					? this.#options.consultationDetails
					: (this.#options.artifactContents ?? this.#options.consultationDetails);
				if (!reader) throw new GraphWireError("capability_unavailable", "Protected reader unavailable");
				const result = await reader.read(input.source_id, input.graph_run_id, input.ref);
				await this.#authorize(readScope);
				yield this.#frame(
					{
						type: "graph.artifact",
						source_id: input.source_id,
						graph_run_id: input.graph_run_id,
						ref: input.ref,
						...result,
						next_page_token: null,
					},
					reply,
				);
				return;
			}
			// This connection has no command or authoring dispatcher, even for forged scopes/buttons.
			throw new GraphWireError("capability_unavailable", "Read-only Graph operation unavailable");
		} catch (error) {
			if (error instanceof GraphWireError && error.code === "scope_denied") yield* this.invalidate("revoked");
			yield this.#error(error, reply);
		} finally {
			this.#busy = false;
		}
	}

	/** Embedding calls at most 5s apart and awaits transport backpressure for every yielded frame. */
	async *poll(): AsyncGenerator<GraphWireReadFrame> {
		if (this.#closed) return;
		if (this.#busy) throw new GraphWireError("invalid_input", "Concurrent Graph delivery");
		this.#busy = true;
		try {
			for (const subscription of this.#subscriptions.values()) {
				if (subscription.mode === "history") continue;
				try {
					yield* this.#deliver(subscription, null, null);
				} catch (error) {
					if (error instanceof GraphWireError && error.code === "scope_denied") yield* this.invalidate("revoked");
					yield this.#error(error, null);
				}
			}
		} finally {
			this.#busy = false;
		}
	}

	/** Call immediately on authenticated transport revocation, including during an awaited recheck. */
	invalidate(reason: "revoked" | "expired" | "scope_changed" = "revoked"): GraphWireSourceFrame[] {
		this.#closed = true;
		const subscriptions = [...this.#subscriptions.values()];
		this.#subscriptions.clear();
		return subscriptions.map(subscription => subscription.session.invalidate(reason));
	}
}

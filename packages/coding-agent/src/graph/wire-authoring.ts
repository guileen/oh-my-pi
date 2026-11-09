import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import {
	GRAPH_WIRE_EXECUTION_EXTENSION,
	GRAPH_WIRE_PROTOCOL,
	GraphWireError,
	isGraphWireExecutionOperation,
	type GraphWireAuthor,
	type GraphWireAuthorResultFrame,
	type GraphWireDefinitionFrame,
	type GraphWireDefinitionGet,
	type GraphWireMutation,
	type GraphWireReconciliationFrame,
	type GraphWireRequestGet,
	validateGraphWireAuthoringRequest,
	validateGraphWireAuthorResultFrame,
	validateGraphWireDefinitionFrame,
	validateGraphWireReconciliationFrame,
} from "@oh-my-pi/pi-wire/graph";
import type { GraphAuthoringIntent, GraphAuthoringService, GraphOperation } from "./authoring";

export interface GraphWireAuthoringSource {
	source_id: string;
	/** Immutable server-owned identity of the deployment/profile, not its display name. */
	binding: string;
	definitions: GraphAuthoringService;
	capabilities: readonly string[];
}
export interface GraphWireAuthoringGrant {
	generation: string;
	source_binding: string;
	subscription_id: string;
	scope_id: string;
	mode: "live" | "history";
	source_ready: boolean;
	can_author: boolean;
	/** Independent of `can_author`: editing a definition never implies spending model budget. */
	can_execute: boolean;
	/** null is whole-source access; [] authorizes no existing Graph. */
	graph_ids: string[] | null;
	authorized_at: number;
	expires_at: number;
}
/** Host-supplied Run control. The bridge admits, never decides: idempotency, revision
 * comparison, authorization and the real start/lifecycle transition stay here. */
export interface GraphWireExecutionService {
	/** May await; the bridge serializes requests across the await and re-authorizes after it. */
	apply(
		principalId: string,
		sourceId: string,
		intentId: string,
		request: GraphWireMutation,
	): GraphOperation | Promise<GraphOperation>;
	/** Receipt lookup only. Never starts, resumes or mutates a Run. */
	reconcile(principalId: string, sourceId: string, intentId: string): GraphOperation | null;
}
export interface GraphWireAuthoringOptions {
	principal_id: string;
	sources: readonly GraphWireAuthoringSource[];
	/** Negotiated out of band; no incoming authoring frame can enable an extension. */
	extensions: readonly string[];
	/** Synchronous current permission/readiness check. Called again inside the write transaction.
	 * The embedding owns authentication, revocation and its source-ready barriers. */
	authorize(principalId: string, sourceId: string): GraphWireAuthoringGrant | null;
	/** Required for Run control. Absent means `capability_unavailable`, never an implicit allow. */
	execution?: GraphWireExecutionService;
	/** Synchronous, side-effect-free observation of an already-validated request, called before
	 * any authorization lookup. It lets a host correlate the frame's declared subscription id and
	 * scope id with the grant it is about to issue. It authorizes nothing: skipping, mutating or
	 * throwing here can only cause the subsequent grant check to deny. */
	observeRequest?: (request: unknown) => void;
	now?: () => number;
}
type FailureCode =
	| GraphWireError["code"]
	| "invalid_state"
	| "unknown_graph"
	| "unknown_request"
	| "source_changed"
	| "idempotency_conflict";
export interface GraphWireAuthoringFailure {
	code: FailureCode;
	message: string;
	retryable: boolean;
	details: { reason: "history_read_only" | "source_not_ready" } | null;
	reset_required: false;
}
export type GraphWireAuthoringFrame =
	| GraphWireDefinitionFrame
	| GraphWireAuthorResultFrame
	| GraphWireReconciliationFrame
	| {
			protocol: typeof GRAPH_WIRE_PROTOCOL;
			in_reply_to: string | null;
			type: "error";
			error: GraphWireAuthoringFailure;
	  };
class AuthoringFailure extends Error {
	constructor(
		readonly code: FailureCode,
		readonly reason: "history_read_only" | "source_not_ready" | null = null,
	) {
		super(code);
	}
}
function denied(): never {
	throw new AuthoringFailure("scope_denied");
}
const id = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
/** One receipt vocabulary for both ledgers: definition intents and Run control. */
const RECONCILE_STATE = {
	accepted: "admitted",
	completed: "applied",
	unknown: "unknown",
	rejected: "rejected",
} as const;

/** Explicit profile-local writer embedding, separate from the read-only observer. Source aliases
 * must share its durable intent ledger. Never authenticates a browser, starts jobs or installs a
 * listener. Transport must bound frames and never cache protected content. */
export class GraphWireAuthoringBridge {
	readonly #principal: string;
	readonly #sources: GraphWireAuthoringSource[];
	readonly #extensions: readonly string[];
	readonly #authorize: GraphWireAuthoringOptions["authorize"];
	readonly #execution: GraphWireExecutionService | null;
	readonly #observe: ((request: unknown) => void) | null;
	readonly #clock: () => number;
	#lastNow = -Infinity;
	#queue = 0;
	#tail: Promise<void> = Promise.resolve();
	#inside = false;
	readonly #deliveries = new WeakMap<object, () => void>();

	constructor(options: GraphWireAuthoringOptions) {
		if (
			!id(options.principal_id) ||
			!options.sources.length ||
			options.sources.length > 64 ||
			new Set(options.sources.map(source => source.source_id)).size !== options.sources.length ||
			new Set(options.sources.map(source => source.definitions.root)).size !== 1 ||
			options.sources.some(
				source => !id(source.source_id) || !id(source.binding) || !Array.isArray(source.capabilities),
			) ||
			!Array.isArray(options.extensions)
		)
			throw new GraphWireError("invalid_input", "Invalid trusted Graph authoring configuration");
		this.#principal = options.principal_id;
		this.#sources = options.sources.map(source => ({ ...source, capabilities: [...source.capabilities] }));
		this.#extensions = [...options.extensions];
		this.#authorize = options.authorize;
		this.#execution = options.execution ?? null;
		this.#observe = options.observeRequest ?? null;
		this.#clock = options.now ?? Date.now;
	}

	#grant(source: GraphWireAuthoringSource, previous?: GraphWireAuthoringGrant): GraphWireAuthoringGrant {
		if (
			!this.#extensions.includes(GRAPH_WIRE_EXECUTION_EXTENSION) ||
			!source.capabilities.includes(GRAPH_WIRE_EXECUTION_EXTENSION)
		)
			throw new AuthoringFailure("capability_unavailable");
		const clock = this.#clock;
		const now = clock();
		if (!Number.isFinite(now)) denied();
		this.#lastNow = Math.max(this.#lastNow, now);
		const authorize = this.#authorize;
		let grant: GraphWireAuthoringGrant | null = null;
		try {
			grant = structuredClone(authorize(this.#principal, source.source_id));
		} catch {
			denied();
		}
		const after = clock();
		if (!Number.isFinite(after)) denied();
		this.#lastNow = Math.max(this.#lastNow, after);
		if (
			!grant ||
			grant.source_binding !== source.binding ||
			!id(grant.generation) ||
			!id(grant.scope_id) ||
			!id(grant.subscription_id) ||
			!["live", "history"].includes(grant.mode) ||
			typeof grant.source_ready !== "boolean" ||
			typeof grant.can_author !== "boolean" ||
			typeof grant.can_execute !== "boolean" ||
			!Number.isFinite(grant.authorized_at) ||
			!Number.isFinite(grant.expires_at) ||
			grant.authorized_at > this.#lastNow ||
			grant.expires_at <= this.#lastNow ||
			grant.expires_at - grant.authorized_at > 60_000 ||
			!(
				grant.graph_ids === null ||
				(Array.isArray(grant.graph_ids) && grant.graph_ids.length <= 10_000 && grant.graph_ids.every(id))
			)
		)
			denied();
		if (
			previous &&
			(grant.generation !== previous.generation ||
				grant.scope_id !== previous.scope_id ||
				grant.subscription_id !== previous.subscription_id ||
				canonicalJson(grant.graph_ids) !== canonicalJson(previous.graph_ids))
		)
			denied();
		return grant;
	}
	#target(grant: GraphWireAuthoringGrant, graphId: string | null): void {
		if (grant.graph_ids !== null && (graphId === null || !grant.graph_ids.includes(graphId))) denied();
	}
	#admit(grant: GraphWireAuthoringGrant, permission: "author" | "execute"): void {
		if (permission === "execute" ? !grant.can_execute : !grant.can_author) denied();
		if (grant.mode !== "live") throw new AuthoringFailure("invalid_state", "history_read_only");
		if (!grant.source_ready) throw new AuthoringFailure("invalid_state", "source_not_ready");
	}
	#source(sourceId: string): GraphWireAuthoringSource {
		return this.#sources.find(source => source.source_id === sourceId) ?? denied();
	}

	/** Recheck immediately before a trusted transport hands a frame to its sink, after any
	 * asynchronous backpressure. Protected frames from another bridge are never deliverable here. */
	assertAuthorizedForDelivery(frame: GraphWireAuthoringFrame): void {
		if (frame.type === "error") return;
		const check = this.#deliveries.get(frame);
		if (!check) denied();
		check();
	}

	#protect<T extends GraphWireAuthoringFrame>(
		frame: T,
		source: GraphWireAuthoringSource,
		grant: GraphWireAuthoringGrant,
		targets: (string | null)[],
		permission: "read" | "author" | "execute",
	): T {
		this.#deliveries.set(frame, () => {
			const current = this.#grant(source, grant);
			for (const target of targets) this.#target(current, target);
			if (permission === "author" && !current.can_author) denied();
			if (permission === "execute" && !current.can_execute) denied();
			// A definition's editable flag must not survive a readiness/mode/permission change.
			if (
				frame.type === "graph.definition" &&
				(current.can_author !== grant.can_author ||
					current.mode !== grant.mode ||
					current.source_ready !== grant.source_ready)
			)
				denied();
		});
		return frame;
	}

	handle(value: unknown): GraphWireAuthoringFrame | Promise<GraphWireAuthoringFrame> {
		if (this.#inside) return this.#error(new AuthoringFailure("invalid_state"), null);
		let reply: string | null = null;
		try {
			validateGraphWireAuthoringRequest(value);
			const request = structuredClone(value);
			const messageId = request.message_id;
			reply = messageId;
			const control = request.type === "graph.author" && isGraphWireExecutionOperation(request.request.operation);
			if (this.#queue === 0 && !control) return this.#enter(request, messageId);
			return this.#enqueue(() => this.#enter(request, messageId));
		} catch (error) {
			return this.#error(error, reply);
		}
	}

	#enter(
		request: GraphWireDefinitionGet | GraphWireAuthor | GraphWireRequestGet,
		reply: string,
	): GraphWireAuthoringFrame | Promise<GraphWireAuthoringFrame> {
		this.#inside = true;
		try {
			return this.#dispatch(request, reply);
		} finally {
			this.#inside = false;
		}
	}

	/** One in-flight request at a time: a queued Run control cannot overlap a later request,
	 * and a definition read never overtakes an earlier execution. */
	#enqueue(task: () => GraphWireAuthoringFrame | Promise<GraphWireAuthoringFrame>): Promise<GraphWireAuthoringFrame> {
		this.#queue += 1;
		const settled = this.#tail.then(task);
		this.#tail = settled.then(
			() => {},
			() => {},
		);
		return settled.finally(() => {
			this.#queue -= 1;
		});
	}

	#dispatch(
		request: GraphWireDefinitionGet | GraphWireAuthor | GraphWireRequestGet,
		reply: string,
	): GraphWireAuthoringFrame | Promise<GraphWireAuthoringFrame> {
		try {
			// Observation precedes every authorization lookup so a host can correlate the frame's
			// declared subscription/scope with the grant it is about to issue. It grants nothing:
			// a throw here, or a skipped call, can only make the subsequent grant check deny.
			this.#observe?.(request);
			if (request.type === "request.get") return this.#reconcile(request.intent_id, reply);
			const source = this.#source(request.source_id);
			const grant = this.#grant(source);
			if (request.type === "graph.definition.get") {
				this.#target(grant, request.graph_id);
				const snapshot = source.definitions.get(request.graph_id, request.definition_revision ?? undefined);
				const current = this.#grant(source, grant);
				this.#target(current, request.graph_id);
				if (!snapshot) throw new AuthoringFailure("unknown_graph");
				const frame: GraphWireDefinitionFrame = {
					protocol: GRAPH_WIRE_PROTOCOL,
					type: "graph.definition",
					in_reply_to: reply,
					source_id: source.source_id,
					graph_id: snapshot.graph_id,
					definition_revision: snapshot.revision,
					format: "omp.graph/v1",
					content: snapshot.content,
					editable:
						current.can_author &&
						current.mode === "live" &&
						current.source_ready &&
						(request.definition_revision === null ||
							source.definitions.get(request.graph_id)?.revision === snapshot.revision),
				};
				validateGraphWireDefinitionFrame(frame);
				return this.#protect(frame, source, current, [request.graph_id], "read");
			}
			if (request.subscription_id !== grant.subscription_id || request.scope_id !== grant.scope_id) denied();
			this.#target(grant, request.request.target_id);
			const requested = request.request.operation;
			// Run control is admitted by #execute; every remaining operation is a definition mutation.
			if (isGraphWireExecutionOperation(requested)) return this.#execute(request, source, grant, reply);
			this.#admit(grant, "author");
			const retained = source.definitions.getIntent(this.#principal, request.intent_id);
			if (retained && retained.source_binding !== source.binding) throw new AuthoringFailure("source_changed");
			const intent: GraphAuthoringIntent = {
				principal_id: this.#principal,
				intent_id: request.intent_id,
				source_id: source.source_id,
				source_binding: source.binding,
				request: { ...request.request, operation: requested },
			};
			const operation = source.definitions.applyIntent(intent, () => {
				const current = this.#grant(source, grant);
				this.#target(current, request.request.target_id);
				this.#admit(current, "author");
			});
			const current = this.#grant(source, grant);
			if (!current.can_author) denied();
			this.#target(current, operation.target_id ?? request.request.target_id);
			const frame: GraphWireAuthorResultFrame = {
				protocol: GRAPH_WIRE_PROTOCOL,
				type: "graph.author.result",
				in_reply_to: reply,
				intent_id: request.intent_id,
				operation,
				error: null,
			};
			validateGraphWireAuthorResultFrame(frame);
			return this.#protect(
				frame,
				source,
				current,
				[request.request.target_id, operation.target_id ?? request.request.target_id],
				"author",
			);
		} catch (error) {
			return this.#error(error, reply);
		}
	}

	/** Run control lives outside the definition ledger: idempotency, revision comparison and the
	 * real transition belong to the injected host service. The bridge only admits and re-admits. */
	async #execute(
		request: GraphWireAuthor,
		source: GraphWireAuthoringSource,
		grant: GraphWireAuthoringGrant,
		reply: string,
	): Promise<GraphWireAuthoringFrame> {
		try {
			this.#admit(grant, "execute");
			const service = this.#execution;
			// Absent service means "cannot execute here", never an implicit allow.
			if (!service) throw new AuthoringFailure("capability_unavailable");
			const operation = await service.apply(
				this.#principal,
				source.source_id,
				request.intent_id,
				structuredClone(request.request),
			);
			// Re-authorize across the await: the grant may have been revoked while starting.
			const current = this.#grant(source, grant);
			this.#admit(current, "execute");
			this.#target(current, operation.target_id ?? request.request.target_id);
			const frame: GraphWireAuthorResultFrame = {
				protocol: GRAPH_WIRE_PROTOCOL,
				type: "graph.author.result",
				in_reply_to: reply,
				intent_id: request.intent_id,
				operation,
				error: null,
			};
			validateGraphWireAuthorResultFrame(frame);
			return this.#protect(
				frame,
				source,
				current,
				[request.request.target_id, operation.target_id ?? request.request.target_id],
				"execute",
			);
		} catch (error) {
			return this.#error(error, reply);
		}
	}

	#reconcile(intentId: string, reply: string): GraphWireAuthoringFrame {
		let found: {
			source: GraphWireAuthoringSource;
			intent: GraphAuthoringIntent;
			grant: GraphWireAuthoringGrant;
		} | null = null;
		let withheld: unknown;
		for (const source of this.#sources) {
			let grant: GraphWireAuthoringGrant;
			try {
				grant = this.#grant(source);
			} catch (error) {
				withheld ??= error;
				continue;
			}
			const intent = source.definitions.getIntent(this.#principal, intentId);
			if (!intent || intent.source_id !== source.source_id) continue;
			if (intent.source_binding !== source.binding) throw new AuthoringFailure("source_changed");
			if (found) denied();
			this.#target(grant, intent.request.target_id);
			if (!grant.can_author) denied();
			found = { source, intent, grant };
		}
		if (!found) {
			// A Run receipt may exist where no definition intent does; both keep one vocabulary.
			const execution = this.#execution;
			if (execution) {
				let receipt: { source: GraphWireAuthoringSource; operation: GraphOperation } | null = null;
				for (const source of this.#sources) {
					let grant: GraphWireAuthoringGrant;
					try {
						grant = this.#grant(source);
					} catch (error) {
						withheld ??= error;
						continue;
					}
					// Receipt lookup only; a missing execute grant cannot read another principal's Run.
					if (!grant.can_execute) continue;
					const operation = execution.reconcile(this.#principal, source.source_id, intentId);
					if (!operation) continue;
					if (receipt) denied();
					this.#target(grant, operation.target_id);
					receipt = { source, operation };
				}
				if (receipt) {
					const { source, operation } = receipt;
					// Mirrors the definition path: no live/ready gate on a read-only reconciliation.
					const current = this.#grant(source);
					if (!current.can_execute) denied();
					this.#target(current, operation.target_id);
					const frame: GraphWireReconciliationFrame = {
						protocol: GRAPH_WIRE_PROTOCOL,
						type: "operation",
						in_reply_to: reply,
						intent_id: intentId,
						state: RECONCILE_STATE[operation.state],
						receipt: null,
						result: null,
						error: null,
						graph_operation: operation,
					};
					validateGraphWireReconciliationFrame(frame);
					return this.#protect(frame, source, current, [operation.target_id], "execute");
				}
			}
			if (withheld) throw withheld;
			throw new AuthoringFailure("unknown_request");
		}
		const { source, intent, grant } = found;
		// Deliberately read-only while unready/history: never invoke applyIntent or mutate here.
		const operation = source.definitions.getIntentOperation(this.#principal, intentId);
		const current = this.#grant(source, grant);
		if (!current.can_author) denied();
		this.#target(current, intent.request.target_id);
		if (!operation) throw new AuthoringFailure("unknown_request");
		this.#target(current, operation.target_id ?? intent.request.target_id);
		const frame: GraphWireReconciliationFrame = {
			protocol: GRAPH_WIRE_PROTOCOL,
			type: "operation",
			in_reply_to: reply,
			intent_id: intentId,
			state: RECONCILE_STATE[operation.state],
			receipt: null,
			result: null,
			error: null,
			graph_operation: operation,
		};
		validateGraphWireReconciliationFrame(frame);
		return this.#protect(
			frame,
			source,
			current,
			[intent.request.target_id, operation.target_id ?? intent.request.target_id],
			"author",
		);
	}

	#error(error: unknown, reply: string | null): GraphWireAuthoringFrame {
		let code: FailureCode =
			error instanceof AuthoringFailure || error instanceof GraphWireError ? error.code : "capability_unavailable";
		if (error instanceof Error && "code" in error && error.code === "idempotency_conflict")
			code = "idempotency_conflict";
		return {
			protocol: GRAPH_WIRE_PROTOCOL,
			type: "error",
			in_reply_to: reply,
			error: {
				code,
				message:
					"Graph authoring request was not authorized or could not be completed; reconcile the original intent before retrying.",
				retryable: false,
				details: error instanceof AuthoringFailure && error.reason ? { reason: error.reason } : null,
				reset_required: false,
			},
		};
	}
}

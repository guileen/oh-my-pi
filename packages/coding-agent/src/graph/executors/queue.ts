import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";

export interface QueueExecutionRequest {
	version: 1;
	run_id: string;
	invocation_id: string;
	attempt_id: string;
	fence: string;
	request_key: string;
	executor: string;
	inputs: Record<string, GraphRef | string>;
	task_ref: GraphRef;
	authorization_ref: GraphRef;
	model_binding_ref: null;
	base_snapshot_ref: null;
	duty: string;
	deadline: string | null;
}

export type QueueState =
	| "submitting"
	| "accepted"
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelling"
	| "cancelled"
	| "unknown";
export interface QueueCapabilities {
	submit_idempotent: boolean;
	lookup_by_key: boolean;
	cancel: boolean;
}
export interface QueueIdentity {
	service_id: string;
	attempt_id: string;
	fence: string;
	request_key: string;
}
export interface QueueObservation extends QueueIdentity {
	external_task_id: string | null;
	state: Exclude<QueueState, "submitting">;
	result_refs: GraphRef[];
	observed_at: string;
}
export interface QueueRecord extends Omit<QueueObservation, "state"> {
	request: QueueExecutionRequest;
	state: QueueState;
}
export type QueueLookup =
	| { status: "found"; observation: QueueObservation }
	| { status: "not_found" }
	| { status: "unknown" };

/** A configured, trusted service protocol implementation, not an embedded queue. */
export interface QueueServiceClient {
	readonly service_id: string;
	readonly capabilities: QueueCapabilities;
	submit(request: QueueExecutionRequest): Promise<QueueObservation>;
	query(identity: QueueIdentity & { external_task_id: string | null }): Promise<QueueLookup>;
	cancel(identity: QueueIdentity & { external_task_id: string | null }): Promise<QueueObservation>;
}

/** Transactions must be durable and serialized per request key, including across host restarts.
 * The host must authorize dispatch and check its current fence before invoking adapter methods.
 * Quarantine retains uncorrelated and stale evidence without advancing a graph.
 */
export interface QueueStateStore {
	transact<T>(
		requestKey: string,
		update: (record: QueueRecord | null) => { record: QueueRecord | null; value: T },
	): Promise<T>;
	quarantine(observation: QueueObservation, reason: string): Promise<void>;
}
export type QueueUpdate = {
	disposition: "applied" | "duplicate" | "ignored" | "stale" | "unmatched";
	record: QueueRecord | null;
};

const terminal = (state: QueueState) => state === "succeeded" || state === "failed" || state === "cancelled";
const sameIdentity = (a: QueueIdentity, b: QueueIdentity) =>
	a.service_id === b.service_id &&
	a.attempt_id === b.attempt_id &&
	a.fence === b.fence &&
	a.request_key === b.request_key;
const identity = (record: QueueRecord) => ({
	service_id: record.service_id,
	attempt_id: record.attempt_id,
	fence: record.fence,
	request_key: record.request_key,
	external_task_id: record.external_task_id,
});

/** Correlate both the durable service identity and its original execution envelope. */
export function queueRecordMatchesExecution(
	record: QueueRecord,
	execution: Pick<QueueExecutionRequest, "run_id" | "invocation_id" | "attempt_id" | "fence" | "request_key">,
	executor: string | undefined,
): boolean {
	return !!(
		record.service_id &&
		record.attempt_id === execution.attempt_id &&
		record.fence === execution.fence &&
		record.request_key === execution.request_key &&
		record.request?.run_id === execution.run_id &&
		record.request.invocation_id === execution.invocation_id &&
		record.request.attempt_id === execution.attempt_id &&
		record.request.fence === execution.fence &&
		record.request.request_key === execution.request_key &&
		executor &&
		record.request.executor === executor
	);
}

export class QueueAdapter {
	constructor(
		private readonly client: QueueServiceClient,
		private readonly store: QueueStateStore,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	/** Read durable intent without creating or submitting a request. */
	async get(requestKey: string): Promise<QueueRecord | null> {
		return this.store.transact(requestKey, record => {
			if (record && record.service_id !== this.client.service_id) throw new Error("queue service mismatch");
			return { record, value: record };
		});
	}

	/** Atomically records intent before the first side effect. Repeated calls never submit. */
	async submit(request: QueueExecutionRequest): Promise<QueueRecord> {
		const initial: QueueRecord = {
			service_id: this.client.service_id,
			attempt_id: request.attempt_id,
			fence: request.fence,
			request_key: request.request_key,
			external_task_id: null,
			state: "submitting",
			result_refs: [],
			observed_at: this.now(),
			request,
		};
		const claim = await this.store.transact(request.request_key, record => {
			if (record) {
				if (!sameIdentity(record, initial) || canonicalJson(record.request) !== canonicalJson(request))
					throw new Error("queue request key conflict");
				return { record, value: { record, created: false } };
			}
			return { record: initial, value: { record: initial, created: true } };
		});
		if (!claim.created) return claim.record;
		return this.#send(claim.record);
	}

	/** Reconcile first. Only an authoritative absence plus idempotent submission permits a retry. */
	async reconcile(requestKey: string, beforeRetry?: () => Promise<void>): Promise<QueueRecord> {
		const record = await this.#get(requestKey);
		if (terminal(record.state)) return record;
		if (!record.external_task_id && !this.client.capabilities.lookup_by_key) return this.#uncertain(record);
		let lookup: QueueLookup;
		try {
			lookup = await this.client.query(identity(record));
		} catch {
			return this.#uncertain(record);
		}
		if (lookup.status === "found") {
			const update = await this.observe(lookup.observation, record);
			return update.disposition === "unmatched" || update.disposition === "stale"
				? this.#uncertain(record)
				: update.record!;
		}
		if (
			lookup.status === "not_found" &&
			!record.external_task_id &&
			this.client.capabilities.submit_idempotent &&
			record.state !== "cancelling"
		) {
			await beforeRetry?.();
			return this.#send(record);
		}
		return this.#uncertain(record);
	}

	/** A cancel request is not proof of remote cancellation. */
	async cancel(requestKey: string): Promise<QueueRecord> {
		let record = await this.store.transact(requestKey, current => {
			if (!current || current.service_id !== this.client.service_id) throw new Error("unknown queue request");
			const next: QueueRecord = terminal(current.state)
				? current
				: { ...current, state: "cancelling", observed_at: this.now() };
			return { record: next, value: next };
		});
		if (terminal(record.state) || !this.client.capabilities.cancel) return record;
		try {
			const observation = await this.client.cancel(identity(record));
			const update = await this.observe(observation, record);
			record = update.record ?? record;
		} catch {
			/* The durable cancelling intent remains pending reconciliation. */
		}
		return record;
	}

	/** The caller supplies the current authorized identity, independently of the notification. */
	async observe(observation: QueueObservation, current: QueueIdentity): Promise<QueueUpdate> {
		if (observation.service_id !== this.client.service_id || !sameIdentity(observation, current)) {
			await this.store.quarantine(observation, "stale or untrusted identity");
			return { disposition: "stale", record: null };
		}
		const update = await this.store.transact(observation.request_key, record => {
			if (
				!record ||
				!sameIdentity(record, observation) ||
				(record.external_task_id !== null && record.external_task_id !== observation.external_task_id)
			) {
				return { record, value: { disposition: "unmatched", record } as QueueUpdate };
			}
			if (terminal(record.state)) {
				const duplicate =
					record.state === observation.state &&
					JSON.stringify(record.result_refs) === JSON.stringify(observation.result_refs);
				return { record, value: { disposition: duplicate ? "duplicate" : "unmatched", record } as QueueUpdate };
			}
			if (
				(record.state === "running" && (observation.state === "accepted" || observation.state === "queued")) ||
				(record.state === "queued" && observation.state === "accepted")
			) {
				return { record, value: { disposition: "ignored", record } as QueueUpdate };
			}
			// A remote nonterminal response cannot undo a pending cancellation.
			const state = record.state === "cancelling" && !terminal(observation.state) ? "cancelling" : observation.state;
			const next: QueueRecord = {
				...record,
				...observation,
				state,
				external_task_id: observation.external_task_id ?? record.external_task_id,
			};
			return { record: next, value: { disposition: "applied", record: next } as QueueUpdate };
		});
		if (update.disposition === "unmatched")
			await this.store.quarantine(observation, "unknown request or external task");
		return update;
	}

	async #get(requestKey: string): Promise<QueueRecord> {
		return this.store.transact(requestKey, record => {
			if (!record || record.service_id !== this.client.service_id) throw new Error("unknown queue request");
			return { record, value: record };
		});
	}
	async #uncertain(record: QueueRecord): Promise<QueueRecord> {
		return this.store.transact(record.request_key, current => {
			if (!current || !sameIdentity(current, record)) throw new Error("queue request changed");
			// A failed, older operation must not erase evidence recorded while it was in flight.
			const next: QueueRecord =
				terminal(current.state) ||
				current.state === "cancelling" ||
				canonicalJson(current) !== canonicalJson(record)
					? current
					: { ...current, state: "unknown", observed_at: this.now() };
			return { record: next, value: next };
		});
	}
	async #send(record: QueueRecord): Promise<QueueRecord> {
		const current = await this.#get(record.request_key);
		if (
			!sameIdentity(current, record) ||
			terminal(current.state) ||
			current.state === "cancelling" ||
			current.external_task_id !== null
		)
			return current;
		try {
			const observation = await this.client.submit(record.request);
			const update = await this.observe(observation, record);
			return update.disposition === "unmatched" || update.disposition === "stale"
				? this.#uncertain(record)
				: update.record!;
		} catch {
			return this.#uncertain(record);
		}
	}
}

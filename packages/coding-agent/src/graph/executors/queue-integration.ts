import {
	QueueAdapter,
	type QueueCapabilities,
	type QueueIdentity,
	type QueueObservation,
	type QueueServiceClient,
	type QueueStateStore,
	type QueueUpdate,
} from "./queue";

/** Trusted service-specific code verifies the original bytes and maps its own callback format. */
export interface QueueCallbackProtocol {
	verify(body: Uint8Array, headers: Headers): Promise<boolean>;
	decode(body: Uint8Array, headers: Headers): Promise<unknown>;
}

export interface QueueIntegrationOptions {
	client: QueueServiceClient;
	store: QueueStateStore;
	callback: QueueCallbackProtocol;
	/** Resolve from current host-authorized run state, not from callback claims. */
	resolveCurrent(observation: QueueObservation): Promise<QueueIdentity | null>;
	maxCallbackBytes?: number;
}

function parseObservation(value: unknown): QueueObservation {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid queue observation");
	const item = value as Record<string, unknown>;
	const states = ["accepted", "queued", "running", "succeeded", "failed", "cancelling", "cancelled", "unknown"];
	if (
		![item.service_id, item.attempt_id, item.fence, item.request_key, item.observed_at].every(
			v => typeof v === "string" && v.length > 0,
		) ||
		(item.external_task_id !== null && (typeof item.external_task_id !== "string" || !item.external_task_id)) ||
		typeof item.state !== "string" ||
		!states.includes(item.state) ||
		!Array.isArray(item.result_refs) ||
		!item.result_refs.every((ref: unknown) => {
			if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
			const r = ref as Record<string, unknown>;
			return typeof r.id === "string" && !!r.id && typeof r.digest === "string" && !!r.digest;
		})
	)
		throw new Error("Invalid queue observation");
	return {
		service_id: item.service_id as string,
		attempt_id: item.attempt_id as string,
		fence: item.fence as string,
		request_key: item.request_key as string,
		external_task_id: item.external_task_id as string | null,
		state: item.state as QueueObservation["state"],
		result_refs: item.result_refs as QueueObservation["result_refs"],
		observed_at: item.observed_at as string,
	};
}

/** Install only from host-owned configuration. No Graph input can register a service or verifier. */
export class QueueIntegration {
	readonly adapter: QueueAdapter;
	readonly serviceId: string;
	readonly capabilities: Readonly<QueueCapabilities>;
	readonly #options: QueueIntegrationOptions;
	readonly #maxBytes: number;

	constructor(options: QueueIntegrationOptions) {
		const { client, callback } = options;
		if (
			!client.service_id ||
			!client.capabilities ||
			![client.capabilities.submit_idempotent, client.capabilities.lookup_by_key, client.capabilities.cancel].every(
				value => typeof value === "boolean",
			) ||
			typeof client.submit !== "function" ||
			typeof client.query !== "function" ||
			typeof client.cancel !== "function" ||
			typeof callback?.verify !== "function" ||
			typeof callback.decode !== "function" ||
			typeof options.resolveCurrent !== "function"
		)
			throw new Error("Invalid trusted queue integration");
		const maxBytes = options.maxCallbackBytes ?? 1024 * 1024;
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
			throw new Error("Invalid queue callback size limit");
		this.#options = options;
		this.#maxBytes = maxBytes;
		this.serviceId = client.service_id;
		this.capabilities = Object.freeze({ ...client.capabilities });
		this.adapter = new QueueAdapter(
			{
				service_id: this.serviceId,
				capabilities: this.capabilities,
				async submit(request) {
					return parseObservation(await client.submit(request));
				},
				async query(identity) {
					const result = await client.query(identity);
					if (result?.status === "found")
						return { status: "found", observation: parseObservation(result.observation) };
					if (result?.status === "not_found" || result?.status === "unknown") return { status: result.status };
					throw new Error("Invalid queue lookup");
				},
				async cancel(identity) {
					return parseObservation(await client.cancel(identity));
				},
			},
			options.store,
		);
	}

	/** Authentication precedes decoding, identity resolution and any durable mutation. */
	async acceptCallback(body: Uint8Array, headers: Headers): Promise<QueueUpdate> {
		if (body.byteLength > this.#maxBytes) throw new Error("Queue callback body too large");
		const authenticatedBody = body.slice();
		const authenticatedHeaders = new Headers(headers);
		if ((await this.#options.callback.verify(authenticatedBody.slice(), new Headers(authenticatedHeaders))) !== true)
			throw new Error("Queue callback authentication failed");
		const observation = parseObservation(
			await this.#options.callback.decode(authenticatedBody, authenticatedHeaders),
		);
		const current = await this.#options.resolveCurrent(structuredClone(observation));
		if (!current) {
			await this.#options.store.quarantine(observation, "no current authorized queue attempt");
			return { disposition: "unmatched", record: null };
		}
		return this.adapter.observe(observation, current);
	}
}

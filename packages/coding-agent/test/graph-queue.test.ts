import { describe, expect, it } from "bun:test";
import {
	QueueAdapter,
	type QueueExecutionRequest,
	type QueueIdentity,
	type QueueLookup,
	type QueueObservation,
	type QueueRecord,
	type QueueServiceClient,
	type QueueStateStore,
} from "../src/graph/executors/queue";

const request: QueueExecutionRequest = {
	version: 1,
	run_id: "run",
	invocation_id: "invocation",
	attempt_id: "attempt",
	fence: "1",
	request_key: "key",
	executor: "video",
	inputs: {},
	task_ref: { id: "task", digest: "sha" },
	authorization_ref: { id: "auth", digest: "sha" },
	model_binding_ref: null,
	base_snapshot_ref: null,
	duty: "general",
	deadline: null,
};
const id: QueueIdentity = { service_id: "service", attempt_id: "attempt", fence: "1", request_key: "key" };
const observation = (state: QueueObservation["state"], changes: Partial<QueueObservation> = {}): QueueObservation => ({
	...id,
	external_task_id: "remote",
	state,
	result_refs: [],
	observed_at: "now",
	...changes,
});

class MemoryStore implements QueueStateStore {
	records = new Map<string, QueueRecord>();
	quarantined: QueueObservation[] = [];
	async transact<T>(
		key: string,
		update: (record: QueueRecord | null) => { record: QueueRecord | null; value: T },
	): Promise<T> {
		const result = update(this.records.get(key) ?? null);
		if (result.record) this.records.set(key, result.record);
		else this.records.delete(key);
		return result.value;
	}
	async quarantine(item: QueueObservation): Promise<void> {
		this.quarantined.push(item);
	}
}

class Client implements QueueServiceClient {
	service_id = "service";
	capabilities = { submit_idempotent: true, lookup_by_key: true, cancel: true };
	submissions: QueueExecutionRequest[] = [];
	queries: (QueueIdentity & { external_task_id: string | null })[] = [];
	cancellations: (QueueIdentity & { external_task_id: string | null })[] = [];
	submitResult: QueueObservation | Error = observation("accepted");
	queryResult: QueueLookup | Error = { status: "unknown" };
	cancelResult: QueueObservation | Error = observation("cancelling");
	async submit(value: QueueExecutionRequest): Promise<QueueObservation> {
		this.submissions.push(value);
		if (this.submitResult instanceof Error) throw this.submitResult;
		return this.submitResult;
	}
	async query(value: QueueIdentity & { external_task_id: string | null }): Promise<QueueLookup> {
		this.queries.push(value);
		if (this.queryResult instanceof Error) throw this.queryResult;
		return this.queryResult;
	}
	async cancel(value: QueueIdentity & { external_task_id: string | null }): Promise<QueueObservation> {
		this.cancellations.push(value);
		if (this.cancelResult instanceof Error) throw this.cancelResult;
		return this.cancelResult;
	}
}

function setup() {
	const client = new Client();
	const store = new MemoryStore();
	const adapter = new QueueAdapter(client, store, () => "now");
	return { client, store, adapter };
}

describe("external queue adapter", () => {
	it("persists intent before calling the service and never resubmits a repeated request", async () => {
		const { adapter, store, client } = setup();
		const submit = client.submit.bind(client);
		client.submit = async value => {
			expect(store.records.get("key")?.state).toBe("submitting");
			return submit(value);
		};
		expect((await adapter.submit(request)).state).toBe("accepted");
		expect((await adapter.submit(request)).external_task_id).toBe("remote");
		expect(client.submissions).toHaveLength(1);
		await expect(adapter.submit({ ...request, inputs: { different: "value" } })).rejects.toThrow("conflict");
	});

	it("preserves a running observation when earlier states arrive late", async () => {
		const { adapter, store } = setup();
		await adapter.submit(request);
		const running = observation("running", { result_refs: [{ id: "partial", digest: "sha" }], observed_at: "later" });
		expect((await adapter.observe(running, id)).disposition).toBe("applied");
		expect((await adapter.observe(observation("accepted"), id)).disposition).toBe("ignored");
		expect((await adapter.observe(observation("queued"), id)).disposition).toBe("ignored");
		expect(store.records.get("key")).toMatchObject(running);
	});

	it("recognizes equivalent request objects regardless of property order", async () => {
		const { adapter, client } = setup();
		await adapter.submit(request);
		await adapter.submit({ ...request, task_ref: { digest: "sha", id: "task" } });
		expect(client.submissions).toHaveLength(1);
	});

	it("reconciles a lost receipt by the original key without another submission, including after restart", async () => {
		const { adapter, store, client } = setup();
		client.submitResult = new Error("receipt lost");
		expect((await adapter.submit(request)).state).toBe("unknown");
		client.queryResult = { status: "found", observation: observation("running") };
		const restarted = new QueueAdapter(client, store, () => "later");
		expect((await restarted.reconcile("key")).state).toBe("running");
		expect(client.queries[0]).toEqual({ ...id, external_task_id: null });
		expect(client.submissions).toHaveLength(1);
	});

	it("only retries after authoritative absence with supported idempotence", async () => {
		const { adapter, client } = setup();
		client.submitResult = new Error("lost");
		await adapter.submit(request);
		client.queryResult = { status: "not_found" };
		client.capabilities.submit_idempotent = false;
		expect((await adapter.reconcile("key")).state).toBe("unknown");
		expect(client.submissions).toHaveLength(1);
		client.capabilities.submit_idempotent = true;
		client.submitResult = observation("queued");
		expect((await adapter.reconcile("key")).state).toBe("queued");
		expect(client.submissions).toEqual([request, request]);
		expect(client.queries).toHaveLength(2);
	});

	it("rechecks host authorization after lookup and before an idempotent retry", async () => {
		const { adapter, client } = setup();
		client.submitResult = new Error("lost");
		await adapter.submit(request);
		client.queryResult = { status: "not_found" };
		await expect(
			adapter.reconcile("key", async () => {
				throw new Error("authorization revoked");
			}),
		).rejects.toThrow("authorization revoked");
		expect(client.submissions).toHaveLength(1);
		expect((await adapter.get("key"))?.state).toBe("unknown");
	});

	it("does not blindly retry without query, or when query is uncertain", async () => {
		const { adapter, client } = setup();
		client.submitResult = new Error("lost");
		await adapter.submit(request);
		client.capabilities.lookup_by_key = false;
		expect((await adapter.reconcile("key")).state).toBe("unknown");
		expect(client.queries).toHaveLength(0);
		client.capabilities.lookup_by_key = true;
		client.queryResult = new Error("offline");
		expect((await adapter.reconcile("key")).state).toBe("unknown");
		expect(client.submissions).toHaveLength(1);
	});

	it("preserves a newer callback when an older reconciliation fails", async () => {
		const { adapter, client } = setup();
		await adapter.submit(request);
		const querying = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<QueueLookup>();
		client.query = async () => {
			querying.resolve();
			return reply.promise;
		};
		const reconciliation = adapter.reconcile("key");
		await querying.promise;
		const running = observation("running", { observed_at: "later" });
		await adapter.observe(running, id);
		reply.reject(new Error("query failed"));
		expect(await reconciliation).toMatchObject(running);
		expect(await adapter.get("key")).toMatchObject(running);
	});

	it("preserves a newer callback when the submission receipt is lost", async () => {
		const { adapter, client } = setup();
		const submitting = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<QueueObservation>();
		client.submit = async () => {
			submitting.resolve();
			return reply.promise;
		};
		const submission = adapter.submit(request);
		await submitting.promise;
		const running = observation("running", { observed_at: "later" });
		await adapter.observe(running, id);
		reply.reject(new Error("receipt lost"));
		expect(await submission).toMatchObject(running);
		expect(await adapter.get("key")).toMatchObject(running);
	});

	it("deduplicates completions and quarantines stale, conflicting, and untrusted notices", async () => {
		const { adapter, store } = setup();
		await adapter.submit(request);
		const done = observation("succeeded", { result_refs: [{ id: "output", digest: "digest" }] });
		expect((await adapter.observe(done, { ...id, fence: "2" })).disposition).toBe("stale");
		expect((await adapter.observe({ ...done, service_id: "other" }, id)).disposition).toBe("stale");
		expect((await adapter.observe(done, id)).disposition).toBe("applied");
		expect((await adapter.observe(done, id)).disposition).toBe("duplicate");
		expect((await adapter.observe(observation("failed"), id)).disposition).toBe("unmatched");
		expect(store.quarantined).toHaveLength(3);
		expect(store.records.get("key")?.state).toBe("succeeded");
	});

	it("retains cancellation until the remote service confirms it, and retains later completion", async () => {
		const { adapter, client } = setup();
		await adapter.submit(request);
		client.cancelResult = new Error("offline");
		expect((await adapter.cancel("key")).state).toBe("cancelling");
		expect(client.cancellations[0]).toEqual({ ...id, external_task_id: "remote" });
		client.queryResult = { status: "found", observation: observation("running") };
		expect((await adapter.reconcile("key")).state).toBe("cancelling");
		client.queryResult = {
			status: "found",
			observation: observation("succeeded", { result_refs: [{ id: "late", digest: "sha" }] }),
		};
		const result = await adapter.reconcile("key");
		expect(result.state).toBe("succeeded");
		expect(result.result_refs[0].id).toBe("late");
	});

	it("never invents cancellation when the service lacks support", async () => {
		const { adapter, client } = setup();
		await adapter.submit(request);
		client.capabilities.cancel = false;
		expect((await adapter.cancel("key")).state).toBe("cancelling");
		expect(client.cancellations).toHaveLength(0);
	});
	it("records cancellation only when the service confirms it", async () => {
		const { adapter, client } = setup();
		await adapter.submit(request);
		client.cancelResult = observation("cancelled");
		expect((await adapter.cancel("key")).state).toBe("cancelled");
		expect(client.cancellations[0].external_task_id).toBe("remote");
	});
});

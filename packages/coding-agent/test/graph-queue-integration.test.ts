import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS } from "../src/graph/cli";
import { QueueIntegration } from "../src/graph/executors/queue-integration";
import type {
	QueueExecutionRequest,
	QueueIdentity,
	QueueObservation,
	QueueServiceClient,
} from "../src/graph/executors/queue";
import { GraphRunStore } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function newStore() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-queue-integration-"));
	roots.push(root);
	return { root, store: new GraphRunStore(GRAPH_CLI_LIMITS, root) };
}

const secret = Buffer.alloc(32, 7);
const request = (key: string): QueueExecutionRequest => ({
	version: 1,
	run_id: `run-${key}`,
	invocation_id: `invocation-${key}`,
	attempt_id: `attempt-${key}`,
	fence: "1",
	request_key: key,
	executor: "queue",
	inputs: {},
	task_ref: { id: "task", digest: "hash" },
	authorization_ref: { id: "auth", digest: "hash" },
	model_binding_ref: null,
	base_snapshot_ref: null,
	duty: "general",
	deadline: null,
});
const observation = (r: QueueExecutionRequest, state: QueueObservation["state"]): QueueObservation => ({
	service_id: "service",
	attempt_id: r.attempt_id,
	fence: r.fence,
	request_key: r.request_key,
	external_task_id: `task-${r.request_key}`,
	state,
	result_refs: [],
	observed_at: "now",
});

function setup(verifyOverride?: () => boolean, resolveOverride?: (item: QueueObservation) => QueueIdentity | null) {
	const { root, store } = newStore();
	const db = new Database(path.join(root, "graphs.sqlite"));
	const current = new Map<string, QueueIdentity>();
	const client: QueueServiceClient = {
		service_id: "service",
		capabilities: { submit_idempotent: false, lookup_by_key: false, cancel: false },
		async submit(r) {
			return observation(r, "accepted");
		},
		async query() {
			return { status: "unknown" };
		},
		async cancel() {
			throw new Error("not supported");
		},
	};
	const integration = new QueueIntegration({
		client,
		store,
		callback: {
			async verify(body, headers) {
				if (verifyOverride) return verifyOverride();
				const actual = Buffer.from(headers.get("signature") ?? "", "hex");
				const expected = createHmac("sha256", secret).update(body).digest();
				return actual.length === expected.length && timingSafeEqual(actual, expected);
			},
			async decode(body) {
				return JSON.parse(new TextDecoder().decode(body));
			},
		},
		async resolveCurrent(item) {
			return resolveOverride ? resolveOverride(item) : (current.get(item.request_key) ?? null);
		},
	});
	return { db, store, current, integration };
}

function signed(item: unknown): [Uint8Array, Headers] {
	const body = new TextEncoder().encode(JSON.stringify(item));
	return [body, new Headers({ signature: createHmac("sha256", secret).update(body).digest("hex") })];
}

describe("queue service integration", () => {
	it("persists independent shared-service requests and authenticates, fences and deduplicates callbacks", async () => {
		const { db, store, current, integration } = setup();
		const a = request("a"),
			b = request("b");
		for (const r of [a, b]) {
			const item = observation(r, "succeeded");
			current.set(r.request_key, item);
			await integration.adapter.submit(r);
		}
		const aResult = observation(a, "succeeded");
		expect((await integration.acceptCallback(...signed(aResult))).disposition).toBe("applied");
		expect((await integration.acceptCallback(...signed(aResult))).disposition).toBe("duplicate");
		expect((await integration.adapter.submit(b)).state).toBe("accepted");
		expect(
			(await integration.acceptCallback(...signed({ ...observation(b, "succeeded"), fence: "old" }))).disposition,
		).toBe("stale");
		expect((await integration.adapter.submit(b)).state).toBe("accepted");
		const count = db.query("SELECT count(*) AS count FROM graph_queue_quarantine").get() as { count: number };
		expect(count.count).toBe(1);
		db.close();
		store.close();
	});

	it("rejects tampering and invalid payloads without changing state", async () => {
		const { db, store, integration } = setup();
		const r = request("x");
		await integration.adapter.submit(r);
		const [body, headers] = signed(observation(r, "succeeded"));
		body[0] ^= 1;
		await expect(integration.acceptCallback(body, headers)).rejects.toThrow("authentication");
		await expect(
			integration.acceptCallback(...signed({ ...observation(r, "succeeded"), result_refs: [null] })),
		).rejects.toThrow("observation");
		expect((await integration.adapter.submit(r)).state).toBe("accepted");
		db.close();
		store.close();
	});
	it("rejects non-boolean callback authentication before decoding", async () => {
		const { db, store, integration } = setup(() => "allow" as unknown as boolean);
		await expect(integration.acceptCallback(new TextEncoder().encode("not json"), new Headers())).rejects.toThrow(
			"authentication",
		);
		db.close();
		store.close();
	});

	it("persists authenticated callback facts even when authorization mutates its observation argument", async () => {
		const r = request("mutable-policy");
		const { db, store, integration } = setup(undefined, item => {
			item.state = "succeeded";
			item.result_refs.push({ id: "unverified", digest: "unverified" });
			return observation(r, "queued");
		});
		try {
			await integration.adapter.submit(r);
			const updated = await integration.acceptCallback(...signed(observation(r, "queued")));
			expect(updated.disposition).toBe("applied");
			expect(updated.record?.state).toBe("queued");
			expect(updated.record?.result_refs).toEqual([]);
			expect((await integration.adapter.submit(r)).state).toBe("queued");
		} finally {
			db.close();
			store.close();
		}
	});

	it("quarantines authenticated callbacks without a current authorized attempt", async () => {
		const { db, store, integration } = setup();
		const r = request("orphan");
		expect((await integration.acceptCallback(...signed(observation(r, "succeeded")))).disposition).toBe("unmatched");
		const count = db.query("SELECT count(*) AS count FROM graph_queue_quarantine").get() as { count: number };
		expect(count.count).toBe(1);
		db.close();
		store.close();
	});

	it("retains an uncertain submission across store recreation without unsafe retry", async () => {
		const { root, store } = newStore();
		let submissions = 0;
		const client: QueueServiceClient = {
			service_id: "service",
			capabilities: { submit_idempotent: false, lookup_by_key: false, cancel: false },
			async submit() {
				submissions++;
				throw new Error("response lost");
			},
			async query() {
				throw new Error("no lookup");
			},
			async cancel() {
				throw new Error("no cancellation");
			},
		};
		const callback = {
			async verify() {
				return false;
			},
			async decode() {
				return null;
			},
		};
		const options = {
			client,
			store,
			callback,
			async resolveCurrent() {
				return null;
			},
		};
		const first = new QueueIntegration(options);
		expect((await first.adapter.submit(request("lost"))).state).toBe("unknown");
		store.close();
		const reopened = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		const restarted = new QueueIntegration({ ...options, store: reopened });
		expect((await restarted.adapter.reconcile("lost")).state).toBe("unknown");
		expect((await restarted.adapter.cancel("lost")).state).toBe("cancelling");
		expect(submissions).toBe(1);
		reopened.close();
	});
});

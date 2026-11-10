import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QueueIntegration } from "../src/graph/executors/queue-integration";
import type { QueueExecutionRequest, QueueObservation, QueueServiceClient } from "../src/graph/executors/queue";
import { GraphHost, type GraphHostOptions } from "../src/graph/host";
import { type GraphAttemptCompletion, GraphRunStore } from "../src/graph/store";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const auth = { id: "grant", digest: "sha256:grant" };
const source = `---
format: omp.graph/v1
name: queue-host
members: {}
nodes:
  work:
    kind: queue
    task: '#work'
    executor: video
---
## work
Produce a result.
`;

function start(store: GraphRunStore, content = source) {
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const definition = store.definitions.get(imported.target_id!)!;
	return store.start(
		{
			version: 1,
			request_key: "start",
			operation: "start",
			target_id: definition.graph_id,
			if_revision: definition.revision,
			payload: { inputs: {}, authorization_ref: auth },
		},
		{
			graph_id: definition.graph_id,
			definition_revision: definition.revision,
			definition_digest: definition.digest,
			authorization_ref: auth,
			inputs: {},
			members: {},
			executors: { video: { id: "video", digest: "sha256:video" } },
		},
	).target_id!;
}

function harness(
	store: GraphRunStore,
	service: QueueServiceClient,
	options: {
		authorize?: boolean;
		wrongExecutor?: boolean;
		badResult?: boolean;
		resolveHuman?: GraphHostOptions["resolveHuman"];
	} = {},
) {
	const integration = new QueueIntegration({
		client: service,
		store,
		callback: {
			async verify(_body, headers) {
				return headers.get("signature") === "trusted";
			},
			async decode(body) {
				return JSON.parse(new TextDecoder().decode(body));
			},
		},
		async resolveCurrent(observation) {
			const intent = store.listHostIntents().find(item => item.request_key === observation.request_key);
			if (!intent) return null;
			return {
				service_id: service.service_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				request_key: intent.request_key,
			};
		},
	});
	const queue: NonNullable<GraphHostOptions["queue"]> = {
		integration,
		async authorize() {
			return options.authorize ?? true;
		},
		async resolve(intent): Promise<QueueExecutionRequest> {
			return {
				version: 1,
				run_id: intent.run_id,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				request_key: intent.request_key,
				executor: options.wrongExecutor ? "other" : "video",
				inputs: {},
				task_ref: auth,
				authorization_ref: auth,
				model_binding_ref: null,
				base_snapshot_ref: null,
				duty: "general",
				deadline: null,
			};
		},
		async verifyResult(intent, record) {
			return {
				run_id: intent.run_id,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				state: record.state === "cancelled" ? "cancelled" : record.state === "succeeded" ? "succeeded" : "failed",
				outcome: "done",
				outputs: options.badResult ? { forged: auth } : ({} as Record<string, typeof auth>),
			};
		},
	};
	const host = new GraphHost({
		store,
		queue,
		resolveHuman: options.resolveHuman,
		program: {
			async accept() {
				throw new Error("unexpected program dispatch");
			},
			query() {
				return null;
			},
			cancel() {
				return "unknown";
			},
		},
		async resolveProgram() {
			throw new Error("unexpected program resolution");
		},
		async verifyProgramResult() {
			throw new Error("unexpected program result");
		},
	});
	return { host, integration, queue };
}

function service() {
	let submitted = 0;
	let latest: QueueObservation | undefined;
	const client: QueueServiceClient = {
		service_id: "queue",
		capabilities: { submit_idempotent: false, lookup_by_key: true, cancel: false },
		async submit(request) {
			submitted++;
			latest = {
				service_id: "queue",
				attempt_id: request.attempt_id,
				fence: request.fence,
				request_key: request.request_key,
				external_task_id: "remote",
				state: "accepted",
				result_refs: [],
				observed_at: "now",
			};
			return latest;
		},
		async query() {
			return latest ? { status: "found", observation: latest } : { status: "not_found" };
		},
		async cancel() {
			throw new Error("unsupported");
		},
	};
	return { client, submitted: () => submitted, latest: () => latest! };
}

it("routes queue requests, authenticates callbacks and advances only a verified terminal result", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-"));
	const store = new GraphRunStore(limits, root);
	try {
		const run = start(store),
			remote = service(),
			{ host, integration } = harness(store, remote.client);
		host.start();
		await host.tick();
		await host.tick();
		expect(remote.submitted()).toBe(1);
		expect(store.getRun(run)?.state).not.toBe("succeeded");
		const body = new TextEncoder().encode(JSON.stringify({ ...remote.latest(), state: "succeeded" }));
		await expect(integration.acceptCallback(body, new Headers())).rejects.toThrow("authentication");
		await integration.acceptCallback(body, new Headers({ signature: "trusted" }));
		await host.tick();
		expect(store.getRun(run)?.state).toBe("succeeded");
		expect(store.getAttemptHistory(run).filter(item => item.accepted)).toHaveLength(1);
	} finally {
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it.each(["resolver-input", "resolver-envelope", "human-resolver"] as const)(
	"submits the original queue identity despite callback mutation: %s",
	async scenario => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-resolver-"));
		const store = new GraphRunStore(limits, root);
		try {
			const run = start(store);
			const remote = service();
			const { host, queue, integration } = harness(store, remote.client, {
				resolveHuman:
					scenario === "human-resolver"
						? async intent => {
								intent.attempt_id = "substituted-attempt";
								return null;
							}
						: undefined,
			});
			const resolve = queue.resolve;
			let retained: QueueExecutionRequest | undefined;
			queue.resolve = async intent => {
				retained = await resolve(intent);
				if (scenario === "resolver-input") intent.attempt_id = "substituted-attempt";
				return retained;
			};
			queue.authorize = async () => {
				if (scenario === "resolver-envelope" && retained) {
					retained.attempt_id = "substituted-attempt";
					retained.inputs = { injected: "not part of the resolved request" };
				}
				return true;
			};
			host.start();
			await host.tick();
			await host.tick();
			const intent = store.getDispatchIntents(run)[0];
			expect(remote.submitted()).toBe(1);
			expect(remote.latest().attempt_id).toBe(intent.attempt_id);
			const record = await integration.adapter.get(intent.request_key);
			expect(record?.request.inputs).toEqual({});
			await integration.acceptCallback(
				new TextEncoder().encode(JSON.stringify({ ...remote.latest(), state: "succeeded" })),
				new Headers({ signature: "trusted" }),
			);
			await host.tick();
			expect(store.getRun(run)?.state).toBe("succeeded");
		} finally {
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

it("reconciles a durable queue attempt after host restart without resubmission", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-restart-"));
	let store = new GraphRunStore(limits, root);
	try {
		const run = start(store),
			remote = service();
		const first = harness(store, remote.client);
		first.host.start();
		await first.host.tick();
		await first.host.tick();
		store.close();
		store = new GraphRunStore(limits, root);
		const second = harness(store, remote.client);
		second.host.start();
		await second.host.tick();
		expect(store.getRun(run)?.state).toBe("running");
		const body = new TextEncoder().encode(JSON.stringify({ ...remote.latest(), state: "succeeded" }));
		await second.integration.acceptCallback(body, new Headers({ signature: "trusted" }));
		await second.host.tick();
		expect(remote.submitted()).toBe(1);
		expect(store.getRun(run)?.state).toBe("succeeded");
	} finally {
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it.each([{ authorize: false }, { authorize: "false" as unknown as boolean }, { wrongExecutor: true }])(
	"fails closed before submission for invalid trusted admission %j",
	async options => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-denied-"));
		const store = new GraphRunStore(limits, root);
		try {
			const run = start(store),
				remote = service(),
				{ host } = harness(store, remote.client, options);
			host.start();
			await host.tick();
			await host.tick();
			expect(remote.submitted()).toBe(0);
			expect(store.getRun(run)?.state).toBe("held");
		} finally {
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

it("does not commit outputs not attested by the queue result", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-result-"));
	const store = new GraphRunStore(limits, root);
	try {
		const run = start(store),
			remote = service(),
			{ host, integration } = harness(store, remote.client, { badResult: true });
		host.start();
		await host.tick();
		await host.tick();
		const body = new TextEncoder().encode(JSON.stringify({ ...remote.latest(), state: "succeeded" }));
		await integration.acceptCallback(body, new Headers({ signature: "trusted" }));
		await host.tick();
		expect(store.getRun(run)?.state).toBe("held");
		expect(store.getAttemptHistory(run).filter(item => item.accepted)).toHaveLength(0);
	} finally {
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it.each(["verifyResult", "prepareArtifacts", "retained-completion"] as const)(
	"does not persist a callback-mutated authenticated queue state through %s",
	async phase => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-callback-mutation-"));
		const store = new GraphRunStore(limits, root);
		try {
			const registry = store.configureArtifacts({
				maxBytes: 4096,
				authorize: async (principal, _action, scope) => scope.includes(principal),
			});
			const run = start(
				store,
				source.replace(
					"    executor: video",
					"    executor: video\n    outputs: {result: {media_type: text/plain, required: true}}",
				),
			);
			const remote = service();
			const { host, integration, queue } = harness(store, remote.client);
			let verifications = 0;
			let preparations = 0;
			let retainedCompletion: GraphAttemptCompletion | undefined;
			queue.verifyResult = async (intent, record) => {
				verifications++;
				// A verifier may normalize a record in place and return that same object.
				// Neither its argument nor its return value may remain Host-owned state.
				retainedCompletion = Object.assign(record, {
					run_id: intent.run_id,
					invocation_id: intent.invocation_id,
					attempt_id: intent.attempt_id,
					fence: intent.fence,
					state: "succeeded" as const,
					outcome: "done",
					outputs: { result: record.result_refs[0] },
				});
				return retainedCompletion;
			};
			host.start();
			await host.tick();
			await host.tick();
			const intent = store.getDispatchIntents(run)[0];
			const artifact = await registry.store.publish("alice", new TextEncoder().encode("queue output"), {
				media_type: "text/plain",
				producer_attempt_id: intent.attempt_id,
				source_ref: null,
				access_scope: ["alice"],
			});
			const resultRef = { id: artifact.id, digest: artifact.digest };
			queue.prepareArtifacts = async (_intent, record) => {
				preparations++;
				const prepared = await registry.prepareRegistration([
					{
						artifact,
						expected: {
							media_type: "text/plain",
							producer_attempt_id: intent.attempt_id,
							source_ref: null,
							access_scope: ["alice"],
						},
					},
				]);
				if (phase === "prepareArtifacts") record.state = "failed";
				if (phase === "retained-completion") retainedCompletion!.state = "failed";
				return prepared;
			};
			const authenticatedState = phase === "verifyResult" ? "failed" : "succeeded";
			await integration.acceptCallback(
				new TextEncoder().encode(
					JSON.stringify({ ...remote.latest(), state: authenticatedState, result_refs: [resultRef] }),
				),
				new Headers({ signature: "trusted" }),
			);
			await host.tick();
			expect(verifications).toBe(1);
			expect(preparations).toBe(phase === "verifyResult" ? 0 : 1);
			expect(await integration.adapter.get(intent.request_key)).toMatchObject({
				state: authenticatedState,
				result_refs: [resultRef],
			});
			const accepted = store.getAttemptHistory(run).filter(item => item.accepted);
			if (phase === "verifyResult") {
				expect(accepted).toHaveLength(0);
				expect(registry.lookup(resultRef)).toBeNull();
			} else {
				expect(accepted).toMatchObject([
					{
						completion: {
							run_id: intent.run_id,
							invocation_id: intent.invocation_id,
							attempt_id: intent.attempt_id,
							fence: intent.fence,
							state: authenticatedState,
							outcome: "done",
							outputs: { result: resultRef },
						},
					},
				]);
				expect(accepted).toHaveLength(1);
				expect(store.getRun(run)?.state).toBe("succeeded");
				expect(Buffer.from(await registry.store.read("alice", resultRef)).toString()).toBe("queue output");
			}
			expect(store.getDispatchIntents(run)[0]).toMatchObject({
				id: intent.id,
				run_id: intent.run_id,
				invocation_id: intent.invocation_id,
				attempt_id: intent.attempt_id,
				fence: intent.fence,
				request_key: intent.request_key,
			});
			expect(remote.submitted()).toBe(1);
		} finally {
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

it("keeps reconciling after a transient authorization outage without requiring a host restart", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-outage-"));
	const store = new GraphRunStore(limits, root);
	try {
		const run = start(store);
		const remote = service();
		const options = { authorize: true };
		const { host, integration } = harness(store, remote.client, options);
		host.start();
		await host.tick();
		await host.tick();
		options.authorize = false;
		await host.tick();
		expect(store.getRun(run)?.state).toBe("held");
		options.authorize = true;
		await integration.acceptCallback(
			new TextEncoder().encode(JSON.stringify({ ...remote.latest(), state: "succeeded" })),
			new Headers({ signature: "trusted" }),
		);
		store.configureLifecycle({ authorize: () => true, verifyResume: () => true });
		expect(
			store.mutateLifecycle("owner", {
				version: 1,
				request_key: "resume",
				operation: "resume",
				target_id: run,
				if_revision: store.getRun(run)!.revision,
				payload: { decision_ref: auth },
			}).state,
		).toBe("completed");
		await host.tick();
		expect(store.getRun(run)?.state).toBe("succeeded");
		expect(remote.submitted()).toBe(1);
	} finally {
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it.each(["cancelled", "succeeded"] as const)(
	"records confirmed %s after cancellation without routing downstream",
	async state => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-cancel-"));
		const store = new GraphRunStore(limits, root);
		try {
			const run = start(
				store,
				`---
format: omp.graph/v1
name: cancel-handoff
members: {}
nodes:
  work: {kind: queue, executor: video, task: '#work'}
  next: {kind: queue, executor: video, task: '#next'}
edges:
  - {id: handoff, from: work, to: next}
---
## work
Produce.
## next
Must not start after cancellation.
`,
			);
			const remote = service();
			const { host, integration } = harness(store, remote.client);
			host.start();
			await host.tick();
			await host.tick();
			store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
			expect(
				store.mutateLifecycle("owner", {
					version: 1,
					request_key: "cancel",
					operation: "cancel",
					target_id: run,
					if_revision: store.getRun(run)!.revision,
					payload: { reason: "stop" },
				}).state,
			).toBe("completed");
			expect(store.getRun(run)?.state).toBe("cancelling");
			await integration.acceptCallback(
				new TextEncoder().encode(JSON.stringify({ ...remote.latest(), state })),
				new Headers({ signature: "trusted" }),
			);
			await host.tick();
			expect(store.getRun(run)?.state).toBe("cancelled");
			expect(store.getDispatchIntents(run)[0].state).toBe("finished");
			expect(store.getAttemptHistory(run)).toMatchObject([{ accepted: true, completion: { state } }]);
			const revision = store.getRun(run)!.revision;
			await host.tick();
			expect(store.getRun(run)!.revision).toBe(revision);
			expect(remote.submitted()).toBe(1);
		} finally {
			store.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);

it("holds rather than hangs when the service cancels an active task without a user cancel", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-remote-cancel-"));
	const store = new GraphRunStore(limits, root);
	try {
		const run = start(store);
		const remote = service();
		const { host, integration } = harness(store, remote.client);
		host.start();
		await host.tick();
		await host.tick();
		await integration.acceptCallback(
			new TextEncoder().encode(JSON.stringify({ ...remote.latest(), state: "cancelled" })),
			new Headers({ signature: "trusted" }),
		);
		await host.tick();
		expect(store.getRun(run)?.state).toBe("held");
		expect(store.getScheduleState(run)?.invocations[0].state).toBe("cancelled");
		expect(store.getDispatchIntents(run)[0].state).toBe("finished");
	} finally {
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("releases Graph execution capacity while independent tasks wait in a shared external queue", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-queue-capacity-"));
	const store = new GraphRunStore(limits, root);
	let host: GraphHost | undefined;
	try {
		const run = start(
			store,
			source.replace(
				"    executor: video",
				"    executor: video\n  other: {kind: queue, task: '#work', executor: video}\npolicy: {max_parallel: 1}",
			),
		);
		const records = new Map<string, QueueObservation>();
		let submitted = 0;
		const remote = service();
		const client: QueueServiceClient = {
			...remote.client,
			async submit(request) {
				submitted++;
				const observation = {
					...(await remote.client.submit(request)),
					external_task_id: `remote-${request.attempt_id}`,
					state: "queued" as const,
				};
				records.set(request.request_key, observation);
				return observation;
			},
			async query(identity) {
				const observation = records.get(identity.request_key);
				return observation ? { status: "found", observation } : { status: "not_found" };
			},
		};
		({ host } = harness(store, client));
		host.start();
		for (let tick = 0; tick < 6; tick++) await host.tick();
		expect(submitted).toBe(2);
		expect(
			store
				.getScheduleState(run)
				?.invocations.map(item => [item.node, item.state])
				.sort(),
		).toEqual([
			["other", "waiting"],
			["work", "waiting"],
		]);
		expect(store.getAttemptHistory(run)).toEqual([]);
	} finally {
		await host?.shutdown();
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

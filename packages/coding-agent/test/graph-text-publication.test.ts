import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphArtifactRegistry, type ArtifactPublication } from "../src/graph/artifacts";
import { GraphRunStore } from "../src/graph/store";
import {
	GraphTextPublicationError,
	type GraphTextPublicationPolicy,
	type GraphTextPublicationRequest,
} from "../src/graph/text-publication";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const roots: string[] = [];
const stores: GraphRunStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function open(root: string): GraphRunStore {
	const store = new GraphRunStore(limits, root);
	stores.push(store);
	return store;
}
function close(store: GraphRunStore): void {
	stores.splice(stores.indexOf(store), 1);
	store.close();
}
function deferred() {
	return Promise.withResolvers<void>();
}
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-text-publication-"));
	roots.push(root);
	const store = open(root);
	const content =
		"---\nformat: omp.graph/v1\nname: publication\nmembers: {}\nnodes:\n  work: {kind: program, executor: test, task: '#work'}\n---\n## work\nWork.\n";
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	expect(imported.state).toBe("completed");
	const graph = store.definitions.get(imported.target_id!)!;
	const request: GraphTextPublicationRequest = {
		version: 1,
		request_key: "publish",
		operation: "artifact.publish",
		target_id: graph.graph_id,
		if_revision: null,
		payload: { content: "# Bounded text\n你好\n", media_type: "text/markdown", expected_digest: null },
	};
	const publication = (candidate = request): ArtifactPublication => ({
		media_type: candidate.payload.media_type,
		producer_attempt_id: null,
		source_ref: { id: graph.graph_id, digest: graph.digest },
		access_scope: ["alice"],
		expected_digest: candidate.payload.expected_digest,
	});
	const policy: GraphTextPublicationPolicy = {
		principal: "alice",
		maxBytes: 4096,
		authorizeArtifact: async (principal, _action, scope) => scope.includes(principal),
		authorizeRequest: (principal, candidate) => principal === "alice" && candidate.target_id === graph.graph_id,
		resolvePublication: async (_principal, candidate) => publication(candidate),
	};
	return { root, store, graph, request, policy, publication };
}
function counts(root: string) {
	const db = new Database(path.join(root, "graphs.sqlite"), { readonly: true });
	try {
		const artifacts = db.query<{ count: number }, []>("SELECT count(*) AS count FROM graph_artifacts").get()!;
		const publications = db
			.query<{ count: number }, []>(
				"SELECT count(*) AS count FROM graph_requests WHERE json_extract(canonical,'$.operation')='artifact.publish'",
			)
			.get()!;
		return { artifacts: artifacts.count, publications: publications.count };
	} finally {
		db.close();
	}
}
function registry(f: { root: string; policy: GraphTextPublicationPolicy }) {
	return new GraphArtifactRegistry({
		root: f.root,
		maxBytes: f.policy.maxBytes,
		authorize: f.policy.authorizeArtifact,
	});
}

it("publishes genuine immutable bytes and replays after reopening without resolving or republishing", async () => {
	const f = fixture();
	let resolves = 0;
	f.policy.resolvePublication = async (_principal, request) => {
		resolves++;
		return f.publication(request);
	};
	const service = f.store.configureTextPublications(f.policy);
	const result = await service.publish(f.request);
	expect(result).toMatchObject({ state: "completed", target_id: f.graph.graph_id, revision: null, error: null });
	expect(result.result_ref).not.toBeNull();
	const artifacts = registry(f);
	try {
		expect(Buffer.from(await artifacts.store.read("alice", result.result_ref!)).toString()).toBe(
			f.request.payload.content,
		);
		expect(artifacts.lookup(result.result_ref!)).toMatchObject({
			media_type: "text/markdown",
			source_ref: { id: f.graph.graph_id, digest: f.graph.digest },
			access_scope: ["alice"],
		});
		expect(fs.statSync(path.join(f.root, "artifacts", result.result_ref!.id)).mode & 0o777).toBe(0o400);
		await expect(artifacts.store.read("bob", result.result_ref!)).rejects.toMatchObject({
			code: "permission_denied",
		});
	} finally {
		artifacts.close();
	}
	result.result_ref!.id = "caller-mutated";
	close(f.store);
	const reopened = open(f.root);
	const replay = await reopened.configureTextPublications(f.policy).publish(f.request);
	expect(replay.state).toBe("completed");
	expect(replay.result_ref!.id).not.toBe("caller-mutated");
	expect(resolves).toBe(1);
	expect(
		reopened.definitions.requestGetAuthorized(
			"publish",
			request => request.operation === "artifact.publish" && request.if_revision === null,
		),
	).toEqual({ kind: "publication", receipt: replay });
	expect(counts(f.root)).toEqual({ artifacts: 1, publications: 1 });
});

it("shares the global request namespace, including prior authoring keys, without republishing", async () => {
	const f = fixture();
	let resolves = 0;
	f.policy.resolvePublication = async (_principal, request) => {
		resolves++;
		return f.publication(request);
	};
	const service = f.store.configureTextPublications(f.policy);
	const result = await service.publish(f.request);
	expect(result.state).toBe("completed");
	for (const request of [
		{ ...f.request, payload: { ...f.request.payload, content: "different" } },
		{ ...f.request, request_key: "import" },
	])
		expect((await service.publish(request)).error?.code).toBe("idempotency_conflict");
	const authoring = f.store.definitions.mutate({
		version: 1,
		request_key: "publish",
		operation: "create",
		target_id: null,
		if_revision: null,
		payload: { name: "other" },
	});
	expect(authoring.error?.code).toBe("idempotency_conflict");
	expect(resolves).toBe(1);
	expect(counts(f.root)).toEqual({ artifacts: 1, publications: 1 });
});

it("denies false and Promise request authorizations without invoking the resolver or registering results", async () => {
	for (const authorize of [() => false, () => Promise.resolve(true), () => Promise.reject(new Error("denied"))]) {
		const f = fixture();
		let resolves = 0;
		f.policy.authorizeRequest = authorize as GraphTextPublicationPolicy["authorizeRequest"];
		f.policy.resolvePublication = async () => {
			resolves++;
			return f.publication();
		};
		const result = await f.store.configureTextPublications(f.policy).publish(f.request);
		expect(result.error?.code).toBe("permission_denied");
		expect(result.result_ref).toBeNull();
		expect(resolves).toBe(0);
		expect(f.store.definitions.requestGet("publish")).toBeNull();
		expect(counts(f.root)).toEqual({ artifacts: 0, publications: 0 });
	}
});

it("rechecks current permission before replay and protects publication receipt reads", async () => {
	const f = fixture();
	let allowed = true;
	f.policy.authorizeRequest = () => allowed;
	const service = f.store.configureTextPublications(f.policy);
	expect((await service.publish(f.request)).state).toBe("completed");
	allowed = false;
	expect((await service.publish(f.request)).error?.code).toBe("permission_denied");
	expect(() => f.store.definitions.requestGet("publish", true)).toThrow();
	expect(() => f.store.definitions.requestGetAuthorized("publish")).toThrow();
	expect(() => f.store.definitions.requestGetAuthorized("publish", () => false)).toThrow();
	expect(() =>
		f.store.definitions.requestGetAuthorized("publish", (() => Promise.resolve(true)) as unknown as () => boolean),
	).toThrow();
	expect(counts(f.root)).toEqual({ artifacts: 1, publications: 1 });
});

it("captures the request and principal before awaits and detaches every policy argument", async () => {
	const f = fixture();
	const entered = deferred();
	const release = deferred();
	const original = structuredClone(f.request);
	const principals: string[] = [];
	f.policy.authorizeRequest = (principal, request) => {
		principals.push(principal);
		request.request_key = "callback-forged";
		request.payload.content = "callback-forged";
		return true;
	};
	f.policy.resolvePublication = async (principal, request) => {
		principals.push(principal);
		entered.resolve();
		await release.promise;
		expect(request).toEqual(original);
		request.target_id = "resolver-forged";
		return f.publication(original);
	};
	const service = f.store.configureTextPublications(f.policy);
	const pending = service.publish(f.request);
	await entered.promise;
	f.request.request_key = "mutated";
	f.request.target_id = "mutated";
	f.request.payload.content = "mutated";
	f.policy.principal = "mallory";
	release.resolve();
	const result = await pending;
	expect(result).toMatchObject({
		state: "completed",
		request_key: original.request_key,
		target_id: original.target_id,
	});
	expect(principals).toEqual(["alice", "alice", "alice"]);
	const artifacts = registry(f);
	try {
		expect(Buffer.from(await artifacts.store.read("alice", result.result_ref!)).toString()).toBe(
			original.payload.content,
		);
	} finally {
		artifacts.close();
	}
	expect(f.store.definitions.requestGet("mutated")).toBeNull();
});

it("detaches publication metadata before artifact authorization awaits", async () => {
	const f = fixture();
	const metadata = f.publication();
	const entered = deferred();
	const release = deferred();
	f.policy.resolvePublication = async () => metadata;
	f.policy.authorizeArtifact = async (principal, action, scope) => {
		if (action === "publish") {
			entered.resolve();
			await release.promise;
		}
		return scope.includes(principal);
	};
	const pending = f.store.configureTextPublications(f.policy).publish(f.request);
	await entered.promise;
	metadata.access_scope[0] = "mallory";
	metadata.source_ref!.id = "forged";
	metadata.media_type = "application/octet-stream";
	release.resolve();
	const result = await pending;
	expect(result.state).toBe("completed");
	const artifacts = registry(f);
	try {
		expect(artifacts.lookup(result.result_ref!)).toMatchObject({
			access_scope: ["alice"],
			media_type: "text/markdown",
			source_ref: { id: f.graph.graph_id },
		});
	} finally {
		artifacts.close();
	}
});

it("maps digest and metadata mismatches, limits, malformed Unicode and denied artifact policy to standard failures", async () => {
	for (const failure of ["digest", "media", "resolver-digest", "size", "unicode", "artifact-denied"] as const) {
		const f = fixture();
		if (failure === "digest") f.request.payload.expected_digest = `sha256:${"0".repeat(64)}`;
		if (failure === "size") f.policy.maxBytes = 1;
		if (failure === "unicode") f.request.payload.content = "bad\ud800text";
		if (failure === "artifact-denied") f.policy.authorizeArtifact = async () => false;
		if (failure === "media")
			f.policy.resolvePublication = async () => ({ ...f.publication(), media_type: "text/plain" });
		if (failure === "resolver-digest")
			f.policy.resolvePublication = async () => ({
				...f.publication(),
				expected_digest: `sha256:${"0".repeat(64)}`,
			});
		const result = await f.store.configureTextPublications(f.policy).publish(f.request);
		expect(result.state).toBe("rejected");
		expect(result.error?.code).toBe(
			failure === "size"
				? "resource_limit"
				: failure === "artifact-denied"
					? "permission_denied"
					: "definition_invalid",
		);
		const durable = ["digest", "media", "resolver-digest"].includes(failure);
		expect(f.store.definitions.requestGet("publish")).toEqual(durable ? result : null);
		expect(counts(f.root)).toEqual({ artifacts: 0, publications: durable ? 1 : 0 });
	}
});

it("rechecks authorization after durable byte publication without registering a Ref or receipt on revocation", async () => {
	const f = fixture();
	let checks = 0;
	f.policy.authorizeRequest = () => ++checks === 1;
	const result = await f.store.configureTextPublications(f.policy).publish(f.request);
	expect(result.error?.code).toBe("permission_denied");
	expect(checks).toBe(2);
	expect(fs.readdirSync(path.join(f.root, "artifacts")).length).toBe(1);
	expect(f.store.definitions.requestGet("publish")).toBeNull();
	expect(counts(f.root)).toEqual({ artifacts: 0, publications: 0 });
});

it("commits one receipt and registered reference for concurrent identical requests across store connections", async () => {
	const f = fixture();
	const secondStore = open(f.root);
	const entered = deferred();
	const release = deferred();
	let calls = 0;
	f.policy.resolvePublication = async (_principal, request) => {
		if (++calls === 2) entered.resolve();
		await release.promise;
		return f.publication(request);
	};
	const first = f.store.configureTextPublications(f.policy).publish(f.request);
	const second = secondStore.configureTextPublications(f.policy).publish(f.request);
	await entered.promise;
	release.resolve();
	const results = await Promise.all([first, second]);
	expect(results[0].state).toBe("completed");
	expect(results[1]).toEqual(results[0]);
	expect(calls).toBe(2);
	expect(counts(f.root)).toEqual({ artifacts: 1, publications: 1 });
});

it("rejects a missing exact target before resolution", async () => {
	const f = fixture();
	let resolves = 0;
	f.policy.authorizeRequest = () => true;
	f.policy.resolvePublication = async () => {
		resolves++;
		return f.publication();
	};
	const result = await f.store
		.configureTextPublications(f.policy)
		.publish({ ...f.request, target_id: `${f.graph.graph_id}-missing` });
	expect(result.error?.code).toBe("unknown_reference");
	expect(resolves).toBe(0);
	expect(f.store.definitions.requestGet("publish")).toEqual(result);
	expect(counts(f.root)).toEqual({ artifacts: 0, publications: 1 });
});

it("publishes to a Run without transitioning it or adding task authority", async () => {
	const f = fixture();
	const authorization = { id: "authorized-test", digest: "sha256:authorized-test" };
	const started = f.store.start(
		{
			version: 1,
			request_key: "start",
			operation: "start",
			target_id: f.graph.graph_id,
			if_revision: f.graph.revision,
			payload: { inputs: {}, authorization_ref: authorization },
		},
		{
			graph_id: f.graph.graph_id,
			definition_revision: f.graph.revision,
			definition_digest: f.graph.digest,
			authorization_ref: authorization,
			inputs: {},
			members: {},
			executors: { test: authorization },
		},
	);
	expect(started.state).toBe("accepted");
	const before = f.store.getRun(started.target_id!)!;
	const schedule = f.store.getScheduleState(before.id);
	f.policy.authorizeRequest = (_principal, request) => request.target_id === before.id;
	const result = await f.store.configureTextPublications(f.policy).publish({ ...f.request, target_id: before.id });
	expect(result).toMatchObject({ state: "completed", target_id: before.id, revision: null });
	expect(f.store.getRun(before.id)).toEqual(before);
	expect(f.store.getScheduleState(before.id)).toEqual(schedule);
	expect(f.store.getDispatchIntents(before.id)).toEqual([]);
});

it("refuses existing or replacement artifact policies without weakening the configured policy", async () => {
	const f = fixture();
	const artifacts = f.store.configureArtifacts({ maxBytes: 4096, authorize: async () => false });
	expect(() => f.store.configureTextPublications(f.policy)).toThrow(GraphTextPublicationError);
	await expect(artifacts.store.publish("alice", Buffer.from("denied"), f.publication())).rejects.toMatchObject({
		code: "permission_denied",
	});
	expect(counts(f.root)).toEqual({ artifacts: 0, publications: 0 });
	const fresh = open(f.root);
	fresh.configureTextPublications(f.policy);
	expect(() => fresh.configureTextPublications(f.policy)).toThrow(GraphTextPublicationError);
	expect(() => fresh.configureArtifacts({ maxBytes: 4096, authorize: async () => true })).toThrow();
});

it("rolls registration back if the shared global receipt insertion fails", async () => {
	const f = fixture();
	const service = f.store.configureTextPublications(f.policy);
	const db = new Database(path.join(f.root, "graphs.sqlite"));
	try {
		db.exec(
			"CREATE TRIGGER reject_text_receipt BEFORE INSERT ON graph_requests WHEN NEW.request_key='publish' BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END",
		);
		const failed = await service.publish(f.request);
		expect(failed.error?.code).toBe("internal_error");
		expect(f.store.definitions.requestGet("publish")).toBeNull();
		expect(counts(f.root)).toEqual({ artifacts: 0, publications: 0 });
		db.exec("DROP TRIGGER reject_text_receipt");
		expect((await service.publish(f.request)).state).toBe("completed");
		expect(counts(f.root)).toEqual({ artifacts: 1, publications: 1 });
	} finally {
		db.close();
	}
});

it("persists admitted rejection replay across reopen and reserves its global key even after policy repair", async () => {
	const f = fixture();
	let resolves = 0;
	f.policy.resolvePublication = async () => {
		resolves++;
		return { ...f.publication(), media_type: "text/plain" };
	};
	const rejected = await f.store.configureTextPublications(f.policy).publish(f.request);
	expect(rejected.error?.code).toBe("definition_invalid");
	close(f.store);
	const reopened = open(f.root);
	let allowed = true;
	f.policy.authorizeRequest = () => allowed;
	f.policy.resolvePublication = async () => {
		resolves++;
		return f.publication();
	};
	const service = reopened.configureTextPublications(f.policy);
	expect(await service.publish(f.request)).toEqual(rejected);
	expect(
		(
			await service.publish({
				...f.request,
				payload: { ...f.request.payload, content: "repaired content" },
			})
		).error?.code,
	).toBe("idempotency_conflict");
	allowed = false;
	expect((await service.publish(f.request)).error?.code).toBe("permission_denied");
	expect(resolves).toBe(1);
	expect(reopened.definitions.requestGetAuthorized("publish", () => true)).toEqual({
		kind: "publication",
		receipt: rejected,
	});
	expect(counts(f.root)).toEqual({ artifacts: 0, publications: 1 });
});

it("rejects malformed, non-Unicode and oversized envelopes before admission without reserving their keys", async () => {
	for (const failure of ["envelope", "unicode", "size"] as const) {
		const f = fixture();
		let authorizations = 0;
		let resolutions = 0;
		f.policy.authorizeRequest = () => {
			authorizations++;
			return true;
		};
		f.policy.resolvePublication = async () => {
			resolutions++;
			return f.publication();
		};
		if (failure === "unicode") f.request.payload.content = "\udc00";
		if (failure === "size") f.policy.maxBytes = 1;
		const request =
			failure === "envelope"
				? ({ ...f.request, if_revision: "1" } as unknown as GraphTextPublicationRequest)
				: f.request;
		const result = await f.store.configureTextPublications(f.policy).publish(request);
		expect(result.error?.code).toBe(failure === "size" ? "resource_limit" : "definition_invalid");
		expect(authorizations).toBe(0);
		expect(resolutions).toBe(0);
		expect(f.store.definitions.requestGet("publish")).toBeNull();
		expect(counts(f.root)).toEqual({ artifacts: 0, publications: 0 });
	}
});

it("reauthorizes rejection persistence and does not save it after false or Promise revocation", async () => {
	for (const revoked of [() => false, () => Promise.resolve(true)]) {
		const f = fixture();
		let checks = 0;
		f.policy.authorizeRequest = (() =>
			++checks === 1 ? true : revoked()) as GraphTextPublicationPolicy["authorizeRequest"];
		f.policy.resolvePublication = async () => ({ ...f.publication(), media_type: "text/plain" });
		const result = await f.store.configureTextPublications(f.policy).publish(f.request);
		expect(result.error?.code).toBe("permission_denied");
		expect(checks).toBe(2);
		expect(f.store.definitions.requestGet("publish")).toBeNull();
		expect(counts(f.root)).toEqual({ artifacts: 0, publications: 0 });
	}
});

it("returns the first durable receipt when a concurrent identical request completes or rejects first", async () => {
	for (const winner of ["completed", "rejected"] as const) {
		const f = fixture();
		const entered = deferred();
		const release = deferred();
		const secondStore = open(f.root);
		const losingPolicy: GraphTextPublicationPolicy = {
			...f.policy,
			resolvePublication: async () => {
				entered.resolve();
				await release.promise;
				return winner === "completed" ? { ...f.publication(), media_type: "text/plain" } : f.publication();
			},
		};
		const pending = secondStore.configureTextPublications(losingPolicy).publish(f.request);
		await entered.promise;
		if (winner === "rejected")
			f.policy.resolvePublication = async () => ({ ...f.publication(), media_type: "text/plain" });
		const first = await f.store.configureTextPublications(f.policy).publish(f.request);
		expect(first.state).toBe(winner);
		release.resolve();
		expect(await pending).toEqual(first);
		expect(counts(f.root)).toEqual({ artifacts: winner === "completed" ? 1 : 0, publications: 1 });
	}
});

it("never overwrites a conflicting global key while saving an application rejection", async () => {
	const f = fixture();
	const entered = deferred();
	const release = deferred();
	f.policy.resolvePublication = async () => {
		entered.resolve();
		await release.promise;
		return { ...f.publication(), media_type: "text/plain" };
	};
	const pending = f.store.configureTextPublications(f.policy).publish(f.request);
	await entered.promise;
	const authoring = f.store.definitions.mutate({
		version: 1,
		request_key: "publish",
		operation: "create",
		target_id: null,
		if_revision: null,
		payload: { name: "concurrent-authoring" },
	});
	expect(authoring.state).toBe("completed");
	release.resolve();
	expect((await pending).error?.code).toBe("idempotency_conflict");
	expect(f.store.definitions.requestGet("publish")).toEqual(authoring);
	expect(counts(f.root)).toEqual({ artifacts: 0, publications: 0 });
});

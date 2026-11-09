import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalArtifactStore, type GraphArtifact } from "../src/graph/artifacts";
import {
	TrustedProgramExecutor,
	type ProgramExecutionRequest,
	type TrustedProgram,
} from "../src/graph/executors/program";
import { validateGraphOutputContent } from "../src/graph/output-validation";

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-artifacts-test-"));
	const records = new Map<string, GraphArtifact>();
	const store = new LocalArtifactStore({
		directory: path.join(root, "store"),
		maxBytes: 1024,
		lookup: async ref => records.get(ref.id) ?? null,
		authorize: async (principal, _action, scope) => scope.includes(principal),
	});
	return { root, store, records };
}

const metadata = {
	media_type: "text/plain",
	producer_attempt_id: "attempt",
	source_ref: null,
	access_scope: ["alice"],
};
const ref = { id: "ref", digest: "sha256:test" };
function request(): ProgramExecutionRequest {
	return {
		version: 1,
		run_id: "run",
		invocation_id: "invocation",
		attempt_id: "attempt",
		fence: "9007199254740993",
		request_key: "key",
		executor: "test",
		inputs: {},
		task_ref: ref,
		authorization_ref: ref,
		model_binding_ref: null,
		base_snapshot_ref: null,
		duty: "general",
		deadline: null,
		parameters: {},
		outputs: { result: { media_type: "text/plain", required: true } },
		principal: "alice",
		output_scope: ["alice"],
	};
}
function program(root: string, script: string): TrustedProgram {
	return {
		executable: process.execPath,
		workspaceRoot: root,
		env: {},
		argv: [{ literal: "-e" }, { literal: script }, { parameter: "value", type: "string" }],
		outputs: { result: { filename: "result.txt", media_type: "text/plain" } },
		outcome: "done",
		timeoutMs: 10000,
	};
}
async function settled(executor: TrustedProgramExecutor, id: string) {
	const result = await executor.wait(id);
	if (!result) throw new Error("Execution not found");
	return result;
}

async function publishSchema(
	store: LocalArtifactStore,
	records: Map<string, GraphArtifact>,
	schema: unknown,
	access_scope = ["alice"],
): Promise<GraphArtifact> {
	const artifact = await store.publish(access_scope[0], Buffer.from(JSON.stringify(schema)), {
		...metadata,
		media_type: "application/schema+json",
		access_scope,
	});
	records.set(artifact.id, artifact);
	return artifact;
}

function structuredProgram(root: string): TrustedProgram {
	const config = program(
		root,
		"require('node:fs').writeFileSync('result.txt', Buffer.from(process.argv.at(-1), 'base64'))",
	);
	config.outputs.result.media_type = "application/json";
	return config;
}

function structuredRequest(schema: GraphArtifact, bytes: Uint8Array): ProgramExecutionRequest {
	return {
		...request(),
		parameters: { value: Buffer.from(bytes).toString("base64") },
		outputs: { result: { media_type: "application/json", required: true, schema_ref: schema } },
	};
}

describe("local graph artifacts", () => {
	it("denies artifact publication and reads when authorization is not boolean true", async () => {
		const { root, store, records } = await fixture();
		try {
			const artifact = await store.publish("alice", Buffer.from("secret"), metadata);
			records.set(artifact.id, artifact);
			const denied = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async value => records.get(value.id) ?? null,
				authorize: async () => "false" as unknown as boolean,
			});
			await expect(denied.read("alice", artifact)).rejects.toMatchObject({ code: "permission_denied" });
			await expect(denied.publish("alice", Buffer.from("x"), metadata)).rejects.toMatchObject({
				code: "permission_denied",
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("withholds content when read authorization is revoked during retrieval", async () => {
		const { root, store, records } = await fixture();
		try {
			const artifact = await store.publish("alice", Buffer.from("secret"), metadata);
			records.set(artifact.id, artifact);
			let permitted = true;
			const guarded = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async value => records.get(value.id) ?? null,
				authorize: async () => {
					const allowed = permitted;
					queueMicrotask(() => {
						permitted = false;
					});
					return allowed;
				},
			});
			await expect(guarded.read("alice", artifact)).rejects.toMatchObject({ code: "permission_denied" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not let policy argument mutation widen a published artifact's readers", async () => {
		const { root, records } = await fixture();
		try {
			const guarded = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async value => records.get(value.id) ?? null,
				authorize: async (principal, _action, scope) => {
					const allowed = scope.includes(principal);
					(scope as string[]).push("mallory");
					return allowed;
				},
			});
			const artifact = await guarded.publish("alice", Buffer.from("secret"), metadata);
			records.set(artifact.id, artifact);
			await expect(guarded.read("mallory", artifact)).rejects.toMatchObject({ code: "permission_denied" });
			expect(Buffer.from(await guarded.read("alice", artifact)).toString()).toBe("secret");
			await expect(guarded.read("mallory", artifact)).rejects.toMatchObject({ code: "permission_denied" });
			expect(artifact.access_scope).toEqual(["alice"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the requested reference stable while lookup is pending", async () => {
		const { root, store, records } = await fixture();
		try {
			const original = await store.publish("alice", Buffer.from("original"), metadata);
			const replacement = await store.publish("alice", Buffer.from("replacement"), metadata);
			records.set(original.id, original);
			records.set(replacement.id, replacement);
			const guarded = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async value => {
					await Promise.resolve();
					return records.get(value.id) ?? null;
				},
				authorize: async (principal, _action, scope) => scope.includes(principal),
			});
			const requested = { id: original.id, digest: original.digest };
			const pending = guarded.read("alice", requested);
			Object.assign(requested, { id: replacement.id, digest: replacement.digest });
			expect(Buffer.from(await pending).toString()).toBe("original");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects lookup callbacks that retarget their reference argument", async () => {
		const { root, store } = await fixture();
		try {
			const original = await store.publish("alice", Buffer.from("original"), metadata);
			const replacement = await store.publish("alice", Buffer.from("replacement"), metadata);
			const requested = { id: original.id, digest: original.digest };
			const guarded = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async value => {
					Object.assign(value, { id: replacement.id, digest: replacement.digest });
					return replacement;
				},
				authorize: async (principal, _action, scope) => scope.includes(principal),
			});
			await expect(guarded.read("alice", requested)).rejects.toMatchObject({ code: "invalid" });
			expect(requested).toEqual({ id: original.id, digest: original.digest });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not let authorization retarget shared lookup metadata to another artifact", async () => {
		const { root, store } = await fixture();
		try {
			const original = await store.publish("alice", Buffer.from("original"), metadata);
			const secret = await store.publish("bob", Buffer.from("secret"), { ...metadata, access_scope: ["bob"] });
			const shared = structuredClone(original);
			const guarded = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async () => shared,
				authorize: async (principal, _action, scope) => {
					const allowed = scope.includes(principal);
					Object.assign(shared, secret, { access_scope: ["alice"] });
					return allowed;
				},
			});
			await expect(guarded.read("alice", original)).rejects.toMatchObject({ code: "invalid" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps verification bound to the digest supplied before asynchronous file access", async () => {
		const { root, store } = await fixture();
		try {
			const artifact = await store.publish("alice", Buffer.from("original"), metadata);
			const altered = { ...artifact, digest: `sha256:${"0".repeat(64)}` };
			const pending = store.verifyPublishedContent(altered);
			altered.digest = artifact.digest;
			await expect(pending).rejects.toMatchObject({ code: "digest_mismatch" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("snapshots buffered publication bytes before authorization can mutate them", async () => {
		const { root, records } = await fixture();
		try {
			const bytes = Buffer.from("original");
			const digest = `sha256:${Bun.SHA256.hash(bytes, "hex")}`;
			const guarded = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async value => records.get(value.id) ?? null,
				authorize: async (principal, action, scope) => {
					if (action === "publish") bytes.fill(0);
					return scope.includes(principal);
				},
			});
			const artifact = await guarded.publish(
				"alice",
				bytes,
				{ ...metadata, expected_digest: digest },
				async value => {
					expect(Buffer.from(value).toString()).toBe("original");
				},
			);
			records.set(artifact.id, artifact);
			expect(artifact.digest).toBe(digest);
			expect(Buffer.from(await guarded.read("alice", artifact)).toString()).toBe("original");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("hashes and writes a private copy of each streamed chunk", async () => {
		const { root, store, records } = await fixture();
		try {
			const chunk = new Uint8Array(Buffer.from("original"));
			const length = chunk.byteLength;
			const digest = `sha256:${Bun.SHA256.hash(chunk, "hex")}`;
			let inspections = 0;
			Object.defineProperty(chunk, "byteLength", {
				get: () => {
					// Mutate the producer's buffer between hashing and the first write if it is retained.
					if (++inspections === 2) chunk.fill(0);
					return length;
				},
			});
			async function* content() {
				yield chunk;
			}
			const artifact = await store.publish("alice", content(), { ...metadata, expected_digest: digest });
			records.set(artifact.id, artifact);
			expect(artifact.digest).toBe(digest);
			expect(Buffer.from(await store.read("alice", artifact)).toString()).toBe("original");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("checks scope and content digest on every read", async () => {
		const { root, store, records } = await fixture();
		try {
			const bytes = Buffer.from("hello");
			const artifact = await store.publish("alice", bytes, metadata);
			records.set(artifact.id, artifact);
			expect(artifact.digest).toBe(`sha256:${Bun.SHA256.hash(bytes, "hex")}`);
			expect(Buffer.from(await store.read("alice", artifact)).toString()).toBe("hello");
			await expect(store.read("bob", artifact)).rejects.toMatchObject({ code: "permission_denied" });
			await expect(store.publish("bob", bytes, metadata)).rejects.toMatchObject({ code: "permission_denied" });
			await expect(store.read("alice", { id: artifact.id, digest: "sha256:wrong" })).rejects.toMatchObject({
				code: "invalid",
			});
			records.set(artifact.id, { ...artifact, availability: "expired" });
			await expect(store.read("alice", artifact)).rejects.toMatchObject({ code: "expired" });
			records.set(artifact.id, { ...artifact, expires_at: "2000-01-01T00:00:00.000Z" });
			await expect(store.read("alice", artifact)).rejects.toMatchObject({ code: "expired" });
			records.set(artifact.id, artifact);
			await fs.chmod(path.join(root, "store", artifact.id), 0o600);
			await fs.writeFile(path.join(root, "store", artifact.id), "jello");
			await expect(store.read("alice", artifact)).rejects.toMatchObject({ code: "digest_mismatch" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("never publishes partial, oversized or digest-mismatched content", async () => {
		const { root, store } = await fixture();
		try {
			async function* interrupted() {
				yield Buffer.from("partial");
				throw new Error("interrupted");
			}
			await expect(store.publish("alice", interrupted(), metadata)).rejects.toThrow("interrupted");
			await expect(store.publish("alice", Buffer.alloc(1025), metadata)).rejects.toMatchObject({
				code: "too_large",
			});
			await expect(
				store.publish("alice", Buffer.from("x"), { ...metadata, expected_digest: "sha256:bad" }),
			).rejects.toMatchObject({ code: "digest_mismatch" });
			expect(await fs.readdir(path.join(root, "store"))).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("bounds validation reads, requires read grants and rolls back rejected fresh publications", async () => {
		const { root, store } = await fixture();
		try {
			let seen: Uint8Array | null = null;
			await expect(
				store.publish("alice", Buffer.alloc(1025), metadata, async bytes => {
					seen = bytes;
				}),
			).rejects.toMatchObject({ code: "too_large" });
			expect(seen).toBeNull();
			await expect(
				store.publish("alice", Buffer.from("original"), metadata, async bytes => {
					expect(Buffer.from(bytes).toString()).toBe("original");
					throw new Error("invalid output");
				}),
			).rejects.toThrow("invalid output");
			const denied = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async () => null,
				authorize: async (_principal, action) => action === "publish",
			});
			await expect(
				denied.publish("alice", Buffer.from("secret"), metadata, async bytes => {
					seen = bytes;
				}),
			).rejects.toMatchObject({ code: "permission_denied" });
			expect(seen).toBeNull();
			expect(await fs.readdir(path.join(root, "store"))).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not parse or transform output bytes without a schema", async () => {
		const { root, store } = await fixture();
		try {
			const bytes = Uint8Array.from([0xff, 0x00, 0xef, 0xbb, 0xbf]);
			await validateGraphOutputContent(
				{ media_type: "application/octet-stream", required: true },
				bytes,
				"alice",
				store,
			);
			expect([...bytes]).toEqual([0xff, 0x00, 0xef, 0xbb, 0xbf]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rolls back fresh validated metadata when read permission is revoked during validation", async () => {
		const { root } = await fixture();
		try {
			let readable = true;
			const store = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async () => null,
				authorize: async (_principal, action) => action === "publish" || readable,
			});
			await expect(
				store.publish("alice", Buffer.from("value"), metadata, async bytes => {
					expect(Buffer.from(bytes).toString()).toBe("value");
					readable = false;
				}),
			).rejects.toMatchObject({ code: "permission_denied" });
			expect(await fs.readdir(path.join(root, "store"))).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("trusted program execution", () => {
	it("binds frozen registration references to the registered name and configuration", async () => {
		const { root, store } = await fixture();
		try {
			const config = program(root, "process.exit(0)");
			const executor = new TrustedProgramExecutor({ test: config }, { store, authorize: async () => true });
			const frozen = executor.registrationRef("test")!;
			expect(frozen.id).toBe("test");
			expect(frozen.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(executor.verifyRegistration("test", frozen)).toBe(true);
			expect(executor.verifyRegistration("other", frozen)).toBe(false);
			expect(executor.verifyRegistration("test", { ...frozen, digest: "sha256:wrong" })).toBe(false);
			expect(executor.verifyRegistration("test", { ...frozen, id: "other" })).toBe(false);
			expect(executor.registrationRef("missing")).toBeNull();

			// Registrations are snapshotted, not affected by later caller mutations.
			config.argv[0] = { literal: "--changed" };
			expect(executor.verifyRegistration("test", frozen)).toBe(true);
			const changed = new TrustedProgramExecutor({ test: config }, { store, authorize: async () => true });
			expect(changed.verifyRegistration("test", frozen)).toBe(false);
			const renamed = new TrustedProgramExecutor(
				{ other: program(root, "process.exit(0)") },
				{
					store,
					authorize: async () => true,
				},
			);
			expect(renamed.registrationRef("other")!.digest).not.toBe(frozen.digest);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("requires a valid explicit environment and binds it to the frozen registration", async () => {
		const { root, store } = await fixture();
		try {
			const config = program(root, "process.exit(0)");
			const options = { store, authorize: async () => true };
			expect(() => new TrustedProgramExecutor({ test: { ...config, env: undefined as never } }, options)).toThrow();
			expect(() => new TrustedProgramExecutor({ test: { ...config, env: { "BAD=KEY": "x" } } }, options)).toThrow();
			expect(
				() => new TrustedProgramExecutor({ test: { ...config, env: { OK: "bad\0value" } } }, options),
			).toThrow();
			config.env.PATH = "/trusted/bin";
			const executor = new TrustedProgramExecutor({ test: config }, options);
			const frozen = executor.registrationRef("test")!;
			config.env.PATH = "/changed/bin";
			expect(executor.verifyRegistration("test", frozen)).toBe(true);
			const changed = new TrustedProgramExecutor({ test: config }, options);
			expect(changed.verifyRegistration("test", frozen)).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("passes only the configured environment to the program", async () => {
		const { root, store, records } = await fixture();
		const key = `GRAPH_TEST_SECRET_${crypto.randomUUID().replaceAll("-", "")}`;
		const previous = process.env[key];
		process.env[key] = "host-secret";
		try {
			const config = program(
				root,
				`require('node:fs').writeFileSync('result.txt', JSON.stringify({ leaked: process.env[${JSON.stringify(key)}] ?? null, allowed: process.env.GRAPH_ALLOWED }))`,
			);
			config.env.GRAPH_ALLOWED = "configured";
			const executor = new TrustedProgramExecutor({ test: config }, { store, authorize: async () => true });
			const accepted = await executor.accept({ ...request(), parameters: { value: "unused" } });
			const result = await settled(executor, accepted.execution_ref!);
			expect(result.state).toBe("succeeded");
			records.set(result.outputs.result.id, result.outputs.result);
			expect(JSON.parse(Buffer.from(await store.read("alice", result.outputs.result)).toString())).toEqual({
				leaked: null,
				allowed: "configured",
			});
		} finally {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not let authorization callbacks mutate the dispatched request or output scope", async () => {
		const { root, store, records } = await fixture();
		try {
			const observed: ProgramExecutionRequest[] = [];
			const executor = new TrustedProgramExecutor(
				{ test: program(root, "require('node:fs').writeFileSync('result.txt', process.argv.at(-1))") },
				{
					store,
					authorize: async candidate => {
						observed.push(structuredClone(candidate));
						candidate.parameters.value = "changed";
						candidate.principal = "mallory";
						candidate.output_scope.push("mallory");
						return true;
					},
				},
			);
			const accepted = await executor.accept({ ...request(), parameters: { value: "approved" } });
			const result = await settled(executor, accepted.execution_ref!);
			expect(result.state).toBe("succeeded");
			expect(observed).toHaveLength(2);
			for (const candidate of observed) {
				expect(candidate.parameters.value).toBe("approved");
				expect(candidate.principal).toBe("alice");
				expect(candidate.output_scope).toEqual(["alice"]);
			}
			expect(result.outputs.result.access_scope).toEqual(["alice"]);
			records.set(result.outputs.result.id, result.outputs.result);
			expect(Buffer.from(await store.read("alice", result.outputs.result)).toString()).toBe("approved");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("denies execution when authorization returns a non-boolean value", async () => {
		const { root, store } = await fixture();
		try {
			const executor = new TrustedProgramExecutor(
				{ test: program(root, "process.exit(0)") },
				{ store, authorize: async () => "false" as unknown as boolean },
			);
			const result = await executor.accept({ ...request(), parameters: { value: "safe" } });
			expect(result).toMatchObject({ state: "rejected", execution_ref: null });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not spawn when authorization is revoked during preparation", async () => {
		const { root, store } = await fixture();
		try {
			const marker = path.join(root, "spawned");
			let checks = 0;
			const executor = new TrustedProgramExecutor(
				{ test: program(root, "require('node:fs').writeFileSync(process.argv.at(-1), 'spawned')") },
				{ store, authorize: async () => ++checks === 1 },
			);
			const accepted = await executor.accept({ ...request(), parameters: { value: marker } });
			const result = await settled(executor, accepted.execution_ref!);
			expect(result.state).toBe("failed");
			await expect(fs.readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("passes metacharacters as inert argv data and publishes output", async () => {
		const { root, store, records } = await fixture();
		try {
			const marker = path.join(root, "injected");
			const value = `hello; touch ${marker} $(echo injected)`;
			const executor = new TrustedProgramExecutor(
				{ test: program(root, "require('node:fs').writeFileSync('result.txt', process.argv.at(-1))") },
				{ store, authorize: async () => true },
			);
			const accepted = await executor.accept({ ...request(), parameters: { value } });
			expect(accepted.state).toBe("accepted");
			const result = await settled(executor, accepted.execution_ref!);
			expect(result.state).toBe("succeeded");
			expect(result.fence).toBe("9007199254740993");
			records.set(result.outputs.result.id, result.outputs.result);
			expect(Buffer.from(await store.read("alice", result.outputs.result)).toString()).toBe(value);
			await expect(fs.readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a non-decimal fence before dispatch", async () => {
		const { root, store } = await fixture();
		try {
			const executor = new TrustedProgramExecutor(
				{ test: program(root, "process.exit(0)") },
				{ store, authorize: async () => true },
			);
			const accepted = await executor.accept({ ...request(), fence: "-1", parameters: { value: "safe" } });
			expect(accepted.state).toBe("rejected");
			expect(accepted.error).toContain("Invalid execution fence");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("fails when exit zero omits a required output", async () => {
		const { root, store } = await fixture();
		try {
			const executor = new TrustedProgramExecutor(
				{ test: program(root, "process.exit(0)") },
				{ store, authorize: async () => true },
			);
			const accepted = await executor.accept({ ...request(), parameters: { value: "safe" } });
			const result = await settled(executor, accepted.execution_ref!);
			expect(result.state).toBe("failed");
			expect(result.outcome).toBeNull();
			expect(result.error).toContain("Output result unavailable");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("validates structured program output before success while preserving exact immutable bytes", async () => {
		const { root, store, records } = await fixture();
		try {
			const schema = await publishSchema(store, records, {
				$schema: "https://json-schema.org/draft/2020-12/schema",
				$defs: { count: { type: "integer", minimum: 1 } },
				type: "object",
				properties: { count: { $ref: "#/$defs/count" }, label: { type: "string", maxLength: 1 } },
				required: ["count", "label"],
				additionalProperties: false,
			});
			const bytes = Buffer.from(' \n{ "label": "😀", "count": 2 }\n');
			const executor = new TrustedProgramExecutor(
				{ test: structuredProgram(root) },
				{ store, authorize: async () => true },
			);
			const accepted = await executor.accept(structuredRequest(schema, bytes));
			expect(accepted.state).toBe("accepted");
			const result = await settled(executor, accepted.execution_ref!);
			expect(result).toMatchObject({ state: "succeeded", outcome: "done", error: null });
			records.set(result.outputs.result.id, result.outputs.result);
			expect(await store.read("alice", result.outputs.result)).toEqual(bytes);
			expect(result.outputs.result.digest).toBe(`sha256:${Bun.SHA256.hash(bytes, "hex")}`);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ name: "malformed JSON", schema: true, bytes: Buffer.from("{") },
		{ name: "non-UTF8 JSON", schema: true, bytes: Uint8Array.from([0x22, 0xff, 0x22]) },
		{ name: "BOM-prefixed JSON", schema: true, bytes: Buffer.from("\ufeff{}") },
		{ name: "false schema", schema: false, bytes: Buffer.from("{}") },
		{ name: "no type coercion", schema: { type: "integer" }, bytes: Buffer.from('"2"') },
		{
			name: "no extra-key deletion",
			schema: { type: "object", additionalProperties: false },
			bytes: Buffer.from('{"extra":1}'),
		},
		{
			name: "no default insertion",
			schema: { type: "object", properties: { count: { default: 2 } }, required: ["count"] },
			bytes: Buffer.from("{}"),
		},
		{ name: "inherited names are not present", schema: { required: ["constructor"] }, bytes: Buffer.from("{}") },
		{ name: "nonfinite JSON number", schema: true, bytes: Buffer.from("1e400") },
		{
			name: "size limit before buffering for validation",
			schema: true,
			bytes: Buffer.from(JSON.stringify("x".repeat(1024))),
		},
	])("withholds succeeded state and downstream artifacts for $name", async ({ schema: definition, bytes }) => {
		const { root, store, records } = await fixture();
		try {
			const schema = await publishSchema(store, records, definition);
			const executor = new TrustedProgramExecutor(
				{ test: structuredProgram(root) },
				{ store, authorize: async () => true },
			);
			const accepted = await executor.accept(structuredRequest(schema, bytes));
			expect(accepted.state).toBe("accepted");
			const result = await settled(executor, accepted.execution_ref!);
			expect(result.state).toBe("failed");
			expect(result.outcome).toBeNull();
			expect(result.outputs).toEqual({});
			expect(result.error).not.toBeNull();
			expect(await fs.readdir(path.join(root, "store"))).toEqual([schema.id]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("honors a true schema for unmodified JSON scalar output", async () => {
		const { root, store, records } = await fixture();
		try {
			const schema = await publishSchema(store, records, true);
			const bytes = Buffer.from("  false \n");
			const executor = new TrustedProgramExecutor(
				{ test: structuredProgram(root) },
				{ store, authorize: async () => true },
			);
			const accepted = await executor.accept(structuredRequest(schema, bytes));
			const result = await settled(executor, accepted.execution_ref!);
			expect(result.state).toBe("succeeded");
			records.set(result.outputs.result.id, result.outputs.result);
			expect(await store.read("alice", result.outputs.result)).toEqual(bytes);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.each([Buffer.from("{"), Uint8Array.from([0xff]), Buffer.from("null")])(
		"rejects malformed schema artifact bytes before dispatch: %j",
		async bytes => {
			const { root, store, records } = await fixture();
			try {
				const schema = await store.publish("alice", bytes, { ...metadata, media_type: "application/schema+json" });
				records.set(schema.id, schema);
				const executor = new TrustedProgramExecutor(
					{ test: structuredProgram(root) },
					{ store, authorize: async () => true },
				);
				const accepted = await executor.accept(structuredRequest(schema, Buffer.from("{}")));
				expect(accepted).toMatchObject({ state: "rejected", execution_ref: null });
				expect(accepted.error).toContain("schema");
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it.each(["denied", "digest mismatch"] as const)(
		"rejects schema reads with %s before program dispatch",
		async mode => {
			const { root, store, records } = await fixture();
			try {
				const schema = await publishSchema(
					store,
					records,
					{ type: "object" },
					mode === "denied" ? ["bob"] : ["alice"],
				);
				if (mode === "digest mismatch") {
					await fs.chmod(path.join(root, "store", schema.id), 0o600);
					await fs.writeFile(path.join(root, "store", schema.id), '{"type":"string"}');
				}
				const marker = path.join(root, "spawned");
				const config = structuredProgram(root);
				config.argv = [
					{ literal: "-e" },
					{ literal: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')` },
				];
				const executor = new TrustedProgramExecutor({ test: config }, { store, authorize: async () => true });
				const candidate = structuredRequest(schema, Buffer.from("{}"));
				candidate.parameters = {};
				const accepted = await executor.accept(candidate);
				expect(accepted).toMatchObject({ state: "rejected", execution_ref: null });
				expect(accepted.error).toContain(mode === "denied" ? "Artifact read denied" : "Artifact digest mismatch");
				await expect(fs.readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it("rechecks schema read authorization after the program exits", async () => {
		const { root, store, records } = await fixture();
		try {
			const schema = await publishSchema(store, records, true);
			const marker = path.join(root, "revoke");
			const guarded = new LocalArtifactStore({
				directory: path.join(root, "store"),
				maxBytes: 1024,
				lookup: async value => records.get(value.id) ?? null,
				authorize: async (principal, action, scope) =>
					scope.includes(principal) &&
					!(action === "read" && scope.includes("schema") && (await Bun.file(marker).exists())),
			});
			records.set(schema.id, { ...schema, access_scope: ["alice", "schema"] });
			const config = structuredProgram(root);
			config.argv[1] = {
				literal: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'revoke'); require('node:fs').writeFileSync('result.txt', '{}')`,
			};
			const executor = new TrustedProgramExecutor({ test: config }, { store: guarded, authorize: async () => true });
			const accepted = await executor.accept(structuredRequest(schema, Buffer.from("{}")));
			expect(accepted.state).toBe("accepted");
			const result = await settled(executor, accepted.execution_ref!);
			expect(result).toMatchObject({ state: "failed", outcome: null, outputs: {} });
			expect(result.error).toContain("Artifact read denied");
			expect(await fs.readdir(path.join(root, "store"))).toEqual([schema.id]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ code: 0, outcome: "pass" },
		{ code: 1, outcome: "revise" },
	])("routes workspace check exit $code and publishes its evidence", async ({ code, outcome }) => {
		const { root, store, records } = await fixture();
		try {
			const config = program(root, `console.log("observed check"); process.exit(${code})`);
			config.argv = config.argv.slice(0, 2);
			config.outputs = { evidence: { filename: "evidence.txt", media_type: "text/plain" } };
			config.outcome = "pass";
			config.workspaceCheck = { cwd: root, label: "test", failureOutcome: "revise" };
			const executor = new TrustedProgramExecutor({ test: config }, { store, authorize: async () => true });
			const accepted = await executor.accept({
				...request(),
				outputs: { evidence: { media_type: "text/plain", required: true } },
			});
			expect(accepted.state).toBe("accepted");
			const result = await settled(executor, accepted.execution_ref!);
			expect(result).toMatchObject({ state: "succeeded", outcome });
			const evidence = result.outputs.evidence;
			expect(evidence).toBeDefined();
			records.set(evidence.id, evidence);
			const content = new TextDecoder().decode(await store.read("alice", evidence));
			expect(content).toContain(`Exit code: ${code}`);
			expect(content).toContain("observed check");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ type: "object", unevaluatedProperties: false },
		{ type: "array", unevaluatedItems: false },
		{ type: "string", format: "email" },
		{ contentEncoding: "base64" },
		{ customAssertion: true },
		{ anyOf: [true, { unevaluatedProperties: false }] },
		{ $defs: { unused: { format: "date-time" } } },
		{ $ref: "#/$defs/value", $defs: { value: true }, type: "string" },
		{ $ref: "#" },
		{ $dynamicRef: "#node" },
		{ $schema: "http://json-schema.org/draft-07/schema#" },
		{ multipleOf: 0.1 },
		{ type: "bogus" },
		{ patternProperties: { "[": true } },
		{ allOf: [] },
		{ exclusiveMinimum: true },
	])("rejects malformed or unsupported schema %j even for an optional absent output", async definition => {
		const { root, store, records } = await fixture();
		try {
			const schema = await publishSchema(store, records, definition);
			const executor = new TrustedProgramExecutor(
				{ test: structuredProgram(root) },
				{ store, authorize: async () => true },
			);
			const candidate = structuredRequest(schema, Buffer.from("{}"));
			candidate.outputs.result.required = false;
			const accepted = await executor.accept(candidate);
			expect(accepted).toMatchObject({ state: "rejected", execution_ref: null });
			expect(accepted.error).toContain("Invalid Graph output schema");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GraphArtifactRegistry, type ArtifactPublication } from "../src/graph/artifacts";

const publication: ArtifactPublication = {
	media_type: "text/plain",
	producer_attempt_id: "attempt-1",
	source_ref: null,
	access_scope: ["alice"],
};
const authorize = async (principal: string, _action: "read" | "publish", scope: readonly string[]) =>
	scope.includes(principal);

describe("profile artifact registry", () => {
	it("persists exact references, provenance and authorized scope across reopen", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-ledger-"));
		try {
			const registry = new GraphArtifactRegistry({ root, maxBytes: 1024, authorize });
			const artifact = await registry.store.publish("alice", Buffer.from("hello"), publication);
			await registry.register([{ artifact, expected: publication }]);
			registry.close();
			const reopened = new GraphArtifactRegistry({ root, maxBytes: 1024, authorize });
			try {
				expect(reopened.lookup(artifact)).toMatchObject({ ...artifact, expires_at: null });
				expect(Buffer.from(await reopened.store.read("alice", artifact)).toString()).toBe("hello");
				await expect(reopened.store.read("bob", artifact)).rejects.toMatchObject({ code: "permission_denied" });
				expect(() => reopened.lookup({ id: artifact.id, digest: "sha256:forged" })).toThrow();
				const otherRoot = path.join(root, "other");
				const other = new GraphArtifactRegistry({ root: otherRoot, maxBytes: 1024, authorize });
				try {
					expect(other.lookup(artifact)).toBeNull();
				} finally {
					other.close();
				}
			} finally {
				reopened.close();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects forged producer, scope, content and immutable identity changes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-ledger-"));
		const registry = new GraphArtifactRegistry({ root, maxBytes: 1024, authorize });
		try {
			const artifact = await registry.store.publish("alice", Buffer.from("hello"), publication);
			await expect(
				registry.register([{ artifact: { ...artifact, access_scope: ["bob"] }, expected: publication }]),
			).rejects.toMatchObject({ code: "invalid" });
			await expect(
				registry.register([{ artifact: { ...artifact, producer_attempt_id: "forged" }, expected: publication }]),
			).rejects.toMatchObject({ code: "invalid" });
			await registry.register([{ artifact, expected: publication }]);
			await registry.register([{ artifact, expected: publication }]);
			await expect(
				registry.register([
					{ artifact: { ...artifact, media_type: "other" }, expected: { ...publication, media_type: "other" } },
				]),
			).rejects.toMatchObject({ code: "invalid" });
			await fs.chmod(path.join(root, "artifacts", artifact.id), 0o600);
			await fs.writeFile(path.join(root, "artifacts", artifact.id), "jello");
			await expect(registry.store.read("alice", artifact)).rejects.toMatchObject({ code: "digest_mismatch" });
			await expect(registry.register([{ artifact, expected: publication }])).rejects.toMatchObject({
				code: "digest_mismatch",
			});
		} finally {
			registry.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("handles imports, expiry, unavailable objects and missing files", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-ledger-"));
		const registry = new GraphArtifactRegistry({ root, maxBytes: 1024, authorize });
		try {
			const imported = {
				...publication,
				producer_attempt_id: null,
				source_ref: { id: "external", digest: "sha256:source" },
			};
			const expired = await registry.store.publish("alice", Buffer.from("import"), imported);
			await registry.register([{ artifact: expired, expected: imported, expires_at: "2000-01-01T00:00:00.000Z" }]);
			expect(registry.lookup(expired)?.source_ref).toEqual(imported.source_ref);
			await expect(registry.store.read("alice", expired)).rejects.toMatchObject({ code: "expired" });
			const unknown = await registry.store.publish("alice", Buffer.from("unknown"), publication);
			await registry.register([{ artifact: unknown, expected: publication }]);
			registry.markUnavailable(unknown, "unknown");
			await expect(registry.store.read("alice", unknown)).rejects.toMatchObject({ code: "unknown" });
			const missing = await registry.store.publish("alice", Buffer.from("gone"), publication);
			await fs.unlink(path.join(root, "artifacts", missing.id));
			await expect(registry.register([{ artifact: missing, expected: publication }])).rejects.toMatchObject({
				code: "missing",
			});
			expect(registry.lookup(missing)).toBeNull();
			const lost = await registry.store.publish("alice", Buffer.from("lost"), publication);
			await registry.register([{ artifact: lost, expected: publication }]);
			await fs.unlink(path.join(root, "artifacts", lost.id));
			await expect(registry.store.read("alice", lost)).rejects.toMatchObject({ code: "missing" });
		} finally {
			registry.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("withholds bytes when reconciliation withdraws availability during final authorization", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-ledger-"));
		let withdraw: (() => void) | undefined;
		const registry = new GraphArtifactRegistry({
			root,
			maxBytes: 1024,
			authorize: async (principal, action, scope) => {
				if (action === "read") withdraw?.();
				return authorize(principal, action, scope);
			},
		});
		try {
			const artifact = await registry.store.publish("alice", Buffer.from("secret"), publication);
			await registry.register([{ artifact, expected: publication }]);
			let reads = 0;
			withdraw = () => {
				if (++reads === 2) registry.markUnavailable(artifact, "missing");
			};
			await expect(registry.store.read("alice", artifact)).rejects.toMatchObject({ code: "missing" });
		} finally {
			registry.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("withholds bytes when expiry passes during final authorization", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-ledger-"));
		const expiry = Date.parse("2100-01-01T00:00:00.000Z");
		let now = expiry - 1;
		let reads = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const registry = new GraphArtifactRegistry({
			root,
			maxBytes: 1024,
			authorize: async (principal, action, scope) => {
				if (action === "read" && ++reads === 2) now = expiry;
				return authorize(principal, action, scope);
			},
		});
		try {
			const artifact = await registry.store.publish("alice", Buffer.from("secret"), publication);
			await registry.register([{ artifact, expected: publication, expires_at: new Date(expiry).toISOString() }]);
			await expect(registry.store.read("alice", artifact)).rejects.toMatchObject({ code: "expired" });
		} finally {
			clock.mockRestore();
			registry.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rolls back batches and participates in the host transaction", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-ledger-"));
		const db = new Database(path.join(root, "graphs.sqlite"));
		const registry = new GraphArtifactRegistry({ root, maxBytes: 1024, authorize, database: db });
		try {
			const first = await registry.store.publish("alice", Buffer.from("first"), publication);
			const second = await registry.store.publish("alice", Buffer.from("second"), publication);
			const prepared = await registry.prepareRegistration([
				{ artifact: first, expected: publication },
				{ artifact: second, expected: publication },
			]);
			expect(() =>
				db.transaction(() => {
					registry.commitPrepared(prepared);
					throw new Error("rollback");
				})(),
			).toThrow("rollback");
			expect(registry.lookup(first)).toBeNull();
			expect(registry.lookup(second)).toBeNull();
			db.transaction(() => registry.commitPrepared(prepared))();
			expect(registry.lookup(first)?.digest).toBe(first.digest);
			expect(registry.lookup(second)?.digest).toBe(second.digest);
			const third = await registry.store.publish("alice", Buffer.from("third"), publication);
			const conflicting = { ...first, media_type: "application/json" };
			await expect(
				registry.register([
					{ artifact: third, expected: publication },
					{ artifact: conflicting, expected: { ...publication, media_type: "application/json" } },
				]),
			).rejects.toMatchObject({ code: "invalid" });
			expect(registry.lookup(third)).toBeNull();
		} finally {
			registry.close();
			db.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

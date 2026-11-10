import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphGrants, type GraphGrantScope, type GraphGrantUse } from "../src/graph/grants";
import { GraphRunStore, type GraphStartRequest } from "../src/graph/store";

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const executor = {
	kind: "program" as const,
	id: "registered-program",
	configuration: { id: "config", digest: hash("a") },
};
const scope: GraphGrantScope = {
	graph_id: "graph",
	definition_revision: "1",
	definition_digest: hash("b"),
	executors: [executor],
};
const use: GraphGrantUse = {
	owner: "alice",
	graph_id: "graph",
	definition_revision: "1",
	definition_digest: hash("b"),
	executor,
};

function expectCode(action: () => unknown, code: string) {
	try {
		action();
	} catch (error) {
		expect(error).toMatchObject({ code });
		return;
	}
	throw new Error(`Expected ${code}`);
}

function ledger(db: Database, current: () => boolean = () => true, allowed: () => boolean = () => true) {
	return new GraphGrants({
		database: db,
		authorize: (_db, _action, principal, grant) => allowed() && principal === grant.owner,
		definitionCurrent: () => current(),
	});
}

function assertUsable(db: Database, grants: GraphGrants, ...args: Parameters<GraphGrants["assertUsable"]>): void {
	db.transaction(() => grants.assertUsable(...args)).immediate();
}

describe("Graph owner grants", () => {
	it("persists revocation and refuses to replay issuance after a restart", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-grants-"));
		const file = path.join(dir, "grants.sqlite");
		let db = new Database(file);
		try {
			let grants = ledger(db);
			const ref = grants.issue("alice", "request-1", scope);
			expect(grants.issue("alice", "request-1", scope)).toEqual(ref);
			assertUsable(db, grants, "alice", ref, use);
			grants.revoke("alice", ref);
			db.close();
			db = new Database(file);
			grants = ledger(db);
			expectCode(() => assertUsable(db, grants, "alice", ref, use), "revoked");
			expectCode(() => grants.issue("alice", "request-1", scope), "revoked");
			grants.revoke("alice", ref);
			const replacement = grants.issue("alice", "request-2", scope);
			expect(replacement.id).not.toBe(ref.id);
			assertUsable(db, grants, "alice", replacement, use);
			expectCode(() => assertUsable(db, grants, "alice", ref, use), "revoked");
		} finally {
			db.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("binds owner, exact definition and explicit executor configuration", () => {
		const db = new Database(":memory:");
		try {
			const grants = ledger(db);
			const ref = grants.issue("alice", "request", scope);
			for (const changed of [
				{ ...use, owner: "bob" },
				{ ...use, graph_id: "other" },
				{ ...use, definition_revision: "2" },
				{ ...use, definition_digest: hash("c") },
				{ ...use, executor: { ...executor, id: "other" } },
				{ ...use, executor: { ...executor, configuration: { ...executor.configuration, digest: hash("c") } } },
			])
				expectCode(() => assertUsable(db, grants, "alice", ref, changed), "permission_denied");
			expectCode(() => assertUsable(db, grants, "bob", ref, use), "permission_denied");
			expectCode(() => grants.revoke("bob", ref), "permission_denied");
			expectCode(() => grants.issue("alice", "request", { ...scope, definition_revision: "2" }), "conflict");
			expectCode(() => assertUsable(db, grants, "alice", { ...ref, digest: hash("d") }, use), "conflict");
		} finally {
			db.close();
		}
	});

	it("checks current definition and trusted authority again, failing closed", () => {
		const db = new Database(":memory:");
		try {
			let current = true;
			let allowed = true;
			const grants = ledger(
				db,
				() => current,
				() => allowed,
			);
			const ref = grants.issue("alice", "request", scope);
			current = false;
			expectCode(() => assertUsable(db, grants, "alice", ref, use), "conflict");
			expectCode(() => grants.issue("alice", "request", scope), "conflict");
			expectCode(() => grants.issue("alice", "new", scope), "conflict");
			current = true;
			allowed = false;
			expectCode(() => assertUsable(db, grants, "alice", ref, use), "permission_denied");
			expectCode(() => grants.revoke("alice", ref), "permission_denied");
			expectCode(() => grants.issue("alice", "request", scope), "permission_denied");
			const nonBoolean = new GraphGrants({
				database: db,
				authorize: () => 1 as unknown as boolean,
				definitionCurrent: () => true,
			});
			expectCode(() => assertUsable(db, nonBoolean, "alice", ref, use), "permission_denied");
		} finally {
			db.close();
		}
	});

	it("checks the grant inside a caller-owned dispatch transaction and rolls back denied dispatch", () => {
		const db = new Database(":memory:");
		try {
			const grants = ledger(db);
			db.exec("CREATE TABLE dispatches (id TEXT PRIMARY KEY)");
			const ref = grants.issue("alice", "request", scope);
			// A check detached from dispatch cannot protect against revocation before dispatch.
			expectCode(() => grants.assertUsable("alice", ref, use), "permission_denied");
			const dispatch = db.transaction((id: string) => {
				db.query("INSERT INTO dispatches VALUES (?)").run(id);
				grants.assertUsable("alice", ref, use);
			});
			dispatch.immediate("first");
			grants.revoke("alice", ref);
			expectCode(() => dispatch.immediate("second"), "revoked");
			expect(db.query("SELECT id FROM dispatches ORDER BY id").all()).toEqual([{ id: "first" }]);
		} finally {
			db.close();
		}
	});

	it("rejects malformed scopes and detects stored grant tampering", () => {
		const db = new Database(":memory:");
		try {
			const grants = ledger(db);
			expectCode(() => grants.issue("alice", "empty", { ...scope, executors: [] }), "invalid");
			expectCode(() => grants.issue("alice", "duplicate", { ...scope, executors: [executor, executor] }), "invalid");
			expectCode(() => grants.issue("alice", "bad-revision", { ...scope, definition_revision: "01" }), "invalid");
			expectCode(
				() => grants.issue("alice", "bad-digest", { ...scope, definition_digest: "sha256:bad" }),
				"invalid",
			);
			const ref = grants.issue("alice", "valid", scope);
			db.query("UPDATE graph_owner_grants SET data=? WHERE id=?").run("{}", ref.id);
			expectCode(() => assertUsable(db, grants, "alice", ref, use), "conflict");
		} finally {
			db.close();
		}
	});
});

it("admits a grant in the Run transaction but never dispatches without containment", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-grant-run-"));
	const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
	const store = new GraphRunStore(limits, root);
	try {
		const content = `---
format: omp.graph/v1
name: grant-test
members: {}
nodes:
  task:
    kind: program
    executor: registered-program
    task: '#task'
---
## task
Work.
`;
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const grants = store.configureGrants((_db, _action, principal, grant) => principal === grant.owner);
		const grant = grants.issue("alice", "grant", {
			graph_id: definition.graph_id,
			definition_revision: definition.revision,
			definition_digest: definition.digest,
			executors: [executor],
		});
		const request: GraphStartRequest = {
			version: 1,
			request_key: "start",
			operation: "start",
			target_id: definition.graph_id,
			if_revision: definition.revision,
			payload: { inputs: {}, authorization_ref: grant },
		};
		const prepared = {
			graph_id: definition.graph_id,
			definition_revision: definition.revision,
			definition_digest: definition.digest,
			authorization_ref: grant,
			inputs: {},
			members: {},
			executors: { "registered-program": executor.configuration },
		};
		expect(store.start(request, prepared).error?.code).toBe("permission_denied");
		expect(store.startGranted("bob", request, prepared).error?.code).toBe("permission_denied");
		expect(
			store.startGranted("alice", request, {
				...prepared,
				executors: { "registered-program": { ...executor.configuration, digest: hash("c") } },
			}).error?.code,
		).toBe("permission_denied");
		const started = store.startGranted("alice", request, prepared);
		expect(started.state).toBe("accepted");
		expect(store.startGranted("alice", request, prepared)).toEqual(started);
		const owner = store.claimHost()!;
		expect(store.schedule(started.target_id!, owner.owner_id, owner.epoch).action?.type).toBe("ready");
		const held = store.schedule(started.target_id!, owner.owner_id, owner.epoch);
		expect(held.action?.type).toBe("hold");
		expect(held.intent).toBeNull();
		expect(store.getDispatchIntents(started.target_id!)).toEqual([]);
		grants.revoke("alice", grant);
		expect(store.startGranted("alice", request, prepared).error?.code).toBe("permission_denied");
		expect(store.startGranted("alice", { ...request, request_key: "later" }, prepared).error?.code).toBe(
			"permission_denied",
		);
	} finally {
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

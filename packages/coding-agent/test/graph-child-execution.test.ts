import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	createChildExecution,
	installChildExecutionSchema,
	reconcileChildExecution,
	recoverChildExecutions,
	type ChildExecutionHost,
	type ChildIdentity,
} from "../src/graph/child-execution";
import type { GraphDefinition, GraphMember } from "../src/graph/contracts";

const limits = { maxBytes: 32768, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const member: GraphMember = {
	bot: { id: "bot", digest: "sha256:abc" },
	model: "model",
	base: "omp-default",
	duty: "code-only",
	permissions: { read: ["src"], write: ["src"], execute: [] },
};
const parent: GraphDefinition = {
	format: "omp.graph/v1",
	name: "parent",
	members: { owner: member },
	nodes: {
		build: {
			kind: "subgraph",
			task: "#task",
			member: "owner",
			writes: ["src"],
			child_policy: { kinds: ["bot"], max_nodes: 2, max_parallel: 2 },
		},
	},
	policy: { max_parallel: 2 },
};
const child: GraphDefinition = {
	format: "omp.graph/v1",
	name: "child",
	members: { owner: member },
	nodes: { work: { kind: "bot", task: "#task", member: "owner", writes: ["src"] } },
};
const source = (definition: GraphDefinition) => `---\n${JSON.stringify(definition)}\n---\n## task\nImplement.\n`;
const identity: ChildIdentity = { run_id: "parent", invocation_id: "invocation", attempt_id: "attempt", fence: "1" };
const isolation = { mode: "serial" as const, description: "Serialized child writers; no OS sandbox" };

function fixture() {
	const db = new Database(":memory:");
	installChildExecutionSchema(db);
	db.exec(
		"CREATE TABLE child_runs (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE completions (id TEXT PRIMARY KEY)",
	);
	let active: "active" | "cancelling" | "inactive" = "active";
	let reserved = true;
	let aggregate = false;
	let isolationEnforced = true;
	const host: ChildExecutionHost = {
		parent: (_db, current) =>
			current.fence === "1"
				? {
						state: active,
						reserved,
						authority: { parent, parentNode: "build", limits },
					}
				: null,
		authorizeIsolation: () => isolationEnforced,
		createRun: transaction => {
			transaction.query("INSERT INTO child_runs VALUES (?,?)").run("child", "running");
			return "child";
		},
		cancelRun: (transaction, id) => {
			transaction.query("UPDATE child_runs SET state='cancelled' WHERE id=?").run(id);
		},
		childState: (transaction, id) => {
			const row = transaction.query("SELECT state FROM child_runs WHERE id=?").get(id);
			if (!row || typeof row !== "object" || !("state" in row)) return "unknown";
			switch (row.state) {
				case "running":
				case "succeeded":
				case "failed":
				case "held":
				case "cancelled":
					return row.state;
				default:
					return "unknown";
			}
		},
		verifyAggregation: () => (aggregate ? { result: { id: "artifact", digest: "sha256:result" } } : null),
		completeParent: transaction => {
			transaction.query("INSERT INTO completions VALUES (?)").run("parent");
			return true;
		},
	};
	return {
		db,
		host,
		setActive: (value: typeof active) => {
			active = value;
		},
		setReserved: (value: boolean) => {
			reserved = value;
		},
		setIsolationEnforced: (value: boolean) => {
			isolationEnforced = value;
		},
		setAggregate: (value: boolean) => {
			aggregate = value;
		},
	};
}

describe("durable child execution", () => {
	it("validates before creating and requires the existing parent reservation", () => {
		const { db, host, setReserved } = fixture();
		setReserved(false);
		expect(createChildExecution(db, host, identity, source(child), isolation).status).toBe("rejected");
		setReserved(true);
		const invalid = { ...child, budgets: { escape: { limit: 1, scope: "run" as const } } };
		expect(createChildExecution(db, host, identity, source(invalid), isolation).status).toBe("rejected");
		expect(db.query("SELECT * FROM child_runs").all()).toEqual([]);
		db.close();
	});

	it("reuses one durable child across retries and rejects changed candidates", () => {
		const { db, host } = fixture();
		expect(createChildExecution(db, host, identity, source(child), isolation).status).toBe("created");
		expect(
			createChildExecution(db, host, { ...identity, attempt_id: "retry" }, source(child), isolation).status,
		).toBe("existing");
		expect(createChildExecution(db, host, identity, source({ ...child, name: "other" }), isolation).status).toBe(
			"rejected",
		);
		expect(db.query("SELECT * FROM child_runs").all()).toHaveLength(1);
		db.close();
	});

	it("retains the requested parent and isolation across mutating authorization callbacks", () => {
		const { db, host } = fixture();
		const requestedIdentity = { ...identity };
		const requestedIsolation = { ...isolation };
		host.authorizeIsolation = (_transaction, current, disclosure) => {
			current.run_id = "different-parent";
			disclosure.description = "Unapproved isolation";
			return true;
		};
		try {
			const created = createChildExecution(db, host, requestedIdentity, source(child), requestedIsolation);
			expect(created.status).toBe("created");
			if (created.status === "rejected") throw new Error("Unexpected rejection");
			expect(created.record.parent_run_id).toBe(identity.run_id);
			expect(created.record.isolation).toEqual(isolation);
			expect(reconcileChildExecution(db, host, { ...identity })?.state).toBe("running");
			expect(createChildExecution(db, host, { ...identity }, source(child), { ...isolation }).status).toBe(
				"existing",
			);
			expect(db.query("SELECT parent_run_id FROM graph_child_executions").all()).toEqual([
				{ parent_run_id: identity.run_id },
			]);
		} finally {
			db.close();
		}
	});

	it("rejects parallel execution under a serial-only host", () => {
		const { db, host } = fixture();
		const parallel = { ...child, policy: { max_parallel: 2 } };
		expect(createChildExecution(db, host, identity, source(parallel), isolation).status).toBe("rejected");
		expect(db.query("SELECT * FROM child_runs").all()).toEqual([]);
		db.close();
	});

	it("requires real isolation enforcement and cancels if that authority is revoked", () => {
		const { db, host, setIsolationEnforced, setAggregate } = fixture();
		setIsolationEnforced(false);
		expect(createChildExecution(db, host, identity, source(child), isolation).status).toBe("rejected");
		expect(db.query("SELECT * FROM child_runs").all()).toEqual([]);
		setIsolationEnforced(true);
		expect(createChildExecution(db, host, identity, source(child), isolation).status).toBe("created");
		setIsolationEnforced(false);
		expect(createChildExecution(db, host, identity, source(child), isolation).status).toBe("rejected");
		setAggregate(true);
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
		setIsolationEnforced(true);
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
		expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		db.close();
	});

	it("rolls back a child run if creation fails before containment is committed", () => {
		const { db, host } = fixture();
		const create = host.createRun;
		host.createRun = (transaction, input) => {
			create(transaction, input);
			throw new Error("failed");
		};
		expect(() => createChildExecution(db, host, identity, source(child), isolation)).toThrow();
		expect(db.query("SELECT * FROM child_runs").all()).toEqual([]);
		db.close();
	});

	it("requires verified aggregation and completes the parent once despite duplicate notifications", () => {
		const { db, host, setAggregate } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		db.query("UPDATE child_runs SET state='succeeded'").run();
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("held");
		expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		setAggregate(true);
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("completed");
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("completed");
		expect(db.query("SELECT * FROM completions").all()).toHaveLength(1);
		db.close();
	});

	it("withholds success on failure and propagates parent cancellation", () => {
		const { db, host, setActive, setAggregate } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		db.query("UPDATE child_runs SET state='failed'").run();
		setAggregate(true);
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("held");
		setActive("cancelling");
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
		expect(db.query("SELECT state FROM child_runs").get()).toEqual({ state: "failed" });
		expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		db.close();
	});

	it("settles parent cancellation without rewriting or cancelling a successful child", () => {
		const { db, host, setActive, setAggregate } = fixture();
		try {
			createChildExecution(db, host, identity, source(child), isolation);
			db.query("UPDATE child_runs SET state='succeeded'").run();
			setActive("cancelling");
			setAggregate(true);
			host.cancelRun = () => {
				throw new Error("Terminal child must retain its historical result");
			};
			expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
			expect(db.query("SELECT state FROM child_runs").get()).toEqual({ state: "succeeded" });
			expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("retries durable cancellation after reactivation until the child confirms it", () => {
		const { db, host, setActive, setAggregate } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		let requests = 0;
		host.cancelRun = () => {
			requests++;
		};
		setActive("cancelling");
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelling");
		setActive("active");
		setAggregate(true);
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelling");
		expect(requests).toBe(2);
		expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		db.query("UPDATE child_runs SET state='cancelled'").run();
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
		expect(requests).toBe(2);
		db.close();
	});

	it("rolls back cancellation and its containment state together on failure", () => {
		const { db, host, setActive } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		const cancel = host.cancelRun;
		host.cancelRun = (transaction, id) => {
			cancel(transaction, id);
			throw new Error("failed");
		};
		setActive("cancelling");
		expect(() => reconcileChildExecution(db, host, identity)).toThrow();
		expect(db.query("SELECT state FROM child_runs").get()).toEqual({ state: "running" });
		host.cancelRun = cancel;
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
		db.close();
	});

	it("cancels a child when its parent reservation is no longer proven", () => {
		const { db, host, setReserved, setAggregate } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		setReserved(false);
		setAggregate(true);
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
		setReserved(true);
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("cancelled");
		expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		db.close();
	});

	it("does not complete a parent on a non-boolean completion result", () => {
		const { db, host, setAggregate } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		db.query("UPDATE child_runs SET state='succeeded'").run();
		setAggregate(true);
		host.completeParent = () => "accepted" as unknown as boolean;
		expect(reconcileChildExecution(db, host, identity)?.state).toBe("held");
		db.close();
	});

	it("rolls back partial parent completion when the host rejects it, then permits a successful retry", () => {
		for (const result of [false, "accepted" as unknown as boolean]) {
			const { db, host, setAggregate } = fixture();
			createChildExecution(db, host, identity, source(child), isolation);
			db.query("UPDATE child_runs SET state='succeeded'").run();
			setAggregate(true);
			const complete = host.completeParent;
			host.completeParent = transaction => {
				transaction.query("INSERT INTO completions VALUES (?)").run("partial");
				return result;
			};
			expect(reconcileChildExecution(db, host, identity)?.state).toBe("held");
			expect(db.query("SELECT * FROM completions").all()).toEqual([]);
			host.completeParent = complete;
			expect(reconcileChildExecution(db, host, identity)?.state).toBe("completed");
			expect(db.query("SELECT * FROM completions").all()).toEqual([{ id: "parent" }]);
			db.close();
		}
	});

	it("rolls back parent completion and propagates unexpected errors", () => {
		const { db, host, setAggregate } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		db.query("UPDATE child_runs SET state='succeeded'").run();
		setAggregate(true);
		host.completeParent = transaction => {
			transaction.query("INSERT INTO completions VALUES (?)").run("partial");
			throw new Error("completion failed");
		};
		expect(() => reconcileChildExecution(db, host, identity)).toThrow("completion failed");
		expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		db.close();
	});

	it("recovers lost notifications with a current parent identity and skips terminal children", () => {
		const { db, host, setAggregate } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		db.query("UPDATE child_runs SET state='succeeded'").run();
		setAggregate(true);
		const recovered = recoverChildExecutions(db, host, () => identity);
		expect(recovered.reconciled.map(record => record.state)).toEqual(["completed"]);
		expect(recovered.unresolved).toEqual([]);
		expect(
			recoverChildExecutions(db, host, () => {
				throw new Error("terminal child must not resolve");
			}),
		).toEqual({ reconciled: [], unresolved: [] });
		expect(db.query("SELECT * FROM completions").all()).toHaveLength(1);
		db.close();
	});

	it("reports missing, mismatched and stale parent identities without mutating children", () => {
		const { db, host, setActive } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		setActive("cancelling");
		const unresolved = [{ run_id: identity.run_id, invocation_id: identity.invocation_id }];
		for (const resolved of [null, { ...identity, invocation_id: "other" }, { ...identity, fence: "stale" }]) {
			expect(recoverChildExecutions(db, host, () => resolved)).toEqual({ reconciled: [], unresolved });
		}
		expect(db.query("SELECT state FROM child_runs").get()).toEqual({ state: "running" });
		expect(recoverChildExecutions(db, host, () => identity).reconciled[0].state).toBe("cancelled");
		db.close();
	});

	it("checks owner fencing inside creation and reconciliation transactions before host callbacks", () => {
		const { db, host } = fixture();
		const rejectOwner = () => {
			db.query("INSERT INTO completions VALUES (?)").run("guard-write");
			throw new Error("stale owner");
		};
		expect(() => createChildExecution(db, host, identity, source(child), isolation, rejectOwner)).toThrow(
			"stale owner",
		);
		expect(db.query("SELECT * FROM child_runs").all()).toEqual([]);
		expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		createChildExecution(db, host, identity, source(child), isolation);
		db.query("UPDATE child_runs SET state='succeeded'").run();
		expect(() => reconcileChildExecution(db, host, identity, rejectOwner)).toThrow("stale owner");
		expect(db.query("SELECT * FROM completions").all()).toEqual([]);
		expect(db.query("SELECT state FROM child_runs").get()).toEqual({ state: "succeeded" });
		db.close();
	});

	it("rejects stale fences for both creation and reconciliation", () => {
		const { db, host } = fixture();
		createChildExecution(db, host, identity, source(child), isolation);
		const stale = { ...identity, fence: "old" };
		expect(createChildExecution(db, host, stale, source(child), isolation).status).toBe("rejected");
		expect(reconcileChildExecution(db, host, stale)).toBeNull();
		db.close();
	});
});

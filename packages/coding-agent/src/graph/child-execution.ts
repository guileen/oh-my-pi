import type { Database } from "bun:sqlite";
import { validateChildGraph, type ChildGraphAuthority } from "./child-policy";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import type { GraphDefinition } from "./contracts";
import type { GraphIssue } from "./validation-types";

export interface ChildParentAuthority {
	state: "active" | "held" | "cancelling" | "inactive";
	reserved: boolean;
	authority: ChildGraphAuthority;
}

/** All operations on this interface run synchronously inside the coordinator's SQLite
 * transaction, on the same connection. It is trusted host code, not graph content. */
export interface ChildExecutionHost {
	/** Authenticate the current fenced attempt and return its frozen authority. `reserved`
	 * must prove that the parent invocation's budget consumption was committed; it must
	 * not reserve a second, child-local budget. */
	parent(db: Database, identity: ChildIdentity): ChildParentAuthority | null;
	/** Prove the requested execution mode is actually enforced for this child. Serial
	 * means writers are serialized across all relevant executions, not merely within
	 * this graph; isolated requires the exact approved baseline and real isolation. */
	authorizeIsolation(db: Database, identity: ChildIdentity, isolation: ChildIsolation): boolean;
	/** Must create a real durable child run in this transaction, inheriting the parent's
	 * frozen bindings, authorization and budget ownership. Never dispatch from here. */
	createRun(
		db: Database,
		input: {
			identity: ChildIdentity;
			source: string;
			definition: GraphDefinition;
			isolation: ChildIsolation;
		},
	): string;
	/** Request cancellation durably in the same transaction; external cancellation is
	 * driven by the normal host outbox. This operation must be idempotent. */
	cancelRun(db: Database, childRunId: string): void;
	/** Return durable scheduler state, not a branch's self-report. */
	childState(db: Database, childRunId: string): "running" | "succeeded" | "failed" | "held" | "cancelled" | "unknown";
	/** Verify mandatory results and integration, returning only immutable parent outputs.
	 * This must check actual integration evidence, not a model's assertion. */
	verifyAggregation(db: Database, childRunId: string, identity: ChildIdentity): Record<string, GraphRef> | null;
	/** Complete the current parent attempt transactionally; return false if it is stale.
	 * Completion must be idempotent and enforce the normal parent output contract.
	 * Writes made by this callback are rolled back unless it returns exactly true. */
	completeParent(db: Database, identity: ChildIdentity, outputs: Record<string, GraphRef>): boolean;
}

export interface ChildIdentity {
	run_id: string;
	invocation_id: string;
	attempt_id: string;
	fence: string;
}

/** Trusted recovery of existing work; never authorizes a new child dispatch. */
export interface ChildExecutionRecovery {
	host: ChildExecutionHost;
	resolveIdentity(runId: string, invocationId: string): ChildIdentity | null;
}

/** A trusted host must provide the enforcement behind this disclosure. Serial execution
 * avoids concurrent child writers but is not a sandbox or isolation from other processes. */
export type ChildIsolation =
	| { mode: "serial"; description: string }
	| { mode: "isolated"; description: string; baseline: GraphRef };

export interface ChildExecutionRecord {
	parent_run_id: string;
	parent_invocation_id: string;
	child_run_id: string;
	source: string;
	isolation: ChildIsolation;
	state: "running" | "cancelling" | "cancelled" | "held" | "completed";
}

export type ChildCreateResult =
	| { status: "created" | "existing"; record: ChildExecutionRecord }
	| { status: "rejected"; issues: GraphIssue[] };

/** Install alongside the graph schema under the graph store's existing schema lock. */
export function installChildExecutionSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS graph_child_executions (
		parent_run_id TEXT NOT NULL,
		parent_invocation_id TEXT NOT NULL,
		child_run_id TEXT NOT NULL UNIQUE,
		data TEXT NOT NULL,
		PRIMARY KEY(parent_run_id,parent_invocation_id)
	)`);
}

function get(db: Database, identity: ChildIdentity): ChildExecutionRecord | null {
	const row = db
		.query("SELECT data FROM graph_child_executions WHERE parent_run_id=? AND parent_invocation_id=?")
		.get(identity.run_id, identity.invocation_id) as { data: string } | null;
	return row ? (JSON.parse(row.data) as ChildExecutionRecord) : null;
}
function save(db: Database, record: ChildExecutionRecord): void {
	db.query("UPDATE graph_child_executions SET data=? WHERE parent_run_id=? AND parent_invocation_id=?").run(
		JSON.stringify(record),
		record.parent_run_id,
		record.parent_invocation_id,
	);
}
function validIdentity(identity: ChildIdentity): boolean {
	return [identity.run_id, identity.invocation_id, identity.attempt_id, identity.fence].every(
		value => typeof value === "string" && value.length > 0,
	);
}
function validIsolation(value: ChildIsolation): boolean {
	return (
		!!value &&
		typeof value.description === "string" &&
		value.description.trim().length > 0 &&
		(value.mode === "serial" ||
			(value.mode === "isolated" &&
				!!value.baseline &&
				typeof value.baseline.id === "string" &&
				!!value.baseline.id &&
				typeof value.baseline.digest === "string" &&
				!!value.baseline.digest))
	);
}
const rejected = (message: string): ChildCreateResult => ({ status: "rejected", issues: [{ path: "", message }] });

function childStopped(state: string): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}

// A rejected completion must not leave partial parent state in the outer transaction.
// Nested SQLite transactions use a savepoint; unexpected errors still abort reconciliation.
function completeParent(
	db: Database,
	host: ChildExecutionHost,
	identity: ChildIdentity,
	outputs: Record<string, GraphRef>,
): boolean {
	const rejectedCompletion = Symbol("rejected child completion");
	try {
		db.transaction(() => {
			if (host.completeParent(db, structuredClone(identity), structuredClone(outputs)) !== true)
				throw rejectedCompletion;
		})();
		return true;
	} catch (error) {
		if (error === rejectedCompletion) return false;
		throw error;
	}
}

/** Validate before any durable child creation. The parent reservation, child run and
 * containment record are checked/created atomically. Invocation identity, not attempt
 * identity, is the idempotency key: retry/restart cannot buy a fresh child graph. */
export function createChildExecution(
	db: Database,
	host: ChildExecutionHost,
	identity: ChildIdentity,
	source: string,
	isolation: ChildIsolation,
	assertOwner?: () => void,
	/** Final trusted check after policy callbacks, before any child writes. */
	authorizeCreation?: () => boolean,
): ChildCreateResult {
	return db
		.transaction((): ChildCreateResult => {
			assertOwner?.();
			if (!validIdentity(identity) || typeof source !== "string" || !validIsolation(isolation))
				return rejected("Invalid child execution request or isolation disclosure");
			identity = { ...identity };
			isolation = structuredClone(isolation);
			const parent = host.parent(db, structuredClone(identity));
			if (!parent || parent.state !== "active" || parent.reserved !== true)
				return rejected("Current parent authority and budget reservation are required");
			if (host.authorizeIsolation(db, structuredClone(identity), structuredClone(isolation)) !== true)
				return rejected("Child execution isolation is not enforced by the trusted host");
			const prior = get(db, identity);
			if (prior) {
				if (prior.source !== source || JSON.stringify(prior.isolation) !== JSON.stringify(isolation))
					return rejected("Parent invocation already owns a different child graph");
				if (authorizeCreation && authorizeCreation() !== true) return rejected("Child creation authority changed");
				return { status: "existing", record: prior };
			}
			const result = validateChildGraph(source, parent.authority);
			if (!result.definition) return { status: "rejected", issues: result.issues };
			if (isolation.mode === "serial" && (result.definition.policy?.max_parallel ?? 1) !== 1)
				return rejected("Serial execution requires child max_parallel=1");
			if (authorizeCreation && authorizeCreation() !== true) return rejected("Child creation authority changed");
			const childRunId = host.createRun(db, {
				identity: structuredClone(identity),
				source,
				definition: structuredClone(result.definition),
				isolation: structuredClone(isolation),
			});
			if (typeof childRunId !== "string" || !childRunId) throw new Error("Child run was not created");
			const record: ChildExecutionRecord = {
				parent_run_id: identity.run_id,
				parent_invocation_id: identity.invocation_id,
				child_run_id: childRunId,
				source,
				isolation,
				state: "running",
			};
			db.query("INSERT INTO graph_child_executions VALUES (?,?,?,?)").run(
				record.parent_run_id,
				record.parent_invocation_id,
				record.child_run_id,
				JSON.stringify(record),
			);
			return { status: "created", record };
		})
		.immediate();
}

/** Reauthenticate inside the scheduler ownership transaction, including completed
 * child work waiting for a trusted integration gate rather than fabricating an orphan. */
function ownedChildExecutionState(
	db: Database,
	host: ChildExecutionHost,
	identity: ChildIdentity,
): "running" | "succeeded" | null {
	if (!db.inTransaction) throw new Error("Child recovery authentication requires a transaction");
	if (!validIdentity(identity)) return null;
	identity = { ...identity };
	const parent = host.parent(db, structuredClone(identity));
	const record = get(db, identity);
	if (
		parent?.state !== "active" ||
		parent.reserved !== true ||
		!record ||
		!["running", "held"].includes(record.state) ||
		host.authorizeIsolation(db, structuredClone(identity), structuredClone(record.isolation)) !== true
	)
		return null;
	const state = host.childState(db, record.child_run_id);
	return state === "succeeded" || (state === "running" && record.state === "running") ? state : null;
}

export function hasRunningChildExecution(db: Database, host: ChildExecutionHost, identity: ChildIdentity): boolean {
	return ownedChildExecutionState(db, host, identity) === "running";
}

export function hasUnaggregatedChildExecution(
	db: Database,
	host: ChildExecutionHost,
	identity: ChildIdentity,
): boolean {
	return ownedChildExecutionState(db, host, identity) === "succeeded";
}

/** Reconcile after child notifications and on restart. Parent cancellation always wins;
 * artifacts are retained by the child store. No notification itself asserts success. */
export function reconcileChildExecution(
	db: Database,
	host: ChildExecutionHost,
	identity: ChildIdentity,
	assertOwner?: () => void,
): ChildExecutionRecord | null {
	return db
		.transaction(() => {
			assertOwner?.();
			if (!validIdentity(identity)) return null;
			identity = { ...identity };
			const parent = host.parent(db, structuredClone(identity));
			const record = get(db, identity);
			if (!parent || !record) return null;
			if (record.state === "completed" || record.state === "cancelled") return record;
			// Cancellation remains sticky even after authority or enforcement is restored.
			if (
				(parent.state !== "active" && parent.state !== "held") ||
				parent.reserved !== true ||
				host.authorizeIsolation(db, structuredClone(identity), structuredClone(record.isolation)) !== true ||
				record.state === "cancelling"
			) {
				let state = host.childState(db, record.child_run_id);
				// Terminal child results are history; cancelling containment does not rewrite them.
				if (!childStopped(state)) {
					host.cancelRun(db, record.child_run_id);
					state = host.childState(db, record.child_run_id);
				}
				record.state = childStopped(state) ? "cancelled" : "cancelling";
				save(db, record);
				return record;
			}
			// A hold pauses parent advancement; it does not revoke already owned child work.
			if (parent.state === "held") return record;
			const state = host.childState(db, record.child_run_id);
			if (state === "succeeded") {
				const outputs = host.verifyAggregation(db, record.child_run_id, structuredClone(identity));
				if (outputs && completeParent(db, host, identity, outputs)) record.state = "completed";
				else record.state = "held";
			} else if (state !== "running") record.state = "held";
			else record.state = "running";
			save(db, record);
			return record;
		})
		.immediate();
}

/** Revisit durable, nonterminal children after host restart or a lost notification.
 * The resolver must obtain the current attempt and fence from the trusted parent
 * scheduler, not from the child record. A missing identity is reported, never treated
 * as proof that a stale attempt may cancel or complete its parent. Each child is
 * reconciled in its own transaction; a later failure does not undo earlier work. */
export function recoverChildExecutions(
	db: Database,
	host: ChildExecutionHost,
	resolveIdentity: (parentRunId: string, parentInvocationId: string) => ChildIdentity | null,
	assertOwner?: () => void,
): { reconciled: ChildExecutionRecord[]; unresolved: { run_id: string; invocation_id: string }[] } {
	const rows = db.query("SELECT data FROM graph_child_executions").all() as { data: string }[];
	const reconciled: ChildExecutionRecord[] = [];
	const unresolved: { run_id: string; invocation_id: string }[] = [];
	for (const row of rows) {
		const record = JSON.parse(row.data) as ChildExecutionRecord;
		if (record.state === "completed" || record.state === "cancelled") continue;
		const identity = resolveIdentity(record.parent_run_id, record.parent_invocation_id);
		if (
			!identity ||
			identity.run_id !== record.parent_run_id ||
			identity.invocation_id !== record.parent_invocation_id
		) {
			unresolved.push({ run_id: record.parent_run_id, invocation_id: record.parent_invocation_id });
			continue;
		}
		const current = reconcileChildExecution(db, host, identity, assertOwner);
		if (current) reconciled.push(current);
		else unresolved.push({ run_id: record.parent_run_id, invocation_id: record.parent_invocation_id });
	}
	return { reconciled, unresolved };
}

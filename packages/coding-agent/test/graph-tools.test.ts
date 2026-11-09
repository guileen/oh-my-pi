import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphHost } from "../src/graph/host";
import { GraphRunStore } from "../src/graph/store";
import { createLocalGraphToolOptions } from "../src/graph/local-policy";
import { createLocalLifecyclePolicy } from "../src/graph/local-lifecycle";
import { GraphManageTool, GraphReadTool } from "../src/tools/graph";

const roots: string[] = [];
const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function rootDir() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-tools-"));
	roots.push(root);
	return root;
}

describe("Graph agent tools", () => {
	it("authors through revision guards, reconciles requests, and reads historical definitions", async () => {
		const root = rootDir();
		const manage = new GraphManageTool({ root });
		const read = new GraphReadTool({ root });
		const create = {
			version: 1 as const,
			request_key: "create",
			operation: "create" as const,
			target_id: null,
			if_revision: null,
			payload: { name: "draft" },
		};
		const first = await manage.execute("1", create);
		const receipt = first.details as { target_id: string; revision: string; state: string };
		expect(receipt.state).toBe("completed");
		expect((await manage.execute("2", create)).details).toEqual(first.details);
		expect((await manage.execute("3", { ...create, payload: { name: "other" } })).details.error.code).toBe(
			"idempotency_conflict",
		);
		const edit = {
			version: 1 as const,
			request_key: "edit",
			operation: "edit" as const,
			target_id: receipt.target_id,
			if_revision: receipt.revision,
			payload: { content: "---\nformat: omp.graph/v1\nname: changed\nmembers: {}\nnodes: {}\n---\n" },
		};
		expect((await manage.execute("4", edit)).details.revision).toBe("2");
		expect((await manage.execute("5", { ...edit, request_key: "stale" })).details.error.code).toBe(
			"revision_conflict",
		);
		const historical = await read.execute("6", {
			version: 1,
			operation: "definition.get",
			target_id: receipt.target_id,
			revision: "1",
		});
		expect(historical.details.revision).toBe("1");
		expect(historical.details.content).toContain("name: draft");
		expect(
			(await read.execute("7", { version: 1, operation: "request.get", target_id: "create" })).details.records,
		).toEqual([first.details]);
		expect(
			(await read.execute("8", { version: 1, operation: "request.get", target_id: "missing" })).details.error.code,
		).toBe("unknown_reference");
	});

	it("tells a dispatcher which Graph declares a deliverable without reading its definition", async () => {
		const root = rootDir();
		const manage = new GraphManageTool({ root });
		const read = new GraphReadTool({ root });
		const content = fs.readFileSync(
			path.join(import.meta.dir, "../examples/graph/requirement-spec-draft/GRAPH.md"),
			"utf8",
		);
		const imported = await manage.execute("1", {
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		expect(imported.details.error).toBeNull();
		const catalog = await read.execute("2", { version: 1, operation: "catalog" });
		expect(catalog.details.content).toContain("contract:declared");
		expect(catalog.details.content).toContain(
			"Bindings: packages/coding-agent/examples/graph/requirement-spec-draft/models.md",
		);
		expect(catalog.details.content).toContain("Deliverable: spec, review");
		expect(catalog.details.content).toContain("Report events: succeeded, failed, held, stalled");
		expect(catalog.details.records).toHaveLength(1);
	});

	it("blocks one dispatcher turn on the same outbox and wakes on the first committed notification", async () => {
		const { root, runId } = runFixture();
		const read = new GraphReadTool({ root, authorizeRun: () => true });
		const waited = await read.execute("wait", {
			version: 1,
			operation: "wait",
			target_id: runId,
			timeout_ms: 1000,
		});
		expect(waited.details.error).toBeNull();
		const observed = waited.details.records[0] as { run: { id: string; state: string } };
		expect(observed.run.id).toBe(runId);
		expect(["queued", "running", "waiting"]).toContain(observed.run.state);
		expect(waited.details.content).toContain("Notifications: 0");

		const manage = new GraphManageTool({
			root,
			lifecycle: { principal: "local-user", policy: createLocalLifecyclePolicy({ principal: "local-user" }) },
		});
		// A notification committed before the wait must not wake it: the dispatcher already
		// knows about it, and replaying it turns every resume into a stale wake-up.
		expect(
			(
				await manage.execute("hold", {
					version: 1,
					request_key: "pause",
					operation: "hold",
					target_id: runId,
					if_revision: "1",
					payload: { reason: "focus" },
				})
			).details.error,
		).toBeNull();
		const stale = await read.execute("stale", {
			version: 1,
			operation: "wait",
			target_id: runId,
			timeout_ms: 1000,
		});
		expect(stale.details.error).toBeNull();
		expect(stale.details.content).toContain("Notifications: 0");

		// A wait started before a commit wakes on the next committed notification. Resuming is
		// not one: only terminal, held and stalled transitions are notified, so a dispatcher
		// never wakes on the echo of its own control command.
		const started = Date.now();
		const pending = read.execute("wait", {
			version: 1,
			operation: "wait",
			target_id: runId,
			timeout_ms: 60000,
		});
		await Bun.sleep(100);
		const resumed = await manage.execute("resume", {
			version: 1,
			request_key: "resume",
			operation: "resume",
			target_id: runId,
			if_revision: "2",
			payload: { kind: "operator" },
		});
		expect(resumed.details.error).toBeNull();
		await Bun.sleep(400);
		const heldAgain = await manage.execute("hold", {
			version: 1,
			request_key: "pause-again",
			operation: "hold",
			target_id: runId,
			if_revision: "3",
			payload: { reason: "operator review" },
		});
		expect(heldAgain.details.error).toBeNull();
		const woken = await pending;
		expect(Date.now() - started).toBeLessThan(5000);
		expect(woken.details.error).toBeNull();
		expect(woken.details.content).toContain("run.held");

		expect(
			(await read.execute("bad-timeout", { version: 1, operation: "wait", target_id: runId, timeout_ms: 500 }))
				.details.error?.code,
		).toBe("invalid_input");
		expect(
			(await read.execute("unknown", { version: 1, operation: "wait", target_id: "missing", timeout_ms: 1000 }))
				.details.error?.code,
		).toBe("unknown_run");
		expect(
			(
				await new GraphReadTool({ root, authorizeRun: () => false }).execute("unauthorized", {
					version: 1,
					operation: "wait",
					target_id: runId,
					timeout_ms: 1000,
				})
			).details.error?.code,
		).toBe("permission_denied");
	});

	it("denies Run observations without trusted authorization and hides execution receipts", async () => {
		const { root, runId } = runFixture();
		const tool = new GraphReadTool({ root });
		for (const operation of ["status", "events"] as const) {
			const result = await tool.execute("1", { version: 1, operation, target_id: runId });
			expect(result.details.error.code).toBe("permission_denied");
			expect(result.details.records).toEqual([]);
		}
		const receipt = await tool.execute("2", { version: 1, operation: "request.get", target_id: "start" });
		expect(receipt.details.error.code).toBe("permission_denied");
		expect(receipt.details.records).toEqual([]);
	});

	it("recovers execution receipts with separate current permission without granting Run observation", async () => {
		const { root, runId } = runFixture();
		let allowed = true;
		const tool = new GraphReadTool({
			root,
			authorizeExecutionReceipt: request => {
				expect(request.operation).toBe("start");
				expect(request.request_key).toBe("start");
				expect(request.if_revision).toBe("1");
				request.request_key = "import";
				request.payload = {};
				return allowed;
			},
		});
		const request = { version: 1 as const, operation: "request.get" as const, target_id: "start" };
		const recovered = await tool.execute("receipt", request);
		expect(recovered.details.error).toBeNull();
		expect(recovered.details.records[0].target_id).toBe(runId);
		const observed = await tool.execute("observe", { version: 1, operation: "status", target_id: runId });
		expect(observed.details.error.code).toBe("permission_denied");
		allowed = false;
		const denied = await tool.execute("revoked", request);
		expect(denied.details.error.code).toBe("permission_denied");
		expect(denied.details.records).toEqual([]);
		expect(denied.details.content).not.toContain(runId);
		const observerOnly = new GraphReadTool({ root, authorizeRun: () => true });
		expect((await observerOnly.execute("observer", request)).details.error.code).toBe("permission_denied");
	});
	it("starts frozen Runs through trusted admission and replays without another preflight", async () => {
		const root = rootDir();
		const author = new GraphManageTool({ root });
		const imported = await author.execute("import", {
			version: 1,
			request_key: "definition",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: start\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		const graphId = imported.details.target_id as string;
		const request = {
			version: 1 as const,
			request_key: "tool-start",
			operation: "start" as const,
			target_id: graphId,
			if_revision: "1",
			payload: { inputs: {}, authorization_ref: { id: "auth", digest: "sha256:auth" } },
		};
		let allowed = true;
		let preflights = 0;
		const tool = new GraphManageTool({
			root,
			start: {
				principal: "alice",
				authorizeTarget: (_principal, target) => {
					target.graph_id = "mutated";
					return true;
				},
				authorizeRequest: (_principal, candidate) => {
					candidate.target_id = "mutated";
					return allowed;
				},
				preflight: async (_principal, candidate, snapshot) => {
					preflights++;
					return {
						graph_id: snapshot.graph_id,
						definition_revision: snapshot.revision,
						definition_digest: snapshot.digest,
						authorization_ref: candidate.payload.authorization_ref,
						inputs: candidate.payload.inputs,
						members: {},
						executors: {},
					};
				},
			},
		});
		const pendingRequest = tool.parameters.assert(request);
		const starting = tool.execute("start", pendingRequest);
		pendingRequest.target_id = "changed-during-authorization";
		pendingRequest.request_key = "changed-during-authorization";
		const started = await starting;
		pendingRequest.target_id = graphId;
		pendingRequest.request_key = "tool-start";
		expect(started.details.state).toBe("accepted");
		expect(started.details.request_key).toBe("tool-start");
		const runId = started.details.target_id as string;
		const read = new GraphReadTool({ root, authorizeRun: id => id === runId });
		const snapshot = await read.execute("status", { version: 1, operation: "status", target_id: runId });
		expect(snapshot.details.records[0].run.state).toBe("queued");
		expect(snapshot.details.records[0].run.graph_id).toBe(graphId);
		await author.execute("edit", {
			version: 1,
			request_key: "edit",
			operation: "edit",
			target_id: graphId,
			if_revision: "1",
			payload: { content: "---\nformat: omp.graph/v1\nname: changed\nmembers: {}\nnodes: {}\n---\n" },
		});
		expect((await tool.execute("replay", request)).details).toEqual(started.details);
		expect(preflights).toBe(1);
		allowed = false;
		expect((await tool.execute("revoked", request)).details.error.code).toBe("permission_denied");
		allowed = true;
		expect(
			(
				await tool.execute("conflict", {
					...request,
					payload: { ...request.payload, inputs: { task: { id: "other", digest: "sha256:other" } } },
				})
			).details.error.code,
		).toBe("idempotency_conflict");
		const unconfigured = await author.execute("unconfigured", request);
		expect(unconfigured.details.error.code).toBe("capability_unavailable");
	});

	it("controls Runs only with a separate trusted lifecycle policy and reconciles guarded transitions", async () => {
		const { root, runId } = runFixture();
		const hold = {
			version: 1 as const,
			request_key: "hold",
			operation: "hold" as const,
			target_id: runId,
			if_revision: "1",
			payload: { reason: "inspect results", kind: "gate" as const },
		};
		const observer = new GraphReadTool({ root, authorizeRun: () => true });
		const status = async () =>
			(await observer.execute("status", { version: 1, operation: "status", target_id: runId })).details.records[0]
				.run;
		const unconfigured = new GraphManageTool({
			root,
			authorizeRun: () => true,
			authorizeExecutionReceipt: () => true,
		});
		expect((await unconfigured.execute("denied", hold)).details.error.code).toBe("capability_unavailable");
		expect((await status()).state).toBe("queued");
		let allowed = true;
		const decision = { id: "decision", digest: "sha256:approved" };
		const manage = new GraphManageTool({
			root,
			lifecycle: {
				principal: "alice",
				policy: {
					authorize: principal => allowed && principal === "alice",
					verifyResume: (_principal, request, { run }) =>
						"decision_ref" in request.payload &&
						request.payload.decision_ref.id === decision.id &&
						request.payload.decision_ref.digest === decision.digest &&
						request.if_revision === run.revision,
				},
			},
		});
		const held = await manage.execute("hold", hold);
		expect(held.details.error).toBeNull();
		expect((await status()).state).toBe("held");
		expect((await status()).reason).toBe("inspect results");
		expect((await manage.execute("replay", hold)).details).toEqual(held.details);
		allowed = false;
		expect((await manage.execute("revoked-replay", hold)).details.error.code).toBe("permission_denied");
		allowed = true;
		expect((await manage.execute("conflict", { ...hold, payload: { reason: "different" } })).details.error.code).toBe(
			"idempotency_conflict",
		);
		const resume = {
			version: 1 as const,
			request_key: "resume",
			operation: "resume" as const,
			target_id: runId,
			if_revision: held.details.revision as string,
			payload: { decision_ref: { ...decision, digest: "sha256:unapproved" } },
		};
		expect((await manage.execute("unapproved", resume)).details.error.code).toBe("gate_unsatisfied");
		expect((await status()).state).toBe("held");
		const resumed = await manage.execute("approved", {
			...resume,
			request_key: "resume-approved",
			payload: { decision_ref: decision },
		});
		expect(resumed.details.error).toBeNull();
		expect((await status()).state).toBe("running");
		const cancel = { ...hold, operation: "cancel" as const, payload: { reason: "inspect results" } };
		expect((await manage.execute("stale", { ...cancel, request_key: "stale" })).details.error.code).toBe(
			"revision_conflict",
		);
		const cancelled = await manage.execute("cancel", {
			...cancel,
			request_key: "cancel",
			if_revision: resumed.details.revision as string,
		});
		expect(cancelled.details.error).toBeNull();
		expect((await status()).state).toBe("cancelled");
		const reader = new GraphReadTool({
			root,
			authorizeExecutionReceipt: request => request.operation === "cancel" && request.target_id === runId,
		});
		expect(
			(await reader.execute("receipt", { version: 1, operation: "request.get", target_id: "cancel" })).details
				.records,
		).toEqual([cancelled.details]);
	});

	it("defaults a tool hold to an operator pause the same principal can resume", async () => {
		const { root, runId } = runFixture();
		const manage = new GraphManageTool({
			root,
			lifecycle: { principal: "local-user", policy: createLocalLifecyclePolicy({ principal: "local-user" }) },
		});
		const held = await manage.execute("hold", {
			version: 1,
			request_key: "pause",
			operation: "hold",
			target_id: runId,
			if_revision: "1",
			payload: { reason: "focus" },
		});
		expect(held.details.error).toBeNull();
		const paused = new GraphRunStore(limits, root);
		expect([paused.getRun(runId)?.hold_kind, paused.getRun(runId)?.held_by]).toEqual(["operator", "local-user"]);
		paused.close();
		const resumed = await manage.execute("resume", {
			version: 1,
			request_key: "resume",
			operation: "resume",
			target_id: runId,
			if_revision: held.details.revision as string,
			payload: { kind: "operator" },
		});
		expect(resumed.details.error).toBeNull();
		const running = new GraphRunStore(limits, root);
		expect(running.getRun(runId)?.state).toBe("running");
		running.close();

		expect(
			(
				await manage.execute("gate", {
					version: 1,
					request_key: "gate",
					operation: "hold",
					target_id: runId,
					if_revision: resumed.details.revision as string,
					payload: { reason: "approval", kind: "gate" },
				})
			).details.error,
		).toBeNull();
		const observer = new GraphReadTool({ root, authorizeRun: () => true });
		const gateRevision = (await observer.execute("status", { version: 1, operation: "status", target_id: runId }))
			.details.records[0].run.revision;
		const refused = await manage.execute("bare-resume", {
			version: 1,
			request_key: "bare-resume",
			operation: "resume",
			target_id: runId,
			if_revision: gateRevision,
			payload: { kind: "operator" },
		});
		expect(refused.details.error?.code).toBe("gate_unsatisfied");
	});

	it("answers human waits through trusted content resolution without granting Agent approval authority", async () => {
		const { root, runId } = runFixture();
		const store = new GraphRunStore(limits, root);
		try {
			let allowed = true;
			store.configureHuman((_action, principal) => principal === "alice");
			const host = new GraphHost({
				store,
				program: {
					accept: async () => {
						throw new Error("unexpected program");
					},
					query: () => null,
					cancel: () => "unknown",
				},
				resolveHuman: async () => ({
					principal: "alice",
					questionRef: { id: "question", digest: "sha256:question" },
				}),
				resolveProgram: async () => {
					throw new Error("unexpected program");
				},
				verifyProgramResult: async () => {
					throw new Error("unexpected program");
				},
			});
			expect(host.start()).toBe(true);
			await host.tick();
			await host.tick();
			const invocation = store.getScheduleState(runId)!.invocations[0];
			const decision = store.getHumanQuestion("alice", `human:${invocation.id}`)!;
			const request = {
				version: 1 as const,
				request_key: "tool-answer",
				operation: "answer" as const,
				target_id: runId,
				if_revision: store.getRun(runId)!.revision,
				payload: {
					decision_id: decision.id,
					input_digest: decision.input_digest,
					outcome: "done",
					content_ref: { id: "answer", digest: "sha256:answer" },
				},
			};
			const unconfigured = new GraphManageTool({
				root,
				authorizeRun: () => true,
				authorizeExecutionReceipt: () => true,
			});
			const parsed = unconfigured.parameters.assert(request);
			expect((await unconfigured.execute("denied", parsed)).details.error.code).toBe("capability_unavailable");
			expect(store.getScheduleState(runId)!.invocations[0].state).toBe("waiting");
			let reads = 0;
			let targetAllowed = true;
			let revokeOnRead = false;
			let body = "Approved after reviewing the frozen input.";
			const tool = new GraphManageTool({
				root,
				answer: {
					principal: "alice",
					authorizeTarget: (_principal, target) => {
						target.run_id = "redirected";
						return targetAllowed;
					},
					resolveContent: async (_principal, scope) => {
						reads++;
						scope.content_ref.id = "redirected";
						if (revokeOnRead) allowed = false;
						return body;
					},
					authorRef: async () => ({ id: "alice", digest: "sha256:alice" }),
					authorize: (_action, principal) => allowed && principal === "alice",
				},
			});
			targetAllowed = false;
			expect((await tool.execute("target-denied", parsed)).details.error.code).toBe("permission_denied");
			expect(reads).toBe(0);
			targetAllowed = true;
			body = "";
			expect((await tool.execute("empty-content", parsed)).details.error.code).toBe("definition_invalid");
			body = "Approved after reviewing the frozen input.";
			revokeOnRead = true;
			expect((await tool.execute("revoked-before-commit", parsed)).details.error.code).toBe("permission_denied");
			expect(store.getScheduleState(runId)!.invocations[0].state).toBe("waiting");
			allowed = true;
			revokeOnRead = false;
			const pending = tool.parameters.assert(structuredClone(request));
			if (pending.operation !== "answer") throw new Error("Expected answer parameters");
			const answering = tool.execute("answer", pending);
			pending.target_id = "changed-during-authorization";
			pending.payload.content_ref.id = "changed-during-authorization";
			const answered = await answering;
			expect(answered.details.error).toBeNull();
			expect(answered.details.target_id).toBe(runId);
			expect(answered.details.result_ref).toEqual(request.payload.content_ref);
			expect(store.getScheduleState(runId)!.invocations[0].state).toBe("succeeded");
			expect(store.getHumanQuestion("alice", decision.id)!.answer!.reason).toBe(body);
			expect((await tool.execute("replay", request)).details).toEqual(answered.details);
			body = "Changed bytes under the same reference.";
			expect((await tool.execute("changed-content", request)).details.error.code).toBe("idempotency_conflict");
			body = "Approved after reviewing the frozen input.";
			allowed = false;
			expect((await tool.execute("revoked-replay", request)).details.error.code).toBe("permission_denied");
			allowed = true;
			const reader = new GraphReadTool({ root, authorizeExecutionReceipt: () => true });
			expect(
				(await reader.execute("receipt", { version: 1, operation: "request.get", target_id: "tool-answer" }))
					.details.records,
			).toEqual([answered.details]);
			await host.tick();
			expect(store.getRun(runId)!.state).toBe("succeeded");
		} finally {
			store.close();
		}
	});

	it("reports denied profile access rather than returning an empty definition", async () => {
		const root = rootDir();
		const link = path.join(root, "linked-profile");
		fs.symlinkSync(root, link);
		const result = await new GraphReadTool({ root: link }).execute("1", {
			version: 1,
			operation: "definition.get",
			target_id: "missing",
		});
		expect(result.details.error.code).toBe("permission_denied");
		expect(result.details.records).toEqual([]);
	});

	it("reads authorized Run facts and resumable events, propagating cursor errors", async () => {
		const { root, runId } = runFixture();
		const tool = new GraphReadTool({ root, authorizeRun: id => id === runId });
		const status = await tool.execute("1", { version: 1, operation: "status", target_id: runId });
		expect(status.details.records[0].run.state).toBe("queued");
		expect(status.details.records[0].run).not.toHaveProperty("authorization_ref");
		const cursor = status.details.records[0].cursor;
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			db.query("INSERT INTO graph_events VALUES (?,?,?)").run(
				cursor.journal_id,
				2,
				JSON.stringify({ type: "test" }),
			);
			db.query("UPDATE graph_journals SET seq=2 WHERE run_id=?").run(runId);
		} finally {
			db.close();
		}
		const first = await tool.execute("2", { version: 1, operation: "events", target_id: runId, limit: 1 });
		expect(first.details.records).toHaveLength(1);
		expect(first.details.next_cursor.seq).toBe("1");
		const second = await tool.execute("3", {
			version: 1,
			operation: "events",
			target_id: runId,
			after: first.details.next_cursor,
		});
		expect(second.details.records).toHaveLength(1);
		expect(second.details.next_cursor).toBeNull();
		const empty = await tool.execute("4", {
			version: 1,
			operation: "events",
			target_id: runId,
			after: second.details.records[0].cursor,
		});
		expect(empty.details.records).toEqual([]);
		expect(empty.details.error).toBeNull();
		const invalid = await tool.execute("5", {
			version: 1,
			operation: "events",
			target_id: runId,
			after: { journal_id: "foreign", seq: "0" },
		});
		expect(invalid.details.error.code).toBe("invalid_cursor");
		expect(
			(await tool.execute("6", { version: 1, operation: "events", target_id: runId, limit: 101 })).details.error
				.code,
		).toBe("invalid_input");
		const gapDb = new Database(path.join(root, "graphs.sqlite"));
		try {
			gapDb.query("DELETE FROM graph_events WHERE journal_id=? AND seq=2").run(cursor.journal_id);
		} finally {
			gapDb.close();
		}
		const expired = await tool.execute("7", { version: 1, operation: "events", target_id: runId, after: cursor });
		expect(expired.details.error.code).toBe("cursor_expired");
	});

	it("lists Runs and drains the notification outbox for authorized observers only", async () => {
		const { root, runId } = labeledFixture();
		const observer = new GraphReadTool({ root, authorizeRun: id => id === runId });

		const runs = await observer.execute("runs", { version: 1, operation: "runs" });
		expect(runs.details.error).toBeNull();
		expect(runs.details.records).toHaveLength(1);
		const entry = runs.details.records[0] as { run_id: string; title?: string; state: string; stalled: boolean };
		expect(entry.run_id).toBe(runId);
		expect(entry.title).toBe("dispatch probe");
		expect(entry.state).toBe("held");
		expect(entry.stalled).toBe(false);
		expect(runs.details.content).toContain("dispatch probe");

		const page = await observer.execute("notifications", { version: 1, operation: "notifications" });
		expect(page.details.error).toBeNull();
		expect(page.details.records).toHaveLength(1);
		const [note] = page.details.records as { id: string; kind: string; report_to?: string }[];
		expect(note!.kind).toBe("run.held");
		expect(note!.report_to).toBe("wherdr:session");
		expect(page.details.notification_cursor).toBe(1);

		const drained = await observer.execute("drained", {
			version: 1,
			operation: "notifications",
			since: 1,
		});
		expect(drained.details.records).toEqual([]);
		expect(drained.details.notification_cursor).toBe(1);

		const filtered = await observer.execute("filtered", {
			version: 1,
			operation: "notifications",
			run_id: "another-run",
		});
		expect(filtered.details.error).toBeNull();
		expect(filtered.details.records).toEqual([]);

		const denied = new GraphReadTool({ root, authorizeRun: () => false });
		expect((await denied.execute("runs", { version: 1, operation: "runs" })).details.records).toEqual([]);
		expect((await denied.execute("notes", { version: 1, operation: "notifications" })).details.records).toEqual([]);

		const unconfigured = new GraphReadTool({ root });
		expect((await unconfigured.execute("runs", { version: 1, operation: "runs" })).details.error.code).toBe(
			"permission_denied",
		);
		expect((await unconfigured.execute("notes", { version: 1, operation: "notifications" })).details.error.code).toBe(
			"permission_denied",
		);

		expect(
			(await observer.execute("bad-limit", { version: 1, operation: "notifications", limit: 201 })).details.error
				.code,
		).toBe("invalid_input");
		expect(
			(await observer.execute("bad-target", { version: 1, operation: "runs", target_id: runId })).details.error.code,
		).toBe("invalid_input");
		expect(
			(await observer.execute("bad-since", { version: 1, operation: "events", target_id: runId, since: 0 })).details
				.error.code,
		).toBe("invalid_input");
		expect(
			(await observer.execute("bad-run", { version: 1, operation: "runs", run_id: runId })).details.error.code,
		).toBe("invalid_input");
	});

	it("renders a Run report only for an authorized observer holding both grants", async () => {
		const { root, runId } = runFixture();
		const reader = new GraphReadTool({
			root,
			authorizeRun: id => id === runId,
			readArtifact: async () => {
				throw new Error("no artifact may be read for a Run without declared outputs");
			},
		});
		const report = await reader.execute("report", { version: 1, operation: "report", target_id: runId });
		expect(report.details.error).toBeNull();
		expect(report.details.records[0]).toMatchObject({ format: "omp.graph/report/v1", state: "queued" });
		expect(report.details.content).toContain(`Run: ${runId}`);
		expect(report.details.content).toContain("Deliverable: not declared");

		const noRead = new GraphReadTool({ root, authorizeRun: () => true });
		expect(
			(await noRead.execute("no-read", { version: 1, operation: "report", target_id: runId })).details.error.code,
		).toBe("permission_denied");
		const denied = new GraphReadTool({
			root,
			authorizeRun: () => false,
			readArtifact: async () => {
				throw new Error("unreachable");
			},
		});
		expect(
			(await denied.execute("denied", { version: 1, operation: "report", target_id: runId })).details.error.code,
		).toBe("permission_denied");
	});
});

function labeledFixture() {
	const root = rootDir();
	const store = new GraphRunStore(limits, root);
	try {
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: labeled\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "private", digest: "sha256:test" };
		const started = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref,
				inputs: {},
				members: {},
				executors: {},
				title: "dispatch probe",
				report_to: "wherdr:session",
			},
		);
		if (started.state !== "accepted" || !started.target_id) throw new Error("Run setup failed");
		store.configureLifecycle({ authorize: () => true, verifyResume: () => true });
		const held = store.mutateLifecycle("alice", {
			version: 1,
			operation: "hold",
			request_key: "hold",
			target_id: started.target_id,
			if_revision: store.getRun(started.target_id)!.revision,
			payload: { reason: "Operator pause" },
		});
		if (held.error) throw new Error(`Hold failed: ${held.error.message}`);
		return { root, runId: started.target_id };
	} finally {
		store.close();
	}
}

function runFixture() {
	const root = rootDir();
	const store = new GraphRunStore(limits, root);
	try {
		const content =
			"---\nformat: omp.graph/v1\nname: human\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n";
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: { content },
		});
		const definition = store.definitions.get(imported.target_id!)!;
		const auth = { id: "private", digest: "sha256:test" };
		const result = store.start(
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
				executors: {},
			},
		);
		if (result.state !== "accepted" || !result.target_id) throw new Error("Run setup failed");
		return { root, runId: result.target_id };
	} finally {
		store.close();
	}
}

describe("Graph dispatch authority", () => {
	it("forwards a bounded dispatch request and reports the accepted Run", async () => {
		const captured: unknown[] = [];
		const tool = new GraphManageTool({
			root: rootDir(),
			dispatch: {
				principal: "alice",
				maxModelCalls: 4,
				maxTimeoutMs: 60_000,
				dispatch: async request => {
					captured.push(request);
					return { run_id: "run-1", request_key: request.request_key, log_path: "/tmp/log" };
				},
			},
		});
		const result = await tool.execute("dispatch", {
			version: 1,
			request_key: "agent-dispatch",
			operation: "dispatch",
			target_id: "graph-1",
			if_revision: null,
			payload: {
				title: "Ship M1-A",
				bindings: "models.md",
				inputs: { task: "brief" },
				max_model_calls: 2,
				report_to: "wherdr:session",
			},
		});
		expect(captured).toEqual([
			{
				request_key: "agent-dispatch",
				graph_id: "graph-1",
				title: "Ship M1-A",
				bindings: "models.md",
				inputs: { task: "brief" },
				max_model_calls: 2,
				timeout_ms: 60_000,
				report_to: "wherdr:session",
			},
		]);
		expect(result.details).toMatchObject({ operation: "dispatch", state: "accepted", run_id: "run-1" });
	});

	it("refuses dispatch without a trusted policy", async () => {
		const tool = new GraphManageTool({ root: rootDir() });
		const refused = await tool.execute("dispatch", {
			version: 1,
			request_key: "agent-dispatch",
			operation: "dispatch",
			target_id: "graph-1",
			if_revision: null,
			payload: { title: "Ship M1-A", bindings: "models.md", inputs: { task: "brief" } },
		});
		expect(refused.isError).toBe(true);
		expect(refused.details.error.code).toBe("capability_unavailable");
	});

	it("bounds the local owner policy before any process starts", async () => {
		const workspace = rootDir();
		const options = createLocalGraphToolOptions({ root: rootDir(), cwd: workspace, maxModelCalls: 4 });
		expect(options.authorizeRun?.("unknown-run")).toBe(false);
		const request = {
			request_key: "dispatch-1",
			graph_id: "graph-1",
			title: "Bounded",
			bindings: "models.md",
			inputs: { task: "brief" },
			max_model_calls: 2,
			timeout_ms: 30_000,
		};
		await expect(options.dispatch!.dispatch({ ...request, bindings: "/etc/passwd" })).rejects.toMatchObject({
			code: "permission_denied",
		});
		await expect(options.dispatch!.dispatch({ ...request, inputs: {} })).rejects.toMatchObject({
			code: "definition_invalid",
		});
		await expect(options.dispatch!.dispatch({ ...request, max_model_calls: 5 })).rejects.toMatchObject({
			code: "resource_limit",
		});
		await expect(options.dispatch!.dispatch({ ...request, title: " " })).rejects.toMatchObject({
			code: "definition_invalid",
		});
	});
});

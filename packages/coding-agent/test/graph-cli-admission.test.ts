import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GraphExecutionReceiptRequest } from "../src/graph/authoring";
import { GRAPH_CLI_LIMITS, type GraphStartAdmission, runGraphCommand } from "../src/graph/cli";
import { GraphRunStore } from "../src/graph/store";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-admission-"));
	roots.push(root);
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
	const content =
		"---\nformat: omp.graph/v1\nname: review\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n";
	const imported = store.definitions.mutate({
		version: 1,
		request_key: "import",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	const graph = imported.target_id!;
	store.close();
	let reads = 0;
	let preflights = 0;
	let authorized = true;
	let targetAuthorized = true;
	let input = "original";
	const auth = { id: "auth", digest: "sha256:auth" };
	const admission: GraphStartAdmission = {
		principal: "alice",
		authorizeTarget: () => targetAuthorized,
		publishInput: async (_principal, item) => ({
			id: item.name,
			digest: `sha256:${Bun.SHA256.hash(item.content, "hex")}`,
		}),
		resolveAuthorization: async () => auth,
		authorizeRequest: () => authorized,
		preflight: async (_principal, request, snapshot) => {
			preflights++;
			return {
				graph_id: snapshot.graph_id,
				definition_revision: snapshot.revision,
				definition_digest: snapshot.digest,
				authorization_ref: request.payload.authorization_ref,
				inputs: request.payload.inputs,
				members: {},
				executors: {},
			};
		},
	};
	async function run(
		args: string[],
		start: GraphStartAdmission | null = admission,
		authorizeExecutionReceipt?: (request: GraphExecutionReceiptRequest) => boolean,
	) {
		let stdout = "";
		let stderr = "";
		const code = await runGraphCommand(args, {
			root,
			start: start ?? undefined,
			authorizeExecutionReceipt,
			readInput: () => {
				reads++;
				return input;
			},
			out: text => {
				stdout += text;
			},
			err: text => {
				stderr += text;
			},
		});
		return { code, stdout, stderr };
	}
	return {
		root,
		graph,
		content,
		admission,
		run,
		reads: () => reads,
		preflights: () => preflights,
		setInput: (value: string) => {
			input = value;
		},
		setAuthorized: (value: boolean) => {
			authorized = value;
		},
		setTargetAuthorized: (value: boolean) => {
			targetAuthorized = value;
		},
	};
}

it("rejects host ensure when the detached worker has no trusted configuration", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-host-unconfigured-"));
	roots.push(root);
	let stdout = "";
	let stderr = "";
	const code = await runGraphCommand(["host", "ensure"], {
		root,
		out: text => {
			stdout += text;
		},
		err: text => {
			stderr += text;
		},
	});
	expect(code).not.toBe(0);
	expect(stdout).not.toContain("launch requested");
	expect(stderr).toContain("capability_unavailable");
	expect(stderr).toContain("trusted host configuration");
	expect(fs.existsSync(path.join(root, "graphs.sqlite"))).toBe(false);
});

describe("Graph CLI trusted start admission", () => {
	it("fails closed before reading input when production admission or target authorization is absent", async () => {
		const f = fixture();
		const args = ["start", f.graph, "--request-key", "start", "--if-revision", "1", "--input", "task.md"];
		const unavailable = await f.run(args, null);
		expect(unavailable.code).toBe(3);
		expect(unavailable.stderr).toContain("trusted preflight");
		f.setTargetAuthorized(false);
		expect((await f.run(args)).stderr).toContain("permission_denied");
		expect(f.reads()).toBe(0);
		expect(f.preflights()).toBe(0);
	});

	it("requires explicit authorization rather than a truthy policy result", async () => {
		const f = fixture();
		const args = ["start", f.graph, "--request-key", "start", "--if-revision", "1", "--input", "task.md"];
		f.admission.authorizeTarget = () => "allow" as unknown as boolean;
		expect((await f.run(args)).stderr).toContain("permission_denied");
		expect(f.reads()).toBe(0);
		f.admission.authorizeTarget = () => true;
		f.admission.authorizeRequest = () => "allow" as unknown as boolean;
		expect((await f.run(args)).stderr).toContain("permission_denied");
		expect(f.preflights()).toBe(0);
	});

	it("keeps the selected Graph and revision when target authorization mutates its inspection copy", async () => {
		const f = fixture();
		f.admission.authorizeTarget = (_principal, target) => {
			target.graph_id = "other";
			target.request_key = "other";
			target.revision = "0";
			return true;
		};
		const started = await f.run(["start", f.graph, "--request-key", "selected", "--if-revision", "1"]);
		expect(started.code).toBe(0);
		const runId = /^Run: (.+)$/m.exec(started.stdout)![1];
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		try {
			expect(store.getRun(runId)?.graph_id).toBe(f.graph);
			expect(store.definitions.requestGet("selected")?.target_id).toBe(runId);
			expect(store.definitions.requestGet("other")).toBeNull();
		} finally {
			store.close();
		}
	});

	it("publishes stdin as task, authorizes every replay and checks canonical idempotency before preflight", async () => {
		const f = fixture();
		const args = ["start", f.graph, "--request-key", "start", "--if-revision", "1", "--input", "-"];
		const first = await f.run(args);
		expect(first.code).toBe(0);
		const run = /^Run: (.+)$/m.exec(first.stdout)![1];
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		const snapshot = store.getSnapshot(store.getRun(run)!.snapshot_ref)!;
		expect(snapshot.inputs.task).toEqual({ id: "task", digest: `sha256:${Bun.SHA256.hash("original", "hex")}` });
		store.definitions.mutate({
			version: 1,
			operation: "edit",
			request_key: "edit",
			target_id: f.graph,
			if_revision: "1",
			payload: { content: f.content.replace("Decide.", "Decide again.") },
		});
		store.close();
		const replay = await f.run(args);
		expect(replay.stdout).toBe(first.stdout);
		expect(f.preflights()).toBe(1);
		f.setAuthorized(false);
		const denied = await f.run(args);
		expect(denied.code).toBe(3);
		expect(denied.stdout).toBe("");
		expect(denied.stderr).toContain("permission_denied");
		f.setAuthorized(true);
		f.setInput("changed");
		const conflict = await f.run(args);
		expect(conflict.stdout).toContain("idempotency_conflict");
		expect(f.preflights()).toBe(1);
	});

	it("recovers the original start receipt without reading input or repeating admission, including after definition edits", async () => {
		const f = fixture();
		const started = await f.run(["start", f.graph, "--request-key", "lost-start", "--if-revision", "1"]);
		expect(started.code).toBe(0);
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		try {
			store.definitions.mutate({
				version: 1,
				operation: "edit",
				request_key: "edit-after-start",
				target_id: f.graph,
				if_revision: "1",
				payload: { content: f.content.replace("Decide.", "Changed.") },
			});
		} finally {
			store.close();
		}
		let authorized = true;
		const authorize = (request: GraphExecutionReceiptRequest): boolean => {
			expect(request.operation).toBe("start");
			expect(request.target_id).toBe(f.graph);
			expect(request.if_revision).toBe("1");
			// Mutating the policy argument must not redirect the protected lookup.
			request.request_key = "import";
			return authorized;
		};
		const recovered = await f.run(["request", "get", "lost-start"], null, authorize);
		expect(recovered).toEqual(started);
		expect(f.reads()).toBe(0);
		expect(f.preflights()).toBe(1);
		const machine = await f.run(["request", "get", "lost-start", "--format=json"], null, authorize);
		expect(JSON.parse(machine.stdout).operation.target_id).toBe(/^Run: (.+)$/m.exec(started.stdout)![1]);
		authorized = false;
		const denied = await f.run(["request", "get", "lost-start"], null, authorize);
		expect(denied.code).toBe(3);
		expect(denied.stdout).toBe("");
		expect(denied.stderr).toContain("permission_denied");
		const unconfigured = await f.run(["request", "get", "lost-start"], null);
		expect(unconfigured.code).toBe(3);
		expect(unconfigured.stdout).toBe("");
		const pending = await f.run(["request", "get", "lost-start"], null, (() => Promise.resolve(true)) as unknown as (
			request: GraphExecutionReceiptRequest,
		) => boolean);
		expect(pending.code).toBe(3);
		expect(pending.stdout).toBe("");
	});

	it("reads a rejected execution receipt as a successful read without admitting a Run", async () => {
		const f = fixture();
		const rejected = await f.run(["start", f.graph, "--request-key", "stale-start", "--if-revision", "0"]);
		expect(rejected.code).toBe(2);
		expect(rejected.stdout).toContain("revision_conflict");
		const result = await f.run(
			["request", "get", "stale-start", "--format=json"],
			null,
			request => request.operation === "start" && request.target_id === f.graph && request.if_revision === "0",
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).operation.error.code).toBe("revision_conflict");
		expect(f.preflights()).toBe(0);
	});

	it("reconciles an exact lifecycle request after reopening without repeating its transition", async () => {
		const f = fixture();
		const started = await f.run(["start", f.graph, "--request-key", "start-hold", "--if-revision", "1"]);
		const runId = /^Run: (.+)$/m.exec(started.stdout)![1];
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		let revision: string;
		try {
			store.configureLifecycle({ authorize: () => true, verifyResume: () => false });
			const held = store.mutateLifecycle("alice", {
				version: 1,
				operation: "hold",
				target_id: runId,
				request_key: "held",
				if_revision: "1",
				payload: { reason: "Await review" },
			});
			expect(held.error).toBeNull();
			revision = store.getRun(runId)!.revision;
		} finally {
			store.close();
		}
		const recovered = await f.run(
			["request", "get", "held", "--format=json"],
			null,
			request =>
				request.operation === "hold" && request.target_id === runId && request.payload.reason === "Await review",
		);
		expect(recovered.code).toBe(0);
		expect(JSON.parse(recovered.stdout).operation.target_id).toBe(runId);
		const reopened = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		try {
			expect(reopened.getRun(runId)!.revision).toBe(revision);
			expect(reopened.getRun(runId)!.state).toBe("held");
		} finally {
			reopened.close();
		}
	});

	it("persists stale-revision rejection without preflight and binds any input filename to task", async () => {
		const f = fixture();
		const args = ["start", f.graph, "--request-key", "stale", "--if-revision", "0", "--input", "task.md"];
		const rejected = await f.run(args);
		expect(rejected.stdout).toContain("revision_conflict");
		expect(f.preflights()).toBe(0);
		expect((await f.run(args)).stdout).toBe(rejected.stdout);
		const accepted = await f.run([
			"start",
			f.graph,
			"--request-key",
			"fresh",
			"--if-revision",
			"1",
			"--input",
			"notes.md",
		]);
		const id = /^Run: (.+)$/m.exec(accepted.stdout)![1];
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		expect(store.getSnapshot(store.getRun(id)!.snapshot_ref)!.inputs.task.id).toBe("task");
		store.close();
	});
	it("rejects unknown and duplicate input names before publishing, and binds multiple declared inputs", async () => {
		const f = fixture();
		const content =
			"---\nformat: omp.graph/v1\nname: briefed\nmembers: {}\nnodes:\n  approval:\n    kind: human\n    task: '#approval'\n    inputs: {brief: {run_input: brief}, notes: {run_input: notes}}\n---\n## approval\nDecide.\n";
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		let briefed: string;
		try {
			briefed = store.definitions.mutate({
				version: 1,
				request_key: "import-briefed",
				operation: "import",
				target_id: null,
				if_revision: null,
				payload: { content },
			}).target_id!;
		} finally {
			store.close();
		}
		const readsBefore = f.reads();
		const unknown = await f.run([
			"start",
			briefed,
			"--request-key",
			"unknown-input",
			"--if-revision",
			"1",
			"--input",
			"nope=a.md",
		]);
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toContain("Graph does not accept input: nope");
		expect(unknown.stderr).toContain("accepts brief, notes");
		expect(f.reads()).toBe(readsBefore);
		expect(f.preflights()).toBe(0);
		const duplicate = await f.run([
			"start",
			briefed,
			"--request-key",
			"duplicate-input",
			"--if-revision",
			"1",
			"--input",
			"brief=a.md",
			"--input",
			"brief=b.md",
		]);
		expect(duplicate.code).toBe(2);
		expect(duplicate.stderr).toContain("Duplicate --input brief");
		expect(f.reads()).toBe(readsBefore);
		const twoStdin = await f.run([
			"start",
			briefed,
			"--request-key",
			"stdin-input",
			"--if-revision",
			"1",
			"--input",
			"brief=-",
			"--input",
			"notes=-",
		]);
		expect(twoStdin.code).toBe(2);
		expect(twoStdin.stderr).toContain("Only one input can read stdin");
		const started = await f.run([
			"start",
			briefed,
			"--request-key",
			"two-inputs",
			"--if-revision",
			"1",
			"--input",
			"brief=a.md",
			"--input",
			"notes=b.md",
		]);
		expect(started.code).toBe(0);
		const runId = /^Run: (.+)$/m.exec(started.stdout)![1];
		const reopened = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		try {
			const inputs = reopened.getSnapshot(reopened.getRun(runId)!.snapshot_ref)!.inputs;
			expect(Object.keys(inputs).sort()).toEqual(["brief", "notes"]);
			expect(inputs.brief.id).toBe("brief");
			expect(inputs.notes.id).toBe("notes");
		} finally {
			reopened.close();
		}
	});

	it("keeps the legacy bare-FILE task binding for a graph that declares no inputs", async () => {
		const f = fixture();
		const started = await f.run([
			"start",
			f.graph,
			"--request-key",
			"legacy-input",
			"--if-revision",
			"1",
			"--input",
			"notes.md",
		]);
		expect(started.code).toBe(0);
		const runId = /^Run: (.+)$/m.exec(started.stdout)![1];
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		try {
			expect(store.getSnapshot(store.getRun(runId)!.snapshot_ref)!.inputs.task.id).toBe("task");
		} finally {
			store.close();
		}
	});

	it("does not admit a run when trusted preflight rejects the executor", async () => {
		const f = fixture();
		f.admission.preflight = async () => {
			throw Object.assign(new Error("Executor registry is unavailable"), { code: "capability_unavailable" });
		};
		const result = await f.run(["start", f.graph, "--request-key", "start", "--if-revision", "1"]);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("capability_unavailable");
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
		expect(store.definitions.requestGet("start")).toBeNull();
		store.close();
	});

	it("rejects a definition changed while preflight was awaiting", async () => {
		const f = fixture();
		const preflight = f.admission.preflight;
		f.admission.preflight = async (principal, request, snapshot) => {
			const prepared = await preflight(principal, request, snapshot);
			const store = new GraphRunStore(GRAPH_CLI_LIMITS, f.root);
			store.definitions.mutate({
				version: 1,
				operation: "edit",
				request_key: "edit-race",
				target_id: f.graph,
				if_revision: "1",
				payload: { content: f.content.replace("Decide.", "Changed.") },
			});
			store.close();
			return prepared;
		};
		const result = await f.run(["start", f.graph, "--request-key", "start", "--if-revision", "1"]);
		expect(result.stdout).toContain("revision_conflict");
	});
});

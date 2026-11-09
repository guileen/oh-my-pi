import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	GraphAuthoringService,
	type GraphAuthoringIntent,
	type GraphMutation,
	type GraphOperation,
} from "../src/graph/authoring";
import { validateGraphDefinition } from "../src/graph/definition";

const limits = { maxBytes: 100_000, maxDepth: 40, maxAliases: 100, maxNodes: 2000 };
const roots: string[] = [];
const stores: GraphAuthoringService[] = [];
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-authoring-"));
	roots.push(root);
	const store = new GraphAuthoringService(limits, root);
	stores.push(store);
	return { root, store };
}
function request(
	operation: GraphMutation["operation"],
	request_key: string,
	payload: Record<string, unknown>,
	target_id: string | null = null,
	if_revision: string | null = null,
): GraphMutation {
	return { version: 1, operation, request_key, payload, target_id, if_revision };
}
function intent(mutation: GraphMutation, intentId = mutation.request_key): GraphAuthoringIntent {
	return {
		principal_id: "alice",
		intent_id: intentId,
		source_id: "server-source",
		source_binding: "immutable-binding",
		request: mutation,
	};
}
function expectCode(action: () => unknown, code: string): void {
	let failure: unknown;
	try {
		action();
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({ code });
}
function committed(result: GraphOperation) {
	expect(result.error).toBeNull();
	expect(result.state).toBe("completed");
	return { id: result.target_id!, revision: result.revision! };
}
const member = {
	role: "#review-role",
	model: "review-model",
	base: "isolated",
	duty: "review",
	permissions: { read: [], write: [], execute: [] },
};

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Graph authoring", () => {
	it("creates and incrementally builds a definition without changing unrelated Markdown", () => {
		const { store } = setup();
		const created = committed(store.mutate(request("create", "create", { name: "review" })));
		const original =
			store.get(created.id)!.content + "\nIntroduction with **formatting**.\n\n```md\n## example\n```\n";
		let revision = committed(
			store.mutate(request("edit", "prose", { content: original }, created.id, created.revision)),
		).revision;
		revision = committed(
			store.mutate(
				request(
					"member.add",
					"member",
					{ key: "reviewer", value: member, body: "Review the plan." },
					created.id,
					revision,
				),
			),
		).revision;
		revision = committed(
			store.mutate(
				request(
					"node.add",
					"node",
					{
						key: "review",
						value: { kind: "bot", member: "reviewer", task: "#review-task" },
						body: "Inspect the proposal.",
					},
					created.id,
					revision,
				),
			),
		).revision;
		revision = committed(
			store.mutate(
				request(
					"node.add",
					"next",
					{ key: "next", value: { kind: "human", task: "#next" }, body: "Decide." },
					created.id,
					revision,
				),
			),
		).revision;
		revision = committed(
			store.mutate(
				request(
					"connect",
					"edge",
					{ value: { id: "review-next", from: "review", to: "next" } },
					created.id,
					revision,
				),
			),
		).revision;
		revision = committed(
			store.mutate(
				request(
					"permit",
					"permit",
					{ value: { from: "reviewer", to: "reviewer", when: "#review-role" } },
					created.id,
					revision,
				),
			),
		).revision;
		const exported = store.get(created.id, revision)!;
		expect(exported.content).toContain("\nIntroduction with **formatting**.\n\n```md\n## example\n```\n");
		expect(exported.content).toContain("## review-role\nReview the plan.");
		expect(exported.content).toContain("## review-task\nInspect the proposal.");
		const imported = committed(store.mutate(request("import", "import", { content: exported.content })));
		expect(store.get(imported.id)!.content).toBe(exported.content);
		expect(store.get(imported.id)!.digest).toBe(exported.digest);
		expect(store.get(created.id, "1")!.content).not.toContain("review-role");
	});

	it("retains imported bytes and extension data through incremental edits", () => {
		const { store } = setup();
		const content =
			"---\r\nformat: omp.graph/v1\r\nname: example\r\nmembers: {}\r\nnodes: {}\r\nextensions:\r\n  x-note: 'keep this'\r\n---\r\n\r\nUntouched prose.\r\n";
		const imported = committed(store.mutate(request("import", "import", { content })));
		expect(store.get(imported.id)!.content).toBe(content);
		const changed = committed(
			store.mutate(
				request(
					"node.add",
					"node",
					{ key: "question", value: { kind: "human", task: "#question" }, body: "What next?" },
					imported.id,
					imported.revision,
				),
			),
		);
		const exported = store.get(imported.id, changed.revision)!.content;
		expect(exported).toContain("x-note: 'keep this'");
		expect(exported).toContain("\r\n\r\nUntouched prose.\r\n");
	});

	it("edits an aliased section without changing the original collection", () => {
		const { store } = setup();
		const content =
			"---\nformat: omp.graph/v1\nname: aliased\nmembers: &empty {}\nnodes: *empty\nextensions:\n  x-note: keep\n---\n\nOriginal prose.\n";
		const imported = committed(store.mutate(request("import", "alias-import", { content })));
		const edited = committed(
			store.mutate(
				request(
					"node.add",
					"alias-node",
					{ key: "question", value: { kind: "human", task: "#question" }, body: "What next?" },
					imported.id,
					imported.revision,
				),
			),
		);
		const exported = store.get(imported.id, edited.revision)!.content;
		expect(exported).toContain("\n\nOriginal prose.\n");
		expect(exported).toContain("x-note: keep");
		expect(exported).toContain("## question\nWhat next?");
		const definition = validateGraphDefinition(exported, limits);
		expect(definition.issues).toEqual([]);
		expect(definition.source.frontmatter.frontmatter.members).toEqual({});
		expect(definition.source.frontmatter.frontmatter.nodes).toEqual({
			question: { kind: "human", task: "#question" },
		});
		const reimported = committed(store.mutate(request("import", "alias-reimport", { content: exported })));
		expect(store.get(reimported.id)!.content).toBe(exported);
		expect(store.get(imported.id, imported.revision)!.content).toBe(content);
		const stale = store.mutate(request("edit", "alias-stale", { content }, imported.id, imported.revision));
		expect(stale.error?.code).toBe("revision_conflict");
		expect(store.get(imported.id)!.content).toBe(exported);
	});

	it("edits an anchor owner without changing another section that references it", () => {
		const { store } = setup();
		const content =
			"---\nformat: omp.graph/v1\nname: anchored\nmembers: &empty {}\nnodes: *empty\n---\n\nOriginal prose.\n";
		const imported = committed(store.mutate(request("import", "anchor-import", { content })));
		const edited = committed(
			store.mutate(
				request(
					"member.add",
					"anchor-member",
					{ key: "reviewer", value: member, body: "Review." },
					imported.id,
					imported.revision,
				),
			),
		);
		const exported = store.get(imported.id, edited.revision)!.content;
		const definition = validateGraphDefinition(exported, limits);
		expect(definition.issues).toEqual([]);
		expect(definition.source.frontmatter.frontmatter.nodes).toEqual({});
		expect(definition.source.frontmatter.frontmatter.members).toEqual({ reviewer: member });
		expect(exported).toContain("\n\nOriginal prose.\n");
	});

	it("serializes guarded writes across connections and keeps rejected deletions from changing the snapshot", () => {
		const { store, root } = setup();
		const other = new GraphAuthoringService(limits, root);
		stores.push(other);
		const imported = committed(
			store.mutate(
				request("import", "import", {
					content:
						"---\nformat: omp.graph/v1\nname: review\nmembers:\n  reviewer:\n    role: '#review-role'\n    model: model\n    base: isolated\n    duty: review\n    permissions: {read: [], write: [], execute: []}\nnodes:\n  review:\n    kind: bot\n    member: reviewer\n    task: '#review-task'\n---\n## review-role\nReview.\n## review-task\nInspect.\n",
				}),
			),
		);
		const before = store.get(imported.id)!.content;
		const first = committed(
			store.mutate(request("edit", "first", { content: `${before}\nExtra.\n` }, imported.id, imported.revision)),
		);
		const conflict = other.mutate(
			request("edit", "second", { content: `${before}\nOther.\n` }, imported.id, imported.revision),
		);
		expect(conflict.error?.code).toBe("revision_conflict");
		expect(conflict.error?.details?.current_revision).toBe(first.revision);
		const invalid = other.mutate(
			request(
				"edit",
				"delete",
				{ content: before.replace(/members:\n[\s\S]*?nodes:/, "members: {}\nnodes:") },
				imported.id,
				first.revision,
			),
		);
		expect(invalid.error?.code).toBe("definition_invalid");
		expect(invalid.error?.details?.issues).toBeDefined();
		expect(store.get(imported.id)!.content).toBe(`${before}\nExtra.\n`);
	});

	it("reports the actual source location of duplicate YAML keys", () => {
		const { store } = setup();
		const result = store.mutate(
			request("import", "duplicate", {
				content: "---\nformat: omp.graph/v1\nname: first\nname: second\nmembers: {}\nnodes: {}\n---\n",
			}),
		);
		expect(result.error?.code).toBe("definition_invalid");
		expect(result.error?.location).toEqual({ file: "GRAPH.md", path: "", line: 4, column: 1 });
	});

	it("reconciles durable same-key requests before checking revision and rejects changed payloads", () => {
		const { store, root } = setup();
		const created = committed(store.mutate(request("create", "create", { name: "example" })));
		const edit = request(
			"edit",
			"edit",
			{ content: `${store.get(created.id)!.content}\nProse.\n` },
			created.id,
			created.revision,
		);
		const result = store.mutate(edit);
		committed(result);
		const other = new GraphAuthoringService(limits, root);
		stores.push(other);
		expect(other.mutate(edit)).toEqual(result);
		expect(other.requestGet("edit")).toEqual(result);
		expect(other.mutate({ ...edit, payload: { content: "different" } }).error?.code).toBe("idempotency_conflict");
		expect(other.mutate({ ...edit, if_revision: result.revision }).error?.code).toBe("idempotency_conflict");
		expect(other.get(created.id)!.revision).toBe(result.revision!);
	});

	it("retains principal-scoped original intents through store reopen and authorized replay", () => {
		const { store, root } = setup();
		const original = intent(request("create", "durable-create", { name: "durable" }));
		let authorizations = 0;
		const authorize = () => {
			authorizations++;
		};
		const result = store.applyIntent(original, authorize);
		committed(result);
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = new GraphAuthoringService(limits, root);
		stores.push(reopened);
		expect(reopened.getIntent("alice", original.intent_id)).toEqual(original);
		const detached = reopened.getIntent("alice", original.intent_id)!;
		detached.request.payload.name = "changed-copy";
		detached.source_binding = "changed-copy";
		expect(reopened.getIntent("alice", original.intent_id)).toEqual(original);
		expect(reopened.applyIntent(original, authorize)).toEqual(result);
		expect(reopened.mutate(original.request)).toEqual(result);
		expect(reopened.requestGet(original.request.request_key)).toEqual(result);
		expect(authorizations).toBe(2);
		expect(reopened.get(result.target_id!)?.revision).toBe("1");
	});

	it("rejects changed source, binding or business data without replacing the original intent", () => {
		const { store } = setup();
		const original = intent(request("create", "intent-create", { name: "original" }));
		const result = store.applyIntent(original, () => {});
		const candidates = [
			{ ...original, source_id: "another-source" },
			{ ...original, source_binding: "another-binding" },
			{ ...original, request: { ...original.request, payload: { name: "changed" } } },
			{ ...original, request: { ...original.request, request_key: "another-request" } },
		];
		for (const candidate of candidates)
			expectCode(() => store.applyIntent(candidate, () => {}), "idempotency_conflict");
		expect(store.getIntent("alice", original.intent_id)).toEqual(original);
		expect(store.requestGet("another-request")).toBeNull();
		expect(store.requestGet(original.request.request_key)).toEqual(result);
		expect(store.applyIntent(original, () => {})).toEqual(result);
	});

	it("isolates matching browser intent IDs by exact principal", () => {
		const { store } = setup();
		const alice = intent(request("create", "alice-create", { name: "alice" }), "shared-intent");
		const first = committed(store.applyIntent(alice, () => {}));
		expect(store.getIntent("bob", "shared-intent")).toBeNull();
		expect(store.getIntent("Alice", "shared-intent")).toBeNull();
		const bob = {
			...intent(request("create", "bob-create", { name: "bob" }), "shared-intent"),
			principal_id: "bob",
			source_id: "bob-source",
		};
		const second = committed(store.applyIntent(bob, () => {}));
		expect(second.id).not.toBe(first.id);
		expect(store.getIntent("alice", "shared-intent")).toEqual(alice);
		expect(store.getIntent("bob", "shared-intent")).toEqual(bob);
	});

	it("keeps mutation and intent absent when transaction-local authorization rejects", () => {
		const { store, root } = setup();
		const original = intent(request("create", "denied-create", { name: "denied" }));
		const denied = new Error("grant expired");
		expect(() =>
			store.applyIntent(original, function (this: unknown, ...args: unknown[]) {
				expect(this).toBeUndefined();
				expect(args).toEqual([]);
				expect(store.requestGet(original.request.request_key)).toBeNull();
				expect(store.getIntent("alice", original.intent_id)).toBeNull();
				throw denied;
			}),
		).toThrow(denied);
		const db = new Database(path.join(root, "graphs.sqlite"));
		try {
			for (const table of ["graph_definitions", "graph_snapshots", "graph_requests", "graph_authoring_intents"])
				expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
		expect(store.requestGet(original.request.request_key)).toBeNull();
		expect(store.getIntent("alice", original.intent_id)).toBeNull();
		const result = store.applyIntent(original, () => {});
		committed(result);
		expect(() =>
			store.applyIntent(original, () => {
				throw denied;
			}),
		).toThrow(denied);
		expect(store.getIntent("alice", original.intent_id)).toEqual(original);
		expect(store.requestGet(original.request.request_key)).toEqual(result);
	});

	it("does not commit a mutation while asynchronous authorization is still pending", () => {
		const { store } = setup();
		const original = intent(request("create", "async-authorization", { name: "pending" }));
		expectCode(() => store.applyIntent(original, async () => {}), "permission_denied");
		expect(store.requestGet(original.request.request_key)).toBeNull();
		expect(store.getIntent("alice", original.intent_id)).toBeNull();
	});

	it("binds an isolated immutable request before calling host authorization", () => {
		const { store } = setup();
		const original = intent(request("create", "isolated-create", { name: "original" }));
		const retained = structuredClone(original);
		const result = store.applyIntent(original, () => {
			original.source_id = "changed-source";
			original.source_binding = "changed-binding";
			original.request.request_key = "changed-request";
			original.request.payload.name = "changed-name";
		});
		committed(result);
		expect(store.get(result.target_id!)?.content).toContain("name: original\n");
		expect(store.getIntent(retained.principal_id, retained.intent_id)).toEqual(retained);
		expect(store.requestGet("changed-request")).toBeNull();
		expect(store.mutate(retained.request)).toEqual(result);
		expect(store.applyIntent(retained, () => {})).toEqual(result);
		const value = structuredClone(member);
		const addition = intent(
			request(
				"member.add",
				"isolated-member",
				{ key: "reviewer", value, body: "Review." },
				result.target_id,
				result.revision,
			),
		);
		const boundAddition = structuredClone(addition);
		const added = store.applyIntent(addition, () => {
			value.role = "#changed-role";
			value.model = "changed-model";
		});
		committed(added);
		expect(store.get(result.target_id!)?.content).toContain("review-model");
		expect(store.getIntent("alice", addition.intent_id)).toEqual(boundAddition);
		expect(store.mutate(boundAddition.request)).toEqual(added);
	});

	it("preserves common request replay, conflicts and revision guards for intent mutations", () => {
		const { store } = setup();
		const created = committed(store.mutate(request("create", "common-create", { name: "common" })));
		const content = `${store.get(created.id)!.content}\nRetained prose.\n`;
		const edit = intent(request("edit", "common-edit", { content }, created.id, created.revision));
		const result = store.applyIntent(edit, () => {});
		committed(result);
		expect(store.mutate(edit.request)).toEqual(result);
		expect(store.applyIntent({ ...edit, intent_id: "another-intent" }, () => {})).toEqual(result);
		const changed = intent({ ...edit.request, payload: { content: `${content}\nChanged.\n` } }, "collision");
		expect(store.applyIntent(changed, () => {}).error?.code).toBe("idempotency_conflict");
		expect(store.requestGet("common-edit")).toEqual(result);
		expect(store.getIntent("alice", edit.intent_id)).toEqual(edit);
		const stale = intent(request("edit", "stale-edit", { content }, created.id, created.revision));
		const rejection = store.applyIntent(stale, () => {});
		expect(rejection.error?.code).toBe("revision_conflict");
		expect(store.applyIntent(stale, () => {})).toEqual(rejection);
		expect(store.requestGet("stale-edit")).toEqual(rejection);
		expect(store.get(created.id)?.revision).toBe(result.revision!);
		expect(store.get(created.id)?.content).toBe(content);
	});

	it("validates bounded control-free intent identities and rechecks profile access for lookup", () => {
		const { store, root } = setup();
		const original = intent(request("create", "identity-create", { name: "identity" }));
		for (const field of ["principal_id", "intent_id", "source_id", "source_binding"] as const) {
			for (const value of ["", "bad\nidentity", "bad\u007fidentity", "é".repeat(513)])
				expectCode(() => store.applyIntent({ ...original, [field]: value }, () => {}), "definition_invalid");
		}
		expect(store.requestGet(original.request.request_key)).toBeNull();
		expect(store.getIntent("alice", original.intent_id)).toBeNull();
		store.applyIntent(original, () => {});
		fs.chmodSync(root, 0o755);
		try {
			expectCode(() => store.getIntent("alice", original.intent_id), "permission_denied");
			expectCode(() => store.applyIntent(original, () => {}), "permission_denied");
		} finally {
			fs.chmodSync(root, 0o700);
		}
	});
	it("rejects an edit introducing ambiguous shared final review sources", () => {
		const { store } = setup();
		const content = `---
format: omp.graph/v1
name: loops
members: {}
nodes:
  review: {kind: human, task: '#task'}
  other-review: {kind: human, task: '#task'}
  final: {kind: human, task: '#task', outcomes: [go, hold]}
loops:
  first: {max_reviews: 1, final_node: final, retry_target: review, final_outcomes: {go: go, hold: hold}, count_nodes: [review], scope: stage, stage: draft}
  second: {max_reviews: 1, final_node: final, retry_target: other-review, final_outcomes: {go: go, hold: hold}, count_nodes: [other-review], scope: stage, stage: draft}
---
## task
Review.
`;
		const snapshot = committed(store.mutate(request("import", "import-loops", { content })));
		const edit = store.mutate(
			request(
				"edit",
				"ambiguous-loops",
				{ content: content.replace("count_nodes: [other-review]", "count_nodes: [review]") },
				snapshot.id,
				snapshot.revision,
			),
		);
		expect(edit.state).toBe("rejected");
		expect(edit.error?.code).toBe("definition_invalid");
		expect(edit.error?.details?.issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "/loops/second/count_nodes/0" })]),
		);
		expect(store.get(snapshot.id)?.content).toBe(content);
		expect(store.get(snapshot.id)?.revision).toBe(snapshot.revision);
	});

	it("reuses the current identical import instead of creating a duplicate graph", () => {
		const { store } = setup();
		const content = "---\nformat: omp.graph/v1\nname: idempotent\nmembers: {}\nnodes: {}\n---\n\nSame bytes.\n";
		const first = committed(store.mutate(request("import", "import-first", { content })));
		const second = committed(store.mutate(request("import", "import-second", { content })));
		expect(second.id).toBe(first.id);
		expect(second.revision).toBe(first.revision);
		expect(store.get(second.id)!.digest).toBe(store.get(first.id)!.digest);
	});

	it("treats a stale re-import after an edit as a new graph", () => {
		const { store } = setup();
		const content = "---\nformat: omp.graph/v1\nname: stale\nmembers: {}\nnodes: {}\n---\n\nOriginal.\n";
		const imported = committed(store.mutate(request("import", "stale-import", { content })));
		committed(
			store.mutate(
				request(
					"node.add",
					"stale-node",
					{ key: "q", value: { kind: "human", task: "#q" }, body: "Next?" },
					imported.id,
					imported.revision,
				),
			),
		);
		const again = committed(store.mutate(request("import", "stale-again", { content })));
		expect(again.id).not.toBe(imported.id);
		expect(store.get(again.id)!.content).toBe(content);
		expect(store.get(imported.id)!.content).toContain("## q");
	});
});

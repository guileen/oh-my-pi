import { describe, expect, test } from "bun:test";
import {
	GraphWireError,
	type GraphWireAuthor,
	type GraphWireAuthorResultFrame,
	type GraphWireDefinitionFrame,
	type GraphWireMutation,
	type GraphWireOperation,
	validateGraphWireAuthoringRequest,
	validateGraphWireAuthorResultFrame,
	validateGraphWireDefinitionFrame,
	type GraphWireReconciliationFrame,
	validateGraphWireReconciliationFrame,
} from "../src/graph";

const MAX_CONTENT_BYTES = 200 * 1024;
const mutation = (changes: Partial<GraphWireMutation> = {}): GraphWireMutation => ({
	version: 1,
	request_key: "request-1",
	operation: "create",
	target_id: null,
	if_revision: null,
	payload: { name: "review" },
	...changes,
});
const author = (request = mutation()): GraphWireAuthor => ({
	protocol: "omp.graph.v1",
	type: "graph.author",
	message_id: "message-1",
	subscription_id: "subscription-1",
	scope_id: "scope-1",
	intent_id: "intent-1",
	source_id: "source-1",
	request,
});
const definition = (): GraphWireDefinitionFrame => ({
	protocol: "omp.graph.v1",
	type: "graph.definition",
	in_reply_to: "message-1",
	source_id: "source-1",
	graph_id: "graph-1",
	definition_revision: "1",
	format: "omp.graph/v1",
	content: "---\nformat: omp.graph/v1\nname: review\nmembers: {}\nnodes: {}\n---\n",
	editable: true,
});
const completed = (): GraphWireOperation => ({
	request_key: "request-1",
	state: "completed",
	target_id: "graph-1",
	revision: "1",
	result_ref: { id: "graph-1@1", digest: "sha256:abc" },
	error: null,
});
const result = (operation = completed()): GraphWireAuthorResultFrame => ({
	protocol: "omp.graph.v1",
	type: "graph.author.result",
	in_reply_to: "message-1",
	intent_id: "intent-1",
	operation,
	error: null,
});
const rejected = (): GraphWireOperation => ({
	request_key: "request-1",
	state: "rejected",
	target_id: null,
	revision: null,
	result_ref: null,
	error: {
		code: "definition_invalid",
		message: "Invalid definition",
		location: { file: "GRAPH.md", path: "", line: null, column: null },
		retryable: false,
		details: { issues: [{ path: "nodes", message: "Invalid nodes" }] },
	},
});
const valueRequest = (value: unknown): GraphWireAuthor =>
	author(mutation({ operation: "connect", target_id: "graph-1", if_revision: "1", payload: { value } }));
function nested(depth: number): unknown {
	let value: unknown = null;
	for (let index = 0; index < depth; index++) value = { child: value };
	return value;
}

describe("Graph definition authoring wire boundary", () => {
	test("admits only definition operations and exact reconciliation/read envelopes", () => {
		const payloads: Record<GraphWireMutation["operation"], Record<string, unknown>> = {
			create: { name: "review" },
			import: { content: definition().content },
			edit: { content: definition().content },
			"member.add": { key: "reviewer", value: { role: "#reviewer" }, body: "Review." },
			"node.add": { key: "review", value: { kind: "human", task: "#review" }, body: "Decide." },
			connect: { value: { id: "edge", from: "review", to: "next" } },
			permit: { value: { from: "reviewer", to: "author", when: "#review" } },
			start: {
				inputs: { task: { id: "artifact-1", digest: "sha256:abc" } },
				authorization_ref: { id: "grant-1", digest: "sha256:abc" },
			},
			hold: { reason: "Pause before the next dispatch" },
			resume: { decision_ref: { id: "decision-1", digest: "sha256:abc" } },
			cancel: { reason: "Superseded by a newer request" },
		};
		for (const operation of Object.keys(payloads) as GraphWireMutation["operation"][]) {
			const creating = operation === "create" || operation === "import";
			validateGraphWireAuthoringRequest(
				author(
					mutation({
						operation,
						payload: payloads[operation],
						target_id: creating ? null : "graph-1",
						if_revision: creating ? null : "123456789012345678901234567890",
					}),
				),
			);
		}
		const read = {
			protocol: "omp.graph.v1",
			type: "graph.definition.get",
			message_id: "m",
			source_id: "s",
			graph_id: "g",
			definition_revision: null,
		};
		validateGraphWireAuthoringRequest(read);
		validateGraphWireAuthoringRequest({ ...read, definition_revision: "0" });
		validateGraphWireAuthoringRequest({
			protocol: "omp.graph.v1",
			type: "request.get",
			message_id: "m",
			intent_id: "i",
		});
		for (const operation of ["retry", "accept", "reject"]) {
			expect(() =>
				validateGraphWireAuthoringRequest({ ...author(), request: { ...mutation(), operation } }),
			).toThrow();
		}
		expect(() => validateGraphWireAuthoringRequest({ ...read, profile: "private" })).toThrow();
		expect(() =>
			validateGraphWireAuthoringRequest({
				protocol: "omp.graph.v1",
				type: "request.get",
				message_id: "m",
				intent_id: "i",
				source_id: "s",
			}),
		).toThrow();
	});

	test("validates execution payloads exactly", () => {
		const execution = (
			operation: GraphWireMutation["operation"],
			payload: Record<string, unknown>,
			target_id: string | null = "graph-1",
			if_revision: string | null = "123456789012345678901234567890",
		) => author(mutation({ operation, payload, target_id, if_revision }));
		const artifact = { id: "artifact-1", digest: "sha256:abc" };
		const start = { inputs: { task: artifact }, authorization_ref: { id: "grant-1", digest: "sha256:abc" } };
		validateGraphWireAuthoringRequest(execution("start", start));
		validateGraphWireAuthoringRequest(
			execution("start", {
				...start,
				entry_nodes: ["plan"],
				provided_outputs: { plan: { out: artifact } },
			}),
		);
		for (const payload of [
			{ inputs: { task: artifact } },
			{ inputs: { task: artifact }, authorization_ref: { id: "grant-1" } },
			{ inputs: { task: artifact }, authorization_ref: { id: "grant-1", digest: "sha256:abc", path: "/tmp" } },
			{ inputs: { task: "artifact-1" }, authorization_ref: { id: "grant-1", digest: "sha256:abc" } },
			{ ...start, note: "extra" },
			{ ...start, entry_nodes: "plan" },
			{ ...start, provided_outputs: { plan: { out: { id: "artifact-1" } } } },
		])
			expect(() => validateGraphWireAuthoringRequest(execution("start", payload))).toThrow(GraphWireError);
		for (const operation of ["hold", "cancel"] as const) {
			validateGraphWireAuthoringRequest(execution(operation, { reason: "Pause before the next dispatch" }));
			for (const payload of [{}, { reason: "" }, { reason: 7 }, { reason: "Pause", kind: "operator" }])
				expect(() => validateGraphWireAuthoringRequest(execution(operation, payload))).toThrow(GraphWireError);
		}
		validateGraphWireAuthoringRequest(
			execution("resume", { decision_ref: { id: "decision-1", digest: "sha256:abc" } }),
		);
		const decision = { id: "decision-1", digest: "sha256:abc" };
		for (const payload of [
			{},
			{ decision_ref: { id: "decision-1" } },
			{ decision_ref: { ...decision, path: "decision.md" } },
			{ decision_ref: decision, kind: "operator" },
		])
			expect(() => validateGraphWireAuthoringRequest(execution("resume", payload))).toThrow(GraphWireError);
		// Execution always targets an existing graph/run revision; creation-shaped targets are refused.
		expect(() => validateGraphWireAuthoringRequest(execution("start", start, null, null))).toThrow(GraphWireError);
		expect(() => validateGraphWireAuthoringRequest(execution("cancel", { reason: "x" }, "graph-1", null))).toThrow(
			GraphWireError,
		);
	});

	test("rejects missing/extra keys, wrong protocol, controls and non-JSON objects", () => {
		for (const frame of [author(), definition(), result()]) {
			const validate =
				frame.type === "graph.author"
					? validateGraphWireAuthoringRequest
					: frame.type === "graph.definition"
						? validateGraphWireDefinitionFrame
						: validateGraphWireAuthorResultFrame;
			for (const malformed of [
				null,
				[],
				{ ...frame, protocol: "omp.graph.v2" },
				{ ...frame, local_path: "/private" },
			]) {
				expect(() => validate(malformed)).toThrow(GraphWireError);
			}
			const missing: Record<string, unknown> = { ...frame };
			delete missing.protocol;
			expect(() => validate(missing)).toThrow();
		}
		for (const id of ["", "line\nbreak", "nul\0", "delete\u007f", "control\u0085", "x".repeat(257)]) {
			expect(() => validateGraphWireAuthoringRequest({ ...author(), message_id: id })).toThrow();
			expect(() => validateGraphWireDefinitionFrame({ ...definition(), graph_id: id })).toThrow();
			expect(() => validateGraphWireAuthorResultFrame({ ...result(), intent_id: id })).toThrow();
		}
		expect(() =>
			validateGraphWireAuthoringRequest(author(mutation({ payload: { name: "review", cwd: "/tmp" } }))),
		).toThrow();
		expect(() =>
			validateGraphWireAuthoringRequest({ ...author(), request: { ...mutation(), execution: true } }),
		).toThrow();
		expect(() =>
			validateGraphWireAuthoringRequest(Object.assign(Object.create({ inherited: true }), author())),
		).toThrow();
		expect(() => validateGraphWireAuthoringRequest({ ...author(), [Symbol("secret")]: true })).toThrow();
		const getter = { ...author() };
		Object.defineProperty(getter, "type", {
			enumerable: true,
			get: () => {
				throw new Error("must not execute");
			},
		});
		expect(() => validateGraphWireAuthoringRequest(getter)).toThrow(GraphWireError);
	});

	test("enforces operation-specific targets, canonical revisions and payload shapes", () => {
		for (const operation of ["create", "import"] as const) {
			const request = mutation({
				operation,
				payload: operation === "create" ? { name: "review" } : { content: "" },
			});
			for (const changes of [{ target_id: "g" }, { if_revision: "1" }]) {
				expect(() => validateGraphWireAuthoringRequest(author({ ...request, ...changes }))).toThrow();
			}
		}
		const edit = mutation({ operation: "edit", target_id: "g", if_revision: "1", payload: { content: "" } });
		for (const if_revision of [null, "", "01", "-1", "1.0", "1e2", " 1", "1\n"]) {
			expect(() => validateGraphWireAuthoringRequest(author({ ...edit, if_revision }))).toThrow();
			expect(() =>
				validateGraphWireDefinitionFrame({ ...definition(), definition_revision: if_revision }),
			).toThrow();
			expect(() =>
				validateGraphWireAuthoringRequest({
					protocol: "omp.graph.v1",
					type: "graph.definition.get",
					message_id: "m",
					source_id: "s",
					graph_id: "g",
					definition_revision: if_revision ?? "bad",
				}),
			).toThrow();
		}
		expect(() => validateGraphWireAuthoringRequest(author({ ...edit, target_id: null }))).toThrow();
		for (const payload of [{ content: 1 }, { content: "", name: "extra" }, {}]) {
			expect(() => validateGraphWireAuthoringRequest(author({ ...edit, payload }))).toThrow();
		}
		expect(() => validateGraphWireAuthoringRequest(author(mutation({ version: 2 as 1 })))).toThrow();
	});

	test("counts UTF-8 source bytes for definitions, import/edit and incremental bodies", () => {
		const content = "é".repeat(MAX_CONTENT_BYTES / 2);
		validateGraphWireDefinitionFrame({ ...definition(), content });
		for (const operation of ["import", "edit"] as const) {
			const request = mutation({
				operation,
				payload: { content },
				target_id: operation === "edit" ? "g" : null,
				if_revision: operation === "edit" ? "1" : null,
			});
			validateGraphWireAuthoringRequest(author(request));
			expect(() =>
				validateGraphWireAuthoringRequest(author({ ...request, payload: { content: `${content}x` } })),
			).toThrow();
		}
		expect(() => validateGraphWireDefinitionFrame({ ...definition(), content: `${content}x` })).toThrow();
		for (const operation of ["member.add", "node.add"] as const) {
			const request = mutation({
				operation,
				target_id: "g",
				if_revision: "1",
				payload: { key: "key", value: {}, body: content },
			});
			validateGraphWireAuthoringRequest(author(request));
			expect(() =>
				validateGraphWireAuthoringRequest(
					author({ ...request, payload: { ...request.payload, body: `${content}x` } }),
				),
			).toThrow();
		}
		expect(() => validateGraphWireDefinitionFrame({ ...definition(), format: "text/html" })).toThrow();
		expect(() => validateGraphWireDefinitionFrame({ ...definition(), editable: "true" })).toThrow();
	});

	test("bounds JSON tree depth, nodes, per-string and aggregate UTF-8 bytes", () => {
		validateGraphWireAuthoringRequest(valueRequest(nested(15)));
		expect(() => validateGraphWireAuthoringRequest(valueRequest(nested(16)))).toThrow();
		validateGraphWireAuthoringRequest(valueRequest(Array(9998).fill(null)));
		expect(() => validateGraphWireAuthoringRequest(valueRequest(Array(9999).fill(null)))).toThrow();
		validateGraphWireAuthoringRequest(valueRequest("é".repeat(MAX_CONTENT_BYTES / 2)));
		expect(() => validateGraphWireAuthoringRequest(valueRequest("é".repeat(MAX_CONTENT_BYTES / 2 + 1)))).toThrow();
		const aggregate = Array(6).fill("x".repeat(MAX_CONTENT_BYTES));
		expect(() => validateGraphWireAuthoringRequest(valueRequest(aggregate))).toThrow();
	});

	test("rejects unsafe keys, cycles, nonfinite values and non-JSON payloads/details", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const getter = Object.defineProperty({}, "secret", {
			enumerable: true,
			get: () => {
				throw new Error("must not execute");
			},
		});
		const invalid = [NaN, Infinity, -Infinity, undefined, 1n, () => null, new Date(), cycle, getter, Array(1)];
		for (const key of ["__proto__", "constructor", "prototype"])
			invalid.push(JSON.parse(`{"nested":{"${key}":true}}`));
		for (const value of invalid) {
			expect(() => validateGraphWireAuthoringRequest(valueRequest(value))).toThrow(GraphWireError);
			const operation = rejected();
			operation.error!.details = { value };
			expect(() => validateGraphWireAuthorResultFrame(result(operation))).toThrow(GraphWireError);
		}
		for (const value of [nested(16), Array(9999).fill(null), "é".repeat(MAX_CONTENT_BYTES / 2 + 1)]) {
			const operation = rejected();
			operation.error!.details = { value };
			expect(() => validateGraphWireAuthorResultFrame(result(operation))).toThrow();
		}
	});

	test("keeps operation state coherent and preserves nullable source coordinates", () => {
		validateGraphWireAuthorResultFrame(result());
		validateGraphWireAuthorResultFrame(result(rejected()));
		for (const state of ["accepted", "unknown"] as const) {
			validateGraphWireAuthorResultFrame(result({ ...completed(), state, revision: null, result_ref: null }));
			validateGraphWireAuthorResultFrame(
				result({ ...completed(), state, target_id: null, revision: null, result_ref: null }),
			);
		}
		for (const operation of [
			{ ...completed(), target_id: null },
			{ ...completed(), revision: null },
			{ ...completed(), result_ref: null },
			{ ...completed(), error: rejected().error },
			{ ...rejected(), error: null },
			{ ...rejected(), revision: "1" },
			{ ...rejected(), result_ref: completed().result_ref },
			{ ...completed(), state: "unknown" as const, target_id: null },
		])
			expect(() => validateGraphWireAuthorResultFrame(result(operation))).toThrow();
		for (const [line, column] of [
			[null, null],
			[12, null],
			[null, 3],
			[12, 3],
		]) {
			const operation = rejected();
			operation.error!.location = { file: "GRAPH.md", path: "", line, column };
			const frame = result(operation);
			const before = JSON.stringify(frame);
			validateGraphWireAuthorResultFrame(frame);
			expect(JSON.stringify(frame)).toBe(before);
		}
		for (const coordinate of [0, -1, 1.5, Infinity, "1"]) {
			const operation = rejected();
			const frame = result(operation);
			Object.assign(operation.error!.location!, { line: coordinate });
			expect(() => validateGraphWireAuthorResultFrame(frame)).toThrow();
		}
		expect(() => validateGraphWireAuthorResultFrame({ ...result(), error: { code: "invalid_input" } })).toThrow();
		expect(() =>
			validateGraphWireAuthorResultFrame({ ...result(), operation: { ...completed(), extra: true } }),
		).toThrow();
		const operation = rejected();
		Object.assign(operation.error!.location!, { offset: 3 });
		expect(() => validateGraphWireAuthorResultFrame(result(operation))).toThrow();
	});

	test("rejects reconciliation envelopes that relabel admission or rejection as applied", () => {
		const pending: GraphWireOperation = { ...completed(), state: "accepted", revision: null, result_ref: null };
		const frame: GraphWireReconciliationFrame = {
			protocol: "omp.graph.v1",
			type: "operation",
			in_reply_to: "lookup",
			intent_id: "original",
			state: "admitted",
			receipt: null,
			result: null,
			error: null,
			graph_operation: pending,
		};
		validateGraphWireReconciliationFrame(frame);
		expect(() => validateGraphWireReconciliationFrame({ ...frame, state: "applied" })).toThrow(GraphWireError);
		expect(() =>
			validateGraphWireReconciliationFrame({ ...frame, state: "applied", graph_operation: rejected() }),
		).toThrow(GraphWireError);
		validateGraphWireReconciliationFrame({ ...frame, state: "rejected", graph_operation: rejected() });
		validateGraphWireReconciliationFrame({
			...frame,
			state: "unknown",
			graph_operation: { ...pending, state: "unknown" },
		});
		validateGraphWireReconciliationFrame({
			...frame,
			state: "unknown",
			graph_operation: { ...pending, state: "unknown", error: { ...rejected().error!, code: "result_unknown" } },
		});
		validateGraphWireReconciliationFrame({ ...frame, state: "applied", graph_operation: completed() });
		expect(() => validateGraphWireReconciliationFrame({ ...frame, receipt: { accepted: true } })).toThrow(
			GraphWireError,
		);
		expect(() =>
			validateGraphWireReconciliationFrame({ ...frame, graph_operation: { ...pending, error: {} } }),
		).toThrow(GraphWireError);
	});
});

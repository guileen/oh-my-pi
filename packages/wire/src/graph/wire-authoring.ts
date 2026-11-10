import { GRAPH_WIRE_PROTOCOL, GraphWireError } from "./wire-types";

export type GraphWireDefinitionOperation =
	| "create"
	| "import"
	| "edit"
	| "member.add"
	| "node.add"
	| "connect"
	| "permit";

/** Run control. Validation alone never admits execution: the host must attach an execution
 * service and a live, ready, execute-capable grant, or the operation is refused. */
export type GraphWireExecutionOperation = "start" | "hold" | "resume" | "cancel";

export type GraphWireMutationOperation = GraphWireDefinitionOperation | GraphWireExecutionOperation;

export interface GraphWireMutation {
	version: 1;
	request_key: string;
	operation: GraphWireMutationOperation;
	target_id: string | null;
	if_revision: string | null;
	payload: Record<string, unknown>;
}

export function isGraphWireExecutionOperation(
	operation: GraphWireMutationOperation,
): operation is GraphWireExecutionOperation {
	return operation === "start" || operation === "hold" || operation === "resume" || operation === "cancel";
}

export interface GraphWireOperation {
	request_key: string;
	state: "accepted" | "completed" | "unknown" | "rejected";
	target_id: string | null;
	revision: string | null;
	result_ref: { id: string; digest: string } | null;
	error: {
		code: string;
		message: string;
		location: { file: string; path: string; line: number | null; column: number | null } | null;
		retryable: boolean;
		details: Record<string, unknown> | null;
	} | null;
}

export interface GraphWireDefinitionGet {
	protocol: typeof GRAPH_WIRE_PROTOCOL;
	type: "graph.definition.get";
	message_id: string;
	source_id: string;
	graph_id: string;
	definition_revision: string | null;
}

export interface GraphWireAuthor {
	protocol: typeof GRAPH_WIRE_PROTOCOL;
	type: "graph.author";
	message_id: string;
	subscription_id: string;
	scope_id: string;
	intent_id: string;
	source_id: string;
	request: GraphWireMutation;
}

export interface GraphWireRequestGet {
	protocol: typeof GRAPH_WIRE_PROTOCOL;
	type: "request.get";
	message_id: string;
	intent_id: string;
}

export interface GraphWireDefinitionFrame {
	protocol: typeof GRAPH_WIRE_PROTOCOL;
	type: "graph.definition";
	in_reply_to: string;
	source_id: string;
	graph_id: string;
	definition_revision: string;
	format: "omp.graph/v1";
	content: string;
	editable: boolean;
}

export interface GraphWireAuthorResultFrame {
	protocol: typeof GRAPH_WIRE_PROTOCOL;
	type: "graph.author.result";
	in_reply_to: string;
	intent_id: string;
	operation: GraphWireOperation;
	error: null;
}

/** Graph extension of request.get; the legacy Bot receipt/result fields remain unchanged. */
export interface GraphWireReconciliationFrame {
	protocol: typeof GRAPH_WIRE_PROTOCOL;
	type: "operation";
	in_reply_to: string;
	intent_id: string;
	state: "admitted" | "applied" | "unknown" | "rejected";
	receipt: null;
	result: null;
	error: null;
	graph_operation: GraphWireOperation;
}

const MAX_TEXT_BYTES = 200 * 1024;
const MAX_TREE_STRING_BYTES = 1024 * 1024;
const MAX_TREE_DEPTH = 16;
const MAX_TREE_NODES = 10_000;
const encoder = new TextEncoder();
const unsafeKeys: Record<string, true> = { ["__proto__"]: true, prototype: true, constructor: true } as const;
const identity = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const revision = (value: unknown): value is string => identity(value) && /^(0|[1-9][0-9]*)$/.test(value);
const text = (value: unknown): value is string =>
	typeof value === "string" && value.length <= MAX_TEXT_BYTES && encoder.encode(value).byteLength <= MAX_TEXT_BYTES;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function invalid(): never {
	throw new GraphWireError("protocol_error", "Invalid Graph authoring wire value");
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
	if (!object(value) || Reflect.ownKeys(value).length !== keys.length) invalid();
	for (const key of keys) {
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (!property || !property.enumerable || !("value" in property)) invalid();
	}
}

/** Payloads and error details are finite JSON trees, not executable objects or unbounded diagnostics. */
function tree(value: unknown): void {
	let nodes = 0;
	let stringBytes = 0;
	const ancestors = new Set<object>();
	function string(value: string): void {
		if (value.length > MAX_TEXT_BYTES) invalid();
		const bytes = encoder.encode(value).byteLength;
		stringBytes += bytes;
		if (bytes > MAX_TEXT_BYTES || stringBytes > MAX_TREE_STRING_BYTES) invalid();
	}
	function visit(value: unknown, depth: number): void {
		if (++nodes > MAX_TREE_NODES || depth > MAX_TREE_DEPTH) invalid();
		if (value === null || typeof value === "boolean") return;
		if (typeof value === "string") return string(value);
		if (typeof value === "number") {
			if (!Number.isFinite(value)) invalid();
			return;
		}
		if (typeof value !== "object" || ancestors.has(value)) invalid();
		ancestors.add(value);
		if (Array.isArray(value)) {
			if (value.length > MAX_TREE_NODES || Reflect.ownKeys(value).length !== value.length + 1) invalid();
			for (let index = 0; index < value.length; index++) {
				const property = Object.getOwnPropertyDescriptor(value, String(index));
				if (!property || !property.enumerable || !("value" in property)) invalid();
				visit(property.value, depth + 1);
			}
		} else {
			if (!object(value)) invalid();
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key !== "string" || Object.hasOwn(unsafeKeys, key)) invalid();
				string(key);
				const property = Object.getOwnPropertyDescriptor(value, key);
				if (!property || !property.enumerable || !("value" in property)) invalid();
				visit(property.value, depth + 1);
			}
		}
		ancestors.delete(value);
	}
	visit(value, 0);
}

/** Required keys plus an exact, bounded allowance for declared optional keys. */
function bounded(
	value: unknown,
	required: readonly string[],
	optional: readonly string[],
): asserts value is Record<string, unknown> {
	if (!object(value)) invalid();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) invalid();
	}
	for (const key of required) {
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (!property || !property.enumerable || !("value" in property)) invalid();
	}
}

/** Immutable artifact reference: content identity plus digest, never a path or a claim. */
function ref(value: unknown): void {
	exact(value, ["id", "digest"]);
	if (!identity(value.id) || !identity(value.digest)) invalid();
}

function refMap(value: unknown): void {
	if (!object(value)) invalid();
	let count = 0;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !identity(key) || ++count > 1024) invalid();
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (!property || !property.enumerable || !("value" in property)) invalid();
		ref(property.value);
	}
}

/** Declared entry node keys, not free-form identifiers. */
function keys(value: unknown): void {
	if (!Array.isArray(value) || value.length > 1024) invalid();
	for (let index = 0; index < value.length; index++) {
		const property = Object.getOwnPropertyDescriptor(value, String(index));
		if (!property || !property.enumerable || !("value" in property) || !identity(property.value)) invalid();
	}
}

/** Imported predecessor outputs: node key to that node's declared output refs. */
function nestedRefMap(value: unknown): void {
	if (!object(value)) invalid();
	let count = 0;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !identity(key) || ++count > 256) invalid();
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (!property || !property.enumerable || !("value" in property)) invalid();
		refMap(property.value);
	}
}

function mutation(value: unknown): void {
	exact(value, ["version", "request_key", "operation", "target_id", "if_revision", "payload"]);
	if (value.version !== 1 || !identity(value.request_key) || !object(value.payload)) invalid();
	tree(value.payload);
	const creating = value.operation === "create" || value.operation === "import";
	if (
		creating
			? value.target_id !== null || value.if_revision !== null
			: !identity(value.target_id) || !revision(value.if_revision)
	)
		invalid();
	switch (value.operation) {
		case "create":
			exact(value.payload, ["name"]);
			if (!identity(value.payload.name)) invalid();
			break;
		case "import":
		case "edit":
			exact(value.payload, ["content"]);
			if (typeof value.payload.content !== "string") invalid();
			break;
		case "member.add":
		case "node.add":
			exact(value.payload, ["key", "value", "body"]);
			if (!identity(value.payload.key) || typeof value.payload.body !== "string") invalid();
			break;
		case "connect":
		case "permit":
			exact(value.payload, ["value"]);
			break;
		case "start":
			bounded(value.payload, ["inputs", "authorization_ref"], ["entry_nodes", "provided_outputs"]);
			refMap(value.payload.inputs);
			ref(value.payload.authorization_ref);
			if (Object.hasOwn(value.payload, "entry_nodes")) keys(value.payload.entry_nodes);
			if (Object.hasOwn(value.payload, "provided_outputs")) nestedRefMap(value.payload.provided_outputs);
			break;
		case "hold":
		case "cancel":
			exact(value.payload, ["reason"]);
			if (!text(value.payload.reason) || value.payload.reason.length === 0) invalid();
			break;
		case "resume":
			exact(value.payload, ["decision_ref"]);
			ref(value.payload.decision_ref);
			break;
		default:
			invalid();
	}
}

/** Authorization, trusted source selection and live-scope admission remain host responsibilities. */
export function validateGraphWireAuthoringRequest(
	value: unknown,
): asserts value is GraphWireDefinitionGet | GraphWireAuthor | GraphWireRequestGet {
	if (!object(value)) invalid();
	const type = Object.getOwnPropertyDescriptor(value, "type");
	if (!type || !("value" in type)) invalid();
	switch (type.value) {
		case "graph.definition.get":
			exact(value, ["protocol", "type", "message_id", "source_id", "graph_id", "definition_revision"]);
			if (
				!identity(value.source_id) ||
				!identity(value.graph_id) ||
				(value.definition_revision !== null && !revision(value.definition_revision))
			)
				invalid();
			break;
		case "graph.author":
			exact(value, [
				"protocol",
				"type",
				"message_id",
				"subscription_id",
				"scope_id",
				"intent_id",
				"source_id",
				"request",
			]);
			if (![value.subscription_id, value.scope_id, value.intent_id, value.source_id].every(identity)) invalid();
			mutation(value.request);
			break;
		case "request.get":
			exact(value, ["protocol", "type", "message_id", "intent_id"]);
			if (!identity(value.intent_id)) invalid();
			break;
		default:
			invalid();
	}
	if (value.protocol !== GRAPH_WIRE_PROTOCOL || !identity(value.message_id)) invalid();
}

export function validateGraphWireDefinitionFrame(value: unknown): asserts value is GraphWireDefinitionFrame {
	exact(value, [
		"protocol",
		"type",
		"in_reply_to",
		"source_id",
		"graph_id",
		"definition_revision",
		"format",
		"content",
		"editable",
	]);
	if (
		value.protocol !== GRAPH_WIRE_PROTOCOL ||
		value.type !== "graph.definition" ||
		![value.in_reply_to, value.source_id, value.graph_id].every(identity) ||
		!revision(value.definition_revision) ||
		value.format !== "omp.graph/v1" ||
		!text(value.content) ||
		typeof value.editable !== "boolean"
	)
		invalid();
}

function operation(value: unknown): asserts value is GraphWireOperation {
	exact(value, ["request_key", "state", "target_id", "revision", "result_ref", "error"]);
	if (
		!identity(value.request_key) ||
		(value.target_id !== null && !identity(value.target_id)) ||
		(value.revision !== null && !revision(value.revision))
	)
		invalid();
	if (value.result_ref !== null) {
		exact(value.result_ref, ["id", "digest"]);
		if (!identity(value.result_ref.id) || !identity(value.result_ref.digest)) invalid();
	}
	if (value.error !== null) {
		exact(value.error, ["code", "message", "location", "retryable", "details"]);
		if (!identity(value.error.code) || !text(value.error.message) || typeof value.error.retryable !== "boolean")
			invalid();
		if (value.error.location !== null) {
			exact(value.error.location, ["file", "path", "line", "column"]);
			if (!text(value.error.location.file) || !text(value.error.location.path)) invalid();
			for (const coordinate of [value.error.location.line, value.error.location.column]) {
				if (
					coordinate !== null &&
					!(typeof coordinate === "number" && Number.isSafeInteger(coordinate) && coordinate > 0)
				)
					invalid();
			}
		}
		if (value.error.details !== null) {
			if (!object(value.error.details)) invalid();
			tree(value.error.details);
		}
	}
	switch (value.state) {
		case "completed":
			if (value.target_id === null || value.revision === null || value.result_ref === null || value.error !== null)
				invalid();
			break;
		case "rejected":
			if (value.error === null || value.revision !== null || value.result_ref !== null) invalid();
			break;
		case "accepted":
		case "unknown":
			if (
				(value.state === "accepted" && value.error !== null) ||
				(value.revision !== null && value.target_id === null) ||
				(value.result_ref !== null && (value.target_id === null || value.revision === null))
			)
				invalid();
			break;
		default:
			invalid();
	}
}

export function validateGraphWireAuthorResultFrame(value: unknown): asserts value is GraphWireAuthorResultFrame {
	exact(value, ["protocol", "type", "in_reply_to", "intent_id", "operation", "error"]);
	if (
		value.protocol !== GRAPH_WIRE_PROTOCOL ||
		value.type !== "graph.author.result" ||
		!identity(value.in_reply_to) ||
		!identity(value.intent_id) ||
		value.error !== null
	)
		invalid();
	operation(value.operation);
}

export function validateGraphWireReconciliationFrame(value: unknown): asserts value is GraphWireReconciliationFrame {
	exact(value, [
		"protocol",
		"type",
		"in_reply_to",
		"intent_id",
		"state",
		"receipt",
		"result",
		"error",
		"graph_operation",
	]);
	if (
		value.protocol !== GRAPH_WIRE_PROTOCOL ||
		value.type !== "operation" ||
		!identity(value.in_reply_to) ||
		!identity(value.intent_id) ||
		value.receipt !== null ||
		value.result !== null ||
		value.error !== null
	)
		invalid();
	operation(value.graph_operation);
	const states = { accepted: "admitted", completed: "applied", unknown: "unknown", rejected: "rejected" } as const;
	if (value.state !== states[value.graph_operation.state]) invalid();
}

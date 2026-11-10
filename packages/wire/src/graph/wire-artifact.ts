import { GRAPH_WIRE_PROTOCOL, GraphWireError } from "./wire-types";

/** Bounded text only. Binary artifacts require a separately authorized download channel. */
export interface GraphWireArtifactFrame {
	protocol: typeof GRAPH_WIRE_PROTOCOL;
	type: "graph.artifact";
	in_reply_to: string;
	source_id: string;
	graph_run_id: string;
	ref: string;
	availability: "available" | "expired" | "missing" | "unknown";
	media_type: string | null;
	content: string | null;
	next_page_token: null;
}

const MAX_CONTENT_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const keys = [
	"protocol",
	"type",
	"in_reply_to",
	"source_id",
	"graph_run_id",
	"ref",
	"availability",
	"media_type",
	"content",
	"next_page_token",
];
const identity = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
function invalid(): never {
	throw new GraphWireError("protocol_error", "Invalid protected Graph content response");
}

/** Shared browser/relay validation; correlation and current authorization remain caller duties. */
export function validateGraphWireArtifactFrame(value: unknown): asserts value is GraphWireArtifactFrame {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const frame = value as Record<string, unknown>;
	if (
		Object.keys(frame).length !== keys.length ||
		!keys.every(key => Object.hasOwn(frame, key)) ||
		frame.protocol !== GRAPH_WIRE_PROTOCOL ||
		frame.type !== "graph.artifact" ||
		![frame.in_reply_to, frame.source_id, frame.graph_run_id, frame.ref].every(identity) ||
		frame.next_page_token !== null
	)
		invalid();
	if (frame.availability !== "available") {
		if (
			!["expired", "missing", "unknown"].includes(String(frame.availability)) ||
			frame.media_type !== null ||
			frame.content !== null
		)
			invalid();
		return;
	}
	if (
		typeof frame.media_type !== "string" ||
		frame.media_type.length > 256 ||
		!/^(?:text\/[a-z0-9!#$&^_.+-]+|application\/(?:json|[a-z0-9!#$&^_.+-]+\+json))(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(
			frame.media_type,
		) ||
		typeof frame.content !== "string" ||
		frame.content.length > MAX_CONTENT_BYTES ||
		encoder.encode(frame.content).byteLength > MAX_CONTENT_BYTES
	)
		invalid();
}

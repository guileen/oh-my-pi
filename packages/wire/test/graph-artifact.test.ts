import { describe, expect, test } from "bun:test";
import { validateGraphWireArtifactFrame } from "../src/graph";

const response = () => ({
	protocol: "omp.graph.v1",
	type: "graph.artifact",
	in_reply_to: "message-1",
	source_id: "source",
	graph_run_id: "run",
	ref: "consultation-message:question",
	availability: "available",
	media_type: "text/markdown",
	content: "Review this plan",
	next_page_token: null,
});

describe("protected Graph content wire boundary", () => {
	test("unavailable results cannot smuggle protected content or metadata", () => {
		for (const availability of ["expired", "missing", "unknown"]) {
			expect(() => validateGraphWireArtifactFrame({ ...response(), availability })).toThrow(
				"Invalid protected Graph content response",
			);
			const safe = { ...response(), availability, content: null, media_type: null };
			validateGraphWireArtifactFrame(safe);
			expect(() => validateGraphWireArtifactFrame({ ...safe, content: "secret" })).toThrow();
		}
	});
	test("rejects binary, executable and malformed metadata instead of exposing inline bytes", () => {
		for (const media_type of [
			"application/octet-stream",
			"application/javascript",
			"text/markdown; charset=latin1",
			"text/markdown\r\nX-Leak: value",
		]) {
			expect(() => validateGraphWireArtifactFrame({ ...response(), media_type })).toThrow();
		}
		expect(() => validateGraphWireArtifactFrame({ ...response(), local_path: "/secret" })).toThrow();
		expect(() => validateGraphWireArtifactFrame({ ...response(), next_page_token: "unbound" })).toThrow();
		expect(() => validateGraphWireArtifactFrame({ ...response(), in_reply_to: "" })).toThrow();
	});
	test("counts UTF-8 bytes, not characters, at the complete-content ceiling", () => {
		const boundary = { ...response(), content: "é".repeat(512 * 1024) };
		validateGraphWireArtifactFrame(boundary);
		expect(() => validateGraphWireArtifactFrame({ ...boundary, content: `${boundary.content}x` })).toThrow();
	});
});

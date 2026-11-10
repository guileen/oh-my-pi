import { describe, expect, it } from "bun:test";
import { GraphCompleteTool, createGraphCompleteTool, type GraphCompletionCandidate } from "../src/tools/graph-complete";

const candidate = {
	request_key: "completion-1",
	outcome: "revise",
	verdict: "rejected",
	outputs: { report: { id: "artifact-1", digest: "sha256:123" } },
};

describe("graph_complete consumer", () => {
	it("fails closed without an authenticated runtime", async () => {
		const result = await new GraphCompleteTool().execute("call", candidate);
		expect(result.isError).toBe(true);
		expect(result.details.state).toBe("rejected");
		expect(result.details.error.code).toBe("permission_denied");
	});

	it("passes only the candidate and reports acceptance without claiming Run completion", async () => {
		const calls: GraphCompletionCandidate[] = [];
		const tool = createGraphCompleteTool({
			async submit(input) {
				calls.push(input);
				return { request_key: input.request_key, state: "accepted", error: null };
			},
		});
		const result = await tool.execute("call", candidate);
		expect(calls).toEqual([candidate]);
		expect(result.details.state).toBe("accepted");
		expect(result.isError).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("does not mean") });
	});

	it("rejects identity spoofing, malformed refs and missing control data before the runtime", async () => {
		let calls = 0;
		const tool = createGraphCompleteTool({
			async submit(input) {
				calls++;
				return { request_key: input.request_key, state: "accepted", error: null };
			},
		});
		for (const bad of [
			{ ...candidate, member: "other" },
			{ ...candidate, attempt_id: "other" },
			{ ...candidate, fence: "other" },
			{ ...candidate, outputs: { report: { ...candidate.outputs.report, fence: "other" } } },
			{ ...candidate, outputs: { report: { id: "artifact-1" } } },
			{ ...candidate, outcome: "" },
			{ ...candidate, request_key: 5 as unknown as string },
		]) {
			const result = await tool.execute("call", bad as typeof candidate);
			expect(result.details.state).toBe("rejected");
			expect(result.details.error.code).toBe("invalid_request");
		}
		expect(calls).toBe(0);
	});

	it("accepts an omitted request key because the host binds it", async () => {
		const calls: GraphCompletionCandidate[] = [];
		const tool = createGraphCompleteTool({
			async submit(input) {
				calls.push(input);
				return { request_key: "host-bound", state: "accepted", error: null };
			},
		});
		const { request_key: _omitted, ...withoutKey } = candidate;
		const result = await tool.execute("call", withoutKey);
		expect(calls).toHaveLength(1);
		expect(result.details.state).toBe("accepted");
	});

	it("exposes trusted host rejections, including stale fences and invalid artifacts", async () => {
		for (const code of ["stale_fence", "permission_denied", "invalid_output", "idempotency_conflict"]) {
			const tool = createGraphCompleteTool({
				async submit(input) {
					return {
						request_key: input.request_key,
						state: "rejected",
						error: {
							code,
							message: "Not accepted",
							location: null,
							retryable: false,
							details: null,
						},
					};
				},
			});
			const result = await tool.execute("call", candidate);
			expect(result.isError).toBe(true);
			expect(result.details.error.code).toBe(code);
		}
	});
	it("reports an uncertain transport failure without claiming rejection", async () => {
		const tool = createGraphCompleteTool({
			async submit() {
				throw new Error("connection lost");
			},
		});
		const result = await tool.execute("call", candidate);
		expect(result.details.state).toBe("unknown");
		expect(result.details.request_key).toBe(candidate.request_key);
		expect(result.details.error.retryable).toBe(true);
		expect(result.isError).toBe(true);
	});
});

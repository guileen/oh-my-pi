import { describe, expect, it } from "bun:test";
import {
	type DaemonOperation,
	type LaunchDisposition,
	parseDaemonRpcResult,
	parseDaemonWireRequest,
} from "../../src/launch/protocol";

const operation: Extract<DaemonOperation, { op: "logs" }> = {
	op: "logs",
	name: "web",
	lines: 20,
	head: false,
	follow: false,
	timeoutMs: 1_000,
};

const baseResult = {
	name: "web",
	text: "ready",
	cursor: 42,
	timedOut: false,
	state: "running" as const,
};

const baseSnapshot = {
	name: "web",
	id: "daemon-1",
	state: "ready" as const,
	createdAt: 1,
	startedAt: 1,
	restartCount: 0,
	outputBytes: 5,
	persist: false,
	detached: false,
};

describe("launch logs protocol", () => {
	it("decodes terminal rows without changing their bytes", () => {
		const terminalRows = ["\x1b[0m\x1b[1;38;5;2mready", "", "界e\u0301"];
		expect(parseDaemonRpcResult(operation, { ...baseResult, terminalRows })).toEqual({
			op: "logs",
			...baseResult,
			terminalRows,
		});
	});

	it("rejects a non-array terminal row payload", () => {
		expect(() => parseDaemonRpcResult(operation, { ...baseResult, terminalRows: "ready" })).toThrow(
			"result.terminalRows must be an array of strings",
		);
	});

	it("rejects non-string terminal row entries", () => {
		expect(() => parseDaemonRpcResult(operation, { ...baseResult, terminalRows: ["ready", 7] })).toThrow(
			"result.terminalRows item must be a string",
		);
	});
});

describe("launch logs compatibility", () => {
	it("preserves the rendered-row request for upgraded brokers", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "token-1",
			operation: { ...operation, renderTerminalRows: true },
		});
		expect(request.operation).toMatchObject({ ...operation, renderTerminalRows: true });
	});

	it("preserves completion owner changes on reconnect requests", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "token-1",
			owners: ["session-owner"],
			detachedOwners: ["parked-owner"],
			completionUnsubscribes: ["disposed-owner"],
			completionSubscriptionId: "subscription-1",
			operation: { op: "list" },
		});

		expect(request.owners).toEqual(["session-owner"]);
		expect(request.detachedOwners).toEqual(["parked-owner"]);
		expect(request.completionUnsubscribes).toEqual(["disposed-owner"]);
		expect(request.completionSubscriptionId).toBe("subscription-1");
	});

	it("decodes raw terminal text from an already-running legacy broker", () => {
		const result = parseDaemonRpcResult(operation, { ...baseResult, terminalText: "progress\rready" });
		if (result.op !== "logs") throw new Error("unexpected result");
		expect("terminalText" in result ? result.terminalText : undefined).toBe("progress\rready");
	});
});

describe("daemon mode protocol", () => {
	it("accepts persistence transitions and rejects unsupported modes", () => {
		const request = parseDaemonWireRequest({
			id: "mode-request",
			token: "token",
			operation: { op: "mode", name: "web", mode: "persist" },
		});
		expect(request.operation).toEqual({ op: "mode", name: "web", mode: "persist" });
		expect(
			parseDaemonRpcResult(
				{ op: "mode", name: "web", mode: "persist" },
				{ daemon: { ...baseSnapshot, persist: true } },
			),
		).toEqual({ op: "mode", daemon: { ...baseSnapshot, persist: true } });
		expect(() =>
			parseDaemonWireRequest({
				id: "bad-mode",
				token: "token",
				operation: { op: "mode", name: "web", mode: "restart" },
			}),
		).toThrow("operation.mode must be persist, session, or detached");
	});
});

describe("regex-derived protocol fields", () => {
	it("preserves an empty wait pattern match", () => {
		const waitOperation: Extract<DaemonOperation, { op: "wait" }> = {
			op: "wait",
			name: "web",
			for: "ready",
			pattern: "^",
			timeoutMs: 1_000,
		};
		expect(
			parseDaemonRpcResult(waitOperation, {
				daemon: baseSnapshot,
				matched: "",
				timedOut: false,
			}),
		).toEqual({
			op: "wait",
			daemon: baseSnapshot,
			matched: "",
			timedOut: false,
		});
	});
});

describe("durable launch protocol", () => {
	const metadata = { launch_intent_id: "intent", session_owner_id: "owner", owner_epoch: "9007199254740993" };

	it("preserves decimal owner fences and exact stop generations", () => {
		expect(
			parseDaemonWireRequest({
				id: "fence",
				token: "token",
				operation: { op: "fence_owner", session_owner_id: "owner", through_epoch: metadata.owner_epoch },
			}).operation,
		).toEqual({ op: "fence_owner", session_owner_id: "owner", through_epoch: metadata.owner_epoch });
		expect(
			parseDaemonWireRequest({
				id: "stop",
				token: "token",
				operation: { op: "stop", name: "service", id: "generation-id", generation: "123", timeoutMs: 500 },
			}).operation,
		).toMatchObject({ id: "generation-id", generation: "123" });
		for (const epoch of ["01", "-1", "1.0", "1e3"]) {
			expect(() =>
				parseDaemonWireRequest({
					id: "invalid-epoch",
					token: "token",
					operation: { op: "reconcile_launch", ...metadata, owner_epoch: epoch, mode: "cancel" },
				}),
			).toThrow("canonical unsigned decimal");
		}
	});

	it("does not accept a non-final terminal or final pending response", () => {
		const operation = { op: "reconcile_launch" as const, ...metadata, mode: "inspect" as const };
		const cancelled: LaunchDisposition = {
			launch_intent_id: metadata.launch_intent_id,
			state: "cancelled_before_launch",
			service: null,
			outcome: null,
			final: true,
			error: null,
		};
		expect(parseDaemonRpcResult(operation, { disposition: cancelled })).toEqual({
			op: "reconcile_launch",
			disposition: cancelled,
		});
		expect(() => parseDaemonRpcResult(operation, { disposition: { ...cancelled, state: "pending" } })).toThrow(
			"finality",
		);
		expect(() =>
			parseDaemonRpcResult(operation, {
				disposition: {
					...cancelled,
					state: "terminal",
					service: { id: "service", generation: "12" },
					outcome: "cancelled",
					final: false,
				},
			}),
		).toThrow("finality");
		expect(() =>
			parseDaemonRpcResult(operation, {
				disposition: { ...cancelled, state: "terminal", outcome: "cancelled" },
			}),
		).toThrow("exact generation");
	});
});

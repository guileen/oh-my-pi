import { describe, expect, it } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import {
	applyWorkPackageTodoOutcome,
	bindWorkPackageTodo,
	getLatestTodoSnapshotIdentity,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function snapshot(phases: TodoPhase[]) {
	const session = SessionManager.inMemory(process.cwd());
	session.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	return getLatestTodoSnapshotIdentity(session.getBranch())!;
}

function tasks(): TodoPhase[] {
	return [
		{
			name: "Build",
			tasks: [
				{ content: "A", status: "in_progress" },
				{ content: "B", status: "pending" },
			],
		},
	];
}

describe("work-package todo outcomes", () => {
	it("binds the current task and advances the next pending task on completion", () => {
		const phases = tasks();
		const identity = snapshot(phases);
		const binding = bindWorkPackageTodo(phases, identity)!;
		applyWorkPackageTodoOutcome(phases, identity, binding, "completed");
		expect(phases[0].tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});

	it("resolves exact phase and task targets without silently choosing duplicate names", () => {
		const phases: TodoPhase[] = [
			{ name: "One", tasks: [{ content: "A", status: "in_progress" }] },
			{ name: "Two", tasks: [{ content: "A", status: "pending" }] },
		];
		const identity = snapshot(phases);
		expect(() => bindWorkPackageTodo(phases, identity, { task: "A" })).toThrow();
		const binding = bindWorkPackageTodo(phases, identity, { phase: "Two", task: "A" })!;
		applyWorkPackageTodoOutcome(phases, identity, binding, "blocked", "waiting");
		expect(phases[0].tasks[0].status).toBe("in_progress");
		expect(phases[1].tasks[0]).toMatchObject({ status: "blocked", blocker: "waiting" });
	});

	it("preserves a blocker and starts the next task rather than restarting blocked work", () => {
		const phases = tasks();
		const identity = snapshot(phases);
		const binding = bindWorkPackageTodo(phases, identity)!;
		expect(() => applyWorkPackageTodoOutcome(phases, identity, binding, "blocked", "  ")).toThrow();
		applyWorkPackageTodoOutcome(phases, identity, binding, "blocked", "waiting\nfor input");
		expect(phases[0].tasks[0]).toMatchObject({ status: "blocked", blocker: "waiting for input" });
		expect(phases[0].tasks[1].status).toBe("in_progress");
	});

	it("requires completed children before completing a phase", () => {
		const phases = tasks();
		const identity = snapshot(phases);
		const binding = bindWorkPackageTodo(phases, identity, { phase: "Build" })!;
		const before = structuredClone(phases);
		expect(() => applyWorkPackageTodoOutcome(phases, identity, binding, "completed")).toThrow();
		expect(phases).toEqual(before);
	});

	it("blocks only unfinished phase tasks and preserves completed and abandoned children", () => {
		const phases: TodoPhase[] = [
			{
				name: "P",
				tasks: [
					{ content: "done", status: "completed" },
					{ content: "drop", status: "abandoned" },
					{ content: "active", status: "in_progress" },
					{ content: "pending", status: "pending" },
				],
			},
			{ name: "Next", tasks: [{ content: "next", status: "pending" }] },
		];
		const identity = snapshot(phases);
		const binding = bindWorkPackageTodo(phases, identity, { phase: "P" })!;
		applyWorkPackageTodoOutcome(phases, identity, binding, "blocked", "external");
		expect(phases[0].tasks.map(task => task.status)).toEqual(["completed", "abandoned", "blocked", "blocked"]);
		expect(phases[0].tasks[2].blocker).toBe("external");
		expect(phases[1].tasks[0].status).toBe("in_progress");
	});

	it("rejects stale identity and removed targets without changing the caller's copy", () => {
		const phases = tasks();
		const identity = snapshot(phases);
		const binding = bindWorkPackageTodo(phases, identity)!;
		const before = structuredClone(phases);
		expect(() =>
			applyWorkPackageTodoOutcome(phases, { ...identity, sourceEntryId: "other" }, binding, "completed"),
		).toThrow();
		expect(phases).toEqual(before);
		phases[0].tasks.shift();
		const removed = structuredClone(phases);
		expect(() => applyWorkPackageTodoOutcome(phases, identity, binding, "completed")).toThrow();
		expect(phases).toEqual(removed);
	});

	it("does not reopen completed work and can resume blocked work without its old blocker", () => {
		const phases = tasks();
		const identity = snapshot(phases);
		const binding = bindWorkPackageTodo(phases, identity)!;
		applyWorkPackageTodoOutcome(phases, identity, binding, "completed");
		const nextIdentity = snapshot(phases);
		expect(() => bindWorkPackageTodo(phases, nextIdentity, { task: "A" })).toThrow();
		expect(() =>
			applyWorkPackageTodoOutcome(phases, nextIdentity, { ...binding, identity: nextIdentity }, "in_progress"),
		).toThrow();
		const next = bindWorkPackageTodo(phases, nextIdentity, { task: "B" })!;
		applyWorkPackageTodoOutcome(phases, nextIdentity, next, "blocked", "waiting");
		const blockedIdentity = snapshot(phases);
		const blocked = bindWorkPackageTodo(phases, blockedIdentity, { task: "B" })!;
		applyWorkPackageTodoOutcome(phases, blockedIdentity, blocked, "in_progress");
		expect(phases[0].tasks[1].status).toBe("in_progress");
		expect(phases[0].tasks[1].blocker).toBeUndefined();
	});
});

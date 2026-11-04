import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { isJsonSchemaValueValid } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolCall } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CONTEXT_NOTES_ENTRY_TYPE,
	getContextNotes,
	MAX_CONTEXT_NOTES_BYTES,
} from "@oh-my-pi/pi-coding-agent/session/context-notes";
import type { ContextNotesEntry } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import type { CustomEntry, ResetBoundaryEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type QaCheckpointAcceptance,
	type QaCheckpointInput,
	qaCheckpointError,
} from "@oh-my-pi/pi-coding-agent/session/qa-rollover";
import { ContextNotesTool, NewContextTool, type NewContextParams } from "@oh-my-pi/pi-coding-agent/tools/context-notes";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgCompactionExperimentalContextManagement } from "@oh-my-pi/pi-coding-agent/session/context-settings";

const NOW = "2026-09-04T00:00:00.000Z";

function noteEntry(id: string, parentId: string | null, text: string): CustomEntry<ContextNotesEntry> {
	return {
		type: "custom",
		customType: CONTEXT_NOTES_ENTRY_TYPE,
		data: { version: 1, text },
		id,
		parentId,
		timestamp: NOW,
	};
}

function resetEntry(id: string, parentId: string | null): ResetBoundaryEntry {
	return { type: "reset_boundary", id, parentId, timestamp: NOW };
}

function toolSession(
	settings: Settings,
	sessionManager: SessionManager,
	ownerId = sessionManager.getSessionId(),
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionId: () => ownerId,
		getSessionSpawns: () => null,
		sessionManager,
	};
}

function codexModel() {
	return buildModel({
		id: "gpt-5.5",
		name: "gpt-5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

describe("experimental context notes", () => {
	it("accepts an omitted text on the model wire and reads saved notes without modifying the journal", async () => {
		using tempDir = TempDir.createSync("@omp-context-notes-read-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const manager = SessionManager.create(tempDir.path(), sessionDir);
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, manager));
		if (!tool) throw new Error("expected context notes tool");
		try {
			await tool.execute("save", { text: "retain this notebook" });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("expected persisted session file");
			const before = await Bun.file(sessionFile).text();
			const revision = getContextNotes(manager.getBranch());
			const model = codexModel();
			const [wireTool] = convertOpenAICodexResponsesTools([tool], model);
			if (wireTool?.type !== "function") throw new Error("expected function schema");
			expect(isJsonSchemaValueValid(wireTool.parameters, {})).toBe(true);
			expect(isJsonSchemaValueValid(wireTool.parameters, { text: "" })).toBe(true);
			expect(isJsonSchemaValueValid(wireTool.parameters, { text: null })).toBe(false);
			const args = validateToolCall([tool], { type: "toolCall", id: "read", name: tool.name, arguments: {} });
			const read = await tool.execute("read", tool.parameters.assert(args));
			expect(read.content).toEqual([{ type: "text", text: "retain this notebook" }]);
			expect(getContextNotes(manager.getBranch())).toEqual(revision);
			expect(await Bun.file(sessionFile).text()).toBe(before);
			await tool.execute("clear", { text: "" });
			expect(getContextNotes(manager.getBranch())?.text).toBe("");
			expect(getContextNotes(manager.getBranch())?.entryId).not.toBe(revision?.entryId);
			const resumed = await SessionManager.open(sessionFile, sessionDir);
			try {
				expect(getContextNotes(resumed.getBranch())?.text).toBe("");
			} finally {
				await resumed.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("rejects an oversized UTF-8 replacement while retaining the current notebook revision", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const session = toolSession(settings, sessionManager);
		const tool = ContextNotesTool.createIf(session);
		if (!tool) throw new Error("expected context notes tool");

		await tool.execute("initial", { text: "Retain this notebook after an invalid replacement." });
		const multibyteCharacter = "€";
		const oversized = multibyteCharacter.repeat(
			Math.floor(MAX_CONTEXT_NOTES_BYTES / Buffer.byteLength(multibyteCharacter, "utf8")) + 1,
		);
		await expect(tool.execute("overflow", { text: oversized })).rejects.toThrow(
			`${MAX_CONTEXT_NOTES_BYTES} UTF-8 bytes`,
		);
		expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_CONTEXT_NOTES_BYTES);
		expect(getContextNotes(sessionManager.getBranch())?.text).toBe(
			"Retain this notebook after an invalid replacement.",
		);
		expect(
			sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === CONTEXT_NOTES_ENTRY_TYPE),
		).toHaveLength(1);
	});

	it("leaves the branch journal unchanged when reading a missing notebook", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, sessionManager));
		if (!tool) throw new Error("expected context notes tool");

		await tool.execute("read-missing", {});
		expect(getContextNotes(sessionManager.getBranch())).toBeUndefined();
		expect(sessionManager.getBranch()).toHaveLength(0);
	});

	it("uses only the active branch's latest notebook and hides it after a context reset", () => {
		const shared = noteEntry("base", null, "shared context");
		const branchA: SessionEntry[] = [shared, noteEntry("a", "base", "branch A context")];
		const branchB: SessionEntry[] = [shared, noteEntry("b", "base", "branch B context")];
		const resetBranch: SessionEntry[] = [
			shared,
			resetEntry("reset", "base"),
			noteEntry("after", "reset", "fresh context"),
		];

		expect(getContextNotes(branchA)).toEqual({ entryId: "a", text: "branch A context" });
		expect(getContextNotes(branchB)).toEqual({ entryId: "b", text: "branch B context" });
		expect(getContextNotes(resetBranch)).toEqual({ entryId: "after", text: "fresh context" });
		expect(getContextNotes([shared, resetEntry("clear", "base")])).toBeUndefined();
	});

	it("persists a replacement for resume and refuses disabled or parent-bound tool sessions", async () => {
		using tempDir = TempDir.createSync("@omp-context-notes-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const session = toolSession(settings, sessionManager);
		const tool = ContextNotesTool.createIf(session);
		if (!tool) throw new Error("expected context notes tool");

		await tool.execute("save", { text: "preserve this across resume" });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const resumed = await SessionManager.open(sessionFile, sessionDir);
		try {
			expect(getContextNotes(resumed.getBranch())).toMatchObject({ text: "preserve this across resume" });
		} finally {
			await resumed.close();
			await sessionManager.close();
		}

		const disabled = toolSession(
			Settings.isolated({ "compaction.experimentalContextManagement": false }),
			SessionManager.inMemory(),
		);
		expect(ContextNotesTool.createIf(disabled)).toBeNull();
		expect(NewContextTool.createIf(disabled)).toBeNull();

		const advisorBound = toolSession(settings, SessionManager.inMemory(), "advisor-session");
		expect(ContextNotesTool.createIf(advisorBound)).toBeNull();
	});
	it("does not append notes when the branch changes while disk preparation is pending", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, sessionManager));
		if (!tool) throw new Error("expected context notes tool");
		const pendingEnsure = Promise.withResolvers<void>();
		const ensureSpy = vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(() => pendingEnsure.promise);
		try {
			const pendingWrite = tool.execute("stale-branch", { text: "must not persist" });
			await Promise.resolve();
			sessionManager.appendCustomEntry("test_branch_change");
			pendingEnsure.resolve();
			await expect(pendingWrite).rejects.toThrow("session branch changed");
			expect(getContextNotes(sessionManager.getBranch())).toBeUndefined();
		} finally {
			ensureSpy.mockRestore();
		}
	});

	it("does not append notes when experimental context management is disabled while preparing disk", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.experimentalContextManagement": true });
		const tool = ContextNotesTool.createIf(toolSession(settings, sessionManager));
		if (!tool) throw new Error("expected context notes tool");
		const pendingEnsure = Promise.withResolvers<void>();
		const ensureSpy = vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(() => pendingEnsure.promise);
		try {
			const pendingWrite = tool.execute("disabled-mid-write", { text: "must not persist" });
			await Promise.resolve();
			cfgCompactionExperimentalContextManagement.override(settings, false);
			pendingEnsure.resolve();
			await expect(pendingWrite).rejects.toThrow("Experimental context management is disabled.");
			expect(getContextNotes(sessionManager.getBranch())).toBeUndefined();
		} finally {
			ensureSpy.mockRestore();
		}
	});
});

describe("QA new_context checkpoint contracts", () => {
	const checkpoint: QaCheckpointInput = {
		cycleId: "qa:session:1",
		summary: "Parser edits saved; smoke failed on empty input. Integration not run.",
		disposition: "continue",
		nextAction: "Inspect the empty-input parser failure.",
	};

	function qaSession(accept: NonNullable<ToolSession["qaRollover"]>["accept"]): ToolSession {
		return {
			...toolSession(Settings.isolated({}), SessionManager.inMemory()),
			skipPythonPreflight: true,
			qaRollover: { isEnabled: () => true, accept },
		};
	}

	function requireTool(session: ToolSession): NewContextTool {
		const tool = NewContextTool.createIf(session);
		if (!tool) throw new Error("expected QA new_context tool");
		return tool;
	}

	it("advertises every disposition without forcing a nullable next action", () => {
		const tool = requireTool(
			qaSession(async () => {
				throw new Error("schema validation must not execute acceptance");
			}),
		);
		const [wireTool] = convertOpenAICodexResponsesTools([tool], codexModel());
		if (wireTool?.type !== "function") throw new Error("expected function schema");
		const valid = [
			{ checkpoint },
			{ checkpoint: { cycleId: checkpoint.cycleId, summary: checkpoint.summary, disposition: "complete" } },
			{ checkpoint: { cycleId: checkpoint.cycleId, summary: checkpoint.summary, disposition: "blocked" } },
		];
		for (const arguments_ of valid) {
			expect(isJsonSchemaValueValid(wireTool.parameters, arguments_)).toBe(true);
			expect(() =>
				validateToolCall([tool], {
					type: "toolCall",
					id: "wire",
					name: tool.name,
					arguments: arguments_,
				}),
			).not.toThrow();
		}
		for (const arguments_ of [
			{},
			{ checkpoint: { ...checkpoint, nextAction: null } },
			{ checkpoint: { ...checkpoint, timestamp: NOW } },
			{ checkpoint, extra: true },
		]) {
			expect(isJsonSchemaValueValid(wireTool.parameters, arguments_)).toBe(false);
		}
	});

	it("rejects malformed checkpoints before invoking the owning persistence callback", async () => {
		const accept = vi.fn(async (): Promise<QaCheckpointAcceptance> => {
			throw new Error("malformed checkpoints must not reach persistence");
		});
		const tool = requireTool(qaSession(accept));
		const invalid: unknown[] = [
			{},
			null,
			[],
			{ checkpoint: null },
			{ checkpoint: { ...checkpoint, cycleId: " " } },
			{ checkpoint: { ...checkpoint, summary: "\n\t" } },
			{ checkpoint: { cycleId: checkpoint.cycleId, summary: checkpoint.summary, disposition: "continue" } },
			{ checkpoint: { ...checkpoint, nextAction: null } },
			{ checkpoint: { ...checkpoint, disposition: "complete" } },
			{ checkpoint: { ...checkpoint, disposition: "complete", nextAction: undefined } },
			{ checkpoint: { ...checkpoint, nextAction: "" } },
			{ checkpoint: { ...checkpoint, nextAction: " \n" } },
			{ checkpoint: { ...checkpoint, disposition: "unknown" } },
			{ checkpoint: { ...checkpoint, disposition: "blocked" } },
			{ checkpoint: { ...checkpoint, version: 1 } },
			{ checkpoint, text: "ignored data is unsafe" },
		];
		for (const params of invalid) {
			const args = validateAgentToolArguments(tool, {
				type: "toolCall",
				id: "invalid",
				name: tool.name,
				arguments: params as Record<string, unknown>,
			});
			await expect(tool.execute("invalid", args as NewContextParams)).rejects.toMatchObject({
				context: { code: "QA_INVALID_CHECKPOINT" },
			});
		}
		expect(accept).not.toHaveBeenCalled();
	});

	it("does not acknowledge a checkpoint until the owner has durably accepted it", async () => {
		const persisted = Promise.withResolvers<QaCheckpointAcceptance>();
		const accept = vi.fn((_input: QaCheckpointInput, _signal?: AbortSignal) => persisted.promise);
		const tool = requireTool(qaSession(accept));
		const controller = new AbortController();
		let acknowledged = false;
		const result = tool.execute("persist", { checkpoint }, controller.signal).then(value => {
			acknowledged = true;
			return value;
		});
		await Promise.resolve();
		expect(accept).toHaveBeenCalledWith(checkpoint, controller.signal);
		expect(acknowledged).toBe(false);
		persisted.resolve({
			requested: true,
			checkpoint: { cycleId: checkpoint.cycleId, entryId: "durable-entry", status: "accepted" },
		});
		await result;
		expect(acknowledged).toBe(true);
	});

	it("preserves typed owner errors instead of reporting a recorded checkpoint", async () => {
		for (const code of ["QA_STALE_CYCLE", "QA_CHECKPOINT_CONFLICT", "QA_PERSIST_FAILED"] as const) {
			const error = qaCheckpointError(code, "owner rejected checkpoint", checkpoint.cycleId);
			const tool = requireTool(
				qaSession(async () => {
					throw error;
				}),
			);
			await expect(tool.execute("owner-error", { checkpoint })).rejects.toBe(error);
			await expect(wrapToolWithMetaNotice(tool).execute("wrapped-owner-error", { checkpoint })).rejects.toBe(error);
		}
	});

	it("requires an enabled live journal owner and rechecks eligibility when an existing tool executes", async () => {
		const accept = vi.fn(async (): Promise<QaCheckpointAcceptance> => {
			throw new Error("unavailable owners must not receive checkpoints");
		});
		const session = qaSession(accept);
		const tool = requireTool(session);
		session.qaRollover = { isEnabled: () => false, accept };
		expect(NewContextTool.createIf(session)).toBeNull();
		await expect(tool.execute("disabled", { checkpoint })).rejects.toMatchObject({
			context: { code: "QA_NOT_ACTIVE", cycleId: checkpoint.cycleId },
		});
		for (const overrides of [
			{ isDisposed: () => true },
			{ getSessionId: () => "advisor-or-parent-session" },
			{ sessionManager: undefined },
			{ qaRollover: undefined },
		]) {
			expect(NewContextTool.createIf({ ...qaSession(accept), ...overrides })).toBeNull();
		}
		expect(accept).not.toHaveBeenCalled();
	});

	it("preserves experimental empty-object precedence and refuses QA data rather than ignoring it", async () => {
		const accept = vi.fn(async (): Promise<QaCheckpointAcceptance> => {
			throw new Error("experimental notes mode must not invoke QA");
		});
		const session = qaSession(accept);
		cfgCompactionExperimentalContextManagement.override(session.settings, true);
		const tool = requireTool(session);
		expect((await tool.execute("experimental", {})).details).toEqual({ requested: true });
		await expect(tool.execute("wrong-mode", { checkpoint })).rejects.toMatchObject({
			context: { code: "QA_NOT_ACTIVE", cycleId: checkpoint.cycleId },
		});
		await expect(tool.execute("unknown-data", { text: "must not be discarded" })).rejects.toThrow(
			"accepts only an empty object",
		);
		expect(accept).not.toHaveBeenCalled();
	});

	it("registers the owner tool for TUI and headless sessions without widening restricted tool grants", async () => {
		for (const hasUI of [true, false]) {
			const session = qaSession(async () => {
				throw new Error("registration must not accept a checkpoint");
			});
			session.hasUI = hasUI;
			session.taskDepth = hasUI ? 0 : 1;
			expect((await createTools(session, ["read"])).map(tool => tool.name)).toContain("new_context");
			expect(
				(await createTools({ ...session, restrictToolNames: true }, ["read"])).map(tool => tool.name),
			).not.toContain("new_context");
			expect(
				(await createTools({ ...session, restrictToolNames: true }, ["new_context"])).map(tool => tool.name),
			).toEqual(["new_context"]);
		}
	});

	it("does not invoke acceptance for an already aborted tool execution", async () => {
		const accept = vi.fn(async (): Promise<QaCheckpointAcceptance> => {
			throw new Error("aborted execution must not reach persistence");
		});
		const tool = requireTool(qaSession(accept));
		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("aborted", { checkpoint }, controller.signal)).rejects.toThrow();
		expect(accept).not.toHaveBeenCalled();
	});
});

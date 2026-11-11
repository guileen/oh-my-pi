import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { INSTRUCTION_ANCHOR_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/instruction-anchor";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * The `rewind` tool reaches the session through the host bridge built in
 * `sdk.ts`. A point that resolves on the branch is useless when the bridge
 * omits `getInstructionAnchor`/`validateInstructionRewind`: the optional calls
 * fall through and the tool reports "No active checkpoint". These cases drive
 * the tool, not the session API, so a missing wiring fails here.
 */
describe("instruction rewind through the session tool bridge", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionManagerRef: SessionManager | undefined;
	let noticeEntryId: string | undefined;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	async function openSessionWithPoint(id: string): Promise<AgentSession> {
		tempDir = TempDir.createSync("@pi-instruction-rewind-tool-");
		const settings = Settings.isolated({ "async.enabled": false, "compaction.enabled": false });
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "fix a" }],
			timestamp: Date.now(),
		});
		// Mirrors the shape `#instructionNoticeFor` persists: an agent-attributed
		// hidden notice whose id lives in `details`.
		noticeEntryId = sessionManager.appendCustomMessageEntry(
			INSTRUCTION_ANCHOR_MESSAGE_TYPE,
			`Instruction rewind point \`${id}\` is available.`,
			false,
			{ id },
			"agent",
		);
		sessionManagerRef = sessionManager;
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry,
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;
		return result.session;
	}

	function rewindTool(session: AgentSession) {
		const tool = session.agent.state.tools.find(candidate => candidate.name === "rewind");
		if (!tool) throw new Error("Expected the rewind tool in the default roster");
		return tool;
	}

	it("accepts the advertised point instead of reporting no active checkpoint", async () => {
		const opened = await openSessionWithPoint("R0");
		const result = await rewindTool(opened).execute("call-1", {
			checkpointId: "R0",
			report: "located in a.ts:12",
			nextAction: "apply the fix",
		});
		expect(result.details).toMatchObject({
			instructionAnchor: true,
			checkpointId: "R0",
			report: "located in a.ts:12",
		});
	});

	it("rejects an id that is not on the branch as a stale point", async () => {
		const opened = await openSessionWithPoint("R0");
		await expect(
			rewindTool(opened).execute("call-2", {
				checkpointId: "R7",
				report: "located",
				nextAction: "continue",
			}),
		).rejects.toThrow("Instruction rewind point R7 is stale or unavailable");
	});

	it("treats null-valued optional parameters as omitted", async () => {
		const opened = await openSessionWithPoint("R0");
		const result = await rewindTool(opened).execute("call-4", {
			checkpointId: "R0",
			report: "null optionals normalized",
			nextAction: "continue",
			outcome: null,
			reason: null,
			note: null,
		});
		expect(result.details.instructionAnchor).toBe(true);
	});

	it("keeps the point reusable after an observation fold cut past it", async () => {
		const opened = await openSessionWithPoint("R0");
		if (!sessionManagerRef || !noticeEntryId) throw new Error("Expected the harness to record the notice");
		// What `rewind({observationId})` writes: a branch summary whose parent is the
		// cut point, which here sits after the notice. The notice survives on the
		// branch, so the point must stay usable — invalidating it broke real runs.
		sessionManagerRef.branchWithSummary(noticeEntryId, "", { kind: "search-rewind" });
		const result = await rewindTool(opened).execute("call-3", {
			checkpointId: "R0",
			report: "chain read order captured in the notes",
			nextAction: "answer the user",
		});
		expect(result.details).toMatchObject({ instructionAnchor: true, checkpointId: "R0" });
	});
});

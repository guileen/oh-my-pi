import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { validateToolCall } from "@oh-my-pi/pi-ai/utils/validation";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	cfgCompactionEnabled,
	cfgCompactionExperimentalContextManagement,
	cfgCompactionMethodOrder,
	cfgCompactionMidTurnEnabled,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import { cfgBashEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgGithubEnabled, cfgGrepEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Tool-gating settings (`grep.enabled`, `*.enabled`, ...) must reconcile a live
// session's tools and prompt instead of waiting for the next session.
describe("settings-gated tools in a live session", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-settings-gated-tools-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function startSession(settings: Settings, toolNames?: string[]): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: registryDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames,
		});
		sessions.push(session);
		return session;
	}

	/** Lets the coalesced watch fire, then waits for the reconcile it queued on the registry lock. */
	async function settle(session: AgentSession): Promise<void> {
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
	}

	const GREP_POLICY = "NEVER shell `grep`/`rg`/`awk`";

	it("removes and restores grep in the request tools and system prompt", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);

		cfgGrepEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getToolByName("grep")).toBeUndefined();
		expect(session.systemPrompt.join("\n")).not.toContain(GREP_POLICY);
		expect(session.getActiveToolNames()).toContain("read");

		cfgGrepEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);
	});

	it("never widens an explicit tool list", async () => {
		const settings = Settings.isolated({ "grep.enabled": false, "github.enabled": false });
		const session = await startSession(settings, ["read", "bash"]);
		const before = session.getActiveToolNames();
		expect(before).not.toContain("grep");

		cfgGrepEnabled.set(settings, true);
		cfgGithubEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toEqual(before);
		expect(session.getToolByName("grep")).toBeUndefined();

		cfgBashEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).toContain("read");
	});

	it("replaces new_context schemas on experimental/QA mode switches and follows live QA eligibility", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.methodOrder": ["qaonly"],
		});
		const session = await startSession(settings, ["read", "grep"]);
		expect(session.getToolByName("new_context")).toBeUndefined();

		cfgCompactionEnabled.override(settings, true);
		await settle(session);
		const qaTool = session.getToolByName("new_context");
		if (!qaTool) throw new Error("expected QA acknowledgement tool");
		expect(() =>
			validateToolCall([qaTool], {
				type: "toolCall",
				id: "qa-empty",
				name: "new_context",
				arguments: {},
			}),
		).toThrow();
		const qaCheckpoint = {
			checkpoint: { cycleId: "qa:wire-only", summary: "Saved work; awaiting approval.", disposition: "blocked" },
		};
		expect(() =>
			validateToolCall([qaTool], {
				type: "toolCall",
				id: "qa-checkpoint",
				name: "new_context",
				arguments: qaCheckpoint,
			}),
		).not.toThrow();

		cfgCompactionExperimentalContextManagement.override(settings, true);
		await settle(session);
		const experimentalTool = session.getToolByName("new_context");
		if (!experimentalTool) throw new Error("expected experimental rollover tool");
		expect(session.getActiveToolNames()).toContain("context_notes");
		expect(() =>
			validateToolCall([experimentalTool], {
				type: "toolCall",
				id: "experimental-empty",
				name: "new_context",
				arguments: {},
			}),
		).not.toThrow();
		await expect(experimentalTool.execute("wrong-mode", qaCheckpoint)).rejects.toMatchObject({
			context: { code: "QA_NOT_ACTIVE" },
		});

		cfgCompactionExperimentalContextManagement.override(settings, false);
		await settle(session);
		const restoredQaTool = session.getToolByName("new_context");
		if (!restoredQaTool) throw new Error("expected restored QA acknowledgement tool");
		expect(() =>
			validateToolCall([restoredQaTool], {
				type: "toolCall",
				id: "restored-empty",
				name: "new_context",
				arguments: {},
			}),
		).toThrow();

		cfgCompactionMidTurnEnabled.override(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("new_context");
		cfgCompactionMidTurnEnabled.override(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("new_context");
		cfgCompactionMethodOrder.override(settings, ["soft"]);
		await settle(session);
		expect(session.getToolByName("new_context")).toBeUndefined();
	});

	it("removes a QA force-inclusion when experimental mode would not grant that tool list", async () => {
		const settings = Settings.isolated({ "compaction.methodOrder": ["qaonly"] });
		const session = await startSession(settings, ["read"]);
		expect(session.getActiveToolNames()).toContain("new_context");
		cfgCompactionExperimentalContextManagement.override(settings, true);
		await settle(session);
		expect(session.getToolByName("new_context")).toBeUndefined();
		expect(session.getActiveToolNames()).not.toContain("context_notes");
	});
});

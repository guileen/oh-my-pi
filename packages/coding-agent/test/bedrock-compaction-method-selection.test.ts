import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	DEFAULT_COMPACTION_METHOD_ORDER,
	type EngineCompactionMethod,
	isCompactionMethod,
	resolveCompactionMethodOrder,
	resolveMethodSettings,
	resolveSpeculationMethod,
} from "@oh-my-pi/pi-coding-agent/session/compaction-methods";

/** Resolve Bedrock support from the authored identity and compat rules, not generated model data. */
function getBedrockCompactionModel() {
	const sourceSpec: ModelSpec<"bedrock-converse-stream"> = {
		id: "global.anthropic.claude-opus-5-5",
		name: "Claude Opus 5.5 (Global)",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
	return buildModel(sourceSpec);
}

describe("Bedrock native compaction method selection", () => {
	test("prefers native remote compaction and keeps ineligible routes on the soft fallback", () => {
		const model = getBedrockCompactionModel();
		const settings = Settings.isolated({ "compaction.methodOrder": ["remote", "soft"] });
		const compaction = cfgCompaction.get(settings);

		expect(resolveSpeculationMethod(model, compaction)).toBe("remote");
		expect(resolveSpeculationMethod({ ...model, remoteCompaction: { enabled: false } }, compaction)).toBe("soft");
	});
});

describe("automatic QA method selection", () => {
	test.each([{ methodOrder: ["qaonly"] }, { methodOrder: ["qaonly", "soft"] }])(
		"preserves the configured QA order %j",
		({ methodOrder }) => {
			const compaction = cfgCompaction.get(Settings.isolated({ "compaction.methodOrder": methodOrder }));
			expect(compaction.methodOrder).toEqual(methodOrder);
			expect(resolveCompactionMethodOrder(compaction.methodOrder)).toEqual([...methodOrder]);
			expect(isCompactionMethod("qaonly")).toBe(true);
		},
	);

	test("filters invalid entries and duplicates without adding a paid fallback", () => {
		expect(resolveCompactionMethodOrder(["qaonly", "invalid", "qaonly", null])).toEqual(["qaonly"]);
		expect(resolveCompactionMethodOrder(["qaonly", "soft", "qaonly", "remote"])).toEqual([
			"qaonly",
			"soft",
			"remote",
		]);
	});

	test("keeps automatic defaults unchanged", () => {
		expect(DEFAULT_COMPACTION_METHOD_ORDER).toEqual(["remote", "snapcompact", "handoff", "shake", "soft"]);
		expect(cfgCompaction.get(Settings.isolated()).methodOrder).toEqual(DEFAULT_COMPACTION_METHOD_ORDER);
	});

	test.each([
		{ methodOrder: ["qaonly"] },
		{ methodOrder: ["qaonly", "soft"] },
		{ methodOrder: ["remote", "qaonly", "soft"] },
	])("does not speculate past a selected local QA method %j", ({ methodOrder }) => {
		const model = { ...getBedrockCompactionModel(), remoteCompaction: { enabled: false } };
		const compaction = cfgCompaction.get(Settings.isolated({ "compaction.methodOrder": methodOrder }));
		expect(resolveSpeculationMethod(model, compaction)).toBeUndefined();
	});

	test("keeps earlier eligible remote speculation ahead of QA", () => {
		const compaction = cfgCompaction.get(
			Settings.isolated({ "compaction.methodOrder": ["remote", "qaonly", "soft"] }),
		);
		expect(resolveSpeculationMethod(getBedrockCompactionModel(), compaction)).toBe("remote");
		expect(resolveSpeculationMethod(getBedrockCompactionModel(), compaction, { skipRemote: true })).toBeUndefined();
	});

	test("rejects QA at the generic summary engine boundary", () => {
		const compaction = cfgCompaction.get(Settings.isolated({ "compaction.methodOrder": ["qaonly", "soft"] }));
		expect(() => resolveMethodSettings(compaction, "qaonly" as EngineCompactionMethod)).toThrow();
		expect(resolveMethodSettings(compaction, "soft")).toMatchObject({
			strategy: "context-full",
			remoteEnabled: false,
		});
	});
});

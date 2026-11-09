import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { renderProviderModels } from "@oh-my-pi/pi-coding-agent/cli/models-cli";

afterEach(() => {
	vi.restoreAllMocks();
});

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as ModelSpec);
}

function render(args: { models: Model<Api>[]; compact?: boolean; index?: boolean; pattern?: string }): string {
	const output: string[] = [];
	spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	renderProviderModels(
		{ getAvailable: () => args.models, getError: () => undefined },
		"ls",
		args.pattern,
		false,
		"chat",
		args.compact,
		args.index,
	);
	return output.join("").replace(/\u001b\[[0-9;]*m/g, "");
}

const CATALOG = [model("alpha", "a-1"), model("alpha", "a-2"), model("beta", "b-1")];

describe("omp models summary rendering", () => {
	it("index mode reports provider counts and omits every model row", () => {
		const text = render({ models: CATALOG, index: true });
		expect(text).toContain("alpha (2)");
		expect(text).toContain("beta (1)");
		expect(text).toContain("2 provider(s), 3 model(s)");
		expect(text).not.toContain("a-1");
		expect(text).not.toContain("│");
	});

	it("a provider filter wins over index mode so the drill-down stays detailed", () => {
		const text = render({ models: CATALOG, index: true, pattern: "alpha" });
		expect(text).toContain("a-1");
		expect(text).toContain("a-2");
		expect(text).not.toContain("b-1");
	});

	it("compact mode drops the box borders but keeps one row per model", () => {
		const text = render({ models: CATALOG, compact: true, pattern: "alpha" });
		expect(text).not.toContain("│");
		expect(text).toContain("a-1");
		expect(text).toContain("a-2");
		expect(render({ models: CATALOG, pattern: "alpha" })).toContain("│");
	});
});

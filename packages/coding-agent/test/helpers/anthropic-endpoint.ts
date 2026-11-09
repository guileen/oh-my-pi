import { afterEach, beforeEach } from "bun:test";

/**
 * Neutralize Anthropic gateway and Foundry routing for the calling test file.
 * Tests that exercise rerouting can set the variables explicitly inside the test.
 */
export function withOfficialAnthropicEndpoint(): void {
	const keys = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY"] as const;
	let previous: (string | undefined)[];
	beforeEach(() => {
		previous = keys.map(key => Bun.env[key]);
		for (const key of keys) delete Bun.env[key];
	});
	afterEach(() => {
		for (const [index, key] of keys.entries()) {
			const value = previous[index];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});
}

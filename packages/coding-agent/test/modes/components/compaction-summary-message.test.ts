import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
	HandoffSummaryMessageComponent,
} from "@oh-my-pi/pi-tui/chat/compaction-summary-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { CompactionSummaryMessage, CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

function makeHandoffMessage(content: CustomMessage<unknown>["content"]): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: "handoff",
		content,
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

describe("handoff summary divider", () => {
	it("renders handoff custom messages with the compact divider instead of a framed block", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage(
				`<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>\n\nThe above is a handoff document.`,
			),
			false,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const collapsed = Bun.stripANSI(component!.render(80).join("\n"));
		expect(collapsed).toContain("handed-off");
		expect(collapsed).not.toContain("[handoff]");
		expect(collapsed).not.toContain("Continue the resize fix");
	});

	it("expands to the handoff document without the provider-only XML wrapper", () => {
		const component = createHandoffSummaryMessageComponent(
			makeHandoffMessage([
				{
					type: "text",
					text: "<handoff-context>\n# Goal\nContinue the resize fix.\n</handoff-context>",
				},
			]),
			true,
		);

		expect(component).toBeInstanceOf(HandoffSummaryMessageComponent);
		const expanded = Bun.stripANSI(component!.render(80).join("\n"));
		expect(expanded).toContain("Handoff context");
		expect(expanded).toContain("Continue the resize fix");
		expect(expanded).not.toContain("<handoff-context>");
		expect(expanded).not.toContain("</handoff-context>");
	});

	it("leaves unrelated custom messages on the generic renderer path", () => {
		const message = makeHandoffMessage("Not a handoff.");
		message.customType = "extension-note";

		expect(createHandoffSummaryMessageComponent(message, false)).toBeUndefined();
	});
});

describe("QA compaction summary divider", () => {
	function qaMessage(overrides: Partial<CompactionSummaryMessage> = {}): CompactionSummaryMessage {
		return {
			role: "compactionSummary",
			summary: "Saved work and next operation.",
			tokensBefore: 100_000,
			tokensAfter: 70_000,
			method: "qaonly",
			timestamp: 1,
			...overrides,
		};
	}

	it("shows local QA and observed before/after amounts", () => {
		const component = new CompactionSummaryMessageComponent(qaMessage());
		try {
			const collapsed = Bun.stripANSI(component.render(80).join("\n"));
			expect(collapsed).toContain("Q&A");
			expect(collapsed).toContain("100K");
			expect(collapsed).toContain("70K");
			expect(collapsed).not.toContain("Saved work");
		} finally {
			component.dispose();
		}
	});

	it("does not invent an after count when it is unavailable", () => {
		const component = new CompactionSummaryMessageComponent(qaMessage({ tokensAfter: undefined }));
		try {
			const collapsed = Bun.stripANSI(component.render(80).join("\n"));
			expect(collapsed).not.toContain("→");
			expect(collapsed).not.toContain("0 tokens");
			component.setExpanded(true);
			const expanded = Bun.stripANSI(component.render(80).join("\n"));
			expect(expanded).toContain("100,000");
			expect(expanded).not.toContain("to 0");
		} finally {
			component.dispose();
		}
	});

	it.each([1, 4, 12, 24, 80])("keeps QA divider rows within %s columns", width => {
		const component = new CompactionSummaryMessageComponent(qaMessage());
		try {
			for (const line of component.render(width)) {
				expect(Bun.stringWidth(line, { countAnsiEscapeCodes: false })).toBeLessThanOrEqual(width);
			}
		} finally {
			component.dispose();
		}
	});
});

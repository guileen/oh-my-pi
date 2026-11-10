import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BotGraphToolCallContext } from "../src/bots/agent-runtime";
import {
	assertGrantedToolCall,
	grantedToolNames,
	type GraphMemberGrants,
	validateExecuteGrant,
	validateGrantPattern,
} from "../src/graph/workspace-grants";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-grants-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(root, "README.md"), "# readme\n");
	return root;
}

function grants(overrides: Partial<GraphMemberGrants> = {}): GraphMemberGrants {
	return { read: [], write: [], execute: [], ...overrides };
}

function call(name: string, args: Record<string, unknown> = {}): BotGraphToolCallContext {
	return { toolCall: { type: "toolCall", id: "call", name, arguments: args }, args };
}

async function denied(promise: Promise<void>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? "none";
	}
	throw new Error("Expected the call to be denied");
}

describe("workspace grant admission", () => {
	it("admits reads inside the granted subtree and refuses the rest of the workspace", async () => {
		const root = workspace();
		const scope = grants({ read: ["src"] });
		await assertGrantedToolCall(call("read", { path: "src/a.ts" }), scope, root);
		await assertGrantedToolCall(call("grep", { path: "src/nested" }), scope, root);
		expect(await denied(assertGrantedToolCall(call("read", { path: "README.md" }), scope, root))).toBe(
			"permission_denied",
		);
	});

	it("admits root searches only for full read grants and checks selectors against the actual file", async () => {
		const root = workspace();
		await assertGrantedToolCall(call("glob", { path: "**/*.ts" }), grants({ read: ["**"] }), root);
		await assertGrantedToolCall(call("read", { path: "src/a.ts:1-2" }), grants({ read: ["src/**"] }), root);
		expect(await denied(assertGrantedToolCall(call("grep"), grants({ read: ["src/**"] }), root))).toBe(
			"permission_denied",
		);
		for (const target of ["src;../secret", "src /outside", "src/{a,../../secret}"]) {
			expect(
				await denied(assertGrantedToolCall(call("grep", { path: target }), grants({ read: ["**"] }), root)),
			).toBe("permission_denied");
		}
	});

	it("checks every host-inspected edit target including a rename destination before writing", async () => {
		const root = workspace();
		const context = {
			...call("edit", { input: "opaque native patch" }),
			editTargets: ["src/a.ts", "README.md"],
		};
		expect(await denied(assertGrantedToolCall(context, grants({ write: ["src/**"] }), root))).toBe(
			"permission_denied",
		);
		await assertGrantedToolCall(
			{ ...context, editTargets: ["src/a.ts", "src/b.ts"] },
			grants({ write: ["src/**"] }),
			root,
		);
		expect(
			await denied(assertGrantedToolCall({ ...context, editTargets: [] }, grants({ write: ["**"] }), root)),
		).toBe("permission_denied");
	});

	it("refuses parent traversal, absolute paths outside the workspace, and symlink escapes", async () => {
		const root = workspace();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "graph-grants-outside-"));
		roots.push(outside);
		fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
		fs.symlinkSync(outside, path.join(root, "leak"));
		const scope = grants({ read: ["**"] });
		expect(await denied(assertGrantedToolCall(call("read", { path: "../outside" }), scope, root))).toBe(
			"permission_denied",
		);
		expect(
			await denied(assertGrantedToolCall(call("read", { path: path.join(outside, "secret.txt") }), scope, root)),
		).toBe("permission_denied");
		expect(await denied(assertGrantedToolCall(call("read", { path: "leak/secret.txt" }), scope, root))).toBe(
			"permission_denied",
		);
	});

	it("admits writes only through a declared write grant and keeps undeclared tools closed", async () => {
		const root = workspace();
		const scope = grants({ write: ["src/**"] });
		await assertGrantedToolCall(call("write", { path: "src/new.ts" }), scope, root);
		expect(await denied(assertGrantedToolCall(call("edit", { path: "README.md" }), scope, root))).toBe(
			"permission_denied",
		);
		expect(await denied(assertGrantedToolCall(call("read", { path: "src/a.ts" }), scope, root))).toBe(
			"permission_denied",
		);
	});

	it("admits only declared named commands and refuses shell composition", async () => {
		const root = workspace();
		await assertGrantedToolCall(call("bash", { command: "bun test" }), grants({ execute: ["test"] }), root);
		await assertGrantedToolCall(
			call("bash", { command: "bun run check:types" }),
			grants({ execute: ["typecheck"] }),
			root,
		);
		expect(
			await denied(
				assertGrantedToolCall(call("bash", { command: "bun run check" }), grants({ execute: ["test"] }), root),
			),
		).toBe("permission_denied");
		expect(
			await denied(
				assertGrantedToolCall(call("bash", { command: "bun test; rm -rf ." }), grants({ execute: ["test"] }), root),
			),
		).toBe("permission_denied");
		expect(await denied(assertGrantedToolCall(call("bash", { command: "bun test" }), grants(), root))).toBe(
			"permission_denied",
		);
	});

	it("rejects grant declarations that cannot be bounded to the workspace", () => {
		for (const pattern of ["/etc/passwd", "../secrets", "~/.ssh", "src//nested", ""]) {
			expect(() => validateGrantPattern(pattern, "read")).toThrow();
		}
		expect(() => validateGrantPattern("src/**", "read")).not.toThrow();
		expect(() => validateExecuteGrant("test", "execute")).not.toThrow();
		expect(() => validateExecuteGrant("rm", "execute")).toThrow();
	});

	it("admits harness bookkeeping while keeping delegation closed", async () => {
		const root = workspace();
		// The frozen omp-default prompt asks for `todo`; refusing it aborts a competent run for a
		// reason the grant model does not care about. `task` spawns subagents, so it stays denied.
		await assertGrantedToolCall(call("todo"), grants(), root);
		expect(await denied(assertGrantedToolCall(call("task", { prompt: "do it" }), grants(), root))).toBe(
			"permission_denied",
		);
	});

	it("derives tool names from grants so a member cannot request a tool it was not given", () => {
		expect(grantedToolNames(grants())).toEqual([]);
		expect(grantedToolNames(grants({ read: ["."], write: ["src"], execute: ["test"] }))).toEqual([
			"read",
			"grep",
			"glob",
			"find",
			"write",
			"edit",
			"bash",
		]);
	});
});

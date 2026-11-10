import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGraphCommand } from "../src/graph/cli";

it("rejects standalone execution and observation even with a legacy local policy", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-local-"));
	try {
		fs.writeFileSync(
			path.join(root, "local-policy.json"),
			JSON.stringify({ version: 1, graphs: ["graph"], programs: {} }),
			{ mode: 0o600 },
		);
		for (const args of [
			["start", "graph", "--request-key", "key", "--if-revision", "1"],
			["host", "ensure"],
			["status", "run"],
		]) {
			let error = "";
			const code = await runGraphCommand(args, {
				root,
				out: () => {},
				err: text => {
					error += text;
				},
			});
			expect(code).not.toBe(0);
			expect(error).toMatch(/not configured|unavailable/);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

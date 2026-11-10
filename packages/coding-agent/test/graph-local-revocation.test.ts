import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGraphCommand } from "../src/graph/cli";

it("does not revive a legacy grant when the same policy content is restored", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-policy-"));
	const file = path.join(root, "local-policy.json");
	const policy = JSON.stringify({ version: 1, graphs: ["graph"], programs: {} });
	try {
		for (const content of [policy, JSON.stringify({ version: 1, graphs: [], programs: {} }), policy]) {
			fs.writeFileSync(file, content, { mode: 0o600 });
			const code = await runGraphCommand(["start", "graph", "--request-key", "key", "--if-revision", "1"], {
				root,
				out: () => {},
				err: () => {},
			});
			expect(code).not.toBe(0);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

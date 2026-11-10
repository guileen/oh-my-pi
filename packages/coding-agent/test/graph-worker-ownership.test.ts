import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GRAPH_CLI_LIMITS } from "../src/graph/cli";
import { GraphRunStore } from "../src/graph/store";
import { runGraphWorker } from "../src/graph/worker";

it("releases profile resources when trusted host configuration fails", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-worker-owner-"));
	try {
		await expect(
			runGraphWorker({
				root,
				signal: new AbortController().signal,
				createHostOptions: () => {
					throw new Error("configuration unavailable");
				},
			}),
		).rejects.toThrow("configuration unavailable");
		const store = new GraphRunStore(GRAPH_CLI_LIMITS, root);
		try {
			expect(store.claimHost()).not.toBeNull();
		} finally {
			store.close();
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { readProfileArtifact } from "../graph/artifacts";
import { graphHelp, runGraphCommand } from "../graph/cli";
import { closeDaemonClients } from "../launch/client";
import { GRAPH_CLI_LIMITS } from "../graph/limits";

export default class Graph extends Command {
	static description = graphHelp.description;
	static args = graphHelp.args;
	static flags = graphHelp.flags;
	static examples = graphHelp.examples;
	static strict = false;

	async run(): Promise<void> {
		const root = path.join(getAgentDir(), "graphs");
		try {
			const code = await runGraphCommand(this.argv, {
				// This process runs as the profile owner: graphs.sqlite and the artifact
				// directory are already readable by this OS user, so re-checking here adds no
				// confidentiality. Embedded hosts (RPC, web, workers) MUST pass their own
				// principal-scoped callback instead of this one.
				authorizeRunObservation: () => true,
				// This process runs as the profile owner, so hold/cancel — and resuming its own
				// operator pause — are authorized here. Gate holds still need a decision reference.
				allowLocalLifecycle: true,
				// Same owner-local trust boundary for `report`: a read-only connection, and the
				// read grant never widens into publication authority.
				readArtifact: ref =>
					readProfileArtifact(ref, {
						root,
						maxBytes: GRAPH_CLI_LIMITS.maxBytes,
						principal: "local-user",
						authorize: async (_principal, action) => action === "read",
					}),
				// Start descriptors are host-supplied metadata for the worker. This process is the
				// profile owner, so it may publish and read them; publishing still grants no start.
				descriptor: {
					principal: "local-user",
					maxBytes: GRAPH_CLI_LIMITS.maxBytes,
					authorizeArtifact: async (_principal, action) => action === "read" || action === "publish",
					authorizeTarget: async () => true,
				},
			});
			if (code !== 0) process.exitCode = code;
		} finally {
			// A grant-capable Run reaches broker-backed tools (read/edit/grep/glob/bash), and the
			// daemon client's IPC socket is a live async handle. Without this close the one-shot
			// CLI stays alive after the Run is already terminal (measured: 40 s of work, ~4 min
			// of idle before SIGTERM). Runs that never touch the broker are unaffected.
			await closeDaemonClients();
			// That close is necessary but not sufficient: a grant-capable Run can still leave a
			// ref'd handle behind (measured: 40 s of work, 187 s of wall clock). This command is
			// a one-shot CLI, so do not let a leaked handle hold the process open. The guard is
			// unref'd — it never delays a clean exit — and only fires while something else keeps
			// the loop alive, logging what was still open so the leak stays visible.
			const leakGuard = setTimeout(() => {
				const handles = process.getActiveResourcesInfo?.() ?? [];
				if (handles.length > 0) logger.warn("graph command finished with open handles", { handles });
				logger.flush();
				process.exit(process.exitCode ?? 0);
			}, 2_000);
			leakGuard.unref();
		}
	}
}

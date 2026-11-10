import * as path from "node:path";
import { acquireFileLock } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerClient, createDaemonBrokerClient } from "../launch/client";
import { describeDaemon } from "../launch/ensure";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";

import { BOT_ID_ENV, BOT_ROOT_ENV, BOT_WORKER_ARG } from "./protocol";

/** Own only this caller's broker connection; persistent workers outlive it. */
export class BotHost {
	readonly #root: string;
	#client: Promise<DaemonBrokerClient> | undefined;

	constructor(root: string) {
		this.#root = root;
	}

	async ensure(botId: string): Promise<void> {
		const client = await (this.#client ??= createDaemonBrokerClient(this.#root, {
			runtimeDir: path.join(this.#root, "runtime"),
		}));
		const claim = await acquireFileLock(path.join(this.#root, `${botId}.host`));
		try {
			const name = `omp.bot.${botId}`;
			const existing = await describeDaemon(client, name, "Bot worker");
			if (existing.status === "unknown") throw new Error("Cannot establish Bot worker ownership");
			if (
				existing.status === "found" &&
				["starting", "running", "ready", "restarting"].includes(existing.daemon.state)
			)
				return;
			const launch = resolveWorkerSpawnCmd(BOT_WORKER_ARG);
			try {
				const result = await client.request({
					op: "start",
					awaitReady: false,
					replace: existing.status === "found" && existing.daemon.state === "stopping",
					spec: {
						name,
						application: launch.cmd[0],
						args: launch.cmd.slice(1),
						cwd: launch.cwd ?? this.#root,
						env: workerEnvFromParent({ [BOT_ROOT_ENV]: this.#root, [BOT_ID_ENV]: botId }),
						pty: false,
						persist: true,
						detached: true,
						restart: "no",
					},
				});
				if (result.op !== "start" || ["exited", "failed"].includes(result.daemon.state)) {
					throw new Error("The managed Bot worker failed to launch");
				}
			} catch (error) {
				// A racing client may have started the same singleton under the broker.
				const current = await describeDaemon(client, name, "Bot worker");
				if (
					current.status !== "found" ||
					!["starting", "running", "ready", "restarting"].includes(current.daemon.state)
				)
					throw error;
			}
		} finally {
			claim.release();
		}
	}

	async close(): Promise<void> {
		if (this.#client) (await this.#client).close();
	}
}

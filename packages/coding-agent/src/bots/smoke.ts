import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../launch/client";
import { BotHost } from "./host";
import { BotStore } from "./store";

/** Exercise the shipped worker entry and durable control mailbox without inference. */
export async function smokeTestBotWorker(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-smoke-"));
	const store = new BotStore(root);
	const host = new BotHost(root);
	let broker: DaemonBrokerClient | undefined;
	try {
		const bot = store.createBot({ bot_name: "smoke", cwd: root });
		const submitted = store.admit(bot.bot_id, { command: "submit", input: "Must remain frozen" });
		const stopped = store.admit(bot.bot_id, { command: "stop", job_id: submitted.job_id! });
		await host.ensure(bot.bot_id);
		const deadline = Date.now() + 30_000;
		while (store.request(bot.bot_id, stopped.request_id).outcome === "pending" && Date.now() < deadline)
			await Bun.sleep(50);
		const result = store.request(bot.bot_id, stopped.request_id);
		const job = store.getJob(bot.bot_id, submitted.job_id!);
		if (
			result.outcome !== "applied" ||
			job.state !== "stopped" ||
			!job.settled ||
			job.pending_input_count !== 1 ||
			job.output_ref !== null
		) {
			throw new Error(`Bot worker control smoke failed: ${result.outcome}/${job.state}`);
		}
		broker = await createDaemonBrokerClient(root, { runtimeDir: path.join(root, "runtime") });
		await broker.request({ op: "stop", name: `omp.bot.${bot.bot_id}`, timeoutMs: 5_000 });
		await broker.request({ op: "shutdown" });
	} finally {
		broker?.close();
		await host.close();
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

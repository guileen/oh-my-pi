import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { resolveCliEntryCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import {
	launchOwnedSupervisor,
	prepareOwnedSupervisor,
	queryOwnedSupervisor,
	signalOwnedSupervisor,
	type OwnedSupervisorStatus,
} from "./owned-supervisor";

/** Exercise the bundled worker graph, real native spawn, output drain, and disconnected recovery. */
export async function smokeTestOwnedSupervisor(): Promise<void> {
	if (process.platform === "win32") {
		process.stdout.write("smoke-test: owned supervisor skipped (native Unix ownership unsupported on Windows)\n");
		return;
	}
	using temp = TempDir.createSync("omp-owned-supervisor-smoke-");
	const command = [...resolveCliEntryCmd(), "--version"];
	const application = command.shift();
	if (!application) throw new Error("Owned supervisor smoke could not resolve the CLI executable");
	const ref = await prepareOwnedSupervisor(
		temp.path(),
		{
			application,
			args: command,
			cwd: process.cwd(),
			env: workerEnvFromParent(),
			outputPath: path.join(temp.path(), "output.log"),
			maxOutputBytes: 1024 * 1024,
			previousOutputPath: path.join(temp.path(), "output.previous.log"),
		},
		{ generation: crypto.randomUUID() },
	);
	const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS;
	let status: OwnedSupervisorStatus | undefined;
	try {
		launchOwnedSupervisor(ref);
		do {
			status = await queryOwnedSupervisor(ref, 250);
			if (status.state === "exited") break;
			await Bun.sleep(25);
		} while (Date.now() < deadline);
		if (status.state !== "exited" || status.exitCode !== 0 || status.signal !== null) {
			throw new Error(`Owned supervisor smoke did not confirm CLI exit: ${JSON.stringify(status)}`);
		}
		const output = await fs.readFile(path.join(temp.path(), "output.log"), "utf8");
		if (!output.includes(VERSION)) throw new Error("Owned supervisor smoke did not capture the real CLI version");
		while ((await fs.exists(ref.endpoint)) && Date.now() < deadline) await Bun.sleep(10);
		if (await fs.exists(ref.endpoint)) throw new Error("Owned supervisor smoke worker did not clean its endpoint");
		const recovered = await queryOwnedSupervisor(ref, 250);
		if (recovered.state !== "exited" || recovered.exitCode !== 0 || recovered.signal !== null) {
			throw new Error("Owned supervisor smoke lost the authenticated durable exit");
		}
		const lateSignal = await signalOwnedSupervisor(ref, 9, true, 250);
		if (lateSignal.delivered || lateSignal.status.state !== "exited") {
			throw new Error("Owned supervisor smoke signaled after confirmed exit");
		}
	} finally {
		if (status?.state !== "exited") {
			try {
				await signalOwnedSupervisor(ref, 9, true, 250);
			} catch {
				// Never attempt cleanup by a persisted numeric PID after owner loss.
			}
		}
	}
}

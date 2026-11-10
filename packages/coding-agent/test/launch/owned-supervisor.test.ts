// Runtime integration tests intentionally use real timers: native IPC, file locks,
// OS child ownership, and detached-worker survival cannot be driven by fake timers.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { OWNED_SUPERVISOR_WORKER_ARG } from "../../src/cli/worker-selectors";
import {
	connectOwnedSupervisor,
	launchOwnedSupervisor,
	parseOwnedSupervisorRef,
	prepareOwnedSupervisor,
	queryOwnedSupervisor,
	sendOwnedSupervisorInput,
	signalOwnedSupervisor,
	type OwnedSupervisorRef,
	type OwnedSupervisorStatus,
} from "../../src/launch/owned-supervisor";
import { OWNED_SUPERVISOR_DIR_ENV, OWNED_SUPERVISOR_MAX_FRAME_BYTES } from "../../src/launch/owned-supervisor-protocol";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../../src/subprocess/worker-client";

async function waitForState(ref: OwnedSupervisorRef, states: OwnedSupervisorStatus["state"][], timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let status = await queryOwnedSupervisor(ref, 100);
	while (!states.includes(status.state) && Date.now() < deadline) {
		await Bun.sleep(25);
		status = await queryOwnedSupervisor(ref, 100);
	}
	if (!states.includes(status.state))
		throw new Error(`Supervisor remained ${status.state}, expected ${states.join("/")}`);
	return status;
}

async function waitForFile(file: string) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const contents = await fs.readFile(file, "utf8");
			if (contents.length > 0) return contents;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		await Bun.sleep(25);
	}
	throw new Error(`Application did not write ${file}`);
}

async function prepare(dir: string, source: string) {
	return prepareOwnedSupervisor(
		dir,
		{
			application: process.execPath,
			args: ["-e", source],
			cwd: dir,
			env: { OWNED_APPLICATION_TEST: "explicit-only" },
		},
		{ generation: crypto.randomUUID() },
	);
}

async function stop(ref: OwnedSupervisorRef) {
	try {
		await signalOwnedSupervisor(ref, 9, true, 250);
		await waitForState(ref, ["exited"], 3000);
	} catch {
		// A completed/lost owner is not a reason to signal a stored numeric PID.
	}
}

describe.skipIf(process.platform === "win32")("authenticated owned supervisor", () => {
	it("persists private immutable configuration and exposes only validated reference fields", async () => {
		using temp = TempDir.createSync("@omp-owned-prepare-");
		const dir = temp.path();
		const spec = { application: process.execPath, args: ["-e", ""], cwd: dir, env: {} };
		const identity = { generation: "fixed-generation" };
		const ref = await prepareOwnedSupervisor(dir, spec, identity);
		expect(await prepareOwnedSupervisor(dir, spec, identity)).toEqual(ref);
		expect(parseOwnedSupervisorRef({ ...ref, unrelated: "discard" })).toEqual(ref);
		expect(() => parseOwnedSupervisorRef({ ...ref, endpoint: "other" })).toThrow();
		expect(() => parseOwnedSupervisorRef({ ...ref, token: "invalid" })).toThrow();
		await expect(prepareOwnedSupervisor(dir, { ...spec, args: ["different"] }, identity)).rejects.toThrow("conflict");
		expect((await fs.stat(path.join(dir, "owned-supervisor.json"))).mode & 0o777).toBe(0o600);
		expect((await queryOwnedSupervisor(ref, 50)).state).toBe("prepared");
	});

	it("owns one application across concurrent launches and recovers its authenticated exit after disconnect", async () => {
		using temp = TempDir.createSync("@omp-owned-once-");
		const count = path.join(temp.path(), "count");
		const release = path.join(temp.path(), "release");
		const ref = await prepare(
			temp.path(),
			`
			const fs = require("node:fs");
			fs.appendFileSync(${JSON.stringify(count)}, "started\\n");
			console.log("application-output");
			console.error("application-error");
			while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
			process.exit(7);
		`,
		);
		try {
			for (let attempt = 0; attempt < 4; attempt++) launchOwnedSupervisor(ref);
			const running = await waitForState(ref, ["running"]);
			expect(running.pid).toBeGreaterThan(0);
			const client = await connectOwnedSupervisor(ref);
			expect((await client.status()).generation).toBe(ref.generation);
			client.close();
			await fs.writeFile(release, "exit");
			const exited = await waitForState(ref, ["exited"]);
			expect(exited.exitCode).toBe(7);
			expect(exited.signal).toBeNull();
			expect(await fs.readFile(count, "utf8")).toBe("started\n");
			const output = await fs.readFile(path.join(ref.dir, "output.log"), "utf8");
			expect(output).toContain("application-output");
			expect(output).toContain("application-error");
			launchOwnedSupervisor(ref);
			expect(await queryOwnedSupervisor(ref)).toEqual(exited);
			expect(await fs.readFile(count, "utf8")).toBe("started\n");
		} finally {
			await stop(ref);
		}
	}, 30_000);

	it("survives the launcher process and never overlays its capability environment onto the application", async () => {
		using temp = TempDir.createSync("@omp-owned-survive-");
		const observed = path.join(temp.path(), "env.json");
		const ref = await prepare(
			temp.path(),
			`
			await Bun.write(${JSON.stringify(observed)}, JSON.stringify(process.env));
			await Bun.sleep(20000);
		`,
		);
		const modulePath = path.resolve(import.meta.dir, "../../src/launch/owned-supervisor.ts");
		const launcher = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
			import { launchOwnedSupervisor } from ${JSON.stringify(modulePath)};
			launchOwnedSupervisor(JSON.parse(process.env.OWNED_TEST_REF));
		`,
			],
			{
				env: workerEnvFromParent({ OWNED_TEST_REF: JSON.stringify(ref), SECRET_FROM_LAUNCHER: "do-not-inherit" }),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		try {
			expect(await launcher.exited).toBe(0);
			await waitForState(ref, ["running"]);
			const env = JSON.parse(await waitForFile(observed));
			expect(env.OWNED_APPLICATION_TEST).toBe("explicit-only");
			expect(env[OWNED_SUPERVISOR_DIR_ENV]).toBeUndefined();
			expect(env.OWNED_TEST_REF).toBeUndefined();
			expect(env.SECRET_FROM_LAUNCHER).toBeUndefined();
			expect(JSON.stringify(env)).not.toContain(ref.token);
			expect((await queryOwnedSupervisor(ref)).state).toBe("running");
		} finally {
			await stop(ref);
		}
	}, 30_000);

	it("rejects invalid capability/generation/operations and oversized native frames without affecting the application", async () => {
		using temp = TempDir.createSync("@omp-owned-auth-");
		const ref = await prepare(temp.path(), "await Bun.sleep(20000)");
		launchOwnedSupervisor(ref);
		try {
			await waitForState(ref, ["running"]);
			await expect(connectOwnedSupervisor({ ...ref, token: "0".repeat(64) }, 250)).rejects.toThrow();
			await expect(connectOwnedSupervisor({ ...ref, generation: "wrong-generation" }, 250)).rejects.toThrow();
			await expect(queryOwnedSupervisor({ ...ref, token: "0".repeat(64) }, 250)).rejects.toThrow("authentication");
			await expect(sendOwnedSupervisorInput(ref, "x".repeat(16 * 1024 + 1))).rejects.toThrow("operation");
			const socket = await IpcConnection.connect(ref.endpoint, { framing: "lines", timeoutMs: 250 });
			const response = Promise.withResolvers<string>();
			const deadline = setTimeout(() => response.reject(new Error("Malformed operation was not rejected")), 1000);
			socket.start(response.resolve, () => {});
			socket.send(
				JSON.stringify({
					version: 1,
					id: "invalid-op",
					generation: ref.generation,
					token: ref.token,
					operation: { op: "signal", signal: "SIGKILL", group: true },
				}),
			);
			try {
				expect(JSON.parse(await response.promise).ok).toBe(false);
			} finally {
				clearTimeout(deadline);
				socket.destroy();
			}
			const oversized = await IpcConnection.connect(ref.endpoint, { framing: "lines", timeoutMs: 250 });
			const closed = Promise.withResolvers<void>();
			const oversizedDeadline = setTimeout(
				() => closed.reject(new Error("Oversized frame remained connected")),
				1000,
			);
			oversized.start(
				() => {},
				() => closed.resolve(),
			);
			oversized.send("x".repeat(OWNED_SUPERVISOR_MAX_FRAME_BYTES + 1));
			try {
				await closed.promise;
			} finally {
				clearTimeout(oversizedDeadline);
				oversized.destroy();
			}
			expect((await queryOwnedSupervisor(ref)).state).toBe("running");
		} finally {
			await stop(ref);
		}
	}, 30_000);

	it("writes bounded stdin through the owner and persists signal termination without signaling after reap", async () => {
		using temp = TempDir.createSync("@omp-owned-input-");
		const observed = path.join(temp.path(), "input");
		const ref = await prepare(
			temp.path(),
			`
			process.stdin.on("data", data => require("node:fs").appendFileSync(${JSON.stringify(observed)}, data));
			await Bun.sleep(20000);
		`,
		);
		launchOwnedSupervisor(ref);
		try {
			await waitForState(ref, ["running"]);
			await sendOwnedSupervisorInput(ref, "owned-input\n");
			expect(await waitForFile(observed)).toBe("owned-input\n");
			const signaled = await signalOwnedSupervisor(ref, 15, true);
			expect(signaled.delivered).toBe(true);
			const exited = await waitForState(ref, ["exited"]);
			expect(exited.signal).toBe(15);
			// After the owner exits, there is no fallback to the diagnostic PID.
			const result = await signalOwnedSupervisor(ref, 9, true, 100);
			expect(result.delivered).toBe(false);
			expect((await queryOwnedSupervisor(ref)).state).toBe("exited");
		} finally {
			await stop(ref);
		}
	}, 30_000);

	it("treats supervisor loss as unknown and permanently fences duplicate application launch", async () => {
		using temp = TempDir.createSync("@omp-owned-loss-");
		const count = path.join(temp.path(), "count");
		const release = path.join(temp.path(), "release");
		const done = path.join(temp.path(), "done");
		const ref = await prepare(
			temp.path(),
			`
			const fs = require("node:fs");
			fs.appendFileSync(${JSON.stringify(count)}, "once\\n");
			const deadline = Date.now() + 20000;
			while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await Bun.sleep(20);
			fs.writeFileSync(${JSON.stringify(done)}, "done");
		`,
		);
		const launch = resolveWorkerSpawnCmd(OWNED_SUPERVISOR_WORKER_ARG);
		// This handle owns the supervisor, not the managed application. Its SIGKILL
		// models owner loss; the application exits itself rather than PID cleanup.
		const owner = Bun.spawn(launch.cmd, {
			cwd: launch.cwd,
			env: workerEnvFromParent({ [OWNED_SUPERVISOR_DIR_ENV]: ref.dir }),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		try {
			await waitForState(ref, ["running"]);
			await waitForFile(count);
			owner.kill("SIGKILL");
			await owner.exited;
			expect((await queryOwnedSupervisor(ref, 100)).state).toBe("unknown");
			launchOwnedSupervisor(ref);
			// A newly booted owner with the old immutable config must also refuse
			// to spawn, even though the original owner and endpoint are gone.
			const replacement = Bun.spawn(launch.cmd, {
				cwd: launch.cwd,
				env: workerEnvFromParent({ [OWNED_SUPERVISOR_DIR_ENV]: ref.dir }),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				detached: true,
			});
			expect(await replacement.exited).toBe(0);
			await fs.writeFile(release, "release");
			expect(await waitForFile(done)).toBe("done");
			expect(await fs.readFile(count, "utf8")).toBe("once\n");
			expect((await queryOwnedSupervisor(ref, 100)).state).toBe("unknown");
		} finally {
			if (owner.exitCode === null) owner.kill("SIGKILL");
			await owner.exited;
			await fs.writeFile(release, "release");
			// SIGKILL cannot unlink a hashed Unix socket outside the TempDir.
			await fs.rm(ref.endpoint, { force: true });
		}
	}, 30_000);

	it("fails closed on a torn durable intent and on tampered terminal authentication", async () => {
		using temp = TempDir.createSync("@omp-owned-torn-");
		const tornDir = path.join(temp.path(), "torn");
		const count = path.join(tornDir, "should-not-start");
		const ref = await prepare(tornDir, `await Bun.write(${JSON.stringify(count)}, "bad")`);
		await fs.writeFile(path.join(tornDir, "owned-supervisor.started"), "torn");
		launchOwnedSupervisor(ref);
		expect((await queryOwnedSupervisor(ref, 100)).state).toBe("unknown");
		expect(await fs.exists(count)).toBe(false);

		const terminal = await prepare(path.join(temp.path(), "terminal"), "process.exit(3)");
		launchOwnedSupervisor(terminal);
		expect((await waitForState(terminal, ["exited"])).exitCode).toBe(3);
		const file = path.join(terminal.dir, "owned-supervisor.exit.json");
		const value = JSON.parse(await fs.readFile(file, "utf8"));
		value.status.exitCode = 0;
		await fs.writeFile(file, JSON.stringify(value));
		// The worker closes promptly after publication; wait for its endpoint to
		// disappear so this query necessarily exercises durable recovery.
		const deadline = Date.now() + 1000;
		while ((await fs.exists(terminal.endpoint)) && Date.now() < deadline) await Bun.sleep(10);
		expect((await queryOwnedSupervisor(terminal, 100)).state).toBe("unknown");
	}, 30_000);

	it("stops its owned child if its endpoint is removed and leaves a durable confirmed exit", async () => {
		using temp = TempDir.createSync("@omp-owned-endpoint-");
		const ref = await prepare(temp.path(), "await Bun.sleep(20000)");
		launchOwnedSupervisor(ref);
		try {
			await waitForState(ref, ["running"]);
			await fs.unlink(ref.endpoint);
			const exited = await waitForState(ref, ["exited"]);
			expect(exited.signal).toBe(15);
		} finally {
			await stop(ref);
		}
	}, 30_000);

	it("forwards native output limits and does not publish exit before final output is drained", async () => {
		using temp = TempDir.createSync("@omp-owned-output-");
		const maxOutputBytes = 64 * 1024;
		const outputPath = path.join(temp.path(), "output.log");
		const previousOutputPath = path.join(temp.path(), "output.previous.log");
		const ref = await prepareOwnedSupervisor(
			temp.path(),
			{
				application: process.execPath,
				args: ["-e", `console.log("x".repeat(${maxOutputBytes * 4})); console.log("final-owned-output");`],
				cwd: temp.path(),
				env: {},
				outputPath,
				maxOutputBytes,
				previousOutputPath,
			},
			{ generation: crypto.randomUUID() },
		);
		try {
			launchOwnedSupervisor(ref);
			expect((await waitForState(ref, ["exited"])).exitCode).toBe(0);
			const output = await fs.readFile(outputPath, "utf8");
			const previous = await fs.readFile(previousOutputPath, "utf8");
			expect(Buffer.byteLength(output)).toBeLessThanOrEqual(maxOutputBytes);
			expect(Buffer.byteLength(previous)).toBeLessThanOrEqual(maxOutputBytes);
			expect(output).toContain("final-owned-output");
		} finally {
			await stop(ref);
		}
	}, 30_000);
});

import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { collectScope } from "../../src/cli/ps-data";
import {
	launchOwnedSupervisor,
	prepareOwnedSupervisor,
	queryOwnedSupervisor,
	signalOwnedSupervisor,
	type OwnedSupervisorRef,
	type OwnedSupervisorStatus,
} from "../../src/launch/owned-supervisor";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function startBroker(projectDir: string, runtimeDir: string) {
	const listening = Promise.withResolvers<void>();
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "launch-finality-broker.ts")], {
		env: {
			...process.env,
			[DAEMON_PROJECT_DIR_ENV]: projectDir,
			[DAEMON_RUNTIME_DIR_ENV]: runtimeDir,
			[DAEMON_IDLE_GRACE_ENV]: "60000",
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
		ipc(message: unknown) {
			if (typeof message === "object" && message !== null && "type" in message && message.type === "listening")
				listening.resolve();
		},
	});
	return {
		child,
		listening: Promise.race([
			listening.promise,
			child.exited.then(async code => {
				throw new Error(`Broker exited (${code}): ${await new Response(child.stderr).text()}`);
			}),
		]),
	};
}

// Native IPC and detached OS owners need real-time polling; fake timers cannot advance their state.
async function waitForOwnedState(ref: OwnedSupervisorRef, state: OwnedSupervisorStatus["state"]) {
	const deadline = Date.now() + 10_000;
	let status = await queryOwnedSupervisor(ref, 100);
	while (status.state !== state && Date.now() < deadline) {
		await Bun.sleep(25);
		status = await queryOwnedSupervisor(ref, 100);
	}
	if (status.state !== state) throw new Error(`Owned supervisor remained ${status.state}, expected ${state}`);
	return status;
}

for (const detached of [false, true]) {
	it(`does not adopt or signal a legacy ${detached ? "detached" : "session"} record's unrelated PID`, async () => {
		using temp = TempDir.createSync("@omp-owned-recovery-");
		const projectDir = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(projectDir);
		const victim = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		});
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
		await Bun.write(
			path.join(runtimeDir, "daemons", "legacy", "meta.json"),
			JSON.stringify({
				daemon: {
					name: "legacy",
					id: "old-generation",
					state: "running",
					pid: victim.pid,
					createdAt: 1,
					startedAt: 1,
					restartCount: 0,
					outputBytes: 0,
					persist: true,
					detached,
				},
				spec: {
					name: "legacy",
					application: process.execPath,
					args: [],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: true,
					detached,
				},
			}),
		);
		expect((await collectScope({ kind: "project", projectDir, runtimeDir })).daemons).toMatchObject([
			{ snapshot: { state: "unknown" }, supervised: false },
		]);
		const broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			const result = await client.request({ op: "describe", name: "legacy" });
			expect(result).toMatchObject({ op: "describe", daemon: { state: "unknown" } });
			expect(victim.exitCode).toBeNull();
			await expect(client.request({ op: "send", name: "legacy", signal: "SIGKILL" })).rejects.toThrow("ownership");
			await expect(client.request({ op: "restart", name: "legacy" })).rejects.toThrow("ownership");
			expect(victim.exitCode).toBeNull();
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			if (broker.child.exitCode === null) broker.child.kill();
			await broker.child.exited;
			victim.kill();
			await victim.exited;
		}
	}, 20_000);
}

it.skipIf(process.platform === "win32")(
	"recovers the same detached owned child across broker death and preserves stdin and exit status",
	async () => {
		using temp = TempDir.createSync("@omp-owned-broker-restart-");
		const projectDir = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(projectDir);
		const launches = path.join(projectDir, "launches");
		const script = path.join(projectDir, "service.ts");
		await Bun.write(
			script,
			`import * as fs from "node:fs"; fs.appendFileSync(${JSON.stringify(launches)}, "launch\\n"); process.stdout.write("ready\\n"); process.stdin.on("data", data => { process.stdout.write("received:" + data.toString()); if (data.toString().includes("done")) process.exit(7); });`,
		);
		let client = await createDaemonBrokerClient(projectDir, { runtimeDir });
		let broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			const started = await client.request({
				op: "start",
				spec: {
					name: "owned",
					application: process.execPath,
					args: [script],
					cwd: projectDir,
					env: {},
					pty: false,
					restart: "no",
					persist: true,
					detached: true,
					ready: { log: "ready", timeoutMs: 10_000 },
				},
			});
			if (started.op !== "start") throw new Error("Unexpected start response");
			expect(started.daemon.state).toBe("ready");
			client.close();
			broker.child.kill("SIGKILL");
			await broker.child.exited;
			expect((await collectScope({ kind: "project", projectDir, runtimeDir })).daemons).toMatchObject([
				{ snapshot: { state: "ready", pid: started.daemon.pid }, supervised: false },
			]);
			broker = startBroker(projectDir, runtimeDir);
			await broker.listening;
			client = await createDaemonBrokerClient(projectDir, { runtimeDir });
			const recovered = await client.request({ op: "describe", name: "owned" });
			expect(recovered).toMatchObject({
				op: "describe",
				daemon: {
					id: started.daemon.id,
					pid: started.daemon.pid,
					startedAt: started.daemon.startedAt,
					state: "ready",
				},
			});
			await client.request({ op: "send", name: "owned", data: "done\r" });
			const finished = await client.request({ op: "wait", name: "owned", for: "exit", timeoutMs: 10_000 });
			expect(finished).toMatchObject({ op: "wait", timedOut: false, daemon: { state: "failed", exitCode: 7 } });
			const logs = await client.request({
				op: "logs",
				name: "owned",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 0,
			});
			if (logs.op !== "logs") throw new Error("Unexpected logs response");
			expect(logs.text).toContain("received:done");
			expect(await Bun.file(launches).text()).toBe("launch\n");
		} finally {
			await client.request({ op: "stop", name: "owned", timeoutMs: 500 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			if (broker.child.exitCode === null) broker.child.kill();
			await broker.child.exited;
		}
	},
	45_000,
);

it.skipIf(process.platform === "win32")(
	"requires fresh readiness output after an owned service automatically restarts",
	async () => {
		using temp = TempDir.createSync("@omp-owned-readiness-");
		const projectDir = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(projectDir);
		const marker = path.join(projectDir, "launched");
		const script = path.join(projectDir, "service.ts");
		await Bun.write(
			script,
			`const marker = Bun.file(${JSON.stringify(marker)});
const first = !(await marker.exists());
await Bun.write(marker, "launched");
console.log(first ? "service-ready" : "second-generation");
process.stdin.on("data", () => { if (first) process.exit(1); else console.log("service-ready"); });`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			const started = await client.request({
				op: "start",
				spec: {
					name: "restarting",
					application: process.execPath,
					args: [script],
					cwd: projectDir,
					env: {},
					pty: false,
					restart: "on-failure",
					persist: true,
					detached: true,
					ready: { log: "service-ready", timeoutMs: 10_000 },
				},
			});
			if (started.op !== "start") throw new Error("Unexpected start response");
			expect(started.daemon.state).toBe("ready");
			await client.request({ op: "send", name: "restarting", data: "restart\n" });
			const deadline = Date.now() + 10_000;
			let secondGeneration = false;
			while (Date.now() < deadline) {
				const result = await client.request({ op: "describe", name: "restarting" });
				if (
					result.op === "describe" &&
					result.daemon.restartCount === 1 &&
					result.daemon.pid !== undefined &&
					result.daemon.pid !== started.daemon.pid
				) {
					secondGeneration = true;
					break;
				}
				await Bun.sleep(25);
			}
			if (!secondGeneration) throw new Error("Service did not automatically restart");
			const pending = await client.request({ op: "wait", name: "restarting", for: "ready", timeoutMs: 200 });
			expect(pending).toMatchObject({ op: "wait", timedOut: true, daemon: { state: "starting" } });
			await client.request({ op: "send", name: "restarting", data: "announce\n" });
			const ready = await client.request({ op: "wait", name: "restarting", for: "ready", timeoutMs: 10_000 });
			expect(ready).toMatchObject({ op: "wait", timedOut: false, daemon: { state: "ready", restartCount: 1 } });
		} finally {
			await client.request({ op: "stop", name: "restarting", timeoutMs: 500 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			if (broker.child.exitCode === null) broker.child.kill();
			await broker.child.exited;
		}
	},
	30_000,
);

for (const scenario of [
	{ label: "persisted stop intent despite unknown state", state: "unknown", stopRequested: true, outcome: "exited" },
	{ label: "persisted stopping state", state: "stopping", stopRequested: false, outcome: "exited" },
	{ label: "unexpected signal termination", state: "unknown", stopRequested: false, outcome: "failed" },
] as const) {
	it.skipIf(process.platform === "win32")(
		`lists authenticated offline ${scenario.label} without booting a broker`,
		async () => {
			using temp = TempDir.createSync("@omp-owned-offline-outcome-");
			const projectDir = path.join(temp.path(), "project");
			const runtimeDir = path.join(temp.path(), "runtime");
			await fs.mkdir(projectDir);
			const name = "offline";
			const id = "offline-generation";
			const startedAt = 1;
			const dir = path.join(runtimeDir, "daemons", name);
			const spec = {
				name,
				application: process.execPath,
				args: ["-e", "process.stdin.resume()"],
				cwd: projectDir,
				env: {},
				pty: false,
				restart: "no",
				persist: true,
				detached: true,
			};
			const supervisor = await prepareOwnedSupervisor(path.join(dir, `owned-${id}-${startedAt}`), spec, {
				generation: `${id}:${startedAt}`,
			});
			await Bun.write(
				path.join(dir, "meta.json"),
				JSON.stringify({
					daemon: {
						name,
						id,
						state: scenario.state,
						createdAt: 1,
						startedAt,
						restartCount: 0,
						outputBytes: 0,
						persist: true,
						detached: true,
					},
					spec,
					supervisor,
					stopRequested: scenario.stopRequested,
				}),
			);
			launchOwnedSupervisor(supervisor);
			try {
				const running = await waitForOwnedState(supervisor, "running");
				const scope = { kind: "project" as const, projectDir, runtimeDir };
				const active = await collectScope(scope);
				expect(active.daemons).toHaveLength(1);
				expect(active.daemons[0]).toMatchObject({
					snapshot: {
						id,
						state: scenario.state === "unknown" ? "running" : "stopping",
						pid: running.pid,
					},
					supervised: false,
				});
				expect(active.daemons[0]!.snapshot).not.toHaveProperty("stopRequested");
				expect(await fs.readdir(runtimeDir)).toEqual(["daemons"]);

				expect((await signalOwnedSupervisor(supervisor, 9, true)).delivered).toBe(true);
				await waitForOwnedState(supervisor, "exited");
				const finished = await collectScope(scope);
				expect(finished.daemons).toHaveLength(1);
				expect(finished.daemons[0]).toMatchObject({
					snapshot: { id, state: scenario.outcome, exitCode: 137 },
					supervised: false,
				});
				expect(finished.daemons[0]!.snapshot.pid).toBeUndefined();
				expect(finished.daemons[0]!.snapshot).not.toHaveProperty("stopRequested");
				expect(await fs.readdir(runtimeDir)).toEqual(["daemons"]);
			} finally {
				await signalOwnedSupervisor(supervisor, 9, true, 250).catch(() => undefined);
				await waitForOwnedState(supervisor, "exited").catch(() => undefined);
			}
		},
		30_000,
	);
}

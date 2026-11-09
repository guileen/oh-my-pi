// Native IPC, OS exit, and the broker's monitor require real timers; fake time cannot drive them.
// IPC barriers choose the race ordering. Real-time deadlines only bound failures and authenticated-state polling.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	parseOwnedSupervisorRef,
	queryOwnedSupervisor,
	signalOwnedSupervisor,
	type OwnedSupervisorRef,
} from "../../src/launch/owned-supervisor";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
} from "../../src/launch/protocol";

function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error(`Timed out: ${label}`)), timeoutMs);
	return Promise.race([promise, expired.promise]).finally(() => clearTimeout(timer));
}

function startBroker(projectDir: string, runtimeDir: string) {
	const listening = Promise.withResolvers<void>();
	const armed = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	const inspected = Promise.withResolvers<unknown>();
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "broker-owned-generation.ts")], {
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
			if (typeof message !== "object" || message === null || !("type" in message)) return;
			if (message.type === "listening") listening.resolve();
			if (message.type === "armed") armed.resolve();
			if (message.type === "held") held.resolve();
			if (message.type === "calls" && "calls" in message) inspected.resolve(message.calls);
		},
	});
	const died = child.exited.then(async code => {
		throw new Error(`Generation fixture exited (${code}): ${await new Response(child.stderr).text()}`);
	});
	return {
		child,
		listening: () => bounded(Promise.race([listening.promise, died]), "broker listening"),
		async arm(gate: "signal" | "input" | "prepare", generation: string) {
			child.send({ type: "arm", gate, generation });
			await bounded(Promise.race([armed.promise, died]), "reply gate armed");
		},
		held: () => bounded(Promise.race([held.promise, died]), "old reply held"),
		release() {
			if (child.exitCode === null) child.send({ type: "release" });
		},
		calls() {
			child.send({ type: "calls" });
			return bounded(Promise.race([inspected.promise, died]), "signal calls inspected");
		},
	};
}

function request(client: DaemonBrokerClient, operation: DaemonOperation) {
	return client.request(operation, AbortSignal.timeout(15_000));
}

async function reference(runtimeDir: string): Promise<OwnedSupervisorRef> {
	const metadata: { supervisor?: unknown } = await Bun.file(
		path.join(runtimeDir, "daemons", "service", "meta.json"),
	).json();
	return parseOwnedSupervisorRef(metadata.supervisor);
}

async function exited(ref: OwnedSupervisorRef, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await queryOwnedSupervisor(ref, 250);
		if (status.state === "exited") return status;
		await Bun.sleep(10);
	}
	throw new Error(`Owned generation ${ref.generation} did not terminate`);
}

async function assertRunning(client: DaemonBrokerClient, ref: OwnedSupervisorRef, snapshot: DaemonSnapshot) {
	expect(await queryOwnedSupervisor(ref, 500)).toMatchObject({
		generation: ref.generation,
		state: "running",
		pid: snapshot.pid,
	});
	const marker = `alive-${crypto.randomUUID()}`;
	await request(client, { op: "send", name: "service", data: `${marker}\n` });
	// An application-level acknowledgement proves the replacement still executes after the stale operation completes.
	expect(
		await request(client, { op: "wait", name: "service", for: "exit", pattern: `ack:${marker}`, timeoutMs: 5_000 }),
	).toMatchObject({ op: "wait", timedOut: false, daemon: { state: "running", pid: snapshot.pid } });
	expect(await request(client, { op: "describe", name: "service" })).toMatchObject({
		op: "describe",
		daemon: { state: "running", pid: snapshot.pid, startedAt: snapshot.startedAt },
	});
}

const scenarios = [
	{ name: "does not settle a replacement from an old send's delayed exited reply", gate: "signal", operation: "send" },
	{ name: "does not escalate an old stop against the replacement supervisor", gate: "signal", operation: "stop" },
	{
		name: "does not send a trailing signal to a replacement after delayed old-generation input",
		gate: "input",
		operation: "send",
	},
] as const;

describe.skipIf(process.platform === "win32")("owned broker generation isolation", () => {
	for (const scenario of scenarios) {
		it(
			scenario.name,
			async () => {
				using temp = TempDir.createSync("@omp-owned-generation-");
				const projectDir = path.join(temp.path(), "project");
				const runtimeDir = path.join(temp.path(), "runtime");
				await fs.mkdir(projectDir);
				const broker = startBroker(projectDir, runtimeDir);
				const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
				const refs = new Map<string, OwnedSupervisorRef>();
				let pending: Promise<unknown> | undefined;
				try {
					await broker.listening();
					const started = await request(client, {
						op: "start",
						spec: {
							name: "service",
							application: process.execPath,
							args: [
								"-e",
								'process.stdin.setEncoding("utf8"); process.stdin.on("data", data => process.stdout.write("ack:" + data));',
							],
							env: {},
							cwd: projectDir,
							pty: false,
							restart: "no",
							persist: false,
							detached: false,
						},
					});
					if (started.op !== "start") throw new Error("Unexpected start response");
					const original = await reference(runtimeDir);
					refs.set(original.generation, original);
					expect(started.daemon.pid).toBeGreaterThan(0);
					await assertRunning(client, original, started.daemon);
					await broker.arm(scenario.gate, original.generation);
					const operation: DaemonOperation =
						scenario.operation === "stop"
							? { op: "stop", name: "service", timeoutMs: 0 }
							: {
									op: "send",
									name: "service",
									signal: "SIGTERM",
									...(scenario.gate === "input" ? { data: "before-restart\n" } : {}),
								};
					// Attach rejection handling immediately; stale sends are allowed to reject while their target has already exited.
					pending = request(client, operation).then(
						result => result,
						(error: unknown) => error,
					);
					await broker.held();
					if (scenario.gate === "input") await request(client, { op: "stop", name: "service", timeoutMs: 1_000 });
					expect(await exited(original)).toMatchObject({
						generation: original.generation,
						state: "exited",
						pid: started.daemon.pid,
					});
					expect(
						await request(client, { op: "wait", name: "service", for: "exit", timeoutMs: 5_000 }),
					).toMatchObject({
						op: "wait",
						timedOut: false,
						daemon: { state: scenario.gate === "signal" && scenario.operation === "send" ? "failed" : "exited" },
					});
					const restarted = await request(client, { op: "restart", name: "service" });
					if (restarted.op !== "restart") throw new Error("Unexpected restart response");
					const replacement = await reference(runtimeDir);
					refs.set(replacement.generation, replacement);
					expect(replacement.generation).not.toBe(original.generation);
					expect(restarted.daemon.startedAt).toBeGreaterThan(started.daemon.startedAt);
					expect(restarted.daemon.pid).toBeGreaterThan(0);
					await assertRunning(client, replacement, restarted.daemon);

					broker.release();
					const outcome = await bounded(pending, "stale operation completion");
					if (scenario.operation === "stop") {
						expect(outcome).toMatchObject({
							op: "stop",
							daemon: { state: "running", pid: restarted.daemon.pid },
						});
					} else {
						expect(outcome).toBeInstanceOf(Error);
						expect((outcome as Error).message).toContain("generation");
					}
					// Repeated termination of the old ref is safe; no signal may target its replacement.
					expect(await broker.calls()).not.toContainEqual(
						expect.objectContaining({ generation: replacement.generation }),
					);
					await assertRunning(client, replacement, restarted.daemon);
					expect(await queryOwnedSupervisor(original, 500)).toMatchObject({
						generation: original.generation,
						state: "exited",
					});
				} finally {
					try {
						broker.release();
						await bounded(pending ?? Promise.resolve(), "pending request cleanup").catch(() => undefined);
						const retained = await reference(runtimeDir).catch(() => undefined);
						if (retained) refs.set(retained.generation, retained);
						await Promise.all(
							[...refs.values()].map(async ref => {
								await signalOwnedSupervisor(ref, 9, true, 500);
								await exited(ref);
							}),
						);
					} finally {
						await request(client, { op: "shutdown" }).catch(() => undefined);
						client.close();
						if (broker.child.exitCode === null) broker.child.kill();
						await bounded(broker.child.exited, "fixture cleanup");
					}
				}
			},
			45_000,
		);
	}
	for (const phase of ["start", "restart"] as const) {
		it(`rejects detachment during ${phase} preparation without mutating the service spec`, async () => {
			using temp = TempDir.createSync("@omp-owned-starting-");
			const projectDir = path.join(temp.path(), "project");
			const runtimeDir = path.join(temp.path(), "runtime");
			await fs.mkdir(projectDir);
			const broker = startBroker(projectDir, runtimeDir);
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
			const refs = new Map<string, OwnedSupervisorRef>();
			const launch: Extract<DaemonOperation, { op: "start" }> = {
				op: "start",
				spec: {
					name: "service",
					application: process.execPath,
					args: [
						"-e",
						'process.stdin.setEncoding("utf8"); process.stdin.on("data", data => process.stdout.write("ack:" + data));',
					],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			};
			let pending: Promise<unknown> | undefined;
			try {
				await broker.listening();
				if (phase === "restart") {
					const started = await request(client, launch);
					if (started.op !== "start") throw new Error("Unexpected start response");
					const original = await reference(runtimeDir);
					refs.set(original.generation, original);
					await assertRunning(client, original, started.daemon);
				}
				await broker.arm("prepare", "*");
				const starting = request(client, phase === "start" ? launch : { op: "restart", name: "service" });
				pending = starting.catch((error: unknown) => error);
				await broker.held();
				const preparing = await request(client, { op: "describe", name: "service" });
				if (preparing.op !== "describe") throw new Error("Unexpected describe response");
				expect(preparing.spec).toEqual(launch.spec);
				expect(preparing.daemon).toMatchObject({ persist: false, detached: false });
				expect(preparing.daemon.pid).toBeUndefined();
				await expect(request(client, { op: "mode", name: "service", mode: "detached" })).rejects.toThrow(
					"already starting",
				);
				await expect(request(client, { op: "restart", name: "service" })).rejects.toThrow("already starting");
				await expect(request(client, { ...launch, replace: true })).rejects.toThrow("already starting");
				expect(await request(client, { op: "describe", name: "service" })).toEqual(preparing);
				for (const original of refs.values()) expect(await exited(original)).toMatchObject({ state: "exited" });

				broker.release();
				const launched = await starting;
				if (launched.op !== "start" && launched.op !== "restart") throw new Error("Unexpected launch response");
				expect(launched.op).toBe(phase);
				const ref = await reference(runtimeDir);
				refs.set(ref.generation, ref);
				expect(launched.daemon.startedAt).toBe(preparing.daemon.startedAt);
				expect(await request(client, { op: "describe", name: "service" })).toMatchObject({
					op: "describe",
					spec: launch.spec,
					daemon: { persist: false, detached: false, startedAt: preparing.daemon.startedAt },
				});
				await assertRunning(client, ref, launched.daemon);
			} finally {
				try {
					broker.release();
					await bounded(pending ?? Promise.resolve(), "preparing launch cleanup").catch(() => undefined);
					const retained = await reference(runtimeDir).catch(() => undefined);
					if (retained) refs.set(retained.generation, retained);
					await Promise.all(
						[...refs.values()].map(async ref => {
							await signalOwnedSupervisor(ref, 9, true, 500);
							await exited(ref);
						}),
					);
				} finally {
					await request(client, { op: "shutdown" }).catch(() => undefined);
					client.close();
					if (broker.child.exitCode === null) broker.child.kill();
					await bounded(broker.child.exited, "fixture cleanup");
				}
			}
		}, 45_000);
	}
});

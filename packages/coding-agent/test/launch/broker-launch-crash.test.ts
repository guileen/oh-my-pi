// Integration tests need real IPC/native process death; fake timers cannot drive SIGKILL,
// child exit, or broker recovery. IPC barriers avoid timing guesses for the delayed start.
import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonLaunchMetadata,
	type DaemonOperation,
} from "../../src/launch/protocol";

function processBroker(projectDir: string, runtimeDir: string, holdLaunch = false) {
	const listening = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "launch-finality-broker.ts")], {
		env: {
			...process.env,
			[DAEMON_PROJECT_DIR_ENV]: projectDir,
			[DAEMON_RUNTIME_DIR_ENV]: runtimeDir,
			[DAEMON_IDLE_GRACE_ENV]: "60000",
			...(holdLaunch ? { OMP_TEST_LAUNCH_GATE_CWD: projectDir } : {}),
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
		ipc(message: unknown) {
			if (typeof message !== "object" || message === null || !("type" in message)) return;
			if (message.type === "listening") listening.resolve();
			if (message.type === "launch-held") held.resolve();
		},
	});
	const died = child.exited.then(async code => {
		throw new Error(`Broker fixture exited (${code}): ${await new Response(child.stderr).text()}`);
	});
	return {
		child,
		listening: Promise.race([listening.promise, died]),
		held: holdLaunch ? Promise.race([held.promise, died]) : Promise.resolve(),
	};
}

function operation(projectDir: string, id: string, epoch: string): Extract<DaemonOperation, { op: "start" }> {
	return {
		op: "start",
		owner: "crash-owner",
		replace: true,
		awaitReady: false,
		launch: { launch_intent_id: id, session_owner_id: "crash-owner", owner_epoch: epoch },
		spec: {
			name: "reused-service",
			application: process.execPath,
			args: ["-e", 'Bun.serve({ port: 0, fetch() { return new Response("ok"); } })'],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		},
	};
}

async function reconcile(client: DaemonBrokerClient, launch: DaemonLaunchMetadata) {
	const result = await client.request({ op: "reconcile_launch", ...launch, mode: "cancel" });
	if (result.op !== "reconcile_launch") throw new Error("Unexpected reconciliation response");
	return result.disposition;
}

it("retains delayed cancellation across real broker SIGKILL, fences stale arrivals, and cleans only the exact reused generation", async () => {
	using temp = TempDir.createSync("@omp-launch-crash-");
	const projectDir = path.join(temp.path(), "project");
	const runtimeDir = path.join(temp.path(), "runtime");
	await fs.mkdir(projectDir);
	const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir });
	const keeper = await createDaemonBrokerClient(projectDir, { runtimeDir });
	let currentClient = firstClient;
	let broker = processBroker(projectDir, runtimeDir, true);
	const pids = new Set<number>();
	let pending: Promise<unknown> | undefined;
	try {
		await broker.listening;
		const delayed = operation(projectDir, "delayed-crash", "1");
		pending = firstClient.request(delayed).catch(error => error);
		await broker.held;
		expect(await keeper.request({ op: "list" })).toEqual({ op: "list", daemons: [] });
		const cancellation = reconcile(keeper, delayed.launch!);
		expect(await keeper.request({ op: "fence_owner", session_owner_id: "crash-owner", through_epoch: "1" })).toEqual({
			op: "fence_owner",
			fenced_through_epoch: "1",
		});
		broker.child.kill("SIGKILL");
		await broker.child.exited;
		expect(await pending).toBeInstanceOf(Error);
		// A lost barrier response is uncertain even though the request was durably accepted.
		expect(await cancellation).toMatchObject({ state: "unknown", final: false, error: { code: "cleanup_failed" } });
		firstClient.close();
		keeper.close();

		broker = processBroker(projectDir, runtimeDir);
		await broker.listening;
		currentClient = await createDaemonBrokerClient(projectDir, { runtimeDir });
		expect(await reconcile(currentClient, delayed.launch!)).toMatchObject({
			state: "cancelled_before_launch",
			final: true,
			service: null,
			outcome: null,
		});
		await expect(currentClient.request(delayed)).rejects.toThrow();
		await expect(currentClient.request(operation(projectDir, "stale-arrival", "1"))).rejects.toThrow("fenced");

		const second = operation(projectDir, "second-generation", "2");
		const [oldBarrier, secondStart] = await Promise.all([
			reconcile(currentClient, delayed.launch!),
			currentClient.request(second),
		]);
		expect(oldBarrier.final).toBe(true);
		if (secondStart.op !== "start") throw new Error("Unexpected second generation start");
		if (secondStart.daemon.pid !== undefined) pids.add(secondStart.daemon.pid);
		const secondTerminal = await reconcile(currentClient, second.launch!);
		expect(secondTerminal).toMatchObject({ state: "terminal", final: true, outcome: "cancelled" });

		const third = operation(projectDir, "third-generation", "3");
		const [oldTerminal, thirdStart] = await Promise.all([
			reconcile(currentClient, second.launch!),
			currentClient.request(third),
		]);
		expect(oldTerminal).toEqual(secondTerminal);
		if (thirdStart.op !== "start") throw new Error("Unexpected third generation start");
		expect(thirdStart.daemon.id).not.toBe(secondStart.daemon.id);
		if (thirdStart.daemon.pid !== undefined) pids.add(thirdStart.daemon.pid);
		const guarded = await currentClient.request({
			op: "stop",
			name: thirdStart.daemon.name,
			id: secondStart.daemon.id,
			generation: String(secondStart.daemon.startedAt),
			timeoutMs: 500,
		});
		expect(guarded).toMatchObject({ op: "stop", daemon: { id: thirdStart.daemon.id, state: "running" } });

		broker.child.kill("SIGKILL");
		await broker.child.exited;
		currentClient.close();
		expect(await reconcile(currentClient, third.launch!)).toMatchObject({ state: "unknown", final: false });
		broker = processBroker(projectDir, runtimeDir);
		await broker.listening;
		currentClient = await createDaemonBrokerClient(projectDir, { runtimeDir });
		const recovered = await reconcile(currentClient, third.launch!);
		expect(recovered).toMatchObject({ state: "terminal", final: true, outcome: "cancelled" });
		expect(recovered.service).toEqual({ id: thirdStart.daemon.id, generation: String(thirdStart.daemon.startedAt) });
		if (thirdStart.daemon.pid !== undefined)
			expect(Process.fromPid(thirdStart.daemon.pid)?.status()).not.toBe("running");
	} finally {
		firstClient.close();
		keeper.close();
		if (broker.child.exitCode === null) {
			await currentClient.request({ op: "shutdown" }).catch(() => undefined);
			if (broker.child.exitCode === null) broker.child.kill("SIGKILL");
		}
		currentClient.close();
		await broker.child.exited;
		await pending;
		for (const pid of pids) await Process.fromPid(pid)?.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
	}
}, 45_000);

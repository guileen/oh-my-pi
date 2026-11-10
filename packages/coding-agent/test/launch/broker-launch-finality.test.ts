import { Database } from "bun:sqlite";
// Integration tests: real broker RPC, native process lifetime, and real timers are required.
// The delayed stat holds preparation before enumeration can see a service record.
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_LAUNCH_LEDGER_FILE,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonLaunchMetadata,
	type DaemonOperation,
	type LaunchDisposition,
} from "../../src/launch/protocol";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

async function boot(
	projectDir: string,
	runtimeDir: string,
): Promise<{
	client: DaemonBrokerClient;
	close(): Promise<void>;
}> {
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const ready = Promise.withResolvers<void>();
	const previousTitle = process.title;
	const previousProject = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntime = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment({ onListening: ready.resolve });
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProject);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntime);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	await Promise.race([
		ready.promise,
		broker.then(() => {
			throw new Error("Broker exited before listening");
		}),
	]);
	return {
		client,
		async close() {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		},
	};
}

function launch(projectDir: string, id: string, epoch = "1"): Extract<DaemonOperation, { op: "start" }> {
	return {
		op: "start",
		owner: "bot-session",
		launch: { launch_intent_id: id, session_owner_id: "bot-session", owner_epoch: epoch },
		replace: true,
		awaitReady: false,
		spec: {
			name: "owned-service",
			application: process.execPath,
			args: ["-e", 'Bun.serve({ port: 0, fetch() { return new Response("ok"); } })'],
			env: { FIRST: "1", SECOND: "2" },
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		},
	};
}

async function reconcile(
	client: DaemonBrokerClient,
	metadata: DaemonLaunchMetadata,
	mode: "inspect" | "cancel",
): Promise<LaunchDisposition> {
	const result = await client.request({ op: "reconcile_launch", ...metadata, mode });
	if (result.op !== "reconcile_launch") throw new Error("Unexpected launch reconciliation result");
	return result.disposition;
}

async function waitForRunning(client: DaemonBrokerClient, metadata: DaemonLaunchMetadata): Promise<LaunchDisposition> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const disposition = await reconcile(client, metadata, "inspect");
		if (disposition.state === "running") return disposition;
		await Bun.sleep(10);
	}
	throw new Error("Launch did not become running");
}

describe("broker durable launch finality", () => {
	it.each([1, 2])(
		"does not stop an existing daemon when replacement is fenced during refresh %i",
		async blockedRefresh => {
			using temp = TempDir.createSync("@omp-launch-replace-fence-");
			const projectDir = path.join(temp.path(), "project");
			const runtimeDir = path.join(temp.path(), "runtime");
			await fs.mkdir(projectDir);
			const broker = await boot(projectDir, runtimeDir);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let targetPid: number | undefined;
			let pending: Promise<unknown> | undefined;
			let restoreStat: (() => void) | undefined;
			try {
				const initial = launch(projectDir, "unused");
				const started = await broker.client.request({
					...initial,
					owner: undefined,
					launch: undefined,
					spec: { ...initial.spec, detached: true },
				});
				if (started.op !== "start" || started.daemon.pid === undefined)
					throw new Error("Existing daemon did not start");
				targetPid = started.daemon.pid;
				const logPath = path.join(runtimeDir, "daemons", initial.spec.name, "output.log");
				const originalStat = fs.stat;
				let refreshes = 0;
				const delayedStat = spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
					if (String(args[0]) === logPath && ++refreshes === blockedRefresh) {
						entered.resolve();
						await release.promise;
					}
					return originalStat(...args);
				}) as typeof fs.stat);
				restoreStat = () => delayedStat.mockRestore();
				const stale = launch(projectDir, "stale-replacement");
				pending = broker.client.request(stale).catch(error => error);
				await entered.promise;
				await broker.client.request({
					op: "fence_owner",
					session_owner_id: "bot-session",
					through_epoch: "1",
				});
				release.resolve();
				expect(await pending).toBeInstanceOf(Error);
				restoreStat();
				restoreStat = undefined;
				const listed = await broker.client.request({ op: "list" });
				expect(listed).toMatchObject({
					op: "list",
					daemons: [{ id: started.daemon.id, pid: targetPid, state: "running" }],
				});
				expect(Process.fromPid(targetPid)?.status() === "running").toBe(true);
				expect(await reconcile(broker.client, stale.launch!, "inspect")).toMatchObject({
					state: "cancelled_before_launch",
					final: true,
				});
				const fresh = launch(projectDir, "fresh-replacement", "2");
				const replaced = await broker.client.request(fresh);
				if (replaced.op !== "start") throw new Error("Unexpected start result");
				expect(replaced.daemon.id).not.toBe(started.daemon.id);
				expect((await waitForRunning(broker.client, fresh.launch!)).state).toBe("running");
			} finally {
				release.resolve();
				restoreStat?.();
				await pending;
				await broker.close();
				if (targetPid !== undefined)
					await Process.fromPid(targetPid)?.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			}
		},
		15_000,
	);

	it("refuses stale-owner cleanup of a replacement generation", async () => {
		using temp = TempDir.createSync("@omp-launch-owner-fence-");
		const projectDir = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(projectDir);
		const broker = await boot(projectDir, runtimeDir);
		try {
			const replacement = launch(projectDir, "replacement", "2");
			const started = await broker.client.request(replacement);
			if (started.op !== "start") throw new Error("Unexpected start result");
			await waitForRunning(broker.client, replacement.launch!);
			const stop = {
				op: "stop_owned" as const,
				name: started.daemon.name,
				id: started.daemon.id,
				generation: String(started.daemon.startedAt),
				session_owner_id: "bot-session",
				through_epoch: "1",
				timeoutMs: 5_000,
			};
			await expect(broker.client.request(stop)).rejects.toThrow("cannot be confirmed");
			expect((await reconcile(broker.client, replacement.launch!, "inspect")).state).toBe("running");
			const result = await broker.client.request({ ...stop, through_epoch: "2" });
			expect(result).toMatchObject({ op: "stop_owned", daemon: { state: "exited" } });
		} finally {
			await broker.close();
		}
	}, 15_000);

	it("registers once, canonicalizes environment order, and rejects changed identity or payload", async () => {
		using temp = TempDir.createSync("@omp-launch-intent-");
		const projectDir = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(projectDir);
		const broker = await boot(projectDir, runtimeDir);
		const operation = launch(projectDir, "intent-once");
		let terminal: LaunchDisposition | undefined;
		try {
			const first = await broker.client.request(operation);
			const duplicate = await broker.client.request({
				...operation,
				awaitReady: true,
				spec: { ...operation.spec, env: { SECOND: "2", FIRST: "1" } },
			});
			expect(duplicate).toEqual(first);
			await expect(
				broker.client.request({ ...operation, spec: { ...operation.spec, args: ["-e", "process.exit(1)"] } }),
			).rejects.toThrow("idempotency_conflict");
			await expect(
				broker.client.request({ ...operation, launch: { ...operation.launch!, owner_epoch: "2" } }),
			).rejects.toThrow("idempotency_conflict");
			await expect(
				broker.client.request({ ...launch(projectDir, "wrong-owner"), owner: "another-session" }),
			).rejects.toThrow("does not match");
			const listed = await broker.client.request({ op: "list" });
			if (listed.op !== "list") throw new Error("Unexpected list result");
			expect(listed.daemons).toHaveLength(1);
			const disposition = await reconcile(broker.client, operation.launch!, "cancel");
			terminal = disposition;
			expect(disposition).toMatchObject({ state: "terminal", final: true, outcome: "cancelled", error: null });
			if (first.op !== "start") throw new Error("Unexpected start result");
			expect(disposition.service).toEqual({ id: first.daemon.id, generation: String(first.daemon.startedAt) });
		} finally {
			await broker.close();
		}
		const restarted = await boot(projectDir, runtimeDir);
		try {
			expect(await reconcile(restarted.client, operation.launch!, "inspect")).toEqual(terminal);
			const retained = await restarted.client.request(operation);
			expect(retained).toMatchObject({ op: "start", daemon: { state: "exited" } });
		} finally {
			await restarted.close();
		}
	}, 15_000);

	it.each(["fence", "cancel"] as const)(
		"covers an accepted start delayed beyond empty enumeration via %s and retains finality",
		async mode => {
			using temp = TempDir.createSync("@omp-launch-pending-");
			const projectDir = path.join(temp.path(), "project");
			const runtimeDir = path.join(temp.path(), "runtime");
			await fs.mkdir(projectDir);
			const broker = await boot(projectDir, runtimeDir);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const originalStat = fs.stat;
			const delayedStat = spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
				if (String(args[0]) === projectDir) {
					entered.resolve();
					await release.promise;
				}
				return originalStat(...args);
			}) as typeof fs.stat);
			const operation = launch(projectDir, "delayed-intent");
			let pending: Promise<unknown> | undefined;
			try {
				pending = broker.client.request(operation).catch(error => error);
				await entered.promise;
				const empty = await broker.client.request({ op: "list" });
				expect(empty).toEqual({ op: "list", daemons: [] });
				expect(await reconcile(broker.client, operation.launch!, "inspect")).toMatchObject({
					state: "pending",
					final: false,
				});
				const cancelled = mode === "cancel" ? reconcile(broker.client, operation.launch!, "cancel") : undefined;
				const fenced = await broker.client.request({
					op: "fence_owner",
					session_owner_id: "bot-session",
					through_epoch: "1",
				});
				expect(fenced).toEqual({ op: "fence_owner", fenced_through_epoch: "1" });
				release.resolve();
				expect(await pending).toBeInstanceOf(Error);
				const disposition = cancelled
					? await cancelled
					: await reconcile(broker.client, operation.launch!, "inspect");
				expect(disposition).toEqual({
					launch_intent_id: "delayed-intent",
					state: "cancelled_before_launch",
					service: null,
					outcome: null,
					final: true,
					error: null,
				});
				expect(await broker.client.request({ op: "list" })).toEqual({ op: "list", daemons: [] });
			} finally {
				release.resolve();
				delayedStat.mockRestore();
				await pending;
				await broker.close();
			}
			const restarted = await boot(projectDir, runtimeDir);
			try {
				expect(await reconcile(restarted.client, operation.launch!, "inspect")).toMatchObject({
					state: "cancelled_before_launch",
					final: true,
				});
				await expect(restarted.client.request(operation)).rejects.toThrow();
				await expect(restarted.client.request(launch(projectDir, "late-arrival"))).rejects.toThrow("fenced");
				const next = await restarted.client.request(launch(projectDir, "next-epoch", "2"));
				expect(next.op).toBe("start");
			} finally {
				await restarted.close();
			}
		},
		20_000,
	);

	it("keeps old cancellation and exact stop guards from killing a reused service generation", async () => {
		using temp = TempDir.createSync("@omp-launch-generation-");
		const projectDir = path.join(temp.path(), "project");
		await fs.mkdir(projectDir);
		const broker = await boot(projectDir, path.join(temp.path(), "runtime"));
		try {
			const old = launch(projectDir, "old-generation");
			const oldStart = await broker.client.request(old);
			if (oldStart.op !== "start") throw new Error("Unexpected start result");
			const terminal = await reconcile(broker.client, old.launch!, "cancel");
			const next = await broker.client.request(launch(projectDir, "new-generation", "2"));
			if (next.op !== "start") throw new Error("Unexpected start result");
			expect(next.daemon.id).not.toBe(oldStart.daemon.id);
			expect(await reconcile(broker.client, old.launch!, "cancel")).toEqual(terminal);
			const protectedStop = await broker.client.request({
				op: "stop",
				name: next.daemon.name,
				id: oldStart.daemon.id,
				generation: String(oldStart.daemon.startedAt),
				timeoutMs: 500,
			});
			if (protectedStop.op !== "stop") throw new Error("Unexpected stop result");
			expect(protectedStop.daemon.id).toBe(next.daemon.id);
			expect(protectedStop.daemon.state).toBe("running");
			const wrongGeneration = await broker.client.request({
				op: "stop",
				name: next.daemon.name,
				id: next.daemon.id,
				generation: "0",
				timeoutMs: 500,
			});
			if (wrongGeneration.op !== "stop") throw new Error("Unexpected stop result");
			expect(wrongGeneration.daemon.state).toBe("running");
		} finally {
			await broker.close();
		}
	}, 15_000);

	it("reconciles a lost readiness response and cancels without waiting for its readiness timeout", async () => {
		using temp = TempDir.createSync("@omp-launch-response-");
		const projectDir = path.join(temp.path(), "project");
		await fs.mkdir(projectDir);
		const runtimeDir = path.join(temp.path(), "runtime");
		const broker = await boot(projectDir, runtimeDir);
		const observer = await createDaemonBrokerClient(projectDir, { runtimeDir });
		const abort = new AbortController();
		const operation = launch(projectDir, "lost-response");
		operation.awaitReady = true;
		operation.spec.ready = { log: "never-ready", timeoutMs: 60_000 };
		const response = broker.client.request(operation, abort.signal).catch(error => error);
		try {
			const running = await waitForRunning(observer, operation.launch!);
			expect(running.final).toBe(false);
			abort.abort();
			expect(await response).toBeInstanceOf(Error);
			expect(await reconcile(observer, operation.launch!, "inspect")).toMatchObject({
				state: "running",
				final: false,
			});
			const cancelled = await reconcile(observer, operation.launch!, "cancel");
			expect(cancelled).toMatchObject({ state: "terminal", final: true, outcome: "cancelled" });
			expect(cancelled.service).toEqual(running.service);
		} finally {
			abort.abort();
			observer.close();
			await broker.close();
		}
	}, 15_000);

	it("does not turn missing ledger or an empty service inventory into final cleanup", async () => {
		using temp = TempDir.createSync("@omp-launch-ledger-loss-");
		const projectDir = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(projectDir);
		const operation = launch(projectDir, "retained-intent");
		const first = await boot(projectDir, runtimeDir);
		try {
			expect(await reconcile(first.client, operation.launch!, "inspect")).toMatchObject({
				state: "unknown",
				final: false,
				error: { code: "cleanup_failed" },
			});
			await first.client.request({ op: "fence_owner", session_owner_id: "bot-session", through_epoch: "1" });
			expect(await reconcile(first.client, operation.launch!, "cancel")).toMatchObject({
				state: "unknown",
				final: false,
				error: { code: "cleanup_failed" },
			});
		} finally {
			await first.close();
		}
		const retained = await boot(projectDir, runtimeDir);
		try {
			expect(await reconcile(retained.client, operation.launch!, "cancel")).toMatchObject({
				state: "unknown",
				final: false,
				error: { code: "cleanup_failed" },
			});
			await expect(retained.client.request(operation)).rejects.toThrow("cleanup_failed");
		} finally {
			await retained.close();
		}
		await fs.rm(path.join(runtimeDir, DAEMON_LAUNCH_LEDGER_FILE));
		const restarted = await boot(projectDir, runtimeDir);
		try {
			expect(await restarted.client.request({ op: "list" })).toEqual({ op: "list", daemons: [] });
			expect(await reconcile(restarted.client, operation.launch!, "cancel")).toMatchObject({
				state: "unknown",
				final: false,
				error: { code: "cleanup_failed" },
			});
			await expect(
				restarted.client.request({ op: "fence_owner", session_owner_id: "bot-session", through_epoch: "1" }),
			).rejects.toThrow("cleanup_failed");
		} finally {
			await restarted.close();
		}
	}, 15_000);

	it.each(["empty", "truncated", "missing_tables"] as const)(
		"rejects a retained %s ledger without rebuilding its schema or losing fences",
		async corruption => {
			using temp = TempDir.createSync("@omp-launch-ledger-corruption-");
			const projectDir = path.join(temp.path(), "project");
			const runtimeDir = path.join(temp.path(), "runtime");
			await fs.mkdir(projectDir);
			const first = await boot(projectDir, runtimeDir);
			try {
				expect(
					await first.client.request({ op: "fence_owner", session_owner_id: "bot-session", through_epoch: "1" }),
				).toEqual({ op: "fence_owner", fenced_through_epoch: "1" });
			} finally {
				await first.close();
			}
			const ledgerPath = path.join(runtimeDir, DAEMON_LAUNCH_LEDGER_FILE);
			if (corruption === "missing_tables") {
				using db = new Database(ledgerPath);
				db.exec("DROP TABLE owners");
			} else {
				await fs.truncate(ledgerPath, corruption === "empty" ? 0 : 64);
			}
			const restarted = await boot(projectDir, runtimeDir);
			try {
				const delayed = launch(projectDir, `corrupt-${corruption}`);
				await expect(restarted.client.request(delayed)).rejects.toThrow("cleanup_failed");
				expect(await reconcile(restarted.client, delayed.launch!, "cancel")).toMatchObject({
					state: "unknown",
					final: false,
					error: { code: "cleanup_failed" },
				});
				expect(await restarted.client.request({ op: "list" })).toEqual({ op: "list", daemons: [] });
			} finally {
				await restarted.close();
			}
		},
		15_000,
	);

	it("does not expose terminal cancellation when its durable final write fails", async () => {
		using temp = TempDir.createSync("@omp-launch-final-write-failure-");
		const projectDir = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(projectDir);
		const broker = await boot(projectDir, runtimeDir);
		const operation = launch(projectDir, "failed-final-commit");
		let pid: number | undefined;
		try {
			const started = await broker.client.request(operation);
			if (started.op !== "start") throw new Error("Unexpected start result");
			pid = started.daemon.pid;
			using db = new Database(path.join(runtimeDir, DAEMON_LAUNCH_LEDGER_FILE));
			db.exec(`CREATE TRIGGER fail_final_launch BEFORE INSERT ON launches
				WHEN json_extract(NEW.data, '$.disposition.final') = 1
				BEGIN SELECT RAISE(ABORT, 'injected final persistence failure'); END`);
			const disposition = await reconcile(broker.client, operation.launch!, "cancel");
			expect(disposition).toMatchObject({ state: "unknown", final: false, error: { code: "cleanup_failed" } });
			expect(await reconcile(broker.client, operation.launch!, "inspect")).toMatchObject({
				state: "unknown",
				final: false,
				error: { code: "cleanup_failed" },
			});
			if (pid !== undefined) expect(Process.fromPid(pid)?.status()).not.toBe("running");
		} finally {
			await broker.close();
			if (pid !== undefined) await Process.fromPid(pid)?.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
		}
	}, 15_000);

	it("reports an unavailable client as uncertain rather than cancelled", async () => {
		using temp = TempDir.createSync("@omp-launch-client-loss-");
		const client = await createDaemonBrokerClient(temp.path(), { runtimeDir: path.join(temp.path(), "runtime") });
		client.close();
		expect(
			await reconcile(
				client,
				{ launch_intent_id: "unconfirmed", session_owner_id: "owner", owner_epoch: "1" },
				"cancel",
			),
		).toMatchObject({ state: "unknown", final: false, error: { code: "cleanup_failed", retryable: true } });
	});
});

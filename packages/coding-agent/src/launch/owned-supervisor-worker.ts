import * as fs from "node:fs";
import * as path from "node:path";
import { FileLock, IpcConnection, IpcServer, OwnedChild } from "@oh-my-pi/pi-natives";
import {
	capabilityEqual,
	hasStarted,
	OWNED_SUPERVISOR_DIR_ENV,
	OWNED_SUPERVISOR_MAX_FRAME_BYTES,
	parseOperation,
	readConfig,
	record,
	writeStarted,
	writeTerminal,
	type OwnedSupervisorStatus,
} from "./owned-supervisor-protocol";

/**
 * One native child, one generation, one process-owned lock. Losing this worker
 * loses control, not authority to adopt a numeric PID. The durable intent then
 * permanently fences another application launch for this generation.
 */
export async function startOwnedSupervisorFromEnvironment(): Promise<void> {
	const dir = process.env[OWNED_SUPERVISOR_DIR_ENV];
	if (!dir || !path.isAbsolute(dir)) throw new Error("Owned supervisor requires its private generation directory");
	const config = readConfig(dir);
	const lock = FileLock.tryAcquire(path.join(dir, "owned-supervisor.owner.lock"));
	if (!lock.acquired) return;
	const connections = new Set<IpcConnection>();
	const launchReady = Promise.withResolvers<void>();
	let server: IpcServer | undefined;
	let child: OwnedChild | undefined;
	let state: OwnedSupervisorStatus = {
		generation: config.generation,
		state: "prepared",
		pid: null,
		exitCode: null,
		signal: null,
	};
	let stopAt: number | undefined;
	let terminalPersisted = false;
	const finish = (): void => {
		if (state.state === "exited" || state.state === "unknown") {
			if (!terminalPersisted) {
				writeTerminal(config, state);
				terminalPersisted = true;
			}
		}
	};
	const poll = (): OwnedSupervisorStatus => {
		if (child && state.state === "running") {
			const result = child.poll();
			if (!result.running) {
				state =
					(result.exitCode === null) === (result.signal === null)
						? { ...state, state: "unknown", error: "Owned application returned no unambiguous terminal status" }
						: { ...state, state: "exited", exitCode: result.exitCode, signal: result.signal };
				finish();
			}
		}
		return state;
	};
	const stop = (): void => {
		if (stopAt !== undefined || poll().state !== "running" || !child) return;
		// Unix groups are owned only while their native leader is unreaped. This
		// is not descendant containment: a descendant can escape with setsid().
		child.signal(15, process.platform !== "win32");
		stopAt = Date.now() + 2000;
	};
	try {
		// Do not touch a winner's endpoint, and never reinterpret a stale intent
		// as permission to launch. The marker's mere presence is fail-closed.
		if (hasStarted(dir)) return;
		server = await IpcServer.listen(
			config.endpoint,
			{
				framing: "lines",
				maxFrameBytes: OWNED_SUPERVISOR_MAX_FRAME_BYTES,
			},
			connection => {
				if (connections.size >= 64) {
					connection.destroy();
					return;
				}
				connections.add(connection);
				// Bound unauthenticated connections, including peers that never send a frame.
				const idle = setTimeout(() => connection.destroy(), 5000);
				connection.start(
					async line => {
						// Native acceptance callbacks may run before listen() resolves.
						// Never authenticate/acknowledge a prepared-state signal and then spawn.
						await launchReady.promise;
						if (connection.closed) return;
						let id = "";
						try {
							const request: unknown = JSON.parse(line);
							if (
								!record(request) ||
								request.version !== 1 ||
								typeof request.id !== "string" ||
								request.id.length < 1 ||
								request.id.length > 128 ||
								request.generation !== config.generation ||
								typeof request.token !== "string" ||
								request.token.length !== 64 ||
								!capabilityEqual(request.token, config.token)
							)
								throw new Error("Owned supervisor authentication failed");
							id = request.id;
							const operation = parseOperation(request.operation);
							idle.refresh();
							let delivered = false;
							poll();
							if (operation.op === "signal") {
								if (operation.group && process.platform === "win32") {
									throw new Error("Safe process-group signaling is unsupported on Windows");
								}
								if (child && state.state === "running") {
									// Native poll/signal share a lock; signal cannot target a PID
									// after that owned child was reaped, including this race.
									delivered = child.signal(operation.signal, operation.group);
									poll();
								}
							} else if (operation.op === "input") {
								if (!child || state.state !== "running") throw new Error("Owned application is not running");
								child.write(operation.data);
							}
							if (!connection.send(JSON.stringify({ id, ok: true, status: state, delivered })))
								connection.destroy();
						} catch (error) {
							const message =
								error instanceof Error ? error.message.slice(0, 4096) : "Owned supervisor request failed";
							connection.send(JSON.stringify({ id, ok: false, error: message }));
							connection.end();
						}
					},
					() => {
						clearTimeout(idle);
						connections.delete(connection);
					},
				);
			},
		);
		const endpointIdentity = process.platform === "win32" ? undefined : fs.lstatSync(config.endpoint);
		// No await between publishing intent and obtaining the owned handle. Live
		// requests cannot observe prepared, acknowledge a signal, then start later.
		writeStarted(config);
		try {
			child = OwnedChild.spawn(config.spec);
			state = { ...state, state: "running", pid: child.pid };
			launchReady.resolve();
		} catch {
			// Without a handle we cannot prove the OS never created a process.
			state = {
				...state,
				state: "unknown",
				error:
					process.platform === "win32"
						? "Owned application supervision is unsupported on Windows"
						: "Owned application spawn did not return an ownership handle",
			};
			finish();
			return;
		}
		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
		while (poll().state === "running") {
			if (endpointIdentity) {
				try {
					const current = fs.lstatSync(config.endpoint);
					if (current.dev !== endpointIdentity.dev || current.ino !== endpointIdentity.ino) stop();
				} catch {
					stop();
				}
			}
			if (stopAt !== undefined && Date.now() >= stopAt && child) {
				child.signal(9, process.platform !== "win32");
			}
			await Bun.sleep(25);
		}
		finish();
		// A status/signal request may have observed exit and queued its reply.
		// Drain only briefly; durable authenticated status supports disconnected recovery.
		await Promise.race([Promise.all([...connections].map(connection => connection.drained())), Bun.sleep(100)]);
	} finally {
		launchReady.resolve();
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		for (const connection of connections) connection.destroy();
		await server?.close();
		lock.release();
	}
}

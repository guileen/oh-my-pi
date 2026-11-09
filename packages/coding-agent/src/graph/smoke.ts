import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import { GraphRunStore } from "./store";
import { GRAPH_WIRE_PROTOCOL, GraphWireSourceState } from "@oh-my-pi/pi-wire/graph";
import { createDaemonBrokerClient } from "../launch/client";
import {
	resolveCliEntryCmd,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { GRAPH_ROOT_ENV, GRAPH_WIRE_READ_ARG, GRAPH_WORKER_ARG } from "./worker-protocol";

/** Verify standalone workers and local-policy admission fail closed, including through the broker. */
export async function smokeTestGraphWorker(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-graph-smoke-"));
	try {
		const launch = resolveWorkerSpawnCmd(GRAPH_WORKER_ARG);
		const child = Bun.spawn(launch.cmd, {
			cwd: launch.cwd,
			env: workerEnvFromParent({ [GRAPH_ROOT_ENV]: root }),
			stdout: "ignore",
			stderr: "pipe",
		});
		const timeout = setTimeout(() => child.kill(), SMOKE_TEST_TIMEOUT_MS);
		try {
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			if (exitCode === 0 || !stderr.includes("Graph worker requires trusted host configuration")) {
				throw new Error(`Graph worker did not fail closed: exit ${exitCode}, ${stderr}`);
			}
		} finally {
			clearTimeout(timeout);
		}
		const env = workerEnvFromParent({ PI_CODING_AGENT_DIR: root, OMP_PROFILE: "", PI_PROFILE: "" });
		const command = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
			const process = Bun.spawn([...resolveCliEntryCmd(), "graph", ...args], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const timer = setTimeout(() => process.kill(), SMOKE_TEST_TIMEOUT_MS);
			try {
				const [code, stdout, stderr] = await Promise.all([
					process.exited,
					new Response(process.stdout).text(),
					new Response(process.stderr).text(),
				]);
				return { code, stdout, stderr };
			} finally {
				clearTimeout(timer);
			}
		};
		const definition = path.join(root, "graph.md");
		await fs.writeFile(
			definition,
			"---\nformat: omp.graph/v1\nname: smoke\nmembers: {}\nnodes:\n  work: {kind: program, task: '#work', executor: example}\n---\n## work\nRun the trusted smoke program.\n",
		);
		const imported = await command("import", "--file", definition, "--request-key", "smoke-import");
		const graph = imported.stdout.match(/^Graph: (.+)$/m)?.[1];
		if (imported.code !== 0 || !graph) throw new Error(`Graph CLI import failed: ${imported.stderr}`);
		const graphRoot = path.join(root, "graphs");
		await fs.writeFile(
			path.join(graphRoot, "local-policy.json"),
			JSON.stringify({
				version: 1,
				graphs: [graph],
				programs: {
					example: {
						executable: "/usr/bin/true",
						workspaceRoot: root,
						argv: [],
						outputs: {},
						outcome: "done",
						timeoutMs: 5000,
					},
				},
			}),
			{ mode: 0o600 },
		);
		const started = await command("start", graph, "--request-key", "smoke-start", "--if-revision", "1");
		if (started.code === 0 || !started.stderr.includes("trusted preflight"))
			throw new Error("Graph CLI accepted the unavailable local policy");
		const ensured = await command("host", "ensure");
		if (ensured.code === 0 || !ensured.stderr.includes("Standalone Graph worker is unavailable"))
			throw new Error("Graph CLI accepted the unavailable standalone worker");
		const broker = await createDaemonBrokerClient(graphRoot, { runtimeDir: path.join(graphRoot, "runtime") });
		try {
			await broker.request({
				op: "start",
				awaitReady: false,
				spec: {
					name: "omp.graph.host",
					application: launch.cmd[0],
					args: launch.cmd.slice(1),
					cwd: launch.cwd ?? graphRoot,
					env: workerEnvFromParent({ [GRAPH_ROOT_ENV]: graphRoot }),
					pty: false,
					persist: true,
					detached: true,
					restart: "no",
				},
			});
			const exited = await broker.request({
				op: "wait",
				name: "omp.graph.host",
				for: "exit",
				timeoutMs: SMOKE_TEST_TIMEOUT_MS,
			});
			if (exited.op !== "wait" || exited.timedOut || !["exited", "failed"].includes(exited.daemon.state))
				throw new Error("Broker-launched Graph worker did not fail closed");
		} finally {
			await broker.request({ op: "stop", name: "omp.graph.host", timeoutMs: 5_000 }).catch(() => undefined);
			await broker.request({ op: "shutdown" }).catch(() => undefined);
			broker.close();
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** Exercise the compiled/source CLI's real readonly wire module graph and mutation denial. */
export async function smokeTestGraphWireRead(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-graph-wire-smoke-"));
	const store = new GraphRunStore({ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 }, root);
	try {
		const imported = store.definitions.mutate({
			version: 1,
			request_key: "import",
			operation: "import",
			target_id: null,
			if_revision: null,
			payload: {
				content:
					"---\nformat: omp.graph/v1\nname: wire-smoke\nmembers: {}\nnodes:\n  approval: {kind: human, task: '#approval'}\n---\n## approval\nDecide.\n",
			},
		});
		if (imported.error) throw new Error("Cannot prepare wire smoke definition");
		const definition = store.definitions.get(imported.target_id!)!;
		const authorization_ref = { id: "smoke-authorization", digest: "sha256:smoke" };
		const run = store.start(
			{
				version: 1,
				request_key: "start",
				operation: "start",
				target_id: definition.graph_id,
				if_revision: definition.revision,
				payload: { inputs: {}, authorization_ref },
			},
			{
				graph_id: definition.graph_id,
				definition_revision: definition.revision,
				definition_digest: definition.digest,
				authorization_ref,
				inputs: {},
				members: {},
				executors: {},
				observation: { source_id: "smoke-source", members: {} },
			},
		);
		if (run.state !== "accepted" || !run.target_id) throw new Error("Cannot prepare wire smoke Run");
		const runId = run.target_id;
		const consumer = new GraphWireSourceState({
			subscriptionId: "smoke",
			mode: "live",
			scope: { source_ids: ["smoke-source"], graph_run_id: runId },
			limits: { maxRecords: 100, maxPages: 100, maxEvents: 100 },
		});
		const launch = resolveWorkerSpawnCmd(GRAPH_WIRE_READ_ARG);
		const child = Bun.spawn([...launch.cmd, root, "smoke-source", runId], {
			cwd: launch.cwd,
			env: workerEnvFromParent(),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(child.stderr).text();
		const timer = setTimeout(() => child.kill(), SMOKE_TEST_TIMEOUT_MS);
		let ready = false;
		let denied = false;
		const send = (type: string, fields: Record<string, unknown>) =>
			child.stdin.write(`${JSON.stringify({ protocol: GRAPH_WIRE_PROTOCOL, type, message_id: type, ...fields })}\n`);
		try {
			send("hello", { supported_protocols: [GRAPH_WIRE_PROTOCOL], extensions: ["graph.execution.v1"] });
			send("subscribe", {
				subscription_id: "smoke",
				mode: "live",
				scope: { source_ids: ["smoke-source"], graph_run_id: runId },
				resume: null,
			});
			for await (const line of readLines(child.stdout)) {
				const frame = JSON.parse(new TextDecoder().decode(line));
				if (frame.type === "hello") {
					if (frame.extensions.length || frame.capabilities.includes("graph.execution.v1"))
						throw new Error("Readonly wire unexpectedly advertises execution");
					continue;
				}
				if (frame.type === "error") {
					if (frame.in_reply_to !== "graph.command" || frame.error.code !== "capability_unavailable")
						throw new Error("Readonly wire returned an unexpected error");
					denied = true;
					child.stdin.end();
					continue;
				}
				consumer.apply(frame);
				if (frame.type === "source.ready" && !ready) {
					const source = consumer.read().sources[0];
					if (
						!source?.ready ||
						!source.records.some(
							record =>
								record.kind === "run" &&
								record.value.graph_run_id === runId &&
								record.value.graph_id === definition.graph_id &&
								record.value.definition.nodes.some(node => node.node_id === "approval"),
						)
					)
						throw new Error("Readonly wire did not deliver the native Run");
					ready = true;
					send("graph.command", { action: "cancel", graph_run_id: runId });
				}
			}
			const exit = await child.exited;
			if (exit !== 0 || !ready || !denied || store.getRun(runId)?.state !== "queued")
				throw new Error(`Readonly wire smoke failed: exit=${exit}; ${await stderr}`);
		} finally {
			clearTimeout(timer);
			child.kill();
			await child.exited;
			await stderr;
		}
	} finally {
		store.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

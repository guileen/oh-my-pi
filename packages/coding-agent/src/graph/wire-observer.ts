import { Readable, Writable } from "node:stream";
import { serveGraphWireStdio } from "./wire-stdio";

// Internal trusted launcher only: [--execution-records] ROOT SOURCE_ID RUN_ID [RUN_ID...].
// The opt-in exposes only execution observation and scoped consultation text. No command registration,
// browser listener, credential handshake or client-controlled source/Run configuration.
// The parent owns real session/current-config authorization and MUST close stdin on revocation;
// see serveGraphWireStdio's contract. Merely launching this process confers no authorization.
export async function startGraphWireObserver(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const lifetime = new AbortController();
	const stop = (): void => lifetime.abort();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		const args = [...argv];
		const executionRecords = args[0] === "--execution-records";
		const positional = executionRecords ? args.slice(1) : args;
		const [root, sourceId, ...runIds] = positional;
		if (!root || !sourceId || !runIds.length || positional.some(value => value.startsWith("-")))
			throw new Error("Invalid launcher configuration");
		await serveGraphWireStdio({
			root,
			sourceId,
			runIds,
			executionRecords,
			input: Readable.toWeb(process.stdin),
			output: Writable.toWeb(process.stdout),
			signal: lifetime.signal,
		});
	} catch {
		process.stderr.write("Graph wire observation unavailable\n");
		process.exitCode = 1;
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		// Own process-stream lifetime too: unresolved pipe backpressure cannot retain the source.
		process.stdin.destroy();
		process.stdout.destroy();
	}
}

if (import.meta.main) void startGraphWireObserver();

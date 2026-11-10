import { GRAPH_CLI_LIMITS } from "./cli";
import { GraphHost, type GraphHostOptions } from "./host";
import { GraphRunStore } from "./store";
import { GRAPH_ROOT_ENV } from "./worker-protocol";

/**
 * The factory is a trusted embedding capability, not configuration from a Graph or
 * an environment variable. It must supply the real grant, executor and result
 * verification implementations required by GraphHost.
 */
export interface GraphWorkerOptions {
	root: string;
	signal: AbortSignal;
	createHostOptions?: (store: GraphRunStore) => Omit<GraphHostOptions, "store">;
	intervalMs?: number;
}

function waitForNextTick(signal: AbortSignal, intervalMs: number): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const finish = (): void => {
		clearTimeout(timer);
		signal.removeEventListener("abort", finish);
		resolve();
	};
	const timer = setTimeout(finish, intervalMs);
	signal.addEventListener("abort", finish, { once: true });
	if (signal.aborted) finish();
	return promise;
}

/** Run a single profile owner only when the trusted host policy is available. */
export async function runGraphWorker(options: GraphWorkerOptions): Promise<void> {
	const intervalMs = options.intervalMs ?? 250;
	if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("Invalid Graph worker interval");
	if (!options.createHostOptions) throw new Error("Graph worker requires trusted host configuration");
	const store = new GraphRunStore(GRAPH_CLI_LIMITS, options.root);
	try {
		const host = new GraphHost({ ...options.createHostOptions(store), store });
		if (!host.start()) throw new Error("Cannot establish Graph host ownership");
		try {
			while (!options.signal.aborted) {
				await host.tick();
				await waitForNextTick(options.signal, intervalMs);
			}
		} finally {
			await host.shutdown();
		}
	} finally {
		store.close();
	}
}

/** The standalone worker cannot safely supply local revocation and containment. */
export async function startGraphWorkerFromEnvironment(): Promise<void> {
	if (!process.env[GRAPH_ROOT_ENV]) throw new Error("Graph worker requires its profile-local root");
	throw new Error("Graph worker requires trusted host configuration; standalone local execution is unavailable");
}

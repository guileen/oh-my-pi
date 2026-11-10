import type { ReadableStreamDefaultReader, WritableStreamDefaultWriter } from "node:stream/web";
import { untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { GraphWireArtifactContentReader } from "./wire-artifact-content";
import { GraphWireConsultationDetailReader } from "./wire-consultation-detail";
import { GraphReadProfile } from "./read-profile";
import { GraphWireLedger } from "./wire-ledger";
import { GraphWireReadBridge, type GraphWireReadFrame } from "./wire-read-bridge";
import { GRAPH_WIRE_EXECUTION_EXTENSION, GRAPH_WIRE_PROTOCOL } from "@oh-my-pi/pi-wire/graph";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 128 * 1024;
const MAX_PENDING_REQUESTS = 16;
const identity = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);
const unavailable = (): Error => new Error("Graph wire observation unavailable");
class PollDue extends Error {}

export interface GraphWireStdioOptions {
	root: string;
	sourceId: string;
	runIds: readonly string[];
	input: ReadableStream<Uint8Array>;
	output: WritableStream<Uint8Array>;
	/** Trusted read-only execution observation opt-in; never inferred from wire frames or env. */
	executionRecords?: boolean;
	/** Separately trusted file reader. Execution observation alone grants no artifact file access. */
	artifactContents?: Pick<GraphWireArtifactContentReader, "read">;
	/** Immediate trusted-parent revocation; not a wire request or an authentication mechanism. */
	signal?: AbortSignal;
	/** Optional additional trusted embedding check, never supplied by a client frame. */
	assertAuthorized?: (signal: AbortSignal) => void | Promise<void>;
	/** 1..5000ms. Production defaults to 1000ms. */
	pollIntervalMs?: number;
	/** 1..5000ms, includes actual writable backpressure. Defaults to 1000ms. */
	writeTimeoutMs?: number;
}

/**
 * Internal private-pipe source for an ALREADY authenticated, authorized parent. The launcher
 * fixes the one source and exact non-null Run allowlist; wire frames cannot configure them.
 * Profile ownership is only filesystem integrity, never authorization. The parent MUST enforce
 * its actual session/current configuration policy, close/abort this pipe immediately on
 * revocation, and protect transport confidentiality/integrity (including encryption remotely).
 * There is no HTTP/browser listener, credential delivery, mutation or execution dispatcher.
 * EOF is connection revocation, not a request to drain queued requests. A producer must leave
 * stdin open while consuming replies. Every delivery is sequential and awaits real output
 * backpressure; one stalled frame ends the connection rather than building a write queue.
 *
 * Owns the profile and stream locks until settlement. A bounded independent input pump is
 * necessary to observe EOF even during authorization/output waits. It rejects excess pending
 * input rather than buffering an unbounded producer. Shared readLines/readJsonl helpers cannot
 * enforce a byte ceiling before decoding/parsing or reject an unterminated final frame.
 */
export async function serveGraphWireStdio(options: GraphWireStdioOptions): Promise<void> {
	// Capture trusted launch configuration before any asynchronous authorization or stream work.
	options = { ...options, runIds: [...options.runIds] };
	const sourceId = options.sourceId;
	const runIds = new Set(options.runIds);
	const pollIntervalMs = options.pollIntervalMs ?? 1000;
	const writeTimeoutMs = options.writeTimeoutMs ?? 1000;
	if (
		!options.root ||
		!identity(sourceId) ||
		!options.runIds.length ||
		options.runIds.length > 1000 ||
		runIds.size !== options.runIds.length ||
		!options.runIds.every(identity) ||
		![pollIntervalMs, writeTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 5000)
	)
		throw unavailable();

	const lifetime = new AbortController();
	const signal = lifetime.signal;
	let profile: GraphReadProfile | undefined;
	let bridge: GraphWireReadBridge<null> | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
	let failed = false;
	let outputStalled = false;
	let inputTask: Promise<void> | undefined;
	let wake = Promise.withResolvers<void>();
	const queue: { value: unknown; bytes: number }[] = [];
	let pendingBytes = 0;
	const stop = (): void => {
		bridge?.invalidate("revoked");
		lifetime.abort();
		wake.resolve();
	};
	const fail = (): void => {
		failed = true;
		stop();
	};
	const onParentAbort = (): void => stop();
	options.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		if (options.signal?.aborted) stop();
		signal.throwIfAborted();
		profile = new GraphReadProfile(options.root);
		const openedProfile = profile;
		const ledger = new GraphWireLedger(profile.db, { readOnly: true });
		const extensions = options.executionRecords === true ? [GRAPH_WIRE_EXECUTION_EXTENSION] : [];
		const generation = crypto.randomUUID();
		const checkAccess = async (): Promise<void> => {
			signal.throwIfAborted();
			openedProfile.assertAccess();
			await untilAborted(signal, async () => options.assertAuthorized?.(signal));
			signal.throwIfAborted();
			openedProfile.assertAccess();
		};
		bridge = new GraphWireReadBridge(ledger, {
			principal: null,
			catalog: async () => {
				await checkAccess();
				return {
					generation,
					sources: [
						{
							source_id: sourceId,
							kind: "graph",
							profile_id: null,
							bot_id: null,
							capabilities: ["graph.runs.v1", "graph.history.v1", ...extensions],
						},
					],
				};
			},
			authorize: async (_principal, scope) => {
				await checkAccess();
				return scope.source_ids.length === 1 &&
					scope.source_ids[0] === sourceId &&
					scope.graph_run_id !== null &&
					runIds.has(scope.graph_run_id)
					? { generation }
					: null;
			},
			maxSubscriptions: 16,
			maxPageTokens: 64,
			pageSize: 32,
			extensions,
			consultationDetails: extensions.length ? new GraphWireConsultationDetailReader(profile.db) : undefined,
			artifactContents: extensions.length ? options.artifactContents : undefined,
		});
		reader = options.input.getReader();
		writer = options.output.getWriter();
		const inputReader = reader;
		const outputWriter = writer;
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const encoder = new TextEncoder();
		const readInput = async (): Promise<void> => {
			const line = new Uint8Array(MAX_REQUEST_BYTES);
			let used = 0;
			try {
				while (!signal.aborted) {
					const result = await untilAborted(signal, inputReader.read());
					if (result.done) {
						if (used) fail();
						else stop();
						return;
					}
					const chunk = result.value;
					if (chunk.byteLength > MAX_PENDING_BYTES + MAX_REQUEST_BYTES + MAX_PENDING_REQUESTS) throw unavailable();
					let offset = 0;
					while (offset < chunk.byteLength) {
						const end = chunk.indexOf(10, offset);
						const boundary = end === -1 ? chunk.byteLength : end;
						const count = boundary - offset;
						if (used + count > MAX_REQUEST_BYTES) throw unavailable();
						line.set(chunk.subarray(offset, boundary), used);
						used += count;
						if (end === -1) break;
						if (queue.length >= MAX_PENDING_REQUESTS || pendingBytes + used > MAX_PENDING_BYTES)
							throw unavailable();
						// Byte bound and fatal UTF-8 validation both precede JSON.parse.
						const value: unknown = JSON.parse(decoder.decode(line.subarray(0, used)));
						queue.push({ value, bytes: used });
						pendingBytes += used;
						used = 0;
						wake.resolve();
						offset = end + 1;
					}
				}
			} catch {
				if (!signal.aborted) fail();
			}
		};
		inputTask = readInput();
		const writeFrame = async (frame: GraphWireReadFrame): Promise<void> => {
			await checkAccess();
			const json = JSON.stringify(frame);
			// UTF-8 bytes are at least UTF-16 code units; avoid an avoidable giant byte allocation.
			if (json.length + 1 > MAX_FRAME_BYTES) throw unavailable();
			const bytes = encoder.encode(`${json}\n`);
			if (bytes.byteLength > MAX_FRAME_BYTES) throw unavailable();
			try {
				await withTimeout(outputWriter.write(bytes), writeTimeoutMs, unavailable(), signal);
			} catch {
				outputStalled = true;
				throw unavailable();
			}
			await checkAccess();
		};
		let pollDeadline = performance.now() + 5000;
		const deliver = async (frames: AsyncGenerator<GraphWireReadFrame>): Promise<void> => {
			// Sequential delivery cannot overlap bridge.poll(). Close rather than exceeding its
			// maximum cadence if a long authorization/snapshot or trickle consumer blocks polling.
			const cadenceTimer = setTimeout(fail, Math.max(1, pollDeadline - performance.now()));
			try {
				while (!signal.aborted) {
					const result = await untilAborted(signal, frames.next());
					if (result.done) return;
					await writeFrame(result.value);
					if (result.value.type === "error" && result.value.error.code === "scope_denied") {
						stop();
						return;
					}
				}
			} finally {
				clearTimeout(cadenceTimer);
				// Do not await an external authorization callback that ignores cancellation.
				void frames.return(undefined).catch(() => {});
			}
		};
		let nextPoll = performance.now() + pollIntervalMs;
		while (!signal.aborted) {
			if (performance.now() >= nextPoll) {
				await deliver(bridge.poll());
				nextPoll = performance.now() + pollIntervalMs;
				pollDeadline = performance.now() + 5000;
				continue;
			}
			const request = queue.shift();
			if (request) {
				pendingBytes -= request.bytes;
				await deliver(bridge.handle(request.value));
				continue;
			}
			wake = Promise.withResolvers<void>();
			try {
				await withTimeout(wake.promise, Math.max(1, nextPoll - performance.now()), new PollDue(), signal);
			} catch (error) {
				if (!(error instanceof PollDue)) throw error;
			}
		}
	} catch {
		if (!signal.aborted) failed = true;
	} finally {
		stop();
		try {
			profile?.close();
		} catch {
			failed = true;
		}
		options.signal?.removeEventListener("abort", onParentAbort);
		// A malformed input gets only a generic protocol error, never input, argv or exceptions.
		// Never queue an error behind a stalled write. Teardown must not wait for the peer.
		if (failed && writer && !outputStalled) {
			try {
				const error = {
					protocol: GRAPH_WIRE_PROTOCOL,
					type: "error",
					in_reply_to: null,
					error: {
						code: "protocol_error",
						message: "Graph wire observation unavailable",
						retryable: false,
						details: null,
						reset_required: false,
					},
				};
				await withTimeout(
					writer.write(new TextEncoder().encode(`${JSON.stringify(error)}\n`)),
					writeTimeoutMs,
					unavailable(),
					options.signal,
				);
			} catch {}
		}
		if (reader) {
			void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		if (writer) {
			void writer.abort().catch(() => {});
			writer.releaseLock();
		}
		await inputTask;
	}
	if (failed) throw unavailable();
}

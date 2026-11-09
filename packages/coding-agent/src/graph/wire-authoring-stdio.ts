import type { ReadableStreamDefaultReader, WritableStreamDefaultWriter } from "node:stream/web";
import { untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import { GraphWireAuthoringBridge, type GraphWireAuthoringOptions } from "./wire-authoring";

/** JSON escaping can expand the shared authoring validator's 1 MiB aggregate string budget.
 * Output uses the same 2 MiB ceiling as the fixed-Run observer. Limits include framing only
 * for output; request/pending byte counts exclude the newline delimiter. */
export const GRAPH_WIRE_AUTHORING_STDIO_LIMITS = Object.freeze({
	maxRequestBytes: 8 * 1024 * 1024,
	maxFrameBytes: 2 * 1024 * 1024,
	maxPendingBytes: 8 * 1024 * 1024,
	maxPendingRequests: 16,
});

export interface GraphWireAuthoringStdioOptions extends GraphWireAuthoringOptions {
	input: ReadableStream<Uint8Array>;
	output: WritableStream<Uint8Array>;
	/** Trusted parent revocation. The embedding must abort immediately on connection revocation. */
	signal?: AbortSignal;
	/** 1..5000ms, including writable readiness and the actual write. Defaults to 1000ms. */
	writeTimeoutMs?: number;
}
const unavailable = (): Error => new Error("Graph wire authoring transport unavailable");

/** Private trusted-parent JSONL transport, not an authenticator, listener or CLI grant issuer.
 * Captures the already-authenticated principal, bindings and negotiated extensions before any
 * await. Owns stream locks but NOT the supplied services; durable intent/recovery belongs to
 * the bridge. Requests and writes are serialized, without an automatic mutation retry.
 *
 * EOF/abort revokes the connection immediately, discarding queued requests, not draining them.
 * EOF with an unfinished reply is a transport failure; parent abort remains cancellation.
 * Keep input open while reading replies. Invalid UTF-8/JSON, unterminated frames, resource
 * overflow and stalled output reject with a generic error without echoing input or protected
 * bytes. Bridge errors remain correlated wire frames.
 *
 * After backpressure, current authorization is rechecked synchronously immediately before
 * write(). The trusted sink must deliver or discard each write promptly and honor parent
 * revocation; bytes already handed to a sink cannot be recalled by a Web Streams driver.
 */
export async function serveGraphWireAuthoringStdio(options: GraphWireAuthoringStdioOptions): Promise<void> {
	const bridge = new GraphWireAuthoringBridge(options);
	const input = options.input;
	const output = options.output;
	const parentSignal = options.signal;
	const writeTimeoutMs = options.writeTimeoutMs ?? 1000;
	if (!Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1 || writeTimeoutMs > 5000) throw unavailable();
	const limits = GRAPH_WIRE_AUTHORING_STDIO_LIMITS;
	const lifetime = new AbortController();
	const signal = lifetime.signal;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
	let inputTask: Promise<void> | undefined;
	let failed = false;
	let deliveryPending = false;
	let wake = Promise.withResolvers<void>();
	const queue: { value: unknown; bytes: number }[] = [];
	let pendingBytes = 0;
	const stop = (): void => {
		lifetime.abort();
		queue.length = 0;
		pendingBytes = 0;
		wake.resolve();
	};
	const fail = (): void => {
		failed = true;
		stop();
	};
	parentSignal?.addEventListener("abort", stop, { once: true });
	try {
		if (parentSignal?.aborted) stop();
		signal.throwIfAborted();
		reader = input.getReader();
		writer = output.getWriter();
		const inputReader = reader;
		const outputWriter = writer;
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const encoder = new TextEncoder();
		const readInput = async (): Promise<void> => {
			// Grow only when needed, never exceeding the byte bound before decode/parse.
			let line = new Uint8Array(4096);
			let used = 0;
			try {
				while (!signal.aborted) {
					const result = await untilAborted(signal, inputReader.read());
					if (result.done) {
						if (used || deliveryPending) fail();
						else stop();
						return;
					}
					const chunk = result.value;
					if (chunk.byteLength > limits.maxPendingBytes + limits.maxRequestBytes + limits.maxPendingRequests)
						throw unavailable();
					let offset = 0;
					while (offset < chunk.byteLength) {
						const end = chunk.indexOf(10, offset);
						const boundary = end === -1 ? chunk.byteLength : end;
						const count = boundary - offset;
						const size = used + count;
						if (size > limits.maxRequestBytes || pendingBytes + size > limits.maxPendingBytes)
							throw unavailable();
						if (size > line.byteLength) {
							const grown = new Uint8Array(
								Math.min(limits.maxRequestBytes, Math.max(size, line.byteLength * 2)),
							);
							grown.set(line.subarray(0, used));
							line = grown;
						}
						line.set(chunk.subarray(offset, boundary), used);
						used = size;
						if (end === -1) break;
						if (queue.length >= limits.maxPendingRequests) throw unavailable();
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
		while (!signal.aborted) {
			const request = queue.shift();
			if (!request) {
				wake = Promise.withResolvers<void>();
				await untilAborted(signal, wake.promise);
				continue;
			}
			pendingBytes -= request.bytes;
			deliveryPending = true;
			const frame = await bridge.handle(request.value);
			const json = JSON.stringify(frame);
			if (json.length + 1 > limits.maxFrameBytes) throw unavailable();
			const bytes = encoder.encode(`${json}\n`);
			if (bytes.byteLength > limits.maxFrameBytes) throw unavailable();
			await withTimeout(
				(async () => {
					await untilAborted(signal, outputWriter.ready);
					signal.throwIfAborted();
					bridge.assertAuthorizedForDelivery(frame);
					signal.throwIfAborted();
					await outputWriter.write(bytes);
					deliveryPending = false;
				})(),
				writeTimeoutMs,
				unavailable(),
				signal,
			);
			signal.throwIfAborted();
			bridge.assertAuthorizedForDelivery(frame);
			if (frame.type === "error" && frame.error.code === "scope_denied") stop();
		}
	} catch {
		if (!signal.aborted) failed = true;
	} finally {
		stop();
		parentSignal?.removeEventListener("abort", stop);
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

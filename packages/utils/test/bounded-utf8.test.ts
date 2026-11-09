import { expect, it } from "bun:test";
import { readBoundedUtf8, TextReadError } from "../src/stream";

it("preserves BOM, CRLF and multibyte characters split across chunks at the exact byte limit", async () => {
	const content = "\uFEFF方案\r\n";
	const bytes = new TextEncoder().encode(content);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
			controller.close();
		},
	});
	expect(await readBoundedUtf8(stream, bytes.byteLength)).toBe(content);
});

it("cancels overflowing input without consuming its remainder", async () => {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(Uint8Array.of(97, 98));
		},
		cancel() {
			cancelled = true;
		},
	});
	await expect(readBoundedUtf8(stream, 1)).rejects.toMatchObject({ code: "too_large" });
	expect(cancelled).toBe(true);
});

it("rejects malformed and truncated UTF-8 instead of substituting replacement characters", async () => {
	for (const bytes of [Uint8Array.of(0xff), Uint8Array.of(0xe4, 0xb8)]) {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		});
		await expect(readBoundedUtf8(stream, 10)).rejects.toBeInstanceOf(TextReadError);
	}
});

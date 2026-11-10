import * as fs from "node:fs";
import * as path from "node:path";
import type { GraphDeliveryEnvelope } from "./delivery";
import { assertConsumerName } from "./notification-consumer";
import { GraphObservationError } from "./observation";

export const GRAPH_INBOX_FORMAT = "omp.graph/inbox/v1" as const;

/** Upper bound for one consumer's inbox file. A full inbox fails instead of dropping records. */
export const GRAPH_INBOX_MAX_BYTES = 16 * 1024 * 1024;

/** Notifications per inbox page, matching `notifications` and `deliver`. */
export const GRAPH_INBOX_MAX_PAGE = 200;

export interface GraphLocalInboxReadOptions {
	/** Line index to resume from; 0 replays the inbox from its first record. */
	since?: number;
	/** Records per page. Default 50, 1..200. */
	limit?: number;
}

export interface GraphLocalInboxPage {
	format: typeof GRAPH_INBOX_FORMAT;
	consumer: string;
	as_of: string;
	/** Line index of the next unconsumed record. */
	cursor: number;
	records: GraphDeliveryEnvelope[];
}

/**
 * The built-in delivery sink: one append-only JSONL file per consumer, under `<root>/inbox/`.
 * It exists so a local session can receive notifications without standing up an external
 * command. Writing here never touches a Run, and a failed append never acknowledges anything —
 * the delivery cursor stays put, so the record is retried.
 *
 * Delivery stays at-least-once: a crash between the append and the cursor advance replays the
 * line, and readers MUST dedupe by `notification.id`.
 */
export class GraphLocalInbox {
	readonly consumer: string;
	readonly #file: string;
	readonly #maxBytes: number;

	constructor(root: string, consumer: string, options: { maxBytes?: number } = {}) {
		this.consumer = assertConsumerName(consumer);
		const maxBytes = options.maxBytes ?? GRAPH_INBOX_MAX_BYTES;
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
			throw new GraphObservationError("invalid_input", "Inbox byte limit must be a positive integer");
		this.#maxBytes = maxBytes;
		this.#file = path.join(path.resolve(root), "inbox", `${consumer}.jsonl`);
	}

	/** Append one envelope as a single JSON line, then fsync before reporting success. */
	append(envelope: GraphDeliveryEnvelope): void {
		if (envelope.consumer !== this.consumer)
			throw new GraphObservationError(
				"invalid_input",
				`Envelope is addressed to ${envelope.consumer}, not ${this.consumer}`,
			);
		const line = `${JSON.stringify(envelope)}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		const size = this.#size();
		if (size + bytes > this.#maxBytes)
			throw new GraphObservationError(
				"resource_limit",
				`Inbox ${this.#file} would exceed ${this.#maxBytes} bytes; consume and truncate it before delivering more`,
			);
		fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		const fd = fs.openSync(this.#file, "a", 0o600);
		try {
			// Enforce the mode on an existing file too: an inbox may reveal Run titles and ids.
			fs.fchmodSync(fd, 0o600);
			fs.writeSync(fd, line);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}

	/** Read a page of envelopes and report the line index to resume from. */
	read(options: GraphLocalInboxReadOptions = {}): GraphLocalInboxPage {
		const since = options.since ?? 0;
		if (!Number.isSafeInteger(since) || since < 0)
			throw new GraphObservationError("invalid_input", "Inbox cursor must be a non-negative integer");
		const limit = options.limit ?? 50;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > GRAPH_INBOX_MAX_PAGE)
			throw new GraphObservationError("invalid_input", `Inbox page size must be 1..${GRAPH_INBOX_MAX_PAGE}`);

		const records = this.#records();
		// A cursor past the end would skip records appended later, so clamp it to the file length.
		const start = Math.min(since, records.length);
		const page = records.slice(start, start + limit);
		return {
			format: GRAPH_INBOX_FORMAT,
			consumer: this.consumer,
			as_of: new Date().toISOString(),
			cursor: start + page.length,
			records: page,
		};
	}

	#size(): number {
		try {
			return fs.statSync(this.#file).size;
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return 0;
			throw error;
		}
	}

	#records(): GraphDeliveryEnvelope[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.#file, "utf8");
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return [];
			throw error;
		}
		const lines = raw.split("\n");
		// A trailing newline leaves one empty tail element; any other empty line means damage.
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines.map((line, index) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new GraphObservationError(
					"invalid_input",
					`Inbox ${this.#file} line ${index + 1} is not valid JSON; repair or remove it before consuming`,
				);
			}
			const record = parsed as Partial<GraphDeliveryEnvelope> | null;
			if (
				!record ||
				typeof record !== "object" ||
				typeof record.notification !== "object" ||
				record.notification === null ||
				typeof record.notification.id !== "string"
			)
				throw new GraphObservationError(
					"invalid_input",
					`Inbox ${this.#file} line ${index + 1} is not a delivery envelope`,
				);
			return record as GraphDeliveryEnvelope;
		});
	}
}

import * as fs from "node:fs";
import * as path from "node:path";
import { GraphObservationError } from "./observation";

const CONSUMER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Shared rule for durable consumer names: cursors and local inboxes address the same consumer. */
export function assertConsumerName(consumer: string): string {
	if (!CONSUMER_NAME.test(consumer))
		throw new GraphObservationError(
			"invalid_input",
			"Consumer name must be 1..64 characters of lowercase letters, digits, dot, underscore or hyphen",
		);
	return consumer;
}

/**
 * A durable read position for one notification consumer (a dispatcher session, wherdr, an
 * external integrator). The cursor only decides where that consumer resumes; reading never
 * changes a Run, and advancing it never acknowledges delivery on another consumer's behalf.
 */
export class GraphNotificationConsumerCursor {
	readonly consumer: string;
	readonly #file: string;

	constructor(root: string, consumer: string) {
		this.consumer = assertConsumerName(consumer);
		this.#file = path.join(path.resolve(root), "consumers", `${consumer}.json`);
	}

	read(): number {
		let raw: string;
		try {
			raw = fs.readFileSync(this.#file, "utf8");
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return 0;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new GraphObservationError(
				"invalid_input",
				`Consumer cursor ${this.#file} is not valid JSON; repair or remove it before consuming`,
			);
		}
		const cursor = (parsed as { cursor?: unknown } | null)?.cursor;
		if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)
			throw new GraphObservationError(
				"invalid_input",
				`Consumer cursor ${this.#file} has no non-negative integer cursor`,
			);
		return cursor;
	}

	/** Cursors only move forward: a replayed page cannot rewind a consumer. */
	advance(cursor: number): number {
		if (!Number.isInteger(cursor) || cursor < 0)
			throw new GraphObservationError("invalid_input", "Cursor must be a non-negative integer");
		const current = this.read();
		if (cursor <= current) return current;
		const directory = path.dirname(this.#file);
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporary = `${this.#file}.${process.pid}.${crypto.randomUUID()}.tmp`;
		fs.writeFileSync(
			temporary,
			`${JSON.stringify({ consumer: this.consumer, cursor, updated_at: new Date().toISOString() })}\n`,
			{
				mode: 0o600,
			},
		);
		fs.renameSync(temporary, this.#file);
		return cursor;
	}
}

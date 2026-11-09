import type { GraphNotification } from "@oh-my-pi/pi-wire/graph";
import { GraphObservation, GraphObservationError } from "./observation";
import { GraphNotificationConsumerCursor } from "./notification-consumer";
import { GRAPH_CLI_LIMITS } from "./limits";

export const GRAPH_DELIVERY_FORMAT = "omp.graph/delivery/v1" as const;

/** One notification as handed to a delivery command on stdin. */
export interface GraphDeliveryEnvelope {
	format: typeof GRAPH_DELIVERY_FORMAT;
	consumer: string;
	delivered_at: string;
	notification: GraphNotification;
}

export interface GraphDeliveryFailure {
	id: string;
	exit_code: number | null;
	timed_out: boolean;
}

export interface GraphDeliveryResult {
	format: typeof GRAPH_DELIVERY_FORMAT;
	consumer: string;
	/** Consumer cursor after the successful deliveries in this call. */
	cursor: number;
	delivered: string[];
	/** Present when a command failed; the cursor did not move past that page. */
	failure: GraphDeliveryFailure | null;
}

export interface GraphDeliveryOptions {
	root: string;
	consumer: string;
	/** Operator-supplied argv, never derived from Graph content. Receives one envelope per call on stdin. */
	command?: string[];
	/** Per-delivery deadline. Default 30000, 1..600000. */
	timeoutMs?: number;
	/** Notifications per page. Default 50, 1..200. */
	limit?: number;
	/** Keep polling until `followTimeoutMs` elapses. */
	follow?: boolean;
	/** Default 60000, 1..600000. */
	followTimeoutMs?: number;
	/** Per-Run authorization. Unauthorized notifications are skipped, as with `notifications`. */
	authorize(runId: string): boolean | Promise<boolean>;
	/** Injectable execution seam; resolves the command's exit code. */
	deliver?(envelope: GraphDeliveryEnvelope): Promise<{ exitCode: number | null; timedOut: boolean }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FOLLOW_MS = 60_000;

function bounded(value: number | undefined, fallback: number, max: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1 || value > max)
		throw new GraphObservationError("invalid_input", `${name} must be an integer in 1..${max}`);
	return value;
}

/**
 * Hand each authorized notification to one operator command, advancing a durable consumer cursor
 * only after the command exits 0. Delivery is at-least-once: a failure or a crash can repeat an
 * already-delivered record, so the command MUST dedupe by notification id. Nothing here changes a
 * Run, and a failed delivery is not a Run failure.
 */
export async function deliverGraphNotifications(options: GraphDeliveryOptions): Promise<GraphDeliveryResult> {
	const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 600_000, "delivery timeout");
	const limit = bounded(options.limit, 50, 200, "delivery page size");
	const followTimeoutMs = bounded(options.followTimeoutMs, DEFAULT_FOLLOW_MS, 600_000, "follow timeout");
	if (!options.deliver && (options.command ?? []).length === 0)
		throw new GraphObservationError("invalid_input", "A delivery command is required");
	const consumer = new GraphNotificationConsumerCursor(options.root, options.consumer);
	const command = options.command;
	const run = options.deliver ?? (envelope => spawnDelivery(command ?? [], envelope, timeoutMs));

	const delivered: string[] = [];
	let cursor = consumer.read();
	const deadline = Date.now() + (options.follow ? followTimeoutMs : 0);
	const observation = new GraphObservation(options.root, GRAPH_CLI_LIMITS);
	try {
		for (;;) {
			const page = observation.notifications({ since: cursor, limit });
			const visible: GraphNotification[] = [];
			for (const notification of page.notifications)
				if ((await options.authorize(notification.run_id)) === true) visible.push(notification);
			for (const notification of visible) {
				const envelope: GraphDeliveryEnvelope = {
					format: GRAPH_DELIVERY_FORMAT,
					consumer: consumer.consumer,
					delivered_at: new Date().toISOString(),
					notification,
				};
				const outcome = await run(envelope);
				if (outcome.exitCode !== 0)
					return {
						format: GRAPH_DELIVERY_FORMAT,
						consumer: consumer.consumer,
						cursor,
						delivered,
						failure: { id: notification.id, exit_code: outcome.exitCode, timed_out: outcome.timedOut },
					};
				delivered.push(notification.id);
			}
			// Advance only after every authorized record in this page was handed over successfully.
			// Unauthorized records are skipped here exactly as `notifications` skips them.
			if (page.notifications.length > 0) {
				cursor = consumer.advance(page.cursor);
			}
			if (!options.follow || delivered.length > 0 || Date.now() >= deadline)
				return { format: GRAPH_DELIVERY_FORMAT, consumer: consumer.consumer, cursor, delivered, failure: null };
			await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
		}
	} finally {
		observation.close();
	}
}

async function spawnDelivery(
	command: string[],
	envelope: GraphDeliveryEnvelope,
	timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
	const proc = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
	proc.stdin.write(`${JSON.stringify(envelope)}\n`);
	await proc.stdin.end();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		return { exitCode: await proc.exited, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

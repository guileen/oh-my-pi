import type { GraphRunState } from "@oh-my-pi/pi-wire/graph";

/** States that end a foreground execution. A hold parks the executor instead of ending it. */
const TERMINAL = new Set<GraphRunState>(["succeeded", "failed", "cancelled"]);

export interface ForegroundPauseObservation {
	/** `held` when this observation parked the executor, `resumed` when it lifted a park. */
	transition: "held" | "resumed" | null;
	/** Milliseconds still available to the foreground execution. */
	remaining: number;
}

/**
 * Deadline bookkeeping for a foreground Graph execution whose Run can be held by an operator.
 *
 * A hold pauses scheduling; it must not end the executor, because the Run would then be
 * `running` with nothing left to dispatch it. Held time is also not execution time, so it does
 * not consume the foreground deadline.
 */
export class ForegroundPause {
	#deadline: number;
	#heldAt: number | undefined;

	constructor(deadline: number, heldAt?: number) {
		this.#deadline = deadline;
		this.#heldAt = heldAt;
	}

	get held(): boolean {
		return this.#heldAt !== undefined;
	}

	get deadline(): number {
		return this.#deadline;
	}

	/** Only a terminal Run ends foreground execution. */
	static terminal(state: GraphRunState): boolean {
		return TERMINAL.has(state);
	}

	/**
	 * Work that is already admitted may still settle: a hold never converts a started attempt
	 * into a failure. This is the gate for an attempt's own model turns and tools.
	 */
	static settlable(state: GraphRunState | undefined): boolean {
		return state !== undefined && !TERMINAL.has(state) && state !== "cancelling";
	}

	/**
	 * Beginning a new attempt requires live scheduling. A held Run parks its executor until an
	 * operator resumes it, so admission — not settlement — is what a hold blocks.
	 */
	static dispatchable(state: GraphRunState | undefined): boolean {
		return state === "queued" || state === "running";
	}

	observe(state: GraphRunState, now: number): ForegroundPauseObservation {
		if (state === "held") {
			if (this.#heldAt === undefined) {
				this.#heldAt = now;
				return { transition: "held", remaining: Number.POSITIVE_INFINITY };
			}
			return { transition: null, remaining: Number.POSITIVE_INFINITY };
		}
		if (this.#heldAt !== undefined) {
			this.#deadline += now - this.#heldAt;
			this.#heldAt = undefined;
			return { transition: "resumed", remaining: this.remaining(now) };
		}
		return { transition: null, remaining: this.remaining(now) };
	}

	remaining(now: number): number {
		return this.#heldAt === undefined ? Math.max(0, this.#deadline - now) : Number.POSITIVE_INFINITY;
	}
}

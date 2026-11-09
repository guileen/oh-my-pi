import { GraphObservationBridge, GraphObservationBridgeError, type GraphObservationView } from "./observation-bridge";
import type { GraphCursor } from "@oh-my-pi/pi-wire/graph";

/**
 * Client-driven, read-only local projection polling. Each non-null result replaces
 * the previous view; intermediate states can be coalesced. This is not a wire
 * subscription, a historical reconstruction, or a negotiated capability.
 */
export class GraphLiveObservation<Principal> {
	#cursor: GraphCursor | null = null;
	#polling = false;

	constructor(
		private readonly bridge: GraphObservationBridge<Principal>,
		private readonly principal: Principal,
		private readonly runId: string,
	) {}

	async poll(): Promise<GraphObservationView | null> {
		if (this.#polling) throw new GraphObservationBridgeError("unsupported");
		this.#polling = true;
		try {
			const view = await this.bridge.view(this.principal, this.runId);
			// The embedding host may retain the returned view. Keep the committed
			// boundary private while later authorization checks suspend this poll.
			const cursor = { ...view.cursor };
			const previous = this.#cursor;
			if (previous) {
				if (previous.journal_id !== cursor.journal_id || BigInt(previous.seq) > BigInt(cursor.seq))
					throw new GraphObservationBridgeError("unsupported");
				if (previous.seq === cursor.seq) return null;
				// Verify the entire interval is retained and supported before advancing.
				// Journal facts are metadata, not execution-record replacements.
				let after = previous;
				let more = true;
				while (more) {
					const page = await this.bridge.events(this.principal, this.runId, {
						after: { ...after },
						watermark: { ...cursor },
						limit: 100,
					});
					after = page.cursor;
					more = page.next_cursor !== null;
				}
				// Authorization may have changed while paging; do not disclose the view
				// without one last principal-aware check.
				const current = await this.bridge.snapshot(this.principal, this.runId);
				if (current.cursor.journal_id !== cursor.journal_id || BigInt(current.cursor.seq) < BigInt(cursor.seq))
					throw new GraphObservationBridgeError("unsupported");
			}
			this.#cursor = { ...cursor };
			return { ...view, cursor };
		} finally {
			this.#polling = false;
		}
	}
}

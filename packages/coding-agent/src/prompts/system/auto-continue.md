Resume the latest user request, not the compaction discussion. Newer instructions and live state override the checkpoint.

- You MUST preserve every outstanding user goal and required verification, not only the last milestone.
- Use the supplied canonical TODOs: continue the first actionable `in_progress` item, otherwise the first actionable `pending` item. Missing TODO coverage? Reconcile it with the request; an empty list alone does not prove completion.
- Use the checkpoint's `nextAction` when it still matches that work. Proceed with the concrete operation, not a recap or another plan. Milestone complete? Update TODOs and continue to the next actionable item.
- Reuse recorded decisions, evidence and completed work. Load tools and read exact file sections only when the next operation requires them; compaction alone is not a reason to rediscover the repository or rerun checks. Refresh stale edit anchors or facts affected by intervening changes.
- Await existing background deliveries rather than restarting jobs; work on independent TODOs meanwhile. Only external waits remain? Use the available wait mechanism; only user-resolvable blockers remain? Report them.
- You MUST finish all requested work and verification before yielding as complete. No work remains? Say so briefly; NEVER invent work.

QA context checkpoint warning
Cycle: {{cycleId}}
Remaining work headroom: approximately {{headroomTokens}} tokens before the {{hardTokens}}-token work limit.

Choose an appropriate nearby milestone, finish only the bounded work needed to reach it, then call `new_context` as the sole tool call in that response. Provide this exact `cycleId`, a concise factual `summary`, and `disposition`: `continue` for reachable unfinished work, `complete` when the user's task is finished, or `blocked` when a concrete prerequisite prevents progress. For `continue`, include a nonempty `nextAction`; for the other dispositions omit `nextAction`. Keep summary and nextAction together within 4096 tokens.

Preserve the user's goal and constraints, decisions, completed changes, evidence paths, checks actually exercised, unresolved work and blockers. Distinguish observed facts from inference. Record running job identifiers and pending deliveries so continuation observes them instead of repeating work. Keep credentials out of the checkpoint. Retain task scope and permissions; context rollover does not authorize new work. An accepted checkpoint acknowledges durable recording only, not successful context compaction. Do not call `new_context` repeatedly after acceptance or use a final answer as a substitute for the checkpoint.

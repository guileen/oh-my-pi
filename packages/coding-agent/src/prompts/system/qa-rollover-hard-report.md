QA work limit reached
Cycle: {{cycleId}}
Work limit: {{hardTokens}} tokens. Remaining ordinary-work headroom: {{headroomTokens}} tokens.

Ordinary work is paused. Use this reserved reporting response only to call `new_context`, as the sole tool call. Do not start reads, writes, commands, research or other tools; already-running tools settle through the runtime. Supply this exact `cycleId`, a concise factual `summary`, and `disposition`: `continue` for reachable unfinished work, `complete` only when the user's task is finished, or `blocked` for a concrete missing prerequisite. `continue` requires a nonempty `nextAction`; omit it for `complete` and `blocked`. Summary and nextAction together must fit within 4096 tokens.

Record the user's goal and constraints, completed work, decisions, evidence and artifact paths, verification actually performed, unfinished work, blockers, running job identifiers and pending deliveries. State the next actionable step for continuation, preserving existing permissions and avoiding duplicate work. Keep credentials out. Do not claim completion merely because the work limit was reached. The runtime permits one reserved report attempt and may pause safely if recording or compaction cannot complete; acceptance confirms durable recording, not a successful rewrite. Finish with the checkpoint call rather than a final answer or another tool batch.

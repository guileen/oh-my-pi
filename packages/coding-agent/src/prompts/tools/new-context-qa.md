Record a safe checkpoint for the current QA rollover cycle. You MUST use this tool only after receiving a cycle hint, warning, or hard-stop report request, as the sole tool call in your response.

Input: `{checkpoint: {cycleId, summary, disposition, nextAction?}}`.

- `cycleId`: the exact identifier from the current hint, warning, or report request.
- `summary`: nonempty saved changes, decisions, observed evidence/results and locations, unverified claims, unfinished work, and blockers. No required headings.
- `disposition: "continue"`: ANY requested action remains, including unrun verification; `nextAction` MUST name the next concrete operation.
- `disposition: "complete"`: the ENTIRE current user task is finished, not merely this milestone or checkpoint. You MUST omit `nextAction`. A summary mentioning remaining work MUST use `continue`, never `complete`.
- `disposition: "blocked"`: work cannot proceed; you MUST describe the blocker in `summary` and omit `nextAction`.
- Summary plus next action MUST fit 4,096 tokens and the remaining headroom. You NEVER truncate away necessary evidence to conceal an oversized checkpoint.

Context notices are advisory: a hint (checkpoint MAY denoise low-value context), then a warning and a final warning; you choose the milestone, with no request-count deadline. Only near the model's context limit MUST ordinary work stop; use the reserved report-only response. Model-capacity safety MAY force an earlier stop.
Acceptance confirms durable recording, not successful compaction. You MUST stop ordinary work after acceptance; the session owns any continuation. An identical same-cycle retry returns the original entry; changed content conflicts. The hard-stop report permits only one provider attempt; rejection NEVER restores ordinary work. You NEVER use `{}` in QA mode.

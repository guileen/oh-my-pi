<critical>
Context is large. You SHOULD choose an appropriate nearby milestone for a QA checkpoint.
You MAY continue ordinary work below {{hardTokens}} input-context tokens; there is no request-count deadline.
</critical>

QA rollover cycle: `{{cycleId}}`.
Remaining ordinary-work context headroom: {{headroomTokens}} tokens.

- You SHOULD choose the milestone based on the task, not an arbitrary number of requests.
- You MUST preserve saved changes, decisions, evidence locations/results, uncertainty, unfinished work, and blockers in `checkpoint.summary`.
- You MUST use `checkpoint.cycleId: "{{cycleId}}"`.
- Any requested action remains, including verification? You MUST set `disposition: "continue"` and a concrete `nextAction`.
- The ENTIRE current user task is finished? You MUST set `disposition: "complete"` and omit `nextAction`. Finishing this milestone is NOT task completion.
- User approval or another blocker prevents work? You MUST set `disposition: "blocked"`, describe the blocker in `summary`, and omit `nextAction`.
- You MUST keep summary plus next action within 4,096 tokens.
- Failed checks are valid evidence; you MUST identify unverified claims.
- You NEED NOT wait for background jobs or passing checks to checkpoint.

<critical>
At your chosen milestone, you MUST submit `new_context({checkpoint})` as the sole tool call in its response.
At the ordinary-work limit you MUST stop work and report saved work, incomplete work, and the next action; model-capacity safety MAY force this earlier.
Acceptance confirms durable recording, not successful compaction. You MUST stop ordinary work after acceptance and let the session own continuation.
</critical>

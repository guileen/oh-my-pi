<critical>
Context is large. You SHOULD checkpoint at the next safe milestone rather than fill the remaining context.
You MAY continue ordinary work below {{hardTokens}} input-context tokens; there is no request-count deadline.
</critical>

QA rollover cycle: `{{cycleId}}`.
Remaining ordinary-work context headroom: {{headroomTokens}} tokens.

- You SHOULD choose the milestone based on the task, not an arbitrary number of requests.
- You MUST preserve all outstanding user goals, saved changes, decisions, evidence locations/results, uncertainty, unfinished verification, and blockers in `checkpoint.summary`.
- Canonical TODOs and job state are preserved separately. Record only missing continuation context; NEVER copy whole TODO lists, transcripts, file contents, or prior summaries. Preserve still-relevant facts from prior checkpoints; this checkpoint must stand on its own.
- You MUST use `checkpoint.cycleId: "{{cycleId}}"`.
- Any actionable work or verification remains? You MUST set `disposition: "continue"` and `nextAction` naming the next concrete operation, its target, and completion check, aligned with the next actionable TODO.
- The ENTIRE current user task is finished? You MUST set `disposition: "complete"` and omit `nextAction`. Finishing this milestone is NOT task completion.
- All remaining work requires external input with no actionable alternative? You MUST set `disposition: "blocked"`, describe the blockers and release conditions in `summary`, and omit `nextAction`. One blocked goal does not block independent goals.
- You MUST keep summary plus next action within 4,096 tokens; this is a ceiling, not a target. Keep only facts needed to resume without repeating work.
- Failed checks are valid evidence; you MUST identify unverified claims.
- You NEED NOT wait for background jobs or passing checks to checkpoint.

<critical>
At your chosen milestone, you MUST submit `new_context({checkpoint})` as the sole tool call in its response.
At the ordinary-work limit you MUST stop work and report saved work, incomplete work, and the next action; model-capacity safety MAY force this earlier.
Acceptance confirms durable recording, not successful compaction. You MUST stop ordinary work after acceptance and let the session own continuation.
</critical>

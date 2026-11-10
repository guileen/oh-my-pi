<critical>
The ordinary-work limit has been reached. You MUST stop ordinary work now.
You MUST use this response ONLY to report through a sole `new_context({checkpoint})` tool call. You NEVER inspect, edit, run checks, dispatch jobs, or call other tools.
</critical>

QA rollover cycle: `{{cycleId}}`.
Ordinary-work limit: {{hardTokens}} input-context tokens.

- You MUST use `checkpoint.cycleId: "{{cycleId}}"`.
- You MUST report all outstanding user goals, saved work, evidence locations/results, uncertainty, unfinished verification, and blockers in `checkpoint.summary`.
- Canonical TODOs and job state are preserved separately. Record missing continuation context, not whole TODO lists or transcripts. Preserve still-relevant facts from prior checkpoints; this checkpoint must stand on its own.
- Any actionable work or verification remains? You MUST set `disposition: "continue"` and `nextAction` naming the next concrete operation, its target, and completion check, aligned with the next actionable TODO.
- The ENTIRE user task is complete? You MUST set `disposition: "complete"` and omit `nextAction`.
- All remaining work requires external input with no actionable alternative? You MUST set `disposition: "blocked"`, explain blockers and release conditions, and omit `nextAction`. One blocked goal does not block independent goals.
- You MUST keep summary plus next action within 4,096 tokens; this is a ceiling, not a target. Keep only facts needed to resume without repeating work.
- You MUST use existing evidence only; unverified work remains unverified.
- You NEVER wait for synchronous tools or background jobs in this response; settled tool results and current job state are preserved by the session.

<critical>
This is one bounded report attempt, not permission for more ordinary work.
After acceptance, the session owns QA compaction and usual continuation. You NEVER continue the old work loop.
</critical>

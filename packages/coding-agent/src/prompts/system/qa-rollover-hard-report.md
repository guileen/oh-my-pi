<critical>
The ordinary-work limit has been reached. You MUST stop ordinary work now.
You MUST use this response ONLY to report through a sole `new_context({checkpoint})` tool call. You NEVER inspect, edit, run checks, dispatch jobs, or call other tools.
</critical>

QA rollover cycle: `{{cycleId}}`.
Ordinary-work limit: {{hardTokens}} input-context tokens.

- You MUST use `checkpoint.cycleId: "{{cycleId}}"`.
- You MUST report saved work, evidence locations/results, uncertainty, unfinished work, and blockers in `checkpoint.summary`.
- Any requested work remains? You MUST set `disposition: "continue"` and a concrete `nextAction` for after compaction.
- The ENTIRE user task is complete? You MUST set `disposition: "complete"` and omit `nextAction`.
- User approval or another blocker prevents continuation? You MUST set `disposition: "blocked"`, explain the blocker, and omit `nextAction`.
- You MUST keep summary plus next action within 4,096 tokens.
- You MUST use existing evidence only; unverified work remains unverified.
- You NEVER wait for synchronous tools or background jobs in this response; settled tool results and current job state are preserved by the session.

<critical>
This is one bounded report attempt, not permission for more ordinary work.
After acceptance, the session owns QA compaction and usual continuation. You NEVER continue the old work loop.
</critical>

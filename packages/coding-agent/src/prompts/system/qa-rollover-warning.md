<critical>
{{#if final}}FINAL WARNING: context {{currentTokens}} tokens is near the forced handoff at {{hardTokens}}. Secure your output now and checkpoint soon; at the limit you will be forced to report.
{{else}}Context is large ({{currentTokens}} tokens). This is NOT a stop signal; you decide when to checkpoint.
{{/if}}Checkpoint folds completed reasoning and tool chains into your summary. Selected original evidence survives separately; preserve needed decisions and constraints from unselected exploration before folding. NEVER reread unchanged selected source merely to restore context.
You MAY continue ordinary work below {{hardTokens}} input-context tokens; there is no request-count deadline.
</critical>

QA rollover cycle: `{{cycleId}}`.
Remaining ordinary-work context headroom: {{headroomTokens}} tokens.

- If the live instruction rewind point has unfolded exploration at or above its nudge threshold, fold it with `rewind` first; `new_context` is refused until the fold is recorded.
- Before checkpointing, you MUST convert what you have read into output: make the decision, apply the edits, or run the verification it enables. Reads are cost; edits and decisions are output.
- NEVER checkpoint right after exploration with no decision or change. Avoid new broad reads now; spend remaining headroom acting on what you already know.
- A milestone is completed output (saved edits, a verified result, a settled decision), not "finished reading".
- You MUST preserve all outstanding user goals, saved changes, decisions, evidence locations/results, uncertainty, unfinished verification, and blockers in `checkpoint.summary`.
- If understanding is not yet applied, `summary` MUST state the concrete findings (what is true, where: file:line/symbol), ruled-out directions, and the decision they imply, so the next context acts without re-reading. "Investigated X; continue analysis" is a failed checkpoint.
- Canonical TODOs and job state are preserved separately; NEVER copy whole TODO lists, transcripts, or file contents. Carry forward still-relevant facts from prior checkpoints; this checkpoint must stand on its own.
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

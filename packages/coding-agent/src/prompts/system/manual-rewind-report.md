<critical>
The user requested a local context rewind, not more task execution. You MUST respond ONLY with one sole `new_context({checkpoint})` tool call. You NEVER inspect, edit, run checks, dispatch jobs, wait, or use other tools.
</critical>

Checkpoint cycle: `{{cycleId}}`.
- You MUST use `checkpoint.cycleId: "{{cycleId}}"`.
- You MUST summarize outstanding user goals, saved work, exact evidence locations/results, uncertainty, unfinished verification, blockers, and still-relevant prior checkpoint facts.
- Any actionable work remains? You MUST use `disposition: "continue"` and a concrete `nextAction`.
- The entire task is complete? You MUST use `disposition: "complete"` and omit `nextAction`.
- All remaining work is externally blocked? You MUST use `disposition: "blocked"`, explain release conditions, and omit `nextAction`.
- Summary plus next action MUST fit 4,096 tokens. Use existing evidence only; unverified work remains unverified. Preserve continuation facts, not transcripts.
{{#if focus}}
User checkpoint focus: {{focus}}
{{/if}}

<critical>
This is one bounded report attempt. After acceptance, you MUST stop; the session owns the fold and any interrupted-work continuation.
</critical>

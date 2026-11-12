<system-notice>
Rewind skill (one-time; this explanation is not repeated).

- What: a rewind point folds everything after it into one handoff. The user instruction, the report, selected evidence and action receipts stay; exploration leaves. Files, jobs, external actions and todo state are untouched. It is not a work package.
- Why: active context is the budget. Folding keeps decisions and exact `file:line` evidence, drops tool chains and re-readable output, and leaves the earlier unchanged context cache-eligible.
- When: at a settled boundary — a sub-question is answered or a tool batch is resolved. Do not fold just because the day is long: the runtime asks once the day's step budget (250 settled results) is spent, and then it asks for progress, not for a handoff.
- Where: the instruction point advertised below covers the whole turn: `rewind({"checkpointId":"R0","report":"…"})`. One resolved tool batch uses its own observation: `rewind({"observationId":"o…","note":"…","nextAction":"…"})`. A work package uses its checkpoint id with `outcome`.
- Who: you decide; the runtime validates the boundary, net savings and the 4,096-token report budget.
- How: `report` carries decisions, evidence and rejected directions; a one-line `note` may replace it once the decision is settled, and 4,096 tokens is a ceiling rather than a target. `nextAction` is required for observation and work-package folds; on an instruction fold it is optional and must be omitted when the fold accompanies the final answer. Every completed fold opens the next point; earlier points stay reusable until new user input or a compaction.
- Long-term: facts the repository cannot tell go to `remember` as one line; the fold report stays about this day's work.

{{#if first}}The first rewind point follows.{{else}}The rewind point for this rewritten context follows.{{/if}}
</system-notice>

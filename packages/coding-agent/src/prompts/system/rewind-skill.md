<system-notice>
Rewind skill (one-time; this explanation is not repeated).

- What: a rewind point folds everything after it into one handoff. The user instruction, the report, selected evidence and action receipts stay; exploration leaves. Files, jobs, external actions and todo state are untouched. It is not a work package.
- Why: active context is the budget. Folding keeps decisions and exact `file:line` evidence, drops tool chains and re-readable output, and leaves the earlier unchanged context cache-eligible.
- When: at a settled boundary — a sub-question is answered or a tool batch is resolved — and before yielding after long exploration. Skip only when the interval is already small and useful. The runtime also hints once a point accumulates 12 settled tool results.
- Where: the instruction point advertised below covers the whole turn: `rewind({"checkpointId":"R0","report":"…","nextAction":"…"})`. One resolved tool batch uses its own observation: `rewind({"observationId":"o…","note":"…","nextAction":"…"})`. A work package uses its checkpoint id with `outcome`.
- Who: you decide; the runtime validates the boundary, net savings and the 4,096-token report budget.
- How: `report` carries decisions, evidence and rejected directions; `nextAction` names the immediate continuation. Every completed fold opens the next point; earlier points stay reusable until new user input or a compaction.

{{#if first}}The first rewind point follows.{{else}}The rewind point for this rewritten context follows.{{/if}}
</system-notice>

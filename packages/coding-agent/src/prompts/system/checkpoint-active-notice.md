<system-notice>
Work package active: {{goal}}
checkpointId: {{checkpointId}}
Finish when: {{finishWhen}}
Carry forward: {{carryForward}}

- At `finishWhen`, MUST close this stack-top checkpoint with evidence and the next action; then continue from its parent or the next canonical todo. A todo-bound package requires an explicit outcome; `blocked` requires reason. NEVER separately mark its todo done first.
- Unmet finishWhen? Preserve incomplete work and blockers; NEVER claim completion. A phase's children finishing does not prove its own integration boundary.
- NEVER erase valuable unresolved context to satisfy this notice; retain it in the report or durable artifacts first.
- An explicit outcome may commit progress and close the scope without changing context when no savings exist; this is not compaction. NEVER retry an unchanged rejected handoff.
- Rewind changes conversation context, not files; closing this package does not finish the overall task.
</system-notice>

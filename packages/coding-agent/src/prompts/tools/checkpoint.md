Anchor a preplanned work package before noisy research or a long implementation phase.

Small observation decisions use `rewind({observationId, note, nextAction})` directly: no checkpoint, package contract, report, or todo outcome. Use this macro lifecycle only for planned packages.

Call BEFORE the package's first search/read/edit, not after collecting its findings. Otherwise the expensive trace stays before the anchor and cannot be discarded. Close A with `rewind` BEFORE starting B.

- Before calling, record the overall objective, constraints, and A→B plan in retained context.
- `goal`: this package's outcome; `finishWhen`: future observable completion condition; `carryForward`: checklist for the parent and later siblings—needed contracts, file/symbol locations, evidence, and unresolved risks. These are a plan, NOT research findings; NEVER research first to populate them.
- Call checkpoint alone, then begin this package's search/read/edit work in the next tool turn.
- Save the returned `checkpointId` verbatim for `rewind`.
- New packages nest under the active package, up to 32 scopes. Close only the stack top, then resume its parent; NEVER nest the same todo binding twice. Subagents require explicit `checkpoint` or `rewind` in requested tools; the pair requires `checkpoint.enabled`.
- `todo` omitted binds the unique active task; `{phase}` binds a stage; `{phase,task}` binds an exact task; `false` creates an unbound package. A bound package requires `outcome` (`completed`, `blocked`, `in_progress`); `blocked` requires `reason`.
- NEVER separately mark a bound todo done before rewind: handoff and progress commit together. No savings? An explicit outcome still commits progress and closes the scope without cutting context. Phase completion requires all children complete and evidence for the phase's own acceptance.
- Bindings track todo identity; concurrent replanning or deletion and same-name replacement can invalidate them. Do not bypass a stale binding.

Correct: checkpoint(research contract) → read/grep → rewind(findings, nextAction=A) → checkpoint(A contract) → edit/test → rewind(A evidence, nextAction=B).
Wrong: read/grep → findings → checkpoint; the trace is already before the anchor and stays large.
Rewind replaces post-anchor conversation with a retained handoff, not files. Keep valuable unresolved context in that handoff or durable artifacts.

# checkpoint

> Anchor a preplanned work package so `rewind` can replace its noisy conversation with an evidence-backed handoff.

## Availability

`checkpoint.enabled` (default `true`) gates both `checkpoint` and `rewind`. When enabled, the pair uses stable essential tool definitions rather than discoverable `xd://` devices. Existing tool restrictions still apply. Subagents require an explicit requested-tools entry for either member; registration includes its partner.

Checkpoints nest under the active package, up to 32 levels. Only the stack top can close; its parent then resumes. These tools change conversation context, not files, working-tree contents, artifacts, running processes, or authoritative todo state by rollback.

Small observation decisions need no checkpoint: completed tools return `observationId`, and successful reads also return `readId`. [Selective rewind](./rewind.md#small-observation-decisions) preserves exact evidence while discarding completed exploration, including long reasoning/tool chains, without closing this package. Fuse the next source read into that action rather than adding a model round.

## Plan before anchoring

Before noisy research or a long implementation phase, record the overall objective, constraints, and bounded A→B plan in the conversation. Create the anchor before starting package A, not after collecting the material it should contain.

```json
{
  "goal": "Identify the state transition responsible for duplicate job delivery",
  "finishWhen": "The responsible transition and affected callers are identified with source evidence",
  "carryForward": "Retain source locations, observed behavior, the chosen fix, and remaining implementation and verification work"
}
```

After reaching `finishWhen`, call [rewind](./rewind.md) with the returned ID, a report, and a concrete next action for B. A todo-bound package also requires an outcome. Close A before opening sibling B; close the parent after its own acceptance check. Package completion is not overall-task completion.

## Inputs

The first three fields are required nonblank strings.

| Field | Meaning |
| --- | --- |
| `goal` | Outcome of this work package, not a replacement for the overall objective. |
| `finishWhen` | Observable condition for ending this package. |
| `carryForward` | Future handoff checklist for the parent and later siblings: needed contracts, source locations, evidence, constraints, and unresolved risks. Do not research first to fill this field. |
| `todo` | Optional binding: omit to bind the unique current `in_progress` task; `{"phase":"…"}` binds a phase; `{"phase":"…","task":"…"}` binds an exact task; `false` creates an unbound package. |

The same todo cannot be bound by nested packages. Bindings include canonical source entry identity and fingerprint: concurrent replanning or deleting and recreating a same-named item fails closed. Only the runtime's atomic transitions refresh ancestor bindings; selective rewinds also refresh and persist valid bindings when retaining the latest todo.

## Outputs and recovery

Structured result details contain:

- `checkpointId`: opaque tool-call ID; copy it exactly into `rewind`.
- `goal`, `finishWhen`, `carryForward`: the package contract.
- `startedAt`: ISO timestamp.

The runtime records the anchor after the successful checkpoint result and injects a transient active-package notice. That notice carries the contract and ID and reminds the model to close the package without implying the whole task is finished. Planned packages use the ordinary tool loop, not a hidden retry/continuation scheduler.

The persisted journal supports recovery of active parent packages and their bindings, including after nested handoffs. Older persisted checkpoint results remain recoverable.

## Safety and limits

- Call checkpoint alone. A batch mixing checkpoint with other tools is rejected before any of those tools runs, so the retained prefix cannot contain an unmatched tool call.
- Rewind requires the exact stack-top ID and a resolvable anchor. Missing, stale, or invalidated bindings fail closed.
- User input after the anchor prevents rewind across that input. Re-scope around the new instructions rather than dropping them.
- A todo-bound handoff atomically commits its report and progress; do not call `todo.done` first. Phase completion requires all children completed and evidence for the phase's own acceptance.
- With an explicit outcome, a no-savings handoff can commit progress and close the scope without changing context. It is not a successful compaction.
- Parent handoffs replace child traces and summaries but inherit active selected source/text/image materials separately; release or demote obsolete evidence. Cache eligibility is an estimate, not evidence of a cache hit.

## Implementation

- Tools: `packages/coding-agent/src/tools/checkpoint.ts`
- Runtime and recovery: `packages/coding-agent/src/session/agent-session.ts`
- Session persistence: `packages/coding-agent/src/session/session-manager.ts`
- Registration and gate: `packages/coding-agent/src/tools/index.ts`, `packages/coding-agent/src/tools/settings.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/checkpoint.md`


# rewind

> Replace a locating decision with selected original code, or close a work package with its handoff, then continue.

## Availability

`rewind` shares the `checkpoint.enabled` gate, essential tool visibility, and explicit-subagent restrictions of [checkpoint](./checkpoint.md). Registration treats them as a pair. Nested work packages can contain multiple small search decisions.

## Inputs

### Small search decisions

Successful `grep`/`find` results return a `searchId`; numbered `read` results return a `readId`. No separate checkpoint is needed. Call rewind alone after locating useful code:

```json
{
  "searchId": "<returned searchId>",
  "retain": [{"readId": "<returned readId>", "path": "src/entry.ts", "from": 82, "to": 95}],
  "nextAction": "Located the entry; follow its worker"
}
```

The runtime extracts those exact, fully displayed rows from the delivered snapshot, including path, line numbers and edit tag. It does not reread the current file or ask the model to rewrite code. Raw reads, omitted/truncated rows and selections outside this search are rejected. A decision needs no intent paragraph or report.

Previously selected materials survive later hops. Use returned material references in `release` to remove obsolete code, or `demote: [{"ref": "<material>", "note": "Concise fact or exclusion reason"}]` to retain only a fact and source location. Released code does not reappear on rebuild. The original journal retains the abandoned search path.

Boundaries spanning new user input, compaction, delivered context, or non-search operations are rejected. A search batched with non-search calls is not a safe boundary. Selection is limited to 32 ranges, each at most 2000 lines; up to 128 active materials. The full replacement must shrink context, excluding the generated rewind call from the savings baseline. A small cut preserves current todos and does not close the enclosing package or mark work complete.

### Work-package handoffs


`checkpointId`, `report`, and `nextAction` are required nonblank strings and cannot be mixed with `searchId`. Only the active stack-top package can close.

| Field | Meaning |
| --- | --- |
| `checkpointId` | Exact opaque ID returned by the active `checkpoint`; not a session entry ID or a label. |
| `report` | Facts, source or artifact evidence, decisions, changed files, and remaining work needed after post-anchor context is removed. Distinguish observed results from unverified claims. |
| `nextAction` | Concrete next operation for continuing the overall task. |
| `outcome` | Required for a todo-bound package: `completed`, `blocked`, or `in_progress`. |
| `reason` | Required when `outcome` is `blocked`. |

For example, after completing a todo-bound package:

```json
{
  "checkpointId": "<copy the ID returned by checkpoint>",
  "report": "Updated the model-facing prompts and checked the nested transaction contract.",
  "outcome": "completed",
  "nextAction": "Update the user documentation"
}
```

Reach the package's `finishWhen` before completing it. Commit the report and todo outcome together; do not separately mark the todo done first. Completing a task starts the next pending task; blocked tasks do not restart automatically. Completing a phase requires all children completed and evidence of the phase's own acceptance. Preserve unmet boundaries and blockers explicitly.

Before closing a child, select what its parent and later siblings need: shared constraints, verified contracts and decisions, a compact file/symbol or artifact index, verification evidence, and unresolved risks. Include those in `report`, not private exploration or unrelated code. The retained report stays available to later siblings across their cuts. Selected search materials inside the child are not automatically carried through a macro cut; preserve needed facts and locations in the report instead.

When closing the parent, consolidate still-needed child findings and indexes into the parent's report. Parent cuts replace child reports rather than copying their accumulated history. An index locates evidence; it is not a current source snapshot or edit anchor.

## Outputs and application

Structured result details contain:

- `checkpointId`: the targeted active checkpoint.
- `report`: the retained handoff body; `nextAction` is rendered separately.
- `nextAction`: the concrete continuation.
- `rewound`: whether a cut was requested; it is `false` for an accepted no-cut outcome. Neither value proves the transaction committed.
- `estimate`: estimated context and cache eligibility; `willCompact: false` signals no expected compaction, not a cache hit.

The session applies the request at turn end. The final journal report's `contextChanged` records whether context actually changed. With an explicit outcome and no net savings, progress is still committed atomically and the scope closes, but original context remains. Do not call that compaction or retry merely to force it. Provider usage, not eligibility estimates, establishes actual cache use.

When context changes, the retained handoff includes the report, next action and current todo state; original history remains in the journal. Parent closure can replace child traces and summaries. Recovery restores persisted active parents and valid bindings.

Continue package B from `nextAction`. Rewinding A does not finish the overall task, imply a final yield, or justify repeating already completed work. Create a new checkpoint before B's noisy work when appropriate.

## Fail-closed safety

The runtime validates the request before changing context:

- The ID must match the active stack top; anchors and todo bindings must still resolve. Canonical source entry identity and fingerprint prevent concurrent replanning or delete-and-recreate from silently rebinding a package.
- User input since the anchor prevents rewinding across that input. Unsafe mixed batches and stale boundaries fail closed.
- The estimated replacement must shrink context for a cut; the strict savings baseline excludes the newly generated report, so a long report cannot manufacture savings. With an explicit outcome, no savings can still commit progress without a cut.
- `report`, `nextAction`, and any blocker `reason` together must fit within 4096 estimated tokens.

Invalid requests do not replace context or bypass todo validation. Continue from the handoff or unchanged context as applicable; do not repeat an unchanged rejected request.

## What rewind does not restore

Rewind does not revert files, artifacts, blobs, running processes, external effects, or git state. Edits made during A remain in place. It is a conversation branch operation, not a rollback mechanism.

The prefix through the checkpoint is eligible for provider prompt-cache reuse only while other request and provider conditions match. Rewind does not guarantee a cache hit, fixed context size, or monetary savings.

## Implementation

- Tool schema and result: `packages/coding-agent/src/tools/checkpoint.ts`
- Validation, deferred application, and recovery: `packages/coding-agent/src/session/agent-session.ts`
- Branch persistence: `packages/coding-agent/src/session/session-manager.ts`
- Context rebuilding: `packages/coding-agent/src/session/session-context.ts`
- Retained handoff: `packages/coding-agent/src/prompts/system/rewind-report.md`


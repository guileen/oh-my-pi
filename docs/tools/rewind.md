# rewind

> Retire completed observations while keeping needed evidence, or close a work package with its handoff, then continue.

## Availability

`rewind` shares the `checkpoint.enabled` gate, essential tool visibility, and explicit-subagent restrictions of [checkpoint](./checkpoint.md). Registration treats them as a pair. Small observation decisions need no checkpoint and can occur inside nested work packages.

## Inputs

### Small observation decisions

Every completed tool result, including failures, returns an `observationId` (`o…`), except lifecycle tools `rewind`, `checkpoint`, and `todo`. Successful reads also return a `readId` (`r…`) for source selections. No separate checkpoint, work-package contract, report, or todo outcome is needed.

Prefer a small cut for noisy searches or wrong reads; skip it for tiny/useful output. Optional `read: string[]` fuses retirement with ordinary read paths and inline selectors, preferably bounded source ranges. `note` is a one-line location/exclusion; `nextAction` names the work **after** these reads. This gives the next provider turn the note plus original source with paths, numbered lines and edit tags, not pointers alone or model-rewritten code. No intervening provider round is needed to request the reads. Tests, bash commands, browser and Computer Use observations—including failures—are also eligible.

Examples below assume the indicated refs and evidence were delivered; copy actual returned refs. Search result `o1` located the handler and its caller:

```json
{
  "observationId": "o1",
  "note": "Request handling is in src/entry.ts; src/router.ts calls it.",
  "read": ["src/entry.ts:82-95", "src/router.ts:20-35"],
  "nextAction": "Inspect the delivered handler and caller, then update request handling"
}
```

Fused reads use the enabled canonical `read` tool with its normal permission checks and output format. A disabled reader rejects the request before reading or cutting. Successful reads and full read failures are preserved as ordinary observations with their normal IDs; one failed path does not discard successful reads. Inspect errors before continuing; do not claim unread source or repeat successful reads merely to execute `nextAction`. This is not a general tool-sequencing API.

Optional evidence selections preserve already-delivered content without reading again:

- `retain: [{"readId": "r1", "path": "src/entry.ts", "from": 82, "to": 95}]`, assuming `r1` delivered those rows, carries exact, fully displayed numbered rows, their path and edit tag. Raw reads, omitted/truncated rows, and selections outside the affected observations are rejected.
- `keep: [{"observationId": "o3", "text": "Connection refused", "images": [0]}]`, assuming `o3` delivered that text and an image, carries exact evidence. `text` must be a nonempty substring of one delivered text part. Image indexes are zero-based among delivered image parts, not all content parts. Select text, images, or both; never model-created snapshots or paraphrases.

Previously selected materials survive later hops. Use returned material references in `release` to remove obsolete code, or `demote` entries with the returned `ref` and a concise fact/exclusion `note` to retain only that fact and source location. Prior decision notes and action receipts also survive. Released code does not reappear on rebuild; original history remains in the journal.

Rewind changes context, not execution. Read/grep/find/glob arguments and unselected outputs can be retired. For other or unknown tools, the runtime automatically retains a receipt containing the original tool name and arguments, `isError`, and complete structured details, including asynchronous handles. This records the attempted action, not business success: even `isError: false` is not proof of success. If outcome details were discarded, they are unknown. Do not automatically repeat an action because its output was retired; rewind neither undoes nor replays it. Keep exact output evidence when the next decision needs it.

Call rewind alone after every tool call in the affected batches has a final result. The boundary includes the target call's batch and following completed observations. Mixed completed tools are allowed; incomplete batches, new user input, compaction/reset/branch-summary boundaries, and checkpoint/work-package changes reject the cut. Unrelated asynchronous notifications and current lifecycle state are preserved.

Source selection is limited to 32 ranges, each at most 2000 lines; up to 128 active materials. The full replacement must shrink context, excluding the generated rewind call from the savings baseline. A small cut preserves current todos and does not close the enclosing package or mark work complete.

### Work-package handoffs


`checkpointId`, `report`, and `nextAction` are required nonblank strings. Macro handoffs cannot mix in `observationId`, `note`, `read`, `retain`, `keep`, `release`, or `demote`. Only the active stack-top package can close.

| Field | Meaning |
| --- | --- |
| `checkpointId` | Exact opaque ID returned by the active `checkpoint`; not a session entry ID or a label. |
| `report` | Facts, source or artifact evidence, decisions, changed files, and remaining work needed after post-anchor context is removed. Distinguish observed results from unverified claims. |
| `nextAction` | Concrete next operation for continuing the overall task. |
| `outcome` | Required for a todo-bound package: `completed`, `blocked`, or `in_progress`. |
| `reason` | Required when `outcome` is `blocked`. |

For example, after completing a todo-bound package whose checkpoint returned the illustrative ID `c1`:

```json
{
  "checkpointId": "c1",
  "report": "Updated the model-facing prompts and checked the nested transaction contract.",
  "outcome": "completed",
  "nextAction": "Update the user documentation"
}
```

Reach the package's `finishWhen` before completing it. Commit the report and todo outcome together; do not separately mark the todo done first. Completing a task starts the next pending task; blocked tasks do not restart automatically. Completing a phase requires all children completed and evidence of the phase's own acceptance. Preserve unmet boundaries and blockers explicitly.

Before closing a child, select what its parent and later siblings need: shared constraints, verified contracts and decisions, a compact file/symbol or artifact index, verification evidence, and unresolved risks. Include those in `report`, not private exploration or unrelated code. The retained report stays available to later siblings across their cuts. Selected observation materials inside the child are not automatically carried through a macro cut; preserve needed facts and locations in the report instead.

When closing the parent, consolidate still-needed child findings and indexes into the parent's report. Parent cuts replace child reports rather than copying their accumulated history. An index locates evidence; it is not a current source snapshot or edit anchor.

## Outputs and application

Small-decision results identify the observation boundary and retained materials for later release/demotion; they do not commit todo progress. Requested source reads are persisted after the cut in the same branch transaction, and the next provider turn receives their original output before continuing with `nextAction`. Recovery restores those observations without replaying reads. For macro handoffs, structured result details contain:

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

- For a macro handoff, the ID must match the active stack top; anchors and todo bindings must still resolve. Canonical source entry identity and fingerprint prevent concurrent replanning or delete-and-recreate from silently rebinding a package.
- User input since the boundary prevents rewinding across that input. Incomplete batches and stale boundaries fail closed; macro mixed-batch restrictions remain unchanged. Small-cut boundary and savings validation precede read I/O. New input or stale generation during reads, or persistence failure, cannot commit a stale branch.
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


# rewind

> Retire completed observations while keeping needed evidence, or close a work package with its handoff, then continue.

## Availability

`rewind` shares the `checkpoint.enabled` gate, essential tool visibility, and explicit-subagent restrictions of [checkpoint](./checkpoint.md). Registration treats them as a pair. Small observation decisions need no checkpoint and can occur inside nested work packages.

## Inputs

### Small observation decisions

Every completed tool result, including failures, returns an `observationId` (`o…`), except lifecycle tools `rewind`, `checkpoint`, and `todo`. Successful reads also return a `readId` (`r…`) for source selections. No separate checkpoint, work-package contract, report, or todo outcome is needed.

At the next settled boundary, retire resolved exploration containing disposable results, failed approaches, or long completed reasoning/tool chains. Judge the entire interval; skip only when it is already small and useful. Fuse a needed source read with `read: string[]`, using ordinary paths and bounded selectors. `note` records the decision or exclusion; `nextAction` names the work **after** those reads. The next provider turn receives original source with paths, numbered lines and edit tags, without an extra model round to request it. Tests, bash commands, browser and Computer Use observations—including failures—are also eligible.

Examples below assume the indicated refs and evidence were delivered; copy actual returned refs. Search result `o1` located the handler and its caller:

```json
{
  "observationId": "o1",
  "note": "Request handling is in src/entry.ts; src/router.ts calls it.",
  "read": ["src/entry.ts:82-95", "src/router.ts:20-35"],
  "nextAction": "Inspect the delivered handler and caller, then update request handling"
}
```

Fused reads use the enabled canonical `read` tool with normal permission checks and output format. A disabled reader rejects before reading or cutting. No net savings skips only the cut: valid fused reads still complete once. Successes and full read failures remain ordinary observations with normal IDs; one failed path does not discard successful reads. Inspect errors before continuing; do not claim unread source or repeat successful reads merely to execute `nextAction`. This is not a general tool-sequencing API.

Optional evidence selections preserve already-delivered content without reading again:

- `retain: [{"readId": "r1", "path": "src/entry.ts", "from": 82, "to": 95}]`, assuming `r1` delivered those rows, carries exact, fully displayed numbered rows, their path and edit tag. Raw reads, omitted/truncated rows, and selections outside the affected observations are rejected.
- `keep: [{"observationId": "o3", "text": "Connection refused", "images": [0]}]`, assuming `o3` delivered that text and an image, carries exact evidence. `text` must be a nonempty substring of one delivered text part. Image indexes are zero-based among delivered image parts, not all content parts. Select text, images, or both; never model-created snapshots or paraphrases.

Selected source, text and images survive observation rewinds, work-package handoffs and automatic compaction. Fused numbered source reads are selected from their immutable delivered snapshots, retaining original paths, lines and tags. Use returned references in `release` to stop preserving obsolete material, or `demote` with a concise fact/exclusion `note`. Do not copy selected code into reports or reread it for preservation. Released material does not reappear on rebuild; original history remains in the journal.

Rewind changes context, not execution. Read/grep/find/glob arguments and unselected outputs can be retired. For other or unknown tools, the runtime automatically retains a receipt containing the original tool name and arguments, `isError`, and complete structured details, including asynchronous handles. This records the attempted action, not business success: even `isError: false` is not proof of success. If outcome details were discarded, they are unknown. Do not automatically repeat an action because its output was retired; rewind neither undoes nor replays it. Keep exact output evidence when the next decision needs it.

Call rewind alone after every tool call in the affected batches has a final result. The boundary includes the target call's batch and following completed observations. Mixed completed tools are allowed; incomplete batches, new user input, compaction/reset/branch-summary boundaries, and checkpoint/work-package changes reject the cut. Unrelated asynchronous notifications and current lifecycle state are preserved.

Source selection is limited to 32 ranges, each at most 2000 lines; up to 128 active materials. A cut requires net savings, excluding the generated rewind call from the baseline. Without savings, the decision and any fused reads are recorded without replacing history. Small decisions preserve current todos and do not close the enclosing package or mark work complete.

### Instruction point

Every user instruction opens a point (`R0`, `R1`, …) advertised in a hidden notice after the user entry. `rewind({checkpointId, report, nextAction})` cuts from that point to the current tip: the instruction, report, selected materials, receipts and todo state stay; exploration leaves active context. It is not a work package—no `outcome`, stack entry or todo binding—and accepts no `keep`, `retain`, `read`, `release` or `demote`. A one-line `note` may replace `report` once the decision is settled; providing both is rejected, and the 4,096-token report budget is a ceiling, not a target. When only the reasoning should leave and the tool output is still needed, use [`thinknote`](./think-note.md) instead of a cut.

The first point is preceded by a one-shot hidden skill notice: what a point folds, why (context is the budget), when to fold, where each call form applies, who decides, and how the report is budgeted. It ends with `The first rewind point follows.` Every point then carries a one-line reminder with its id and call form; the skill entry is not tied to point validity, so it survives the user instruction that invalidates earlier points. A compaction or reset that drops the explanation from the rebuilt context re-opens it immediately before the next point, and never repeats it otherwise.

Points are reusable and chained. The notice entry is the cut boundary, so a used point survives and every completed fold opens the next point (`R1`, `R2`, …) at the retained position. Earlier points stay resolvable and may be reused, including the root point; a later user instruction, compaction or reset invalidates points before it. Fold summaries never invalidate a point: a summary that cut before the notice removes the notice from the branch instead. No net savings keeps the context unchanged and leaves the point available; the report still stays in the rewind result and still counts as the fold for the timing demands. The journal is append-only, so rewinding to an earlier point opens a sibling branch; the previous branch remains on disk.

Two runtime timings apply while `checkpoint.enabled` is on and `rewind` is available:

- **Mid-run (advisory).** One hidden hint fires when the point spans 250 settled tool results, and only once: a day that is still producing must not be nudged into a handoff. The hint asks for progress — finish, or fold with what changed — and mentions `remember` for a settled fact.
- **Pre-yield (mandatory).** At a text-only stop, if the point spans at least 250 settled results and no fold was completed for it, the runtime injects one reminder and continues the loop once. It says to answer only when the task is done or blocked; otherwise fold with the progress and keep working. A declined reminder yields to the user instead of looping. The demand carries the same 4,096-token report budget.
- **Rollover precedence.** While the point has at least 12 settled results and no completed fold, a QA `new_context` rollover is refused with `QA_REWIND_FOLD_REQUIRED`: fold first, then checkpoint. The hard context report is the exception, because rewind is unavailable there. Rollover rewrites the branch, so evidence not folded first cannot be recovered afterwards.

The advisory hint costs ~55 text tokens per fire; the pre-yield demand fires at most once per point. A fold recorded without a net-benefit cut still satisfies all three timings; the report stays in the rewind result.

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

Before closing a child, put shared constraints, verified decisions, a compact source/artifact index, verification evidence and unresolved risks in `report`; omit private exploration and unrelated code. Active selected observation materials are inherited separately, including fused-read snapshots, so the report need not repeat their code. Later siblings retain the report and selected evidence.

When closing the parent, consolidate still-needed child findings and indexes into the parent's report. Parent cuts replace child reports rather than copying their accumulated history. An index locates evidence; it is not a current source snapshot or edit anchor.

## Outputs and application

Small-decision results identify the observation boundary and retained materials for later release/demotion; they do not commit todo progress. The continuation contains the concrete note and next action, without a repeated generic preamble. Requested source reads persist in the same atomic transaction whether or not a cut helps; the next provider turn receives their original output before continuing. Recovery restores them without replaying reads. For macro handoffs, structured result details contain:

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
- User input since the boundary prevents rewinding across that input. Incomplete batches and stale boundaries fail closed; macro mixed-batch restrictions remain unchanged. Boundary validation precedes read I/O; no net savings does not reject valid fused reads. New input or stale generation during reads, or persistence failure, cannot commit a stale branch.
- The estimated replacement must shrink context for a cut; the strict savings baseline excludes the newly generated report, so a long report cannot manufacture savings. With an explicit outcome, no savings can still commit progress without a cut.
- `report`, `nextAction`, and any blocker `reason` together must fit within 4096 estimated tokens.

Invalid requests do not replace context or bypass todo validation. Continue from the handoff or unchanged context as applicable; do not repeat an unchanged rejected request.

## What rewind does not restore

Rewind does not revert files, artifacts, blobs, running processes, external effects, or git state. Edits made during A remain in place. It is a conversation branch operation, not a rollback mechanism.

The prefix through the checkpoint is eligible for provider prompt-cache reuse only while other request and provider conditions match. Rewind does not guarantee a cache hit, fixed context size, or monetary savings.

## Implementation

- Tool schema and result: `packages/coding-agent/src/tools/checkpoint.ts`
- Instruction point resolution: `packages/coding-agent/src/session/instruction-anchor.ts`
- Validation, deferred application, and recovery: `packages/coding-agent/src/session/agent-session.ts`
- Branch persistence: `packages/coding-agent/src/session/session-manager.ts`
- Context rebuilding: `packages/coding-agent/src/session/session-context.ts`
- Retained handoff: `packages/coding-agent/src/prompts/system/rewind-report.md`


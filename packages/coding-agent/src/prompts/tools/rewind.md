Retire completed observations, or close a planned work package, then continue.

## Small observation

- Use the returned `observationId` (`o…`), including failed results; `rewind`, `checkpoint`, and `todo` do not provide one. Search → decide the next read → rewind BEFORE that read. Wrong read → retire it with an exclusion `note` before another read. Tests/bash, browser and Computer Use outputs use the same loop.
- Supply `observationId` and `nextAction`; optionally add a brief conclusion/exclusion `note`. No checkpoint, intent paragraph, report, or todo outcome. A small cut never completes a todo or closes its package.
- `retain: [{readId, path, from, to}]` carries exact already-displayed source rows and edit anchors without rereading. `keep: [{observationId, text?, images?}]` carries a nonempty exact substring of one delivered text part and/or zero-based indexes among delivered image parts. NEVER paraphrase kept text or recreate images.
- Selected materials survive later hops. `release` drops returned material references; `demote` replaces their code with a concise fact/exclusion reason and source location. Prior notes and action receipts survive. Preserve caller constraints that later code does not replace.
- Call alone after every tool call in affected batches has a final result. Mixed completed tools are allowed. New input, lifecycle/context boundaries, incomplete batches, invalid selections and no net reduction reject the cut. Unrelated async notifications remain available.
- Except read/grep/find/glob, retired tools keep original name/arguments, `isError` and complete structured details, including async handles. Receipts are historical action metadata, not a current screen or proof of success. Unkept outcome detail becomes unknown: NEVER auto-repeat an action because its output was retired.

Examples assume the indicated refs and content were delivered; copy actual returned refs.

Search returned `o1` locating the handler; rewind before reading it:
```json
{"observationId":"o1","note":"Handler is in src/handler.ts.","nextAction":"Read src/handler.ts:82-95"}
```

Read returned `o2` showing the wrong implementation:
```json
{"observationId":"o2","note":"CLI wrapper only; excludes request handling.","nextAction":"Read src/handler.ts:82-95"}
```

Failed browser action returned `o3`, text `Connection refused` and an image; keep that evidence without retrying:
```json
{"observationId":"o3","keep":[{"observationId":"o3","text":"Connection refused","images":[0]}],"nextAction":"Inspect the existing server job status"}
```

## Work package

- Use `checkpointId`, evidence-backed `report`, and `nextAction`; a bound package also requires `outcome`, and `blocked` requires `reason`. NEVER mix in `observationId`, `note`, `retain`, `keep`, `release`, or `demote`. Call alone; only the active stack top closes.
- Commit progress through rewind, not a separate todo mutation. Report only what the parent and later siblings need: shared constraints, verified contracts/decisions, compact file/symbol or artifact indexes, verification evidence, and unresolved risks. Omit private exploration and irrelevant code.
- Macro cuts do not automatically carry selected observation materials. Closing a parent? Consolidate still-needed child findings and indexes into its report; do not merely announce completion.
- New input, stale boundaries and unsafe mixed batches fail closed. An explicit macro outcome can commit progress and close the scope without a cut when there is no net reduction. Accepted is not committed: `contextChanged` is the actual macro result. NEVER retry an unchanged rejected handoff.

## After either mode

- Rewind changes context, never files, external effects or authoritative todo history; it never undoes or replays actions. Parent cuts replace child traces and summaries when beneficial. Cache eligibility is an estimate, not a hit; only usage confirms caching.
- After success, execute `nextAction` immediately from retained context. Reopen evidence only for missing detail, changed sources, or contradiction.

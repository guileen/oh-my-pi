Retire completed observations, or close a planned work package, then continue.

## Small observation

- Use the returned `observationId` (`o…`), including failed results; `rewind`, `checkpoint`, and `todo` do not provide one. MUST retire resolved exploration with disposable output, failed approaches, or long completed reasoning/tool chains at the next settled boundary. Skip only when the whole interval is small and useful. Tests/bash, browser and Computer Use results are also eligible.
- Supply `observationId` and `nextAction`; optionally add a one-line decision/exclusion `note`. Next step reads source? MUST fuse ordinary bounded read paths/selectors in `read: string[]`, not issue a separate read. One action returns original read output before the next provider turn; `nextAction` follows those reads. No worthwhile cut? Reads still complete without discarding history. No checkpoint, report or todo outcome; a small decision never closes a package.
- For source-location context, keep the one-line note plus real source with paths, numbered lines and edit tags—not pointers alone or model-rewritten code. Fused reads use normal read permissions; disabled read rejects before reading/cutting. Successful reads and full read errors remain available; NEVER claim failed reads succeeded or reread successful paths merely to continue.
- `retain: [{readId, path, from, to}]` carries exact already-displayed source rows and edit anchors without rereading. `keep: [{observationId, text?, images?}]` carries a nonempty exact substring of one delivered text part and/or zero-based indexes among delivered image parts. NEVER paraphrase kept text or recreate images.
- Selected materials survive observation, work-package and automatic folds. `release` drops returned material references; `demote` replaces their code with a concise fact/exclusion reason and source location. Prior notes and action receipts survive. Preserve caller constraints that later code does not replace.
- Call alone after every tool call in affected batches has a final result. Mixed completed tools are allowed. New input, lifecycle/context boundaries, incomplete batches and invalid selections reject the operation. No net reduction skips the cut, not requested reads. Unrelated async notifications remain available.
- Except read/grep/find/glob, retired tools keep original name/arguments, `isError` and complete structured details, including async handles. Receipts are historical action metadata, not a current screen or proof of success. Unkept outcome detail becomes unknown: NEVER auto-repeat an action because its output was retired.

Examples assume the indicated refs and content were delivered; copy actual returned refs.

Search returned `o1` locating the handler; fuse the source read:
```json
{"observationId":"o1","note":"Request handling is in src/handler.ts.","read":["src/handler.ts:82-95"],"nextAction":"Inspect the delivered handler and update request handling"}
```

Read returned `o2` showing the wrong implementation; exclude it and read the alternative:
```json
{"observationId":"o2","note":"CLI wrapper only; excludes request handling.","read":["src/handler.ts:82-95"],"nextAction":"Inspect the delivered handler"}
```

Failed browser action returned `o3`, text `Connection refused` and an image; keep that evidence without retrying:
```json
{"observationId":"o3","keep":[{"observationId":"o3","text":"Connection refused","images":[0]}],"nextAction":"Inspect the existing server job status"}
```

## Instruction point

- Every user instruction opens a point (`R0`, `R1`, …) advertised in the request. `rewind({checkpointId, report, nextAction?})` replaces exploration after that point with the report; the instruction, report, selected materials, receipts and todo state stay. Omit `nextAction` when the fold ends the turn with the final answer; supply it only when work continues. No `outcome`, `note`, `keep`/`retain`, `read`, `release` or `demote` fields.
- Use it once the question is resolved and before the answer. Every completed fold opens the next point at the retained position; earlier points stay valid and may be reused. A later user instruction, compaction or reset invalidates earlier points; fold summaries never do. No net savings rejects the fold; keep working instead.
- A hidden hint names one point once it spans 250 settled tool results (the day budget), and only once. Treat it as a signal, not a schedule: finish, or fold with what changed and keep working. Do not hand off just because a day is long.

## Work package

- Use `checkpointId`, evidence-backed `report`, and `nextAction`; a bound package also requires `outcome`, and `blocked` requires `reason`. NEVER mix in `observationId`, `note`, `read`, `retain`, `keep`, `release`, or `demote`. Call alone; only the active stack top closes.
- Commit progress through rewind, not a separate todo mutation. Report only what the parent and later siblings need: shared constraints, verified contracts/decisions, compact file/symbol or artifact indexes, verification evidence, and unresolved risks. Omit private exploration and irrelevant code.
- Selected original materials carry forward separately; NEVER copy them into the report merely to preserve them. Closing a parent? Consolidate still-needed child decisions, constraints and findings into its report; do not merely announce completion.
- New input, stale boundaries and unsafe mixed batches fail closed. An explicit macro outcome can commit progress and close the scope without a cut when there is no net reduction. Accepted is not committed: `contextChanged` is the actual macro result. NEVER retry an unchanged rejected handoff.

## After either mode

- Rewind changes context, never files, external effects or authoritative todo history; it never undoes or replays actions. Parent cuts replace child traces and summaries when beneficial. Cache eligibility is an estimate, not a hit; only usage confirms caching.
- After success, execute `nextAction` from retained context and any delivered reads. When the fold had no `nextAction`, yield; do not derive work from the report. Reopen evidence only for missing detail, changed sources, or contradiction.

# In-Context Memory

Status: design. Supersedes the ad-hoc framing in `docs/tools/rewind.md` §"when to fold".

Scope: **inside one session**. Cross-session memory (`memory.backend` in
[`memory.md`](./memory.md)) is a separate, retrieval-capable system and is out of scope.

## 1. Problem

Before the agent could edit its own context, everything it wrote stayed in the window, so
nothing had a lifetime. Once folding and rewinding exist, every piece of context either
survives the next cut or dies in it, and the model was never told which. The result is
observable: sessions that re-derive settled conclusions, compaction storms (one session:
152 compactions in 284 min), and folds that delete knowledge with no record of it.

## 2. Invariant

> Memory is pushed, never pulled. Every request contains all memory the model may use.
> There is no "look it up when needed" step.

Storage (journal, sidecar) is not memory; only the injected block is. This invariant is
what makes the rest necessary:

`push` ⇒ cost grows with lines ⇒ lines must be few ⇒ one line per fact ⇒ a line must be
verifiable ⇒ every line carries an anchor.

## 3. Vocabulary

One term per concept. No synonyms in prompts, docs, or code.

| Term | Means | Not to be called |
| --- | --- | --- |
| **day** | one user-instruction round, from the instruction to the next `night` | session, turn |
| **night** | cutting back to the day point and writing the day note | compact, summarize |
| **day point** | the rewind point (`R<k>`) opened after the day's user instruction | checkpoint |
| **day note** | the model's rewrite of the whole day + what to do next; rolling window of days | long-term memory, summary |
| **line** | one long-term fact, appended by the model | memory, note, report |
| **fold** | replacing the current assistant message's reasoning | think |
| **pin** | fixing one observation's exact source text | replay, remember |
| **package** | nested goal with `finishWhen`/`carryOut`, via the `checkpoint` tool | checkpoint point |
| **handoff** | QA rollover summary | checkpoint |
| **compact** | emergency valve when the window is nearly full | night |

## 4. The day

- A day starts at the user instruction. It ends at `night`.
- A long task is a sequence of days. Each day is one window's worth of work.
- Across days three things carry over: the rolling **day notes**, the **line block**, and
  repository state. Day notes carry goals, reasoning continuity and next steps; lines
  carry facts. Repository state carries everything that has an artifact.
- A day that spans multiple user instructions is **not supported**: a later user message
  supersedes the day point today. Steering messages have the same effect and are an open
  issue (§15).

## 5. Operations

Four, and only four.

| Op | Call | Cuts | Produces | Lifetime of the product |
| --- | --- | --- | --- | --- |
| fold | `thinknote({note, drop})` | no | replaced reasoning | current assistant message |
| pin | `rewind({observationId, keep, retain, read})` | that observation | exact source text | branch, until released |
| remember | `remember({line})` | no | one line | session (append-only) |
| night | `rewind({checkpointId: <day point>, note})` | the whole day | day note | rolling window (4 days kept) |

Mid-day rollback is **not** a separate operation: `rewind` to a mid-day point, whose note
dies at the next cut. There is no `nap`, no `commit`, no `mark`.

Rules:

- `fold` MUST use the 4:1 rule (note tokens × 4 ≤ reasoning tokens), else keep the
  reasoning unchanged (`kept`).
- `fold` MUST NEVER be capped by reasoning length. Reasoning effort is a user setting,
  not agent behavior.
- `pin` MUST NOT be used to fold; a pin is a source, not a conclusion.
- `remember` MUST append. The model never edits or deletes an existing line.
- `night` MUST write a day note. A night without one is rejected (§10).

### What a line may contain

A line is admitted only if all three hold:

1. **Not readable from the repository** — anything derivable from code, config or git is
   already memory; a line duplicating it is waste.
2. **Changes a future decision** — if it cannot alter a later choice, it is not a line.
3. **Compressible to one sentence** — a line that needs a paragraph is not settled yet.

Candidate kinds: surprises (measurement contradicting expectation), pinned conventions
that must not be re-derived, disproved paths and why, incident lessons and user
corrections, structural blockers, user constraints.

Excluded: code structure, API names, file inventories, todo detail.

**Line length:** a hint of 200 characters, a hard limit of 400 (2×). Exceeding the hard
limit returns a tool error asking for a rewrite; it never truncates. The hint exists
because the model cannot count characters reliably, and the hard limit only guards against
runaway text.

## 6. Artifacts and lifetimes

| Artifact | Written by | Injected by | Growth | Lifetime |
| --- | --- | --- | --- | --- |
| day note | model, at night | harness, on every request (newest four) | 1 per day | keep 4 days; compress at 8 |
| line | model, during the day, as a `remember` tool call in the stream | harness, on every request, at the tail | append-only | session |
| pinned source | model | as part of the cut | per pin | branch |
| work package | model | as a tool result | stack ≤ 32 | until closed |

The `remember` call is ordinary context for the rest of the day: it sits in the stream like
any other tool call. What survives a cut is the stored line, re-injected by the harness as
a block at the next day. The same holds for day notes: the model writes one at night, and
the harness keeps the rolling window outside the folded region, because a note left in the
stream would be cut by the next night.

Day-note compression (8 → 4) is initiated by the harness and executed by the model, the
same pattern as the QA gate: the harness asks, the model rewrites. At eight notes the
injected block states that the window is exceeded and asks the next fold to merge them;
the injected view already carries only the newest four.

## 7. Measurement

Two quantities, both measured from the day start:

| Metric | Definition | Use |
| --- | --- | --- |
| **Δtokens** | billable tokens added since the day began (`input + cacheRead + output` over assistant entries) | pace |
| **Δsteps** | settled tool results since the day began | pace |

Both are derived from session entries after the last day note (`AgentSession.#dayStats`)
and appended to cut-point reminders (`#memoryFeedbackSuffix`), never to the injected
block: the block sits inside the cacheable prefix and must stay stable for a retained
rewind prefix.

Safety is a different quantity: **absolute context** compared against the existing
compaction threshold. Overflow is a function of the absolute size, not of the increment.

There is exactly **one** safety number and it already exists:
`resolveThresholdTokens(window, settings)` (`packages/agent/src/compaction/compaction.ts`),
resolved per model by `resolveModelCompactionSettings`
(`packages/coding-agent/src/session/model-compaction-threshold.ts`), configured via
`compaction.thresholdTokens` / `compaction.thresholdPercent` / `compaction.modelThresholds`.
No new percentage, no three-tier scheme.

## 8. Budgets

Hard limits are deliberately wide: the agent is expected to manage itself. A limit exists
to stop a catastrophic failure, not to shape normal behavior. Exceeding a limit triggers a
**regeneration request with a target**, never a failure.

| Budget | Measured | Value | On exceed |
| --- | --- | --- | --- |
| context | absolute tokens | `resolveThresholdTokens(...)` | night |
| day pace | Δsteps | 250 (one reminder) | soft tip (§9) |
| day note size | tokens after generation | same threshold function's prompt budget | reject + target, regenerate; if still over, truncate and mark |
| lines per day | count | 20 | ask the model to select or merge |
| line length | characters | hint 200, hard 400 | tool error, rewrite |
| day-note window | days | keep 4 | compress to 4 |
| fold ratio | note/reasoning tokens | 4:1 | `kept` |

The three numbers we choose ourselves are 250, 400 and 20. Everything else is reused.
250/400 come from three real 66–75 MB sessions: results between cuts p90 = 241/241/279,
max = 398.

## 9. Feedback

Feedback is a hint, not a verdict. It states counts and times; it never recommends an
action, because a recommendation can silently change the task.

- Tips attach to cut-point reminders (the mid-run nudge and the pre-yield demand), not to
  individual tool results and not to the injected memory block: the block must stay
  byte-identical within a retained rewind prefix.
- Repeated command: when the same normalized command runs ≥ 3 times in the window, the
  reminder lists `executed 27 times · 3 of the last 5 failed`.
- Exit codes MUST NOT be a hard rule. The model reads the counts and decides.
- No reasoning-length signal. The behavioral signal for idling is **Δsteps stalled while
  Δtokens grows**, which is independent of the user's effort setting.
- Feedback is delivered at cut points (night, fold, remember), not mid-work: a cut is the
  only moment where information is lost or frozen.

## 10. Gates

Two hard gates only, because both guard irreversible writes:

1. **night without a day note** — rejected.
2. **day note still over budget after one regeneration** — truncated and marked, never
   retried.

## 11. Injection and cache

Order, for prefix-cache efficiency (the first changed byte re-bills everything after it):

```
[system / tool schemas]      never changes
[day notes + line block]     changes once per night
[the day's conversation]     changes per request
[latest turn]                changes per request
```

Mutable content goes as late as possible. Appending a line inside an early block would
re-bill the whole conversation; appending it after the day's conversation costs only the
line.

## 12. Relation to existing systems

| System | Relation |
| --- | --- |
| `memory.backend` (`docs/memory.md`) | cross-session, project-scoped, startup-injected; complementary, unchanged |
| compaction / QA rollover (`docs/compaction.md`) | emergency valve; keeps its thresholds, loses the "night" role |
| rewind points (`docs/tools/rewind.md`) | become day points (first `R` of a day) and mid points |
| `checkpoint` tool | remains the package stack; never a memory artifact |
| `thinknote` (`docs/tools/think-note.md`) | unchanged mechanics; renamed `fold` in prose |

## 13. Implementation map

| Piece | Location | State |
| --- | --- | --- |
| `thinknote` + marker + convert rewrite | `tools/think-note.ts`, `session/think-note.ts`, `session/messages.ts` | exists |
| instruction points, notices, nudge, pre-yield gate | `agent-session.ts`, `session/instruction-anchor.ts` | exists |
| QA gate + rollover | `session/session-maintenance.ts`, `session/qa-rollover.ts` | exists |
| `remember` tool + line store | `tools/remember.ts`, `session/context-memory.ts` | exists |
| day-note store + rolling window (4 kept) | `session/context-memory.ts`, `agent-session.ts` | exists; merge notice at 8, model merges on the next fold |
| harness injection of day notes + lines | `agent-session.ts` (`#injectMemoryBlockIntoRequest`) | exists |
| day pace counters (Δtokens / Δsteps) | `agent-session.ts` (`#dayStats`), cut-point reminders | exists |
| command history facts | `session/context-memory.ts` (`summarizeCommandRuns`), cut-point reminders | exists |
| curation notices (bank near limit, day notes over window) | `session/context-memory.ts` (`renderContextMemoryBlock`) | exists |
| threshold reuse | `resolveThresholdTokens`, `resolveModelCompactionSettings` | reuse |
| prompt files | `prompts/system/rewind-skill.md` (reframe as memory), `night.md`, memory-hint | edit/new |

## 14. Acceptance

Unit:

- A night without a day note is rejected; with one, the day point advances and the note is
  stored.
- A day note over budget is rejected with the actual token count and a target; a second
  failure truncates and marks.
- Day notes roll: 5 days keep 4; 8 days compress to 4.
- A line append is visible in the next request at the injection position, and never
  earlier.
- `remember` cannot modify or delete an existing line.
- Δsteps/Δtokens reset at night.

Integration:

- A scripted session runs two days; after the second night the request contains exactly
  one day note set plus all lines.
- The repeated-command tip appears at the third identical command and carries counts only.

Live:

- Same task as the baseline; record Δsteps between nights, lines per day, day-note size.
- Compare with §8 numbers; adjust 250/400 only from data.

## 15. Open

- Calibration of 250 / 400 / 20 from live sessions.
- Trigger for harness-initiated line curation (count? age? conflict?).
- Day spanning multiple user instructions; steering messages currently invalidate the day
  point.
- Whether `remember` is gated by `checkpoint.enabled` or gets its own setting.

## 16. Non-goals

- No vector store, embeddings, graph, or any retrieval step.
- No automatic fact extraction from tool results: lines are model-authored. Machine logs
  are for detection only, never injected.
- No branch switching; abandoned subtrees are not re-enterable.
- No change to cross-session `memory.backend`.

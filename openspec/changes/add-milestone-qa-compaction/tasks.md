# Tasks

The 120K soft-warning / 200K ordinary-work-stop policy supersedes the initially accepted ratio/request-quota policy below. Historical checked items and dated runtime evidence apply only to their original inputs and implementation; they do not prove the superseding policy. Current acceptance is tracked separately here and must be checked only after the integration owner supplies exercised evidence. Repository-wide lint/type verification remains blocked by unrelated Bot/launch working-tree changes, so this change is not archived.

## Current policy acceptance (superseding request, 2026-11-04)

- [x] C1 Implement fixed 120,000-token warning and 200,000-token ordinary-work stop, independently of configured general/model compaction triggers; clamp to actual capacity and reserve report input/output space. Recover to at most 80% of the effective warning (normally 96,000), not 80% of the ordinary stop. Preserve defaults and user configuration.
- [x] C2 Remove the ordinary-work provider-request quota end to end. Prove more than three post-warning requests may reach an agent-chosen later nearby checkpoint below the hard stop; retain warning deduplication and generic transport-retry admission.
- [x] C3 At the hard boundary admit only one bounded sole-tool `new_context` report attempt. Prove ordinary/mixed tools cannot execute, saved work/incomplete work/next action survive accepted reporting and QA, and a failed/missing/invalid report cannot restore ordinary work or retry indefinitely.
- [x] C4 Prove capacity safety with fixed context, pending input, small/unknown windows, zero configured reserve and giant results. If reporting cannot fit, preserve raw history and use only configured fallback methods or safe pause.
- [x] C5 Re-exercise queued-user precedence, cancellation, checkpoint durability/reload, disposition-aware continuation and background-delivery ownership under the updated policy.
- [x] C6 Run integrated behavioral regressions and real CLI/scripted-provider scenarios after both implementation slices land; record exact commands/results. No prompt wording/source-grep tests count as behavioral proof.
- [x] C7 Resolve the user's exact live selector `6-luna` using the existing configured catalog/alias rules and run authorized live acceptance on that route. Record resolved provider/id, effective W/H/R and capacity reserves, post-warning request count, selected milestone, hard-report result, reconstructed context, usage/cache fields and elapsed time. Do not substitute historical `openai-codex/gpt-6.1-sol` evidence or invented model metadata.
- [x] C8 Update proposal/design/spec, existing compaction/settings docs and changelog to the superseding semantics, then validate OpenSpec and map every current scenario to new evidence. Retain historical evidence dates/input applicability. Do not archive while unrelated global checks remain blocked.

### Current integrated regression evidence (2026-11-04)

The integration owner's final run reported **444 passed, 0 failed, 2,120 assertions across 11 files**, elapsed **35.44 seconds**, for:

```sh
env -u ANTHROPIC_BASE_URL bun test packages/agent/test/agent.test.ts packages/agent/test/agent-loop.test.ts packages/coding-agent/test/agent-session-qa-rollover.test.ts packages/coding-agent/test/qa-compaction.test.ts packages/coding-agent/test/context-notes.test.ts packages/coding-agent/test/settings-gated-tools-live.test.ts packages/coding-agent/test/experimental-context-management.test.ts packages/coding-agent/test/agent-session-compaction-cancellation.test.ts packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts packages/coding-agent/test/compaction-speculation.test.ts packages/coding-agent/test/advisor-context-maintenance.test.ts
```

| Current requirement / scenarios | Exercised regression evidence |
|---|---|
| Fixed warning/stop; autonomous later milestone; warning deduplication | Session fixture uses a 300K window and a deliberately different 100K general trigger; exact 120K boundary, more than three warned ordinary requests, later accepted checkpoint, terminal Q&A above the general trigger but below the QA warning does not trigger pre/post-turn fallback |
| Reserved hard reporting; ordinary tools denied; report preserved | Exact 200K report-only tool choice, optional 8,192-token output cap or successful reporting without a supported cap, ordinary/mixed/text/invalid report responses, settled synchronous tool result, accepted report reconstructed after QA, aborted/provider-denied transport retry visibly pauses without being treated as user cancellation |
| Model-capacity safety; recovery below warning | 200K and 20K window clamps, zero configured reserve, unsafe report-input limit, exact smaller-window warning, giant-result raw preservation, fixed/Q&A floors above the 96K recovery target; configured soft fallback with fixed 100K context and a higher 250K general trigger cannot continue above the QA recovery target |
| One continuation; queued input/cancellation/background ownership | Queued-input, abort-before-checkpoint/commit and async-result-during-commit scenarios in both soft and hard-report modes; dispositions, persistence failures, late notifications and journal reopen |
| Generic request restrictions and existing modes | Core Agent additional-gate composition retains forced tool choice and minimum output cap; existing agent-loop, experimental context, queue, cancellation, speculation and advisor suites |

The first integrated run reported 120 passed/12 failed. Fixture defects were corrected before the passing run: direct hard-report messages now supply the scripted cycle identifier; the giant-result payload stays below the existing 500KB journal truncation cap while exceeding actual safe report capacity; and the smaller-window exact boundary includes the default 16,384-token reserve rather than assuming only a 15% reserve.

Intermediate integration evidence remains scoped to its inputs: the earlier run passed 440 tests/2,075 assertions in 18.55 seconds before the final optional-cap, provider-denial, post-turn-trigger and fallback-recovery regressions. A subsequent run reported 442 passed/1 failed because the retry fixture threw a generic transport error instead of streaming the actual aborted/provider-denied envelope. After that correction, an import mistake caused the target file not to load while 391 other tests passed; the fixture now imports the existing error module namespace. The final 444-test run above includes all corrections without weakening the visible-pause/raw-preservation assertions.

The integration owner also reported:

- `bun run --filter @oh-my-pi/pi-agent-core --filter @oh-my-pi/pi-coding-agent --sequential check:types`: both packages passed (engine 9.71s, coding-agent 52.43s).
- Owned seven TypeScript files passed `oxlint`. The final `oxfmt` check found only the latest QA test edits; that file was formatted successfully and the other files were already clean.
- The live executable `.omp-qa-luna-smoke-20261104.ts` and temporary prompt/tool-description sources were removed after proof; consolidated evidence, complete journals, usage JSON and failed probes remain at the recorded paths.

Scoped type/lint/format success does not erase the historical unrelated repository-wide Bot/launch blockers; no global all-green result or archive is claimed.

Current strict OpenSpec validation: `openspec validate add-milestone-qa-compaction --strict --no-interactive` **passed**, reporting `Change 'add-milestone-qa-compaction' is valid`. The immediately preceding owner run failed because the recovery requirement exceeded the strict 500-character text limit; its accounting, warning-relative recovery, fallback and no-loop semantics were retained in concise requirement text, with the 96K-versus-160K numeric example moved into a scenario before the passing rerun.

### Current actual CLI/scripted-provider acceptance (2026-11-04)

`/tmp/omp-qa-policy-runtime-verified.json`, observed at `2026-11-04T14:19:17.925Z`, records **21 passed actual isolated CLI/RPC scenarios**. It contains every exact invocation, per-scenario evidence directory, provider-request sequence, executions, checkpoint ids and compaction boundaries. This is a loopback OpenAI-compatible scripted provider with deterministic billing occupancy, not live-provider compliance or cost evidence.

Nominal fixture: window 300,000, general configured trigger 100,000, W=120,000/H=200,000/R=96,000, report-input limit 255,000. Capacity fixture: window 200,000, explicit reserve zero, W=120,000/H=165,904/R=96,000, report-input limit 170,000.

| Exercised cases | Observed result / indexed evidence |
|---|---|
| `later-milestone` | Five ordinary post-warning calls, then the sixth warned request records the chosen checkpoint; one QA boundary and continuation. Eight total requests; `/tmp/omp-qa-policy-runtime/later-milestone` |
| `hard-report` | One report-only attempt, one accepted checkpoint/QA boundary and one continuation; supported output-cap fixture uses 8,192. `/tmp/omp-qa-policy-runtime-v2/hard-report` |
| `hard-mixed`, `hard-ordinary`, `hard-text`, `hard-invalid` | One report attempt per case; no additional ordinary execution, accepted checkpoint or QA boundary. Raw work remains recoverable; v2 case directories |
| `report-http-failure`, `report-cancel` | HTTP 500 permits one actual report attempt and visible safe pause; true user cancellation preserves stop semantics. No checkpoint/boundary; `/tmp/omp-qa-policy-runtime-v4/` |
| `capacity-clamp`, `capacity-overflow` | Safe earlier stop reports and continues once; unsafe capacity dispatches no report. v2 case directories |
| `queued-input`, `hard-queued-input`, `job-race`, `hard-job-race` | New user input owns resumption; background delivery is consumed once across soft/hard commits. Soft cases under v2, hard cases under v5 |
| `complete`, `blocked`, `auto-continue-off`, `natural`, `abort` | Checkpoint dispositions and user controls suppress inappropriate continuation; natural completion/abort create no QA boundary. v2 case directories |
| `no-progress`, `fallback` | QA-only visibly pauses without hidden summary; configured soft fallback commits once with retained checkpoint evidence. No-progress under v2; fallback under v5 |

Representative exact invocations (the consolidated index records all 21):

```sh
bun /tmp/omp-qa-policy-smoke.mjs --repo /Users/gl/agentworks/oh-my-pi --out /tmp/omp-qa-policy-runtime --scenario later-milestone
bun /tmp/omp-qa-policy-smoke.mjs --repo /Users/gl/agentworks/oh-my-pi --out /tmp/omp-qa-policy-runtime-v2 --scenario hard-report
bun /tmp/omp-qa-policy-smoke.mjs --repo /Users/gl/agentworks/oh-my-pi --out /tmp/omp-qa-policy-runtime-v4 --scenario report-http-failure
bun /tmp/omp-qa-policy-smoke.mjs --repo /Users/gl/agentworks/oh-my-pi --out /tmp/omp-qa-policy-runtime-v5 --scenario fallback
```

CLI acceptance exposed and fixed two additional runtime defects: report retry admission denial was incorrectly bypassing maintenance as a user abort, and post-turn QA-first maintenance was still applying the lower general trigger before the QA watermark. Targeted reruns passed afterward. Temporary executable and checkpoint-gate extension sources were removed; raw RPC, journals, payloads, effective configuration and results remain at the indexed paths.

### Current live `6-luna` acceptance (2026-11-04)

Command: `bun .omp-qa-luna-smoke-20261104.ts`. Consolidated evidence: `/tmp/omp-qa-luna-policy-verified.json`. The exact requested selector `6-luna` resolved through the configured registry to **`openai-codex/gpt-6-luna`**, context window **272,000**. Both final scenarios passed on the live route, not scripted inference.

Effective W=120,000/H=200,000/R=96,000; safe report-input limit 231,200, normal safe output reserve 40,800, minimum reporting reserve 8,192 and report-prompt headroom 4,096. This route does **not** preserve a caller output cap, so no 8,192-token wire limit was requested; the ordinary model reserve, one admitted report attempt, forced sole-tool report and 4,096-token checkpoint-content bound still applied.

| Live scenario | Observed checkpoint and continuation | Context and timing |
|---|---|---|
| Autonomous milestone | Agent chose `new_context` on its first warned request with no forced tool choice; one accepted `continue` checkpoint and one QA commit. Nine total requests, one saved marker write, five dependent inspections and one verification; saved work was not repeated. | 122,991 before → 1,352 projected after; raw payload removed; 27,346 ms. `/tmp/omp-qa-luna-current-v2/milestone/evidence.json` |
| Hard report | One forced `new_context` report, with provider-visible tools restricted to `[new_context]`; report input 202,050/output 187. One accepted `continue` checkpoint and QA commit, then five sequential inspections and one verification. Nine total requests and one marker write/observation attempt; raw work was not repeated. | 202,237 before → 1,423 projected after; raw payload removed; 36,721 ms. `/tmp/omp-qa-luna-current-v4/hard-report/evidence.json` |

Each scenario had one request between its delivered warning/report notice and compaction. These live probes establish useful checkpoint/resumption on this route; the scripted CLI and deterministic session suites separately establish permission for more than three post-warning ordinary requests.

| Scenario total, provider-reported fields | Input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|
| Milestone | 130,727 | 243 | 3,968 | 0 |
| Hard report | 212,959 | 309 | 1,408 | 0 |

Projected retained counts are local estimates. No workload baseline, audited pricing comparison, or fixed monetary saving is inferred from these fields.

The consolidated index retains three failed probes and their applicability: `/tmp/omp-qa-luna-current/milestone/evidence.json` checkpointed/resumed but ambiguous fixture instructions caused an early final answer after one inspection; `/tmp/omp-qa-luna-current-v2/hard-report/evidence.json` exposed the overly restrictive output-cap support guard, subsequently fixed; `/tmp/omp-qa-luna-current-v3/hard-report/evidence.json` reported and compacted but a fixture counter mutated on a rejected redundant observation, subsequently corrected to count only actual saved writes. These failed probes are not presented as acceptance passes.

## Historical implementation checklist (before policy supersession)

All checked items in sections 1–6 below refer to the original ratio/request-quota implementation and the evidence recorded afterward, not current-policy acceptance.

## 1. Automatic QA selection and budget ownership

- [x] 1.1 Use LSP references to enumerate affected method/settings/event consumers; add `qaonly` to the existing automatic method choice and exhaustive dispatch without changing default order or experimental/manual behavior. Cover **Explicit QA-first configuration** with configuration/selection contract checks, including QA-only and configured later fallback.
- [x] 1.2 Implement the maintenance-owned cycle and resolved H/W/R guards using existing token accounting. Integrate pre-prompt, eligible mid-run, and post-turn boundaries; arbitrate speculation and invalidate on mode/model/generation changes. Cover **Early bounded warning** and **Verify reclaimed headroom before continuing**, including exact boundaries, small/unknown windows, fixed context, pending input, and stale provider usage after rewrite.

Dependency: 1.1 before 1.2. Deliverable: opt-in QA policy with one authoritative cycle and no changed default behavior.

## 2. Cooperative checkpoint boundary

- [x] 2.1 Add static warning and QA-specific tool/checkpoint templates following the repository prompt skill/conventions. Deliver a single trusted warning with cycle, headroom, allowance, and minimal-safe-milestone guidance through the existing steering mechanism. Count actual dispatched provider attempts, including retries, with a three-request limit. Cover **Early bounded warning** and **Small safe milestone rather than task completion** without wording tests.
- [x] 2.2 Extend `new_context` and tool-registration/type consumers with the design's QA input/output/error contract; keep experimental `{}` requests mode-specific. Enforce sole-tool acknowledgement at the dispatch boundary, current-cycle validation, size bound, identical-duplicate idempotence, and conflicting duplicate rejection. Cover **Explicit checkpoint acknowledgement** with malformed, stale, mixed-tool, duplicate, and third-request acknowledgement cases.
- [x] 2.3 Persist and flush versioned `qa-rollover-checkpoint` entries before success acknowledgement; invalidate stale ownership after awaits. Cover **Failure preserves the work boundary** with persistence failure and abort/reset/session-switch races.

Dependency: section 1. Deliverable: agent can stop at a truthful checkpoint; no implied commit and no unbounded drain loop.

## 3. QA projection, retention, and commit

- [x] 3.1 Share the existing QA preparation/commit primitive between manual and automatic callers without routing automatic maintenance through manual abort/disconnect. Retain latest-only checkpoint references, original Q&A, canonical state, and journal recovery across repeated compaction/reset/reload. Cover **Preserve Q&A and actionable state locally** with provider-visible reconstruction assertions; prove no summarization call on the QA path.
- [x] 3.2 Project complete post-QA context before mutation; require recovery headroom, preserve uncheckpointed active work on deadline/overshoot, advance only to later configured methods, and latch no-progress pauses. Pass accepted checkpoints into existing fallback summary inputs. Cover **Verify reclaimed headroom before continuing** with Q&A-dominated, fixed-context-dominated, giant-result, empty candidate, and no-fallback scenarios.

Dependency: section 2. Deliverable: a durable usable context boundary or an explicit safe pause, never a compact/continue loop.

## 4. Continuation and concurrent work

- [x] 4.1 Park the old loop on accepted rollover and give one owner the disposition-aware continuation. Preserve terminal-answer safeguards, `autoContinue=false`, queued-input precedence, and cancellation; prevent todo/goal recovery nudges from bypassing a blocked outcome. Cover **Checkpointed work resumes once** with continue/complete/blocked, natural final answer, and user input during commit.
- [x] 4.2 Reconcile canonical job state and pending deliveries at commit/resume without cancelling jobs or redelivering results. Cover **Background work retains ownership** with result arrival before checkpoint, during commit, and after context replacement.
- [x] 4.3 Exercise journal replay before/after commit and late hook/event failures. Cover **Failure preserves the work boundary**: committed context stays authoritative, no duplicate compaction/continuation, no provider call caused solely by reopening a checkpointed session.

Dependency: section 3. Deliverable: continuous unfinished work, preserved user control, and stable async ownership.

## 5. User-facing integration and runtime proof

- [x] 5.1 Update all existing auto-compaction event/type/renderer/RPC consumers for QA and checkpointing/blocked notices. Reuse sanitized, width-limited rendering; unknown counts remain unknown. Cover **Visible and cost-honest operation** without introducing a separate progress API.
- [x] 5.2 Run focused existing QA/compaction/experimental-context/continuation suites plus the new consumer-visible regression scenarios above once the integrated implementation is ready. Use `bun check` for type/build verification as appropriate; record exact commands and results, and keep tests full-suite-safe. Do not add prompt wording, source-grep, forwarding, or static-copy tests.
- [x] 5.3 Launch the actual CLI/TUI using an isolated session/configuration and an instrumented scripted provider. Exercise warning -> saved checkpoint -> local QA -> one continuation; capture provider requests, reconstructed context, journal boundary, and visible before/after/blocked states. Also exercise user abort, natural completion, QA-only no-progress, configured fallback, and a job delivery race. This runtime smoke is required in addition to tests.
- [x] 5.4 With an authorized live provider, validate that the warning yields a small useful checkpoint and resumed work does not repeat completed edits. Record model/route, effective settings, checkpoint request count, actual usage/cache fields, and elapsed time; do not convert missing prices into estimated savings. If provider access is unavailable, record that specific acceptance limit and leave this task unchecked.

Dependency: section 4; rendering work can proceed once its event contract is available. Deliverable: exercised end-to-end behavior, not only a compiling state machine.

## 6. User documentation and closure

- [x] 6.1 After smoke proof, update the existing compaction/user-settings documentation and `packages/coding-agent/CHANGELOG.md` Unreleased section. Explain QA-first selection, illustrative fixed budget, precedence, checkpoint costs, Q&A growth, fallback authorization, cancellation, and blocked recovery. Remove contradictory claims that QA is manual-only; retain truthful manual-mode docs.
- [x] 6.2 Remove temporary smoke scaffolding; run strict OpenSpec validation and map every requirement scenario to recorded runtime/test evidence. Archive only after all applicable acceptance work passes; planning validation and Mind-Test alone do not complete implementation.

## Planning evidence (2026-11-04)

These facts apply to the working tree inspected on this date, not to a released-version audit:

- `openspec list --specs` returned `No specs found`; this change introduces one cohesive capability.
- A direct `bun -e` smoke imported the real threshold resolver, QA preparation, and automatic method parser. Output: `{window:200000,trigger:170000}`, `{window:1000000,trigger:850000}`; QA retained `u,f`, omitted tool-bearing `t`, and preserved the terminal checkpoint text; parsing `["qaonly","soft"]` returned `["soft"]`.
- No model/provider request was used by that smoke. It verifies current local behavior only; the proposed automatic checkpoint protocol was not run.
- Default thresholds derive from an effective reserve of at least 15% of the window, subject to explicit reserve/small-window rules. They are capacity guards, not measured economic optima.
- No pricing audit, latency benchmark, live-provider compliance run, or cache-rebuild measurement was performed. Cost reasoning in design is qualitative; 90%/80% and the three-request allowance are proposed policy, not measurements.
- At planning time, Mind-Test covered ownership, warning deduplication, third-request acceptance, overshoot, final-answer suppression, async delivery, no-progress recovery, cancellation, and restart; runtime acceptance was unexecuted. Implementation evidence follows below.
- Planning validation: `openspec validate add-milestone-qa-compaction --strict --no-interactive` passed; `openspec status --change add-milestone-qa-compaction` reported 4/4 planning artifacts complete. This is structural/document completion, not implementation acceptance.

## Historical implementation evidence (2026-11-04, before policy supersession)

- Real CLI/RPC: `bun /tmp/omp-qa-rollover-smoke.mjs --repo /Users/gl/agentworks/oh-my-pi --out /tmp/omp-qa-runtime-final --scenario all` passed all nine scenarios: continue, complete, blocked, auto-continue-off, natural completion, abort, QA-only no-progress, authorized soft fallback, and real async-bash delivery racing the QA boundary. `/tmp/omp-qa-runtime-final/results.json` indexes provider payloads, raw RPC, journal entries, rebuilt context, observed counts, configuration, and timelines. Usage in this harness is scripted, not live economic evidence.
- `bun test packages/coding-agent/test/agent-session-qa-rollover.test.ts packages/coding-agent/test/context-notes.test.ts packages/coding-agent/test/settings-gated-tools-live.test.ts`: 52 passed. Covers exact W/H boundaries, unknown/tiny windows, mode selection, retry allowance/third-request acknowledgement, malformed/stale/mixed/duplicate checkpoints, persistence failure/cancellation/config/model races, canonical reconstruction, dispositions, queued-user precedence, fallback and async delivery.
- `env -u ANTHROPIC_BASE_URL bun test packages/coding-agent/test/compaction-speculation.test.ts packages/coding-agent/test/advisor-context-maintenance.test.ts`: 61 passed. Unsetting the inherited DeepSeek Anthropic proxy is necessary for the existing native-Anthropic fixtures; the initial proxy-scoped run correctly made native compaction unavailable.
- The initial live `openai-codex/gpt-6.1-sol` probes saved the marker exactly once and durably compacted, but incorrectly selected `complete` while verification remained. `/tmp/omp-qa-live-evidence-first.json` and `-second.json` retain those failed probes. The strict nested union was replaced by one disposition-enum object, optional nextAction and runtime conditional validation with explicit field guidance; both subsequent live continuation probes passed.
- Runtime defects found and fixed before acceptance: staging a QA boundary must not invalidate its own persistence guard; a successful configured fallback must report its committed rewrite; automatic summaries must honor the side-stream transport; follow-up input must be admitted before resuming a QA boundary; independent idle job delivery must clear the QA parked state.

| Requirement / scenarios | Evidence |
|---|---|
| Explicit QA-first configuration; existing mode precedence | Method selection, live tool-gating, experimental-context suites; QA-only CLI no-progress makes no summary request |
| Early bounded warning; nearest safe milestone | Session exact W/H, allowance and third-attempt scenarios; actual CLI warning/checkpoint requests; provider retry admission tests |
| Explicit checkpoint acknowledgement | Tool/session malformed, stale, mixed, duplicate/conflict and persistence-failure scenarios |
| Preserve Q&A/actionable state; repeated reset/reload; terminal answer | `qa-compaction.test.ts`, session journal-reopen test, CLI continue/natural |
| Verify reclaimed headroom | Session fixed/Q&A floors and overshoot; CLI no-progress/fallback |
| Resume once; user input; complete/blocked/disabled | Session queued-user race and dispositions; CLI continue/complete/blocked/auto-continue-off |
| Failure preserves boundary; restart | Session atomic-write failure/abort/model/config races and late-notification/reopen; shared compaction-cancellation/atomic-journal suites |
| Background work retains ownership | Session owned async-result race; CLI real bash completion between checkpoint and replacement, one journaled delivery |
| Visible/cost-honest operation | Actual CLI notice/count traces, renderer/controller regression suites, generated wire contract, `docs/compaction.md` and `docs/settings.md` |

### Historical final verification

- Consolidated regression command (533 passed, 0 failed, 2,517 assertions):
  `env -u ANTHROPIC_BASE_URL bun test packages/agent/test/agent.test.ts packages/agent/test/agent-loop.test.ts packages/coding-agent/test/agent-session-qa-rollover.test.ts packages/coding-agent/test/qa-compaction.test.ts packages/coding-agent/test/context-notes.test.ts packages/coding-agent/test/settings-gated-tools-live.test.ts packages/coding-agent/test/experimental-context-management.test.ts packages/coding-agent/test/agent-session-compaction-cancellation.test.ts packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts packages/coding-agent/test/agent-session-goal-midrun-compaction.test.ts packages/coding-agent/test/compaction-speculation.test.ts packages/coding-agent/test/advisor-context-maintenance.test.ts packages/coding-agent/test/modes/controllers/event-controller-compaction-scrollback.test.ts packages/coding-agent/test/modes/components/compaction-summary-message.test.ts packages/coding-agent/test/session-manager-atomic-rewrite-race.test.ts packages/coding-agent/test/bedrock-compaction-method-selection.test.ts packages/ai/test/openai-responses-stream-retry.test.ts packages/coding-agent/test/rpc-session-events.test.ts packages/coding-agent/test/rpc-frame.test.ts`
- `uv run --project sdk/python/omp-rpc python -m unittest discover -s sdk/python/omp-rpc/tests -p test_protocol.py`: 31 passed. The initial pytest invocation did not run tests because that environment has no pytest; this suite uses unittest.
- `bun run --filter @oh-my-pi/pi-tui --filter @oh-my-pi/pi-wire --filter @oh-my-pi/collab-web --sequential check:types`: passed. The engine type check also passed during the affected-package type run. Scoped changed-integration lint/format passed.
- `bun check` was run, not reported green: unrelated `src/bots/*`, `src/launch/*` and their tests have formatting failures; its Rust sibling was interrupted when TS checking failed. The owned checkpoint-tool formatting was fixed. Direct primary/AI type checks expose unrelated `bots/agent-runtime.ts` initialization, `bots/store.ts` database API and `launch/broker.ts` narrowing failures, plus Bot/launch test typing failures. These files were not changed for this feature. The final primary type check reported no remaining errors in this feature's files.
- `openspec validate add-milestone-qa-compaction --strict --no-interactive`: passed.
- Temporary live/CLI executable scaffolds, diagnostic output and standalone prompt files were removed after proof; captured evidence and isolated session journals remain under the recorded temporary paths. No user configuration was changed, no commit created, and the change remains unarchived.

### Historical live saved-edit acceptance (not `6-luna` or current-policy proof)

`bun .omp-qa-live-smoke-20261104.ts` used the authorized `openai-codex/gpt-6.1-sol` route, low reasoning, isolated workspace/session, `methodOrder: [qaonly]`, auto-continue enabled, and disabled model-threshold overrides, speculation, retry, promotion, memory, advisors and auxiliary inference. The fixture set its threshold from actual occupancy plus local observation tokens to open the warning band; it is not a recommended working budget.

Final evidence: `/tmp/omp-qa-live-evidence.json`; isolated journal `/var/folders/w6/xvny1q5j3_s4gyr66qqfg5l40000gn/T/omp-qa-live-hInGOg/sessions`. H=13,351, W=12,015, R=10,680; elapsed 17,388 ms. One actual warning-carrying checkpoint request. Tool sequence `observe` (inspect + durable marker save) → `new_context` → `verify_marker`: saved edit exactly once, verification exactly once, one accepted `continue` checkpoint and one QA boundary. Recorded context counts were 12,657 before and 1,309 projected after; no summary request. The earlier observed-work continuation success is retained in `/tmp/omp-qa-live-evidence-observation.json`.

| Actual provider request | Input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|
| Observe/save | 1,126 | 27 | 0 | 0 |
| Checkpoint | 11,411 | 222 | 1,024 | 0 |
| Resume/verify | 1,426 | 28 | 0 | 0 |
| Final answer | 200 | 35 | 1,280 | 0 |

These are provider-reported usage fields for this probe. Projected retained context is a local estimate; no baseline workload or fixed monetary saving is claimed.

# Milestone QA Compaction

## Purpose

Let ongoing agent work cross context boundaries with a bounded safe checkpoint, locally preserved Q&A and operational state, and controlled automatic continuation rather than waiting for context exhaustion.

## ADDED Requirements

### Requirement: Explicit QA-first configuration

The system SHALL accept `qaonly` in the ordered automatic compaction methods without changing existing defaults or manual compaction semantics. Cooperative QA rollover SHALL require automatic compaction, QA as the selected method, and an eligible execution boundary. Experimental notes-backed management SHALL retain precedence when enabled.

#### Scenario: Opting in without hidden paid fallbacks
- **WHEN** a user selects only `qaonly`
- **THEN** automatic QA compaction is available and no unconfigured summarizer is invoked

#### Scenario: Existing modes remain authoritative
- **WHEN** automatic compaction is disabled, another method is selected, or experimental notes-backed management is enabled
- **THEN** this feature does not initiate a QA warning cycle or alter the existing mode's behavior

### Requirement: Early bounded warning

For an eligible active request, the system SHALL issue one model-visible soft warning per cycle at 120,000 input-context tokens, clamped to leave a usable cooperative interval within actual model capacity. It SHALL let the agent choose the nearest appropriate milestone and record saved work, evidence, incomplete work, and the next action. It SHALL state the effective ordinary-work stop and token headroom without imposing a provider-request quota.

#### Scenario: Crossing the warning watermark
- **WHEN** a tool-loop boundary first observes context at or above the warning watermark but below the hard limit
- **THEN** the next provider request receives one warning and the user sees a checkpointing status
- **AND** repeated maintenance checks do not enqueue duplicate warnings

#### Scenario: Idle conversation
- **WHEN** a completed or user-blocked conversation is idle above the warning watermark
- **THEN** the system does not start a provider request merely to obtain a checkpoint

### Requirement: Small safe milestone rather than task completion

The warning SHALL NOT impose a three-request or other request-count deadline. The agent SHALL choose a nearby appropriate checkpoint rather than being required to finish the entire task, an arbitrary todo phase, all verification, or all background jobs. At 200,000 input-context tokens, or an earlier capacity-safe limit that reserves room for reporting, the system SHALL stop ordinary work at the next settled synchronous-tool boundary.

#### Scenario: Agent chooses a later appropriate milestone
- **WHEN** more than three provider requests after the warning are useful to reach the chosen nearby milestone and context remains below the effective ordinary-work stop
- **THEN** those ordinary requests remain permitted and a later valid checkpoint can trigger QA compaction

#### Scenario: Hard boundary requires an explicit report
- **WHEN** context reaches the effective ordinary-work stop before a checkpoint has been accepted
- **THEN** the next admitted request is a bounded report-only attempt restricted to `new_context` as the sole tool call
- **AND** ordinary tool calls in that response are not executed
- **AND** an accepted report durably preserves saved work, incomplete work and the next action before local QA and normal continuation

#### Scenario: Reporting cannot safely fit
- **WHEN** a completed tool result, pending input, or fixed context leaves insufficient actual model capacity for the reserved report request
- **THEN** no unsafe request is dispatched and raw uncheckpointed work is preserved for only configured fallback methods or a visible safe pause

#### Scenario: Provider does not support a per-request report output cap
- **WHEN** a report request fits the model's actual safe capacity but its route or required thinking configuration cannot honor an 8,192-token output cap
- **THEN** the system admits the same single sole-tool report attempt using normal provider output behavior without sending an unsupported parameter
- **AND** the normal safe model reserve and 4,096-token checkpoint-content cap remain authoritative

#### Scenario: Report attempt fails or ignores the restriction
- **WHEN** the bounded report attempt fails, is invalid, or does not provide the required checkpoint
- **THEN** ordinary work is not restored and no unbounded report retry loop starts
- **AND** only configured fallback methods or a safe pause may follow

### Requirement: Explicit checkpoint acknowledgement

The QA variant of `new_context` SHALL accept a cycle identifier, nonempty work summary, disposition (`continue`, `complete`, or `blocked`), and a next action required for `continue`. A checkpoint SHALL be accepted only for the current session cycle and as the sole tool call in its assistant response. Acceptance SHALL acknowledge durable recording, not successful compaction.

#### Scenario: Active work records a continuation checkpoint
- **WHEN** the agent submits a valid current-cycle checkpoint describing saved work, observed evidence, uncertainty, and remaining work
- **THEN** the checkpoint is durably recorded before any history rewrite and its next action is available after rollover

#### Scenario: Invalid or stale acknowledgement
- **WHEN** the request is malformed, refers to an old cycle, or shares a response with another tool call
- **THEN** the request returns a specific error and cannot trigger QA rollover or extend the bounded hard-report attempt

#### Scenario: Duplicate acknowledgement
- **WHEN** the same checkpoint is submitted again for the same cycle
- **THEN** it does not append another checkpoint or schedule another continuation
- **AND** different checkpoint content under the same cycle identifier is rejected as a conflict

### Requirement: Preserve Q&A and actionable state locally

QA compaction SHALL preserve user requests, terminal assistant answers, the latest accepted checkpoint, canonical todos, plan/goal state, and running/pending job identities within the active reset boundary. It SHALL remove intermediate reasoning and tool payloads from provider context without deleting their durable journal. The QA transformation SHALL make no summarization model call.

#### Scenario: Findings exist only inside tool work
- **WHEN** the agent records those findings in an accepted checkpoint before QA compaction
- **THEN** the next provider request contains the checkpoint and canonical state but not the discarded tool payloads

#### Scenario: Repeated compaction and reset
- **WHEN** a second QA rollover occurs
- **THEN** historical Q&A remains recoverable and the latest checkpoint replaces the prior operational checkpoint rather than accumulating checkpoint copies
- **AND** a later reset boundary excludes all earlier checkpoints and Q&A

#### Scenario: Natural terminal answer
- **WHEN** the agent finishes normally instead of submitting a checkpoint
- **THEN** the terminal answer remains preserved and a warning alone does not reinterpret it as unfinished work or cause an extra continuation

### Requirement: Verify reclaimed headroom before continuing

The system SHALL count fixed instructions, tool schemas, retained Q&A, checkpoint, operational state and pending input in reconstructed provider context. QA-first work SHALL resume only at or below 80% of the effective warning watermark, including after configured fallback methods. The recovery limit SHALL NOT derive from the hard stop or general trigger. No-progress candidates SHALL NOT cause repeated compact/continue cycles.

#### Scenario: Q&A alone is too large
- **WHEN** retained Q&A or fixed context prevents sufficient recovery
- **THEN** QA is treated as unable to recover and only later configured methods are attempted
- **AND** if none succeeds, the system pauses once with the retained-size reason and available remedies

#### Scenario: Nominal warning defines recovery
- **WHEN** the effective warning is the unclamped 120,000-token watermark and the ordinary-work stop is 200,000 tokens
- **THEN** automatic continuation requires reconstructed context at or below 96,000 tokens
- **AND** a 160,000-token candidate is not recovered even though it is 80% of the ordinary-work stop

#### Scenario: A configured fallback cannot meet QA-first recovery
- **WHEN** QA selects a later configured method but fixed context still exceeds the QA warning's recovery margin, even if it fits a higher general trigger's recovery band
- **THEN** the system does not resume ordinary work or start another warning loop
- **AND** it visibly pauses with the remaining recovery limit rather than treating the fallback as permission to relax that limit

### Requirement: Checkpointed work resumes once

After a successful QA commit, unfinished checkpointed work SHALL automatically resume once when auto-continue is enabled. Completion or blocking dispositions SHALL not generate work. Queued user input SHALL take priority over a synthetic continuation; cancelled, replaced, or superseded sessions SHALL not resume stale work.

#### Scenario: Checkpoint is not a final answer
- **WHEN** a `continue` checkpoint commits successfully and no newer user input exists
- **THEN** exactly one continuation receives its summary and next action, even though the agent deliberately stopped ordinary work

#### Scenario: User changes direction during compaction
- **WHEN** user input is queued while compaction is running
- **THEN** that input drives the next request without an additional synthetic continuation and overrides conflicting checkpoint instructions

#### Scenario: Completion, blocking, or auto-continue disabled
- **WHEN** the checkpoint disposition is `complete` or `blocked`, or auto-continue is disabled
- **THEN** no synthetic work request is generated; existing user-input and job-delivery mechanisms remain available

### Requirement: Failure preserves the work boundary

A failed or cancelled checkpoint persistence or compaction SHALL preserve a recoverable pre-commit conversation. A committed result SHALL remain authoritative even if a later notification fails. Manual compaction, reset, session switch, and user abort SHALL invalidate the automatic cycle and its pending synthetic continuation.

#### Scenario: Persistence fails
- **WHEN** saving the checkpoint or compaction boundary fails
- **THEN** the system reports the failure, does not claim successful rollover, and does not continue from an uncommitted context

#### Scenario: Restart around commit
- **WHEN** the process restarts before or after the compaction commit
- **THEN** journal replay selects the last committed boundary and does not automatically reissue uncertain work or a consumed checkpoint

### Requirement: Background work retains ownership

QA rollover SHALL neither cancel nor duplicate background jobs. It SHALL retain running identities and pending-delivery ownership, and SHALL deliver results arriving during rollover through the existing delivery mechanism without losing or duplicating them.

#### Scenario: Result arrives between checkpoint and commit
- **WHEN** a job finishes after the checkpoint is recorded but before context replacement
- **THEN** the rebuilt context and subsequent delivery reflect the latest job state and the result is delivered once

### Requirement: Visible and cost-honest operation

The user SHALL be able to distinguish checkpointing, compacting, resumed, and blocked states through existing session surfaces. Documentation SHALL distinguish local QA transformation from paid checkpoint/continuation requests and cache rebuild costs, and SHALL not promise a bounded Q&A history or a fixed monetary saving.

#### Scenario: Reviewing an automatic rollover
- **WHEN** a QA rollover succeeds or blocks
- **THEN** the session shows its method, observed before/after context counts when available, and continuation or pause outcome
- **AND** unavailable counts are not displayed as zero or invented savings

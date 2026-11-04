# Proposal

## Why

Before this change, omp supported automatic compaction and continuation but exposed its no-summary-model `qaonly` mode only manually. Long tool loops need an early opportunity to choose a useful nearby milestone and record working knowledge before tool history is removed. A soft warning should not become an arbitrary request deadline; an ordinary-work stop must still leave room for an explicit report within the model's actual capacity.

## What Changes

- Make `qaonly` selectable in the existing automatic compaction method order. Preserve the current default order and manual `/compact qaonly` behavior.
- When QA is the selected automatic method, warn at 120,000 input-context tokens, bounded by actual safe model capacity. Let the agent choose the nearest appropriate milestone and record completed work, evidence, unfinished work, and the next action.
- Allow ordinary work after the warning without a request-count quota. At 200,000 tokens, or an earlier capacity-safe boundary, stop ordinary work and admit only one bounded report attempt using the existing `new_context` checkpoint. Reserve room for that report; if it cannot safely fit, preserve raw work and pause or use only configured fallback methods.
- Extend the existing `new_context` acknowledgement surface for a structured QA checkpoint; keep experimental notes-backed rollover separate and unchanged.
- Preserve the checkpoint alongside existing Q&A and canonical operational state. Compact locally, then resume unfinished work once, honoring user cancellation, new instructions, approvals, and async jobs.
- If QA cannot safely remove enough context, try only later configured methods; otherwise pause with an actionable explanation. Do not silently enable paid summarization.
- Expose warning, compaction, continuation, and blocked states through existing session notices/events. Document fixed warning/stop semantics, capacity clamping, autonomous milestone timing, and cost/retention limits.

## Capabilities

### New Capabilities

- `milestone-qa-compaction`: cooperative, bounded checkpointing and Q&A-only context rollover during ongoing work.

### Modified Capabilities

None. At planning time, the repository had no registered main specifications (`openspec list --specs`).

## Impact

- Primary ownership: `packages/coding-agent/src/session/session-maintenance.ts`; existing method/config, journal/context reconstruction, continuation, tool registration, and TUI/RPC event consumers.
- Reuse `prepareQaCompaction`, compaction commit/rebase machinery, token accounting, and `new_context`; no second scheduler or summarization service.
- Existing settings acquire a new method choice. The QA variant of `new_context` adds a typed checkpoint payload; the experimental empty request remains valid only in its existing mode.
- No new dependencies, default model changes, global threshold changes, or user settings mutations.

## Non-goals

Adaptive pricing optimization, automatic large-window promotion, changing all users to QA-first, replacing the experimental notes backend, compressing historical Q&A itself, killing background jobs, or claiming a measured dollar saving. Implementation evidence and verification limits are recorded in tasks; the change is not automatically archived.

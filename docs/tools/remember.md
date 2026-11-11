# remember

> Append one long-term memory line that survives a context cut.

## Availability

`remember` shares the `checkpoint.enabled` gate and essential visibility of [`rewind`](./rewind.md). Unlike `rewind` and `thinknote`, it changes nothing that is already in context: the call sits in the stream like any other tool call, and its line is stored so the harness can re-inject it after the next cut.

## Inputs

`remember({line})` requires `line`:

- Whitespace is collapsed and trimmed: a multi-line draft occupies one line.
- Longer than 400 characters → rejected with the actual length and a request to rewrite under 200. Nothing is truncated.
- Empty after trimming → rejected.
- More than 20 lines accepted this day → rejected; merge or select instead of appending.

The result reports `N/20` and the character count, and says when the line exceeded the 200-character hint.

## What belongs in a line

A line is admitted only when all three hold:

1. The repository cannot tell it: code, config and git already are memory.
2. It changes a later decision.
3. It compresses into one sentence.

Typical kinds: a surprising measurement, a convention that must not be re-derived, a disproved path and why, an incident lesson or user correction, a structural blocker, a user constraint. Code structure, API names, file lists and todo detail do not belong here.

## Behavior

Each accepted line is persisted as a `context-memory-line` custom entry in the session file, so a resumed session keeps it and a rewind does not delete it. The daily count covers the whole session, including lines recorded on a branch that was later abandoned.

The tool never cuts, rewrites, merges or deletes a line. Curation is initiated by the harness, not by the model.

After a fold or a compaction replaces the context, the harness injects the stored lines together with the last four day notes as one `context-memory-block` notice at the new day start. The block is created once per context: the next cut removes it and the next day re-creates it, so recorded lines survive without a retrieval step.

## Source

- Entry: `packages/coding-agent/src/tools/remember.ts` (`RememberTool`)
- Limits, types and parsing: `packages/coding-agent/src/session/context-memory.ts`
- Session behavior: `AgentSession.rememberContextLine`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/remember.md`
- Design: [`docs/context-memory.md`](../context-memory.md)

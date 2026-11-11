# thinknote

> Replace or drop the current turn's reasoning for the next provider request, without cutting the conversation.

## Availability

`thinknote` shares the `checkpoint.enabled` gate and essential visibility of [`rewind`](./rewind.md). It applies to the assistant turn that contains the call; `rewind` is the tool for removing tool chains and earlier exploration.

## Inputs

`thinknote({note})` requires `note`:

- `note`: nonempty string → replace the turn's reasoning when `noteTokens × 4 ≤ thinkTokens`.
- `note: null` → drop the reasoning.

The decision is made at message end, before the turn's tools run:

- No plaintext reasoning (signed Anthropic/Responses reasoning, encrypted blocks, or no thinking at all) → kept.
- The note is not small enough → kept, with the token counts in the result.
- Otherwise a hidden `think-note` marker is persisted directly after the assistant entry.

## Behavior

The persisted assistant message keeps the full reasoning: the transcript, session reloads and display rebuilds are unchanged. Only the LLM view rewrites the turn—`convertToLlm` replaces the reasoning with the note (or removes it) when the following entry is the marker. The marker itself contributes no message to the request, and `/context` sees the rewritten form.

This is deliberately not a cut: the tool results after the turn stay in context, so a subsequent edit or verification still has the exact output. It also does **not** satisfy the instruction fold timings or the QA rollover gate—only a `rewind` cut does, because those boundaries exist to drop tool chains.

## Cost

The note is output tokens plus its first replay as input; the reasoning it replaces is first-replay input (and cache-read on later turns). The 4:1 ratio reflects DeepSeek flash pricing (output 1.20 vs input 0.30 USD/1M). A note replayed inside the tool-call arguments is a second input copy, so hiding the call would allow a 4:1 ratio instead of roughly 6:1.

## Source

- Entry: `packages/coding-agent/src/tools/think-note.ts` (`ThinkNoteTool`)
- Marker and rewrite: `packages/coding-agent/src/session/think-note.ts`
- Application: `AgentSession.#applyThinkNoteOnMessageEnd`
- Conversion: `packages/coding-agent/src/session/messages.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/think-note.md`

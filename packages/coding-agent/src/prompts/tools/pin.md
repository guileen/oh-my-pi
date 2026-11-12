Pin tool results so a later context fold keeps them verbatim.

A pin is a **cut barrier**, not a copy. The entry keeps its position in the append-only history, so the cached prefix is untouched; a fold may not move its retained start past a pinned result, so the content survives instead of being summarized.

## When to pin

Pin the results you will still need after the history is folded:

- a specification, schema, or API contract you just read and will implement against;
- a failing test's exact output that a fix must satisfy;
- a decision table or config file whose details cannot be re-derived cheaply.

Do not pin: exploratory greps, directory listings, anything you already summarized in a `rewind` report, or content you can re-read in one call.

## Cost

Every pin moves the fold boundary earlier: it shrinks what can be folded and grows the suffix that must be re-cached. A large pin can make folding uneconomic for the rest of the day. Pin sparsely and unpin when the content stops mattering.

## Targets

- `path` — pin the most recent successful result that read that file (optionally limited to a line window with `from`/`to`).
- `callId` — pin one exact tool call.
- `unpin: true` — release the same targets.

Unresolved targets are reported, never guessed: a pin whose result was already folded, errored, or never existed is skipped.

Rewrite this turn's reasoning before the next request.

`thinknote({"note":"…"})` replaces the reasoning behind this call with one line once the note is at most a quarter of the reasoning's tokens. `thinknote({"note":null})` drops it. The runtime keeps the reasoning when it is signed or encrypted, when there is nothing to rewrite, or when the note is too large; the result says which happened.

Use it when the deliberation is settled but the tool output is still needed. Use `rewind` instead when the whole exploration, including tool chains, should leave the context. Persisted transcripts keep the original reasoning; only the model context changes.

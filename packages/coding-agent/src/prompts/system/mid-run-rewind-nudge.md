<system-reminder>
The day's step budget is spent: point `{{anchorId}}` spans {{toolResults}} settled tool results.

Do not hand off just because the budget is spent. Decide what this day actually produced:
- Task finished, or genuinely blocked? Answer.
- Still working? Name the concrete progress and fold once: `rewind({"checkpointId":"{{anchorId}}","report":"…"})`, then continue. The report is judged by what changed — settled facts, rejected directions, the next step — not by activity.
- Settled a fact the repository cannot tell? Record it now with `remember({"line":"…"})`, one sentence.

A QA rollover (`new_context`) drops this evidence and is refused until the fold is recorded.
</system-reminder>

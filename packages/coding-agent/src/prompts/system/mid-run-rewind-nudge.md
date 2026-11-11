<system-reminder>
Instruction point `{{anchorId}}` already spans {{toolResults}} settled tool results. If their raw output is no longer needed, one handoff keeps the conclusions and drops the rest:

`rewind({"checkpointId":"{{anchorId}}","report":"…","nextAction":"…"})`

A QA rollover (`new_context`) drops this evidence and is refused until the fold is recorded.
Optional: keep working when the next step still needs that output.
</system-reminder>

<system-notice>
You are about to answer. Instruction point `{{anchorId}}` still spans {{toolResults}} settled tool results and was not folded.

Fold it before answering:
`rewind({"checkpointId":"{{anchorId}}","report":"…","nextAction":"…"})`

`report`: resolved decisions, `file:line` evidence and rejected directions. `nextAction`: what follows the fold, for example reporting the result. The instruction, report, selected evidence and receipts stay; exploration leaves. A fold with no net savings still records the decision without replacing history.
</system-notice>

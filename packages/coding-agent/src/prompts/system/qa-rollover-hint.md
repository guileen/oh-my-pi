Context: {{currentTokens}} tokens; forced handoff at {{hardTokens}}. No action required.

QA rollover cycle: `{{cycleId}}`.

You MAY checkpoint now to denoise. Checkpoint replaces working context with your summary: distilled findings survive; raw reads do not.
- Favor it when context is mostly noise: blind exploration, large mostly irrelevant files, failed approaches, unclear direction. A distilled restart is cheaper per request and sharper.
- Skip it when you are about to use what you just read (files being edited, code under comparison); re-reading costs more than carrying it.
- If you checkpoint: `new_context({checkpoint})` as the sole tool call, `checkpoint.cycleId: "{{cycleId}}"`. The summary MUST hold conclusions, not a reading log: what is true and where (file:line/symbol), ruled-out directions and why, the decision or open question, and the next concrete step. Set `disposition` and `nextAction` per the tool contract. Stop ordinary work after acceptance.

Context: {{currentTokens}} tokens; forced handoff at {{hardTokens}}. No action required.

QA rollover cycle: `{{cycleId}}`.

You MAY checkpoint now to denoise completed exploration, including long reasoning/tool chains. Selected original evidence survives separately; unselected exploration is replaced by your summary.

- A pending instruction rewind point takes precedence: fold it with `rewind` first. Rollover drops that evidence and is refused until the fold is recorded.
- Favor a settled decision, saved change or verified result with substantial disposable exploration.
- Select exact source needed next before folding; NEVER reread unchanged code merely to restore context.
- If you checkpoint: `new_context({checkpoint})` as the sole tool call, `checkpoint.cycleId: "{{cycleId}}"`. The summary MUST hold conclusions, not a reading log: what is true and where (file:line/symbol), ruled-out directions and why, the decision or open question, and the next concrete step. Set `disposition` and `nextAction` per the tool contract. Stop ordinary work after acceptance.

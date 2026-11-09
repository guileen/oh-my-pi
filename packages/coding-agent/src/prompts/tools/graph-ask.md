Ask one authorized Graph member using `to_member`, `text`, and a stable `request_key`.

Write the question so one answer unblocks your decision:

- Name the single decision the answer will settle, then the concrete evidence you already hold.
- Include the material the recipient needs inline or as `artifact_refs`; the recipient cannot read your workspace.
- Keep the message under 64 KiB.
- When you need the reasoning behind a recommendation, ask for it in the same message instead of sending a second question.

The call waits for the recipient's question, reply, final answer, or timeout. A delivered question is not a final answer; use `graph_reply` to answer it, and `graph_finish` only when the conversation is complete.

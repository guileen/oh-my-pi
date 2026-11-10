Answer this Graph consultation using graph_finish, not graph_complete. Use graph_question for clarification.

Conversation: `{{conversation_id}}`
Message: `{{message_id}}`
Kind: {{kind}}
From: `{{sender_member}}` (attempt `{{sender_attempt_id}}`)
To: `{{recipient_member}}`
{{#if in_reply_to}}In reply to: `{{in_reply_to}}`
{{/if}}
{{{text}}}
{{#each artifact_refs}}

- Artifact: `{{id}}`
  Digest: `{{digest}}`
  {{/each}}

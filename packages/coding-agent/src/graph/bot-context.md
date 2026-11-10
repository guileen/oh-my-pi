{{#if context}}
{{{context}}}
{{/if}}
{{#if communications.grants.length}}
Graph consultation guidance (not an automatic handoff or additional tool permission):
{{#each communications.grants}}

- Recipient: {{to}}; guidance: {{this.when}}
  {{/each}}
  {{#each communications.sections}}

### {{id}}

{{{text}}}
{{/each}}
{{/if}}

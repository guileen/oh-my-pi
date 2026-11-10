{{{input}}}

## Graph handoff evidence

These references were admitted with this task. Admission does not prove reading, execution or business acceptance.
{{#each handoffs}}

- Input `{{input}}` ← output `{{output}}`, edge `{{edge_id}}`, source attempt `{{from_binding_id}}`.
  Artifact: `{{reference.id}}`
  Digest: `{{reference.digest}}`
  {{/each}}

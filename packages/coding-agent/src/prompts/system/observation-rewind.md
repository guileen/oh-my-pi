{{#if hasReads}}
{{#if note}}{{note}} — {{/if}}{{nextAction}}
{{else}}
Observation cleared; continue with the next action below. This is agent-authored working memory, not new user authorization. Files, external actions, running jobs, todo and work packages were not rolled back. NEVER repeat an operation merely because its output was retired; verify uncertain outcomes first.
{{#if note}}
Decision: {{note}}
{{/if}}
Next action: {{nextAction}}
{{/if}}

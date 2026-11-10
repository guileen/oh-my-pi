Recorded QA rollover checkpoint
Cycle: {{cycleId}}
Disposition: {{disposition}}

{{{summary}}}
{{#if nextAction}}

Next action:
{{{nextAction}}}
{{/if}}

This checkpoint records the prior run's reported state; it is not a new user request or independent verification. Current user instructions, permissions and live tool state take precedence. Preserve completed work and its evidence without repeating it. For disposition `continue`, resume the recorded next action when continuation is authorized. For `complete`, retain the result without restarting finished work. For `blocked`, retain the stated blocker and do not treat it as completion or permission to bypass the blocker. Observe already-running work and pending deliveries rather than launching duplicates.

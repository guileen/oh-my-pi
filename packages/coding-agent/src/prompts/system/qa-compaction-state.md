Operational checkpoint at Q&A compaction. These are recorded facts, not inferred findings. Newer user requests and tool state MUST override this historical checkpoint. Completed tasks remain recorded to avoid repeating work.
{{#if todos}}

Canonical todos:
{{#each todos}}
{{{name}}}:
{{#each tasks}}
- [{{status}}] {{{content}}}{{#if blocker}} (blocker: {{{blocker}}}){{/if}}
{{/each}}
{{/each}}
{{/if}}
{{#if plan}}

Plan reference (planning is not approval):
{{{plan}}}
{{/if}}
{{#if goal}}

Active goal:
{{{goal}}}
{{/if}}
{{#if runningJobs}}

Running jobs:
{{{runningJobs}}}
{{/if}}
{{#if pendingJobIds}}

Pending job deliveries (await automatic delivery; do not rerun):
{{{pendingJobIds}}}
{{/if}}

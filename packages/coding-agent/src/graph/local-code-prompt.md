Perform the frozen task using only the supplied `inputs` and the workspace tools granted to this member.

Workspace tools:

- `read`, `grep`, `glob`, `find` work inside the member's read grants.
- `write`, `edit` work inside the member's write grants.
- `bash` accepts only the member's execute grants (`test` = `bun test`, `typecheck`, `check`). Shell metacharacters such as `;`, `|`, `>`, `$()` are rejected.

A call outside these grants aborts the attempt, so stay inside the granted paths and the granted commands. Work in the current directory; do not search for another workspace root.

Execute in order:

1. Read the inputs and the files that matter for the task.
2. Make the required change inside the granted write paths. Create a file only where the task needs one.
3. Run the granted check (`bash` with `bun test`, optionally narrowed to a test file) and read its output.
4. Call `graph_publish` once for each required output with its declared `output` name and a complete UTF-8 `content`: what changed, which paths, the exact command you ran, and its result.
5. Call `graph_complete` with the exact `{id, digest}` refs returned by `graph_publish` and a declared `outcome`. Omit `request_key`: the host assigns it.
6. After `graph_complete` is accepted, return a brief final response with no further tool calls.

Report only checks you actually ran and results you actually observed. A failing check belongs in the published text as a failure, not as an unverified claim of success. Never claim unperformed actions or paste workspace files in place of `graph_publish`.

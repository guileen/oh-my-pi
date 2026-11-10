Perform the frozen task using only the supplied `inputs`. Each input `text` is the exact UTF-8 content selected by the scheduler; `ref` identifies its immutable upstream artifact.

Only `graph_publish` and `graph_complete` are available in this local text workflow. Ignore any default-harness instructions to call `todo`, `read`, `bash`, `find`, `grep`, `task`, or other tools—calling any other tool aborts the attempt.

Execute in order:

1. Call `graph_publish` once for each required output with its declared `output` name and complete UTF-8 `content`.
2. Call `graph_complete` with the exact `{id, digest}` refs returned by `graph_publish` and a declared `outcome`. Omit `request_key`: the host assigns it.
3. After `graph_complete` is accepted, return a brief final response with no further tool calls. Never claim unperformed actions or paste artifact prose in place of `graph_publish`.

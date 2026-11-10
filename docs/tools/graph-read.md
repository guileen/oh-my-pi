# graph_read

Discover Graphs and observe authorized Runs. Source: `packages/coding-agent/src/tools/graph.ts`; operation details: `packages/coding-agent/src/prompts/tools/graph-read.md`.

Calls require `version: 1` and `operation`. `templates`, `workflows`, and `catalog` discover available contracts; `definition.get` reads a definition and `request.get` reconciles a receipt. Discovery does not grant execution authority.

`runs`, `status`, `report`, `events`, `notifications`, and `wait` read authorized Run state. `report` describes committed deliverables; readiness is not acceptance. Events use an `after` cursor; notifications use `since` and return `notification_cursor`. `wait` returns on a terminal state, a new committed notification, or timeout; it does not control the Run.

Run observation and execution receipts require their respective trusted-host authorization. Errors are structured failures, not empty successful results.

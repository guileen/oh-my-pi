# graph_manage

Author Graphs, publish text, and control authorized Runs. Source: `packages/coding-agent/src/tools/graph.ts`; operation details: `packages/coding-agent/src/prompts/tools/graph-manage.md`.

Every call requires `version: 1`, `request_key`, `operation`, `target_id`, `if_revision`, and `payload`. Reuse a stable request key to reconcile a request; conflicting reuse fails. Definition and Run mutations require the current revision.

- `create`, `import`, `edit`, `member.add`, `node.add`, `connect`, `permit`: author definitions. Create/import use null target and revision; import accepts Graph text or a bundled template.
- `start`: submit published input and authorization references to a Graph revision. `dispatch`: launch an admitted local Graph using its catalog binding path and literal inputs.
- `hold`, `resume`, `cancel`: control an authorized Run. Gate holds require an authorized decision reference; cancellation does not prove work stopped.
- `answer`: submit an authorized human decision. `artifact.publish`: publish literal text and use the returned immutable reference.

Start or dispatch acceptance is not task completion. Each operation requires its own trusted-host permission; observation does not grant mutation or execution authority.

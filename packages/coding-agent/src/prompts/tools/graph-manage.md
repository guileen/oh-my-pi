Author Graph definitions, publish text artifacts, and operate Runs with explicit trusted-host permission.

Operations: `create` `{name}`, `import`/`edit` `{content}`, `member.add`/`node.add` `{key,value,body}`, `connect`/`permit` `{value}`. Create/import require null target and revision; edits require the Graph ID and its current `if_revision`. Supply a stable `request_key`; replay the same request to reconcile, and use `graph_read` `request.get` for its receipt. Content is GRAPH.md text, not a file path. `import` also accepts `{template}` naming a bundled template from `graph_read` `templates`, which resolves to that template's content.

Use `create` with a name to author an empty Graph, or `import` with `{template}` to start from a bundled workflow. Use `templates` when no stored Graph fits the task and `catalog` when one may already be imported; dispatching a template requires importing it first.

Start uses the Graph ID and definition `if_revision`, with `{inputs:{name:{id,digest}},authorization_ref:{id,digest}}`; optional `entry_nodes` and `provided_outputs` require authorized provenance. References must already be published; a path or pasted file is not an artifact reference. Acceptance returns a queued Run, not workflow success.

Dispatch runs a Graph in a detached process and returns as soon as the Run is created. Use `dispatch` with the Graph ID, null `if_revision`, and `{title,bindings,inputs}`: `title` is the task label, `bindings` is the model-binding file path inside the session workspace taken from the Graph's `catalog` entry, and `inputs` maps each declared run input to literal text. Optional `max_model_calls`, `timeout_ms`, and `report_to` stay under the trusted policy ceiling. The reply carries the Run ID and the dispatch log path; observe progress with `graph_read` `runs` and `notifications`. A created Run is not a finished task.

Run controls require the Run ID and current `if_revision`: `hold` `{reason,kind?}`, `cancel` `{reason}`, `resume` `{kind:"operator"}` or `{decision_ref:{id,digest}}`.

`hold` defaults to `kind:"operator"`, a scheduling pause that the same principal lifts with `resume {kind:"operator"}`. `kind:"gate"` marks a hold that only an authorized immutable decision can resolve; resume it with `decision_ref` and expect `gate_unsatisfied` when the decision does not cover the current hold. Cancellation requests stop; it does not prove submitted work has stopped. Read access does not grant control. Missing lifecycle permission returns `capability_unavailable`; keep the original key and revision when reconciling a rejection.

Answer uses the Run ID and expected `if_revision`, with `{decision_id,input_digest,outcome,content_ref:{id,digest}}`; optional `verdict` and `evidence_refs` preserve explicit decision evidence. The trusted host must resolve the published answer and authenticate its author. This submits an authorized human decision; NEVER invent approval or substitute an Agent judgment for required human consent.

Publish text with `artifact.publish`, Graph or Run target, null `if_revision`, and `{content,media_type,expected_digest}` (`null` if no expected digest). Content is literal text, NEVER a local path; use the returned artifact reference for task inputs or answers. Binary/large files require the trusted artifact channel. Publication requires separate host permission and grants no execution or human approval.

Missing start/control/answer/publication permission fails closed; observation permission alone grants none.

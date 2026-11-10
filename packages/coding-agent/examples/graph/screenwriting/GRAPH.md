---
format: omp.graph/v1
name: screenwriting
members:
  editor:
    role: '#editor-role'
    model: gpt-6.1-sol
    base: omp-default
    duty: general
    permissions: {read: ['.'], write: ['artifacts'], execute: []}
  writer:
    role: '#writer-role'
    model: gpt-6.1-terra
    base: omp-default
    duty: general
    permissions: {read: ['.'], write: ['artifacts'], execute: []}
  reviewer:
    role: '#reviewer-role'
    model: gpt-6.1-sol
    base: isolated
    duty: review
    permissions: {read: ['.'], write: ['artifacts'], execute: []}
  adjudicator:
    role: '#reviewer-role'
    model: gpt-6.1-sol
    base: isolated
    duty: review
    permissions: {read: ['.'], write: ['artifacts'], execute: []}
nodes:
  prepare:
    kind: bot
    member: editor
    task: '#prepare-task'
    inputs: {brief: {run_input: task}}
    required_inputs: [brief]
    outputs: {draft: {media_type: text/markdown, required: true}}
    outcomes: [concept, structure, script]
  concept-review:
    kind: bot
    member: reviewer
    task: '#review-task'
    required_inputs: [draft]
    outputs: {assessment: {media_type: text/markdown, required: true}}
    outcomes: [pass, revise, author, hold]
    verdicts: [PASS, CONDITIONAL, FAIL, INSUFFICIENT_EVIDENCE]
    decisions: [{verdict: PASS, outcome: pass}, {verdict: CONDITIONAL, outcome: pass}, {verdict: FAIL, outcome: revise}, {verdict: FAIL, outcome: author}, {verdict: FAIL, outcome: hold}, {verdict: INSUFFICIENT_EVIDENCE, outcome: hold}]
    terminal: {hold: hold}
    required_gate: true
  structure-review:
    kind: bot
    member: reviewer
    task: '#review-task'
    required_inputs: [draft]
    outputs: {assessment: {media_type: text/markdown, required: true}}
    outcomes: [pass, revise, author, hold]
    verdicts: [PASS, CONDITIONAL, FAIL, INSUFFICIENT_EVIDENCE]
    decisions: [{verdict: PASS, outcome: pass}, {verdict: CONDITIONAL, outcome: pass}, {verdict: FAIL, outcome: revise}, {verdict: FAIL, outcome: author}, {verdict: FAIL, outcome: hold}, {verdict: INSUFFICIENT_EVIDENCE, outcome: hold}]
    terminal: {hold: hold}
    required_gate: true
  script-review:
    kind: bot
    member: reviewer
    task: '#review-task'
    required_inputs: [draft]
    outputs: {assessment: {media_type: text/markdown, required: true}}
    outcomes: [pass, revise, author, hold]
    verdicts: [PASS, CONDITIONAL, FAIL, INSUFFICIENT_EVIDENCE]
    decisions: [{verdict: PASS, outcome: pass}, {verdict: CONDITIONAL, outcome: pass}, {verdict: FAIL, outcome: revise}, {verdict: FAIL, outcome: author}, {verdict: FAIL, outcome: hold}, {verdict: INSUFFICIENT_EVIDENCE, outcome: hold}]
    terminal: {hold: hold}
    required_gate: true
  concept-author:
    kind: human
    task: '#author-task'
    required_inputs: [assessment]
    outcomes: [hold]
    terminal: {hold: hold}
  structure-author:
    kind: human
    task: '#author-task'
    required_inputs: [assessment]
    outcomes: [hold]
    terminal: {hold: hold}
  script-author:
    kind: human
    task: '#author-task'
    required_inputs: [assessment]
    outcomes: [hold]
    terminal: {hold: hold}
  concept-revise:
    kind: bot
    member: writer
    task: '#revise-task'
    required_inputs: [assessment]
    consume: [revisions]
    outputs: {revision: {media_type: text/markdown, required: true}}
    outcomes: [done, hold]
    terminal: {hold: hold}
  structure-revise:
    kind: bot
    member: writer
    task: '#revise-task'
    required_inputs: [assessment]
    consume: [revisions]
    outputs: {revision: {media_type: text/markdown, required: true}}
    outcomes: [done, hold]
    terminal: {hold: hold}
  script-revise:
    kind: bot
    member: writer
    task: '#revise-task'
    required_inputs: [assessment]
    consume: [revisions]
    outputs: {revision: {media_type: text/markdown, required: true}}
    outcomes: [done, hold]
    terminal: {hold: hold}
  concept-final:
    kind: bot
    member: adjudicator
    task: '#final-task'
    required_inputs: [assessment]
    outputs: {decision: {media_type: text/markdown, required: true}}
    outcomes: [go, hold]
    terminal: {hold: hold}
    required_gate: true
  structure-final:
    kind: bot
    member: adjudicator
    task: '#final-task'
    required_inputs: [assessment]
    outputs: {decision: {media_type: text/markdown, required: true}}
    outcomes: [go, hold]
    terminal: {hold: hold}
    required_gate: true
  script-final:
    kind: bot
    member: adjudicator
    task: '#final-task'
    required_inputs: [assessment]
    outputs: {decision: {media_type: text/markdown, required: true}}
    outcomes: [go, hold]
    terminal: {hold: hold}
    required_gate: true
  deliver:
    kind: bot
    member: editor
    task: '#deliver-task'
    inputs: {brief: {run_input: task}}
    required_inputs: [brief]
    join: any
    outputs: {delivery: {media_type: text/markdown, required: true}}
edges:
  - {id: prepare-concept, from: prepare, to: concept-review, on: [concept], bind: {draft: draft}, branch_group: stage}
  - {id: prepare-structure, from: prepare, to: structure-review, on: [structure], bind: {draft: draft}, branch_group: stage}
  - {id: prepare-script, from: prepare, to: script-review, on: [script], bind: {draft: draft}, branch_group: stage}
  - {id: concept-to-author, from: concept-review, to: concept-author, on: [author], bind: {assessment: assessment}}
  - {id: concept-to-revise, from: concept-review, to: concept-revise, on: [revise], bind: {assessment: assessment}}
  - {id: concept-recheck, from: concept-revise, to: concept-review, on: [done], bind: {revision: revision}, loop: concept}
  - {id: concept-pass, from: concept-review, to: deliver, on: [pass], bind: {concept: assessment}}
  - {id: concept-final-pass, from: concept-final, to: deliver, on: [go], bind: {concept-final: decision}}
  - {id: structure-to-author, from: structure-review, to: structure-author, on: [author], bind: {assessment: assessment}}
  - {id: structure-to-revise, from: structure-review, to: structure-revise, on: [revise], bind: {assessment: assessment}}
  - {id: structure-recheck, from: structure-revise, to: structure-review, on: [done], bind: {revision: revision}, loop: structure}
  - {id: structure-pass, from: structure-review, to: deliver, on: [pass], bind: {structure: assessment}}
  - {id: structure-final-pass, from: structure-final, to: deliver, on: [go], bind: {structure-final: decision}}
  - {id: script-to-author, from: script-review, to: script-author, on: [author], bind: {assessment: assessment}}
  - {id: script-to-revise, from: script-review, to: script-revise, on: [revise], bind: {assessment: assessment}}
  - {id: script-recheck, from: script-revise, to: script-review, on: [done], bind: {revision: revision}, loop: script}
  - {id: script-pass, from: script-review, to: deliver, on: [pass], bind: {script: assessment}}
  - {id: script-final-pass, from: script-final, to: deliver, on: [go], bind: {script-final: decision}}
communications:
  - {from: editor, to: reviewer, when: '#consultation-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: writer, to: editor, when: '#consultation-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: reviewer, to: editor, when: '#consultation-rules', max_rounds: 2, timeout_ms: 180000}
loops:
  concept: {max_reviews: 3, final_node: concept-final, retry_target: concept-review, final_outcomes: {go: go, hold: hold}, final_bind: {assessment: assessment}, count_nodes: [concept-review], scope: stage, stage: concept}
  structure: {max_reviews: 3, final_node: structure-final, retry_target: structure-review, final_outcomes: {go: go, hold: hold}, final_bind: {assessment: assessment}, count_nodes: [structure-review], scope: stage, stage: structure}
  script: {max_reviews: 3, final_node: script-final, retry_target: script-review, final_outcomes: {go: go, hold: hold}, final_bind: {assessment: assessment}, count_nodes: [script-review], scope: stage, stage: script}
budgets:
  revisions: {limit: 6, scope: run}
policy: {max_parallel: 1}
---

This is an unverified C1 definition draft, not an executable workflow guarantee. Production dispatch and end-to-end routing require verification. Human author nodes only HOLD: the graph cannot safely publish a versioned decision and its exact scope to the writer. Although approved_outputs can be restricted to selected outcomes, an input reference alone is not scoped authorization. No model-generated assessment or approval text is human authorization. The revision route is not safe for protected changes: the reviewer can misclassify a protected change as `revise`, and neither dispatch nor output registration verifies the resulting revision against the protection list. Instructions to HOLD are not an enforcement boundary. A trusted embedding must prevent unauthorized modifications and independently check the exact current version, author authority, approved change and resulting scope; historical decision evidence alone is not a grant. Only a `done` revision selects a recheck; `hold` does not rewind. Revision-budget exhaustion HOLDs instead of routing to final review because the budget route cannot pin the current assessment. The definition selects one review stage per Run: it does not implement cross-stage backtracking, retained approvals or cumulative stage counters across stages. Its mutually exclusive stage entry branches lack a forward dependency chain to rebuild with exact current versions and invalidated approvals. The declared stage loops allow three ordinary reviews and one final review; the Run budget permits six revision invocations, consumed at first authorization even if the invocation later HOLDs. Configure exact model bindings, permissions and the `brief` run input explicitly. Definition validation or preview is not an end-to-end run.

The trusted human policy must authenticate the actual author (or their authorized delegate), authorize access to the question and assessment, and be configured before answering; an arbitrary principal, model message, or assessment text is not an author decision. Approval does not attest that the generated revision actually stays in scope.

Trusted embeddings may use `screenwritingApprovalQuestionRef` to commit a human question to the exact decision, Run, invocation, inputs, source revision, content-addressed draft and change scope, answering principal and author identity. `readScreenwritingApprovalEvidence` checks that commitment against an authorized ledger read and requires the explicit `approve`/`APPROVE` decision; it never derives approval from prose. The host must independently resolve and verify the draft and scope bytes, present the exact proposal to the authenticated author, and ensure the question uses this commitment. The helper only establishes historical evidence: it does not check current validity, revocation, author authority, or protect dispatch and output. A production integration must atomically fence those checks, enforce the approved scope on the actual revision, and hold when enforcement is unavailable. This example does not invoke the helper and its author nodes remain HOLD-only.

## editor-role
Protect the author's intent and choose the smallest necessary stage. Never silently reduce the requested delivery standard.

## writer-role
Write only within the authorized scope. Preserve the protected themes, relationships, rules and ending. Do not substitute an outline for requested complete prose.

## reviewer-role
Independently assess the exact version without rewriting it. Distinguish fact, inference, preference and missing evidence. Model simulation is not real reader or market validation.

## consultation-rules
You MAY use graph_ask only for a concrete decision-changing gap:
- editor → reviewer: obtain a focused critique of a proposed direction or representative scene before committing more writing effort.
- writer → editor: clarify the exact revision scope, source version or protected author intent.
- reviewer → editor: request missing context or evidence about the submitted stage.
You MUST keep follow-ups in the existing conversation using graph_question/graph_reply and end with graph_finish. NEVER turn a reply into a reverse independent ask. You MUST share only minimum authorized text; these grants add no artifact-sharing scope or file permissions. Each consultation allows two follow-up rounds and a three-minute deadline; separate requests still require the Host's resource reservation. Consultation NEVER substitutes for an authenticated author decision, authorizes protected changes, satisfies a required review or counts as real audience feedback. Unresolved intent or authorization MUST hold the affected work.

## prepare-task
Read the brief, existing material, requested end stage, medium, constraints, author intent and protected items. For existing text enter its corresponding concept, structure or script review without compulsory exploration. For a seed, research relevant sources as needed, explore two to five genuinely different directions, compare their tradeoffs and probe a representative scene before preparing the requested stage. Keep the full applicable draft, protection list, sources, explicit authorizations and target stage in the published artifact; never invent missing source evidence. Choose the appropriate stage outcome.

## review-task
Use the revision input if present; otherwise use draft. Publish an assessment containing the complete exact reviewed version, digest, protection list, evidence, stage, verdict, next action and one to three decision-changing issues. For a proposed revision state one exact change, not alternatives, and affected protected items; if the version, scope, or consequences cannot be determined, hold. Check causal choices, character knowledge, resources, time, consequences and promises without imposing a fixed structure. PASS or CONDITIONAL may pass only when all mandatory stage criteria are met; carry nonblocking risks. FAIL routes to revise only for an unprotected change, or author for a proposed protected change, otherwise hold. INSUFFICIENT_EVIDENCE holds. Record CONTINUE, TARGETED_DESIGN, PROBE_OR_TEST, REVISIT_DIRECTION or HOLD separately from verdict; conflicting verdict and action must hold. Review never rewrites the work.

## author-task
Review the assessment's exact version, single proposed protected change, affected protected items and consequences. This node only HOLDs: the runtime does not publish outcome-conditional approval evidence and its exact scope to the writer. Retain the assessment and decision for an operator; do not treat the HOLD or a model-generated statement as authorization.

## revise-task
Use the assessment's exact draft. Apply only a specific unprotected change and its necessary dependencies; do not change protected items. Never infer human authorization from assessment prose, a review, or a consultation. Publish the complete revised version, digest, change scope, protection check and unresolved issues. If a protected change, unclear scope, or missing evidence prevents the revision, publish a revision artifact explicitly marked as unchanged and blocked, and return hold; otherwise return done. Model compliance with these restrictions is not machine-enforced.

## final-task
Adjudicate the exact current version in the assessment, without rewriting. Return go only when mandatory criteria are met and blockers are resolved or disproved by evidence; otherwise hold. An unresolved protected change requiring a new author decision must hold. Never lower standards after exhaustion or claim unobserved audience response. Include the current version and evidence in the decision artifact.

## deliver-task
Deliver the reviewed or adjudicated version for the requested stage, its protection list, evidence and remaining risks. A complete draft requires actual prose from beginning to end; a delivery draft must not contain missing mandatory scenes, placeholders or unresolved hard contradictions. No downstream image, video or publication is authorized by this graph.

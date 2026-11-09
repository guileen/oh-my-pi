---
format: omp.graph/v1
name: requirement-development
members:
  researcher:
    role: '#researcher-role'
    model: gpt-6.1-terra
    base: omp-default
    duty: research
    permissions: {read: ['.'], write: ['artifacts'], execute: []}
  guide-author:
    role: '#guide-role'
    model: gpt-6.1-sol
    base: omp-default
    duty: guide
    permissions: {read: ['.'], write: ['artifacts'], execute: []}
  spec-author:
    role: '#spec-role'
    model: gpt-6.1-sol
    base: omp-default
    duty: spec
    permissions: {read: ['.'], write: ['openspec', 'artifacts'], execute: []}
  reviewer:
    role: '#review-role'
    model: gpt-6.1-sol
    base: isolated
    duty: review
    permissions: {read: ['.'], write: ['artifacts'], execute: []}
  adjudicator:
    role: '#review-role'
    model: gpt-6.1-sol
    base: isolated
    duty: review
    permissions: {read: ['.'], write: ['artifacts'], execute: []}
  implementation-lead:
    role: '#code-role'
    model: gpt-6.1-terra
    base: omp-default
    duty: code-only
    permissions: {read: ['.'], write: ['.'], execute: []}
  integrator:
    role: '#code-role'
    model: gpt-6.1-terra
    base: omp-default
    duty: code-only
    permissions: {read: ['.'], write: ['.'], execute: []}
  tester:
    role: '#test-role'
    model: gpt-6-luna
    base: omp-default
    duty: test-only
    permissions: {read: ['.'], write: ['artifacts', 'tmp'], execute: ['test', 'typecheck']}
  acceptance-reviewer:
    role: '#test-role'
    model: gpt-6-luna
    base: omp-default
    duty: test-only
    permissions: {read: ['.'], write: ['artifacts', 'tmp'], execute: ['test', 'typecheck']}
  advisor:
    role: '#advisor-role'
    model: gpt-6-astra
    base: isolated
    duty: consult
    permissions: {read: [], write: [], execute: []}
nodes:
  research:
    kind: bot
    member: researcher
    task: '#research-task'
    inputs: {brief: {run_input: task}}
    required_inputs: [brief]
    outputs: {research: {media_type: text/markdown, required: true}}
  guide:
    kind: bot
    member: guide-author
    task: '#guide-task'
    required_inputs: [research]
    outputs: {guide: {media_type: text/markdown, required: true}}
  spec:
    kind: bot
    member: spec-author
    task: '#spec-task'
    inputs: {brief: {run_input: task}}
    required_inputs: [brief, guide]
    outputs: {spec: {media_type: text/markdown, required: true}}
  mind-test:
    kind: bot
    member: reviewer
    task: '#mind-task'
    required_inputs: [spec]
    outputs: {review: {media_type: text/markdown, required: true}}
    outcomes: [approved, revise, hold]
    terminal: {hold: hold}
    required_gate: true
  final-review:
    kind: bot
    member: adjudicator
    task: '#final-task'
    required_inputs: [review]
    outputs: {decision: {media_type: text/markdown, required: true}}
    outcomes: [go, hold]
    terminal: {hold: hold}
    required_gate: true
  implement:
    kind: subgraph
    member: implementation-lead
    task: '#implement-task'
    child_policy: {kinds: [bot], max_nodes: 24, max_parallel: 3}
    writes: ['.']
    consume: [implementation-attempts]
    join: any
    outputs: {implementation: {media_type: text/markdown, required: true}}
  freeze:
    kind: bot
    member: integrator
    task: '#freeze-task'
    required_inputs: [implementation]
    outputs: {snapshot: {media_type: text/markdown, required: true}}
  test:
    kind: bot
    member: tester
    task: '#test-task'
    required_inputs: [snapshot]
    outputs: {evidence: {media_type: text/markdown, required: true}}
  accept:
    kind: bot
    member: acceptance-reviewer
    task: '#accept-task'
    required_inputs: [snapshot, evidence]
    outputs: {acceptance: {media_type: text/markdown, required: true}}
    outcomes: [pass, revise, hold]
    terminal: {pass: succeed, hold: hold}
    required_gate: true
  exhausted:
    kind: human
    task: '#exhausted-task'
    required_inputs: [spec]
    outcomes: [hold]
    terminal: {hold: hold}
edges:
  - {id: research-guide, from: research, to: guide, bind: {research: research}}
  - {id: guide-spec, from: guide, to: spec, bind: {guide: guide}}
  - {id: spec-review, from: spec, to: mind-test, bind: {spec: spec}, when_budget: {budget: implementation-attempts, state: available}}
  - {id: review-revise, from: mind-test, to: spec, on: [revise], bind: {review: review}, loop: specification}
  - {id: review-implement, from: mind-test, to: implement, on: [approved], bind: {review: review}}
  - {id: final-implement, from: final-review, to: implement, on: [go], bind: {decision: decision}}
  - {id: implement-freeze, from: implement, to: freeze, bind: {implementation: implementation}}
  - {id: freeze-test, from: freeze, to: test, bind: {snapshot: snapshot}}
  - {id: freeze-accept, from: freeze, to: accept, bind: {snapshot: snapshot}}
  - {id: test-accept, from: test, to: accept, bind: {evidence: evidence}}
  - {id: accept-update, from: accept, to: spec, on: [revise], bind: {failure: acceptance}, loop: specification}
  - {id: spec-exhausted, from: spec, to: exhausted, bind: {spec: spec}, when_budget: {budget: implementation-attempts, state: exhausted}}
communications:
  - {from: researcher, to: reviewer, when: '#consultation-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: spec-author, to: researcher, when: '#consultation-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: reviewer, to: spec-author, when: '#consultation-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: researcher, to: advisor, when: '#advisor-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: spec-author, to: advisor, when: '#advisor-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: reviewer, to: advisor, when: '#advisor-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: implementation-lead, to: spec-author, when: '#consultation-rules', max_rounds: 2, timeout_ms: 180000}
  - {from: tester, to: spec-author, when: '#consultation-rules', max_rounds: 2, timeout_ms: 180000}
loops:
  specification:
    max_reviews: 3
    final_node: final-review
    retry_target: spec
    final_outcomes: {go: go, hold: hold}
    final_bind: {review: review}
    count_nodes: [mind-test]
    scope: cycle
    cycle_start: spec
    reset_from: [accept]
budgets:
  implementation-attempts: {limit: 2, scope: run}
policy: {max_parallel: 1, max_child_nodes: 24}
extensions:
  x-contract:
    bindings: packages/coding-agent/examples/graph/requirement-development/models.md
    summary: 面向需求迭代开发的标准多 Bot 协作 Graph（Terra 调研/编码、Astra 规范指引、Sol 编写/评审 OpenSpec、Luna 独立测试验收），遵循高效/节约/灵活价值倾向，将意图、Use Case、场景预期、BDD、MVP 与产品阶段交付统一闭环。
    inputs:
      task:
        media_type: text/markdown
        required: true
        sections: [intent, use_case, bdd_scenarios, mvp_scope]
        description: 由总控 Bot 按规格转写的结构化任务单，包含用户意图、核心 Use Case、BDD 场景（GIVEN/WHEN/THEN）、本期 MVP 边界与可复用资产。
    outputs:
      snapshot:
        node: freeze
        output: snapshot
        media_type: text/markdown
        description: 冻结集成版本清单、源码/规格摘要与编码者自检记录。
      acceptance:
        node: accept
        output: acceptance
        media_type: text/markdown
        description: 针对冻结版本的独立测试与最终验收结论（pass / revise / hold）。
    report_events: [succeeded, failed, held, stalled]
    stall_threshold_ms: 300000
    deliverable:
      summary: 冻结版本、独立验收结论与可运行改动：先读验收结论，再按清单亲自跑一遍。
      experience: 在目标工作区按 `snapshot` 的清单复现构建与测试命令，并体验改动后的入口。
      artifacts: [snapshot, acceptance]
---

This is an unverified C1 definition draft, not an executable workflow guarantee. Production dispatch, child-graph execution, frozen acceptance, budget accounting and end-to-end routing remain unverified. The declared `specification` cycle rewinds from acceptance to spec with the exact acceptance artifact as `failure`, starts a new review cycle only for that declared reset, and retains the Run-scoped implementation budget; ordinary review revisions do not reset that cycle. After budget exhaustion, the corrected spec is bound to the HOLD node, not a new implementation. These are definition-level intentions, not evidence that a production run has performed the rewind, correction or HOLD. Imported prerequisite outputs require authorized provenance and applicable versions; the present import path is limited to a trusted, unconditional complete prefix and cannot skip required gates, budgets or loops. Configure exact model bindings, permissions and the `brief` run input explicitly. Definition validation or preview is not an end-to-end run.

## researcher-role
以高效、节约、灵活为导向调查原始代码、配置与未知项；优先复用已有证据，仅输出与当前 MVP 决策直接相关的事实定位、约束与缺口，不修改产品代码。

## guide-role
基于调研证据与仓库规约，提炼精简可执行的 OpenSpec 编写指引与接口边界；聚焦本期 MVP 最小充分契约，不实施产品代码。

## spec-role
遵循 `openspec-delivery` 技能，将用户意图、核心 Use Case、场景预期、BDD（GIVEN/WHEN/THEN）、MVP 与产品阶段交付统一成链。维护当前里程碑 proposal/spec/design/contracts/tasks，保持正向清晰表述，不替未来阶段过度设计，不降低验收标准迎合缺陷。

## review-role
使用独立上下文审阅提交的当前里程碑规格与证据，不修改被审产物。按“当前 MVP 承诺/安全阻断、已披露可接受限制、后续迭代建议”三级分流，聚焦高效、节约（Token/回合成本）、灵活（通道与多实例能力）与安全底线。

## code-role
使用 OMP 默认编码基座与仓库规则，仅实现已批准的当前 MVP 范围（含必要回归测试源码与文档同步）。执行并记录仓库强制自检（自检不替代 Luna 独立验收），保留用户既有改动。

## test-role
在独立上下文中针对冻结版本（snapshot）执行真实入口、BDD 场景与故障边界验证。不修改产品、测试或规格源码；区分代码实现缺陷（交 coder 修复重冻结）与规格缺口（回 spec-author 修订）。

## advisor-role
只回答被问到的具体问题，不执行任何操作。没有工具，不读文件、不跑命令、不写产物、不修改规格。依据调用方在提问中给出的最小材料作答；材料不足时明确说明缺什么，不猜测、不扩展任务。答复保持精简，直接给出判断、理由与仍不确定的部分。

## consultation-rules
You MAY use graph_ask only for a concrete decision-changing gap:
- researcher → reviewer: audit a concise plan and evidence summary, not the entire research history.
- spec-author → researcher: request missing source evidence or clarify an observation.
- reviewer → spec-author: clarify the submitted specification without requesting edits during review.
- implementation-lead → spec-author: clarify approved scope; changed requirements MUST return through the specification/review workflow.
- tester → spec-author: clarify a frozen acceptance criterion; missing tests or defects MUST still produce failure evidence for the declared revision route.
You MUST use graph_question/graph_reply within the existing conversation for follow-ups, and graph_finish for the final answer. NEVER use reverse independent asks to answer a question. You MUST share only the minimum authorized text; these grants add no artifact-sharing scope or file permissions. Each consultation allows two follow-up rounds and a three-minute deadline; separate requests still require the Host's resource reservation. Consultation NEVER completes a task, approves a gate, changes a frozen version or replaces independent review/test evidence. A missing answer MUST remain an explicit unknown or blocker.

## advisor-rules
向 `advisor` 提问前，先把问题收敛成一句可判定的提问，并附上判断所需的最小材料：结论、关键约束、以及你已经排除的选项。advisor 没有工具，看不到仓库、文件或对话历史，未附材料的追问只能得到“材料不足”的回复，不能替代调研或验收。

- researcher → advisor：这个结论或推断在给定证据下是否成立？
- spec-author → advisor：这段契约/边界是否存在自相矛盾或未定义的失败路径？
- reviewer → advisor：这份评审结论是否成立，是否有被忽略的阻断项？
答复只用于修正当前判断，不构成新的任务、审批或证据。单次问答入参上限 64 KiB、答复上限 32 KiB，超出即失败而不截断；两轮追问后仍未收敛就按未知处理并继续原流程。

## research-task
围绕 `brief`（由总控 Bot 转写的结构化需求单）与目标仓库取证。输出精确文件路径、行号、现有接口/状态模型、Token/性能瓶颈与未知项。若启动时已提供当前有效的调研产物，可直接带来源与版本引用导入，节约重复调用。

## guide-task
结合 `research` 产物与仓库规则、`openspec-delivery` 规范，输出本期 MVP 的设计指引：明确六问（谁用、输入 Spec、产出、状态/异常感知与主动回报、权限/状态归属、完成标准）及体量边界。已有当前有效 guide 可直接导入。

## spec-task
基于 `brief` 与 `guide` 撰写或更新当前里程碑 OpenSpec。将用户意图 → 核心 Use Case → 场景预期 → BDD（GIVEN/WHEN/THEN）→ MVP 切片统一表达；远期阶段仅留路线图。仅当存在规格缺口、契约冲突或授权范围变更时更新规格；实现 bug 直接交编码修复，无需改写正确规格。在实施额度耗尽进入 HOLD 前，先保存失败证据与必要的规格修正。

## mind-task
对当前里程碑规格执行有界 Mind Test：核查意图与 BDD 主路径是否闭环、接口是否高效节约（顶层 I/O Spec、最小上下文与回合数）、汇报与暂停恢复是否灵活、高风险边界是否受控。区分阻断项、已披露限制与后续建议：无实质阻断则 `approved`；存在当前承诺/安全阻断则输出最小修正清单并返回 `revise`；缺关键外部前提则 `hold`。

## final-task
普通评审轮次达上限后执行终审裁定，不修改规格与评审正文。仅判断剩余问题是否违反本期 MVP 承诺或安全底线：已解决或属后续迭代建议则返回 `go` 进入实施；仍存在实质阻断则返回 `hold` 交总控/用户决策。

## implement-task
基于获批的当前 MVP OpenSpec 创建有界 `code-only` 编码子图。共享文件与核心状态串行实施；无重叠模块可并行并在集成前合并。各子成员使用 OMP 默认基座，完成代码、必要回归测试源码与文档更新，执行并记录仓库强制自检，输出完整变更与自检证据包。

## freeze-task
汇总并校验编码子图产物，确保不覆盖用户无关修改。发布冻结快照 `snapshot`：记录源码树摘要、OpenSpec 摘要、变更文件清单、编码者自检结果，以及待独立验证的 BDD 场景清单。缺失必要子图结果时必须 `hold`。

## test-task
由 Luna 在冻结版本 `snapshot` 上运行真实 CLI/服务/界面入口与 BDD 验收场景，记录实际执行的命令、环境、耗时、Token/费用与可观察结果。区分真实模型/进程验证与受控注入测试；不修改源码或重置实施预算。

## accept-task
对照当前 MVP 的 BDD 验收标准与 `evidence` 作出独立裁定：全部本期承诺场景与安全底线有实证支撑则 `pass`；发现规格缺口或契约冲突则附精确证据返回 `revise`；发现代码实现缺陷或缺失回归测试则报告 `hold` 并生成直接交 `coder` 修复→重冻结→复验的交接说明。

## exhausted-task
检查已绑定的最新规格与失败证据包。当前 Run 的实施预算已耗尽，保持 `hold` 并通过 `report_to` 向总控 Bot 汇报失败根因、已保存成果与恢复所需决策。

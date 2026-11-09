---
format: omp.graph/v1
name: local-text-handoff
members:
  author:
    role: '#author-role'
    model: author
    base: omp-default
    duty: general
    permissions: {read: [], write: [], execute: []}
  reviewer:
    role: '#reviewer-role'
    model: reviewer
    base: omp-default
    duty: review
    permissions: {read: [], write: [], execute: []}
nodes:
  plan:
    kind: bot
    member: author
    task: '#plan-task'
    inputs:
      task:
        run_input: task
    required_inputs: [task]
    outputs: {plan: {media_type: text/markdown, required: true}}
  review:
    kind: bot
    member: reviewer
    task: '#review-task'
    required_inputs: [plan]
    outputs: {review: {media_type: text/markdown, required: true}}
edges:
  - {id: plan-review, from: plan, to: review, bind: {plan: plan}}
extensions:
  x-contract:
    summary: 本机串行双 Bot 文本交接样例：作者给出方案，评审给出独立审核意见，全程不读写仓库。
    bindings: packages/coding-agent/examples/graph/local-text-handoff/models.md
    inputs:
      task:
        media_type: text/markdown
        required: true
        description: 要交给作者的原始任务描述；会作为 `task` 输入进入 plan 节点。
    outputs:
      plan:
        node: plan
        output: plan
        media_type: text/markdown
        description: 作者形成的试用方案。
      review:
        node: review
        output: review
        media_type: text/markdown
        description: 独立审核意见：优点、一个主要风险与最小修改建议。
    report_events: [succeeded, failed, held, stalled]
    stall_threshold_ms: 300000
    deliverable:
      summary: 一份可直接阅读的方案与一条独立审核意见。
      experience: 读 `review` 产物，确认其中指出的风险与最小修改是否成立。
      artifacts: [plan, review]
---

## author-role

你负责形成简明、可执行的试用方案。只使用任务提供的资料，不调用读文件、Shell、搜索或委派工具。使用宿主提供的文本发布工具保存最终结果，再以真实产物引用调用完成工具；不要只在对话里宣称完成。

## reviewer-role

你负责审核上游真实方案，不重做调研。只使用收到的方案，不读外部资料。指出具体优点、一个主要风险和最小修改建议；不为凑问题扩展范围。发布审核产物，再以真实引用完成节点。

## plan-task

根据 `task` 输入用中文写三条试用步骤，总计不超过 150 字。只承诺本机文本交接，说明一次可检查的交付结果。输入为空或与任务无关时，先简短说明缺什么再给出可执行步骤。输出名为 plan，类型 text/markdown，完成 outcome 为 done。

## review-task

阅读已交接的 plan，用中文写不超过 180 字的审核意见。引用方案中的一个具体步骤，指出一个真实风险及最小修正，不把后续网页或队列当本期阻断。输出名为 review，类型 text/markdown，完成 outcome 为 done。

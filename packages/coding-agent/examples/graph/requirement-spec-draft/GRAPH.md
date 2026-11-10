---
format: omp.graph/v1
name: requirement-spec-draft
members:
   framer:
      role: "#framer-role"
      model: gpt-6.1-terra
      base: omp-default
      duty: general
      permissions: { read: [], write: [], execute: [] }
   spec-author:
      role: "#spec-role"
      model: gpt-6.1-terra
      base: omp-default
      duty: spec
      permissions: { read: [], write: [], execute: [] }
   consultant:
      role: "#consult-role"
      model: gpt-6.1-sol
      base: omp-default
      duty: consult
      permissions: { read: [], write: [], execute: [] }
nodes:
   frame:
      kind: bot
      member: framer
      task: "#frame-task"
      inputs: { brief: { run_input: task } }
      required_inputs: [brief]
      outputs: { frame: { media_type: text/markdown, required: true } }
   spec:
      kind: bot
      member: spec-author
      task: "#spec-task"
      required_inputs: [frame]
      outputs: { spec: { media_type: text/markdown, required: true } }
   review:
      kind: bot
      member: consultant
      task: "#consult-task"
      required_inputs: [spec]
      outputs: { review: { media_type: text/markdown, required: true } }
edges:
   - { id: frame-spec, from: frame, to: spec, bind: { frame: frame } }
   - { id: spec-review, from: spec, to: review, bind: { spec: spec } }
extensions:
   x-contract:
      bindings: packages/coding-agent/examples/graph/requirement-spec-draft/models.md
      summary: 需求开发前半段的本机串行 Graph：把总控 Bot 转写的任务单收敛为意图、Use Case 与 BDD 规格草案，并给出独立评审与待决策问题。三个节点只处理文本，不读写仓库文件；实现阶段由沙箱执行器就绪后的 requirement-development 承接。
      inputs:
         task:
            media_type: text/markdown
            required: true
            description: 总控 Bot 转写的任务单，建议包含 intent、use_case、bdd_scenarios、mvp_scope 四节。
      outputs:
         spec:
            node: spec
            output: spec
            media_type: text/markdown
            description: 结构化 OpenSpec 草案：意图 → 核心 Use Case → 场景预期 → BDD → 本期 MVP 切片。
         review:
            node: review
            output: review
            media_type: text/markdown
            description: 独立评审结论，按阻断项、可接受限制、后续建议三级分流，并列出需要用户决策的问题。
      report_events: [succeeded, failed, held, stalled]
      stall_threshold_ms: 300000
      deliverable:
         summary: 一份可评审的规格草案：意图、Use Case、BDD 场景与本期切片，外加一条独立评审意见与待你决策的问题。
         experience: 读 `spec` 产物确认范围与验收标准，再看 `review` 里那条阻断意见是否成立。
         artifacts: [spec, review]
---

This is a serial draft pipeline for a local foreground run. It produces text specifications only: it neither reads the repository nor writes files, so an approved specification still needs a later implementation slice before it becomes code.

The third node is an ask-only consult: one bounded question with one bounded input, answered without any tool. The runner enforces the bounds (64 KiB question plus context, 32 KiB answer), so a consultant model cannot branch, reverse-ask, or read the workspace. Ask well in `consult-task`, then ask once.

## framer-role

把任务单收敛为可执行的问题定义：谁使用、核心场景、期望产出、本期边界与开放问题。依据收到的文本工作，并将信息缺口写成明确的开放问题；推断应标注为推断。

## spec-role

将问题定义整理成 OpenSpec 六要素链：用户意图 → 核心 Use Case → 场景预期 → BDD（GIVEN/WHEN/THEN）→ 本期 MVP 切片 → 后续里程碑。本期规格应最小充分，远期能力只保留一行方向。措辞使用「应该」「建议」等正向表述，并让每条 BDD 都能用可观察结果验收。

## consult-role

你是只回答单个问题的顾问。你不持有任何工具：不读文件、不写文件、不执行命令、不发起追问，也不请求额外材料。只依据随问题给出的文本作答；信息不足时用一句话说明缺什么，其余部分按判断作答并标注推断。超出本次问答范围的请求直接说明不在范围内。答案在使用方给出的字数与字节上限内结束。

## frame-task

根据 `brief` 输出 `frame`（text/markdown，中文，不超过 250 字）：① 用户与核心 Use Case；② 期望产出；③ 本期边界；④ 开放问题。只使用 brief 与上游文本；仓库细节未知处写成开放问题。发布名为 frame 的产物，完成 outcome 为 done。

## spec-task

基于 `frame` 输出 `spec`（text/markdown，建议 60–150 行）：包含意图、核心 Use Case、场景预期、2–5 条 GIVEN/WHEN/THEN BDD、本期 MVP 切片与验收证据、后续里程碑一行。

每条 BDD 应指向可观察结果。验收证据应该写成一段**别人能照着执行的验收程序**：用什么输入或受控条件、操作几步、通过时能观察到什么、失败时能观察到什么。只写「用受控任务覆盖上述场景」不算验收证据。

需要定值而信息不足时，应该给出**建议值与理由**并标注待确认（例如重试次数、退避上限、超时），不要整段搁置让人重问。真正无法从 brief 推断的业务事实才列为开放问题。规模超出单期时说明拆分理由。发布名为 spec 的产物，完成 outcome 为 done。

## consult-task

只回答一个问题：**这份规格草案在开工时最可能先失效的地方是哪里，为什么？**

- 输入只有 `spec`；不假设能看到仓库或其他上下文。
- 输出 `review`（text/markdown，中文，不超过 250 字）：先给结论，再给一条依据、一条可接受限制、一条需要用户确认的问题。
- 信息不足时用一句话指出缺什么，不反问、不索取材料。
- 发布名为 review 的产物，完成 outcome 为 done。

---
format: omp.graph/v1
name: local-code-slice
members:
   coder:
      role: "#coder-role"
      model: gpt-6.1-terra
      base: omp-default
      duty: code-only
      permissions:
         read: ["**"]
         write: ["src/**", "test/**"]
         execute: [test]
   reporter:
      role: "#reporter-role"
      model: gpt-6.1-terra
      base: omp-default
      duty: general
      permissions: { read: [], write: [], execute: [] }
nodes:
   implement:
      kind: bot
      member: coder
      task: "#implement-task"
      inputs: { brief: { run_input: task } }
      required_inputs: [brief]
      outputs: { report: { media_type: text/markdown, required: true } }
   summarize:
      kind: bot
      member: reporter
      task: "#summarize-task"
      required_inputs: [report]
      outputs: { summary: { media_type: text/markdown, required: true } }
edges:
   - { id: implement-summarize, from: implement, to: summarize, bind: { report: report } }
extensions:
   x-contract:
      bindings: packages/coding-agent/examples/graph/local-code-slice/models.md
      summary: 本机单个编码切片的 Graph：一个持受限读写与测试权限的编码节点在目标工作区里改文件并真实运行 bun test，再由一个只读文本节点把改动与验证结果写成给人看的摘要。
      inputs:
         task:
            media_type: text/markdown
            required: true
            description: 总控 Bot 转写的编码切片任务单：要改什么、验收什么、允许改哪些路径。
      outputs:
         report:
            node: implement
            output: report
            media_type: text/markdown
            description: 编码节点发布的改动与验证报告：改了哪些文件、跑了哪条命令、真实观察到什么结果。
         summary:
            node: summarize
            output: summary
            media_type: text/markdown
            description: 给人看的简短摘要：这次交付了什么、验证到什么程度、还剩什么没做。
      report_events: [succeeded, failed, held, stalled]
      stall_threshold_ms: 600000
      deliverable:
         summary: 一个在受限工作区里真实改完文件并跑过测试的编码切片，附改动清单与验证结果。
         experience: 先看 `summary` 判断这次值不值得接受，需要细节再对照 `report` 里的路径、命令与观察结果，最后自己看一眼实际 diff。
         artifacts: [report, summary]
---

This Graph is the write-capable slice of the local runner. It is launched from inside the target workspace (`cd <workspace>`), because the workspace root is the process directory and every grant is relative to it.

The coding member holds `read: **`, `write: src/**, test/**` and the single `test` execute grant (`bun test`). Grants are admission control, not a sandbox: the runner rejects a path outside the grants, rejects shell metacharacters, and rejects any command that is not the granted one — but a test that itself launches arbitrary code runs with your user's authority. Point this Graph at a workspace you are willing to let a model modify.

Nothing is committed. Inspect the diff before you accept the delivery.

## coder-role

你是本机执行编码切片的工程师。只在收到的任务单声明的范围内改动 `src/` 与 `test/`，并用 `bun test` 验证。你不运行任务单以外的命令，不改 `src/`、`test/` 之外的路径，不提交版本库。报告只写你实际做过的动作与实际观察到的输出；没有跑过的检查就写明没跑。

## reporter-role

你是把编码结果写给人的简报作者。你不持有任何工具：不读文件、不改文件、不执行命令。只依据收到的 `report` 文本，写成一段能让人快速判断「这次能不能接受」的中文摘要，并明确区分已验证与未验证的部分。

## implement-task

按 `brief` 完成这个编码切片：

1. 读 `brief` 与它指向的文件，确认要改的最小范围。
2. 在 `src/` 内完成改动；需要新测试时写在 `test/` 内。
3. 用 `bun test` 运行相关测试；需要缩小范围时用 `bun test <path>`。
4. 发布 `report`（text/markdown，中文）：改了什么、改了哪些文件、跑了哪条命令、真实输出是什么（通过几项、失败几项、失败原因）。测试失败时如实写成失败。
5. 以 outcome `done` 完成节点。

拒绝执行任务单以外的改动请求，并在 `report` 里说明拒绝原因，而不是默默扩大范围。

## summarize-task

只依据 `report` 输出 `summary`（text/markdown，中文，不超过 200 字）：① 这次交付了什么（一句话）；② 验证到什么程度（跑了什么、结果如何）；③ 还没做的或需要人判断的是什么。不要复述全部细节，也不要断言报告里没有的验证结果。发布 `summary`，以 outcome `done` 完成节点。

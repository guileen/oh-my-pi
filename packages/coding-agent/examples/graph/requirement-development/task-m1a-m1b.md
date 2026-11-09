# 任务标题：实现 M1-A（总控 Bot 发现/派单/心跳/主动回报）与 M1-B（wherdr 同图多 Run 彩色飞线看板）

## 1. 用户意图（Intent）
- **核心目标**：让用户只需与一个总控会话/总控 Bot 聊天，即可由总控 Bot 自动发现合适的 Graph、读取顶层输入输出 Spec、转写需求一键派单、观察依次哪个 Bot 在跑及是否卡死、接收完成/异常主动通知、随时暂停或恢复任务；同时用户可在 `wherdr` 看板一眼看到所有在跑 Graph，以及同一个 Graph 上多个并发任务（Runs）用不同颜色收发消息、流转推进。
- **价值倾向**：**高效**（最短调用链、一键 `dispatch`、轻量 `pause/resume`）、**节约**（顶层 `x-contract` I/O Spec 零噪音选图、按职责裁剪上下文节约 Token）、**灵活**（可配置 `report_to` 汇报通道、同图多 Run 并发叠加展示）。

## 2. 核心用例（Use Case）与适用环境
- **目标仓库**：`/Users/gl/agentworks/oh-my-pi`（Graph 引擎、CLI、Tools、Wire 契约）与 `/Users/gl/agentworks/wherdr`（Web 看板与画布）。
- **所属 OpenSpec Change**：`openspec/changes/add-omp-graph-execution`（参见 `roadmap.md` 与 `milestone-tasks.md`）。
- **角色入口**：
  - 总控 Bot（定义见 `/Users/gl/llmwiki/omp-graph/bots/orchestrator/BOT.md`）通过 `graph_read` / `graph_manage` 或 `omp graph` CLI 驱动；
  - 用户通过总控会话对话，或通过 `wherdr` 网页看板实时观察与控制。

## 3. 场景预期与 BDD 验收标准

### M1-A：总控 Bot 发现、派单、感知与主动回报
- **场景 1（顶层 I/O Spec 与零噪音发现）**
  - **GIVEN** `GRAPH.md` 在 `extensions.x-contract` 声明了 `summary`、`inputs`、`outputs`、`report_events`、`stall_threshold_ms`（未声明的旧图自动从入口 `run_input` 与终点 `outputs` 推导）
  - **WHEN** 总控 Bot 调用 `graph_read` `catalog`（或 CLI `omp graph catalog / list`）
  - **THEN** 仅返回各 Graph 的 ID、名称、可执行状态与顶层 I/O Spec，无需加载整张图的内部节点与提示词即可完成选图与需求转写。
- **场景 2（一键转写派单 `dispatch` 与 `report_to` 主动汇报通道）**
  - **GIVEN** 总控 Bot 已按 Spec 生成任务标题 `title` 与输入字典
  - **WHEN** 调用 `graph_manage` `dispatch`（或 `omp graph dispatch`）并传入 `report_to: { channel, target, events: ["succeeded", "failed", "held", "stalled"] }`
  - **THEN** Host 自动将输入封装为不可变产物、启动带 `title` 的 Run，并在 Run 进入 `succeeded / failed / held / stalled` 时主动向 `report_to` 投递结构化回执与最终产物引用。
- **场景 3（节点执行次序、最新进展与卡死检测）**
  - **GIVEN** Run 正在运行或等待
  - **WHEN** 总控 Bot 调用 `graph_read` `runs.list` 或 `status`
  - **THEN** 返回依次执行/待执行的 Bot 节点、`started_at`、`last_activity_at`、`turn_count`、`activity_summary`，并在运行节点超过 `stall_threshold_ms` 无进展时标记 `stalled` 并告警。
- **场景 4（随时对话暂停与恢复）**
  - **GIVEN** 用户指示总控 Bot“先暂停某任务，稍后恢复”
  - **WHEN** 总控 Bot 执行轻量调度级 `pause` / `resume`（区别于需要正式人工审批产物的 `gate_hold`）
  - **THEN** Host 停止派发新节点，并在 `resume` 后从原断点与原预算计数继续执行。

### M1-B：wherdr 全局运行看板与同图多 Run 彩色画布
- **场景 5（全局在跑总览与同图多 Run 彩色飞线看板）**
  - **GIVEN** 同一个 `graph_id` 下有 2 个以上并发 `graph_run_id` 正在运行
  - **WHEN** 用户打开 `wherdr` Graphs 看板并进入该 Graph
  - **THEN** 顶部/侧栏列出所有活跃 Graph 与并发 Run；同一拓扑画布为每个并发 `run_id` 分配固定色标（`--c1`…`--c6`），节点外圈显示各色任务徽章，边上发生产物传递（`transfer`）或 Bot 间对话（`conversation`）时渲染对应颜色的飞线脉冲；支持一键切换“全部叠加 / 单看某色”，支持本机 CLI 授予短期受限网页会话免强制注册 Passkey。

## 4. 本期 MVP 交付边界与可复用资产
- **实施顺序**：先交付并验收 **M1-A**（A1–A5），冻结通过后再进入 **M1-B**。
- **可直接复用的已有资产**（启动时可作为前置参考导入，免重复调研）：
  - 路线图与任务清单：`openspec/changes/add-omp-graph-execution/roadmap.md`、`milestone-tasks.md`
  - 现有契约与实现：`openspec/changes/add-omp-graph-execution/contracts.md`、`packages/coding-agent/src/graph/`、`packages/wire/src/graph/`
  - 现有 wherdr 组件：`/Users/gl/agentworks/wherdr/app/pages/graphs.vue`、`/Users/gl/agentworks/wherdr/app/components/bots/GraphLiveRun.vue`
- **非目标**：多机分布式调度、无界循环、未经授权自动切换模型或突破预算上限。

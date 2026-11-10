# 日常编码工作流（headless Bot 宿主）

入口：

```sh
omp bot workflows --json
omp bot daily-code --input task.json --request-key daily-task-001 --accept-workspace-code --json
```

先复制 `input.example.json`，将 `workspace` 改成已有工作区的绝对路径，填写任务、事实和用户原话，缩小 `write` 范围，核对 `bindings` 是本机可用且已认证的精确 provider/model。示例绑定不是可用性承诺。`coder` 默认 Terra/low，可单独覆盖模型或强度；`reviewer` 默认 Sol/high，可选 Astra。两者都在首次改动前校验；不支持的强度、缺失模型或认证会阻塞，不静默替换。别名只表示用户配置的角色，不推断模型身份。

## 执行与权限

宿主通过既有 `BotService`、`BotWorker` 和隔离的 Bot runtime，为每轮编码和评审创建全新 Job。`coder.md`、`reviewer.md` 是实际使用的系统提示词，不是待接线的示意文件。两轮仅有 read/grep/glob/write/edit，按工作区 grants 校验路径、符号链接以及所有编辑/重命名目标；不授予 shell、网络、进程、MCP、扩展或委派工具。搜索只接受单个明确的本地路径/模式，复杂列表拆成多次调用；读查询和内部 URL 不在授权内。已有用户改动不重置、不提交；仍应人工检查最终 diff。

第二轮独立核查实际文件并直接修复，不只给建议。两轮都必须提交严格的 `status`/`report` JSON；格式错误、空报告或阻塞不会进入验收。评审要求返工时回编码；验收失败带真实证据回编码，然后重新评审、从头验收，最多 `maxRounds` 轮。

验收由宿主执行，不接受模型提供的命令：

| check     | 固定 argv           |
| --------- | ------------------- |
| test      | bun test            |
| typecheck | bun run check:types |
| check     | bun run check       |

`--accept-workspace-code` 明确授权这些命令执行工作区代码。工作区脚本/测试仍以当前用户权限运行；grants 不是操作系统沙箱，不能限制测试本身的网络、进程、文件访问或副作用。仅用于可信工作区。若项目没有对应脚本，真实非零退出码会进入返工，不会被伪报为通过。不要把本次代码审查的“禁止执行命令”限制理解为已批准运行此入口。

## 结果与恢复

stdout 始终为单个 JSON：`status`、`reason`、`rounds`（实现报告、直接修复评审、真实命令/退出码/输出）、`journal`。只有本轮全部所选检查退出 0 才为 `passed`；不表示未选择的检查或所有业务要求都通过。退出码：通过 0，阻塞 4，输入/调用入口错误 1。

状态在当前 profile 的 `daily-code/<request-key 的 SHA256>/result.json` 中原子保存（0600）；Bot Job 与会话在同目录 `bots/` 中。此目录必须在可写工作区之外。执行前落盘阶段与任务数据，完成后保存已知证据；超时、取消、进程未知退出、报告异常、轮次耗尽或清理未确认都阻塞。默认总期限 30 分钟，可设置 `timeoutMs`。

同 key 同输入只重放终态报告；同 key 不同输入拒绝；崩溃留下未完成阶段时返回阻塞并保留已知证据，不自动恢复、续跑或重放副作用。先核查 journal、Bot 会话、工作区和可能遗留的验收进程，再决定是否人工启动新 key；不要用新 key 自动绕过未知结果。工作区互斥锁只协调同一 profile 的此宿主，不排斥其他编辑器、Graph 或其他 profile。

## Graph / OMH 发现

`omp graph templates --format json` 在独立的 `workflows` 字段列出此宿主契约；既有 `graph_read` 的 `templates` 也附带它，`operation: workflows` 返回完整入口、输入、权限和退出码。OMH 的 `omp-graph` 注册项指向 `omp bot workflows --json`，调用方可从该入口发现命令与契约。

This Bot-host workflow remains separate from the importable `daily-code` Graph template. Discover the Graph with `omp graph templates` and import it with `omp graph import --template daily-code --request-key KEY`; its local foreground runner supports the template's fixed bounded rework topology and requires explicit workspace-write and workspace-code approval.

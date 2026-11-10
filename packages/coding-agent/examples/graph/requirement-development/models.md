---
models:
  gpt-6.1-terra:
    provider: openai-codex
    model: gpt-6.1-terra
  gpt-6-astra:
    provider: openai-codex
    model: gpt-6-astra
  gpt-6.1-sol:
    provider: openai-codex
    model: gpt-6.1-sol
  gpt-6-luna:
    provider: openai-codex
    model: gpt-6-luna
---

# requirement-development 模型绑定配置

按成本与能力分工（上下文与单价来自 `omp models openai-codex --json` 实测）：

| 模型 | 上下文 | 价格 入/出 每 M | 承担角色 |
|---|---|---|---|
| `gpt-6.1-terra` | 500K | $1 / $5 | 调研取证（`researcher`）、OMP 默认基座编码与冻结集成（`implementation-lead`、`integrator`） |
| `gpt-6.1-sol` | 500K | $2 / $10 | 规范指引（`guide-author`）、OpenSpec 撰写（`spec-author`）、独立上下文 Mind Test 评审（`reviewer`）、终审（`adjudicator`） |
| `gpt-6-luna` | 272K | $0.1 / $0.5 | 冻结版本独立测试（`tester`）与验收裁定（`acceptance-reviewer`） |
| `gpt-6-astra` | 272K | $10 / $50 | 只作 `advisor`：`duty: consult`，问/答专用，无任何工具 |

Astra 的上下文并不比 Terra/Sol 长（272K vs 500K），单价却是 Terra 的 10 倍、Sol 的 5 倍。它不是长上下文角色，只适合“带着最小材料换一个第二意见”。因此它没有节点、没有读写权限，只能被 `researcher`/`spec-author`/`reviewer` 通过 `#advisor-rules` 提问；入参上限 64 KiB、答复上限 32 KiB，超限即失败。

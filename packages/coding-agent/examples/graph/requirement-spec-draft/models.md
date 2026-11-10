---
models:
   gpt-6.1-terra:
      provider: openai-codex
      model: gpt-6.1-terra
   gpt-6.1-sol:
      provider: openai-codex
      model: gpt-6.1-sol
   gpt-6-astra:
      provider: openai-codex
      model: gpt-6-astra
---

# requirement-spec-draft 模型绑定配置

按成本与能力分工：

- **Terra (`gpt-6.1-terra`)**：任务单收敛（`framer`）与规格草案撰写（`spec-author`）。500K 上下文、$1/$5。
- **Sol (`gpt-6.1-sol`)**：默认顾问（`consultant`）。500K 上下文、$2/$10。与被写规格不同的模型、不同的上下文，独立性已经成立。
- **Astra (`gpt-6-astra`)**：可选高阶顾问，仅用于高风险评审。272K 上下文、**$10/$50**。

## 为什么默认不用 Astra

真实 Run `4da5816e` 的分节点用量（目录价折算）：

| 节点   | 模型  |   输入 |  输出 | 缓存读 |        成本 |      占比 |
| ------ | ----- | -----: | ----: | -----: | ----------: | --------: |
| frame  | Terra | 12,959 |   314 | 25,472 |     $0.0158 |      7.4% |
| spec   | Terra |  1,619 | 1,414 | 40,064 |     $0.0107 |      5.0% |
| review | Astra | 14,487 |   290 | 28,416 | **$0.1878** | **87.6%** |

顾问只输出 203 字，却吃掉 87.6% 的成本：因为 Astra 单价是 Terra 的 10 倍，而顾问输入要带规格全文。独立性来自「另一个模型、独立上下文」，不来自更贵的档位；同一次问答换 Sol 约为 $0.038。

Astra 的上下文（272K）也小于 Terra/Sol 的 500K，所以它不适合长文归纳。它只出现在 `duty: consult` 节点：一个必填输入、一次问答、无工具权限，由运行器强制 64 KiB 输入与 32 KiB 输出上限。

切换到 Astra 的方法：把 `GRAPH.md` 里 `consultant.model` 改为 `gpt-6-astra`，并保留本文件的 `gpt-6-astra` 绑定。

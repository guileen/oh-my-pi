---
models:
   gpt-6.1-terra:
      provider: openai-codex
      model: gpt-6.1-terra
   gpt-6.1-sol:
      provider: openai-codex
      model: gpt-6.1-sol
---

# local-code-slice 模型绑定配置

- **Terra (`gpt-6.1-terra`)**：默认绑定，同时用于 `coder` 与 `reporter`。500K 上下文、$1/$5，适合读代码、改文件、跑测试。
- **Sol (`gpt-6.1-sol`)**：可选。想换一个不同模型复核时把 `reporter.model` 改成它（$2/$10），摘要质量差异很小，成本翻倍。

编码节点的成本主要来自上下文：它要读真实文件并看测试输出，所以一次切片通常比纯文本 Graph 贵。用 `omp graph status <run>` 看分节点用量再决定是否值得换模型。

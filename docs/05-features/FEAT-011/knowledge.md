# FEAT-011 — 项目知识

## 决策记录

- MEM-ID 走项目级计数器（project.lock）而非 run 级：记忆是跨 run 资产，编号权威必须在 run 之上。
- candidates 与 promote 分离（只列不选/人来措辞）：25 §4 的"机械晋升人把关"在 API 形状上的体现——gateway 永不代写一句话决策。
- 拒收码统一 memory_entry_invalid（含载体路径问题）：调用方一个分支即可兜住全部晋升失败。

## 经验教训

- markdown 作为受管数据载体时，"条目=固定两行块"（bullet+戳）是可机械搬移/校验的最小结构——超过两行就该换 json。

## 可复用模式

- "三层出库防线"（redaction 拒收 → gitignore 拒 → PR 终审）适用于一切 .team→git 的口子。
- 规则批销账：SKIPPED 表按 FEAT 收缩是审计覆盖率的可见推进器。

## 应避免的做法

- 不要让 gateway 自动摘要晋升（无 LLM 红线，25 §7）；
- 不要物理删除被替代条目（Superseded 区保留出处=决策考古学）。

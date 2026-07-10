# FEAT-002 — 项目知识

## 决策记录

- `duplicate_payload` 专属 reason code（backflow 定名）：重复导入既不是 schema 错也不是 usage 错，归 exit 6 冲突类——**合同缺口在实现期暴露时走显式 backflow，不借用近似 code**（模式候选）。
- 稳定序列化（递归 key 排序）做指纹，而非原文 hash：字段顺序差异不应视为不同计划。
- 校验全部前置于任何落盘：零残留语义靠"先验证后建目录"而非事后回滚兜底；回滚仅兜 io 异常。

## 经验教训

- zod passthrough + 显式 FORBIDDEN 扫描的组合优于 strict 模式：既保未知字段（21 §4.2），又拦伪造运行态字段（09 §9）——两个需求用一个 schema 表达会互相打架。
- 同步 CLI 里的锁等待用短忙等（50ms 步进）足够；引入 async 会传染整个原语签名，MVP 不值。

## 可复用模式

- **事务写序模板**：状态文件（writeJsonStateNew，rev=1）→ 计数器 bump（writeJsonStateAtomic）→ events 追加（提交点）→ envelope；后续 publish/claim/submit 全部沿用此骨架。

## 应避免的做法

- 不要在校验阶段之后再分配 ID/建目录之前之外的位置写任何文件；不要用 JSON.stringify 原文做去重指纹。

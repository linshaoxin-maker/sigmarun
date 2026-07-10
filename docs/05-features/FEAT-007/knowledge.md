# FEAT-007 — 项目知识

## 决策记录

- handoff 由 gateway 代写（draft 携带内容）：RULE 2 禁 agent 直写 .team，14 §2.1 又要求 handoff_ref 文件已存在——两约束的唯一交集是 submit 事务内代写。
- 校验先行、写入后置：全部 errors 收集完才动第一笔盘（evidence_invalid 保证零残留）；对照 publish/claim 的"守卫→变更→事件"，submit 把守卫段做成了纯函数清单。
- in_scope 判定丢弃 agent 自报值：evidence 是 agent 自报事实，但**可机械重算的字段一律重算**（AUD-014 的 inline 化）。

## 经验教训

- **字段名错读会静默吞掉配置**：claim-engine 读 `rdoc.policy`（正确为 `default_policy`），`...(undefined ?? {})` 让默认值兜底、测试全绿——直到新消费方需要非默认值才暴露。防线：跨文件消费 schema 时 grep 生产方写入代码（FEAT-005 已有此教训，这次是"默认值掩护"变体：**兜底逻辑会掩盖读错的键**）。

## 可复用模式

- truncateOutput（行数+字节双上限）与 redactText（模式替换+hits 计数）是通用管道件，FEAT-010 export 直接复用。
- emitInvalid 闭包：失败事件 + 结构化错误清单一次成型。

## 应避免的做法

- 不要在校验通过前创建任何目录/文件（mkdirSync 也算写）；
- 不要把"可选字段缺失"与"声明了但失效"混为一谈（output_file 声明即必须存在）。

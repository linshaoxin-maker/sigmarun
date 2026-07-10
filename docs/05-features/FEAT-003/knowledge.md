# FEAT-003 — 项目知识

## 决策记录

- 跨 run 重叠检查放在**一切变更之前**：block 语义要求零残留，先判后写与 import 校验前置同构（事务模板第 0 步：守卫）。
- 幂等语义选"跳过 + 警告"而非报错：重复 publish 是用户重试的正常路径，不该罚。
- cross_run_overlap_detected 事件 actor=policy（机械判定），task_published actor=user（人的决定）——actor 语义按"谁做的决定"而非"谁敲的命令"。

## 经验教训

- 读其他 run 做重叠检查时不能拿对方 run.lock（会死锁/串行化全库）：只读快照 + 事件留痕即可，与 audit 无锁读同口径。

## 可复用模式

- **守卫→变更→事件三段式**已在 import/publish 两处成型，FEAT-004 claim 直接套用。

## 应避免的做法

- 不要在 warn 策略下把重叠做成第二次拦截（agent 会困惑）；warn 就是纯信息 + 事件。

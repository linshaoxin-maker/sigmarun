# Feature 验证报告：FEAT-005 Context Plane

> 2026-07-10 ｜ 用户可见 ｜ RED 17/17 先行 → GREEN 103/103（新增 17 context + 1 cli）

## 1. 四可检验

| 项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | 五个新命令：msg post / msg list / context hydrate / graph validate / memory update |
| 可演示 | ✅ | 真机：blocker+question 入池 → `--open` 派生 → memory update → hydrate（2 must-read/2 消息/1 开放问题）→ graph 体检 |
| 可端到端 | ✅ | claim 后 hydrate 拿到 must_read+消息+风险+previous_attempts；context_hydrated 事件为 AUD-028 对账留锚 |
| 可独立上线 | ✅ | 读面完整；submit 写半场（handoff/context_ack）书面归 FEAT-007 |

## 2. 场景锚（Slice 4 验收四条 + 合同）

| 锚 | 测试 |
|---|---|
| 12 §6 消息行全字段 + MSG 计数 | msg.test `appends a full message line…` |
| **INV-011 无 message_posted 事件** | `does NOT write any event`（events 行数不变的显式断言） |
| type/body/发送者守卫 | `rejects unknown type…` / `rejects an unregistered sender` |
| secret warn-only（管道随 FEAT-007） | `warns (but posts)…` |
| M23 开放问题派生 | `filters by task and type; --open…`（answer 关闭 question） |
| 12 §8 pack + #39 事件 | hydrate.test `assembles the base pack…`（payload.must_read 与 data 一致） |
| 上游 handoff/evidence 入 must_read | `pulls upstream handoff…`（blocks 边反查） |
| **D19 继承读路径** | `includes the L4 project memory…`（docs/team/MEMORY.md 按 project.json 指针） |
| risks + 开放问题过滤 | `surfaces avoid/requires_approval…` |
| 15 §5.3 previous_attempts 透传 | `passes previous_attempts through` |
| Slice 4 验收 1（graph validate） | graph-memory.test 三例：健康图 / AUD-022 悬空边 / AUD-021 注环复检 |
| 12 §7 run memory | `replaces run-memory.md atomically…`（无出处 warn）/ secret **拒收** + 旧文件保全 |
| cli 全链 | cli.test `msg post -> context hydrate roundtrip` |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/2/3 | PASS | build exit 0；103/103，覆盖 92.62%/79.51%（阈 80/70）；契约偏离零（edge 字段名 `kind` 以 run-import 实写为准，测试期核对） |
| G5-4 回归 | PASS | FEAT-001…004 全部 85 既有用例同套件持续绿 |
| G5-5…12 | PASS | 本文件 + self-check + knowledge + 卡片 + 矩阵/CHANGELOG/progress + commit（Refs: FEAT-005） |
| G5-13 | N/A | 无量化 NFR 挂本 FEAT |
| G5-14 | Secrets PASS（memory 拒收 + msg warn 双档已测）；SCA 仍 BLOCKED | — |
| G5-15 | PASS（inspection） | context → core+storage；cli → context；无反向 |
| G5-16…23 | N/A | 同前 |

## 4. 残余（书面）

- [FEAT-007] submit 写 context/tasks/<TASK>.md + evidence.context_ack 对账（AUD-028 完整闭环）；消息体全量脱敏管道。
- [FEAT-008] blocker/开放问题在 status 面板可见（查询命令 `msg list --open` 已可用）。
- [FEAT-011] memory refs 硬校验与 L4 promote（BR-005 全量）。

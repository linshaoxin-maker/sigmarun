# Feature 验证报告：FEAT-008 status/watch/audit/repair 与查询面

> 2026-07-11 ｜ 用户可见 ｜ RED 17/17 先行 → GREEN 149/149（新增 18：watch 7 + audit 9 + dispatch 回归 1 + cli 1）

## 1. 四可检验（复合 FEAT——四子项各自可验收）

| 子项 | 可感知/可演示 |
|---|---|
| 008.1 status+查询面 | `status`（权重 progress/风险/Needs-user 带命令）+ `run list`/`task show`/`evidence show`；真机：blocker 风险 → `next: sigmarun msg list …` |
| 008.2 watch | `watch --once` 真机 tick（sweep+快照）；单实例锁拒 + --force；终态即退 |
| 008.3 audit | `audit run` 真机：14 规则、26 登记跳过、**捕获 FEAT-007 冒烟留下的真实越界（AUD-014 warn）**、exit 0 |
| 008.4 repair | 干净仓 no-op；漂移修复 + 备份 + state_repaired + 幂等二跑 |

## 2. 场景锚

| 锚 | 测试 |
|---|---|
| Slice 7 验收：计数/权重 progress/derived | status.test `reports status counts…`（progress.json team.progress.v1） |
| stale 风险 + 15 §5.1 blocked 豁免 | `progress counts done weight…`（豁免权威=task.json，实现期修正） |
| M32 Needs-user 四类之三 + 可复制命令 | `unresolved blockers…`（approval_pending/blocker/reclaim_confirm；停等确认类随 FEAT-009 追加） |
| 查询面逐字段一致 | `run list / task show / evidence show mirror the facts`（含"暂无 evidence=ok+null"查询语义） |
| 17 §7 watch 三则 + BDD-007-07 | watch.test 三例（tick sweep 复用 claim-next 同段代码=sweepRun） |
| **sweep 半提交回归锁（FEAT-004 隐患修复）** | lease.test `sweep persists its reclaim even when the claim attempt then fails a guard` |
| 18 §7 envelope/exit-0 | audit.test 全组（findings=data；干净仓 rules_run/rules_skipped 断言含 AUD-032 rev_after 债） |
| AUD-001/003/011/013/029/033 各注入即中 | audit.test 五例（篡改/删档/断号/删 worktree） |
| 17 §5.3 + BDD-007-06 | repair.test 三例（账本前滚/备份/state_repaired/幂等 no-op/meta 先修再记事件） |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/2/3 | PASS | build exit 0；149/149，覆盖 90.82%/75.10%（阈 80/70）；偏离均书面（§4） |
| G5-4 回归 | PASS + 缺陷修复 | 131 既有用例持续绿；**FEAT-004 sweep 持久化时序隐患修复**（sweep 动作即时落盘，回归锁入 lease.test） |
| G5-5…12 | PASS | 本文件 + self-check + knowledge + 卡片 + 矩阵/CHANGELOG/progress + commit（Refs: FEAT-008） |
| G5-13 NFR-005 | PASS | audit 快照 seq + concurrent_writes_detected（无锁读合同）；NFR-002 由 watch 单实例锁 + sweep 复用补强 |
| G5-14 | Secrets PASS；SCA 仍 BLOCKED | — |
| G5-15 | PASS（inspection） | watch → dispatch+core+storage；audit → core+storage；无环 |
| G5-16…23 | N/A | 同前 |

## 4. 残余（书面）

- [债] **rev_after**：写事务事件缺 18 §3 要求的 rev_after 字段 → AUD-032 登记跳过；回填为跨 FEAT 待办（进下一步队列）。
- [FEAT-009/010] AUD-005…020/023…028 的 review/verify/context 对账批（audit 引擎注册位已留）；Needs-user 停等确认类。
- [FEAT-011] AUD-036…040。
- [P1] AUD-034 重放引擎、`--fail-on` CI 门禁、watch NDJSON 行合同、team-status 等模板补装（并入 FEAT-009，书面改派）。

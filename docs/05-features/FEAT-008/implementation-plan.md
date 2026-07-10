# FEAT-008 实现计划

## 改动面

| 文件 | 动作 |
|---|---|
| packages/watch/src/{progress.ts,watch.ts,index.ts} | computeProgress/statusRun/runList/taskShow/evidenceShow；watchOnce（锁/终态/sweep/快照） |
| packages/audit/src/{engine.ts,repair.ts,index.ts} | 14 条规则 + 跳过登记；repairRun（备份/前滚/幂等） |
| packages/dispatch/src/claim-engine.ts | 提取导出 sweepRun；sweep 动作即时持久化（修 FEAT-004 隐患） |
| packages/cli/src/cli.ts | status / run list / task show / evidence show / watch / audit run / repair |
| 根接线 | watch+audit 包 |

## 测试（RED 先行）

- watch/test/status.test.ts：计数+权重 progress；stale 风险（blocked 豁免）；blocker 风险；Needs user 三类带命令；progress.json 派生落盘；run list/task show/evidence show 事实一致。
- watch/test/watch.test.ts：--once 执行 sweep（3×TTL 回收）+ 快照；第二实例拒 + --force；终态即退。
- dispatch/test/lease.test.ts 追加：**sweep 后守卫失败仍持久化回收**（回归锁）。
- audit/test/audit.test.ts：干净仓 0 findings + rules_run/skipped；注入重复 claim→AUD-001；过期租约→AUD-003（blocked 豁免例）；acceptance 错配→AUD-013；seq 断号→AUD-033；worktree 丢失→AUD-029；exit 恒 0。
- audit/test/repair.test.ts：list 行漂移按事件链修复 + 备份目录 + state_repaired + 二跑 no-op；meta 计数器漂移前滚。

## 风险

- audit 无锁读：快照期间 seq 前进 → concurrent_writes_detected 置位（不重读）。
- repair 的事件→状态映射表只覆盖已实现事件（claimed/working/submitted/approved/ready 族）。

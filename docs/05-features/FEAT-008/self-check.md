# FEAT-008 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 17 §7 watch（循环体/只读性/单实例/退出/--once） | watchOnce + cli 循环包装（Atomics.wait 同步睡眠，无 OS 守护——D14） | NDJSON 流未做（P2 合同未定稿，书面）；循环模式不进自动化测试（长驻进程），--once 全覆盖 |
| 18 §7 audit 语义 | 只读无锁、exit 0、findings 带 rule_id/severity/next_action/refs、快照 seq + concurrent_writes_detected、rules_skipped 全登记 | 40 条中 14 条落地；26 条登记跳过带原因（数据面未生或 rev_after 债）——**跳过是登记不是省略** |
| 17 §5.3 repair | 计划先行（dry）→ 备份 → meta 先修 → 状态按账本末态修 → state_repaired/项 → 幂等 | 回滚方向（未提交残留删除）未做：当前事件映射只支持前滚；缺账本支持的孤儿文件列 findings 交人工（书面） |
| M32 Needs-user | 批准/blocker/回收确认三类 + 命令 | 停等确认（changes_requested）类随 FEAT-009（书面） |
| INV-006 派生 | progress.json 无 rev、可删重算；AUD-035 对账 | 无 |
| 15 §5.1 豁免权威 | task.json（status/audit 同口径） | 实现期修正：初稿误用 list 行 |

## 测试 / 质量

- 149/149（新增 18）；覆盖 90.82%/75.10%；RED 17 先行；真机六命令冒烟（audit 捕获真实历史越界）。
- engine.ts ≈ 420 行（规则表数据为主）；repair.ts ≈ 180 行；progress.ts ≈ 240 行——规则/清单风格沿用既有豁免口径；TODO 0。
- **随做修复**：FEAT-004 sweep 持久化时序（sweep 后守卫失败留半提交）——sweepRun 提取 + persistSweep 即时落盘 + 回归锁。

## 安全

- audit/repair 只读/机械写，无新增 secret 面；备份目录在 .team/backups/（gitignore 域内）。
- watch 循环模式 --force 用于自愈重入（第二 tick 起），单实例语义靠首 tick 锁竞争。

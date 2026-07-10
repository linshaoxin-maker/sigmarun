# FEAT-008 status/watch/audit/repair 与查询面（复合：008.1–008.4）

状态：**已交付**（2026-07-11）｜ 源：Slice 7 ｜ 依赖：FEAT-007 ｜ 被依赖：FEAT-009/010

制品：[mvp-scope](mvp-scope.md) · [implementation-plan](implementation-plan.md) · [verification](verification.md) · [self-check](self-check.md) · [knowledge](knowledge.md)（卡片在 project-knowledge/features/FEAT-008.md）

代码：**新包 `packages/watch/`**（status/progress/run list/task show/evidence show + watch --once）与 **`packages/audit/`**（14 条规则引擎 + 26 条登记跳过 + repair）；dispatch 提取 sweepRun 并修复 sweep 半提交隐患；cli 七路由；测试 +18（累计 149）。留债：rev_after（AUD-032）、回滚方向 repair、其余规则批随 009/010/011。

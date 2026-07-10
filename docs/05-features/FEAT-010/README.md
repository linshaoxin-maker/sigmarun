# FEAT-010 verify + integrate + export（复合：010.1–010.3）

状态：**已交付**（2026-07-11）——**MVP 主链 FEAT-001…010 闭合** ｜ 源：Slice 9 ｜ 依赖：FEAT-009 ｜ 被依赖：FEAT-011（P1）

制品：[mvp-scope](mvp-scope.md) · [implementation-plan](implementation-plan.md) · [verification](verification.md) · [self-check](self-check.md) · [knowledge](knowledge.md)（卡片在 project-knowledge/features/FEAT-010.md）

代码：dispatch/verify.ts（task/run 双目标 + verifier 合成）；core/integrate.ts（start/record/report，gateway 不碰 git）；core/export.ts（阻断式脱敏归档）；`deps_satisfied_when` 策略位；cli 五路由；测试 +13（累计 172）。真机北极星全链走通。

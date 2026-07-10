# FEAT-009 review gate（含 D15 自主领取）

状态：**已交付**（2026-07-11）｜ 源：Slice 8 ｜ 依赖：FEAT-008 ｜ 被依赖：FEAT-010

制品：[mvp-scope](mvp-scope.md) · [implementation-plan](implementation-plan.md) · [verification](verification.md) · [self-check](self-check.md) · [knowledge](knowledge.md)（卡片在 project-knowledge/features/FEAT-009.md）

代码：dispatch/review.ts（claim/合成/approve/request-changes/resume + 租约回收）；core/submit 补 skip 记录；repair 事件映射扩 review 族；adapters 补 /team-review、/team-status；cli 四路由；测试 +10（累计 159）。留待 FEAT-010：block 决定、verify 合成、task 级 review.required 覆盖。

# FEAT-009 实现计划

## 改动面

| 文件 | 动作 |
|---|---|
| packages/dispatch/src/review.ts | reviewSweep / reviewClaim / synthesizeReview（claimNext 调）/ reviewDecide / resumeTask |
| packages/dispatch/src/claim-engine.ts | claimNext reviewer 分支接合成 |
| packages/core/src/submit.ts | skip 时写 skipped_by_policy 最小 REVIEW 记录 |
| packages/audit/src/repair.ts | EVENT_STATUS 补 review 族 |
| packages/storage/src/errors.ts | +self_approval_forbidden |
| packages/adapters/src/templates.ts | +team-review.md、team-status.md |
| packages/cli/src/cli.ts | review claim/approve/request-changes、resume 路由 |

## 测试（RED 先行）

- dispatch/test/review.test.ts（12）：BDD-006-01 合成（kind/claim/round）；-02 自批拒（现任+previous_attempts 两例）；-03 无 must_fix 拒；-04 返工全链（复活/路径仍占/他人 path_conflict/resume→working）；-05 过期回收（review_released+回 submitted）；approve 全链（记录/事件/claim 完结）；非持有人拒；轮次叠加（REVIEW-…-01/02 并存）；skip 记录（require_review=false）；重复 review claim 拒。
- cli：review 路由 1 例。

## 风险

- 镜像消息先行以取 MSG id（消息池计数器在 run.lock 内，与 review 事务同锁完成）。
- claimNext reviewer 分支绕过 task-list 候选逻辑——同函数内早分支，防守卫序漂移。

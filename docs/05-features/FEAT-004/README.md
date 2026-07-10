# FEAT-004 claim-next + 锁 + 回收

状态：**已交付**（2026-07-10）｜ 源：Slice 3+4 ｜ 依赖：FEAT-003 ｜ 被依赖：FEAT-005…010

制品：[mvp-scope](mvp-scope.md) · [implementation-plan](implementation-plan.md) · [verification](verification.md) · [self-check](self-check.md) · [knowledge](knowledge.md)（卡片在 project-knowledge/features/FEAT-004.md）

代码：新包 `packages/dispatch/`（claim-engine：register/claim-next/heartbeat/release/reclaim/approve-paths + 3×TTL sweep）；错误码 +12、cli 六路由；测试 +25（累计 85）。回填：docs/17 §3 `claim_not_found`/`not_claim_owner`。留待：minimatch→FEAT-007、lock_takeover 事件→FEAT-008、reviewer 合成队列→FEAT-009、NFR-001 压测→CI。

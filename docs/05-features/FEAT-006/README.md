# FEAT-006 dispatch 端到端（--as/--task/--role/--loop）

状态：**已交付**（2026-07-11）｜ 源：Slice 5 ｜ 依赖：FEAT-005 ｜ 被依赖：FEAT-007…010

制品：[mvp-scope](mvp-scope.md) · [implementation-plan](implementation-plan.md) · [verification](verification.md) · [self-check](self-check.md) · [knowledge](knowledge.md)（卡片在 project-knowledge/features/FEAT-006.md）

代码：dispatch 包 +worktree.ts（register/adopt + 回收联动）；core +run-query.ts（run show）；**新包 `packages/adapters/`**（19 号模板全文 + 安装器：/team-plan、/team-dispatch、/team-publish、Codex skill、AGENTS 段落）；cli 四路由；测试 +14（累计 117）。留待：其余 9 模板随 FEAT-008/009/010、conformance CI、user scope 安装（P1）。

# FEAT-004 实现计划

## 改动面

| 文件 | 动作 |
|---|---|
| packages/dispatch/{package.json,tsconfig.json} | 新包（deps: @sigmarun/core, @sigmarun/storage） |
| packages/dispatch/src/claim-engine.ts | registerAgent / claimNext / heartbeat / releaseTask / reclaimTask / approvePaths + sweep 内联 |
| packages/dispatch/src/index.ts | 导出 |
| packages/storage/src/errors.ts | +10 reason codes |
| packages/cli/src/cli.ts | 路由 agent register / claim-next / heartbeat / release / reclaim / approve-paths + exit 映射 |
| 根 tsconfig/vitest/cli package.json | dispatch 引用与别名 |

## 事务骨架（claim-next）

守卫 0：run 打开（run_not_found）→ **run.lock** → 读 run/agents/claims/list → sweep（3×TTL，blocked 豁免）→ BR-001 #1…#9 → 排序选取 → dry-run 分叉 → 写 claims→task.json→list→agents→counters → events（reclaimed…claimed…path_claimed）提交点 → 释放锁。

## 测试（RED 先行）

- register.test.ts：注册成功+事件；label 幂等复用（BDD-003-05）；未注册即领 → agent_not_registered。
- claim.test.ts：BDD-003-01 全断言（文件/事件/租约/worktree 建议）；BDD-002-02 planned 拒；BDD-003-02 依赖阻塞→no_claimable_task+excluded；BDD-003-03 路径冲突（跳过+定向 path_conflict+blocked_by）；BDD-003-04 agent_claim_limit；BDD-004-02 task_already_claimed 零变更；BDD-004-03 deps_blocked；BDD-003-08 requires_approval 拒→approve→通过；优先级排序；--dry-run 零写入；--role 定向 capability_mismatch。
- lease.test.ts：heartbeat 续租；release 全链（previous_attempts/路径同释/他人可再领）；manual reclaim 过期前拒（invalid_transition）/过期后成功；sweep 3×TTL 自动回收再领取（actor sweep）；过期未满 3× 不回收；blocked 豁免。

## 风险

- 排序 depth 计算：depends_on 最长祖先链，list 内 BFS，环已被 FEAT-002 拒于门外。
- run counters 无 `next_agent`/`next_approval` 字段（FEAT-002 未预置）→ 读取时 `?? 1` 兜底，写回补齐。

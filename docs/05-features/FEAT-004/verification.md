# Feature 验证报告：FEAT-004 claim-next + 锁 + 回收

> 2026-07-10 ｜ 用户可见 ｜ RED 23/23 先行 → GREEN 85/85（新增 23 dispatch + 2 cli）

## 1. 四可检验

| 项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | 六个新命令：agent register / claim-next / heartbeat / release / reclaim / approve-paths |
| 可演示 | ✅ | 真机 12 事件全链：init→import→publish→register→claim→幂等 register→heartbeat→上限拒→release→claim_not_found |
| 可端到端 | ✅ | run.lock 事务内 sweep→九守卫→排序→双 claim 写入→events 提交点 |
| 可独立上线 | ✅ | 发布后的队列即刻可被多窗口 agent 并发消费；FEAT-005/006 在其上加 context/dispatch |

## 2. 场景锚

| 锚 | 测试 |
|---|---|
| BDD-003-01 领取全链 | claim.test `claims the dependency-free task…`（claims/task.json/list/agents/事件/租约/worktree 建议 全断言） |
| BDD-003-02 依赖阻塞 | `dependency-blocked queue…`（no_claimable_task + excluded[deps_blocked]） |
| BDD-003-03 路径冲突 | `path overlap skips…`（无冲突候选照常领 + 定向 path_conflict + blocked_by） |
| BDD-003-04 agent 上限 | `an agent holding an active claim is capped`（M36/D17） |
| BDD-003-05 label 幂等 | register.test `same label is idempotent`（同 id、reused=true、单文件） |
| BDD-003-08 requires_approval | `requires_approval blocks…`（拒→approve-paths→通过；AUD-004 inline） |
| BDD-004-02 定向已占 | `directed claim on a held task…`（零变更断言） |
| BDD-004-03 定向依赖阻塞 | `directed claim on a dependency-blocked task` |
| BDD-002-02 未发布拒领 | `rejects on a planned run`（FEAT-003 留债闭合） |
| BDD-007-02 手动回收 | lease.test `manual reclaim of an expired lease`（未过期拒 invalid_transition 另测） |
| BDD-007-03 3×TTL sweep | `sweep auto-reclaims past 3xTTL…`（actor=sweep、triggered_by、previous_attempts；未满 3× 不收、blocked 豁免各一测） |
| BR-001 行 6 | `role mismatch…` capability_mismatch |
| 10 §7 排序 | `picks the higher-priority task first` |
| 10 §2.1 dry-run | `--dry-run explains…`（零写入断言） |
| BR-001 行 9 | **豁免**（P2 既定：纯并发上限归 P5 压测；代码守卫已在，无 BDD） |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/2/3 | PASS | `npm run build` exit 0；85/85，覆盖 93.23% lines / 80.21% branches（阈 80/70）；契约偏离仅书面两项（§4） |
| G5-4 回归 | PASS | FEAT-001/002/003 全部 60 既有用例同套件持续绿 |
| G5-5…12 | PASS | 本文件 + self-check + knowledge + 卡片 + 矩阵/CHANGELOG/progress + commit（Refs: FEAT-004） |
| G5-13 NFR | 部分 PASS | NFR-002 锁语义（storage lock 用例 + 单事务全链）；NFR-001 16 并发压测留 CI（书面豁免同 BR-001 行 9） |
| G5-14 | Secrets PASS（agents/*.json 无凭据/机器指纹字段）；SCA 仍 BLOCKED（跨 FEAT 待办） | — |
| G5-15 | PASS（inspection） | dispatch → core+storage 单向；cli → dispatch；无反向依赖 |
| G5-16…23 | N/A | 同前例 |

## 4. 残余（全部书面）

- [FEAT-007] minimatch 文件级 in_scope 判定（重叠判定当前为保守前缀法，10 §8.2 允许；改派理由见 mvp-scope）。
- [FEAT-008] lock_takeover 事件接线（storage 层无 runDir 上下文，挂账顺延）。
- [FEAT-009] BR-001 行 6 的 reviewer 合成队列半场（D15）。
- [CI] NFR-001 16 并发压测（17 §10）。
- [回填] docs/17 §3 已补 `claim_not_found` / `not_claim_owner` 两码（规则 3 显式执行）。

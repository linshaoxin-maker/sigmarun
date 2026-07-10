# 全量代码审查与修复轮（2026-07-11）

> 范围：`faafeae...HEAD` 全部实现（86 文件 / 9591 行）。流程：8 查找角度（3 正确性 + 复用/简化/效率 + 高度 + 约定）→ 43 候选 → 去重 16 条逐条对抗验证 → **14 成立 / 2 驳回** → 全部修复 + 12 条回归锁。修后 192/192 绿。

## 成立并已修复（按严重度）

| # | 位置 | 缺陷 | 修法 |
|---|---|---|---|
| 1 | core/publish.ts | 锁路径 `locks/run.lock` 与全系 `run.lock` 不一致——publish 与 claim/submit 互斥失效（重复 seq/rev 竞争） | storage 新增 `tryAcquireLock`+`runLockPath` 统一助手，11 处锁点全部收敛（漂移根因一并消除） |
| 2 | audit/repair.ts | 重放表缺 `verification_passed`/`task_integrated`——repair 会把健康的 verified/integrated 任务改写回 approved | 补表项 + `verification_failed` 按 payload.failures_mapped 特判 + keepOwner 家族扩展；回归锁：健康 verified+integrated run → repair no-op |
| 3 | dispatch/review.ts | sweepReviewClaims 半提交：守卫失败路径不落盘 rc，重复 review_released 无限累积；成功路径双扫双事件 | sweep 自持久化（先状态后事件），rc.rev 就地步进；回归锁：过期+守卫失败 → 恰一条事件、盘面 released |
| 4 | dispatch/verify.ts | verifySubmit 无独立性/注册守卫——作者可自验自己的任务 | +agent_not_registered 门 + task 级 historicalOwners 检查（self_approval_forbidden）；synthesizeVerify 改用共享 historicalOwners（内联副本删除） |
| 5 | dispatch/claim-engine.ts | applyReclaim 在 claims/list 持久化前追加提交点事件（17 §5.3 倒置），崩溃窗留重复回收 | applyReclaim 改为返回事件，四条调用路径（sweep×2/release/reclaim）统一"详情→索引→claims→事件"次序 |
| 6 | dispatch/verify.ts | run 级 failures_mapped 无存在性/状态守卫——幻影 id 被记成功、非可回退任务被翻转 | 写前校验：id 必须存在且状态 ∈ {approved,verified,integrated}；schema_invalid 零变更 |
| 7 | dispatch/claim-engine.ts | 定向领取（--task）绕过 run 级 max_parallel_tasks（BR-001 行 9） | 定向分支 finishClaim 前补 Guard #9 |
| 8 | context/memory-promote.ts | 只持 project.lock 就写 run 账本——与 run.lock 持有者并发产生重复 seq（自制 AUD-033 证据） | project.lock → run.lock 双锁（定序防死锁），finally 逆序释放 |
| 9 | 四处 events.jsonl 读点 | 断行（ENOSPC/断电）令 submit/report/audit/repair 全部原始栈崩溃（连修复工具都崩） | core 新增 `readEventsSafe`（容错逐行）；audit 报 AUD-033 error、repair 列 manual finding，submit/report 忽略断行继续 |
| 10 | cli.ts watch | `--interval=30s` → NaN → Atomics.wait(+∞) 首 tick 后永久挂起 | 数值校验，非法即 usage_error |
| 11 | core/run-query.ts | 读 `run.policy`（实为 `default_policy`），run show 永不显示策略 | 字段名修正 + 回归锁 |
| 12 | context/memory-promote.ts | 包含检查缺尾分隔符——`../repo-backup` 侧目录逃逸可写仓库外（实证复现） | `repoRoot + '/'` 锚定（与 export.ts 同式）+ 回归锁 |
| 13 | core/integrate.ts | `--failed` 复活租约硬编码 30 分钟，无视 policy TTL | 读 default_policy.claim_ttl_minutes + 回归锁 |
| 14 | dispatch/verify.ts | verify 输出无截断（对照 evidence 的 256KB 管道） | truncateOutput 从 core 导出复用，记录 output_truncated；顺带清除死脚手架（`{saveState:null as never}`、`void findActiveClaim`、worktree `void ACTIVE`） |

## 驳回（2 条，留档防复查）

- **sweep 扫 paused run**：15 §2.4 操作矩阵明确允许 paused 期 reclaim（pause 只冻结派活，心跳仍在——过期即真死亡），设计如此。
- **worktree branch 正则注入**：run/task id 全部网关自派（`id4` 四位数格式），openRun/claim 守卫在正则之前，不手工伪造 `.team` 内容不可达——留作卫生项不作缺陷。

## 结构性根因（已一并处理/登记）

- **锁样板 11 处复制导致漂移**（#1 的根因）→ `tryAcquireLock` 收敛完成。
- **"事件最后写"靠各事务手工维持** → #3/#5 修复后，claim/review 两族已结构化（事件由持久化完成点统一追加）；grantReviewClaim/reviewDecide 内部的 claims-先于-详情 次序（conventions 角度候选，未上报）登记为收尾轮卫生项。
- 效率类候选（audit evidence() 无缓存、synthesizeReview O(rows×claims)、repair 双读/逐事件 meta 写）**未验证未修**——CLI 规模下非瓶颈，登记收尾轮。

## 证据

- 验证判定：16 个独立 verifier（1-vote，偏召回），逐条引用行号；#12 含沙盒实证复现。
- 修复回归：`packages/dispatch/test/review-fixes.test.ts`（5 组）+ `packages/core/test/review-fixes-core.test.ts`（7 组）；全套 192/192、build 0、真机四命令冒烟（policy 可见/NaN 拒/audit 0 findings/repair no-op）。

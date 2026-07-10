# FEAT-004 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| BR-001 九守卫按序短路（P2 §BR-001） | claimNext：#1 run 态→#2 注册→sweep→#3 agent 上限→#4 候选/定向→#5 依赖→#6 role→#7 路径→#8 批准→#9 并行上限 | sweep 置于 #2/#3 之间（死租约不得楔死队列，D9 惰性派生语义）；#9 在候选过滤后（无候选时 no_claimable_task 优先，语义同表） |
| 10 §2.2/§2.3 响应形状 | data{task_id,claim_id,path_claim_ids,agent_id,lease_until,worktree}; 失败带 candidate_task_id/blocked_by/excluded | 字段挂 envelope.data 内（17 §2 统一信封，10 为 pre-envelope 草案形状） |
| 10 §3 claims 文件 | team.task_claims.v1 / team.path_claims.v1 + attempt 字段 | attempt 为实现补充字段（unknown-field round-trip 兼容，21 §4.2） |
| 10 §7 排序 | priority desc→depth asc（depends_on 最长链）→weight desc→task_id asc | created_at 与 task_id 同序合并（书面于 mvp-scope） |
| 15 §3.3/§5.3 release/reclaim | previous_attempts 追加、path claim 同步终结、ready 回归 | previous_attempts 快照未含 git status（worktree 尚不存在，FEAT-006 接入后补充） |
| 18 事件 #12/16/17/22/24/26/41 | 全部写入，字段对齐（released_claim_ids、reclaim_reason、triggered_by、reused、approval_id） | heartbeat 未采样（每次写；18 §采样允许） |
| 17 §2.2 exit | 新码全量入 EXIT_BY_CODE；claim 过滤类失败走兜底 1 | 与 17 §2.2 类表一致 |
| D9 3×TTL | lease_until + (multiple−1)×TTL；blocked 豁免（AUD-003） | 无 |
| AUD-001/002/004 inline | 守卫 #4（active claim 唯一）/#7/#8 | 无 |

## 测试 / 质量

- 85/85（新增 25）；覆盖 93.23%/80.21%；RED 23 先行在案；真机冒烟 12 事件全链。
- claim-engine.ts ≈ 700 行单模块（<500 阈值超出）——**豁免申请**：六个 primitive 共享 run 事务底座（openRun/withRunLock/loadClaims/applyReclaim），拆文件将复制事务模板；函数级最大 claimNext ≈ 180 行，线性守卫清单风格，同 doctorProject/importRun 既有豁免先例。
- TODO 0；依赖方向合规（dispatch→core+storage；cli→dispatch）。

## 安全

- agents/*.json 仅 label/role/tool——无凭据、无机器指纹（24 §2 红线）。
- envelope 消息只含 id/路径名，不回显文件内容（24 §5）。
- SCA BLOCKED（npm audit 端点，跨 FEAT 待办）。

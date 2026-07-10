# Changelog

## Unreleased

- FEAT-005 Context Plane：新包 `@sigmarun/context`——`msg post/list`（12 §6 消息池，INV-011 不进 events，`--open` 派生开放问题）、`context hydrate`（must_read 组包：brief→run-memory→L4 项目记忆（D19）→上游 handoff/evidence；context_hydrated 事件为 AUD-028 留锚）、`graph validate`（AUD-021/022 防篡改复检）、`memory update`（secret 拒收、无出处警告）。测试 103/103，覆盖 92.6%/79.5%。（Refs: FEAT-005）

- FEAT-004 claim-next + 锁 + 回收：新包 `@sigmarun/dispatch`——`agent register`（D17 label 幂等）、`claim-next`（BR-001 九守卫 + 10 §7 排序 + 定向/--dry-run + worktree 建议）、`heartbeat`/`release`/`reclaim`（BR-004 三阶回收，previous_attempts 永不清零）、`approve-paths`（AUD-004）、3×TTL 惰性 sweep（blocked 豁免）。错误码 +12（含回填 17 §3 的 claim_not_found/not_claim_owner）。测试 85/85，覆盖 93.2%/80.2%。（Refs: FEAT-004）

- FEAT-003 publish：`sigmarun task publish`（draft→ready 双写、planned→active 激活、幂等跳过、D18 跨 run 重叠 warn/block + `--force`、`cross_run_overlap_detected` 事件）。测试 60/60，覆盖 93.5%/80.5%。（Refs: FEAT-003）

- FEAT-002 plan 导入：`sigmarun run import`（payload 校验必拒表 + 警告、AUD-021 环检测 inline、D17 指纹防重 `duplicate_payload`、project.lock 短事务、events 提交点写序）；storage 新增 mkdir 锁与 secret 模式集。测试 52/52，覆盖 93.8%/80.8%。（Refs: FEAT-002）

- FEAT-001 `.team` 基座：`sigmarun init`（幂等初始化 + D4 gitignore）与 `sigmarun doctor`（九项自检，fail 自带修复指引）；storage 基元（team-root 解析、原子写 + rev 乐观锁、未知字段 round-trip）；统一 envelope（17 §2，英文）。测试 25/25，覆盖 91%/73%。（Refs: FEAT-001）

# 17. CLI / MCP Contract and Error Model

> 日期：2026-07-09
> 状态：v0.1 设计草案
> 依据：[13](13-design-audit-and-next-breakdown.md) M16–M20、裁决 §5.5、决策 D3（TS/Node）、D14（被动 CLI + watch 进 MVP）、附录 B F3（rev 乐观锁）；[14](14-evidence-review-verification-contract.md) / [15](15-run-task-state-machine-and-lifecycle.md) / [16](16-git-worktree-and-team-root.md) 引入的命令与错误
> 目标：全命令统一合同——命令总表、返回 envelope、reason code、exit code、锁与原子写实现、ID 分配、`team watch` / `init` / `doctor` 规格、MCP 映射、测试策略。adapter（19 号）只允许依赖本合同解析输出。

---

## 1. 命令总表

> **记号约定（D12 终裁）**：正式 npm 包名与 bin 均为 **`sigmarun`**；本文档集沿用 `team <cmd>` 简记，一律等价于 `sigmarun <cmd>`。协议目录名 `.team/` 不随 CLI 名变化。

图例：写 = 需要锁的状态变更；读 = 无锁只读；MVP 列空白 = P1。

| 命令 | 读/写 | 锁 | MVP | 归属能力 |
|---|---|---|---|---|
| `team init` | 写 | project | ✓ | Record |
| `team doctor` | 读 | — | ✓ | 运维 |
| `team run import <payload>` | 写 | project + run | ✓ | Record |
| `team run show <RUN>` | 读 | — | ✓ | Record |
| `team run list` | 读 | — | ✓ | Record |
| `team run pause / resume <RUN>` | 写 | run | ✓ | Dispatch |
| `team run cancel <RUN>` | 写 | run | ✓ | Dispatch |
| `team run archive <RUN>` | 写 | run | ✓ | Record |
| `team task list <RUN> [--status --owner --type]` | 读 | — | ✓ | Record |
| `team task show <RUN> <TASK>` | 读 | — | ✓ | Record |
| `team evidence show <RUN> <TASK>` | 读 | — | ✓ | Record（[03](03-team-task-list-and-task-schema.md) §10 既有，正式收编；`/team-evidence` 的底层） |
| `team task publish <RUN> [--tasks --all]` | 写 | run | ✓ | Record |
| `team task cancel <RUN> <TASK>` | 写 | run | ✓ | Record |
| `team agent register <RUN> [--label <窗口名>]` | 写 | run | ✓ | Dispatch（**label 幂等**：同 run 同名 active 注册返回同一 AGENT-ID，D17） |
| `team claim-next <RUN> [--role --capability --task --dry-run]` | 写 | run | ✓ | Dispatch |
| `team heartbeat <RUN> <TASK>` | 写 | run | ✓ | Dispatch |
| `team release <RUN> <TASK>` | 写 | run | ✓ | Dispatch |
| `team reclaim <RUN> <TASK>` | 写 | run | ✓ | Dispatch |
| `team block / unblock <RUN> <TASK>` | 写 | run | ✓ | Dispatch |
| `team worktree register / adopt / list <RUN>` | 写/读 | run | ✓ | Record |
| `team submit <RUN> <TASK> --evidence <file>` | 写 | run | ✓ | Record/Audit |
| `team review claim / approve / request-changes / block <RUN> <TASK>` | 写 | run | ✓ | Audit |
| `team verify <RUN> [--task <TASK>] --record <file>` | 写 | run | ✓ | Audit |
| `team approve-paths <RUN> <TASK> --paths` | 写 | run | ✓ | Dispatch |
| `team integrate start <RUN>` / `team report <RUN>` | 写 | run | ✓ | Record |
| `team message post / list`、`team question list` | 写/读 | run（post） | ✓ | Context |
| `team graph show / validate <RUN>` | 读 | — | ✓ | Context |
| `team context hydrate <RUN> <TASK>` | 写（事件） | run | ✓ | Context |
| `team memory update / show <RUN> [--task]` | 写/读 | run | ✓ | Context |
| `team memory promote --run <RUN> --from <ref> --entry ...` | 写 | project + 目标文件 | | Context（L4 晋升，需用户确认；[25](25-project-memory-and-knowledge-promotion.md) §4，P1/Slice 10） |
| `team progress <RUN>` | 写（派生文件） | run | ✓ | Progress |
| `team audit run / task / claims / paths / evidence / progress` | 读 | — | ✓ | Audit |
| `team repair <RUN>` | 写 | run + 备份 | ✓ | 运维（§5.3，M30） |
| `team export <RUN> [--to --full --force]` | 读（写 repo 目录） | — | ✓ | Record |
| `team watch <RUN> [--interval]` | 读 + 周期触发 sweep | 触发时 run | ✓（D14） | Progress |
| `team task add`（import 后增补任务） | 写 | run | | Record |
| `team migrate` | 写 | project + run | | 运维（[21](21-schema-versioning-and-migration.md)） |
| `team backup [--to <dir>]`（支持 repo 外目录，M37） | 读（写备份目录） | — | | 运维（[22](22-packaging-installation-and-evolution.md)） |
| `team deinit`（零删除：只给清理清单与确认，M43） | 读 | — | | 运维（[22](22-packaging-installation-and-evolution.md)） |
| `team adapter install`（形态 B 装模板） | 写 repo 文件 | — | | 分发（[22](22-packaging-installation-and-evolution.md)） |

约定：所有 task 级命令**必须同时给 RUN 与 TASK**（E6 裁决，TASK-ID 是 run-scoped）。

---

## 2. 全局返回 Envelope

### 2.1 结构

`--json` 下 stdout 输出**单个 JSON 对象**（人读格式为默认；**adapter 必须用 `--json`**）：

```json
{
  "ok": false,
  "code": "path_conflict",
  "message": "TASK-0003 paths overlap with active claim held by TASK-0002.",
  "data": {
    "candidate_task_id": "TASK-0003",
    "blocked_by": [
      { "task_id": "TASK-0002", "agent_id": "AGENT-claude-001", "paths": ["src/auth/**"] }
    ]
  },
  "warnings": [],
  "next_actions": [
    "wait for TASK-0002 to submit",
    "team status RUN-0001",
    "ask user to run: team approve-paths ..."
  ],
  "meta": {
    "gateway_version": "0.1.0",
    "envelope_version": "team.envelope.v1",
    "run_id": "RUN-0001",
    "elapsed_ms": 42
  }
}
```

规则：

1. `ok=true` 时 `code` 固定为 `"OK"`；`ok=false` 时 `code` 必为 §3 枚举之一。
2. `data` 的结构随命令而定，但每个命令的 data schema 固定并有版本（随 envelope_version）。
3. `next_actions` 是**可直接执行或可直接转述给用户**的字符串——它是 adapter 固定流程的分支依据（[08](08-core-gateway-capabilities.md) §4.6 的全局化）。
4. `warnings[]` 元素结构 `{code, message, refs?}`，不影响 `ok`。
5. 诊断信息走 stderr，stdout 永远只有 envelope（管道安全）。
6. 错误 message **不回显文件内容**（防 secret 泄漏进日志，[24](24-security-permissions-and-data-hygiene.md)）。

### 2.2 Exit code

| exit | 含义 | 对应 code 类 |
|---|---|---|
| 0 | 成功（含 dry-run） | OK |
| 2 | 用法错误（参数缺失/格式错） | usage_error |
| 3 | 锁超时 | lock_timeout |
| 4 | 校验失败 | schema_invalid / evidence_invalid / payload_* |
| 5 | 目标不存在 | *_not_found |
| 6 | 冲突 | task_already_claimed / path_conflict / rev_conflict / requires_approval / no_claimable_task / deps_blocked / capability_mismatch / parallel_limit_reached / agent_claim_limit（BR-001 守卫族统一 6，2026-07-11 功能测试轮回填） |
| 7 | 状态机拒绝 | invalid_transition / run_paused / run_not_active |
| 8 | 存储/环境错误 | io_error / not_a_git_repo / team_root_not_found / unsupported_schema_version |
| 1 | 其他失败 | 兜底 |

---

## 3. Reason Code 枚举（全命令统一）

| code | 语义 | 主要来源命令 | next_actions 必含 |
|---|---|---|---|
| `run_not_found` / `task_not_found` / `agent_not_registered` | 目标缺失 | 全部 | 正确的查询命令 |
| `run_not_active` / `run_paused` | run 状态不允许 | claim-next、publish | resume / status 命令 |
| `no_claimable_task` | 队列空 | claim-next | status；等待建议 |
| `deps_blocked` / `capability_mismatch` / `parallel_limit_reached` | 领取过滤失败 | claim-next | 具体阻塞项 |
| `agent_claim_limit` | 该 agent 已持有 active claim（`max_active_claims_per_agent`，默认 1；M36/D17） | claim-next | 先 submit / release 当前任务 |
| `cross_run_conflict` | 与其他 active run 的 paths 交集且 `cross_run_path_policy=block`（D18） | task publish、claim-next | 改 paths / `--force` / 等对方 run 收尾 |
| `task_already_claimed` | 任务已被占 | claim-next --task | 可领取任务列表提示 |
| `path_conflict` | 路径占用冲突 | claim-next | blocked_by 详情（§2.1 示例） |
| `requires_approval` | 命中需批准路径 | claim-next、submit | `team approve-paths` 命令模板 |
| `claim_not_found` | 目标 task 无 active claim（exit 5；FEAT-004 实现期定名回填） | heartbeat、release、reclaim | 当前 claim 状态查询 |
| `not_claim_owner` | claim 属他人，拒绝续租/释放（exit 6；FEAT-004 实现期定名回填） | heartbeat、release | 持有者身份提示；非 owner 走 reclaim |
| `lock_timeout` | 未获得锁 | 所有写命令 | 重试建议 + `team doctor` |
| `rev_conflict` | 乐观锁版本不符（疑似绕过 CLI 直改文件） | 所有写命令 | `team audit run` |
| `invalid_transition` | 状态机拒绝（含执行者身份不符） | 状态类命令 | 当前状态 + 合法转换列表 |
| `evidence_invalid` | evidence 校验失败 | submit | 逐条缺失项（[14](14-evidence-review-verification-contract.md) §2.3） |
| `memory_entry_invalid` | L4 晋升条目非法（无 refs / refs 失效 / 命中 secret / supersedes 悬空） | memory promote | [25](25-project-memory-and-knowledge-promotion.md) §4/§6 |
| `duplicate_payload` | 计划指纹与既有 run 相同（D17 防重；exit 6 冲突类；FEAT-002 实现期 backflow 补入） | run import | 查看既有 run / `--force` 显式越过 |
| `self_approval_forbidden` | reviewer 是历任 owner | review claim/approve | 换 reviewer 提示 |
| `schema_invalid` / `unsupported_schema_version` | 输入或存量文件版本问题；后者 `data.kind` ∈ `gateway_too_old` / `migration_required` / `unknown_major`（[21](21-schema-versioning-and-migration.md) §4.1） | import、全部读 | 升级/迁移指引（[21](21-schema-versioning-and-migration.md)） |
| `not_a_git_repo` / `bare_repo_unsupported` / `team_root_not_found` | 环境问题 | 全部 | `team doctor` |
| `worktree_missing` / `worktree_dirty` | worktree 异常 | register/adopt/remove 建议 | [16](16-git-worktree-and-team-root.md) §8 恢复路径 |
| `export_target_invalid` / `export_redaction_hit` | 导出被拒 | export | 命中清单 / --to 修正 |
| `backup_target_invalid` | 备份目标非法（在 `.team/` 内或不可写） | backup | --to 修正（[22](22-packaging-installation-and-evolution.md)） |
| `path_escape_detected` | 路径经 realpath 校验越出 repo/worktree 根（symlink 逃逸，[24](24-security-permissions-and-data-hygiene.md) §6；该行补执行 24 §9 修订指令） | submit、export、worktree register | 修正路径；`team audit paths` |
| `usage_error` / `io_error` | 兜底 | 全部 | — |

新增 reason code 必须同时登记本表 + exit code 映射 + adapter 分支建议，缺一即视为合同破坏（audit 规则）。

---

## 4. 锁实现（D3 选型，关闭 [10](10-claim-next-lock-and-conflict-rules.md) 待决 1/2）

| 项 | 决定 |
|---|---|
| 机制 | **lock 目录**：`mkdir` 原子性（POSIX/Windows 通用），目录内写 `meta.json`（pid、agent_id、command、acquired_at、gateway_version） |
| 两把锁 | `.team/locks/project.lock/`（run 创建与项目级 ID 分配，M19）；`.team/runs/<RUN>/locks/run.lock/`（run 内一切写事务） |
| 获取 | 指数退避重试（50ms 起，×2，上限 1s），默认总超时 5s → `lock_timeout` |
| stale lock | `meta.json.acquired_at` 超过 `lock_stale_ms`（默认 30s，与 lease 分开配置——关闭 10 待决 3）→ 允许抢占：**先原子接管**（旧锁目录 rename 为 `run.lock.taken-<ts>` 留证 + mkdir 新锁），接管成功后的锁事务**第一条事件**写 `lock_takeover`（含旧 meta 与证据路径）——事件追加本身需要持锁，顺序不可颠倒（2026-07-10 review 修正） |
| 持锁纪律 | 锁内只做读文件-算-写文件，**禁止**在锁内执行 git/网络/项目命令 |
| 崩溃恢复 | 进程死亡留下的 lock 目录由 stale 机制回收；半写文件由原子写（§5）杜绝 |

`message post` 等 jsonl 追加同样入 run.lock（M20 关闭）：锁内 append + 分配 MSG-ID，避免跨平台 O_APPEND 语义差异。

---

## 5. 原子写与 `rev` 乐观锁（附录 B F3 落地）

### 5.1 原子写

```text
写 JSON:  write <file>.tmp-<pid> -> fsync(file) -> rename 覆盖
写 jsonl: 锁内以 append 模式写整行 + '\n'，行内含 seq
MVP 不做目录 fsync（记录为已知取舍，崩电极端场景可能丢最后一次 rename——audit 可发现不一致并重建派生文件）
```

### 5.2 `rev` 字段

所有**可变 JSON 状态文件**（task-list、task.json、claims 三件套、path-approvals、worktrees.json、agents/*.json、evidence/*/evidence.json、counters）统一携带：

```json
{ "rev": 12, "updated_at": "2026-07-09T19:30:00+08:00", "...": "..." }
```

规则：

1. 写事务在锁内执行 `read rev -> mutate -> write rev+1`。
2. 锁保证正常路径不会冲突；`rev` 的作用是**检出异常路径**——绕过 CLI 的直改（rev 未按规则递增/updated_at 倒退）在下一次写事务或 `team audit` 中报 `rev_conflict`/`direct_state_edit_suspected`。
3. append-only 文件（events、messages）不用 rev，用**行内 seq**：`events.jsonl` 每行含 `seq`（run 内单调，计数器存 `events.meta.json`，锁内递增）；断号即 audit 证据。
4. 写事务类事件的 payload 携带 `rev_after`（本次事务写入的各状态文件新 rev），作为 audit 的 rev 对账输入（[18](18-audit-rule-catalog-and-trust-model.md) §3）。

### 5.3 跨文件事务：写入顺序、提交点与修复（M30 裁决落地）

单文件原子（§5.1）不等于事务原子——一次写事务触碰多个文件，崩溃可能停在中间。约定：

1. **Canonical 写入顺序**：状态文件按"详情 → 索引 → claims → 派生物"顺序写，**`events.jsonl` 追加永远最后——它是提交点**。事件在，事务成立；事件不在，已写状态一律视为未提交残留。
2. **崩溃语义**：崩溃于事件前 → 残留与账本不符（AUD 一致性矩阵 + `rev_after` 对账检出），按未提交处理；崩溃于事件后 → 事务成立，缺失派生物重算即可。
3. **`team repair --run <RUN>`**：机械修复原语——对照 events 账本（含 `rev_after`）逐文件比对：未提交残留**回滚**，已提交但缺派生物**前滚重算**；幂等；执行前自动备份（复用 [21](21-schema-versioning-and-migration.md) §5 备份机件）；修复动作写 `state_repaired` 事件；修不了的列 findings 交人工。audit 从此"能测也能修"。

---

## 6. ID 分配

| ID | 计数器位置 | 保护锁 |
|---|---|---|
| `RUN-ID` | `.team/counters.json` | project.lock |
| `TASK-ID` / `CLAIM-*` / `MSG-*` / `REVIEW-*` / `VERIFY-*` / `EDGE-*` / `WT-*` | `runs/<RUN>/counters.json` | run.lock |

格式正则（校验用）：`RUN-\d{4}`、`TASK-\d{4}`、`CLAIM-(task|path|review)-\d{4}`、`MSG-\d{4}`、`REVIEW-TASK-\d{4}-\d{2}`、`VERIFY-\d{4}`、`AGENT-[a-z0-9-]+-\d{3}`。ID 只增不复用；run 删除不回收号段。

---

## 7. `team watch` 规格（D14 落地）

```text
team watch RUN-0001 [--interval 30] [--once]
```

| 规则 | 内容 |
|---|---|
| 循环体 | 每 interval 秒：① 取 run.lock 执行一次 sweep（过期 claim 处理、auto-reclaim 判定，与 claim-next 的 sweep 同一段代码）② 无锁重算 progress ③ 打印状态增量（新事件、新风险、progress 变化） |
| 只读性 | 除 sweep 引发的回收类状态变更（其本身是 D9 规定的合法权威操作）外，不做任何写；**不派活、不 claim、不 submit** |
| 单实例 | `runs/<RUN>/locks/watch.lock`（advisory）：第二个 watch 启动时警告并退出，`--force` 可越过 |
| 退出 | run 进入终态（reported/archived/cancelled）时自动退出；`--once` 执行单轮（供外部 cron 调用） |
| 输出 | 人读为主；`--json` 时输出 NDJSON 事件流（行 = `team.event.v1` 事件行 + 周期快照行；[23](23-dashboard-information-architecture.md) §6 已裁决 dashboard MVP 用文件轮询、不依赖此流，正式行合同随 read-model P2 定稿） |

---

## 8. `team init` / `team doctor`

| 命令 | 内容 |
|---|---|
| `init` | 创建 `.team/`（project.json、counters.json、templates/、locks/）；向 `.gitignore` 追加 `.team/`（[16](16-git-worktree-and-team-root.md) §1.1）；已初始化则幂等返回现状 |
| `doctor` | 检查并逐项报告：git repo 与 common-dir 解析、team root 一致性（主 checkout vs worktree）、Node 版本、锁可用性（建锁-删锁自测）、schema 版本矩阵（[21](21-schema-versioning-and-migration.md)）、遗留 tracked `.team/`、悬挂 lock 目录、abandoned worktree 数 |

---

## 9. MCP 映射（形态 C 预留，D1）

| 原则 | 内容 |
|---|---|
| 同核 | MCP server 与 CLI 链接同一个 core 库（20 号 C4 的 container 边界），tool 一一映射 primitive：`team_claim_next`、`team_submit_evidence`…（命名沿 [07](07-skill-plugin-execution-form.md) §2C） |
| 同合同 | tool result 的 structured content 就是 §2 envelope；reason code、next_actions 完全一致——adapter 从 CLI 迁到 MCP 不改分支逻辑 |
| 生命周期 | stdio MCP server 跟随 agent 会话（与 Claude Code 行为一致）；server 常驻期间可选内建 watch 循环（D14 的形态 C 路径） |
| 并发 | server 内部仍走文件锁——**多个 server 实例（多会话）并存是常态**，不得假设单实例独占 |

---

## 10. Gateway 自身测试策略（13 号 P0 承诺 + 附录 B 验收用例宿主）

| 类别 | 用例 |
|---|---|
| 并发 | 16 个并发 claim-next（同 run）：零双认领、claims 文件 rev 严格递增、events seq 无断号 |
| 崩溃注入 | 写事务中 kill -9（tmp 写后 / rename 前后）：重启后无半写文件，audit 可过或可检出并重建派生文件 |
| 锁 | 持锁进程被 kill → 30s 后其他进程 takeover 且留 `lock_takeover` 事件 |
| 失败模式回归 | 附录 B F1–F5 五个场景各一条端到端用例（引用 [13](13-design-audit-and-next-breakdown.md) 附录 B 的"验收用例"列） |
| 合同回归 | 每个 reason code 至少一条触发用例，断言 envelope 结构 + exit code 映射 |
| 跨平台 | 锁/原子写/路径规范化在 macOS、Linux、Windows CI 三平台跑 |

---

## 11. Schema 版本握手（最低规则，全文归 [21](21-schema-versioning-and-migration.md)）

1. 读任何 `.team` 文件：`schema_version` major 不认识 → `unsupported_schema_version`（exit 8），提示 `team migrate` 或升级 gateway。
2. minor 级新增字段：读时**保留未知字段**原样写回（forward-compat）。
3. `project.json.min_gateway_version`：低于此版本的 gateway 拒绝写操作（防旧工具破坏新状态）。

---

## 12. MVP 验收场景

| 场景 | 预期 |
|---|---|
| 任意命令 `--json` 输出 | 单个合法 envelope，stderr 无 JSON 污染 |
| 未注册 agent 直接 claim | `agent_not_registered`，exit 5，next_actions 含 register 命令 |
| 手动改 task-claims.json 后执行写命令 | `rev_conflict` 或 audit `direct_state_edit_suspected` |
| 持锁进程被 kill 后 35s 再操作 | takeover 成功且事件可查 |
| watch 运行中 agent 断线 3×TTL | 下一轮 sweep 自动回收，watch 打印回收通知 |
| Windows 上并发 claim | 行为与 macOS 一致（CI 保证） |
| doctor 在被污染仓库（tracked .team）运行 | 明确报告 + 修复指引 |

---

## 13. 对现有文档的修订指令

| 文档 | 修订 |
|---|---|
| [04](04-command-workflows.md) | primitive 清单以 §1 总表为准收敛 |
| [07](07-skill-plugin-execution-form.md) | §2C MCP 工具面对齐 §9；风险表"skill 被忽略"行补 envelope/next_actions 机制 |
| [08](08-core-gateway-capabilities.md) | §4.6 结构化失败升级为全局 §2 envelope；§7 MVP 命令面替换为 §1 |
| [10](10-claim-next-lock-and-conflict-rules.md) | §5 锁规则表替换为 §4；待决 1/2/3 关闭 |
| [15](15-run-task-state-machine-and-lifecycle.md) | 新 primitives 的 envelope/reason code 以本文为准 |

---

## 14. 遗留到其他文档的接口

- 权威/派生字段矩阵已隐含于 rev 覆盖范围；graph node 去 status 的修订随 12 号修订 pass 执行（13 §5.5）
- component 接口签名（claim-engine、lock-manager、storage、audit engine）→ [20](20-c4-l2-l3-component-contracts.md)
- 版本迁移全策 → [21](21-schema-versioning-and-migration.md)
- envelope 人读文案与错误话术 → 19 号 adapter
- 错误输出脱敏细则 → [24](24-security-permissions-and-data-hygiene.md)

# 14. Evidence / Review / Verification Contract

> 日期：2026-07-09
> 状态：v0.1 设计草案
> 依据：[13](13-design-audit-and-next-breakdown.md) M6–M10、裁决 §5.4、决策 D6 / D8 / D11、附录 B F1（evidence 门禁是治"忘标完成"的主防线）；[15](15-run-task-state-machine-and-lifecycle.md) 状态机 v2
> 目标：把"完成的证明"从自由文本变成机器可校验的合同。gateway 只做**结构完整性与引用存在性**的机械校验，不做质量语义判断（灰区规则，13 §5.7）。

---

## 1. 三类记录总览与存储修订

[02](02-domain-model-and-team-storage.md) 的单文件布局（`evidence/TASK-0001.md`、`verification.md`）无法承载结构化校验与多轮记录，修订为：

```text
.team/runs/RUN-0001/
  evidence/
    TASK-0003/
      evidence.json          # 结构化事实（权威）
      evidence.md            # 人读叙述（从 json 生成骨架 + agent 补充）
      outputs/
        check-01.log         # required_checks 原始输出（截断+脱敏后）
        cmd-07.log
      history/
        rev-1.evidence.json  # 返工前的历史版本（机械归档）
  reviews/
    TASK-0003/
      REVIEW-TASK-0003-01.json
      REVIEW-TASK-0003-01.md
      REVIEW-TASK-0003-02.json   # 多轮 review 各自成记录，永不覆盖
  verification/
    VERIFY-0001.json         # target 可为 task 或 run
    VERIFY-0001.md
  verification.md            # 降级为派生索引（可重建，同 progress.json）
```

| 记录 | 粒度 | 多轮 | 权威载体 | 解决的审计缺口 |
|---|---|---|---|---|
| EvidenceBundle | per task | 按 revision 归档 | `evidence.json` | M6（自由 markdown 无法机械检查） |
| ReviewRecord | per task per round | `-01/-02/...` 递增 | `REVIEW-*.json` | M8（多轮覆盖、review claim 缺模型） |
| VerificationRecord | per task 或 per run | 独立 VERIFY-ID | `VERIFY-*.json` | M7（run 级单文件 vs per-task 状态） |

---

## 2. Evidence Contract

### 2.1 `evidence.json` schema（`team.evidence.v1`）

```json
{
  "schema_version": "team.evidence.v1",
  "rev": 1,
  "run_id": "RUN-0001",
  "task_id": "TASK-0003",
  "claim_id": "CLAIM-task-0007",
  "agent_id": "AGENT-codex-001",
  "submitted_at": "2026-07-09T18:20:00+08:00",
  "revision": 1,
  "summary": "Added auth API tests covering login success, invalid credentials, expired session.",
  "changed_files": [
    { "path": "tests/api/auth/login.test.ts", "change_type": "added", "in_scope": true },
    { "path": "src/api/auth/session.ts", "change_type": "modified", "in_scope": true }
  ],
  "commands": [
    {
      "cmd_id": "cmd-01",
      "cmd": "npm test -- auth-api",
      "cwd": "worktree",
      "exit_code": 0,
      "duration_ms": 42180,
      "output_file": "outputs/check-01.log",
      "output_truncated": false
    }
  ],
  "required_checks_results": [
    { "check": "npm test -- auth-api", "cmd_ref": "cmd-01", "status": "pass" }
  ],
  "acceptance": [
    { "item": "API tests cover successful login.", "status": "met", "evidence_ref": "cmd-01" },
    { "item": "API tests cover invalid credentials.", "status": "met", "evidence_ref": "cmd-01" },
    { "item": "Tests fail before implementation and pass after.", "status": "partial", "note": "red-run output lost; see risks" }
  ],
  "risks": ["Red-run output was not captured; only final green run recorded."],
  "deviations": [],
  "follow_ups": ["Consider rate-limit test in a follow-up task."],
  "context_ack": ["context/tasks/TASK-0001.md", "evidence/TASK-0001/evidence.md"],
  "handoff": "# TASK-0003 handoff\n\n- Added auth API tests; session.ts hardened. Source: cmd-01.\n"
}
```

> **草案（输入）vs 落盘（权威记录）——照抄本例前必读。** 上面是你传给 `sigmarun submit --evidence=<file>` 的**草案**，字段名以 gateway 实现为准（`packages/core/src/submit.ts`）：
> - 命令原始输出用 **`commands[].output_file`**（你捕获到磁盘的原始输出路径，从调用 cwd 解析，绝对路径亦可）——**不是** `output_ref`。
> - handoff 用顶层 **`handoff`**（inline 正文字符串）或 **`handoff_file`**（指向文件的路径）——**不是** `handoff_ref`。
> - `output_ref` / `handoff_ref` / `in_scope` / `output_truncated` / `revision` / `submitted_at` / `claim_id` 是 gateway **落盘时**生成的字段：`output_file`→`output_ref`（截断+脱敏后的相对路径）、`handoff`→`handoff_ref`（`context/tasks/<TASK>.md`）、`in_scope` 按 path claim 重算。草案里写不写这些无所谓（gateway 忽略并覆盖），但**别用它们代替 `output_file`/`handoff`**，否则 submit 报 `evidence_invalid`。

字段规则（草案输入字段）：

| 字段 | 必填 | 机械校验 |
|---|---|---|
| `changed_files[]` | yes | 非空；`in_scope` 由 gateway 按 path claim glob 计算，不由 agent 自报 |
| `commands[]` | yes | required check 对应的 command 必须存在且 `output_file`（草案输入名）指向的文件存在；落盘后重写为 `output_ref` |
| `required_checks_results[]` | yes | 必须覆盖 `task.json.required_checks` 的每一条；status ∈ pass/fail/skipped，skipped 必须带 note |
| `acceptance[]` | yes | 必须与 `task.json.acceptance` 逐条对应（数量与文本匹配）；status ∈ met/unmet/partial |
| `context_ack[]` | yes（有上游时） | 每个 ref 必须是存在的文件/锚点；与 hydrate 时的 must_read 对比，缺失项记 warning（M22 的可执行版本） |
| `handoff` / `handoff_file` | yes | 草案输入名：`handoff` 为 inline 正文，或 `handoff_file` 指向文件；gateway 落盘为 `handoff_ref`（`context/tasks/<TASK>.md`） |
| `revision` | yes | 返工后 +1，旧版归档到 `history/` |

### 2.2 原始输出策略（D8 落地）

| 规则 | 内容 |
|---|---|
| required_checks | **必须**保存原始输出到 `outputs/`，`exit_code` 必填 |
| 截断 | 默认保留首 50 行 + 末 200 行，单文件上限 256 KB，超限标 `output_truncated: true` |
| 脱敏 | 写盘前经过 redaction 管道（[24](24-security-permissions-and-data-hygiene.md)），命中 secret 模式替换为 `[REDACTED:kind]` |
| 其余命令 | 输出可选；`exit_code` 建议保留 |
| 边界 | 输出由 **agent 执行命令产生**，gateway 只负责截断、脱敏、落盘（D11） |

### 2.3 submit 事务（gateway 侧）

```text
1. acquire run.lock
2. 校验 task 状态 == working 且调用者 == owner
3. schema 校验 evidence.json（上表规则，全部机械）
4. changed_files × path claim -> 计算 in_scope；越界文件按 policy 记 warning/error
5. 落盘 outputs（截断+脱敏）、evidence.json、生成 evidence.md 骨架
6. task -> submitted；claim -> submitted（path claim 按 hold 策略保持，15 §4.2）
7. 若 require_review=false 且 task 未强制 review：task -> approved，写 skip review record，append review_skipped
8. append evidence_submitted
9. release run.lock
```

校验失败：整个事务回滚，返回 `evidence_invalid` + 逐条错误（哪个 check 缺输出、哪条 acceptance 未覆盖），task 停留在 `working`。

---

## 3. Review Contract

### 3.1 Review claim（裁决 13 §5.4：gate + 轻量 claim）

存储于 `claims/review-claims.json`（与 task/path claims 并列，[10](10-claim-next-lock-and-conflict-rules.md) 模型补全）：

```json
{
  "schema_version": "team.review_claims.v1",
  "rev": 4,
  "claims": [
    {
      "claim_id": "CLAIM-review-0002",
      "task_id": "TASK-0003",
      "reviewer_agent_id": "AGENT-claude-002",
      "round": 1,
      "status": "active",
      "acquired_at": "2026-07-09T18:30:00+08:00",
      "lease_until": "2026-07-09T18:50:00+08:00"
    }
  ]
}
```

规则：

1. `team review claim` 在 run.lock 内检查 **reviewer ≠ task owner**（INV-008，含 previous_attempts 中的历任 owner）。
2. review lease 默认 20 分钟（review 比实现短），过期同样走惰性 sweep 回收。
3. 一个 task 同时最多一个 active review claim（防两个 reviewer 重复劳动）。
4. review claim 的获取路径有二：显式 `team review claim`（人触发 `/team-review`），或 `claim-next --role reviewer` 合成的虚拟工作项（D15，[15](15-run-task-state-machine-and-lifecycle.md) §7）——两者落的是同一种 claim 记录。

### 3.2 `REVIEW-*.json` schema（`team.review.v1`）

```json
{
  "schema_version": "team.review.v1",
  "review_id": "REVIEW-TASK-0003-01",
  "run_id": "RUN-0001",
  "task_id": "TASK-0003",
  "round": 1,
  "reviewer_agent_id": "AGENT-claude-002",
  "evidence_revision": 1,
  "started_at": "2026-07-09T18:30:00+08:00",
  "completed_at": "2026-07-09T18:44:00+08:00",
  "decision": "request_changes",
  "checklist": [
    { "item": "behavior coverage", "status": "pass" },
    { "item": "error paths", "status": "fail" }
  ],
  "findings": [
    {
      "finding_id": "F-01",
      "severity": "major",
      "kind": "missing_case",
      "file": "tests/api/auth/login.test.ts",
      "message": "Locked-account path is not tested.",
      "must_fix": true,
      "message_ref": "MSG-0014"
    }
  ],
  "scope_check": { "out_of_scope_files": [], "verdict": "pass" },
  "acceptance_opinion": [
    { "item": "API tests cover invalid credentials.", "agree": true }
  ]
}
```

规则：

| 规则 | 内容 |
|---|---|
| 轮次 | `round` 与 evidence `revision` 对应；每轮新建记录，**永不覆盖**（M8） |
| decision | `approve` / `request_changes` / `block`；request_changes 必须 ≥1 条 `must_fix` finding |
| findings 镜像 | `must_fix` findings 同时以 `request_changes`/`finding` 类型写入 message pool（[12](12-context-plane-task-dag-message-pool-memory.md) §6），`message_ref` 回链——owner 返工时 hydrate 自动带上 |
| checklist 来源 | `task.json.review.focus`，无则用 run 模式默认 checklist（[15](15-run-task-state-machine-and-lifecycle.md) §10） |
| skip 记录 | `require_review=false` 时 gateway 写 `decision: "skipped_by_policy"` 的最小记录，保证"每个 approved 任务都有 review 记录"这条审计不变量无例外 |

---

## 4. Verification Contract

### 4.1 `VERIFY-*.json` schema（`team.verification.v1`）

```json
{
  "schema_version": "team.verification.v1",
  "verify_id": "VERIFY-0002",
  "run_id": "RUN-0001",
  "target": { "kind": "task", "task_id": "TASK-0003" },
  "verifier_agent_id": "AGENT-codex-002",
  "executed_at": "2026-07-09T19:00:00+08:00",
  "checks": [
    {
      "name": "focused tests",
      "cmd": "npm test -- auth-api",
      "exit_code": 0,
      "output_file": "outputs/verify-0002-01.log",
      "status": "pass"
    }
  ],
  "gates": {
    "build": "pass",
    "focused_tests": "pass",
    "regression_tests": "skipped",
    "scope_check": "pass",
    "evidence_complete": "pass"
  },
  "skip_reasons": { "regression_tests": "covered by run-level verification" },
  "verdict": "pass",
  "failures_mapped": []
}
```

> **草案 vs 落盘**（同 §2.1 约定，以 `packages/dispatch/src/verify.ts` 为准）：`sigmarun verify submit --verify=<file>` 收的是**草案**，check 原始输出用 **`checks[].output_file`**（不是 `output_ref`）；gateway 落盘时才把它重写为 `output_ref`。

规则：

1. `target.kind` ∈ `task` / `run`。task 级记录驱动 `approved -> verified` 转换；run 级记录（integration 阶段的全量验证）必须把失败映射回 TASK-ID（`failures_mapped[]`），对应任务转 `changes_requested`（15 §3.3）。
2. 五个最小 gate（`build` / `focused_tests` / `regression_tests` / `scope_check` / `evidence_complete`）沿用 [04](04-command-workflows.md) §9；每个 gate 值 ∈ `pass` / `fail` / `skipped`（**合法值是 `skipped`，不是 `skip`**）；`skipped` 必须在 `skip_reasons[gate]` 带原因（如 review-mode run 无代码变更）。`checks[].status` 同为 `pass` / `fail` / `skipped`。
3. **命令由 agent/integrator 执行，gateway 校验结构、落盘、推状态**（D11）。gateway 唯一的"验证"是：exit_code 与 status 一致性、草案输入名 `checks[].output_file` 指向的文件存在（落盘后重写为 `output_ref`）。
4. `verdict: pass` 要求所有非 skipped gate 均 pass。
5. `verification.md` 降级为从 `verification/*.json` 生成的派生索引。

---

## 5. `requires_approval` 路径批准流（M10）

```text
team approve-paths --run RUN-0001 --task TASK-0003 --paths "src/users/**" [--deny]
```

| 规则 | 内容 |
|---|---|
| 谁可批准 | user 或 integrator 角色；**agent 可请求（message type `question` + `path_approval` 标记），不能自批** |
| 存储 | `claims/path-approvals.json`（`schema_version: "team.path_approvals.v1"`，[21](21-schema-versioning-and-migration.md) 补定）：approval_id、task_id、paths、granted_by、granted_at、expires（默认随 task claim 生命周期） |
| 冲突 override 复用 | [10](10-claim-next-lock-and-conflict-rules.md) §8.3 的 path conflict `override` 走同一机制与事件，`payload.kind` ∈ `requires_approval` / `conflict_override`——事件统一命名 `path_approval_granted`（取代 13 号 M26 的 `path_override_approved` 拟名） |
| claim 阶段 | `claim-next` 遇 `requires_approval` 路径且无有效 approval → 返回 `requires_approval` reason + 申请命令提示 |
| submit 阶段 | changed_files 命中 requires_approval 且无 approval → `evidence_invalid`（error 级） |
| 事件 | `path_approval_requested` / `path_approval_granted` / `path_approval_denied` |

---

## 6. Templates 定稿要求

`templates/` 四个模板按本合同生成骨架（详细文本进实现仓库，此处定章节结构）：

| 模板 | 必备章节 |
|---|---|
| `evidence.md` | Summary / Changed Files / Checks & Outputs / Acceptance / Risks & Deviations / Follow-ups / Context Read |
| `review.md` | Decision / Checklist / Findings（含 severity 与 must_fix）/ Scope Check / Notes |
| `verification.md` | Target / Gates / Checks & Outputs / Verdict / Failures Mapped |
| `task.md` | 维持 [03](03-team-task-list-and-task-schema.md) §6 |

---

## 7. 事件补全（本文档新增）

```text
evidence_submitted          # payload: task_id, revision, checks_pass_count, out_of_scope_count
evidence_invalid            # 校验失败（可采样）
review_claimed  review_released
review_approved  changes_requested  review_blocked
verification_started  verification_passed  verification_failed
path_approval_requested  path_approval_granted  path_approval_denied
```

（`review_skipped` 已由 [15](15-run-task-state-machine-and-lifecycle.md) §11 引入。）schema 统一归 [18](18-audit-rule-catalog-and-trust-model.md)。

---

## 8. Audit 挂钩（正式编号已定于 [18](18-audit-rule-catalog-and-trust-model.md) §4，2026-07-10 回填）

| 规则ID | 检查 | 依赖本合同的哪部分 | 严重度 |
|---|---|---|---|
| AUD-011 | submitted/approved 任务缺 evidence.json | §2.1 | error |
| AUD-012 | required_check 无对应 output 文件 / pass 与 exit_code 矛盾 | §2.2 | error |
| AUD-013 | acceptance 条目与 task.json 不对齐 | §2.1 | error |
| AUD-014 | changed_files 越出 path claim（in_scope 重算） | §2.3 | warn/error（按 policy） |
| AUD-015 | reviewer == 历任 owner | §3.1 | error |
| AUD-016 | approved 任务无 review 记录（含 skip 记录） | §3.2 | error |
| AUD-017 | verified 任务无 pass verdict 的 verification 记录 | §4 | error |
| AUD-004 | requires_approval 路径无批准记录 | §5 | error |
| AUD-028 | context_ack 未覆盖 hydrate must_read | §2.1 | warn |
| AUD-018 | outputs 含疑似 secret（redaction 漏网） | §2.2 + [24](24-security-permissions-and-data-hygiene.md) | error |
| AUD-019/020 | review_skipped 政策核查 / 并发 review claim | §3.1–3.2 | warn / error |

---

## 9. MVP 验收场景

| 场景 | 预期 |
|---|---|
| submit 时缺一条 required_check 输出 | `evidence_invalid`，task 留在 working，错误指明缺哪条 |
| evidence 声称 pass 但 exit_code=1 | 机械校验拒绝（status 与 exit_code 不一致） |
| 返工后二次 submit | `revision=2`，rev-1 归档进 history/，review round 2 新建记录 |
| reviewer 尝试 review 自己接手过的任务（previous_attempts 命中） | review claim 被拒（INV-008 扩展） |
| require_review=false | submit 后自动 approved，存在 `skipped_by_policy` review 记录 + `review_skipped` 事件 |
| run 级 verification 一个 check 失败 | 失败映射回 TASK-ID，该任务转 changes_requested |
| 修改 requires_approval 路径且已获批 | claim 与 submit 均放行，审计可见 granted_by |
| 输出含 `AKIA...` 形态字符串 | 落盘文件中为 `[REDACTED:aws_key]`（联动 24 号） |

---

## 10. 对现有文档的修订指令

| 文档 | 修订 |
|---|---|
| [02](02-domain-model-and-team-storage.md) | 存储树按 §1 更新（evidence/reviews/verification 目录化，verification.md 降级派生）；对象表 ReviewRecord/VerificationRecord 的 ID 说明更新 |
| [03](03-team-task-list-and-task-schema.md) | §8 表中 review claim 指向 §3.1；`approved -> verified` 的"必须记录"改为 VERIFY 记录 |
| [04](04-command-workflows.md) | §5/§8/§9 以本合同为准重写职责清单；§11 事件表按 §7 扩充 |
| [08](08-core-gateway-capabilities.md) | §3.1 记录对象表、§5.3 检查项表与 §8 挂钩 |
| [10](10-claim-next-lock-and-conflict-rules.md) | claim 模型增加 review-claims 与 path-approvals 两个文件 |
| [12](12-context-plane-task-dag-message-pool-memory.md) | §7.3 submit 行增加 context_ack 要求；findings 镜像规则回链 |

---

## 11. 遗留到其他文档的接口

- redaction 模式表、熵启发式、export 二次扫描 → [24](24-security-permissions-and-data-hygiene.md)
- `evidence_invalid` 等 reason code 与 envelope → [17](17-cli-mcp-contract-and-error-model.md)
- §8 规则的正式编号、输入、消息模板 → [18](18-audit-rule-catalog-and-trust-model.md)
- review checklist 的模式默认值文案 → 19 号 adapter 模板

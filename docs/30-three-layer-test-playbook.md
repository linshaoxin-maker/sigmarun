# 30. 三层对照测试手册(用户层 × gateway × 代码层)

> 日期:2026-07-22(v0.2.1)
> 用法:每条用例三层对照——**用户层**(你打什么/看什么)· **gateway**(命令 + envelope + 状态流转)· **代码层**(模块/函数 + 落盘 + 事件)。轻量旅途的事件序列为**真机抓取**;其余事件名逐一核对自 emit 点。状态词表单源 `core/state-machine.ts`;概览见 [29](29-architecture-journey-and-quickstart.md)。

## 0. 观察工具箱(每步验证用)

| 想看什么 | 命令 / 文件 |
|---|---|
| 账本(唯一真相) | `sigmarun events <RUN> --json`;裸文件 `.team/runs/<RUN>/events.jsonl` |
| 任务状态 + 历史尝试 | `sigmarun task show <RUN> <TASK> --json`(`data.task.status` / `.previous_attempts`) |
| run/进度/需要你 | `sigmarun status <RUN>`(user_state / needs_user) |
| claim 实况 | `.team/runs/<RUN>/claims/task-claims.json` / `path-claims.json` |
| 完整性 | `sigmarun audit run <RUN>`(error→exit 9)· `sigmarun repair <RUN>` |

---

## 1. T1 安装与体检(无状态机,只落盘)

| 步 | 用户层 | gateway | 代码层 |
|---|---|---|---|
| 1 | `sigmarun init` → 看到 next_actions 串 doctor→adapter→/team-plan | 建 `.team/`(project.json/counters),幂等 | `core/lifecycle.initProject`;`.gitignore` 追加 `.team/` |
| 2 | `sigmarun doctor` → 10/10 绿 | 全过 exit 0;**故意 `chmod 555 .team/locks` → exit 9 + `ok:false`**(改回即恢复) | `lifecycle.doctorProject`;失败检查拉低 `ok`(P1-7) |
| 3 | `sigmarun adapter install --tool=all` | Claude→`.claude/commands/`(13)· Codex→`.agents/skills/`(12);`.codex/` **不存在** | `adapters/install.installAdapters`;AGENTS.md 托管段幂等 |

---

## 2. T2 轻量旅途(端到端;事件序列 = 真机金标准)

**每步三层 + 状态流转:**

| 步 | 用户层 | gateway(状态流转) | 代码层(事件) |
|---|---|---|---|
| 1 | `/team-plan <目标>`(或手动 import) | run `[*]→active`;task `[*]→draft→ready` | `core/run-import.importRun` → `run_created`+`task_created`+`task_published`+`run_activated`(轻量 import 一步到位) |
| 2 | (AI)register | — | `dispatch/register.registerAgent` → `agent_registered`;返回 `AGENT-<tool>-NNN`(**后续用返回 id**) |
| 3 | `/team-do`(AI claim) | task `ready→claimed`;claim `[*]→active`;path 占用生效 | `dispatch/claim-engine.claimNext`(run.lock 内原子)→ `task_claimed`+`path_claimed`;返回 `worktree.recommend`(单人轻量=`local`) |
| 4 | (干活;本地 checkout) | — | 无 gateway 参与(运行态在 AI) |
| 5 | (AI)done | task `claimed→done`;claim `active→completed`;path 释放 | `core/run-ops` done → `task_done`(payload.via=done_command) |
| 6 | `/team-status` → 100%;report | run `active→reported` | `core/integrate.reportRun`(轻量臂:全终态才放行)→ `run_reported`;生成 `report.md`;**交还 git 提示** |
| 7 | archive | run `reported→archived` | `run-ops` → `run_archived` |

**金标准事件序列(真机抓取,`events.jsonl` 应逐条吻合):**
```
1 run_created → 2 task_created → 3 task_published → 4 run_activated
→ 5 agent_registered → 6 task_claimed → 7 path_claimed
→ 8 task_done → 9 run_reported → 10 run_archived
```
断言:seq 严格递增无缝;`sigmarun audit run` 0 error。

---

## 3. T3 full 旅途(门链全开)

import **不带** `--lightweight`(run 停 `planned`,任务 `draft`)→ `task publish` 放行(run→`active`,任务→`ready`,`run_activated`)。之后:

| 步 | 用户层 | gateway(task / claim 状态) | 代码层(事件) |
|---|---|---|---|
| claim | `/team-do`(自动转 full 流) | `ready→claimed` / claim `active` | `claimNext` → `task_claimed`+`path_claimed`;recommend=`isolated`(full 必隔离) |
| worktree | (AI)`git worktree add` + `worktree register` | `claimed→working` | `dispatch/worktree.registerWorktree` → `worktree_created`+`task_started` |
| hydrate | (AI)context hydrate | — | `context/context-plane.hydrateContext` → `context_hydrated`;must_read=brief→run-memory→L4→上游 handoff(AUD-028 查 ack) |
| submit | (AI)交 evidence(`handoff` 必填) | `working→submitted`;claim `active→submitted`(**path 仍占**) | `core/submit.submitEvidence` → `evidence_submitted`(校验失败=`evidence_invalid`,人面列出清单) |
| review | **另一窗口**(INV-008)claim+approve | `submitted→reviewing→approved`;gate-claim 一租一还 | `dispatch/review.reviewClaim/reviewDecide` → `review_claimed`+`review_approved`;打回则 `changes_requested`(见 T4-2) |
| verify | 验证窗口跑 gates | `approved→verified` | `dispatch/verify.verifySubmit` → `verification_passed`(5 gate 键;skipped 须 skip_reasons) |
| integrate | `integrate start` → 照 merge_order 用 **git** 合 → `integrate record --merge-commit=<sha>` | run `active→integrating`;task `verified→integrated`;claim→`completed`;**path 释放** | `core/integrate.integrateStart/Record` → `integration_started`+`task_integrated`;**gateway 不碰 git,只排序+记 sha** |
| report | report → 开 PR | task `integrated→done`(report=accept);run→`reported` | `reportRun` → `task_done`(via report_accept)+`run_reported`;`integration.md` 指明"集成分支走你的 PR 流" |

---

## 4. T4 异常用例(每条:怎么造 → 三层期望)

### T4-1 掉线回收(sweep / 人工 force)
- **造**:claim 后不 heartbeat。自动路径要等 lease+2×TTL(~90min);**快速版**:人工 `sigmarun reclaim <RUN> <TASK> --force --agent=user`(仅 user 可即时收活租约)。
- **期望**:task `claimed/working→ready`;claim→`reclaimed`;worktree 转 `abandoned` **不删**;`task show` 的 `previous_attempts` 多一条(含 agent/reason/worktree_path)。事件 `task_reclaimed`。
- **代码层**:`claim-engine.sweepExpired`(惰性,claim-next/watch 触发;blocked 免扫)→ `applyReclaim`(一个原语通吃自动/手动/force)。
- **接管**:下一窗口 claim 到它时,skill 的 TAKEOVER FORK 暂停问人 [adopt 半成品 / restart]。

### T4-2 返工(评审打回 → 原地改)
- **造**:full 旅途 review 时 `request-changes`(review 文件须 ≥1 条 `must_fix:true`,否则 `schema_invalid`)。
- **期望**:task `reviewing→changes_requested`;**owner 的 claim `submitted→active` 复活**(新租约,path 未释放)——owner 不重领、不重建 worktree;`resume` 后 task→`working`,改完重 submit(round+1)。
- **代码层**:`review.reviewDecide`(EVENT `changes_requested`,must_fix 镜像成消息)→ `review.resumeTask`(EVENT `task_started` payload.resumed)。

### T4-3 path 冲突(串行化,不是禁止)
- **造**:两个任务 `paths.allow` 重叠(如都含 `src/x/**`),A 先 claim,B 再 claim。
- **期望**:B 得 `path_conflict` + `data.blocked_by`(点名 A/agent/paths);**A integrate(轻量:done)释放后 B 立刻领得动**——同一文件先后改完全正常,挡的只是"同时"。
- **代码层**:`claim-engine.candidateGuard` 用 `pathsOverlapConservative`(glob 静态前缀互为前缀=重叠,保守);默认 policy `block`。

### T4-4 幽灵 claim → repair(v0.2.1 新)
- **造**:模拟崩溃残留——真 claim 一次后,手改 task.json+list 回 `ready`(留着 claims 里的 active 条目)。
- **期望**:再 claim 撞 `agent_claim_limit`/`parallel_limit_reached`,且 next_actions **点名 repair**(真满载不提示——对照);`sigmarun repair` 清幽灵(→`reclaimed`,备份,事件 `state_repaired`),之后 claim-next 立刻成功。
- **代码层**:`claim-engine.ghostRepairHint`(计数的 active claim 落在非占用态任务上才提示)+ `audit/repair.ts` 账本(foldLedger)对账:**账本认的占用态 claim=活的绝不清**(红线)。

### T4-5 cancel 红线 + 去重
- **造**:`sigmarun run cancel <RUN>`(不加 `--yes`)。
- **期望**:只返回预览(`would_cancel_tasks` + 在途 claim 名单 + "Confirm: … --yes"),run **仍 active**;`--yes` 才级联 cancel(事件 `run_cancelled`/`task_cancelled`)。
- **顺带**:相同 plan.json 导两次 → `duplicate_payload`(指纹去重;换 goal 或 `--force`)。
- **代码层**:`run-ops.runCancel`(预览臂只读)· `run-import` payloadHash 去重。

---

## 5. 每步通用断言(任何用例后可跑)

1. `events.jsonl` seq 严格递增、无重复无跳号(P0-5)。
2. `sigmarun audit run <RUN>`:健康应 0 error(有 error 时 exit 9 但 `--json` envelope 仍 `ok:true`——机器面不被污染)。
3. 任一状态转移必有对应事件(INV-005);`task.json.status` 与"最后一条状态事件"一致(EVENT_STATUS fold)。
4. 同一任务任意时刻 ≤1 条 active claim(INV-003);submitted 任务必有 evidence(INV-010)。
5. 崩溃演练:任意步骤后 kill;重跑命令或 `repair` 后以上 1-4 仍成立(账本=提交点)。

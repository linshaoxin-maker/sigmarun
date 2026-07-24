# 32. Slash Command → CLI → 代码 全映射(接手者手册)

> 日期:2026-07-24(v0.2.3 / 模板 0.6.7)
> **读者:新接手的开发者。** 回答一个问题:用户在聊天窗打的每个 `/team-*`,最终落到哪行代码。架构背景见 [29](29-architecture-journey-and-quickstart.md),状态机见 [15](15-run-task-state-machine-and-lifecycle.md)。

---

## 0. 先懂三层法则(不懂这个,后面全是雾)

```
/team-plan  ──不是代码──►  一段 prompt 模板(教 AI 怎么做事的"剧本")
                                │ AI 照剧本调
                                ▼
sigmarun run import ...  ──唯一入口──►  cli.ts(parse → delegate → envelope → exit code)
                                │ 委托
                                ▼
importRun()  ──真实现──►  包函数(run.lock 内写状态,events.jsonl 为提交点)
```

1. **Slash command 是模板,不是代码。** 全部 13 个命令 = `packages/adapters/src/templates.ts` 里的**字符串常量**(`TEAM_PLAN`、`TEAM_DO`…),`adapter install` 把它们渲染成 `.claude/commands/*.md` 与 `.agents/skills/*/SKILL.md`。adapters 包**零运行时依赖**——它不执行任何东西,只生成文本。**改 AI 行为 = 改字符串 + bump `TEMPLATE_VERSION`**。
2. **CLI 是唯一入口、无业务逻辑。** `packages/cli/src/cli.ts`:argv → `flag()` 解析 → 委托包函数 → `render()` 打 envelope → `EXIT_BY_CODE` 映射退出码。加命令要同时进 `COMMAND_SURFACE`(机器对账表,漏了 `docs-reconciliation.test` 会红)。
3. **包函数是真实现。** 全部返回 `Envelope`;写操作一律 `run.lock` 内、以 `appendEvent` 为提交点(崩了 repair 按账本对回)。共享词表在 `core/state-machine.ts`。

共享注入块(改一处、13 命令×2 工具全变):`RULES_BLOCK`(11 条铁律,含 RULE 11 auto-init)· `COLLAB_BLOCK`(人机协作档位+红线)· `MIDRUN_BLOCK`(中途变更)· `DISPATCH_FLOW(tool)`(full 干活流,plan/dispatch 共用)。

---

## 1. 三件套(用户 90% 的时间只碰这三个)

| Slash | 模板常量 | 教 AI 调的 gateway 命令 | cli.ts 委托 → 实现 | 状态/事件 |
|---|---|---|---|---|
| **/team-plan** 建需求 | `TEAM_PLAN` / `CODEX_PLAN_SKILL` | `doctor`(缺 .team → 自跑 `init`,RULE 11)→ 读仓库拆分 → **PAUSE 等确认** → `run import <payload> [--lightweight]` →(full)`task publish` | `doctorProject`/`initProject`(core/lifecycle.ts)· `importRun`(core/run-import.ts,schema=core/payload.ts)· `publishTasks`(core/publish.ts,含跨 run 路径重叠检测) | run `[*]→planned/active`;task `draft→ready`;`run_created`+`task_created`+`task_published`+`run_activated` |
| **/team-do** 唯一干活入口 | `TEAM_DO` / `CODEX_DO_SKILL` | 定位 run(`run list`,多个→问人)→ 窗口身份(`agent list` RESUME CHECK)→ `claim-next [--task]`(读 `worktree.recommend` 决定本地/隔离)→ 轻量:读 brief 干活→`done`;full:切 DISPATCH_FLOW | `runList`/`agentList`(watch/progress.ts)· `claimNext`(dispatch/claim-engine.ts,**防撞车核心**:lock 内筛选+原子写 claim)· done(core/run-ops.ts) | task `ready→claimed[→working]→done`;claim `[*]→active→completed`;`task_claimed`+`path_claimed`+`task_done` |
| **/team-status** 进度+该我干嘛 | `TEAM_STATUS` / `CODEX_STATUS_SKILL` | `status <RUN>`(无参:唯一 run 直用/多个列表) | `statusRun`(watch/progress.ts:`computeProgress` 聚合 + `deriveUserState` 外部状态机 + needs_user 清单) | 只读;进度从事实重算(INV-006) |

## 2. 需求视图(只读,全在 watch/progress.ts)

| Slash | 模板常量 | gateway 命令 | 实现 |
|---|---|---|---|
| **/team-runs** 需求清单 | `TEAM_RUNS` | `run list` | `runList`(每行带 user_state+下一步) |
| **/team-tasks** 任务列表 | `TEAM_TASKS` | `task list <RUN> [--status/--owner/--type]` | `taskList` |
| **/team-task** 单任务全档案 | `TEAM_TASK`(Codex 缺此镜像,P2) | `task show <RUN> <TASK>` | `taskShow`(status/claims 历史/worktree/`previous_attempts`) |
| **/team-evidence** 证据面板 | `TEAM_EVIDENCE` | `evidence show <RUN> <TASK>` | `evidenceShow` |

## 3. Full 门链(质量流水线;轻量模式下这些被模式墙挡回 `mode_mismatch`)

| Slash | 模板常量 | 教 AI 调的 gateway 命令 | cli.ts 委托 → 实现 | 状态/事件 |
|---|---|---|---|---|
| **/team-publish** 放行草稿 | `TEAM_PUBLISH` | `task publish <RUN>` | `publishTasks`(core/publish.ts) | run `planned→active`;task `draft→ready`;`run_activated` |
| **/team-dispatch** full 干活流(进阶别名,/team-do 自动转入) | `TEAM_DISPATCH`(主体=共享 `DISPATCH_FLOW`) | `agent register`→`claim-next`→`context hydrate`(读 must_read)→`worktree register/adopt`→干活(`msg post`/`heartbeat`)→组 evidence→`submit` | `registerAgent`(dispatch/register.ts)· `claimNext` · `hydrateContext`(context/context-plane.ts)· `registerWorktree/adoptWorktree`(dispatch/worktree.ts)· `postMessage`(context)· `heartbeat`(dispatch/claim-engine)· `submitEvidence`(core/submit.ts) | task `claimed→working→submitted`;`worktree_created`+`task_started`+`context_hydrated`+`evidence_submitted` |
| **/team-submit** 手动补交证据 | `TEAM_SUBMIT` | `submit <RUN> <TASK> --agent --evidence` | `submitEvidence`(core/submit.ts:机械校验 evidence draft、落 `context/tasks/<T>.md` handoff、redaction) | task→`submitted`;claim→`submitted`(路径仍占);`evidence_submitted` |
| **/team-review** 评审 | `TEAM_REVIEW` / `CODEX_REVIEW_SKILL` | `review claim`→读证据/diff/复跑检查→`review approve\|request-changes\|block --review=<file>`;返工侧 `resume` | `reviewClaim`/`reviewDecide`(dispatch/review.ts:INV-008 `accountableAuthors` 拦自评;request_changes **原地复活** owner claim)· `resumeTask` | task `submitted→reviewing→approved/changes_requested/blocked`;`review_claimed`+`review_approved`/`changes_requested` |
| **/team-verify** 独立验证 | `TEAM_VERIFY` / `CODEX_VERIFY_SKILL` | `claim-next --role=verifier`→跑 5 gates→`verify submit --verify=<file>` | `verifySubmit`(dispatch/verify.ts:gates 枚举 pass/fail/skipped、skipped 须 skip_reasons、fail 回弹 changes_requested) | task `approved→verified`;`verification_passed/failed` |
| **/team-integrate** 集成收尾 | `TEAM_INTEGRATE` | `integrate start`(出 merge 顺序,**gateway 不碰 git**)→AI 用 git 合→`integrate record --merge-commit=<sha>\|--failed`→`report` | `integrateStart`/`integrateRecord`/`reportRun`(core/integrate.ts:record 成功放路径占用+关 claim;report=accept,integrated→done,写 report.md/integration.md) | run `active→integrating→reported`;task `verified→integrated→done`;`integration_started`+`task_integrated`+`run_reported` |

## 4. 改哪类东西去哪儿(接手速查)

| 你想改 | 去哪 | 守卫(改漂了谁会红) |
|---|---|---|
| AI 的行为/话术/暂停点 | `adapters/src/templates.ts` 字符串 + **bump `TEMPLATE_VERSION`** | `field-protocol-reconciliation.test`(skill 必点名代码要的字段)· `install.test` |
| 校验规则/状态转移 | 对应包函数(上表坐标)+ `core/state-machine.ts` 词表 | 各包单测 + `journeys.test`(旅途可执行)+ audit 规则 |
| 加/改 CLI 命令 | `cli.ts` 路由 + `COMMAND_SURFACE` + docs/17 §1 | `docs-reconciliation.test`(双向对账,漏一边就红) |
| 退出码 | `EXIT_BY_CODE`(cli.ts)+ docs/17 §2.2 | 同上 |
| 发布产物 | `scripts/build-release.mjs`(自清+重建)| `release-packaging.test` + `npm run smoke`(CI job) |
| 事件/账本 | `core/events.ts`(seq 崩溃安全)· 事件名进 `EVENT_STATUS` | 事件目录对账 + `events-append-seq.test` |

> 心法:**这个仓库的漂移是被机器守着的**——命令面、退出码、事件目录、依赖矩阵、skill 字段、发布 README、用户旅途,各有一张对账测试。改完跑 `npm test`,红了的那张就是你漏同步的地方。

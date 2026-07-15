# sigmarun 整改设计方案(Remediation Design)

- **版本**:v1.0
- **日期**:2026-07-15
- **状态**:**已批准** —— D21–D24 于 2026-07-15 由产品负责人全部按推荐项裁决(见 §6);R0–R4 依计划执行,ADR-020…024 按 R4 落档
- **基线**:HEAD 61e5b67,266/266 用例,八包 ~9.4k 行 src
- **凭据来源**:2026-07-14/15 全面审查(四路深读代理 + 真机复现)。本方案中每条修复的凭据用三种记法:
  - `file:line` — 源码位置(全部经代理逐行核实);
  - `S1…S13` — 已在临时仓库用 `dist/bin.js` 实跑复现的卡点场景(定义见 §3.0);
  - `docs/NN §x` — 语料库条款。

---

## 0. 设计目标:把"完美产品"收敛为四个可测命题

审查的总结论是:机器面(信封/锁/审计/账本)是高水位,人面(旅程/观测/指引)与宪法(spec 回写)失守。"完美产品"不能是形容词,本方案把它定义为四个**可机器验收**的命题,作为整改完成的唯一标准:

| # | 命题 | 可测形式 |
|---|---|---|
| **P-1 零断点** | 两条旅程(轻量/full)从空仓库到 run 终态,官方指引的每一步都成功 | 两个端到端 CI 场景脚本(被测物 = tarball 安装的 CLI) |
| **P-2 指引活性** | 任何失败信封的首条 `next_actions`,执行后必须"状态改变或获得新信息",禁止原地循环 | 场景包元断言:对每个 fail envelope 执行其首条建议,断言返回的 (code,data) 与原错误不同 |
| **P-3 无死锁** | 场景包中每个可达状态,存在**文档化**的命令序列到达某个终态;"注册新身份洗白"不得作为必要步骤 | 13 个场景(S1–S13)固化为回归测试,每个断言存在出口 |
| **P-4 观测一致** | status / audit / watch 对同一 run 不得互相矛盾(健康轻量 run:audit 零 error;终局 run:watch 退出) | conformance 测试:同一 fixture 同时跑三个观测面,断言结论相容 |

这四个命题直接对应用户的四个诉求:启动能走通(P-1)、卡住有出口(P-2/P-3)、看得懂现场(P-4)。

---

## 1. 需求拆解:从 41 项审查发现反推五个需求簇

审查发现不是需求;需求是发现背后的用户损失。把全部发现归因后得到五个簇,每簇给出用户故事、需求项与凭据锚点。

### R-A 旅程完整性 —— "照官方指引走,不许撞墙"

> 用户故事:我是第一次使用的 tech lead,照 README 装好、照模板发起第一个 run,我期望不查源码就走到终态。

| 需求 | 内容 | 凭据 |
|---|---|---|
| REQ-A1 | full 模式首任务零断点:网关给出的 worktree 建议必须通过网关自己的校验 | **P0 实跑复现**:`claim-next` 建议 `../.team-worktrees/RUN-0001/TASK-0001`(claim-engine.ts:767),`worktree register` 按含项目名段的 `worktree_root`(run-import.ts:202 ← lifecycle.ts:66-68,冒烟修复 L17)校验 → `path_escape_detected` exit 4;模板要求 "exactly as suggested"(templates.ts:62-65);测试只断言路径含 'TASK-0001'(dispatch/test/claim.test.ts:31-33) |
| REQ-A2 | 轻量 run 必须有干净终局 | S8 复现:全 done 后 report/integrate/archive 三拒(integrate.ts:282-289、run-ops.ts:177),watch 无限循环(TERMINAL 不含 active,watch.ts:15),唯一出口是语义错误的 `run cancel` |
| REQ-A3 | 轻量/full 模式互斥且可导航:错模式的动作被明确拒绝并指路;`/team-do` 不得误击 full run | S3 复现:轻量 run 上 submit 合法直通 approved,`done` 拒收(DONE_FROM 不含 approved,task-ops.ts:47),本人 verify 撞自批禁令;/team-do 按"最近 active run"选取(templates.ts:161-163)而 `run list` 数据无 lightweight 标记无进度(progress.ts:235) |
| REQ-A4 | 起步资料可用:安装指令有效、payload 有样例、Codex 侧走得完全程 | README `npm i -g sigmarun` 未发布 + repository OWNER 占位(package.json:31-38);quickstart 无 payload 样例;codex 适配器仅 6 skill 无 publish/integrate/submit/evidence(templates.ts:603-611) |

### R-B 协作安全网 —— "防线不许互相绞杀"

> 用户故事:我开两个 agent 窗口协作,其中一个崩了。我期望系统的回收/评审/阻塞机制**彼此兼容**地把局面收回来,而不是相互把路堵死。

| 需求 | 内容 | 凭据 |
|---|---|---|
| REQ-B1 | 接管(reclaim)不得毁掉该任务的评审可行性 | **S1 复现(最严重)**:A 认领掉线 → B 接管重做提交 → `review claim --agent=A/B` 双双 `self_approval_forbidden`(historicalOwners 按"曾持有 claim"判所有权,review.ts:47、142-147);`claim-next --role=reviewer` 谎报 "No task is waiting for review";status 报 0 needs-you |
| REQ-B2 | 提问等答复不得被判 stale 回收;续租承诺与实现一致 | S2 复现:`working→blocked` 的 owner 入口 `team block` 未实现(docs/15 §3.3 有、cli.ts 无),blocker 消息不冻结租约,3×TTL 被 sweep 收走;模板 RULE 7 承诺 "Other sigmarun calls auto-extend your lease too"(templates.ts:36)而 `msg post` 不续租(context-plane.ts:129-205 无 lease 逻辑;docs/15 §8 本意是续) |
| REQ-B3 | gate(review/verify)租约必须可回收、可观测 | S5 复现:reviewer 死后 task 悬在 reviewing;watch/sweepRun 只扫 task 租约(claim-engine.ts:379-407),status 不读 review-claims(progress.ts:108-130);且 `synthesizeReview` 先读任务快照后跑 sweep,首刷返回 no_claimable_task、二刷才对(review.ts:219-243 顺序 bug) |
| REQ-B4 | 死 agent 持有的新鲜租约,人类必须有处置权 | S4 复现:request-changes 自动复活 owner claim 并续满新 TTL(review.ts:396-406);owner 已死时 resume 报 not_claim_owner、reclaim 报 "still leased until…"(claim-engine.ts:932-937 硬性要求过期),人质期最长 3×TTL;next_actions 指向死者 |
| REQ-B5 | 验证门不可真空通过 | 五个 gate 全 skipped + verdict=pass 被机械接受(`nonSkippedAllPass` 真空成立,verify.ts:97)——S3 逃生实测正是用它绕过,门形同虚设 |
| REQ-B6 | 上游取消后,下游要有处置指引 | S6 复现:cancelled 不在任何 deps_satisfied_when 值域,下游永久 deps_blocked,status 不提示,report 静默抛下 |
| REQ-B7 | 集成期发现缺角要有回头路 | S7 复现:spec 的 `integrating→active`(integration_reopened,docs/15 §2.2)未实现;integrating 态 task add/publish/pause 全拒 |

### R-C 观测与指引 —— "任何时刻问'该谁干什么',必须有答案"

> 用户故事:我是单窗口用户,任务提交完等评审。我期望 status 告诉我下一步敲什么,而不是"0 items need you"。

| 需求 | 内容 | 凭据 |
|---|---|---|
| REQ-C1 | 流水线全部等待态进入 needs_user/next_actions | needs_user 仅三类(reclaim_confirm/blocker/approval_pending,progress.ts:106-162);submitted/approved/changes_requested/verified/integrating 全部沉默(S1/S5 的悬挂因此不可见) |
| REQ-C2 | "谁在干什么"可回答 | 无 `agent list` 命令(cli.ts 注册表);status 无 per-agent 数据(progress.ts:179-191);docs/04 §6 的 "Agents: 3 active \| 1 stale" 无对应实现 |
| REQ-C3 | 人类模式输出可读 | render() 只特判 doctor/events 两类(cli.ts:83-93);实测 `msg list --open` 不显示正文、`run show`/`task show`/`status` 均一行 |
| REQ-C4 | watch 有逐轮心跳输出 | 循环体丢弃中间信封只输出最后一个(cli.ts:256-261);轻量 run 无限静默(与 S8 复合) |
| REQ-C5 | 报错的"下一步"必须是活的 | 兜底 next_actions="Run sigmarun doctor"(envelope.ts:70,专属建议仅 6 个 code,envelope.ts:30-37);S12 复现 doctor 十项全绿的死胡同;S9 复现 claim-next↔publish 互踢(`run_not_active` 一码两义,claim-engine.ts:505-509);S11 复现 blocker 指引自闭环(给只读命令,正解 `msg post --type=answer --reply-to` 无处记载);S13 复现 prune 两条救援建议第一条必死(register 只收 claimed,worktree.ts:69;adopt 只认 abandoned 而 prune 标 pruned,worktree.ts:160) |

### R-D 宪法与漂移治理 —— "特性不入宪,就是下一轮事故"

> 用户故事:我是这个项目的产品负责人,我建语料库+决策台账就是为了防漂移。我期望"实现了什么"与"宪法说什么"机器可对账。

| 需求 | 内容 | 凭据 |
|---|---|---|
| REQ-D1 | 轻量模式入宪:INV-007 边界、审计口径、终局 | `done` = claim 持有者自标完成(task-ops.ts:257-326)直接违反 docs/15 §9 "INV-007 永不放开";audit 无 lightweight 分支,健康轻 run 每任务报 AUD-011/016/017/019 error(S10 复现,engine.ts 无分支);docs/00–25 零提及(grep 证实);无决策记录(docs/04-decisions 仅 README) |
| REQ-D2 | 事件目录闭合恢复 | 4 个 spec 事件从未发出:lock_takeover(#44)、task_rework_started(#18,被 task_started+payload.resumed 替代,review.ts:526-533)、memory_updated(#40)、run_migrated(#49);3 个目录外事件:worktree_pruned、verify_claimed、verify_released |
| REQ-D3 | spec 回写与决策补档 | docs/17 §1 四个标 MVP 的命令未实现(task list/question list/memory show/audit 子命令);docs/21 §4.1 与 migrate-on-read 改判正面冲突(CHANGELOG:15 有裁决、spec 未修);docs/11/20 与八包实况漂移(§2.2 详列);current-state 停在 2026-07-10;traceability 止于 FEAT-011;D20 后无决策记录 |
| REQ-D4 | 版本写闸门实装 | `min_gateway_version` 只在 init 写入(lifecycle.ts:65),全仓无读取校验;docs/21 §8 明言"闸门必须从第一版就实现" |
| REQ-D5 | 审计判定与枚举修正 | AUD-019 判定写反:`review.required !== false` 即 error(engine.ts:428-433),spec(docs/18 §4.C、docs/15 §9)是 task 级强制才 error、policy 跳过为 warn;integrating 类型过滤 `'verify'` vs 枚举 `'verification'`(claim-engine.ts:630 vs payload.ts:5),集成期验证型任务永不可领;claim 状态实现发明 spec 外的 `completed`(verify.ts:195-206、integrate.ts:248-259、review.ts:393、task-ops.ts:305;docs/15 §4.1 枚举无此值,根源是 §4.1 与 §4.3 对 released 时点自相矛盾) |

### R-E 架构收敛 —— "核心不变量要有唯一实现点"

> 用户故事:我是三个月后新增一个 mutator 的开发者(可能是 AI)。我期望锁、rev、events-last 这些不变量由**结构**保证,而不是靠我读对 docs/17 §5.3。

| 需求 | 内容 | 凭据 |
|---|---|---|
| REQ-E1 | 事务骨架唯一实现 | 五份近似拷贝:dispatch `withRunLock`(claim-engine.ts:812)、core `openRunTx`(task-ops.ts:54)、`withRunTransaction`(run-ops.ts:21)、integrate `withLock`(integrate.ts:35)、submit/context-plane 手写内联;docs/20 §4.2/§4.5 承诺的 `RunTx` 类型强制持锁("锁外拿不到写句柄")未实现 |
| REQ-E2 | 状态机数据化、单一真值源 | 转换规则内联散在 submit.ts/review.ts/task-ops.ts/run-ops.ts 的 if 守卫;事件→状态映射表 `EVENT_STATUS` 长在 audit(replay.ts),watch 为拿它引入 watch→audit 依赖边(progress.ts:5),文档依赖图不允许;`'verify'` 笔误这类枚举漂移正是"无单源"的产物 |
| REQ-E3 | 观测归层 | read-model 职责(status/progress/computeProgress)长在 watch 包(docs/20 说该有 read-model 包);`writeProgress` 固定 tmp 文件名且不持锁,双窗口并发 status 有 rename 竞态(progress.ts:195-200) |
| REQ-E4 | audit 包定位明确 | docs/20 §4.6 明文 audit "禁止写";实况 repair.ts 持锁、writeJsonStateAtomic、appendEvent、writeBackup,住在 audit 包 |
| REQ-E5 | 死代码与死配置清理 | `.team/templates/` 死目录(仅 lifecycle.ts:47 创建,零消费);core re-export storage 8 符号零消费(core/index.ts:1,9);candidateGuard 死默认 `['done']`(claim-engine.ts:424 附近,两个调用点均显式传参);`require_verification` 策略字段无任何消费方(grep 仅 import 写入)——设 false 照样要求 verify 记录,是骗人的死配置 |

---

## 2. 顶层架构设计

### 2.1 现状诊断(凭据回链)

代码实况是**纪律良好的三层单体**(storage 原语 / core+dispatch+context+audit 领域 / watch+cli 前端),无循环依赖,构建拓扑与依赖一致。问题不在分层,而在:

1. **不变量无单一实现点**(REQ-E1/E2)——五份事务骨架、三种写序(各自注释都引 docs/17 §5.3 却写出三种顺序,唯一全局成立的是 events-last)。
2. **知识放错层**(REQ-E2/E3)——EVENT_STATUS 在 audit、progress 在 watch、path-conflict 在 core,与 docs/20 的 L3 组件表两张皮。
3. **模式(lightweight)以 flag 散弹枪方式进入**——四处 if 分支(run-import.ts:138,195;claim-engine.ts:519-549;task-ops.ts:260-262;claim-engine.ts:771-779),而 audit/watch/status/run list 全不知情。**这是特性漂移侵蚀架构的活样本:新语义没有落点,只能散落。**
4. **指引(guidance)无注册表**——next_actions 由各调用点手拼 + 一个万能兜底(envelope.ts:70),状态感知为零。

### 2.2 目标架构:内核四件套 + 一次归层

新增/收敛五个内部模块,全部落在既有包内,**不加包、不破坏对外契约**(信封/exit code/schema 全部向后兼容,变更全部是可加性的):

```
┌──────────────────────────── cli(前端)────────────────────────────┐
│  命令注册表 → 参数解析 → 调 core/dispatch/context 门面 → render    │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────── core(领域内核)─────────────────────────┐
│ ① core/tx        TxKernel:唯一事务骨架(锁内写句柄)               │
│ ② core/state-machine  三张转换表(run/task/claim)+ EVENT_STATUS   │
│ ③ core/mode      RunMode 能力对象(lightweight/full 的唯一分叉点)  │
│ ④ core/guidance  code→next_actions 注册表(状态感知)              │
│   (dispatch/context/audit 的 mutator 一律经 ①,守卫一律查 ②③)     │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────────── storage(原语)──────────────────────────┐
│ 锁 / rev 原子写 / redaction / 路径围栏(不变)                      │
└────────────────────────────────────────────────────────────────────┘

⑤ 归层:EVENT_STATUS 从 audit/replay 下沉到 ②(消掉 watch→audit 边);
   watch 包职责如实更名为 read-model(文档层面),writeProgress 加锁改 tmp 唯一名。
```

#### ① `core/tx` — TxKernel(解 REQ-E1;兑现 docs/20 §4.5 的类型强制持锁)

```ts
// 唯一签名。五份拷贝全部改由此路由。
export function withRunTx<T>(
  opts: ResolveOptions, runId: string,
  guard: RunGuard,                 // 声明式:允许的 run 状态集合、是否要求 agent 注册等
  body: (tx: RunTx) => Envelope<T>
): Envelope<T>

interface RunTx {
  readonly root: string; readonly runId: string; readonly run: RunDoc;
  readState<T>(rel: string): Versioned<T>;
  writeState<T>(rel: string, doc: T, expectedRev: number): void;  // 仅此句柄可写
  appendEvent(e: EventInput): void;                                // events-last 由 tx.commit 强制
  counters(): RunCounters;
  readonly takeover: LockTakeoverInfo | null;                      // 见 REQ-D2:锁接管留证
}
```

- **持锁纪律由类型保证**:`writeState`/`appendEvent` 只存在于 `RunTx` 上,而 `RunTx` 只在锁内构造——"锁外拿不到写句柄"从约定变成编译期事实。CI 加 dependency-cruiser 规则:feature 代码禁止直接 import `writeJsonStateAtomic`(docs/20 §5 本来承诺的白名单)。
- **events-last 由结构保证**:`body` 内 `appendEvent` 只入队,`withRunTx` 在 body 正常返回后统一 flush(先 state 后 events 的顺序不再依赖每个作者记得)。
- **lock_takeover 落账**(REQ-D2):`acquireLock` 返回接管信息(storage 已有全部要素:token/rename 路径),TxKernel 在事务首个事件前自动补一条 `lock_takeover` 事件——storage 层不能写事件(层次禁令),放 TxKernel 恰好合层。
- **sweep 前置**(docs/20 R4 的 withSweep 承诺):`guard` 声明 `sweep: true` 的事务在 body 前跑 `sweepExpired`,按命令语义选择开启(claim/submit/review/verify 开,msg post 等轻写不开——修正文档而非全量强推)。
- 迁移策略:先落 TxKernel,再把五个调用方逐个切换,每切一个跑全量测试;写序统一为"详情→索引→claims→派生→events"(docs/17 §5.3 同步修订为实况)。

#### ② `core/state-machine` — 状态机数据化(解 REQ-D5/E2)

```ts
export const TASK_TYPES = ['feature','bugfix','review','verification','integration','spike','docs'] as const;
export const CLAIM_STATUS = ['active','submitted','completed','released','reclaimed','cancelled'] as const; // completed 入宪,见 D21 附带修订
export const TASK_TRANSITIONS: TransitionTable = { /* 现散落各 mutator 的 if 守卫,收敛为数据 */ };
export const RUN_TRANSITIONS: TransitionTable = { /* 同上;新增 integrating→active(reopen)与轻量终局边,见 §3 */ };
export const EVENT_STATUS = { /* 自 audit/replay.ts 迁入;audit 与 watch 改从 core 引 */ };
```

- 三个消费方共用一张表:mutator 守卫(拒绝时自动生成"当前态/目标态/允许动作"的结构化错误)、audit 重放(foldLedger)、**docs 生成**(脚本从表生成 docs/15 的状态机附录表,对账测试断言文档表 = 代码表——drift 变成红灯,见 §5)。
- `'verify'`/`'verification'` 这类笔误从此不可能:类型枚举单源,integrating 过滤直接引 `TASK_TYPES` 子集。
- watch→audit 依赖边消除(watch 改 import core),依赖图回到 docs/20 §5 允许的形状。

#### ③ `core/mode` — RunMode 能力对象(解 REQ-A3;轻量模式的唯一分叉点)

```ts
export function resolveRunMode(run: RunDoc): RunMode;
interface RunMode {
  kind: 'lightweight' | 'full';
  commands: { done: boolean; submit: boolean; review: boolean; verify: boolean;
              integrate: boolean; report: 'after_integration' | 'when_all_done' };
  claimAutoRegister: boolean;
  auditProfile: 'full' | 'lightweight';    // 见 §3.D-2
  nextActionsFlavor: 'ceremony' | 'direct';
}
```

- 现四处 flag 散弹全部收编;**新消费方按能力问、不按 flag 问**:audit 引擎按 `auditProfile` 选规则集,watch/status 按 `report` 能力判终局临近,`run list` 输出 `mode` 字段(S3/S8/S10 的共同根因是"模式只存在于两个命令的 if 里")。
- **模式墙**:轻量 run 上 submit/review/verify/integrate 返回新错误码 `mode_mismatch`(exit 7),消息明确指路 `done`;full run 上 `done` 的现有拒绝(task-ops.ts:260-263,文案已好)保持。互斥从"部分命令知道"变成"守卫层统一知道"。凭据:S3 里 submit 在轻 run 静默直通是陷阱入口。

#### ④ `core/guidance` — 指引注册表(解 REQ-C5;P-2 的实现基础)

```ts
export function nextActionsFor(code: ErrorCode, ctx: GuidanceCtx): string[];
// GuidanceCtx 至少含:run 状态、run mode、任务状态、租约信息(若相关)
```

- 每个错误码一个条目,**允许按 ctx 分流**:`run_not_active` 在 planned 时建议 publish、在 reported/cancelled 时明说"run 已终局,残留任务需在新 run 重建"(S9 的互踢即消);`run_paused` 建议 `run resume`;`claim_not_found`/`self_approval_forbidden` 给各自正解。
- 兜底降级为最后手段且文案改为"这是一个未收录的错误,请附 --json 输出报告 issue"——不再假装 doctor 能治(S12)。
- failEnvelope 增加可选 ctx 参数;未传时退化为静态表(零风险渐进迁移)。

### 2.3 对外暴露的关键能力(公共契约变更清单)

全部为**可加性**变更;既有 schema 均不升 major(新增可选字段),既有命令语义不破坏:

| 面 | 变更 | 服务的需求 |
|---|---|---|
| 命令(新增) | `block <RUN> <TASK> --agent --msg=MSG-ID`(owner 阻塞,租约冻结);`run reopen <RUN>`(integrating→active);`agent list <RUN>`;`reclaim --force`(限 `--agent=user`) | REQ-B2/B7/C2/B4 |
| 命令(增强) | `report` 在轻量 run 全 done 时可用;`run list` 增 `mode`+`progress_pct`;`status` 增 agents 段与流水线 needs 项;`watch` 逐轮输出(`--json` 为 NDJSON 行);`msg post` 捎带续租 | REQ-A2/A3/C1/C2/C4/B2 |
| 信封 | 新错误码 `mode_mismatch`、`gateway_too_old`(docs/21 §6.2 的 data.kind 一并落地);next_actions 全面状态感知 | REQ-A3/D4/C5 |
| 事件 | 新增/补发:`lock_takeover`、`memory_updated`、`run_migrated`、`task_blocked`(owner block);目录收编 `worktree_pruned`/`verify_claimed`/`verify_released`;`task_rework_started` 走 D21 附带裁决(推荐:修订 docs/18,承认 `task_started`+`payload.resumed` 为规范形态——重放已对齐,改文档比改事件便宜且不破坏已有账本) | REQ-D2 |
| 审计 | AUD-019 修正;audit 按 RunMode 选 profile(轻量 run 豁免 AUD-011/016/017/019 → 降 info);AUD-003 补扫 review-claims | REQ-D5/D1/B3 |
| adapter | 模板 v0.4:RULE 7 与续租实现对齐;`/team-do` 按 `mode` 选 run;codex 侧补 6 个缺失 skill;`/team-do` 增加"完成后若全 done → 建议 report" | REQ-B2/A3/A4 |

### 2.4 不做什么(裁剪,防止整改自身过度设计)

- **不实现** docs/12 的 5 种死 edge kind、context snapshots、message visibility、N-1 读窗口——审查证实无消费方,随 D24 在 spec 中降级为 P2/删除。
- **不新建包**(read-model 只做职责更名与文档回写,不物理拆包)——9.4k 行的体量,八包已是轻度过度拆分。
- **不做 dashboard**(docs/23 维持设计稿地位)——先把 CLI 人面(C3)做到可用,是同一预算下收益更高的选择。
- **不改锁机制本体**(30s stale 无续期的接管窗口记为已知限制,docs/17 §4 明示;CLI 短事务体量下概率极低,修复成本与收益不成比)。仅补 lock_takeover 留证(随 TxKernel 顺手兑现)。

---

## 3. 分域详细设计

### §3.0 场景编号(全部已实跑复现,作为回归测试的种子)

S1 reclaim×INV-008 评审死锁 · S2 blocker 等待被回收 · S3 轻量误 submit 卡 approved · S4 request-changes 给死者续租 · S5 reviewer 死亡不可见+合成器首刷谎报 · S6 上游 cancelled 下游无期徒刑 · S7 integrating 单行道 · S8 轻量无终局 · S9 reported 残留任务互踢 · S10 audit×轻量误报 · S11 blocker needs_user 自闭环 · S12 doctor 万能兜底 · S13 prune 断头指引

---

### D-A 旅程完整性

#### A1(P0)worktree 建议路径自洽 —— REQ-A1

- **根因**:冒烟修复 L17(提交 1836ab1)给 `default_worktree_root` 加项目名段时,未同步 claim-engine 的建议构造(该行自首提交 32238f3 未动);测试断言过弱。
- **设计**:`claim-next` 的 suggested_path 一律从 `run.json.worktree_root` 派生(`join(run.worktree_root, taskId)`),不再自行拼接;删除重复拼接逻辑(单源)。
- **回归锁**:① 单测断言 `suggested_path.startsWith(run.worktree_root)`;② **自洽断言**(P-1 的局部形态):新增集成测试——按 claim-next 的建议创建真实 worktree 后 `worktree register` 必须 ok(网关的建议必须过网关的校验,这条元断言防住整类问题)。
- 凭据:claim-engine.ts:767、run-import.ts:202、lifecycle.ts:66-68、templates.ts:62-65、claim.test.ts:31-33。

#### A2 轻量终局 —— REQ-A2(依赖裁决 D21,推荐方案)

- **设计(推荐)**:复用既有链条,**不加新状态**——`report` 对 `mode.report === 'when_all_done'` 的 run 放宽守卫:轻量 run 且无非终态任务时允许 `active→reported`(report.md 从 done 记录与 notes 生成简化汇总);随后 `archive` 照旧。watch 的 TERMINAL 集合不动(reported 可达即自然退出,S8 消)。
- **收尾引导**:`done` 完成最后一个任务时,信封 next_actions 追加 `sigmarun report <RUN>`;status 对全 done 轻量 run 产生 needs_user 项(kind=`run_close`,command=report)。
- **备选**(见 D21 选项 B/C):全 done 自动翻 reported(少一步,但"隐式状态迁移"违背本产品显式账本的性格);或收回 done 命令(杀死轻量模式,不建议)。
- 凭据:integrate.ts:282-289、run-ops.ts:177、watch.ts:15、S8。

#### A3 模式墙与导航 —— REQ-A3

- **设计**:`core/mode`(§2.2③)+ 三个消费点:① submit/review/verify/integrate 在轻量 run 返回 `mode_mismatch` 指路 done;② `run list` 数据增 `mode` 与 `progress_pct`(progress 已有现成计算);③ adapter `/team-do` 模板改为"选最近的 **active 且 mode=lightweight** 的 run;无则指引 /team-plan"。
- **凭据**:S3 全链、templates.ts:161-163、progress.ts:235;/team-do 误击 full run 后连锁(自注册失败→注册→claim→done 拒收→搁浅)已实测。

#### A4 起步资料 —— REQ-A4

- README 安装节改为"源码安装(现状可用)+ npm(发布后解锁)"双轨,repository 占位随发布填实;quickstart 增最小 payload 样例(与 templates.ts:127-133 同源,由脚本从模板抽取,防两处漂移);新增 `init --example`(在空 run 里生成示例 payload 文件,docs/22 路线图已有此项);codex 适配器补 publish/integrate/submit/evidence/runs/tasks 六个 skill(与 claude 侧模板同源生成)。
- 凭据:package.json:31-38、templates.ts:603-611、审查启动组 1–3 条。

---

### D-B 协作安全网

#### B1 INV-008 判据:从"曾持有"改为"实质贡献" —— REQ-B1(依赖裁决 D22,推荐方案)

- **现状**:historicalOwners = 该任务全部 claim 记录的 agent 集合(review.ts:47);接管者与被接管者互相封死(S1)。
- **设计(推荐)**:owner-for-review 判据改为 **`evidence 任意 revision 的提交者 ∪ 当前 active/submitted claim 持有者`**。理由:在本协议里,"对代码负责"的机械可查形态就是 evidence 提交(evidence.by);纯接管未产出者(以及认领后一行未交就被回收者)不再被算作作者。第二道防线不变:reviewDecide 时按同一判据复查(review.ts:287-291 同步改)。gateway 不读 git(D11),故不用 commit 作者做判据——这是能力边界内最精确的信号。
- **残余风险(如实记录)**:A 写了部分代码未及提交被 B 接管续写并提交,新判据下 A 可评审含自己旧代码的提交。权衡:该风险是"部分自审",而现状是"全体死锁+诱导身份洗白";且 review 记录永久留痕、audit AUD-015 同判据复查,可追责。docs/18 信任模型章节记录此让步。
- **配套**:`claim-next --role=reviewer` 无候选时,若存在"因 INV-008 被过滤"的任务,信封 data 如实给出 `filtered_by_independence: [TASK…]` 并建议引入其他评审身份——不再谎报"没有任务在等评审"(S1 的第二层伤害)。
- 凭据:review.ts:47、142-147、287-291;S1;docs/15 §7、docs/18 INV-008。

#### B2 阻塞通道与续租诚实 —— REQ-B2

- **`block` 命令**(spec 既有,补实现):`sigmarun block RUN TASK --agent=<owner> --msg=MSG-ID` → 校验 claim 持有者 + MSG 存在且 type=blocker → task working→blocked、**claim.lease 冻结**(sweep 对 blocked 已豁免,claim-engine.ts:278 现成)、事件 `task_blocked`。`unblock` 已有(review.ts:445-504)。转换表入 ②state-machine。
- **reclaim 的 blocker 检查**(spec 既有,补实现):applyReclaim 回收时若该任务存在未答复 blocker → 置 blocked 而非 ready(docs/10 §10;claim-engine.ts:331 现为无条件 ready)。
- **捎带续租对齐 RULE 7**(docs/15 §8 本意):owner 身份调用的写原语(msg post/block/submit)自动续租——`msg post` 带 `--agent` 且该 agent 持有关联任务的 active claim 时,lease 顺延一个 TTL(在 TxKernel 内做,一处实现)。模板 RULE 7 文字保持,承诺终于为真。
- 凭据:S2、cli.ts 无 block 分支、templates.ts:36、context-plane.ts:129-205、claim-engine.ts:278/331。

#### B3 gate 租约:可回收、可见、合成器修序 —— REQ-B3

- **顺序 bug(立即修)**:`synthesizeReview`/`synthesizeVerify` 调整为**先 sweepReviewClaims、后取任务快照**(review.ts:219-243 现为相反),首刷即正确。
- **sweep 统一**:`sweepRun`(watch tick)与 claim-next 的 sweep 补扫 gate 租约(review-claims.json),过期 gate → 释放并把任务 reviewing→submitted 回退(逻辑已有,只是没进巡检面)。
- **观测补盲**:computeProgress 读 review-claims,过期 gate 进 risks(kind=`stale_review`)与 needs_user(command=`claim-next --role=reviewer`);AUD-003 输入面补 review-claims(docs/18 本来就写了)。
- 凭据:S5、review.ts:219-243、claim-engine.ts:379-407、progress.ts:108-130、engine.ts:114-128。

#### B4 死者租约的人类处置权 —— REQ-B4

- **设计**:`reclaim --force`,仅接受 `--agent=user`(人类根权限,与信任模型一致),绕过"必须已过期"检查,事件 payload 记 `forced: true`;needs_user 增加检测:changes_requested/working 任务的 owner **最后心跳距今 ≥1×TTL** 且租约未到期 → 产生 `stale_owner` 项,command 给 `reclaim --force …--agent=user`。request-changes 的复活续租逻辑保持(对活 owner 是正确行为),死 owner 场景由上述兜底。
- 凭据:S4、review.ts:396-406、claim-engine.ts:932-937。

#### B5 验证门真空通过封堵 —— REQ-B5

- **设计**:机械规则加一条——`verdict=pass` 要求**至少一个非 skipped gate**;全 skipped 只允许 `verdict` 为 fail 或携带 run policy 明示的豁免(轻量 run 走 mode 墙根本不进 verify)。docs/14 §4 补一句。
- 凭据:verify.ts:97(`nonSkippedAllPass` 真空成立)、S3 逃生实测。

#### B6 上游取消的下游处置 —— REQ-B6

- **设计(最小)**:`task cancel` 时扫描下游(blocks 边),信封 warnings 列出将被锁死的任务并给出处置建议(cancel+add 替身);status 对"依赖已取消上游"的任务产生 needs_user 项(kind=`deps_dead`)。**不做**依赖编辑命令(改图应走 task add 重建,保持 DAG 不可变账本性格;在 docs/03 记为设计取舍)。
- 凭据:S6、deps_satisfied_when 值域(claim-engine.ts:424)。

#### B7 集成期回头路 —— REQ-B7(spec 既有,补实现)

- **设计**:`run reopen <RUN>`:integrating→active,事件 `integration_reopened`(docs/15 §2.2 原文),守卫:仅 integrating、无进行中的 integration 任务 claim。转换入 ②表。reopen 后可 task add/publish 补任务,再 integrate start 重入。
- 凭据:S7、docs/15 §2.2、integrate.ts:92-103。

---

### D-C 观测与指引

#### C1 needs_user 流水线扩容 —— REQ-C1

新增五类(现三类保留),全部带可复制命令,数据来源均为现有状态文件,无新采集:

| kind | 触发 | command |
|---|---|---|
| `awaiting_review` | submitted 且无 active review claim 且 policy 要求评审 | `claim-next --role=reviewer --agent=<其他身份>` |
| `awaiting_verify` | approved 且无 active verify claim | `claim-next --role=verifier …` |
| `awaiting_rework` | changes_requested 且 owner 心跳新鲜 | `resume … --agent=<owner>`(owner 心跳陈旧 → 转 B4 的 `stale_owner`) |
| `ready_to_integrate` | 全部任务 ≥verified 且 run=active | `integrate start` |
| `ready_to_report` | integrating 且 verified 剩余 0 / 轻量全 done | `report` |

status 的 next_actions 取 needs[0](现逻辑,progress.ts:213),从此流水线每个等待态都有答案;S1/S5 类悬挂即便发生,也会以 `awaiting_review`+`filtered_by_independence`(B1 配套)形态浮出水面。
凭据:progress.ts:106-162 仅三类;审查指引一致性分析第 1 条。

#### C2 agent 视图 —— REQ-C2

`agent list <RUN>`:agents/*.json × claims 联查,输出 agent_id/label/role/current_task/last_heartbeat_age/claim_status;status 数据增 `agents` 汇总(active/stale 计数)。人面渲染成表(C3)。兑现 docs/04 §6 的展示承诺。
凭据:cli.ts 注册表无此命令、progress.ts:179-191。

#### C3 人面渲染 —— REQ-C3

render() 从"两个特判"改为**按 data 形状的通用节段渲染器**:表格(tasks/agents/claims 列表)、键值块(run/task 详情)、正文块(messages——**必须含 body**)、needs_user 列表(带命令)。覆盖 status/run show/task show/msg list/evidence show/agent list 六个高频读命令;`--json` 契约不动。
凭据:cli.ts:83-93、实测 msg list 无正文等五例。

#### C4 watch 心跳输出 —— REQ-C4

循环模式每轮输出单行摘要(人面:`HH:MM tick: reclaimed N, progress P%, needs M`;`--json`:每轮一行 NDJSON 信封——docs/17 §7 本来的形态);终局判定经 RunMode(轻量全 done → 提示 report 后退出等待,配合 A2 自然终止)。
凭据:cli.ts:256-261、S8 静默循环。

#### C5 指引注册表 —— REQ-C5

§2.2④ 的 `core/guidance` 全量接线:为现有全部错误码(cli.ts:10-46 的映射表枚举)补条目,S9/S11/S12/S13 四个复现场景直接作为注册表的验收用例(S11 的 blocker 项 command 改为 `msg post --type=answer --reply-to=<MSG> --body="…"` 模板;S13 的 prune 指引按 claim/租约状态分流出 register/adopt/release/reclaim 四种正解)。
凭据:envelope.ts:30-37/70、S9/S11/S12/S13、worktree.ts:69/160。

---

### D-D 宪法与漂移治理

#### D-1 轻量模式入宪 —— REQ-D1(裁决 D21)

新增 **docs/26-lightweight-mode.md**:动机(核心用例被完整流水线埋没)、能力矩阵(RunMode 表)、INV-007 修订条款(「实现者不得自标完成」修订为「**在 full 模式 run 中**永不放开;轻量 run 显式豁免,豁免以 run.json.lightweight 标志 + `task_done` 事件的 mode 标注留痕」)、审计口径(profile 表)、终局(A2)、与 full 的互斥墙(A3)。docs/15 §9、docs/18 信任模型同步落修订注。ADR-021 补决策记录(现状:零记录)。

#### D-2 审计修正与 profile —— REQ-D5/D1

- AUD-019 判定改为 spec 原文:task 级 `review.required === true` 被跳过 → error;run policy 关闭下的跳过 → warn(engine.ts:428-433)。
- audit 引擎读 RunMode:`auditProfile === 'lightweight'` 时 AUD-011/016/017/019 对 done 任务降为 info(保留可见性,不制造恐慌);其余 36 条照常(账本/锁/路径/记忆规则与模式无关)。S10 的验收:健康轻量 run audit 零 error(P-4)。
- `'verify'`→`'verification'` 笔误随 ②state-machine 单源自动消灭(过渡期先一行热修,R0)。

#### D-3 spec 回写批处理 —— REQ-D3

一次 reconciliation pass(随 D24 裁决定节奏,本次先补齐):docs/17 §1 命令表(补 events/done/block/reopen/agent list/prune/restore/--verbose/reclaim --force;四个未实现的 MVP 承诺命令降级 P1 或实装——`task list` 建议实装,查询面成本低收益高;其余降级)、docs/18 事件目录(3 进 4 出 + task_rework_started 裁决)、docs/21 §4.1(migrate-on-read 改判 + data.kind 落地)、docs/11/20(八包实况、watch=read-model 职责、audit 含 repair per D23、run.lock 路径、D20 默认值、写序契约收窄为 events-last+推荐序)、docs/10(D18 双点、D20 回写)、current-state.md 刷新、traceability 矩阵补 FEAT-012…(roadmap 六件套+轻量+本方案各特性)、ADR-020(migrate-on-read,追认)/021(轻量)/022(INV-008 判据)/023(audit 定位)/024(回写节奏)落档。

#### D-4 版本写闸门 —— REQ-D4

TxKernel 构造时(所有写事务的必经点)校验 `project.json.min_gateway_version`:major 高于自身 → `gateway_too_old`(exit 8,data.kind 按 docs/21 §6.2);读命令不拦(维持 migrate-on-read 裁决)。一处实现覆盖全部写面——这正是 TxKernel 存在的红利。
凭据:lifecycle.ts:65 只写不读、docs/21 §8。

#### D-5 R0 级小修清单(全部有凭据,零裁决依赖)

| 修复 | 凭据 |
|---|---|
| writeProgress tmp 文件名加 pid(消并发 status 竞态) | progress.ts:195-200 |
| `--team-root` flag 接入 CLI 解析(storage 已支持) | storage/index.ts:36-41、cli.ts 全文无 |
| `task cancel --reason` 落账(help 已承诺) | cli.ts:107 vs task-ops.ts:34-37 |
| 裸 `sigmarun` 打印 help;子命令拼错提示 `sigmarun help` 与近似命令 | cli.ts:509 |
| `--flag value`(空格)给出"请用 --flag=value"专属报错 | cli.ts:56-59 |
| events 时间线显示日期(跨天 run) | cli.ts:70 |
| candidateGuard 死默认参数删除;core 对 storage 的零消费 re-export 删除;`.team/templates/` 不再创建 | claim-engine.ts:424 附近、core/index.ts:1,9、lifecycle.ts:47 |
| `require_verification`:实装(integrate start 在 policy 关闭时接受 approved)或 import 时拒绝未支持值——**推荐实装**,它是 D6(评审开关)的对称件 | grep 零消费、docs/15 §10 |

---

### D-E 架构收敛(§2.2 已给设计,此处只列迁移序与验收)

1. **E1 TxKernel**:先并行落地(新模块+全量测试),再按"风险从低到高"切换调用方:run-ops → task-ops → integrate → submit → claim-engine(最复杂最后切);每切一步全量测试 + 并发真进程测试(concurrency.test.ts 现成)必须绿。验收:grep 断言仓内 `acquireLock|tryAcquireLock` 的 feature 层调用点唯一(TxKernel 内);五份骨架物理删除。
2. **E2 state-machine 表化 + EVENT_STATUS 下沉**:先建表并让新守卫(block/reopen/mode 墙)走表,存量守卫分两批迁移;audit/replay 与 watch/progress 改 import core。验收:watch 包 package.json 依赖去掉 audit;docs 生成脚本产出的状态表与 docs/15 附录逐字节一致(对账测试)。
3. **E3 read-model 归层**:文档更名 + writeProgress 修竞态(R0 已含);不物理拆包。
4. **E4 audit/repair 定位**:按 D23 裁决执行(推荐:修订 docs/20 承认 audit=«规则+重放+修复»,约束条款改为"audit 的写路径唯一入口是 repair,且必须经 TxKernel+备份");若裁决迁移,则 repair.ts 平移至 core 并保留 foldLedger 单源(从 core/state-machine 引)。
5. **CI 结构守卫**:dependency-cruiser 落地(docs/20 §5 承诺):storage 不得 import 任何包;feature 层不得直接 import 原子写;watch 不得 import audit;cli 之外不得 import adapters。

---

## 4. 交付计划(五个阶段,每阶段带 gate)

依赖关系:R0 无前置;R1 依赖裁决 D21/D22;R2 依赖 R1 的 mode/needs_user 基建;R3 独立可并行于 R2(建议 R2 前完成 TxKernel 以便 B2/D-4 落在内核上——故 TxKernel 提前进 R1.5);R4 收尾。

| 阶段 | 内容 | Gate(全部机器可验) |
|---|---|---|
| **R0 止血**(无裁决依赖,~10 项小修+回归锁) | A1(P0)、B3 顺序 bug、D-2 的 AUD-019+笔误热修、B5 真空 pass、B2 的 msg 续租(spec 既有)、D-5 全部小修 | 全量测试绿;新增 S5 回归测试绿;A1 自洽断言绿;审计对既有冒烟 fixture 结论不变 |
| **R1 裁决落地**(D21/D22 批准后) | TxKernel(E1,含 lock_takeover/D-4 闸门/sweep 前置)、A2 轻量终局、A3 模式墙、B1 INV-008 判据、B2 block 命令+reclaim blocker 检查、B4 reclaim --force、B7 run reopen、D-1 docs/26+INV-007 修订、D-2 audit profile | S1/S2/S3/S4/S7/S8/S10 七个场景回归测试绿;并发真进程测试绿;P-3 断言对场景包成立 |
| **R2 观测与指引** | C1 needs_user 扩容、C2 agent 视图、C3 人面渲染、C4 watch 心跳、C5 guidance 全量、B6 下游处置、A4 起步资料(codex 补齐/README/init --example)、adapter v0.4 | S6/S9/S11/S12/S13 绿;**P-2 元断言上线并对全场景包绿**;人面六命令快照测试 |
| **R3 架构收敛** | E2 state-machine 全量迁移+EVENT_STATUS 下沉、E3 归层、E4(per D23)、E5 清理、CI dependency-cruiser | typecheck+全量绿;依赖图对账测试绿(watch 无 audit 依赖);docs 生成表 = 代码表;grep 断言五骨架归一 |
| **R4 宪法回写与发布** | D-3 全部回写、ADR-020…024 落档、current-state/traceability 刷新、**docs-代码对账测试**(命令表/事件目录/状态表三张)、README 双轨安装、npm publish 解锁(用户侧:填 OWNER、npm login) | 对账测试绿;两模式端到端冒烟(P-1)对 tarball 全绿;P-4 conformance 绿 |

**验收总闸**:§0 的 P-1…P-4 四命题全绿 = 整改完成。13 个场景测试 + 3 张对账测试 + 2 个端到端脚本从此常驻 CI,是本方案留给产品的**防漂移永久资产**——下一次"特性只进 CHANGELOG"会直接把 CI 打红。

---

## 5. 防漂移的机制化(回答"如何防止再次发生")

本次漂移的根因不是纪律涣散,是**对账靠人**。方案将三类宪法条款机器化:

1. **命令表对账**:cli 注册表(代码)与 docs/17 §1(表格解析)双向包含断言——新命令不登记、文档承诺不实现,测试红。
2. **事件目录对账**:全仓 `appendEvent` 的事件名集合(静态扫描 + state-machine 表)= docs/18 §2 目录集合。
3. **状态机对账**:docs/15 状态表由 ②state-machine 生成脚本产出,提交的文档与生成结果 diff 为空。

加上 dependency-cruiser(依赖图对账)与 A1 的"建议必须过自家校验"元断言,五道机器闸覆盖本次审查五个簇的漂移形态。

---

## 6. 决策记录(D21–D24)

> **裁决结果(2026-07-15,产品负责人)**:四项全部采纳推荐项(下表加粗项)。D21=修宪+report 终局;D22=实质贡献判据;D23=修订 docs/20 承认 audit 含 repair;D24=语料库宪法权威+机器对账。正式 ADR 文件按 R4 阶段落入 docs/04-decisions/(ADR-021…024,另补 ADR-020 追认 migrate-on-read)。

| # | 问题 | 选项(推荐加粗) | 影响面 |
|---|---|---|---|
| **D21** | 轻量模式入宪与终局 | **A:docs/26 + INV-007 修订(仅轻量豁免)+ report-when-all-done 终局 + audit lightweight profile**;B:全 done 自动翻 reported(隐式迁移,违背显式账本性格);C:收回 done,轻量走简化 submit(杀死轻量价值) | A2/A3/D-1/D-2,R1 全部 |
| **D22** | INV-008 owner 判据 | **A:evidence 提交者 ∪ 当前持有者(实质贡献判据,残余风险如实记档)**;B:维持"曾持有"判据 + 仅靠 user 强制评审豁免(每次接管都要人工介入);C:维持现状(制度性鼓励第三身份洗白,不建议) | B1,S1 |
| **D23** | audit 包含 repair 的定位 | **A:修订 docs/20,承认 audit=«规则+重放+修复»,写路径唯一入口 repair 且必经 TxKernel+备份**;B:repair 平移 core(包边界纯净,但 foldLedger 消费方跨包,徒增一次搬家) | E4,docs/20 |
| **D24** | 语料库权威与回写节奏 | **A:宪法权威不变;恢复"每特性带回写"+ 本次 reconciliation pass + §5 三张对账测试常驻 CI(漂移=红灯)**;B:宣布实现与测试为权威、语料库降级参考(省力,放弃防漂移初衷) | D-3/§5,R4 |

---

## 7. 风险与开放问题

- **TxKernel 迁移是本方案唯一的"心脏手术"**:五个调用方逐个切换、每步全量+并发测试护航;claim-engine 最后切;若 R1 时间紧,TxKernel 可只承接**新增**写面(block/reopen/force/闸门),存量迁移顺延 R3——方案按此弹性排布。
- **INV-008 新判据的残余风险**(B1 已述)记入 docs/18 信任模型,附带缓解(评审留痕+AUD-015 同判据)。
- **审计 profile 引入"同一规则两种严重度"**:以 RunMode 为唯一分叉依据、profile 表写进 docs/26,避免成为第二个散弹开关。
- 开放问题(不阻塞,R2 后评估):`user` 作为评审身份的一等化(现只是 actor 字符串)、`task list` 查询面的过滤参数集、multi-run 工作台(run list 聚合 needs_user)。

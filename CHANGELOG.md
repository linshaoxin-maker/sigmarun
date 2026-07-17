# Changelog

## Unreleased

- **Top 命令收敛 + 功能闭环批**(adapter v0.6.0,341/341=+1):用户面 13 个 /team-* 收敛为「三件套 plan/do/status 跑完整环、门命令由 status 递出」。核心是**合并**:`/team-do` 成为唯一"干活"入口,自动读 run 模式——轻量走 done、full 自动转 dispatch 流(worktree+证据+submit),用户不再需要知道"模式↔命令"映射;`/team-dispatch` 降为进阶别名(--task/--role/--loop)。闭环补丁 G1-G9:①report 后固定交接语(轻量:改动在工作区去 commit/PR;full:集成分支名去开 PR;下一目标回 plan);②中途变更块 MIDRUN_BLOCK(加任务=mini-plan 确认+task add+publish;砍=报下游依赖+确认+cancel;推翻=cancel 红线)注入 plan/do 两侧;③轻量接管脏工作区——共享 working tree 下死窗口的未提交改动,领任务前 git status 该任务 paths,脏则红线问 keep/discard;④窗口名必须生成唯一(win-<4随机>),win-1 这类可猜默认会让两窗口同身份互卡;⑤status 无参可用(唯一 run 直接看/多个列表);⑥full 的 publish 折叠进 plan 确认("确认拆解=授权发布",消灭 no_claimable_task 之谜);⑦没活可领改报"谁在做什么"而非裸 stop;⑧"评审须换窗口"(INV-008)在 dispatch 提交出口和 status 里明说;⑨RESUME CHECK——回来先查自己名下在途 claim,续做而非领新。**G-a `run cancel` 红线化**:无 `--yes` 返回只读影响预览(会死哪些任务、谁在途——claims 联 agent label),`--yes` 才执行;纳入 RED LINES。**G-b 前置错误补恢复引导**:claim_not_found 注册表补"租约可能被 sweep,重新 claim-next";done 撞 ready 补同款;block 撞 claimed 补"先 worktree register 或 heartbeat 保活"。Claude/Codex 两侧全程镜像;渲染 17 项标记逐一验证 + 真机 cancel 预览冒烟通过。

- **逐命令边界摸排 → 先修 4 个真 bug**(57 命令 × 8 维、5 族并行扫,~32 个边界缺口归 5 类;341/341=+4)。这 4 个是纯逻辑错误(与信任模型无关),直接修:①**restore 把账本改坏**——`repair` 的备份集含 `events.meta.json`,却在备份**之后**才往 `events.jsonl` 追加 `state_repaired`(而 events.jsonl 不在备份);restore 回滚 meta 却不碰 events.jsonl → `next_seq` 退到已用 seq 之下、下次 append 复用 seq(AUD-033/ledger_broken)。改为**不备份 meta**(对齐 migrate),restore 后 meta 与 events 一致。②**review approve 矛盾态**——must_fix 镜像成 open `request_changes` 消息的逻辑不分 decision,`approve` 却带 must_fix 会把任务推到 approved 的**同时**挂着未解决改动要求;在守卫处拦掉该矛盾输入。③**integrate record 参数冲突静默**——同传 `--merge-commit` 与 `--failed` 时先判 failed、静默丢弃 merge-commit、把已合并任务悄悄打回 changes_requested;改为互斥 → `usage_error`。④**watch 单实例锁失效**——循环模式首 tick 拿锁即释放、后续 tick `force` 绕锁,两个 watch 几乎必然并发、"已被占用"永不触发;首 tick 改 `holdLock` 持锁整个循环。四个各带回归测试。**归属鉴权(memory promote / approve-paths 记成 "user")经确认不修**:gateway 分不清 AI 与人(同一 CLI 边界),"鉴权"只是又一道 AI 能绕的形式门,与四道门 honor-system 同源——是信任模型的固有特性,非缺口。其余中/低缺口(破坏性操作确认、前置错误 next_actions、坏参数校验等)见缺口全景,待分批。

- **`/team-do` 多-run 消歧(human-loop 补丁,adapter 0.5.2)**:不带 RUN-ID 时,指令原本静默取"最近的 active 轻量 run"——但用户常在**另一个 session/窗口**里打 `/team-do`,或开了**多个 `/team-plan`**,"最近"很可能不是他要的那个。改为:活跃轻量 run 恰好一个才自动用;**多于一个 → PAUSE FOR THE HUMAN**,列出(RUN-ID/标题/状态)让用户选,绝不猜;一个都没有则明说。两侧(Claude `/team-do` + Codex `team-run-do`)同步。选 run 本身是"歧义交给人",此前被漏。

- **故障 fork 补两处「交给人」缺口**(运行时数据流梳理挖出的 corner case;337/337=+4):①**锁误夺**:stale 判定原本纯看锁目录 `mtime`——而 mtime 建锁后从不刷新,一个合法长事务(大文件脱敏、慢 FS,>30s)和崩溃无法区分、会被等待者夺锁。改为**探持锁进程存活**(`process.kill(pid,0)`):只有进程真没了(或 meta 不可读)才夺;加硬上限 `20×staleMs` 兜 pid 复用;`lock_timeout` guidance 从误导的"~30s after last activity"改为按真实行为(进程没了才夺、长事务等它)。②**账本损坏交给人**:`events.jsonl` 的 torn 行或 seq 碰撞是 gateway 自愈不了的(`repair` 只能 roll next_seq),原来只有人主动 `audit` 才看得到;现在 status/watch 检测到就冒 `ledger_broken` needs_user(带 audit 命令、排最前),把解不了的主动交人。锁测试补活/死/无 meta/硬上限四场景,status 补 torn-line 检测。

- **adapter install 一次装多工具**:`sigmarun adapter install --tool=all`(或 `--tool=claude-code,codex`)一条命令把 Claude Code 与 Codex 两套指令都装上——本地两个工具都有的用户不必跑两次。抽出 `installOne` 循环、合并 written/updated/skipped、AGENTS.md 只写一次(工具无关);未知工具名仍 `usage_error` 并列出支持项;`data.tools` 给展开后的列表(保留 `data.tool` 原样兼容)。

- **人在环里 · adapter 交互层**(human-in-the-loop;adapter v0.5.1,333/333 不变——纯指令层):真实用一次(自举清死码)暴露的根因不是某个功能,而是 adapter 指令把「程序能自动跑通」当成了「用户体验」——AI 自动规划→自动领活→自动提交→自动集成,人只在卡死时被甩一个 error code(human-out-of-the-loop)。本轮把六个真决策点写回指令,让 AI 在岔路口带「做好功课的选择题」征询人:①`/team-plan` 在 `run import` 前 PAUSE 展示拆解待确认(先斩后奏→你批准);②`claim-next` 前用 `--dry-run` 预览「会领哪个+为什么」待选(自动领→你知情/可选);③`integrate` 合入共享分支前 PAUSE(红线);④claim 到带 `previous_attempts` 的死窗口半成品时 PAUSE 定 adopt/restart(红线;原 claim-next 对 ≥3×TTL 死租约静默接管);⑤要写 paths.allow 外文件时 PAUSE(gateway 只在 submit 记 `out_of_scope_change` warning、并不拦,故由指令兜;且禁止 AI 自己调 `approve-paths`——gateway 无鉴权、那是人的授权);⑥检查反复失败或返工两次以上(`events --type=changes_requested|verification_failed` 可只读计数)时带诊断 PAUSE 求助,不再无限烧 token 或冷抛 blocker。**新增 `COLLAB_BLOCK`**(注入 plan/do/dispatch/integrate 的 Claude+Codex 两侧)定义介入深度三档(AUTOPILOT/COLLABORATE 默认/CAREFUL,一句话切换、会话内记忆)+ 三条红线(合入/接管/越界,自动挡也拦)+「做好功课的选择题(带 diff/选项/诊断/建议)而非空白问答题、也非替你答了」原则。全部落 adapter 自然语言指令层,claim/lease/路径锁内核零改动——防撞车与人机交互正交。**诚实边界**:②预览用现有 `--dry-run`(可能顺带 sweep 落盘)、④是「接管后在 adopt/restart 点拦」而非「接管前拦」——要更强保证需新增两个小只读钮(`claim-next --preview` 纯只读 / `--no-auto-sweep`),本轮刻意未碰内核。**真机测试**(临时 repo 装 adapter 真跑一遍):验证指令引用的 gateway 契约(`claim-next --dry-run`→`would_claim`、`task list --status=ready`、`events --type=changes_requested`、造真实接管后 `task.previous_attempts`)均真实存在;并抓到 ④ 一处路径 bug——`previous_attempts` 嵌在 `data.task` 而非顶层,原指令让 AI 查顶层会永远漏判接管、④ 形同虚设,已把路径写明(v0.5.1)。印证「指令写对 ≠ 能跑,真正的验证是真实使用」。

- **整改 R5 用户旅途闭环**(第五张机器对账,产品轴;333/333=+22):前四张对账(命令表/exit码/事件目录/依赖矩阵)守的是「实现↔规范」开发者轴;R5 补上「**用户旅途↔功能↔特性**」产品轴。`packages/cli/test/journeys.test.ts` 把全部用户旅途枚举为 **18 条真实 CLI 命令序列的端到端回放**——轻量全链、full 全流水线、claim 生命周期、S1–S13 全部异常旅途(接管/adopt/blocker/返工/review-block/reopen/集成回退/上游取消/worktree 恢复/模式墙)、路径审批、记忆晋升、运维恢复、观测——每条断言「步步推进 + 到达终态 + 不缠绕」,且旅途声明的命令集**精确等于**其实际执行的命令(catalog 不谎报)。四条对账断言:每个改状态命令必属某旅途(无孤儿功能)、每个只读命令可达、无幻影步骤、每个宣称特性(23 个)被某旅途行使(无不可达特性)。**至此用户旅途-功能-特性漂移即 CI 红;docs/06 §3 回写注指向此可执行清单。**

- **整改 R3 架构收敛轮**(前置基线 307/307):①**事务骨架归一**——五份 run 写事务骨架(dispatch withRunLock、core openRunTx/withRunTransaction/integrate withLock+两处内联)全部委托 `core/tx.ts::withRunTx`(解析→存在→版本闸门+锁+接管留证→body→信封映射→释放,一处实现);②**architecture.test.ts** 机检:全仓仅一处 `tryAcquireLock(runLockPath())`、包依赖矩阵(import+package.json 双面)、EVENT_STATUS 单一定义——副本与越界依赖长不回来;③**core/state-machine.ts** 单一词汇(run/task/claim 状态枚举、RUN_TERMINAL、EVENT_STATUS 自 audit 下沉,audit 保留兼容 re-export),watch 不再依赖 audit;④watch.lock 改走锁管理器(60s stale 自愈——原裸 mkdir 是全仓唯一 V6 违例,kill -9 的 watcher 永锁 watch);⑤原子写补文件 fsync(docs/17 §5.1 只豁免目录);⑥migrate 逐 run 取写锁并发 `run_migrated`(a8 关);⑦memory update 取写锁并发 `memory_updated`(a7 关)。

- **整改 R4 语料库对账轮**(311/311):①`task list <RUN> [--status --owner --type]` 实装(docs/17 §1 四个 MVP 承诺中裁定实装的一个,其余三个在表中正式降级并注明覆盖面);②**四张机器对账常驻 CI**(D24 机制落地)——命令面↔docs/17 §1(COMMAND_SURFACE 双向包含+逐条真实可派发)、exit 码↔docs/17 §2.2、发出事件集↔docs/18 §2 活动目录(双向相等;verify_claimed/verify_released/worktree_pruned 收编,task_rework_started/review_requested 正式退役,path_approval 请求/拒绝半边标 P2)、依赖矩阵/单骨架/单 EVENT_STATUS(architecture.test.ts)——**下一次「特性只进 CHANGELOG」直接把 CI 打红**;③docs/17 §1 全表重写对齐实况、§2.2 重写(含 mode_mismatch/gateway_too_old);④docs/21 §4.1 按 migrate-on-read 改判重写;docs/11/20/00 修订注(八包实况、watch=read-model、audit 含 repair per D23、单骨架、events-last);⑤ADR-020…024 落 docs/04-decisions/;⑥current-state 刷新、traceability 补 ROAD/LW/REM 行。**整改 R0–R4 全部收官:P-1…P-4 四个验收命题成立,真机双旅程冒烟通过。**

- **整改 R2 观测与指引轮**(六项交付,302/302(+9);S6/S9/S11/S12/S13 消解——至此 2026-07-15 审查复现的 **13 个卡点场景全数关闭**,方案 P-2「指引活性」与 P-3「无死锁」对场景包成立):
  - **guidance 注册表**(S12):failEnvelope 的「万能 doctor」兜底退役——全部错误码各有其指引(rev_conflict→audit/repair、run_paused→resume、claim 族→task show/claim-next…),无条目宁可空列表不编造;(S9)claim-next 对终局 run 明说「run 已关闭,余活开新 run」,不再与 publish 互踢;(S13)worktree register 放宽接受「working 且无活树」——prune 后重建从断头路变成真路径(WT-ID 防撞、不重发 task_started),prune 指引同步指明 owner 重建/reclaim(--force)双路。
  - **needs_user 流水线扩容**(C1):新五类 awaiting_review/awaiting_verify/awaiting_rework/ready_to_integrate/ready_to_report(policy 与模式感知),单窗口最常见的「现在该干嘛」从此有答案;(B4)changes_requested + owner 心跳静默超 1×TTL → `stale_owner` 直给 `reclaim --force --agent=user`;(B6/S6)ready 任务依赖 cancelled 上游 → `deps_dead` 给重建路,task cancel 同时警告 orphaned_dependents;(S11)blocker 项的命令改为**可清除它的** answer 命令。
  - **agent 视图**(C2):`sigmarun agent list`(注册×活跃 claim×gate 租约联查,心跳龄+stale 判定)+ status 的 agents 汇总——「谁在干什么」首次有数据面。
  - **人面渲染**(C3):render() 按 data 形状出节段——msg list 显示**正文**、run show 出任务表、status 出 needs-you(带缩进命令)、agent list 出表、audit 出 findings 行;--json 逐字节不变。
  - **watch 逐轮心跳**(C4):循环模式每 tick 一行(HH:MM:SS+回收数+进度+needs 数;--json 为 NDJSON 信封),终局报出场;onTick 注入点保可测。
  - **起步资料**(A4):`init --example` 产可直接 import 的示例 payload(测试保证示例过自家 import);README 安装双轨+轻量 5 命令 quickstart 领跑;codex 侧补 publish/submit/integrate/runs/tasks/evidence 六 skill(6→12,Codex-only 团队可走完全程);adapter v0.4.0 的 /team-do 只认领 lightweight run(S3 连锁入口封死)。

- **整改 R1 裁决落地轮**(D21–D24 已批,docs/02-phases/remediation-design-2026-07-15.md §6)。八项交付各带回归锁,293/293(+14);状态机猎手复现的 S1–S13 中 R1 消解 S1/S2/S3/S4/S7/S8/S10 七个:
  - **RunMode + 模式墙**(S3):`core/mode.ts` 成为轻量/full 的唯一分叉点;轻量 run 上 submit/review/verify/integrate/合成一律 `mode_mismatch`(exit 7)并指路 `done`;full run 的 done 同码拒绝;`run list` 增 `lightweight`+`progress_pct`。
  - **轻量终局**(S8/D21):全任务终态后 `report` 自 active 收口(简化 report.md,事件带 mode:lightweight)→ reported → archive;最后一个 done 递上 report 命令;watch 自然退出。轻量宪法落 **docs/26**,INV-007 修订注入 docs/15 §9。
  - **audit 轻量档**(S10):AUD-011/016/017/019 对轻量 run 降 **info**(新 severity 档),健康轻量 run 审计零 error;其余 36 条不动。
  - **INV-008 实质贡献判据**(S1/D22):排除集=evidence 提交者(全 revision)∪当前持有者;纯接管未产出者可评审——接管不再毒化评审门;合成器在独立性滤空队列时如实报 `filtered_by_independence`;AUD-015 同判据;残余风险记档 docs/18。
  - **owner block 通道**(S2):`sigmarun block <RUN> <TASK> --agent --msg=MSG-ID`(working→blocked,须关联真实 blocker 消息,sweep 豁免=租约冻结);回收停靠(docs/10 §10 补全):未答复 blocker 的任务被 reclaim 后停靠 blocked 而非 ready(事件 payload.parked);unblock 无可复活 claim 时回 ready(接管场景不再造出无 claim 的 working)。
  - **reclaim --force**(S4):仅 `--agent=user` 可接管活租约(request-changes 给死者续满 TTL 的人质期由人解),事件 forced:true/forced_by_user;拒绝文案递上 override 路径。
  - **run reopen**(S7):`integrating → active`(spec 既有的 integration_reopened 补实现),集成中可补任务再重入。
  - **TxKernel 种子**(D-4/E1):`core/tx.ts` 的 `acquireRunWriteLock` 成为全部 11 个 run 写事务入口 + 2 个 project 写入口的必经门——`min_gateway_version` 写闸门(gateway_too_old,exit 8;读路径不拦)与 `lock_takeover` 账本事件(先夺后记,actor=system)由此一处兑现;存量事务体迁移按计划留 R3。
  - 宪法回写:docs/26 新增;docs/15 头部修订注(新转换五条)+ §9 INV-007/008 修订;docs/18 AUD-015 判据+轻量档+事件注;docs/13 决策台账补 D21–D24。

- **整改 R0 止血轮**（2026-07-15 全面审查 → 整改设计方案 v1.0 已批准,docs/02-phases/remediation-design-2026-07-15.md;D21–D24 四项产品裁决全按推荐项落账）。九项修复各带回归锁,279/279（+13）:
  - **P0**:`claim-next` 的 worktree 建议路径改从 `run.worktree_root` 派生（冒烟修复 L17 给根加了项目名段,建议路径没跟——每个新仓库 full 模式第一个任务在 `worktree register` 撞 `path_escape_detected`）。新增自洽元断言:网关自己的建议必须过网关自己的 register 校验。
  - **S5 首刷谎报**:`synthesizeReview` 先 sweep 后取任务快照（原先快照在前,自己刚释放的过期评审任务第一刷看不见,报"没有任务在等评审",按 RULES 停机的 agent 就此放弃）。
  - **AUD-019 严重度写反**:policy 合法跳过的评审现按 spec 报 warn（原先 `review.required !== false` 即 error——健康 run 审计满屏红）;task 强制评审被跳过、或 skip 事件与现行 policy 矛盾（伪造/篡改)仍 error。
  - **枚举笔误**:integrating 阶段队列过滤 `'verify'` → `'verification'`（原值不在 TASK_TYPES,验证型任务整个集成期不可领取）。
  - **真空 pass 封堵**:verify 五 gate 全 skipped + verdict=pass 现被机械拒绝（规则 4 对全 skip 真空成立,验证门在被迫绕行时形同虚设）。
  - **捎带续租兑现**（RULE 7 / docs/15 §8）:`msg post` 现对发送者的活跃 task/path/gate 租约续期——发 blocker 等人答复恰是没有心跳节奏的场景,此前规规矩矩提问反被 3×TTL 回收;租约变更补 `heartbeat` 事件（piggyback 标注）保 AUD-032 对账诚实;`--from=user` 永不续租（authorship 未验证,不得为他人 claim 造活性）。
  - **require_verification 实装**:此前该 policy 无任何消费方,设 false 照样要求 verify 记录才能集成（骗人的死配置);现 integrate start/record/report 三门按 `integrableStatuses` 放行 approved,默认行为逐字节不变（对照测试锁定）。
  - **CLI 体验组**:`--team-root` flag 接入解析（docs/16 §2 承诺的最高优先级覆盖,原先只有 env 生效）;`task cancel --reason` 落账（help 承诺、实现丢弃);裸 `sigmarun` 打印 help、子命令拼错回组内菜单;`--agent X` 空格写法给出指名 `=` 语法的诊断;events 时间线带日期（跨天 run 不再误读）。
  - **清理组**:writeProgress tmp 文件名加 pid（双窗口并发 status 的 rename 竞态）;candidateGuard 死默认 `['done']` 删除（与 D20 现行默认在同一签名里并存两套）;core 对 storage 的零消费 re-export 删除;init 不再创建无人读写的 `.team/templates/` 死目录。

- 轻量斜杠命令(用户反馈:人不该手写 plan.json / 敲 CLI,该在 Claude Code 里一句话)。adapter 模板 v0.3.0:`/team-plan <目标>` 重写为**轻量默认**——AI 把目标拆成 2–6 个独立块、自产 payload、`run import --lightweight`,用大白话回报(人看不到 plan.json/run 编号);新增 **`/team-do`**——找到最新 active run、领一块、在仓库里真干、`done` 标记完成(默认隐藏 RUN-ID)。Codex 侧对应 `team-run-plan`(轻量化)+ 新 `team-run-do` skill。完整质量流水线命令(dispatch/review/verify/integrate)原样保留,想要时用。测试 266/266。

- 轻量模式文案清理:`run import --lightweight` 不再报"no required_checks; verification will be unclear"(轻量无验证,该警告是噪音),成功信息改为"claimable now (lightweight)"并直接提示 `claim-next`(不再指向不存在的 publish 步骤)。

- **轻量模式**(用户反馈:核心用例被完整质量流水线埋住了)。`sigmarun run import <plan> --lightweight` 造一个轻量 run——任务立即可领(免 publish)、评审/验证/集成/worktree/证据全部默认关。极简闭环就 5 条命令:`init` → `run import --lightweight` → `claim-next --agent=<随便起名>`(首次即自动注册,不用 `agent register`)→ `done <RUN> <TASK> --agent=<id>`(claimed/working → done 直连,信任领取者,免证据)→ `status`。`done` 仅在轻量 run 生效(完整 run 仍走 report/accept),且只有 claim 持有者能标 done(反撞车延伸到完成)。质量流水线原样保留,想要时不加 `--lightweight` 即完整模式。真机验证:两个工具(codex-1/claude-2)各领一块、各自 done、进度 100%,无一句多余仪式。测试 266/266（+5）。

- 发布纪律 Phase 2：release 自动化 + npm provenance。`npm run release:prepare -- <patch|minor|major> [--dry-run]` 一条命令把版本在三处（root package.json / 全部 workspace 包 / `GATEWAY_VERSION`）同步 bump 并把 CHANGELOG 的 Unreleased 切成带日期的版本段(不 commit/tag/publish,打印后续命令)；`.github/workflows/release.yml` 在推 `vX.Y.Z` tag 时构建+测试+装配+**带 provenance 发布**到 npm(先 `next` dist-tag,验证后 `npm dist-tag add ... latest`;需 `NPM_TOKEN` secret;tag 与 package 版本不符即失败)。发布流程入 CONTRIBUTING.md。脚本 dry-run 预览 + 真跑同步三处已验证(未真实 bump,仍 0.1.0)。测试 261/261。

- 故障降级 Phase 2：backup 轮转 + `restore`,补上恢复闭环。repair/migrate 此前各写各的备份、只堆积、无回滚。现统一到一个备份仓（`.team/backups/<kind>-<stamp>/`,镜像 team-root 相对路径 + `backup.json` manifest,保留最近 20 个自动轮转,repair 与 migrate 都改用）+ 两个命令：`backup list`（列出恢复点:kind/时间/文件数/字节,newest first）、`restore <backup-id> [--dry-run]`（把备份文件覆盖回当前态回滚一次 repair/migrate）。**restore 本身可逆**：覆盖前先把当前态快照进一个 `restore-*` 备份,永远能再走回去。真机验证:repair 写备份→backup list→restore dry-run 全链通。测试 261/261（+8）。

- 发布纪律 Phase 2：schema 演进政策落地 + `sigmarun migrate` 命令（产品负责人裁决：**自动读时迁移**）。版本握手此前承诺前向兼容却无迁移路径——现建**迁移注册表**（`registerMigration(object, fromMajor, fn)`）：老 major 在 `readJsonState` 读时于**内存**升级(不在读路径写盘,lock-free audit 安全),盘上文件下次写时收敛;更新版 major 仍 `unsupported_schema_version` 拒读(不降级)。`sigmarun migrate [<RUN>] [--dry-run]` 显式把盘上老 major 重写为当前(先备份,rev 保留);今天全 v1⇒no-op,但机件已就绪、有测试,v2 schema 一落地即生效。政策文档入 CONTRIBUTING.md：新增字段=minor 不变版、破坏性变更 bump major 且必须同带迁移、CLI semver 与 schema major 独立。测试 256/256（+5）。

- 可观性 Phase 1 收官：全局 `--verbose` 步骤级追踪。事务失败时此前只剩最终信封,看不到 gateway 取了哪些锁、写了哪些文件、append 了哪些事件。`--verbose` 在变更 choke point（锁、原子写、事件 append）埋点,把轨迹写 **stderr**（绝不碰 stdout 信封——`--json` 单行契约不受影响）：`[sigmarun:lock] acquired …` / `[sigmarun:write] <path> rev N→N+1` / `[sigmarun:event] <name> seq N`。写序纪律（详情→索引→claims→派生→events 最后→释放锁）在轨迹里可见。低侵入:一处共享 `vlog` + 三个 choke point,全 gateway 获得追踪。测试 251/251（+2）。**Phase 1 四项全交付**（events / doctor --fix / worktree prune / --verbose）。

- 故障降级 Phase 1（收尾）：`worktree prune <RUN> [--dry-run]`。外部删除的 worktree（`git worktree remove` / `rm -rf` / 清空 scratch）会在注册表留下指向已不存在路径的活条目——`worktree list` 能看见却清不掉。prune 把这些死条目标记 `pruned`（`worktree list`/AUD-029 不再当活的算）+ 发 `worktree_pruned` 事件,并指出 worktree 消失后仍卡在 `working` 的任务(提示重建 worktree 或 reclaim);`--dry-run` 只报不改。测试 249/249（+3）。

- 故障降级 Phase 1：`doctor --fix` 引导式自愈。`doctor` 此前只诊断不治疗——用户看到 fail 得自己知道对应命令。现 `--fix` 对可安全自动修复的失败一键治愈并重检：未初始化→`init`、`.gitignore` 缺 `.team/`→追加(D4)、`.team` 被 git 跟踪→`git rm -r --cached`(文件留盘,AUD-030)、locks 目录缺失→创建；不可安全自动修的(node 版本、schema 损坏、memory 被 ignore)保持 fail 并给人工指引,绝不谎报已修。信封 `data.fixed` 列出实修项。测试 246/246（+4）。

- 可观性 Phase 1 首项：`sigmarun events <RUN>` 账本读取命令。`events.jsonl`（append-only、每事务的事实源）此前无一等读取器，排障只能 `cat` 原始 JSONL——现有对齐的时间线（seq · 时间 · 事件 · actor · 任务/claim），支持 `--task` / `--type` / `--since=<seq>`（增量 tail）/ `--limit`（默认 50，0=全部）过滤，`--json` 带完整 payload。复用 `readEventsSafe`：torn 尾行不崩、降级为 `ledger_torn_tail` warning + `corrupt_lines`（账本健康本身即信号）。只读、无锁、无事件。测试 242/242（+4 单元 +2 conformance）。

- backlog 清库（审查遗留低危项全修，各带回归锁，238/238）：①importRun 查重 TOCTOU——锁内复查 findDuplicateRun（并发同 payload 不再双建 run，Finding 3）；②sweepReviewClaims 崩溃窗——sweep 现也释放"孤儿"活 claim（task 已不在 reviewing 的 review claim / 不在 approved 的 verify claim），崩溃留下的 submitted+active 组合立即自愈而非等满 TTL（Finding 4）；③payload/task/review 文件读容忍 UTF-8 BOM（编辑器加的 BOM 不再报"非法 JSON"）；④adapter install 对无 template_version 标记的手改文件不再静默覆盖——跳过并 `unmanaged_template` 警告（保住本地编辑，--update 强制）；⑤memory promote 的文件 ref 限定 repo/run 内（`../../etc/passwd` 既污染出处又是存在性 oracle，现拒收）。

- 性能（并发审查 Finding 2）：`appendEvent` 的 `rev_after` 快照此前每个事件都全树遍历 + JSON.parse 每个 `.json`，批量事务（cancel/report/import 各附 O(N) 事件）成 O(N×树)——不仅慢，还会拉宽 run 锁的 stale 窗口（操作跑太久被误判接管，Finding 1 无需 OS 暂停即可触发）。引入 storage 侧 state-write 代次计数器，`appendEvent` 按 (runDir, 代次) 记忆化：事务内所有 state 写在事件 append 之前（17 §5.3 events-last），故一批事件只遍历一次。**关键正确性**：`collectStateRevs` 本体保持始终新鲜（AUD-032 等跨进程读当前态必须看见别进程的写）——记忆化仅限锁内的 appendEvent，其代次准确反映本进程写入。第一版曾把记忆化加到导出函数上致跨进程陈旧，被 NFR-001 真进程压测当场抓住并修正。30 任务 cancel（31 事件）0.07s、审计 CLEAN。测试 234/234。

- 文档国际化起步：两篇高频入口文档译成英文（`docs/en/00-user-guide.md` + `docs/en/17-cli-mcp-contract-and-error-model.md`），并行代理翻译后结构化校验通过——行数逐行对齐（358/358、304/304）、零残留中文、所有命令名/标识符/reason code/exit code 逐字节保留（17 号 55 个反引号代码 0 缺失、退出码表 0/2/…/8 原样、133 表行两侧一致）。README 增双语入口 + `docs/en/README.md` 索引（声明实现与测试为规范权威）。其余 01–16/18–25 暂中文。

- 安全跟进（审查 Finding 4，`--from=user` 伪造）：CLI 边界无法认证人类（键盘与 agent 的 shell 调同一二进制），故不删该能力而**如实标注**——user 消息记 `author_unverified: true`、post 时告警、`memory candidates` 透出该标记，让人类晋升进 git 记忆前看得见"网关未验证"；`memory candidates` 顺带改容错读（torn messages.jsonl 不再崩）。SECURITY.md 记入威胁模型。测试 232/232。

- 开源就绪审查轮（4 代理并行 bug 猎捕：并发/锁、状态机/重放、安全围栏、CLI 健壮性）+ 开源脚手架。**修复 12 项（全带回归锁，232/232）**：
  - CRITICAL 崩溃：`readJsonState` 的 JSON.parse 未包 try/catch——git 合并冲突的 `run.json` 让 ~11 命令抛原始堆栈（本产品前提就是跨分支共享 .team/）→ 转 GatewayError(io_error/exit8)+ statusRun 补 catch + bin.ts 兜底网。
  - CRITICAL 死锁：`review block → unblock` 永久卡死任务——block 后 owner claim 停在 submitted，unblock 只翻状态不复活 claim → submit/resume/release/reclaim 全失败仅 cancel 可逃，repair 也救不了（缺陷在 claim 面）→ unblock 复活 owner claim 到 active + 新租约（docs/15 line 199+223）。
  - HIGH 安全：`submit` 把 agent 自报 `cmd_id` 直接拼 `outputs/<cmd_id>.log` 写入——正规 API 的任意 .log 写原语 → 限定裸标识符。
  - HIGH 并发：run 锁无 ownership token——stale 接管与 release 都无条件 rmSync，慢 holder 恢复后删掉接管者的锁致双持有（已确定性复现）→ token 化 release（只删自己）+ rename 化独占接管。
  - HIGH 崩溃：torn `messages.jsonl` 崩 status/watch/msg list/hydrate（不像 events.jsonl 有容错读）→ 两处 readMessages 逐行容错。
  - MEDIUM 安全：redaction 漏 AWS_SECRET_ACCESS_KEY / DSA 私钥 / 纯密码 URL（export 以此为阻断保证）→ 补模式；`export` 的 review_id 从盘上读入拼写路径可穿越 → dest 限定 target 内；memory-promote 用裸 startsWith 前缀判定（兄弟目录绕过）→ 换共享 insideRoot 围栏；`unblock` 无身份检查任何 agent 可解锁 → 限 owner-or-user。
  - MEDIUM 假阳性：AUD-035 重算含全部行、computeProgress 剔除 cancelled → 任何含 cancelled 的 run 永久告警 → AUD-035 同步剔除。
  - MEDIUM 崩溃：`adapter install` 未防 EISDIR → 包 try/catch。
  - CLI 面：`--version`/`-v`/`version`（公共 CLI 必备，此前不响应）；`migrate` 悬空引用（命令不存在）→ 改措辞。
- **开源脚手架**：LICENSE(MIT)、CONTRIBUTING/SECURITY/CODE_OF_CONDUCT、issue/PR 模板、.editorconfig、英文 README(GitHub 门面)、package.json 全量元数据（repository/bugs/homepage/author/keywords/license，仓库 URL 待填 OWNER）；发布物随包携带 LICENSE。

- 桌面版真实代理轮（RUN-0002 jsonlkit，全局 `npm i -g` 形态 B）：北极星旅程首次由**真实桌面 Claude Code 会话**驱动——desktop-A 原生跑 `/team-dispatch` 领取并实现 normalize（复用 parse+stringify，16 真测试一次过），Codex 真进程交叉评审 approve，desktop-V 原生跑 `/team-verify` 独立重跑 6 检查并提交验证，集成 100% done、终审计 40 规则 0 findings 0 skipped。三项契约首次真机验证：**L13 verify 租约实锤**（`verify_claimed` 事件真机出现、`CLAIM-verify-*` 完整生命周期）、**docs/16 §2 git-common-dir 解析**（桌面会话在 fresh worktree 中经共享 .team/ 协作）、**L21 版本感知升级**（真机 12+5 模板滚 0.2.0）。新缺陷 L22（Codex 评审误试顶层 `sigmarun register`）→ codex review skill 补全 `agent register` 命令签名，模板 v0.2.1。测试 226/226。

- adapter 模板版本感知升级（冒烟 L21）：`adapter install` 原先"文件存在即跳过"，0.1.0 模板永远升不到新版（违反 22 §4.3 模板版本化）——现比对 `template_version` 标记，异版本自动改写并报 `updated` 清单，同版本跳过，`--update` 保留为强制改写；信封文案改为 new/updated/up-to-date 三段计数。真机验证：12 个 Claude 模板 + 5 个 Codex skills 一次滚到 v0.2.0。测试 226/226。

- 真实代理冒烟测试轮（两项目 × claude/codex 真进程分发，senior-tester 监控全流程）：北极星以真跨厂牌代理达成——Claude 规划一次成型、Codex/Claude 并行认领互不越界、交叉评审带对抗探针、独立验证真重跑、集成 100%、main 零污染；真代理带回 20 项台账。**修复 9 项（全带回归锁，225/225）**：①verify 合成落租约（CLAIM-verify-*/verify_claimed/verify_released，双真代理独立命中 15 §7 违约——合成无 claim 无互斥）；②heartbeat 覆盖 review/verify gate 租约（RULE 7 此前对评审/验证者不可满足，双厂牌各命中一次）；③worktree 默认根加项目名段（两项目同父目录 RUN-0001 撞路径，Codex 真机撞上）；④changed_files 形状校验入 evidence_invalid 清单（原样误报 path_escape 逼真代理读源码自救）；⑤`msg post --from=user`（人类回 blocker 不再借代理身份）；⑥AUD-026 豁免 handoff 镜像（健康 run 必噪）；⑦AUD-032 豁免 counters.json（INV-011 无事件写手误报）；⑧`--help`/`help` 命令面；⑨AUD-020 按 kind 分组。模板 v0.2.0：submit 四参与五坑清单、heartbeat 全签名、codex 补 team-run-verify skill、AGENTS 段补 headless 前置（claude 登录/codex 沙箱禁 .git 写需 bypass/stdin 闭合）；review claim checklist 自含。两冒烟项目终审计 40 规则全零。

- **D20**：`deps_satisfied_when` 默认档改为 `["verified","integrated","done"]`（产品负责人裁决，2026-07-11）——原 `["done"]` 与"done 仅在 report 验收产生"（15 §3.3）组合使 run 内依赖链默认不可行进（功能测试轮 F4 真机取证）；上游过独立验证即解锁下游，配合 16 §3.6 上游支合并模式；要更严由 planner 显式收紧。docs/10 §6 + docs/13 D20 + 回归锁；tarball 真机复验通过。测试 218/218。

- 全面功能测试轮（发包前，10 批次真机场景，被测物=打包 tarball 经 `npm i -g`）：错误面/BR-001 守卫矩阵/租约-回收-认养链/返工环+INV-008/integrate 失败回退/生命周期级联/context+L4 记忆/watch+export 脱敏中止/审计-篡改-repair 闭环/adapter 幂等全部真机通过。**修复 5 项**：①claim 守卫码 5 枚落兜底 exit 1 → 统一入冲突类 exit 6（17 §2.2 行 6 回填，合同破坏修复）；②**版本握手实现**（17 §11/21 §7）——readJsonState 单点拒读未知 schema major（exit 8）；③verify pass 收编 task claim（AUD-009 行 5：verified 即 claim 终态，健康 run 中途审计不再误报）+ 返工复活集双点扩 completed；④import 未知字段警告（unknown_run_field/unknown_policy_key）；⑤usage 清理。测试 217/217。悬置产品裁决：deps_satisfied_when 默认 `['done']` 使 run 内依赖链不可行进。

- 发布装配（形态 B 前置，22 §4.1 单包裁决落地）：`npm run release` = 构建 + esbuild 把 8 个 workspace 包 bundle 成单包 `sigmarun`（单 bin，zod/minimatch 保持外部依赖，模板内联随包）；npm 面 README；tarball 冒烟通过（全新 repo 安装 → init/doctor 10 项 → import→publish→claim→status(§9 5%)→audit 40 规则→adapter install 13 模板）。实际 `npm publish` 待账号登录与 license 裁决。

- 真机 dogfood（双代理全旅程）+ finding #3 修复：`report` 即 run 验收——integrated 任务批量翻 `done` 并逐个记 `task_done` 事件（15 §3.3 最后一条未实现边闭合，写序 详情→索引→事件）；progress 落实 docs/03 §9 分数全表（claimed 0.05…integrated 0.95，blocked 经账本回溯保持前值，cancelled 剔除分母）——修复"两任务已合并仍显 0%"；replay 表补 `task_done`。dogfood 另两枚 findings：副作用命令勿过管 `head`（SIGPIPE 半途杀 git）；下游依赖未集成上游的分支策略（16 §3.6 新注 + 项目记忆 MEM-0001）。测试 214/214。

- P1 面收官：`run pause/resume/cancel/archive`（15 §2.3 全转换，cancel 级联 claim/task + BDD-007-09，reported 只可 archive）、`task add`（草稿落位 + 图节点/blocks 边 + 依赖校验）与 `task cancel`（级联三类 claim）、`worktree list`、`graph show`（节点带派生状态）；**审计目录 40/40 全在线**——AUD-023…028（上下文/handoff 对账批）+ AUD-034（账本重放引擎，与 repair 共用 foldLedger 单一事实源，补齐 review_blocked/task_cancelled 映射）；review block 决定同步镜像 blocker 消息（AUD-024 一致性）；AUD-026 收敛为仅对含条目的记忆文件要求出处（import 骨架不再误报）。测试 213/213。

- 收尾轮批 2：SCA 归零（根因=镜像源缺 audit 端点，官方源补跑并修 glob 传递依赖）；review `block` 决定 + `unblock` 原语（15 §3.3 blocked 双边，事件 #34/#15）；task 级 `review.required` 覆盖 run 级 false（15 §9 更严格者胜，import 保留字段缺省语义）；integrate 终结 task claim（AUD-009 真机命中即修）；AUD-032 对升级前遗留账本降 warn；adapter 补齐至 12 命令模板 + 4 Codex skills；conformance suite（25 命令面单信封断言，M38）+ NFR-001 真进程并发压测（8 路 claim 唯一分派 + seq 无缝）；CI 三平台×双 Node 矩阵工作流；reviewDecide/grantReviewClaim 写序对齐 17 §5.3；audit evidence 缓存与 synthesizeReview 单遍预建；docs/04 §1.1 命令面实现对齐注记回填。测试 205/205。

- 审查修复轮：全量 8 角度审查（43 候选 → 16 验证 → 14 成立）后修复 14 项——publish 锁路径统一（互斥恢复）、repair 重放表补 verified/integrated（修复工具不再损坏健康 run）、review sweep 半提交、verify 独立性守卫（作者不可自验）、applyReclaim 提交点次序、failures_mapped 守卫、定向领取并行上限、memory promote 双锁与路径逃逸、events.jsonl 容错读取（readEventsSafe）、watch NaN 挂起、run show 策略字段、integrate 租约策略化、verify 输出截断；storage 新增 tryAcquireLock/runLockPath 收敛 11 处锁样板。测试 192/192（+12 回归锁）。详见 docs/02-phases/code-review-2026-07-11.md。

- FEAT-011 project memory promote（L4，**P4 特性全集收官**）：`memory promote`（refs 必填可解析（INV-012 项目级）、secret 拒收、MEM 项目级编号、出处戳、--supersedes 移入 Superseded 区留痕、memory_promoted/superseded 事件、三层出库防线）、`memory candidates`（只列不选）；audit 补 AUD-036…040；status 超限风险；doctor 补 project_memory_committable。测试 180/180，覆盖 89.4%/73.2%。（Refs: FEAT-011）

- FEAT-010 verify + integrate + export（**MVP 主链闭合**）：`verify submit`（14 §4 结构校验、task/run 双目标、失败映射返工）、`claim-next --role=verifier` 合成、`integrate start/record`（拓扑序下发、gateway 不碰 git、--failed 单点回退不卡全局、path claim hold 终点释放）、`report`（integration.md+report.md、run→reported、不合 main）、`export`（阻断式脱敏归档，`export_redaction_hit` 即中止零写入）；依赖门策略位 `deps_satisfied_when`（10 §6 放宽档）。测试 172/172，覆盖 89.7%/73.5%。（Refs: FEAT-010）

- FEAT-009 review gate：`review claim/approve/request-changes` + `resume`（14 §3 全节：INV-008 自批双点拦截（含 previous_attempts 历任 owner）、D15 `claim-next --role=reviewer` 合成 review_work、20 分钟评审租约 + 惰性回收、must_fix 镜像 message pool 回链、owner claim 原地复活返工环、REVIEW 每轮新文件、require_review=false 的 skipped_by_policy 最小记录）；adapter 补 /team-review、/team-status。测试 159/159，覆盖 90.7%/75.3%。（Refs: FEAT-009）

- FEAT-008 status/watch/audit/repair：新包 `@sigmarun/watch`（`status`——权重 progress/风险/M32 Needs-user 带命令、`run list`/`task show`/`evidence show`、`watch`——单实例锁/tick=sweep+快照/终态退出）与 `@sigmarun/audit`（`audit run`——14 条规则 + 26 条登记跳过、exit 0、findings=data、无锁快照；`repair`——账本前滚/执行前备份/state_repaired/幂等）。修复 FEAT-004 sweep 半提交隐患（sweepRun 提取 + 即时持久化）。登记实现债：写事务事件 rev_after（AUD-032）。测试 149/149，覆盖 90.8%/75.1%。（Refs: FEAT-008）

- FEAT-007 evidence 门禁 submit：`sigmarun submit`（14 §2.3 九步事务：校验先行零残留、in_scope minimatch 重算（不信自报）、D8 输出截断+脱敏 `[REDACTED:kind]`、handoff 代写、revision/history 返工承载、D6 review_skipped）；storage 脱敏升级为替换管道。修复 FEAT-004 潜伏缺陷：run 级策略字段 `default_policy` 此前被错读为 `policy`（覆盖静默失效）。测试 131/131，覆盖 92.3%/78.0%。（Refs: FEAT-007）

- FEAT-006 dispatch 端到端：`worktree register/adopt`（claimed→working、回收保留-认养链 16 §3.5、base_commit 机械采集）、`run show`（dispatch 第 1 步）、新包 `@sigmarun/adapters` + `adapter install --tool=claude-code|codex`（/team-plan、/team-dispatch、/team-publish 模板 + Codex skill + AGENTS.md 标记对幂等注入；RULES 十诫逐字、--as/--task/--role/--loop、D5 单任务停机）。测试 117/117，覆盖 92.7%/79.7%。（Refs: FEAT-006）

- FEAT-005 Context Plane：新包 `@sigmarun/context`——`msg post/list`（12 §6 消息池，INV-011 不进 events，`--open` 派生开放问题）、`context hydrate`（must_read 组包：brief→run-memory→L4 项目记忆（D19）→上游 handoff/evidence；context_hydrated 事件为 AUD-028 留锚）、`graph validate`（AUD-021/022 防篡改复检）、`memory update`（secret 拒收、无出处警告）。测试 103/103，覆盖 92.6%/79.5%。（Refs: FEAT-005）

- FEAT-004 claim-next + 锁 + 回收：新包 `@sigmarun/dispatch`——`agent register`（D17 label 幂等）、`claim-next`（BR-001 九守卫 + 10 §7 排序 + 定向/--dry-run + worktree 建议）、`heartbeat`/`release`/`reclaim`（BR-004 三阶回收，previous_attempts 永不清零）、`approve-paths`（AUD-004）、3×TTL 惰性 sweep（blocked 豁免）。错误码 +12（含回填 17 §3 的 claim_not_found/not_claim_owner）。测试 85/85，覆盖 93.2%/80.2%。（Refs: FEAT-004）

- FEAT-003 publish：`sigmarun task publish`（draft→ready 双写、planned→active 激活、幂等跳过、D18 跨 run 重叠 warn/block + `--force`、`cross_run_overlap_detected` 事件）。测试 60/60，覆盖 93.5%/80.5%。（Refs: FEAT-003）

- FEAT-002 plan 导入：`sigmarun run import`（payload 校验必拒表 + 警告、AUD-021 环检测 inline、D17 指纹防重 `duplicate_payload`、project.lock 短事务、events 提交点写序）；storage 新增 mkdir 锁与 secret 模式集。测试 52/52，覆盖 93.8%/80.8%。（Refs: FEAT-002）

- FEAT-001 `.team` 基座：`sigmarun init`（幂等初始化 + D4 gitignore）与 `sigmarun doctor`（九项自检，fail 自带修复指引）；storage 基元（team-root 解析、原子写 + rev 乐观锁、未知字段 round-trip）；统一 envelope（17 §2，英文）。测试 25/25，覆盖 91%/73%。（Refs: FEAT-001）

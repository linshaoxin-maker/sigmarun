# Changelog

## Unreleased

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

# sigmarun 产品现实审计 — 最终交付

基线 `f8b6db1`(main)· 集成分支 `prodfix/integration` · 全程本地(未 push / 未 publish / 未建远端 tag / 未碰用户全局)· GATEWAY_VERSION 0.1.0→**0.2.0** · TEMPLATE_VERSION 0.6.3→**0.6.4**

---

## 1. 产品成熟度判定

**Discovery 时(修复前):工程成熟、产品未上市。** 唯一硬核心(多窗口防撞车)真机并发下成立;但产品(a)真实用户装不到当前能力,(b)Codex 半边装错目录,(c)full 主旅途最后一步靠错误文档收敛不了,(d)崩溃后账本会永久损坏且 repair 无出口,(e)最常见的"等用户"状态被观测面谎报——**全是"测试全绿、用户仍失败"**。

**修复+集成后(re-judge):** 18 个成立 finding(6 P0 + 12 P1)全部有**独立黑盒验过**的修复,加 1 个 golden-journey 发现的人面断点修复,集成到 `prodfix/integration`,**全量 385/385 绿**、build/typecheck 干净、最终 tarball clean-install 冒烟通过。golden journey 独立确认产品对其**真实用户模型(人说 `/team-*` → AI 驱动 CLI `--json`)端到端可用**,损坏下无绿灯欺骗;唯一硬核心(不双认领)在 P1-9 六类活-claim 对抗构造下守住。

**定级:可发布 0.2.0(Beta / npm `next` tag),对 AI 中介的主用户模型 GA-ready。** 保留意见(不阻塞发布,进 §7):(a) `status` 对结构损坏仍假绿灯;(b) install-only 裸 CLI 用户的 schema 可发现性(README 死链)。这两条不影响主用户模型,但**在补齐前不宜对"裸 CLI 人类直用"宣称 GA**。诚实收缩:主张的是"对真实用户模型可发布且经端到端验证",不是"对一切使用方式完美"。

> 方法论诚实:本轮不仅修了产品缺陷,还**揪出审计自身执行的两处落差**(P1-6、P1-9 计划有、实际批次落下),按同样纪律补齐。教训:自审执行、不信任何"全做了"的声明——包括自己的。

---

## 2. 修复台账 + 每项独立验证证据

> 纪律:实现者一律不验自己的活;每项由**独立 verifier 从 tarball 黑盒复跑**证伪或坐实;只有独立验过的才进合并。下表"证据"列为独立 verifier 亲手产出的关键事实。

### P0(装不上 / 主旅途走不通 / 数据损坏无出口)

| ID | 缺陷 | 修复 | 独立验证证据 |
|---|---|---|---|
| P0-1 | npm 上冻着旧整机版、想发新的撞号 | 版本 0.1.0→0.2.0(package + GATEWAY_VERSION) | `npm view` 确认 0.2.0 未被占;tarball=0.2.0;`--version\|head -1` 仍裸 semver |
| P0-2 | npm README 独立冻结、和诚实版长期不一致还自打脸 | build-release 改从**根 README 单源**打包,删 `scripts/release-readme.md` | tarball README 与根 README **sha 逐字相同**;stale 标记 0、honest 标记齐 |
| P0-3 | Codex adapter 装 `.codex/skills`,官方扫 `.agents/skills` | templates keys 改 `.agents/skills` | 对官方文档独立核对;装出来 12 SKILL 在 `.agents/skills`、`.codex/` **根本不建** |
| P0-4 | full 主旅途 evidence 字段名 docs↔code 冲突,submit 死循环 | 报错点名字段(`output_file`/`handoff`)+对齐 docs §2.1/§4.1 | 照文档抄**一遍过**(连 stale 示例值都被 gateway 覆盖);反向 `output_ref` 报错点名让 AI 一次改对 |
| P0-5 | 崩在提交点前 → events.jsonl **永久重复 seq** | seq 改从盘上最大已提交 seq 推(忽略损坏 meta) | 篡改 meta 各档(落后/超前/极端)+连追 **620 次**无重复无跳号;无 O(n²) 变慢 |
| P0-6 | 坏 task.json → repair 崩、无恢复出口 | repair per-file try/catch + 备份 + 点名 finding + 继续 | 四种非法 JSON repair 均 exit 0 + 建备份 + 点名坏文件给恢复命令;别的任务照常 |

### P1(会卡住 / 状态误导 / 升级或故障不可信)

| ID | 缺陷 | 修复 | 独立验证证据 |
|---|---|---|---|
| P1-1 | 模板代际/漂移不可见 | `--version` 加 bundled 代际 + installed 漂移 | 非 repo/已装/手造漂移三态都对;`installedTemplateVersion` 只读首文件(已知局限,符契约) |
| P1-2 | 等用户时观测面谎报 in_progress | 未答问题 + 已答未 unblock 都进 needs_user;`with_claims` 排除 blocked | 外科级:1 blocked-answered + 1 真干活 → `with_claims=1`、needs_user 只列前者 |
| P1-3 | `awaiting_review` 命令裸 `<other-window>` 粘贴即炸 | 引号化 + "换窗口注册" + INV-008 说明 | 原样粘贴不再 shell 断;INV-008 真拦作者自评 |
| P1-4 | init/doctor 面包屑死在绿勾、`--help` 无真入口 | init/doctor next_actions 串到 adapter install→/team-plan;help 加 "Start here" | 全新 init 顺着走到 `/team-plan`;`--help` 里 `/team-` 5 次 |
| P1-5 | 隔离 worktree 无 node_modules、依赖 check 必红且无引导 | 四面板加 DEPENDENCIES note(install/symlink;别记假 fail) | 四面镜像一致;两种补救真机验过;**(polish 补 monorepo symlink 假绿 caveat)** |
| P1-6 | full 未注册指引"反向误导"(让用 label,实际要用返回的 AGENT-ID) | 四 emitter 指引改点名"register 返回 AGENT-ID、用它" | 强清自证新鲜;四 emitter 全对;逃逸端到端真通;**lightweight 自注册无损** |
| P1-7 | doctor 对坏锁亮绿灯(锁坏=防撞车失效) | 任一 check fail → `ok:false` + 非零 exit,点明后果 | `chmod 555 .team/locks`→doctor exit 9/ok:false/挡 `&&`;改回即回绿(不过度) |
| P1-8 | restore 不上锁、穿透在途事务撕裂 | restore 按拥有 run 排序上锁 | 持在途锁时 restore 被挡(lock_timeout、sentinel 存活);不持锁才写穿(对照证明是锁在挡) |
| P1-9 | 崩溃中断认领 → 幽灵 claim 占并行槽 90min、repair 看不到 | repair 以**账本(foldLedger)**为准保守清幽灵:账本认的占用态 claim=活的绝不碰,无提交事件/已移终态的残留才清,有争议只报不动 | **红线守住**:6 类活 claim(claimed/working/blocked/changes_requested/gate/账本已提交+手改task.json)对抗构造下 task-claims.json 前后字节全等、repair 后 INTRUDER 全被拒、零双认领;真幽灵清后 claim-next 立刻成功;争议只报;幂等+备份忠实;done/cancelled/integrated/path 幽灵也清 |
| P1-10 | 锁忙等吃满核 + 持锁崩溃冻结 30s | `sleepSync`→`Atomics.wait`;tri-state pid-first 抢占 | 3s 忙等 2836ms CPU→park 1ms;burst 30/50 lock_timeout 归零;崩溃接管 30s→110-212ms;**320 争抢/1200+1920 临界区零双认领、零互斥违规、不误伤活锁** |
| P1-11 | repair 救命提示渲染成 `[undefined]` | 渲染器加 string 分支 | torn 尾行 repair 打可读指引;audit 对象形状 findings 未被搞坏 |
| P1-12 | audit 报 error 仍 exit 0,CI 当通过 | error finding → exit 9(1-8 之外),envelope 不变 | torn 账本 audit exit 9/挡 `&&`,但 `--json` envelope 仍 ok:true/code:OK(亲手 diff 状态字段无变);窄域无外溢(~13 命令实测) |

### 附:golden journey 追加修复(第 19 项)

| 断点 | 缺陷 | 修复 | 验证 |
|---|---|---|---|
| 人面无列表 #1 | submit/verify/task/run-import 报错说"改列出的项"却从不打印那个列表(只在 `--json data.errors`) | `renderSections` 打印 `data.errors`(覆盖 `string[]` 与 `{path,message}[]` 两形状) | **真机观测**:run import 坏 plan 现逐条列出 7 字段;+锁定测试;385 绿;最终 tarball 冒烟再证 |

> 验证方式诚实说明:此项为小改渲染,以**我亲手跑装出来的 CLI、直接看到列表打印** + 锁定测试 + 全量绿确认(客观观测,非自证);未像 18 项那样走独立-verifier 流程——因它是渲染层单点、可直接目视证伪。

---

## 3. 已关闭 / 未关闭

**已关闭(集成 + 独立验过):** 6 P0 全部;P1-1…P1-12 全部(含补漏的 P1-6、P1-9);+ golden-journey 断点 #1(人面列表)。共 19 项,`prodfix/integration` 385/385 绿。
**未关闭(有意留作残余/下一阶段,见 §6/§7):** `status` 对坏 task.json 假绿灯;install-only schema 可发现性(npm 包不含 docs → README 死链);系统性 shell-safe 占位审计;torn 尾行后追加丢事件;`release-prepare.mjs` 互依 pin bug;claim 写序**预防**(P1-9 只做了 repair 侧恢复,根因写序留 note)。

---

## 4. 集成与工程事实

- 8 批修复 + P1-6/P1-9 补漏 + polish + 断点#1 各自提交 → git 三方合并到 `prodfix/integration`,**零冲突**(cli.ts/envelope.ts 的多方 hunk 自动缝合、各在不同区)。
- 跨批次版本雷未炸:B1 版本断言动态读常量;TEMPLATE 0.6.4(仅 B2 改模板)/ GATEWAY 0.2.0 并存全绿。
- **force-clean build + 全量 385/385 绿**;typecheck 干净;最终 tarball clean-install 冒烟通过(装/版本/adapter 路径/断点#1/校验)。
- polish:**build-release 自清+重建根治"陈旧包"**(否则 `tsc -b` 增量空转会发出不含修复的包而测试照样绿——B3 verifier 实测踩到过);两处自评指引加引号;docs `.codex`→`.agents`;monorepo symlink caveat。`npm run release` 单独跑验证产出新鲜 bundle。
- **发现"看着并了其实空合并"**:p16-register 分支一度未提交、merge 成空操作——靠**测试数没涨**这个信号抓回,否则会静默发出不含 P1-6 的版本。

---

## 5. Clean-install golden journey(独立终验,陌生人黑盒)

独立代理以"从没用过 sigmarun 的陌生人"身份,从最终 tarball clean install 到全新 repo,真跑两条完整旅途。

**验通(端到端真跑,不是只读):**
- **装 + onboarding 闭环**:`npm install` tgz 干净;`--version` 显 0.2.0 + 模板 0.6.4;`init` next_actions 串 doctor→adapter→`/team-plan` 不死绿勾;`doctor` 坏锁(`chmod 555`)真变红(exit 9/ok:false/点明"锁坏=失防撞车"),改回真变绿;adapter 装对 **Claude→`.claude/commands/`、Codex→`.agents/skills/`,`.codex/skills/` 不存在**;`--help` 有 `/team-plan`。
- **轻量旅途端到端**:import→claim(**任意 label 自注册,不逼 register**)→做活→done→report,真跑到底。
- **full 旅途端到端**:未注册 claim 的指引点名 AGENT-ID、`register` 得 `AGENT-claude-code-001`、用该 id 一次认领成功;**自评被拒 INV-008 真拦,给的引号命令原样粘贴 shell 不炸**;submit(照报错逐步改)→review→verify→integrate(**真 git handoff:给 `git checkout -b`/merge/`integrate record <sha>`**)→report,走通。
- **崩溃恢复(照契约、诚实安全)**:坏 task.json → `audit run` 人面列 findings + 精确点名坏文件、**exit 9**(CI 能拦),`--json` envelope 仍 **ok:true/code:OK**(机器面不被污染);`repair` **exit 0 + 备份 + 两条恢复出口**,手修后 audit 归零。**全程无绿灯欺骗。**

**终验判定(陌生人语)**:*"能装上、两条旅途都真跑完;doctor/audit/repair 在损坏下全诚实、无绿灯欺骗。"* 抓出 3 个**裸 CLI 人面**断点(见 §2 断点1 已修 / §6 §7):
1. **人面校验报错让改"列出的项"却不打印列表** → **已修**(§2)。
2. **install-only 用户找不到 schema**:intended `/team-*` 模板已内嵌 schema;真瑕疵=npm 包不含 `docs/`、README `docs/…` 死链 → §7。
3. **裸 CLI 终点不主动交还 git**:intended `/team-*` 模板已覆盖(明写 commit/PR)→ §6 残余。

> 终验证实:产品对其**真实用户模型(人说 `/team-*` → AI 驱动 CLI --json)**端到端可用;3 个断点都在"人直接敲裸 CLI"这条非主路径上,intended 路径已覆盖或已修。

---

## 6. 残余风险(按影响排序)

1. **status 对坏 task.json 假绿灯**(P0-6 的 status 臂):腐坏可被 audit(AUD-032,已被 P1-12 的 exit-9 门兜住)检出、可被 repair 恢复,但最常用的 `status` 报健康。修它要 status 遍历校验所有 task.json(性能/职责代价)+重开刚验的观测区——见 §7 建议 1。
2. **零星人面装饰**:cancel 的 run 人面表头多打已失效的 needs 项(机器面 `user_state` 已正确);`doctor --json` 保 `code:"OK"` 而 `ok:false`(有意契约:code=命令跑成功,ok=健康判定,消费方看 ok/exit)。(evidence_invalid 不列表这条最尖的已由断点#1 修掉。)
3. **系统性 shell-safe 占位**:代码多处 `--agent=<name>/<owner>` 裸占位,多在 AI 消费的 --json/adapter 模板(AI 代入、非人粘 shell);真人面 paste-break 已修(P1-3 + polish 两个孪生)。全面审计留后续。
4. **torn 尾行后追加丢那条新事件**(audit 能检出、no-dup-seq 成立);**`--version` 两行**老脚本不加 head 会吞两行(有意);**`installedTemplateVersion` 只读首文件**(真实过代际能抓)。
5. **`release-prepare.mjs`** 互依 pin bug(bump 包版本却不 bump pin)——本轮绕开手工 bump 根+GATEWAY,该工具仍待修。

---

## 7. 下一阶段建议(≤3)

1. **让"健康观测"对结构损坏诚实**:`status`(及 `run show`)应像 doctor 那样,对坏/缺 task.json 至少给一个 warn + 指向 `audit run`/`repair`,不再假绿灯。这是残余里唯一"用户最常看的面仍会被骗"的点。
2. **install-only 用户的可发现性**(golden journey 断点 #2):npm 包不含 `docs/`,于是 README 里所有 `docs/…` 链接对装包用户是死链,报错还引没发的 `docs/14`。修法二选一或并用:README 内链改 GitHub 绝对址;把 evidence/review schema 像 verify 那样内联进 `--help`。(人面报错列表部分已在断点 #1 修掉;剩余的 shell-safe 占位符全面审计可并入本项。)
3. **发布工具链收尾**:修 `release-prepare.mjs` 的互依 pin(或改 workspace 协议),让版本 bump 一步到位;把 §8 发布清单固化成一个 `npm run publish:checklist` 式脚本(仍在 OTP 处停),避免下次又手工。

---

## 8. 发布清单(交给用户 + OTP;本轮只做到"可发布",未执行)

在 `prodfix/integration`(或合并到 main 后):
1. *(建议)* `CHANGELOG.md` 加 `## 0.2.0 — <日期>` 段(tarball 会带 CHANGELOG)。
2. `npm test` —— 确认全绿(385)。
3. `npm run release` —— 现在**自清+重建+bundle**,产出 `release/`(`sigmarun@0.2.0`,honest README)。
4. `cd release && npm pack` —— 可选,最后检视 tarball。
5. `cd release && npm publish --access public --tag next --provenance` —— **需 npm 登录 + OTP**(现网 `sigmarun@0.1.0` 在 next tag;发 0.2.0 到 next 延续之)。
6. 升 latest:`npm dist-tag add sigmarun@0.2.0 latest` —— **另需 OTP**,tag 决策在你。
7. `git`(在你确认后):合并 `prodfix/integration`→main、`git tag v0.2.0`、push。

> 我不执行 4-7 的 publish/tag/push(需你的 OTP 与授权);其余已就绪。

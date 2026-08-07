# 34. Plan Recipes 规格 v2(从 ai-dev-methodology 逐条推导;字段级)

> 日期:2026-07-25 · v2(v1 作废:v1 凭直觉自创骨架;v2 每条配方都注明**来源**——mode-router 的必交工件表、最小追溯链、P4 切片纪律、工件模板字段)
> 来源文件:`~/.claude/skills/ai-dev-methodology/references/{mode-router, phase-4-estimation-and-priority, quality-checklists}.md` + `templates/{impact-analysis.md, bdd-scenario.feature}`
> 分工铁律不变:**配方=skill 层教 AI 拆**(第一刀,gateway 零改);第二刀(mode 策略默认+audit)见 §7。
> **阀值决策(2026-07-25,产品负责人)**:第一刀照方法论原文取硬度——风险分 **≥31 强制 full+verify**;单任务 **8 点必再切、21 点先 spike**。跑数个真实 run 后按方法论自己的校准法(历史数据回顾)复核这两个阀值;校准数据源=账本(weight vs 实际返工轮次/租约超时/path 冲突率)。

---

## 1. templates.ts 改动清单(同 v1 的五处,内容换成 v2)

①新增共享块 `PLAN_RECIPES`(= §2 路由算法 + §3 映射表 + §4 各配方压缩版);②`TEAM_PLAN` 插步骤 0 ROUTE + 注入 + JSON 骨架 mode 改路由结果 + PAUSE 头显示"模式/风险分/最小追溯链";③`CODEX_PLAN_SKILL` 镜像;④`TEMPLATE_VERSION` bump;⑤field-protocol 对账加关键词:`ROUTE`、`impact-analysis`、`rollback note`、`timebox`、`safety net`、`decision-memo`、`Given/When/Then`。

---

## 2. ROUTE(照抄 mode-router 的选择算法,不是词面匹配)

1. **分类**请求:new idea / feature / bug / refactor / docs / spike / hotfix。
2. **查风险**:user-visible 行为?公共 API?数据/schema?安全合规?架构?回滚难度?
3. **选最小模式**——"能验证这次变更的最小工件集"。
4. **记录模式**:`plan.summary` 开头写 `[Mode decision]` 块(模式/跳过项/理由/残余风险——mode-router 的显式跳过格式原文);拆分确认 PAUSE 头部同显。
5. **升级触发**(工作中出现即升模式并说明):新公共 API/schema/持久态;安全合规;回滚难/要迁移;跨团队;实现与需求/契约/ADR 矛盾;**spike 结果想转正**。

模式→`run.mode` 枚举映射:feature→`feature` · bugfix→`bugfix` · hotfix→`debug` · review/审计→`review` · release→`integration` · spike→`spike` · docs→`docs` · refactor→`feature`+goal 注明(枚举缺口,第二刀补)· perf→`feature`+goal 注明(同)。

---

## 3. 翻译词典:方法论的规划产出,存进 payload 哪个字段、下游谁在用

> 方法论规划时会算出几样东西(估算点数/MoSCoW 分级/风险分/依赖分型…)。这张表回答两件事:**每样存进 plan.json 的哪个字段;那个字段下游谁真的消费**。关键事实:claim-next 的派活排序就是 `priority desc → depth asc → weight desc`(docs/10 §7)——所以 MoSCoW 和点数不是文档装饰,**直接决定谁先被领走**;风险分不进字段,但扳动"开不开质量门"(轻量 vs full)这个最大开关;依赖分型里**只有硬依赖才建 `depends_on` 边**(软依赖建边会把可并行的活错锁成串行)。

| 方法论量(来源:phase-4 补强) | payload 字段 | 规则 |
|---|---|---|
| MoSCoW 优先级 | `priority`(0-100) | Must=90 / Should=60 / Could=30;关键路径上 +10 |
| Story Point 估算 | `weight` | 1/2/3/5/8;**8 点→必须再切;21 点→先出 spike 任务**(估算表原文) |
| 风险评分(6 维 0-60) | 模式选择 | **≥31 强制 full + `require_verification`**;16-30 建议 full;≤15 轻量可 |
| 依赖类型 | — | **Hard→`depends_on`;Soft→不建边,用 priority 排序;Cross-team→契约片先行(接口任务上游);External→该任务 objective 写缓冲/备选** |
| 关键路径 | `priority`+`task_graph` | 依赖 DAG 最长路径上的任务优先派发(phase-4 §5.2) |
| INVEST/四可检验 | 切片自查 | 每片:独立可交付/有价值/可估算/可测试;**纵向切片**(禁 UI 一片、API 一片、DB 一片的汉堡切) |
| SPIDR 切片技巧 | 拆法提示 | 太大时按 Spike/Path/Interface/Data/Rules 找切缝;happy path 先行、简单规则先行 |
| BDD 场景格式 | `acceptance[]` | **Given/When/Then 三段句**,场景编号 `BDD-<KEY>-NN` 前缀;"Then 可自动验证,用具体例子"(P2 检查单原文);测试名含场景 ID(P5 检查单) |

---

## 4. 配方(每条:模式来源 → 必交工件 → 任务映射 → 最小追溯链落到 sigmarun 证据)

### 4.1 feature(Full / Lightweight 模式)
- **必交工件**(mode-router):Lightweight=P1/P2 摘要 + P3 delta + P4 FEAT 条目 + P5 证据;Full=P0-P5 全 + 追溯矩阵。
- **任务映射**:
  - (风险≥中或 Full)`spec-delta`(investigation):产出 P1/P2 摘要+P3 delta(有 workspace 落 `02-phases/`,无则 evidence outputs/`spec-delta.md`);acceptance:["outputs/spec-delta.md 存在:AC 清单 + 受影响契约 + [Mode decision] 块"]。
  - `feat-contract`(implementation,跨片共享接口时):接口/类型先行(Cross-team/Interface 切缝);acceptance 用 Given/When/Then。
  - `feat-<n>`(implementation):**纵向切片**,每片过 INVEST 自查;`weight`=点数(≥8 再切);acceptance=BDD 三段句,编号 `BDD-<key>-NN`;required_checks ≥1 且**测试名含场景 ID**。
  - (细粒度时)`verify-journey`(verification):端到端旅程切片测试(P5 检查单"演示脚本逐步执行并记录实际结果")。
- **最小追溯链→证据映射**:`Requirement/AC → BDD → FEAT → files/tests → result` ⟺ spec-delta 输出 → acceptance(BDD-ID)→ client_task_key(FEAT-ID)→ evidence.changed_files/required_checks_results → verify 记录。**每一跳都有 .team 落点,traceability 行可机械导出**。
- **输出约束**:handoff 必含 `## 接口/契约`;commit 规范 `Refs: FEAT-XXX` trailer(P5 检查单原文)。

### 4.2 bugfix(Bugfix 模式)
- **必交工件**(mode-router 原文):failing repro · **impact analysis** · regression verification · **incident/knowledge update**。
- **任务映射**:
  1. `repro`(investigation):固化失败;acceptance:["存在失败用例/脚本,运行退出非 0(outputs/repro-before.log)","失败信息与报告症状一致"]。
  2. `impact`(investigation,可与 repro 同片,小 bug 时):按 **impact-analysis 模板字段**产出 outputs/impact.md——对外契约变更表(API/Schema/状态机/事件×兼容性)、**受影响模块×回归用例 TC-REG-xxx×回滚方案**、数据迁移(策略/flag/forward-rollback 脚本)、性能路径、安全五问(新增凭据?数据分级?外部路径?STRIDE 重审?合规?)。
  3. `fix`(implementation,depends_on repro,impact):**test-first**;acceptance:["repro 由红转绿(outputs/repro-after.log)","**回归测试与影响分析 1:1**(P5 检查单原文:impact §2 每行 TC-REG 都有对应用例)","全量无新失败"]。
  4. `knowledge`(docs,可并入 fix 收尾):根因+教训入 knowledge/L4(`memory promote`);有 workspace 时进 `project-knowledge/incidents/`。
- **追溯链**:`Bug report → failing repro → root cause → fix → regression test → result` ⟺ goal → repro 证据 → handoff `## 根因` → fix 的 changed_files → TC-REG 结果 → verify/done。
- **升级触发**(mode-router 原文):"根因暴露需求/设计错误" → STOP,标 `[needs backflow to P{N}]`,升 feature/Full 重规划。

### 4.3 hotfix(Hotfix 模式;mode=`debug`)
- **必交工件**(mode-router 原文六件):incident note · root cause hypothesis · **minimal spec/design delta** · regression test · verification · **rollback note**。
- **任务映射**:
  1. `incident`(investigation):事故记录(时间线/影响面/根因假设)→ outputs/incident.md;acceptance 含"[Gate skipped: …] 逐项列明跳过的门+理由"(**跳过≠通过**,mode-router 原文)。
  2. `patch`(implementation,depends_on incident):最小修 + 回归测试;objective 写死"止血优先,禁重构";**acceptance 必含 rollback 项**:["outputs/rollback-note.md 存在:回滚命令/flag/数据影响"]。
  3. `verify-live`(verification):修复验证 + 监控点。
  4. `postmortem`(docs,**可延期但必须建任务**——不建就永远不会补):补审+教训入 incidents。
- **升级触发**:"fix 改公共行为或架构" → 停,转 feature/Full。

### 4.4 refactor(Refactor 模式;v1 整个漏掉)
- **必交工件**(mode-router):**safety net** · before/after verification · 架构影响。
- **任务映射**:
  1. `safety-net`(investigation):**先建行为快照**——现有测试盘点+补齐关键路径行为测试;acceptance:["行为基线测试全绿并归档 outputs/safety-before.log","覆盖将被重构的公共行为"]。测试缺失=**Stop or ask**(mode-router 原文)。
  2. `refactor-<n>`(implementation,depends_on safety-net):结构改动;acceptance:["safety net 全绿(outputs/safety-after.log)","**行为零变化**:before/after 输出一致","架构守护 0 违规(依赖方向/循环/跨层,P5 检查单)"]。
- **追溯链**:`Refactor goal → safety tests → changed files → unchanged behavior evidence`。
- **约束**:公共行为一旦变化 → 停,转 feature。

### 4.5 spike(Spike/POC 模式)
- **必交工件**(mode-router 原文六件):question · **timebox** · **constraints** · experiment plan · result · decision。
- **任务映射**:单片 `spike-<q>`(investigation);objective 含全六件:问题一句话/时间盒(N 小时或轮)/边界(不碰什么)/实验计划;acceptance:["outputs/decision-memo.md:问题/做了什么/证据/**决策(adopt-reject-再探)**+理由"]。
- **约束**:代码可弃(worktree 不并回);**"用户想保留原型代码"=升级触发**(mode-router 原文)→ 开 feature run 按生产纪律重做;decision 经 `memory promote` 入 L4/ADR。

### 4.6 review / 审计(只读)
- 按维度切 `type:"review"` 片(正确性/安全/性能/一致性);acceptance:["outputs/findings-<维>.md:条目=严重度/文件/一句话/建议","git status 干净(0 改动)"];paths.allow `[]`;修复另开 bugfix run(带着 findings 当 bug report——**两配方接力**)。

### 4.7 release(mode=`integration`;顺序链)
- `preflight`(verification:全量+冒烟)→ `version`(implementation:bump+CHANGELOG,commit 带 Refs trailer)→ `publish`(integration:**objective 写明 tag/OTP 由人执行**,人环红线)→ `verify-live`(verification:装包冒烟+`npm view` 证据)。`policy.max_parallel_tasks=1` 天然串行。**回滚方案必写**(P4 检查单:"每个 FEAT 有回滚方案"——release 的回滚=撤 tag/deprecate 策略,进 handoff)。

### 4.8 docs-only
- N 片 `type:"docs"`;必交=**一致性检查**(mode-router:consistency check):acceptance:["受影响工件更新","对账/链接检查绿"];"Docs imply behavior change"→停,升 feature。

### 4.9 perf(第二刀加枚举;骨架先行)
- `baseline`(investigation:基线数字+可复跑脚本,outputs/baseline.log)→ `optimize`(implementation:达标阈值,如 p95<X)→ `compare`(verification:outputs/compare.log 前后对比+全量无回归)。**性能预算句式**取 NFR 检查单("量化指标+测量方法,不是'性能要好'")。

---

## 5. 输出约束总表(合规=这些必须存在;第一刀 PAUSE 自报,第二刀 audit 规则)

| 配方 | 必存(来源) | 落点 |
|---|---|---|
| feature | spec-delta(risk≥中)· BDD 式 acceptance · Refs trailer | outputs/ + acceptance + commit |
| bugfix | 红/绿复现日志 · **impact.md(模板五节)** · TC-REG 1:1 · 根因 | outputs/ + handoff + knowledge |
| hotfix | incident.md · **rollback-note.md** · [Gate skipped] 清单 · postmortem 任务存在 | outputs/ + handoff |
| refactor | **safety-before/after 双日志** · 行为零变化声明 | outputs/ |
| spike | decision-memo(问题/时间盒/边界/计划/证据/决策) | outputs/ → memory promote |
| review | findings-<维>.md(分级)· 0 改动 | outputs/ |
| release | 每步可查证据 · 回滚方案 | acceptance + handoff |
| docs | 一致性检查绿 | required_checks |
| perf | baseline/compare 双数字日志 | outputs/ |

---

## 6. workspace 联动(有 ai-dev-methodology 工作区时)

检测到 `05-features/`/`02-phases/`:acceptance 直接引用既有 BDD-ID(逐字,evidence byte-match 闭环);spec-delta/impact/knowledge 落对应工件路径而非 outputs;`client_task_key`=FEAT/BUG 编号;done 后回写 verification/traceability(上行接缝,见 33 号讨论)。无 workspace:全部落 evidence outputs(轻量工件),不逼仓库改造。

---

## 7. 第二刀(gateway;**已落地 2026-07-25**)

> **实施注**:枚举加宽落 `perf`/`refactor`/**`hotfix`**/**`release`** 四个——括号里的"评估"做完了,结论是**加**。理由:§4.3 原把 hotfix 映射到 `debug`,而 `debug` 同时是普通调试 run 的模式,「hotfix 无 rollback→warn」照那个映射会对每个没有回滚记录的普通调试 run 误报;refactor 同理(原映射塌回 `feature`,规则永远收不到样本)。**枚举与配方从此一一对应**,两侧 plan 模板的 §2 映射表同步改(TEMPLATE 0.6.10→**0.6.11**),模板并写明"选相近的模式会静默关掉这些规则"。
>
> 关键事实(对账时确认):`run.mode` **不驱动任何状态机分支**——轻量↔全量才是唯一能力分叉(`mode.ts::resolveRunMode` 读 `run.lightweight`)。所以枚举加宽对状态机/门链/防撞车确实零风险,§7 的承诺成立。

- **枚举**:`feature`/`bugfix`/`debug`/`review`/`integration`/`spike`/`docs` + `perf`/`refactor`/`hotfix`/`release`(`RUN_MODES`,core 导出)。
- **run-import must-reject**:`mode=="bugfix"` 且 `type=="implementation"` 的任务缺 `required_checks` → **拒收**(修了没检查就无法证明 bug 没了);investigation/docs 片按配方本就无检查,豁免;其余模式维持既有 `task_without_checks` warning。`risk` 字段仍未入 payload(另议)。
- **audit 模式规则**:AUD-042 bugfix 无 investigation 片→warn · AUD-043 hotfix evidence 无 rollback→warn · AUD-044 refactor 无 safety 日志→warn · AUD-045 review 片改/删文件→error · AUD-046 spike 被并回→warn。判定全是结构/关键词测试(I4:gateway 无 LLM);模式不匹配即整条 no-op,旧 run 不受打扰。细则见 [18](18-audit-rule-catalog-and-trust-model.md) §4.I。
- **顺带**:补上**第五张机器对账**——引擎 RULES 的 id 集合 ↔ docs/18 §4 主表行双向相等(此前靠人工同步;上线当场逮出 5 条新规则未入文档)。
- 状态机/门链/防撞车零改动(兑现)。

**AUD-045 的一处规格补白**(实施时定,记录备查):§4.6 写"git status 干净(0 改动)",但 submit 硬性要求 `changed_files` 非空,两者字面冲突。取的口径是——**新增 findings 文档合法,改/删既有文件才是违规**(评审者一旦动手修,那次编辑绕过了评审本身,故 error)。若后续认为评审片应当完全零 changed_files,需先松开 submit 的非空约束,那是另一刀。

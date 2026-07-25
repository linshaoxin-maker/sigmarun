# 34. Plan Recipes 规格 v2(从 ai-dev-methodology 逐条推导;字段级)

> 日期:2026-07-25 · v2(v1 作废:v1 凭直觉自创骨架;v2 每条配方都注明**来源**——mode-router 的必交工件表、最小追溯链、P4 切片纪律、工件模板字段)
> 来源文件:`~/.claude/skills/ai-dev-methodology/references/{mode-router, phase-4-estimation-and-priority, quality-checklists}.md` + `templates/{impact-analysis.md, bdd-scenario.feature}`
> 分工铁律不变:**配方=skill 层教 AI 拆**(第一刀,gateway 零改);第二刀(mode 策略默认+audit)见 §7。

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

## 3. 方法论量 → payload 字段映射(结合的核心,v1 完全没有)

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

## 7. 第二刀预告(gateway;独立小版本)

枚举 +`perf`/`refactor`(评估 +`hotfix`/`release`);run-import 按 mode 注入 §3 默认(bugfix 缺 required_checks→must-reject;risk 字段若入 payload 另议);audit mode 规则:bugfix 无 investigation 片→warn、hotfix evidence 无 rollback 字样→warn、refactor 无 safety 日志→warn、review 片有代码改动→error、spike worktree 被并回→warn。状态机/门链/防撞车零改动。

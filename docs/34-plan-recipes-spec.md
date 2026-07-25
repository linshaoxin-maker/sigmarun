# 34. Plan Recipes 规格(第一刀:按类型拆解;字段级)

> 日期:2026-07-25 · 状态:方案定稿,待实施(第一刀=纯模板层;等 handoff 芯片释放 templates.ts 后动工)
> 目标:`/team-plan` 按任务类型选**配方**拆解——切片骨架、字段格式、输出件、配置全部规格化,防"模型裸拆漏场景"。第二刀(gateway 按 mode 给策略默认+audit 规则)见 §6,另行小版本。

---

## 1. templates.ts 精确改动清单(第一刀全部改动就这五处)

| # | 位置 | 改什么 |
|---|---|---|
| 1 | 新增共享块 `const PLAN_RECIPES` | 七配方压缩文本(§3 的骨架各 4-6 行 + §2 路由表),**单源**,同 COLLAB_BLOCK 模式注入两侧 |
| 2 | `TEAM_PLAN`(Claude 侧) | ①flow 里"Break the goal into 1-6 INDEPENDENT pieces"之前插 **步骤 0:TYPE-ROUTE**(按 §2 判类型;拿不准→带推荐项问一句);②注入 `${PLAN_RECIPES}`;③JSON 骨架 `"mode":"feature"`(现 ~:270 硬编码)→ `"mode":"<TYPE-ROUTE 结果>"`;④拆分确认 PAUSE 的展示头部加一行 `类型:bugfix · 配方:复现→修→回归` |
| 3 | `CODEX_PLAN_SKILL`(Codex 侧) | 同 2 的 ①②③④ 镜像(flow 在文件下半部) |
| 4 | `TEMPLATE_VERSION` | bump 一格 |
| 5 | `adapters/test/field-protocol-reconciliation.test.ts` | 加 RECIPES 段:两侧语料必须含 `TYPE-ROUTE` 及各配方骨架关键词(`repro`、`decision-memo`、`preflight`、`findings-`)——配方漂移即红 |

**Gateway 零改动。** 第一刀只用现有 7 个 mode 枚举(见 §2 映射);`perf` 等新枚举归第二刀。

---

## 2. TYPE-ROUTE(类型判定 → mode 映射;全部落在现有枚举内)

| 目标词面 | 配方 | 填入 `run.mode` |
|---|---|---|
| 新功能/加特性/改行为 | feature | `feature` |
| 修 bug/闪退/报错/回归 | bugfix | `bugfix` |
| 生产急修/先止血 | hotfix(短链) | `debug` |
| 审查/审计/找问题(只读) | review | `review` |
| 发布/上版本/集成收口 | release | `integration` |
| 调研/可行性/试一下 | spike | `spike` |
| 文档/README/注释 | docs | `docs` |
| 性能优化(基线→优化→复测) | perf | **第二刀加枚举前**:按 feature 走,goal 里注明 perf,骨架仍用 §3.8 |

判不准 → 问一句(带推荐项):"这个更像修 bug 还是加功能?我建议按 bugfix 走(先固化复现)。"

---

## 3. 七配方规格(字段级)

**通用约定(全配方适用):**
- 任务字段只用 schema 现有域(docs/09):`client_task_key`(配方前缀,见各节)、`title`、`type`(∈ implementation/investigation/review/verification/integration/docs)、`objective`(一句话)、`acceptance[]`(**每条=可查证据句式**:"存在 X / 命令 Y 退出 0 / 数字 Z 达标")、`depends_on[]`、`paths{allow,avoid}`、`required_checks[]`、`suggested_role`。
- **输出件目录约定**(不新增机制,全复用 evidence):原始输出进 `evidence outputs/`,由 `commands[].cmd_id` 命名(见各节 cmd_id 约定);交接叙述进 `handoff`(按 docs/14 handoff 结构模板,配方追加"必含节");跨 run 结论走 `memory promote`。
- **合规自查**(第一刀=PAUSE 时 AI 逐条报;第二刀=audit 规则):各节"约束"列。

### 3.1 feature(mode=`feature`;默认轻量,大改/高危 full)
- **骨架**:`feat-contract`(可选,implementation:接口/类型先行)→ `feat-<n>`(implementation,user-visible 切片,depends_on contract)→ `feat-docs`(可选,docs)。
- **acceptance 句式**:BDD 风:"当 <条件>,<可观察行为>;由 `<required_check>` 验证"。
- **paths**:切片间 allow 不相交;共享类型文件归 contract 片。
- **required_checks**:每切片 ≥1 条测试命令。
- **handoff 必含节**:`## 接口/契约`(contract 片)。
- **约束**:切片各自独立可交付;无环;1-6 片。

### 3.2 bugfix(mode=`bugfix`;轻量;required_checks 硬)
- **骨架(固定三片;小 bug 可并 ②③)**:
```json
"tasks":[
 {"client_task_key":"repro","title":"复现并固化失败","type":"investigation",
  "objective":"把 issue 症状变成一个稳定失败的测试/脚本",
  "acceptance":["存在失败用例 <测试路径> 或 outputs/repro.sh,运行退出非 0","失败信息与 issue 症状一致"],
  "paths":{"allow":["test/**"]},"required_checks":["repro"]},
 {"client_task_key":"fix","title":"最小修复","type":"implementation","depends_on":["repro"],
  "acceptance":["repro 检查由红转绿","全量测试通过,无新失败"],
  "paths":{"allow":["src/<定位模块>/**","test/**"]},"required_checks":["repro","full-tests"]},
 {"client_task_key":"harden","title":"回归加固(可选)","type":"implementation","depends_on":["fix"],
  "acceptance":["回归用例纳入常跑套件"],"paths":{"allow":["test/**"]}}]
```
- **cmd_id 约定**:`repro-before`(红,exit≠0)/`repro-after`(绿)——同一脚本前后各留一份日志。
- **handoff 必含节**:`## 根因`(一句话)。
- **约束**:第一片必须是 investigation;fix 片 required_checks 非空;禁止"没有失败测试就直接修"。

### 3.3 hotfix(mode=`debug`;生产急修短链)
- **骨架**:`triage`(investigation:定位+最小复现)→ `patch`(implementation,depends_on triage:最小修+就地验证)→ `postmortem`(docs,可延期:事后记录)。
- **配置**:建议 full 短链或轻量+人工复核;`policy.claim_ttl_minutes` 调小(急件不许久占)。
- **handoff 必含节**:`## 事故时间线`、`## 后续债`(postmortem 入 knowledge/L4)。
- **约束**:patch 片 paths.allow 最窄化;"止血优先,重构禁止"写进 objective。

### 3.4 review(mode=`review`;纯只读)
- **骨架**:按维度 N 片(正确性/安全/性能/一致性…),`type:"review"`,`suggested_role:"reviewer"`。
- **acceptance**:["outputs/findings-<维度>.md 存在,条目含 严重度/文件/一句话/建议","git status 干净(0 代码改动)"]。
- **paths**:`allow: []`(不改码;task_without_paths warning 可接受,第二刀为 review mode 豁免)。
- **cmd_id 约定**:`findings-<维度>`。
- **约束**:任何片不得有代码改动;终点=汇总 findings,不修(修=另开 bugfix run)。

### 3.5 release(mode=`integration`;顺序链)
- **骨架(串行,depends_on 逐级)**:`preflight`(verification:全量+冒烟)→ `version`(implementation:bump+CHANGELOG)→ `publish`(integration:tag/发布——**objective 里写明"tag push/OTP 由人执行"**)→ `verify-live`(verification:装包冒烟)。
- **配置**:`policy.max_parallel_tasks: 1`(现成旋钮,天然串行)。
- **acceptance 句式**:每步一条可查证据("`npm view` 显示 X.Y.Z"/"CI run <id> 绿")。
- **约束**:publish 片是人环红线;preflight 不绿禁止进入 version。

### 3.6 spike(mode=`spike`;单片时间盒)
- **骨架**:单片 `spike-<问题>`(investigation);objective 含**时间盒**("最多 N 小时/轮")。
- **acceptance**:["outputs/decision-memo.md 存在:结论(adopt/reject/再探)+理由+证据引用"]。
- **paths**:沙箱目录(如 `spike/**`);**worktree 不并回**(handoff 声明代码可弃)。
- **约束**:决策备忘是唯一必交付物;结论经 `memory promote` 入 L4/ADR。

### 3.7 docs(mode=`docs`)
- **骨架**:N 片 `type:"docs"`;acceptance:["<文档> 更新且 <链接检查/对账测试> 通过"]。
- **约束**:有 docs↔code 对账的仓库,required_checks 必填对账命令。

### 3.8 perf(第二刀加 `perf` 枚举;骨架先行可用,mode 暂填 feature)
- **骨架**:`baseline`(investigation)→ `optimize`(implementation,depends_on baseline)→ `compare`(verification,depends_on optimize)。
- **acceptance**:baseline=["outputs/baseline.log 存在:指标数字+测量命令可复跑"];optimize=["目标阈值达成(如 p95<X ms)"];compare=["outputs/compare.log:前后对比,无功能回归(全量绿)"]。
- **cmd_id 约定**:`baseline`/`compare`(同一测量脚本跑两次)。
- **约束**:没有 baseline 数字禁止进入 optimize;结论数字进 handoff `## 前后对比`。

---

## 4. 配置信息汇总(run.policy 按配方的建议默认;第一刀=模板填,第二刀=gateway 注入)

| 配方 | lightweight | 特殊 policy |
|---|---|---|
| feature | 小改是/大改否 | — |
| bugfix | 是 | required_checks 硬(第二刀:缺→must-reject) |
| hotfix | 视团队 | claim_ttl_minutes 调小;require_verification=true(第二刀默认) |
| review | 是 | (第二刀)豁免 task_without_paths warning |
| release | 是 | max_parallel_tasks=1 |
| spike | 是 | weight 低 |
| docs | 是 | — |
| perf | 否(要 verify 门) | (第二刀)无 baseline 证据 → audit warn |

---

## 5. 输出约束总表(什么必须存在才算"这个类型合规")

| 配方 | 必存输出件 | 落点 |
|---|---|---|
| feature | 接口契约节(有 contract 片时) | handoff |
| bugfix | 红/绿两份复现日志 + 根因一句话 | outputs/repro-before·after + handoff |
| hotfix | 事故时间线 + 后续债 | handoff → knowledge |
| review | 分维度 findings 文件(严重度分级) | outputs/findings-* |
| release | 每步证据行(版本号/CI id) | acceptance 即证据 |
| spike | decision-memo(结论+理由+引用) | outputs/ → memory promote |
| docs | 对账/链接检查绿 | required_checks |
| perf | 基线与对比日志(数字) | outputs/baseline·compare |

---

## 6. 第二刀预告(gateway;独立小版本,另出实施单)

①`payload.ts` 枚举 +`perf`(评估 +hotfix/release 或维持映射);②`run-import` 按 mode 注入 §4 默认(bugfix 缺 required_checks→must-reject 升级);③`audit` mode 感知规则(bugfix 无 investigation 片→warn;perf 无 baseline cmd→warn;review 片有代码改动→error);④docs/09/15/17/18 契约行 + 对账测试同步。**状态机/门链/防撞车零改动;判断仍在 AI,gateway 只机械执行。**

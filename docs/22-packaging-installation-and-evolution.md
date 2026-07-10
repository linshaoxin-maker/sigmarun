# 22. Packaging, Installation, and Evolution

> 日期：2026-07-10
> 状态：v0.1 设计草案
> 依据：[13](13-design-audit-and-next-breakdown.md) 决策 D1（形态 A→B→C 演进）/ D2（首发 Claude Code + Codex）/ D3（TypeScript/Node、npm 分发）/ D12（命名裁决归本文）/ D14（永不做 OS daemon）、附录 C M37（`team backup`）/ M43（`team deinit`）、§6.1 对本文档的章节要求；[07](07-skill-plugin-execution-form.md) 三形态原型；[17](17-cli-mcp-contract-and-error-model.md) §1 命令总表 / §8 init·doctor / §11 版本握手；[20](20-c4-l2-l3-component-contracts.md) §2/§3（monorepo 包结构、`@team/*` scope 占位、mcp-server contract-only）；[21](21-schema-versioning-and-migration.md) §5 备份机件 / §6 发布纪律与 `min_gateway_version`；[16](16-git-worktree-and-team-root.md) §1 gitignore / §7 export；[24](24-security-permissions-and-data-hygiene.md) §10 供应链遗留
> 目标：把 D1 的三形态从"备选方案"落成带进入/退出判据的演进路线图；定死形态 A 的 repo 内布局、init/doctor 首跑与"10 分钟上手"，形态 B 的插件包结构、adapter↔gateway 兼容矩阵与多项目复用，形态 C 的触发条件与发布方式；**实测 npm 可用性并裁决包名（D12）**；定义升级 / 卸载（deinit）/ 备份（backup）与供应链完整性承诺。

---

## 1. 三形态不变式（先立规矩）

分发形态变，协议不变。以下五条贯穿 A/B/C，任何形态升级不得触碰：

| # | 不变式 | 依据 |
|---|---|---|
| I1 | `.team/` 协议、schema 版本策略与分发形态**正交**：形态升级永不要求数据迁移（同 schema major 内） | [21](21-schema-versioning-and-migration.md) §1 |
| I2 | envelope 合同（`team.envelope.v1`、reason code、exit code）跨形态逐字节同构——adapter 从 CLI 迁到 MCP 不改分支逻辑 | [17](17-cli-mcp-contract-and-error-model.md) §2/§9 |
| I3 | **永不做 OS 级开机自启 daemon**（D14）；三形态的常驻进程只有用户手启的 `team watch` 与随 agent 会话启停的 mcp-server | [13](13-design-audit-and-next-breakdown.md) D14 |
| I4 | gateway 无智能、无 LLM 依赖、不执行项目代码（V10） | [20](20-c4-l2-l3-component-contracts.md) §5 |
| I5 | B/C 是**叠加不是替换**：CLI 永不下线，cli / mcp-server / watch 是同一 core 库的三个前端 | [20](20-c4-l2-l3-component-contracts.md) §2 |

---

## 2. 形态 A→B→C 路线图总表

```mermaid
flowchart LR
  A["形态 A<br/>repo 内最小本地版"] -- "北极星端到端<br/>+ conformance 通过<br/>+ ≥1 真实项目" --> B["形态 B<br/>npm 包 + 插件分发"]
  B -. "触发条件成立才做：<br/>结构化调用需求实测" .-> C["形态 C<br/>mcp-server 前端实现"]
```

| 维度 | 形态 A：最小本地版 | 形态 B：插件包 | 形态 C：MCP server |
|---|---|---|---|
| 一句话定位 | 在一个 repo 里验证全链路 | 一条命令装进任意 repo | 给 adapter 换一个结构化调用面 |
| 交付物 | 可跑的 `team` CLI（[17](17-cli-mcp-contract-and-error-model.md) §1 MVP 命令面）、`.claude/commands/` 最小模板、Codex skills 最小版、AGENTS.md 协议段落（全文归 19 号）、conformance suite 雏形（M38） | npm 发布物（含 provenance）、Claude Code plugin、Codex skills 包、`team adapter install`、模板版本化 + doctor 漂移检测 | `team mcp serve` 子命令（stdio）、mcpServers 配置文档、CLI/MCP envelope 同构断言测试（[20](20-c4-l2-l3-component-contracts.md) §7 首行场景） |
| 安装方式 | 复制 `tools/team-gateway/` 进 repo + `npm link`；模板手工/脚本拷入 | `npm i -g <pkg>`＋plugin marketplace 或 `team adapter install` | 同 B 的包；agent 侧 mcpServers 配 `npx <pkg> mcp serve` |
| 进入判据 | P0 合同链（14/15/16/17）冻结 + 19 号最小模板就绪 | **A 的退出判据全部满足 + D12 定名经产品负责人确认**（没有名字不能发包） | 见 §5 触发条件（满足任一 + 17 §9 契约冻结） |
| 退出 / 触发判据 | ① 北极星场景端到端：Claude Code `/team-plan` 产出的 RUN-ID 被 Codex `/team-dispatch` 领取唯一 TASK-ID、写回 evidence、status 可查可信 progress（[13](13-design-audit-and-next-breakdown.md) §8-6）② mock-agent conformance suite 全绿（M38）③ **≥1 个真实项目**（非玩具 repo）完整跑完一个 run 并 `team export` 留档 | ① **≥2 个 repo 复用**同一份全局安装 ② 一键安装升级顺畅：新 repo 从安装到第一个 run ≤10 分钟且不需查源码；升级 = 一条 npm 命令 + doctor 全绿 | 形态 C 无"退出"——它与 B 长期并存（I5），CLI 与 MCP 双前端同时维护 |

---

## 3. 形态 A：repo 内最小本地版

### 3.1 布局清单

```text
repo/
  .team/                          # team init 生成，整体 gitignored（16 §1）
  .claude/commands/               # Claude Code 侧模板（全文归 19 号）
    team-plan.md  team-dispatch.md  team-publish.md  team-status.md
    team-task.md  team-submit.md   team-review.md    team-verify.md
  AGENTS.md                       # 追加协议段落（内容清单见下，全文归 19 号）
  tools/team-gateway/             # 形态 A 的 gateway 宿主（D3：TS/Node 包）
    package.json  bin/team.js  src/...
```

Codex 侧形态 A：skills 目录与触发词写法以 19 号按 D13 实测定稿；本文只约定"与 Claude 模板调用同一个 `team` bin、只解析 `--json` envelope"。

AGENTS.md 协议段落**内容清单**（全文归 19 号，此处防漂移）：① 协议一句话定位 + "永不直改 `.team/` 状态文件"禁令 ② 命令入口与双参约定（E6）③ adapter 必须用 `--json` 并按 envelope/next_actions 分支（[17](17-cli-mcp-contract-and-error-model.md) §2）④ worktree 与 commit 纪律引用（[16](16-git-worktree-and-team-root.md) §3.4）⑤ 指令优先级声明（M42）⑥ submit 为不可跳过末步 + Stop hook 兜底（附录 B F1）。

### 3.2 安装：让 `team` 进 PATH

adapter 模板统一调用 `team`（不是相对路径），因此 PATH 可达性是 doctor 第一检查项：

| 方式 | 命令 | 适用 |
|---|---|---|
| npm link（推荐） | `cd tools/team-gateway && npm i && npm link` | 本机开发者，一次生效 |
| repo scripts | package.json 加 `"team": "node tools/team-gateway/bin/team.js"`，经 `npm run team --` 调 | 不想动全局；**模板不支持此形态**（模板只喊 `team`） |
| 直接路径 | `node tools/team-gateway/bin/team.js ...` | 仅调试；adapter 模板禁用 |

### 3.3 `team init` 首跑流程（对齐 [17](17-cli-mcp-contract-and-error-model.md) §8）

| 步 | 动作 | 失败面 |
|---|---|---|
| 1 | 解析 git repo 与 team root（[16](16-git-worktree-and-team-root.md) §2） | `not_a_git_repo` / `bare_repo_unsupported` |
| 2 | 创建骨架：`project.json`、`counters.json`、`templates/`、`locks/` | `io_error` |
| 3 | 向 `.gitignore` 追加 `.team/` 条目（[16](16-git-worktree-and-team-root.md) §1.1 模板，含注释行） | 已存在则跳过 |
| 4 | `project.json.min_gateway_version` 设为该系列最低兼容版本（[21](21-schema-versioning-and-migration.md) §6.2 提升时机①） | — |
| 5 | 检测 tracked `.team/` 历史遗留 → 警告 + `git rm -r --cached` 指引（[16](16-git-worktree-and-team-root.md) §1.1-4） | — |
| 6 | 输出 next_actions：安装 adapter 模板的位置提示 + §3.5 上手指引 | — |

幂等：重复 init 返回现状报告，不重写已有文件（[17](17-cli-mcp-contract-and-error-model.md) §8 既定）。

### 3.4 `team doctor` 自检项（17 §8 全集 + 本文追加三项）

| 检查项 | 来源 |
|---|---|
| git repo / common-dir 解析、team root 主 checkout 与 worktree 一致性 | [17](17-cli-mcp-contract-and-error-model.md) §8 |
| Node 版本（≥20）、锁自测（建锁-删锁）、悬挂 lock、abandoned worktree 数、tracked `.team/` | [17](17-cli-mcp-contract-and-error-model.md) §8 |
| schema 读写矩阵输出 `data.schemas`（升级握手的数据源） | [21](21-schema-versioning-and-migration.md) §6.1 |
| **追加：`team` bin 可达且版本与安装源一致**（npm link 漂移 / 全局多副本检测） | 本文 §3.2 |
| **追加：`.team/backup/` 总大小与最老快照**，超阈值给清理建议命令（不代删） | [21](21-schema-versioning-and-migration.md) §12 遗留、本文 §7.3 |
| **追加（形态 B 起）：repo 内 adapter 模板版本 vs 包内最新模板**，漂移 → warning + `team adapter install --update` | 本文 §4.3 |

### 3.5 "10 分钟上手"（形态 A 验收脚本的人读版）

| 步 | 在哪 | 做什么 | 预期 |
|---|---|---|---|
| 1 | 终端 | `team init` | `.team/` 就绪，gitignore 已追加 |
| 2 | 终端 | `team doctor` | 全绿 |
| 3 | Claude Code | `/team-plan "给 README 增加 Team Run 使用说明（拆 2 个任务）"`（玩具 run） | 返回 `RUN-0001` + 任务摘要 |
| 4 | Claude Code | `/team-publish RUN-0001` | 任务进入 `ready` 队列 |
| 5 | Codex | `/team-dispatch RUN-0001` | 领到唯一 TASK-ID，建 worktree，开始实现（D5：单任务即停） |
| 6 | Codex | （dispatch 模板末步自动）`team submit ...` | evidence 落盘，task → `submitted` |
| 7 | 任一 | `/team-status RUN-0001` | progress 可信、无 risk，显示等待 review |

判定：干净机器上除模型推理时间外全程 ≤10 分钟；此脚本同时是 conformance suite（M38）的人肉对照组。

### 3.6 形态 A 的已知代价

复制式安装无版本管理（多 repo 各一份、修 bug 要逐份同步）；模板与 CLI 同 repo 演进无兼容压力，但也没有升级通道——这正是 B 的进入动机，不在 A 修复。

---

## 4. 形态 B：插件包分发

### 4.1 npm 发布物

| 决策 | 内容 |
|---|---|
| 发布粒度 | **MVP 单包发布**：`<pkg>`（bundle 全部 workspace 包 + bin）。[20](20-c4-l2-l3-component-contracts.md) §3 的九包是**内部结构**，不必等于发布结构；`@<scope>/*` 拆包推迟到出现外部程序化复用需求 |
| bin | 主命令一个（定名见 §6；文档期占位 `team`）；不为 watch/mcp 增设第二 bin（`team watch` / `team mcp serve` 子命令承载） |
| dist-tag | `latest`（稳定）/ `next`（预发：conformance suite 全绿后 promote）；不 unpublish，撤回用 `npm deprecate` |
| 发布纪律 | schema major bump 必须与 gateway 版本 bump 同版本发布、迁移链就位（[21](21-schema-versioning-and-migration.md) §1-3/§6.1）；每个发布版本的 doctor 输出该版支持矩阵 |
| 包内容 | gateway 三前端 + `adapters/` 模板目录（Claude commands、Codex skills、AGENTS.md 段落，19 号产物）——模板与 gateway **同仓同版本**，天然解决"模板配哪个 CLI"问题 |

### 4.2 插件目录结构（安装到 agent 侧）

```text
# Claude Code plugin（marketplace 或 --plugin-dir 安装）
team-run-claude-plugin/
  .claude-plugin/plugin.json      # name / version / 声明 requires_gateway >= x.y
  commands/team-*.md              # 与 §3.1 同一套模板（19 号全文）
  hooks/                          # Stop hook 兜底（附录 B F1，19 号）

# Codex skills 包（安装到 Codex skills 目录；目录约定按 D13 实测定稿）
team-run-codex-skills/
  team-run-plan/SKILL.md          team-run-dispatch/SKILL.md
  team-run-status/SKILL.md        team-run-review/SKILL.md
  AGENTS.md.fragment              # 协议段落（追加进目标 repo 的 AGENTS.md）
```

安装通道二选一，产物等价：① 工具原生插件机制（Claude marketplace）；② **`team adapter install --tool claude|codex --scope repo|user [--update]`**——从包内 `adapters/` 复制模板到 `.claude/commands/`（repo scope）或用户目录，文件头写入 `template_version` 注释。新命令，登记进 [17](17-cli-mcp-contract-and-error-model.md) §1（见 §10 修订指令）。

### 4.3 adapter ↔ gateway 兼容矩阵与升级策略

模板只依赖三样东西：envelope v1 结构、reason code 表、next_actions 语义（[17](17-cli-mcp-contract-and-error-model.md) §2/§3）。因此：

| 组合 | 行为 |
|---|---|
| 旧模板 + 新 gateway（同 envelope major） | 兼容（additive 字段被忽略）；doctor 报模板漂移 warning，建议 `--update` |
| 新模板 + 旧 gateway | 模板首步 doctor 握手（[21](21-schema-versioning-and-migration.md) §7 事前防线同款）发现 `gateway < requires_gateway` → 停止并提示 `npm i -g <pkg>@latest` |
| 任一模板 + migrate 后的旧 gateway | `min_gateway_version` 写闸门直接拦（[21](21-schema-versioning-and-migration.md) §6.2/§8），与模板无关 |
| envelope major bump（`team.envelope.v2`） | 视同 breaking：模板与 gateway 同版本同发布，plugin.json 的 requires 同步收紧 |

### 4.4 多项目复用与模板版本化

| 规则 | 内容 |
|---|---|
| 全局装一次 | gateway `npm i -g` 一份；每个 repo 仍各自 `team init`（`.team/` 是 repo-local 事实源，D4 不变） |
| repo 内模板 pin | `adapter install --scope repo` 落盘的模板**不随包升级自动改**；升级显式 `--update`（diff 提示后覆盖）——模板是 agent 行为的一部分，静默变更等于静默改流程 |
| 登记 | `project.json.adapter_templates[] = {tool, template_version, installed_at}`（additive 字段，[21](21-schema-versioning-and-migration.md) §3.3 A 类） |
| 漂移可见 | doctor 比对包内模板 vs repo 副本（§3.4 追加项）；conformance suite（M38）在 CI 里按包内最新模板回归 |

---

## 5. 形态 C：MCP server 实现

契约已在 [17](17-cli-mcp-contract-and-error-model.md) §9 与 [20](20-c4-l2-l3-component-contracts.md) §2 定稿（tool 一一映射 primitive、structured content 即 envelope、多实例并存、随会话生命周期）；MVP 只交契约不交实现（contract-only）。**形态 C 是实现动作，不是设计动作。**

触发条件（D1"需求实测成立"的可判定化，满足任一即可立项）：

| # | 信号 | 数据来源 |
|---|---|---|
| T1 | conformance suite 在一个发布周期内捕获 ≥3 起**源于 CLI 文本面**（stdout 解析、转义、截断）而非合同面的 adapter 缺陷 | M38 套件 + issue 标签 |
| T2 | 首发工具任一侧实测：原生 MCP 注册的触发可靠性显著优于 slash+CLI（D13 实测路径的延伸复测） | 19 号实测记录 |
| T3 | 第三个工具接入需求出现，且其 slash/skill 能力弱于其 MCP client 能力 | 用户请求 |

发布方式：**不发新包、不加新 bin**——同一 npm 包新增 `team mcp serve` 子命令（stdio）；agent 侧 mcpServers 配置 `npx <pkg> mcp serve`；server 随会话启停（I3，无 daemon）；上线验收 = [20](20-c4-l2-l3-component-contracts.md) §7 第一行场景（CLI 与 MCP 对同一 primitive 的 envelope 除 `elapsed_ms` 外逐字段相等）。

---

## 6. 命名裁决（D12）

### 6.1 npm 可用性实测（2026-07-10，命令：`npm view <name> version`，E404 = 可注册）

| 候选 | 实测结果 | 判定 |
|---|---|---|
| `teamrun` | `0.1.6` | 占用（与 D12 记录一致） |
| `sigma` | `3.0.3`（sigma.js 图可视化库） | 占用（一致） |
| `sigmarun` | E404 | **可用** |
| `runsigma` | E404 | **可用** |
| `teamgate` | E404 | 名义可用；但 Teamgate 是在售 CRM 产品（teamgate.com），商标风险 → 弃 |
| `trp` | E404 | **可用**（三字母，正是 Team Run Protocol 缩写） |
| `tsig` | `1.0.1` | 占用（`npm view` 静默输出异常，registry 直查 `dist-tags.latest=1.0.1` 确认；且 TSIG 是 DNS 签名术语，语义混淆） |
| `agent-team` | `0.2.0` | 占用 |
| `team-run-protocol` | E404 | **可用**（全称，描述性最强） |

补充事实（同日实测/核验）：

1. **npm moniker 规则**：新包名与既有包仅差标点/连字符即拒注册——`teamrun` 被占意味着 `team-run` 也不可注册（view 虽 E404）；反向地，我们注册 `sigmarun` 即防御 `sigma-run`/`sigma_run` 变体。
2. **bin 与包名可分离**：`sigma` 作为 bin 在 npm 侧无撞名（`sigma` 包无 bin 字段、npm 无 `sigma-cli`）；但 **PyPI 的 `sigma-cli`（SigmaHQ SIEM 规则工具）安装的可执行文件名就是 `sigma`**——目标用户与安全工程人群重叠，短别名有真实 PATH 撞名面。`team` 作为 bin 的泛用词风险（Q8 原始动机）维持不变。
3. **scoped 方案**：`@<org>/cli` + `@<org>/core`… 可行且天然防抢注；org 可用性无法经 registry 匿名探测（`www.npmjs.com/org/*` 返回 403），**注册组织时才能最终确认**；缺点是 `npx @org/cli` 冗长，必须配独立 bin 短名。
4. 本机 PATH 核验：`sigma` / `runsigma` / `trp` / `teamgate` / `team` 在 macOS 默认工具链下均无既有命令占用。

### 6.2 裁决（**已终裁 `sigmarun`**——2026-07-10 产品负责人确认，D12）

| 顺位 | npm 包名 | bin | scope（拆包期启用） | 理由与风险 |
|---|---|---|---|---|
| **推荐** | `sigmarun` | `sigmarun`（主）+ `sigma`（可选别名，安装时可关） | `@sigmarun/*` | 承接 D12 语义方向（Σ=汇总团队事实）；唯一性好、可品牌化；注册即防御连字符变体。风险：别名 `sigma` 与 PyPI sigma-cli 撞（见上），故别名默认关闭 |
| 备选 1 | `runsigma` | `runsigma` | `@runsigma/*` | 同语义家族，动词前置贴"跑一个 run"；与推荐名互为镜像，二者应**同时注册**（一个发布、一个占位防混淆） |
| 备选 2 | `team-run-protocol` | `trp` | `@team-run-protocol/*`（偏长，弱推荐） | 描述性最强、零歧义，适合"协议"叙事；bin 用缩写 `trp`（包名 `trp` 同样可用，可一并注册防御）。风险：三字母 bin 记忆性差、全称包名难念 |

配套纪律（终裁后口径）：**设计文档全集沿用 `team <cmd>` 简记**（记号约定见 [17](17-cli-mcp-contract-and-error-model.md) §1，等价于 `sigmarun <cmd>`），不做全集机械改写；**真名替换在实现仓库启动时一次性执行**：[20](20-c4-l2-l3-component-contracts.md) §3 的 `@team/*` → `@sigmarun/*`、[21](21-schema-versioning-and-migration.md) §7/§8 的 `npm i -g <pkg>` → `sigmarun`、19 号模板落地为可安装产物时命令前缀用真名 `sigmarun`（文档内模板保留记号）、本文 `<pkg>` 占位 → `sigmarun`。注册动作：`sigmarun` 与镜像名 `runsigma` **同时注册**（一发布一占位防混淆）；`@sigmarun` org 注册时确认。替换验收：实现仓库 grep 无 `@team/` 与 `<pkg>` 残留。

---

## 7. 升级 / 卸载 / 备份

### 7.1 升级流程（npm + doctor 版本握手）

| 步 | 动作 | 依据 |
|---|---|---|
| 1 | `npm i -g <pkg>@latest`（形态 A：`git pull` + `npm i`） | — |
| 2 | `team doctor`——握手三查：`gateway_version >= min_gateway_version`；`data.schemas` 读写窗口覆盖存量 run；模板漂移 | [17](17-cli-mcp-contract-and-error-model.md) §11、[21](21-schema-versioning-and-migration.md) §6 |
| 3 | doctor 报 `migration_required` → 按 [21](21-schema-versioning-and-migration.md) §8 顺序：**先升本 repo 所有工具侧的 gateway，最后 `team migrate`** | [21](21-schema-versioning-and-migration.md) §8 |
| 4 | 升级**永不自动 migrate**、永不自动提升 `min_gateway_version`（日常命令禁提升） | [21](21-schema-versioning-and-migration.md) §6.2 |

### 7.2 `team deinit`（M43 落地）

性质：**只读的清理计划生成器 + 交互确认**——gateway 不执行任何删除，只给命令（[16](16-git-worktree-and-team-root.md) §6 原则的卸载版）。存在 active run 或未过期 claim 时首屏警告并要求二次确认。

| 步 | 交互 | 输出 |
|---|---|---|
| 1 | 扫描现状 | active run 数、worktree 清单、backup 大小、`.gitignore` 条目位置 |
| 2 | 确认一：`.team/` 保留还是删除 | 保留 → 仅输出"停用"清单；删除 → 先提示 `team backup --to <repo 外>` 或 `team export` 留档 |
| 3 | 确认二：`.gitignore` 的 `.team/` 条目 | 提示可移除的行位置；**不代改** |
| 4 | 输出逐条命令清单（用户自行执行） | `rm -rf .team/`；逐个 `git worktree remove ...`（[16](16-git-worktree-and-team-root.md) §3.5 语义，脏 worktree 标注 `--force` 后果）；`git branch -d team/RUN-*/...`；卸载 gateway（`npm rm -g <pkg>` 或删 `tools/team-gateway/`）；移除 `.claude/commands/team-*.md` 与 Codex skills；AGENTS.md 协议段落的起止位置提示 |

`--json` 输出结构化计划（`data.plan[]`），供 adapter 转述。

### 7.3 `team backup`（M37 落地）

```text
team backup [--run RUN-0001 | --all] [--to <dir>] [--json]
```

| 规则 | 内容 |
|---|---|
| 机件 | 复用 [21](21-schema-versioning-and-migration.md) §5 的迁移备份机件：整目录复制 + `backup.json` manifest（时间、gateway_version、run 清单、各 schema major 快照） |
| 默认目标 | `.team/backup/<ts>/`——防单文件损坏与误改；**防不了 `rm -rf .team`（M37 的威胁模型本身）** |
| `--to` 外部目标 | 允许 repo 外目录，构成跨 `rm -rf` 防线；目标在 repo 内且非 ignored → **拒绝**（`backup_target_invalid`）：备份是**未脱敏原样快照**，不得入库——这是它与 export（脱敏留档，[16](16-git-worktree-and-team-root.md) §7）的定位分界 |
| 恢复 | MVP 不提供 restore 命令：人工拷回 `.team/` 后跑 `team doctor` + `team audit run` 验一致性（文档明示） |
| 周期快照 | `team watch --snapshot-interval`（P2，M37 原文的可选项）；MVP 只有手动快照 |
| 占用治理 | doctor 报 backup 总大小/最老快照并给清理建议命令（§3.4 追加项，闭合 [21](21-schema-versioning-and-migration.md) §12 遗留） |

---

## 8. 供应链完整性（[24](24-security-permissions-and-data-hygiene.md) §10 落地）

### 8.1 发布管道承诺

| 项 | 承诺 |
|---|---|
| lockfile 纪律 | `package-lock.json` 入库；CI 与发布一律 `npm ci`；lockfile-lint 校验 resolved 仅指向 registry.npmjs.org；依赖升级走审阅式 PR（renovate/dependabot） |
| provenance | GitHub Actions OIDC + `npm publish --provenance`；用户可 `npm audit signatures` 验证发布物与源码 commit 的对应 |
| 2FA | npm org 全员强制 2FA；发布仅经 CI（trusted publishing / granular token，最小权限 + 定期轮换）；**禁止本机手工 publish** |
| 安装面最小 | **无 postinstall 脚本**（纯 JS、无原生编译）——安装期零任意代码执行；无网络回连 |
| 版本不可变 | 已发布版本不 unpublish；问题版本 `npm deprecate` + 修复版 |

### 8.2 依赖最小化承诺（运行时白名单）

| 层 | 运行时依赖白名单 |
|---|---|
| core / storage / dispatch / context / audit | **零重依赖**：仅 `minimatch`（D3 glob 语义，core/path-glob 唯一入口）+ `zod`（schema 校验，[21](21-schema-versioning-and-migration.md) §4.2 passthrough 纪律）。锁 = mkdir（[17](17-cli-mcp-contract-and-error-model.md) §4，零依赖） |
| cli / watch | 同上 + Node 内建（参数解析用 `util.parseArgs`，不引 commander/yargs；不引颜色/spinner——envelope 是机器面，D16） |
| mcp-server（形态 C 才发布） | 追加 `@modelcontextprotocol/sdk`，隔离在该包 |
| 新增依赖流程 | 修订本表（白名单登记）+ 说明"内建/自写不可行"的理由 + 审查其 install 脚本与传递依赖数 |

### 8.3 构建链与依赖违例 CI（闭合 [20](20-c4-l2-l3-component-contracts.md) §9 首条选型）

| 项 | 选型 | 理由 |
|---|---|---|
| workspace | npm workspaces（不引 turborepo/nx） | 包数 ≤10，构建秒级，少一个供应链面 |
| 构建 | tsup（esbuild）产 ESM + d.ts；发布时 bundle 进单包（§4.1） | — |
| 包间依赖违例 | dependency-cruiser 按 [20](20-c4-l2-l3-component-contracts.md) §5 依赖图与 V1–V10 写规则，CI 强制 | 20 §9 指定归本文 |
| 运行时依赖白名单 | CI 脚本断言各包 `dependencies` ⊆ §8.2 白名单 | — |

---

## 9. MVP 验收场景

| 场景 | 预期 |
|---|---|
| 干净机器（macOS/Linux CI）执行 §3.5 十步脚本 | 全链路通过；除模型时间外 ≤10 分钟 |
| `npm pack` 产物离线安装 → `team doctor` | 通过；无 postinstall 执行痕迹；bin 在 PATH |
| 形态 A（tools/ 副本）切换到形态 B（全局包），`.team/` 不动 | 既有 run 的 status / claim / submit 全部正常（I1：分发与数据正交） |
| `team deinit` 全流程 | 清单命令逐条可执行；deinit 自身执行前后文件系统 diff 为空（零删除） |
| `team backup --to` repo 外 → `rm -rf .team` → 人工拷回 | doctor + `team audit run` 通过，事实链完整（M37 闭环） |
| `team backup --to` repo 内非 ignored 目录 | 拒绝，`backup_target_invalid`，exit 6 |
| 已发布版本 `npm audit signatures` | provenance 验证通过 |
| 向 read-model 注入 `import dispatch`、或向 core 加入未白名单依赖 | CI 依赖违例失败（V1 / §8.2） |
| 定名替换完成后全仓 grep `@team/` 与 `<pkg>` | 零残留 |

---

## 10. 对现有文档的修订指令

| 文档 | 修订 |
|---|---|
| [07](07-skill-plugin-execution-form.md) | §2 节首加注："三形态'三选一'已由 D1 改判为演进路线图，各形态交付物与进入/退出判据**指向本文 §2**"；§2B 形态 B 结构中 `mcp/team-gateway-server` 标注"形态 C 才出现（[20](20-c4-l2-l3-component-contracts.md) §2 contract-only）"；§9 末条（MCP server）指向本文 §5 触发条件 |
| [13](13-design-audit-and-next-breakdown.md) | §2.1 **D12 行更新——已执行**（2026-07-10 产品负责人终裁 `sigmarun`，13 §2.1 已同步为终裁记录）；M37/M43 行标注已落地本文 §7.3/§7.2 |
| [17](17-cli-mcp-contract-and-error-model.md) | §1 命令总表登记：`team deinit`（读，无锁，P1）、`team backup`（读 + 写备份目录，P1）、`team adapter install`（写 repo 文件非 `.team`，形态 B）；§3 增 `backup_target_invalid`（exit 6）；§8 doctor 增补本文 §3.4 三项 |
| [16](16-git-worktree-and-team-root.md) | §6 清理表补"整体卸载走 `team deinit` 清单（22 §7.2）"；M37 备份出口指向本文 §7.3 |
| [20](20-c4-l2-l3-component-contracts.md) | §3 `@team/*` 占位注补"定名裁决见 22 §6"；§9 首条（package.json / 构建链 / 依赖白名单工具 / scope）标注已由本文 §8.3 闭合 |
| [21](21-schema-versioning-and-migration.md) | §11 对 22 的预期行（发布纪律 / 升级 UX / 备份治理）标注已由本文 §4.1 / §7.1 / §7.3 落地 |
| [24](24-security-permissions-and-data-hygiene.md) | §10 供应链行标注已由本文 §8 落地 |
| README | 文档索引补 22 行 |
| 19 号（编写时） | AGENTS.md 协议段落全文按本文 §3.1 清单展开；模板文件头 `template_version` 注释规范；安装路径与 `adapter install` 行为按本文 §4.2 |

---

## 11. 遗留到其他文档的接口

- adapter 模板全文、AGENTS.md 段落文案、Stop hook、Codex skills 目录实测（D13）→ 19 号
- conformance suite 的用例定义（形态 A 退出判据②的可执行化，M38）→ 19 号 + [17](17-cli-mcp-contract-and-error-model.md) §10
- `team watch --snapshot-interval` 周期快照规格（P2）→ [17](17-cli-mcp-contract-and-error-model.md) §7 watch 规格增补
- `@<scope>/*` 拆包发布（独立 semver）、brew / 单文件二进制分发 → 形态 C 之后再议（登记，不承诺）
- dashboard（read-model + UI）的分发与版本策略（P2）→ [23](23-dashboard-information-architecture.md)

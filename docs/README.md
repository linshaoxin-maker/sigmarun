# Team Run Protocol Design

> 日期：2026-07-09  
> 状态：v0.1 设计草案  
> 主题：面向 AI4Coding 的项目级多智能体协作协议  

---

## 1. 一句话定位

**Team Run Protocol** 是项目内的 `.team/` 协作协议。Claude Code、Codex 等 coding agent（MVP 首发这两家，Cursor 等预留 Phase 2，D2）负责理解项目、拆解任务、实现、review；`.team/` 作为 gateway 负责接收这些工具提交的 run/task payload，并提供记录事实、发布任务队列、原子认领、锁、防冲突、任务 DAG、上下文传递、进度、证据和审计。

它不是新的 AI 编程模型，也不是中心调度器。它是 repo-local 的 **coordination ledger + task bus + context plane + audit protocol + gateway primitives**。

> **北极星验收**：一个 Claude Code 生成的 `RUN-ID`，能被 Codex 用 `/team-dispatch` 领取唯一 `TASK-ID`、写回 evidence，用户能用 `/team-status` 查到可信 progress。
>
> **产品决策记录**：D1–D16 见 [13 号 §2.1](13-design-audit-and-next-breakdown.md)。改动任何已决事项，先过该表。

---

## 2. 核心用户故事

用户可以在 Claude Code 中执行：

```text
/team-plan "实现 auth phase 1"
```

Claude Code 的 `/team-plan` slash command 使用 Claude 自己的项目理解能力拆任务，然后调用 `.team` gateway primitives 把 run 和 task list 写入 `.team/runs/RUN-0001/`，并返回：

```text
RUN-0001
```

随后用户可以在 Codex 中执行：

```text
/team-dispatch RUN-0001
```

Codex 读取该 run，注册当前 agent，在锁保护下自动领取一个 `TASK-ID`，创建 worktree，开始实现，并持续写回 heartbeat、events、evidence 和 progress。

同一个 `RUN-ID` 可以被多个 Claude Code / Codex 会话加入（Phase 2 起含 Cursor）。每个 agent 自主领取不同任务，`.team/` 保证任务不会被重复领取，路径冲突可见且可阻断。

---

## 3. 关键判断

1. **`RUN-ID` 是跨工具协作入口。**  
   agent-side `/team-plan` 通过 `.team` gateway 创建 run，后续任何 agent 通过 `RUN-ID` 加入。

2. **`TASK-ID` 是执行、查询、review、evidence 的基本单位。**  
   所有状态查询都应该能定位到 task。

3. **任务分发不是中心强派，而是发布队列 + 自主认领。**  
   `team-task-list.json` 是 run 内的任务索引；agent 通过 `claim-next` 原子领取。

4. **锁只保护短事务。**  
   `run.lock` 保护 claim、status update、path claim 等状态变更；长时间执行靠 lease + heartbeat。

5. **`.team/` 只提供工程协作原语。**  
   任务拆解、代码实现、review 判断由 Claude Code / Codex / Cursor 等具体工具完成；`.team` 只校验、记录、发布和编排这些工具写入的事实。

6. **dashboard 是可选展示层。**  
   dashboard 读取 `.team/` 展示谁在做、进度、diff、证据和风险，但不是协议核心。

7. **多 agent 协作需要 Context Plane。**  
   `events.jsonl` 是审计账本，不应该承载所有协作上下文。任务 DAG、message pool、working memory 应该独立建模，让下游 agent 能读取上游 handoff、open questions、decisions 和 context refs。

---

## 4. 文档索引

| 文档 | 内容 |
|---|---|
| [00-user-guide.md](00-user-guide.md) | **用户使用手册**：安装、多窗口协作规矩（`--as` 起名 / `--task` 点名）、锁的大白话、速查表 |
| [01-product-boundary-and-user-journey.md](01-product-boundary-and-user-journey.md) | 产品边界、用户旅途、三类 Team Run |
| [02-domain-model-and-team-storage.md](02-domain-model-and-team-storage.md) | 核心对象模型、`.team/` 目录、状态与制品边界 |
| [03-team-task-list-and-task-schema.md](03-team-task-list-and-task-schema.md) | `team-task-list.json`、`TASK-ID`、任务状态机、task schema |
| [04-command-workflows.md](04-command-workflows.md) | `/team-plan`、`/team-dispatch`、claim、submit、status、review 流程 |
| [05-mvp-feature-slices.md](05-mvp-feature-slices.md) | MVP 切片、后续阶段、待决问题 |
| [06-user-journey-visual-breakdown.md](06-user-journey-visual-breakdown.md) | 用户旅途可视化、泳道图、记录流、MVP 主链路 |
| [07-skill-plugin-execution-form.md](07-skill-plugin-execution-form.md) | Skill / slash command / plugin / gateway 的具体落地形式 |
| [08-core-gateway-capabilities.md](08-core-gateway-capabilities.md) | `.team gateway` 的记录、分发、审计、进度能力契约 |
| [09-team-run-import-payload-schema.md](09-team-run-import-payload-schema.md) | `/team-plan` 到 `team run import` 的 payload 输入合同 |
| [10-claim-next-lock-and-conflict-rules.md](10-claim-next-lock-and-conflict-rules.md) | `claim-next` 的锁、租约、路径冲突、心跳和回收规则 |
| [11-4-plus-1-architecture-view.md](11-4-plus-1-architecture-view.md) | 从 4+1 视图拆解逻辑、过程、开发、物理和场景架构 |
| [12-context-plane-task-dag-message-pool-memory.md](12-context-plane-task-dag-message-pool-memory.md) | 任务 DAG、消息池、working memory 和上下文 hydrate 机制 |
| [13-design-audit-and-next-breakdown.md](13-design-audit-and-next-breakdown.md) | 01–12 设计审计、产品决策记录（D1–D13）、下一批文档拆解与 P0/P1/P2 |
| [14-evidence-review-verification-contract.md](14-evidence-review-verification-contract.md) | evidence/review/verification 三类记录的 schema、多轮机制、submit 事务、requires_approval 批准流 |
| [15-run-task-state-machine-and-lifecycle.md](15-run-task-state-machine-and-lifecycle.md) | run/task/claim 三层状态机闭环、reclaim/publish/pause、dispatch loop、review gate 配置 |
| [16-git-worktree-and-team-root.md](16-git-worktree-and-team-root.md) | `.team/` gitignore 策略、team root 解析、worktree 生命周期、integration/merge、`team export` |
| [17-cli-mcp-contract-and-error-model.md](17-cli-mcp-contract-and-error-model.md) | 命令总表、envelope 与 reason code、锁与原子写、`rev` 乐观锁、`team watch`/init/doctor、MCP 映射 |
| [18-audit-rule-catalog-and-trust-model.md](18-audit-rule-catalog-and-trust-model.md) | 事件目录与 `team.event.v1` schema、AUD-001…035 规则表（P0-inline/P1-audit 两级）、audit 输出契约 |
| [19-agent-adapter-pack-claude-codex.md](19-agent-adapter-pack-claude-codex.md) | Claude commands + Codex skills 全文模板、十诫规则块、双触发路径、AGENTS.md 段落、conformance suite |
| [20-c4-l2-l3-component-contracts.md](20-c4-l2-l3-component-contracts.md) | C4 L1/L2/L3、TS monorepo 九包结构、八个核心组件签名契约、依赖违例清单 |
| [21-schema-versioning-and-migration.md](21-schema-versioning-and-migration.md) | schema 清单盘点、major-only 版本策略、读写兼容规则、`team migrate`、兼容矩阵 |
| [22-packaging-installation-and-evolution.md](22-packaging-installation-and-evolution.md) | A→B→C 路线图、init/doctor/deinit/backup、CLI 定名（已终裁 `sigmarun`）、供应链 |
| [23-dashboard-information-architecture.md](23-dashboard-information-architecture.md) | 只读 dashboard 信息架构：页面树、数据映射、DAG 视图规格、刷新模型、只读边界清单 |
| [24-security-permissions-and-data-hygiene.md](24-security-permissions-and-data-hygiene.md) | 信任模型、权限矩阵、越权写检测、secret redaction 管道、日志脱敏、路径安全 |
| [25-project-memory-and-knowledge-promotion.md](25-project-memory-and-knowledge-promotion.md) | 四层记忆的 L4：git-tracked 项目决策库、`memory promote` 晋升流、借 Claude Code 索引与体积纪律 |

### 方法论工作区（ai-dev-methodology，workspace-grouped）

编号文档 00–25 是**设计语料库**（原位不动）；P0–P5 流程经以下工作区管理，phase 文档是 gate/索引视图不复制内容：

```text
01-current-state/   项目快照 + project-knowledge/
02-phases/          P0-idea · P1-requirement(缺口) · P2-spec · P3-design · P4-feature(FEAT-001…011)
                    · user-journey · traceability-matrix(骨架) · progress
03-architecture/    指针 → 语料库 11/20/02/03/21 与全部合同
04-decisions/       ADR 台账 = 13 §2.1 D1–D19；新决策自 ADR-020 建档
05-features/        P5 交付目录（随实现开工建 FEAT-XXX/）
```

阶段状态速览（2026-07-10，经 Codex 独立外审一轮修复后）：**P0–P4 gate 全绿**（P1 含 UC-001…009/NFR×9、P2 含 BDD 55 场景 + 17 §3 全量错误码映射、追溯矩阵七列无断链且多归属规则明示；SKIPPED/N/A 均留痕）→ P5 未开始。下一步见 [02-phases/progress.md](02-phases/progress.md)。

---

## 5. 当前范围

### In Scope

- repo-local `.team/` 协作协议
- run/task/claim/path/evidence/review/progress/event 对象模型
- 自主认领任务队列
- 文件锁和 lease/heartbeat
- worktree isolation
- task DAG / context plane / message pool
- progress 派生规则
- 跨 Claude Code / Codex 的 slash command 使用旅途（协议字段预留 Cursor，其 adapter 与验收属 Phase 2，D2）

### Out of Scope for v0.1

- 远端多机器同步
- Web dashboard 的完整 UI
- 自动 merge 到 main
- 权限系统和组织管理
- 完整 SaaS 后端
- 替代 Claude Code / Codex / Cursor 的 AI 编程能力
- 自己读取项目并决定如何拆任务
- 跨 repo 的多仓库协作（M43）
- 密码学完整性 / 拜占庭防御（信任模型 = 合作式 + 事后审计，见 [24](24-security-permissions-and-data-hygiene.md)）
- gateway 执行项目命令或做语义总结（checks 由 agent 跑、memory 压缩由 agent 写）

---

## 6. 当前状态与下一步

**设计层已全部定稿（2026-07-10）**：01–12 已按 14–24 的裁决完成 reconciliation 回写；[13](13-design-audit-and-next-breakdown.md) 是审计与决策账本（D1–D16、M1–M43、失败模式清单）；14–24 是实现合同；adapter 的 Codex 触发经两轮实测定稿（T1 3/3、T2 中文 3/3、T3 误报 0/3、T4 显式 2/2，跨 0.142.5 / 0.144 两个 CLI 版本，[19 §8](19-agent-adapter-pack-claude-codex.md)）。

进入实现前剩两件事，然后按切片开工：

1. ~~Codex 触发实测~~ **两轮全部完成，PROVISIONAL 已解除**（[19 §8.1–8.2](19-agent-adapter-pack-claude-codex.md)；testkit 与原始输出归档于 [testkit-codex-trigger/](testkit-codex-trigger/)）。
2. ~~确认 CLI 定名~~ **已终裁：`sigmarun`**（D12，[22 §6](22-packaging-installation-and-evolution.md)；协议目录维持 `.team/`，文档沿用 `team <cmd>` 记号）。
3. 按 [20](20-c4-l2-l3-component-contracts.md) 包结构起 TS monorepo，按 [05](05-mvp-feature-slices.md) 九切片实现；每片过 [17 §10](17-cli-mcp-contract-and-error-model.md) 测试（并发压测、崩溃注入、失败模式 F1–F5 回归、conformance suite）。
4. 北极星场景端到端走通即 MVP 达成。

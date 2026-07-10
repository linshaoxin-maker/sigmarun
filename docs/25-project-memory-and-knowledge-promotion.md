# 25. Project Memory and Knowledge Promotion

> 日期：2026-07-10
> 状态：v0.1 设计草案（设计定稿随 D19；实现排 P1 首位，不动 MVP 九切片）
> 依据：产品负责人 2026-07-10 提出（"任务交接后某个工具怎么查之前做的决策点"）；[13](13-design-audit-and-next-breakdown.md) M33 邻接、[05](05-mvp-feature-slices.md) Phase 2 "cross-run knowledge promotion" 的落地形态；Claude Code 记忆体系查证（code.claude.com/docs/en/memory，2026-07-10）
> 目标：补上记忆体系的第四层——**跨 run、跨工具、跟 git 走的项目级决策库**。gateway 依旧无智能：筛选与撰写归 agent/人，gateway 只做机械晋升、出处校验与体积纪律。

---

## 1. 四层记忆模型（本文档补最后一层）

| 层 | 载体 | 作用域 | 进 git | 状态 |
|---|---|---|---|---|
| L1 task handoff | `context/tasks/TASK-ID.md` | 任务 → 下游任务 | 否（D4） | 已有（[12](12-context-plane-task-dag-message-pool-memory.md)） |
| L2 run memory | `context/run-memory.md` + messages/decisions | run 内 | 否（D4） | 已有 |
| L3 run 归档 | `team export` 报告 | 事后复盘 | 是（用户提交） | 已有（[16](16-git-worktree-and-team-root.md) §7） |
| **L4 project memory** | **`docs/team/MEMORY.md`** | **跨 run 存活、随 clone 走** | **是** | **本文档** |

没有 L4 的问题：RUN-0001 定的"session 7 天滑动过期"，RUN-0007 的 planning agent 无从得知（run 记忆锁在 `.team/` 里且不进 git）；换机器全丢。

---

## 2. 先例参照：Claude Code 记忆体系（借什么、不借什么）

查证事实（官方文档，2026-07-10）：CLAUDE.md 四层加载（企业→用户→项目→local），会话启动全量加载，**纪律 <200 行**；auto-memory 位于 `~/.claude/projects/<slug>/memory/`，**MEMORY.md 索引每会话只加载前 200 行 / 25KB**，主题文件按需读；**同一 repo 的所有 worktree 共享一份**；进 git 分层（CLAUDE.md 入库 / local 与 auto-memory 不入库）；支持 `@path` import（递归 ≤4 层）；维护纪律 = 去重、更新覆盖旧条、增长即拆分。

| Claude Code 的做法 | 我们借不借 | 落法 |
|---|---|---|
| 索引 + 按需（索引轻、细节延迟读） | **借** | L4 只有一个**条目化索引文件**；细节不新发明载体——每条带 refs 指向 export 归档 / evidence / review 原文 |
| 团队共享进 git、个人态不进 git | **借** | L4 进 git（放 `.team/` 之外）；L1/L2 维持 D4 不入库——分层逻辑同构 |
| `@import` 桥接多工具 | **借** | AGENTS.md/CLAUDE.md 协议段加一行指向 L4；Claude Code 用户可再加 `@docs/team/MEMORY.md` 让其每会话自动入上下文；Codex 侧由 hydrate 注入（§5） |
| <200 行体积纪律 | **借** | 同上限；超限 audit warning，纪律是"更新/合并/淘汰"而非无限追加 |
| worktree 共享一份 | **借**（已有） | [16](16-git-worktree-and-team-root.md) §2 team-root 解析天然保证 |
| **模型自动维护**（自己总结自己存） | **不借** | gateway 无 LLM（13 §5.1 铁律）：撰写归 agent、把关归人、gateway 只做机械落盘（§4） |
| 内容域=编码规范/构建命令等指令 | **不借** | L4 只收**工程决策事实**（ADR-lite），不抢 CLAUDE.md/AGENTS.md 的"给 agent 的指令"地盘（§3.3） |

---

## 3. L4 载体与格式

### 3.1 位置

默认 `docs/team/MEMORY.md`，`project.json.project_memory_path` 可配。**必须在 `.team/` 之外且 git-tracked**（gateway 校验：非 ignored、realpath 在 repo 内——沿用 [24](24-security-permissions-and-data-hygiene.md) §6 路径规则）。D4 一字不改。

### 3.2 条目格式（`team.project_memory.v1`，markdown 载体）

```markdown
# Project Memory
<!-- managed by sigmarun; edit via `team memory promote` / PR review -->

## Architecture
- [MEM-0003] Session expiry is 7-day sliding, not absolute.
  ⟨RUN-0001 · 2026-07-09 · refs: docs/team-runs/RUN-0001/evidence/TASK-0001, MSG-0002⟩
- [MEM-0007] Auth module must not import from src/users directly; go through UserPort.
  ⟨RUN-0004 · 2026-07-10 · refs: docs/team-runs/RUN-0004/reviews/TASK-0012 · supersedes MEM-0002⟩

## Constraints
- [MEM-0005] package-lock.json is regenerated only in release runs.
  ⟨RUN-0002 · … ⟩

## Pitfalls
- [MEM-0006] pytest fixtures in tests/auth leak state if run without -p no:cacheprovider.
  ⟨RUN-0003 · … ⟩
```

规则：每条 = **一句话决策 + 出处戳**（来源 RUN、日期、refs、可选 supersedes）；`MEM-ID` 项目级计数器分配（[17](17-cli-mcp-contract-and-error-model.md) §6，project.lock 保护）；分区固定四个起步（Architecture / Interfaces / Constraints / Pitfalls）；**无 refs 的条目非法**（INV-012 的项目级延伸）。

### 3.3 内容域边界（防和工具记忆抢地盘）

| 内容 | 归属 |
|---|---|
| 工程决策事实（接口约定、过期策略、禁改区、已知坑） | **L4 project memory** |
| 给 agent 的行为指令（编码规范、构建命令、流程规矩） | CLAUDE.md / AGENTS.md（工具自己的体系） |
| run 过程细节 | L1/L2/L3，不上浮 |

---

## 4. 写路径：`team memory promote`（机械晋升，人把关）

```text
team memory promote --run RUN-0001 --from MSG-0002 \
  --entry "Session expiry is 7-day sliding, not absolute." \
  --section Architecture [--supersedes MEM-0002]
```

| 步骤 | 执行者 | 说明 |
|---|---|---|
| 候选发现 | gateway（机械） | `/team-integrate` 收尾时列出本 run 全部 `decision` 类消息与 review findings 作为**候选清单**——只列不选 |
| 筛选与措辞 | **agent / 用户** | 智能活：哪条值得进项目记忆、一句话怎么写 |
| 确认 | **用户** | 晋升项进 **Needs user** 清单（M32）；`--yes` 仅限用户显式批量 |
| 落盘 | gateway（机械） | 校验 refs 存在、redaction 扫描（[24](24-security-permissions-and-data-hygiene.md) §4，进 git 的内容必须干净）、分配 MEM-ID、盖出处戳、追加或按 `--supersedes` 更新；写 `memory_promoted` 事件 |
| 生效 | git | 文件变更走正常 commit/PR——**项目记忆的最终把关就是 code review** |

淘汰与修正同路径：`--supersedes MEM-xxxx` 新条替旧条（旧条移入文件尾部 `## Superseded` 区保留出处，不物理删除）。

---

## 5. 读路径：两条，覆盖两类工具

1. **hydrate 注入（协议内，工具无关）**：`team context hydrate` 的 `must_read` 恒含 project memory 文件（存在时）；`/team-plan` 模板第 2 步"读项目上下文"显式包含它——**规划时就知道历史决策**，这是用户场景（"交接后查决策点"）的正解。
2. **工具原生加载（免费加速）**：AGENTS-SECTION（[19](19-agent-adapter-pack-claude-codex.md) §6）加一行"Project decisions live in docs/team/MEMORY.md — read it before planning or large changes"；Claude Code 用户可在 CLAUDE.md 加 `@docs/team/MEMORY.md`（官方 import 语法）使其每会话自动入上下文。

体积纪律保证读得起：文件 >200 行或 >25KB → status/audit warning（借 Claude Code 同款阈值），提示合并/淘汰。

---

## 6. 审计与事件

| 新增 | 内容 |
|---|---|
| 事件 | `memory_promoted`（payload：mem_id、run_id、from_ref、supersedes?）；`memory_superseded` |
| AUD 规则（归 [18](18-audit-rule-catalog-and-trust-model.md) 编号） | 条目无 refs / refs 失效（error）；文件超 200 行/25KB（warn）；supersedes 指向不存在 MEM-ID（error）；`.team/` 内出现 project memory 文件（error，放错位置） |
| doctor | 检查 project_memory_path 未被 gitignore、格式可解析 |

---

## 7. MVP 边界与实现排期

- **设计随本文档定稿（D19）；实现排 P1 首位（Slice 10）**——不阻塞北极星链路，但对多 run 长期使用是第一优先补强。
- MVP 期间的过渡做法（写进 [00](00-user-guide.md)）：用户手动把关键决策写进 `docs/team/MEMORY.md`（哪怕没有 promote 原语，hydrate 注入与 AGENTS-SECTION 指向在 Slice 4/5 就能生效——**读路径先行，写路径 P1**）。
- 明确不做：gateway 自动摘要晋升（无 LLM）；语义检索（Phase 2 semantic search 归 [05](05-mvp-feature-slices.md)）；跨 repo 记忆（M43 多 repo 属 out of scope）。

---

## 8. MVP/P1 验收场景

| 场景 | 预期 |
|---|---|
| RUN-0007 的 `/team-plan` 在 RUN-0001 结束三周后执行 | plan 产出的 payload context 引用了 MEM-0003（7 天滑动过期），无需人提醒 |
| dispatch 后 hydrate | must_read 含 `docs/team/MEMORY.md` |
| promote 一条无 refs 的条目 | 拒绝（`memory_entry_invalid`） |
| promote 内容命中 secret 模式 | 拒绝（进 git 的内容，redaction 阻断式） |
| 文件长到 210 行 | status 出 warning，提示合并/淘汰 |
| `--supersedes` 生效 | 旧条移入 Superseded 区，MEM-ID 链可追溯 |
| fresh clone 后新 run | project memory 随 git 到位，L4 不丢（对比：L1/L2 本机态按设计丢弃） |

---

## 9. 对现有文档的修订指令

| 文档 | 修订 |
|---|---|
| [02](02-domain-model-and-team-storage.md) | project.json 增 `project_memory_path`（默认 `docs/team/MEMORY.md`）；§4 分层表加 L4 一行（git-tracked，`.team/` 外） |
| [05](05-mvp-feature-slices.md) | Phase 2 "cross-run knowledge promotion" 标注"已由 [25](25-project-memory-and-knowledge-promotion.md) 落地为 P1（Slice 10）" |
| [12](12-context-plane-task-dag-message-pool-memory.md) | §9 边界表加 L4 行（权威、git-tracked、经 promote 追加）；§8 hydrate must_read 恒含 project memory |
| [17](17-cli-mcp-contract-and-error-model.md) | §1 增 `team memory promote`（写，project.lock + 目标文件）与 `memory_entry_invalid` reason code |
| [19](19-agent-adapter-pack-claude-codex.md) | AGENTS-SECTION 加指向行；`/team-plan` 模板第 2 步显式读 project memory；integrate 模板收尾列晋升候选 |
| [00](00-user-guide.md) | 新增"项目记忆"小节（已随本文档同步） |
| [18](18-audit-rule-catalog-and-trust-model.md) | §6 规则清单收编（编写 AUD 编号时） |

---

## 10. 遗留接口

- promote 的 needs_user 交互细节 → 08 §6.1 Needs user 区块（M32 机制复用）
- MEM 条目的语义检索 → Phase 2 semantic search
- 多 repo 共享记忆 → out of scope（M43）

# FEAT-011 MVP Scope — project memory promote（L4，P1 首位）

> 源：Slice 10 ｜ 锚：UC-009 · BDD-009-01/02/05/06（-03/-04 读路径已随 FEAT-005/006 交付并验证）｜ 合同：25 全文、D19、17 §3 `memory_entry_invalid`、18 #47/48（memory_promoted/superseded）+ AUD-036…040、INV-012 项目级、24 §4/§6

## In（context 包 memory-store + audit 规则批）

- **`memory promote <RUN> --from=<ref[,ref]> --entry="…" --section=<S> [--supersedes MEM-xxxx]`**（25 §4，机械晋升人把关）：
  - 守卫（全部 `memory_entry_invalid`）：entry 非空一句话；section ∈ Architecture/Interfaces/Constraints/Pitfalls；**refs 必填且可解析**（MSG-ID 存在于消息池 / 路径存在——INV-012 项目级）；entry 过 redaction 扫描（进 git 必须干净，命中即拒）；supersedes 目标必须存在。
  - 载体校验（25 §3.1/24 §6）：project_memory_path 在 repo 内、非 .team、未被 gitignore。
  - MEM-ID 项目级计数器（project.lock 内 `next_mem`）；文件缺失即建管理头 + 四分区骨架。
  - 条目 = 一句话 + 出处戳 `⟨RUN · 日期 · refs: … [· supersedes MEM-x]⟩`；`--supersedes`：旧条移入 `## Superseded` 分区保留出处（不物理删）。
  - 事件：`memory_promoted`（mem_id/refs/supersedes）+（如替代）`memory_superseded`。
- **`memory candidates <RUN>`**（25 §4 候选发现，只列不选）：本 run decision 类消息 + review must_fix/major findings 清单。
- **AUD-036…040 落地**（audit 引擎注册位启用，rules_skipped 相应销账）：036 无出处/失效 refs（error）、037 超 200 行/25KB（warn）、038 supersedes 悬空（error）、039 记忆文件误入 .team（error）、040 per-agent 上限绕过（error）。
- status 风险面：记忆文件超限 → risk（BDD-009-05 的 status 半场；audit 半场即 037）。
- doctor +1 检查：project_memory_path 被 gitignore 时 fail（25 §6）。

## Out（书面）

- gateway 自动摘要晋升（无 LLM，25 §7 明确不做）；语义检索（Phase 2）；跨 repo 记忆（M43）。
- CLAUDE.md `@import` 接线（用户手工，00 号已记）。
- 归档锚点 refs 校验（docs/team-runs/… 深链）：MVP 校验到路径存在层。

## 读路径复验（不重复实现）

- BDD-009-04（hydrate 恒含 L4）：FEAT-005 `includes the L4 project memory…` 用例已锁。
- BDD-009-03（新 run 规划继承）：/team-plan 模板第 2 步已含（FEAT-006 交付文本）。

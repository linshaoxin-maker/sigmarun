# FEAT-006 MVP Scope — dispatch 端到端（--as/--task/--role/--loop）

> 源：05 Slice 5 ｜ 锚：UC-003/004 全链（起名/点名/专职/连跑）+ 15 §3.3 claimed→working + 16 §3 worktree + 19 适配器包 ｜ 合同：16 §3.1–3.5、18 #13/42/43、19 §1–6、D5/D12/D17、22 §MVP 交付物

## In

- **`worktree register <RUN> <TASK> --agent --path --branch`**（dispatch 包）：校验（claim owner、task=claimed、路径存在且为 git worktree、branch 符合 `team/<RUN>/<TASK>-<slug>` 规范）→ worktrees.json（team.worktrees.v1，WT-<TASK>，base_commit 由 `git rev-parse HEAD` 机械采集）→ task claimed→working（task.json+list）→ 事件 `worktree_created`+`task_started`。
- **`worktree adopt <RUN> <TASK> --agent`**（16 §3.5 续做半场）：abandoned→active、owner 转移（原 owner 入 previous_owner_agent_ids）、claimed→working；事件 `worktree_adopted`（payload.previous_owner）+`task_started`。
- **release/reclaim 联动**（16 §3.5 回收半场，扩展 FEAT-004 的 applyReclaim）：active worktree entry → `abandoned`、owner 清空转历史；previous_attempts 条目携带 worktree_path/branch（15 §5.3 hydrate 可见）。
- **`run show <RUN>`**（只读）：run 概要 + 任务 rollup + 状态计数——**从 FEAT-008 查询面提前**（改派理由：19 §3.2 dispatch 流程第 1 步硬依赖；其余查询命令 run list/task list/show/evidence show 仍归 FEAT-008）。
- **新包 `@sigmarun/adapters`** + `adapter install --tool claude-code|codex [--update]`（22 §133，MVP 仅 repo scope）：
  - claude-code → `.claude/commands/team-{plan,dispatch,publish}.md`（19 §3.1/3.2 全文模板 + RULES 十诫逐字块，含 --as/--task/--role/--loop 语义与 D5 单任务停机第 8/10 条）。
  - codex → `.codex/skills/team-run-dispatch/SKILL.md`（19 §4.1，触发词 D13 实测定稿版）。
  - 两工具均追加 `shared/AGENTS-SECTION.md` 进仓库 `AGENTS.md`（标记对幂等，重装不重复）。
  - 文件头 `template_version` 注释；重装默认跳过 + 警告，`--update` 覆盖（漂移检测归 doctor/P1）。
- `--loop` 连跑语义按 D5 落在模板第 10 步（adapter 侧循环，gateway 永远单任务返回）——不新增 gateway 面。

## Out（书面）

- `worktree remove/清理`、AUD-029 巡检 → FEAT-008（audit/repair 面）。
- team-status/team-review/team-verify/team-integrate 等其余 9 个模板 → 随其 gateway 命令的 FEAT（008/009/010）交付时补装。
- user scope 安装、模板版本漂移 doctor 检查、npm 打包 → 22 §Phase 1（P1）。
- conformance suite（19 §9/M38）→ FEAT-008 后统一挂 CI。
- Codex 真机触发复测 → 已有 D13 两轮数据（19 §8），模板文本未改触发面，不复跑。

## 命名声明（非偏离）

19 号模板全文以通用名 `team` 书写；实现 CLI 依 D12 定名 `sigmarun`——安装产物中的命令一律为 `sigmarun ...`，slash 命令名保持 `/team-*`（用户面不变）。

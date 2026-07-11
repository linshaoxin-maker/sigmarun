# 00. 用户使用手册（User Guide）

> 日期：2026-07-11
> 状态：v0.2（随实现迭代；本文是未来实现仓库 README 的底稿）
> 读者：**使用者**，不是协议设计者。只讲如何使用，以及人、coding agent、gateway 各自负责什么。
> 命名：本文使用 `sigmarun`（旧设计文档中的 `team <cmd>` 等同于 `sigmarun <cmd>`，D12）。

---

## 1. 这是什么

**sigmarun 让你在同一个项目中同时使用多个 Claude Code、Codex 窗口，像一个有任务队列、工作隔离和质量门禁的小型软件团队一样协作。**

它由四个层次组成：

| 层次 | 负责什么 | 用户如何感知 |
|---|---|---|
| Claude Code / Codex | 理解项目、拆任务、写代码、审查、运行测试 | 你与之对话的 AI 编程工具 |
| `/team-*` 命令或 Skill | 固定 AI 的协作步骤，要求它调用 gateway | 你在 AI 对话框中输入的主要操作面 |
| `sigmarun` gateway CLI | 分配 ID、导入任务、原子认领、冲突检查、证据门禁、状态推进和审计 | 多数时候由 AI 调用；排障时你也可以直接调用 |
| `.team/` | 当前项目的本地协作事实源 | 通常不直接编辑；状态、证据和事件都可回查 |

sigmarun **不是新的 AI**，不会自己理解需求或写代码；这些工作仍由 Claude Code、Codex 等 coding agent 完成。它也**不依赖中心化网站或云服务**。后续可选 dashboard 只是 `.team/` 的只读观察面，不负责拆任务、认领或修改状态。

一句话边界：

> Coding agent 出智能，Skill 固定流程，gateway 出秩序，`.team/` 保存事实。

---

## 2. 安装与项目接入

### 2.1 安装 CLI

要求 Node.js 20+ 和 Git。npm 正式发布后：

```bash
npm install -g sigmarun
```

从源码仓库试用当前版本：

```bash
npm install
npm run release
npm install -g ./release
```

### 2.2 初始化项目

进入要协作的 Git 项目：

```bash
cd 你的项目
sigmarun init
```

`init` 只负责创建 `.team/`、写入项目级配置并检查 `.gitignore`。它不安装 Claude Code 或 Codex 的命令模板。

### 2.3 安装工具适配器

只安装你实际使用的工具：

```bash
sigmarun adapter install --tool=claude-code
sigmarun adapter install --tool=codex
```

adapter 会在当前项目中安装 `/team-*` command 或 Skill，并在 `AGENTS.md` 中加入受管理的协议说明。adapter 文件属于项目协作配置，可以审阅后提交到 Git；`.team/` 本身不提交。

最后运行：

```bash
sigmarun doctor
```

打开 Claude Code 或 Codex，输入 `/team-` 能看到对应命令，即完成项目接入。

---

## 3. 先记住三个对象

```text
Project
  RUN-0001       一次项目目标，例如“实现 auth phase 1”
    TASK-0001    可独立领取、验证和审查的工程任务
    TASK-0002
    TASK-0003
```

- `RUN-ID` 是跨工具、跨窗口协作的入口。
- `TASK-ID` 是单个 agent 的工作单元。
- `CLAIM-ID`、`AGENT-ID`、锁和租约主要用于 gateway 审计；普通用户通常不需要手工管理。

---

## 4. 一个 feature 的完整旅途

### 4.1 规划：让 coding agent 拆任务

在任意一个已安装 adapter 的 AI 窗口输入：

```text
/team-plan "实现 auth phase 1"
```

这个过程分两层：

1. Claude Code 或 Codex 阅读项目、历史记忆和测试约定，拆出任务 DAG。
2. sigmarun 校验 agent 生成的 payload，分配 `RUN-ID`、`TASK-ID`，记录为 draft。

示例输出：

```text
Created RUN-0001 (draft): Implement auth phase 1
TASK-0001 Add auth domain model
TASK-0002 Add session repository   (depends on TASK-0001)
TASK-0003 Add auth API tests       (depends on TASK-0001)
Next: /team-publish RUN-0001
```

sigmarun 不负责判断应该拆成哪些任务；它只负责验证格式、登记任务图并返回稳定 ID。

### 4.2 放行：发布任务队列

先检查目标、依赖、验收标准和允许修改的路径。确认后：

```text
/team-publish RUN-0001
```

发布是显式的人类控制点。未发布的 draft task 不能被其他窗口领取。

如果任务图只需局部调整，可通过 `sigmarun task add`、`sigmarun task cancel` 做受控变更；如果目标或拆解方式需要整体重做，则取消或保留当前 draft RUN，再执行一次 `/team-plan` 创建新 RUN。当前版本没有静默覆盖既有 RUN 的 `run amend`。不要直接编辑 `.team/`。

### 4.3 分发：让多个实现窗口领取任务

分别在 Claude Code、Codex 窗口中输入：

```text
# Codex 窗口
/team-dispatch RUN-0001 --as 左窗

# Claude Code 窗口
/team-dispatch RUN-0001 --as 右窗
```

每个窗口会依次：

1. 注册自己的 agent 身份。
2. 通过 gateway 原子认领一个可执行的 `TASK-ID`。
3. 读取该任务的依赖、消息、上游 handoff 和项目记忆。
4. 按 gateway 建议执行 `git worktree add`，再让 gateway 校验并登记 worktree。
5. 在隔离 worktree 中写代码、跑测试、提交小步 commit。
6. 向 gateway 提交 evidence，然后停止并向你汇报。

这里的责任边界是：**worktree 由 coding agent 创建，sigmarun gateway 只建议、校验和登记，不执行 `git worktree add`。**

默认一个窗口完成一个任务就停下来。允许它连续领取任务时使用：

```text
/team-dispatch RUN-0001 --as 左窗 --loop
```

想指定任务：

```text
/team-dispatch RUN-0001 --as 左窗 --task TASK-0003
```

如果任务依赖未完成、已被领取或路径冲突，窗口会返回 gateway 的结构化原因并停止，不会擅自换任务。

### 4.4 观察：随时查看项目进展

```text
/team-status RUN-0001
```

你会看到：

- 总体进度与各状态任务数量；
- 每个 agent 正在处理的 `TASK-ID`；
- stale lease、路径冲突、阻塞和开放问题；
- Ready for review / Ready for verify；
- Needs user，以及每项建议的下一步命令。

需要持续观察时：

```bash
sigmarun watch RUN-0001
```

`watch` 每轮读取同一份 `.team/` 状态、执行租约回收检查并刷新进度。未来 dashboard 读取相同事实源，只提供更直观的 RUN、任务 DAG、agent、改动文件、风险和事件视图，不增加写入路径。

### 4.5 提交：实现完成不等于任务完成

实现 agent 必须提交 evidence，其中至少包含：

- 实际修改的文件和 commit；
- 执行过的命令、退出码和输出引用；
- 每条 acceptance criterion 的对应结果；
- 已读取的上下文、遗留风险和给下游的 handoff。

提交成功后任务进入 `submitted`，等待独立审查。agent 不能只在聊天里说“完成了”，也不能自行把任务标记为 done。

### 4.6 审查：独立 reviewer 检查实现

当 `/team-status` 显示 Ready for review 后，在一个没有实现过该任务的窗口中运行：

```text
/team-review RUN-0001 TASK-0003 --as 审查员
```

reviewer 会检查 diff、evidence、验收标准、错误路径、测试和越界改动，然后选择：

- `approve`：进入独立验证；
- `request changes`：记录 finding，任务返回修改流程。

任何 agent 都不能审查或批准自己曾经拥有的任务。MVP 默认不要求 reviewer 窗口从 RUN 开始一直等待；需要审查时再启动即可。

### 4.7 验证：独立 verifier 重新运行检查

review 通过不等于验证通过。使用另一个未拥有该任务的窗口：

```text
/team-verify RUN-0001 TASK-0003 --as 验证员
```

verifier 必须亲自运行 build、focused tests、regression tests 和 scope check，并向 gateway 提交验证记录。通过后任务进入 `verified`；失败则回到修改流程，并保留失败证据。

### 4.8 集成：agent 执行 Git，gateway 记录结果

所有准备集成的任务 verified 后：

```text
/team-integrate RUN-0001
```

integrator agent 会：

1. 从 gateway 获取确定性的集成顺序和 integration branch 建议。
2. 自己执行 `git checkout`、`git merge --no-ff` 和必要的冲突处理。
3. 每次 merge 后运行检查，并把 merge commit 或失败原因登记到 gateway。
4. 运行 run 级全量验证，生成 `integration.md` 和 `report.md`。

sigmarun gateway 不替 agent 执行 Git merge，也永远不自动合入 main。最终由你审阅 integration branch 和报告，然后发 PR 或手工合并。

需要留档时：

```bash
sigmarun export RUN-0001
```

导出物经过脱敏检查后写入 `docs/team-runs/`，由你审阅并决定是否提交。

---

## 5. 谁在什么时候行动

| 阶段 | 主要行动者 | 用户是否需要介入 |
|---|---|---|
| Plan | planning agent 拆任务，gateway 导入 | 检查任务图 |
| Publish | gateway 发布 ready queue | 必须明确放行 |
| Dispatch / Execute | implementer agent | 启动需要的窗口；处理提问和敏感路径批准 |
| Submit | implementer agent + gateway evidence gate | 通常只看汇报 |
| Review | 独立 reviewer agent | 在 Ready for review 时启动 reviewer |
| Verify | 独立 verifier agent | 在 Ready for verify 时启动 verifier |
| Integrate | integrator agent + gateway 记录 | 审阅报告，决定是否发 PR |
| Observe | status / watch / 可选 dashboard | 任意时候查看，不改变状态 |

MVP 是“多窗口 gateway”形态：用户负责打开 coding-agent 窗口，sigmarun 不负责启动或托管 Claude Code、Codex 进程。自动拉起和调度进程属于后续 local orchestrator 能力。

---

## 6. 多 RUN、变更与项目记忆

| 你想做的事 | 推荐动作 | 规则 |
|---|---|---|
| 再做一个独立目标 | `/team-plan "新目标"` | 每个目标一个 RUN，可并行存在 |
| 避免重复计划 | 正常重新导入即可 | gateway 用计划指纹阻止重复导入 |
| 两个 RUN 修改相同路径 | 查看 publish 警告；必要时启用 block policy | 默认警告，可配置为禁止跨 RUN 路径重叠 |
| 暂停整个 RUN | `sigmarun run pause RUN-0001` | 已有事实保留，停止新的正常推进 |
| 恢复 RUN | `sigmarun run resume RUN-0001` | 从现有队列继续 |
| 添加或取消任务 | `sigmarun task add` / `sigmarun task cancel` | 通过 gateway 记录变更，不直接改账本 |
| 目标发生根本变化 | 创建新 RUN | 不把另一项工作悄悄塞进原 RUN |

每个 RUN 的问题、决定和 handoff 进入 message pool 与 run memory。值得长期保留的结论可以通过 `sigmarun memory promote` 晋升到 `docs/team/MEMORY.md`。该文件进入 Git，后续 planning 和 dispatch 会读取它；`.team/` 的运行时事实仍保持本机本地。

---

## 7. 为什么不会互相踩脚

| 防线 | 防止什么 | 机制 |
|---|---|---|
| 原子认领 | 两个窗口领取同一个任务 | `claim-next` 在 run lock 内完成选择和写入 |
| 任务租约 | 挂掉的窗口永久占住任务 | heartbeat 续租，过期后可惰性回收或显式 reclaim |
| 路径占用 | 两个任务并行修改同一范围 | claim 时检查 `paths.allow` 与现有 path claims |
| 身份上限 | 一个窗口囤积多个实现任务 | 一个 agent 默认同时只能持有一个实现任务 |
| Evidence gate | agent 口头宣布完成 | 必须提交可校验的 evidence |
| 独立 review / verify | 自审、自证和错误传递 | owner 不能审批或独立验证自己的任务 |
| 事件与审计 | 状态文件被绕过或半写入 | 事件序列、版本号、audit 和 repair 对账 |

---

## 8. 出问题时怎么恢复

| 症状 | 常见原因 | 动作 |
|---|---|---|
| 领不到任务 | 队列为空、依赖未完成、路径冲突、RUN paused | 查看返回的 `code` / `next_actions`，再看 `/team-status` |
| 任务长期显示被某窗口占用 | agent 退出或租约过期 | 等 watch/下一次 claim 惰性回收，或 `sigmarun reclaim RUN TASK` |
| 上一个 agent 留下未完成 worktree | 任务被回收 | 新 agent 选择 `worktree adopt` 继续，或创建新 attempt |
| review 要求修改 | finding 已写入 message pool | 原实现者或新 implementer 重新 dispatch/resume，修改后再次 submit |
| 想追踪某个任务 | 需要完整事实 | `/team-task RUN TASK`、`/team-evidence RUN TASK` |
| 怀疑账本不一致 | 非正常退出或手工改动 | `sigmarun audit run RUN`；确认后执行 `sigmarun repair RUN` |
| 误删 `.team/` | 本地事实源被删除 | 当前版本不能从 Git 自动恢复；保留的 export 只能用于审计留档，不能完整恢复运行态 |
| 换机器或 fresh clone | `.team/` 不进 Git | 当前版本需创建新运行态；跨机器同步属于后续能力 |

---

## 9. 命令速查

普通用户主要使用 slash commands：

```text
规划     /team-plan "<目标>" [--mode feature|debug|review]
放行     /team-publish <RUN>
干活     /team-dispatch <RUN> [--as <窗口名>] [--task <TASK>] [--loop]
观察     /team-runs · /team-status <RUN> · /team-tasks <RUN>
细节     /team-task <RUN> <TASK> · /team-evidence <RUN> <TASK>
门禁     /team-review <RUN> [TASK] · /team-verify <RUN> [TASK]
收尾     /team-integrate <RUN>
```

项目维护和排障使用 CLI：

```text
项目     sigmarun init · adapter install · doctor
运行     sigmarun run show|list|pause|resume|cancel|archive
任务     sigmarun task show|add|cancel|publish
观察     sigmarun status|watch · worktree list · graph show
恢复     sigmarun reclaim|resume|unblock · audit run · repair
留档     sigmarun report|export · memory candidates|promote
```

`claim-next`、`heartbeat`、`worktree register`、`submit`、`review claim`、`verify submit`、`integrate record` 是 adapter 调用的 gateway 原语。普通用户通常不需要手工组合它们。

完整命令契约见 [04 §1.1](04-command-workflows.md)（slash 面）与 [17 §1](17-cli-mcp-contract-and-error-model.md)（CLI 面）。

---

## 10. 当前边界

- **单机事实源**：`.team/` 是本机协作账本，跨机器/远端同步属于后续版本。
- **首发支持 Claude Code + Codex**：Cursor 等工具后续接入同一 gateway 协议。
- **不托管 agent 进程**：MVP 不自动打开 Claude Code、Codex 或 Cursor；用户自己启动窗口。
- **不自动合 main**：integrator agent 只生成 integration branch 和报告，最终合入由用户决定。
- **dashboard 只读**：可选 dashboard 只展示 RUN、DAG、agent、文件、风险、消息和事件，不写 `.team/`。
- **合作式信任 + 事后审计**：目标是约束 AI 的失误、遗忘和越界，不防御拥有本机文件权限的蓄意恶意进程。

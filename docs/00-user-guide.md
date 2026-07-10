# 00. 用户使用手册（User Guide）

> 日期：2026-07-10
> 状态：v0.1（随实现迭代；本文是未来实现仓库 README 的底稿）
> 读者：**使用者**，不是协议设计者。设计细节一概不讲，只讲怎么用。
> 命名：本文用真名 `sigmarun`（设计文档 01–24 中的 `team <cmd>` 记号 ≡ `sigmarun <cmd>`，D12）。

---

## 1. 这是什么

**sigmarun 让你同时开好几个 AI 编程窗口（Claude Code、Codex）像一个小团队一样干同一个项目，而不互相踩脚。**

它由三部分组成，都装在你自己的机器上：

| 部分 | 是什么 | 你怎么感知它 |
|---|---|---|
| `sigmarun` CLI | 一个命令行工具（npm 安装） | 偶尔在终端敲，多数时候是 AI 在替你敲 |
| `/team-*` 斜杠命令 | 装进 Claude Code / Codex 的一组命令 | 你在对话框里敲的就是它们 |
| `.team/` 目录 | 项目里的协作账本（不进 git） | 基本不用碰，出问题时它是唯一事实 |

**它不是**：不是新的 AI（拆任务、写代码、审代码全是 Claude/Codex 自己的本事）；不是网站或 App（没有界面要学）；不是云服务（全部本地，代码不出机器）。

---

## 2. 安装（一次）

```bash
npm i -g sigmarun      # 装 CLI
cd 你的项目
sigmarun init          # 生成 .team/、装好 /team-* 命令、往 AGENTS.md 加一段协议说明
sigmarun doctor        # 自检：git、锁、命令都就绪了吗
```

装完打开 Claude Code 或 Codex，输入 `/team-` 能看到补全，就绪。

---

## 3. 第一次使用：一个 feature 的完整走法

### ① 拆任务（1 个窗口）

```text
/team-plan "实现 auth phase 1"
```

Claude 读你的代码库，拆出一张任务表（每个任务带目标、验收标准、允许改动的文件范围、依赖关系），返回：

```text
Created RUN-0001 (draft): Implement auth phase 1
TASK-0001 Add auth domain model
TASK-0002 Add session repository   (depends on TASK-0001)
TASK-0003 Add auth API tests       (depends on TASK-0001)
Next: /team-publish RUN-0001
```

### ② 你放行

看一眼拆得对不对。不满意就直接跟它说哪里要改，改完再：

```text
/team-publish RUN-0001
```

### ③ 开几个窗口一起干（产品的核心时刻）

给每个窗口**起个名字**，让它们去领活：

```text
# Codex 窗口 1
/team-dispatch RUN-0001 --as 左窗

# Claude Code 窗口 2
/team-dispatch RUN-0001 --as 右窗

# 窗口 3 当专职审查员
/team-dispatch RUN-0001 --as 审查员 --role reviewer
```

每个窗口自己去队列里领任务、开自己的隔离工作区（git worktree）、写代码、跑测试、交证据。**默认干完一个任务就停下来向你汇报**，你点头才继续（想让它连续干：加 `--loop`）。

**想指定谁干什么？** 窗口有名字就能点名：

```text
/team-dispatch RUN-0001 --as 左窗 --task TASK-0003
```

左窗就去领 TASK-0003；如果这个任务已被别人领了/依赖没好/文件范围冲突，它会告诉你确切原因，**不会**自作主张换一个干。

### ④ 你当监工

```text
/team-status RUN-0001
```

能看到：进度百分比、每个窗口在干哪个任务、风险（谁掉线了、哪两个任务抢文件）、**"等你处理"清单**——要你批准的敏感路径、agent 提的问题、停下来等确认的窗口，每项都带一条可以直接复制的命令。

懒得反复敲？终端挂一个巡检器：

```bash
sigmarun watch RUN-0001    # 每 30 秒刷一次，顺带自动回收挂掉的任务
```

### ⑤ 审查与收尾

实现窗口交活后，审查员窗口会自动领到 review 工作（或者你手动 `/team-review RUN-0001 TASK-0003`）。**任何窗口都不能审批自己写的代码**，这是死规矩。全部通过后：

```text
/team-integrate RUN-0001   # 按依赖顺序合成一个 integration 分支 + 集成报告
```

**合进 main 永远是你自己发 PR**，工具不代劳。要留档：`sigmarun export --run RUN-0001`，出一份脱敏报告放进 `docs/` 提交。

---

## 4. 多窗口、多计划的规矩

| 你想做的事 | 怎么做 | 背后的规矩 |
|---|---|---|
| 再来一个新目标 | 直接再 `/team-plan "新目标"` | **每次 plan = 一个新 RUN**，两个 RUN 并行没问题 |
| 手滑把同一个计划跑两次 | 不用担心 | gateway 对计划算指纹，重复导入会被拦下并告诉你已有的 RUN 编号 |
| 两个 RUN 要改同一片文件 | 默认：发布第二个时**警告**你 | 想要硬保险：把 `cross_run_path_policy` 设为 `block`，直接拦住 |
| 中途改需求 | 目前：砍掉不要的任务（`/team-tasks` 里找到后 cancel）或开新 RUN | 增量改计划（run amend）在路线图上 |
| 同一个窗口重复敲 dispatch | 没事 | 窗口按名字认身份，同名 = 同一个身份，一个身份同时只能持有一个任务 |
| 让某窗口专职审查 | `--role reviewer` | 它只领 review 工作，不写代码 |

---

### 跨 run 的决策去哪了？——项目记忆

每个 run 收尾时，值得留下的决策（"session 用 7 天滑动过期""auth 不许直接 import users"）可以**晋升**进 `docs/team/MEMORY.md`——它**进 git、跟着 clone 走**，之后每个新 run 的规划、每个任务的上下文都会自动带上它：换工具、换机器、隔一个月接手，决策都不丢。晋升要经你确认（出现在 Needs user 清单），每条都带出处（哪个 RUN、什么证据）可回查；过时了用新条替换旧条，历史仍可追溯。MVP 期间没有晋升命令也不要紧——直接手写这个文件，读取链路即刻生效。

## 5. 为什么不会乱（锁的大白话）

你最该担心的三件事——**抢同一个任务、改同一批文件、重复跑**——分别被这几层挡住：

| 层 | 挡什么 | 机制 |
|---|---|---|
| 任务租约 | 两个窗口领到同一个任务 | 领任务是**原子操作**（文件锁保护），领到就有 30 分钟租约，干活自动续 |
| 路径占用 | 两个任务同时改同一片文件 | 每个任务声明文件范围，范围重叠的任务**领不出来**，直到先占者交活 |
| 身份上限 | 一个窗口囤积任务 | 一个窗口（按名字认）同时最多 1 个任务 |
| 计划指纹 | 同一份计划跑两遍 | 重复导入直接拦下 |
| 防篡改对账 | 有人绕过工具直接改账本 | 每个状态文件带版本号、事件流带连续序号，改了就会被审计抓到 |

**窗口挂了怎么办**：任务不会死锁——租约过期 90 分钟后自动回收、放回队列，而且**带着"干到哪了"的快照**（改了哪些文件、最后的进度），下一个领到的窗口可以选择接着干或重来。

**"做完了"怎么算数**：窗口嘴上说完成不算——必须交上证据（测试命令的真实输出、验收标准逐条对照），过不了机器校验就交不上去；交上去还要过另一个窗口的 review。所以你看到 status 里的"done"，是可以信的。

---

## 6. 需要你出手的时刻

这些事工具故意留给人，都会出现在 `/team-status` 的 **Needs user** 清单里，带着可复制的命令：

| 时刻 | 你做什么 |
|---|---|
| 计划拆完 | 看一眼，`/team-publish` 放行 |
| 窗口干完一个任务停下 | 说"继续"，或让它换角色 |
| agent 要改敏感路径（如共享模块） | `sigmarun approve-paths ...` 批准或拒绝 |
| agent 提了问题 / 卡住了 | 在那个窗口里直接回答它 |
| 集成完成 | 自己发 PR 合 main |

---

## 7. 出问题速查

| 症状 | 一句话原因 | 动作 |
|---|---|---|
| 某窗口领不到任务 | 队列空 / 依赖没好 / 文件范围被占 | 看它报的原因；`/team-status` 看全局 |
| 任务一直显示有人占着但没动静 | 那个窗口挂了 | 等自动回收，或 `sigmarun reclaim RUN TASK` 立即回收 |
| 想知道某任务到底发生过什么 | — | `/team-task RUN TASK`：全部事实（证据、review、事件时间线） |
| 怀疑账本被谁乱改过 | — | `sigmarun audit RUN`：全链体检，能测也能修（`sigmarun repair`） |
| 误删了 `.team/` | 它不进 git，删了就没了 | 平时 `sigmarun backup --to <repo 外目录>` 留快照 |
| 换了台机器 | `.team/` 是本机状态，不随 git 走 | 跨机协作是后续版本能力；报告可以 export 进 git |

---

## 8. 命令速查（用户级）

```text
规划     /team-plan "<目标>" [--mode feature|debug|review]
放行     /team-publish <RUN>
干活     /team-dispatch <RUN> [--as <窗口名>] [--task <TASK>] [--role reviewer|verifier] [--loop]
看全局   /team-runs · /team-status <RUN> · /team-tasks <RUN>
看细节   /team-task <RUN> <TASK> · /team-evidence <RUN> <TASK>
收尾     /team-review <RUN> <TASK> · /team-verify <RUN> · /team-integrate <RUN>
终端侧   sigmarun init|doctor|watch|audit|repair|reclaim|export|backup
```

完整命令契约见 [04 §1.1](04-command-workflows.md)（slash 面）与 [17 §1](17-cli-mcp-contract-and-error-model.md)（CLI 面）。

---

## 9. 当前边界（诚实声明）

- **单机**：`.team/` 是本机协作账本，跨机器/远端同步是后续版本。
- **首发支持 Claude Code + Codex**：Cursor 等属 Phase 2，协议已预留。
- **不自动合 main**：集成产物是分支 + 报告，合入永远由你决定。
- **信任模型是"合作式 + 事后审计"**：它防的是 AI 的失误、遗忘和越界，不防蓄意作恶的本机进程——账本就在你的文件系统上，最终权限属于你。

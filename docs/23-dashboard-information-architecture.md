# 23. Dashboard Information Architecture（Read-only Viewer）

> 日期：2026-07-09（v0.1 草案）· 2026-07-24（v0.2 定稿：单页三栏 IA + 视觉 token + 高保真 mock）· 2026-07-25（v0.2.1：失败/重试/历史观测点 §4.5、DAG 动态交互升级 §7、侧栏 C–F 新段 §4.⑥）
> 状态：v0.2 —— 对齐 v0.2.4 已落地的 `sigmarun dashboard`（packages/cli/src/dashboard.ts），给出下一版单页的**明确信息架构、逐区域数据字段映射、状态色 token 与实现拆解**。
> 交付物：本文档 + [23-dashboard-mock.html](23-dashboard-mock.html)（纯静态高保真设计稿，内嵌假数据，浏览器直接打开，明暗双主题）。
> 依据：[08](08-core-gateway-capabilities.md) §6.2 dashboard 定位（不可违背）；[15](15-run-task-state-machine-and-lifecycle.md) 状态机；[13](13-design-audit-and-next-breakdown.md) §7 P2 裁剪（DAG 边 MVP 三种）；[12](12-context-plane-task-dag-message-pool-memory.md)（DAG 与 context 是必展对象）；[17](17-cli-mcp-contract-and-error-model.md)（CLI 等价命令与 events 合同）。
> 参考语言：Conductor（per-agent 卡片）、Vibe Kanban（状态看板）、Dagster（DAG + 侧栏详情）、Temporal（事件时间线）、GitHub Actions（极简 DAG）。
>
> **v0.1 → v0.2 的变化**：v0.1 规划的是多页面站点（P0 总览 / P1 run 详情 / P2 task 详情 / P3 messages / P4 audit，A1–A9 聚合）。v0.2.4 实际落地的是零依赖单页 + `/api/state` 轮询,数据面只有 watch/context 两个包的四个只读函数。v0.2 定稿以**单页三栏**为 MVP 形态,原多页树降级为 §11 演进方向;原 §1 硬边界、§7 只读清单原则全部继承（见 §2、§10）。

---

## 1. 定位与硬边界（继承 v0.1，仍然有效）

| # | 边界 | 说明 |
|---|---|---|
| B1 | **纯只读 viewer,无任何写路径** | 不派活、不改状态、不编辑文本;权威入口永远是 slash command → gateway primitive。dashboard.ts 由构造保证:不 import 任何写 primitive,架构测试守护 |
| B2 | 数据只来自只读 read-model 函数 | 现状:`runList` / `statusRun` / `taskList`（@sigmarun/watch）+ `showGraph`（@sigmarun/context）;扩展只能加**只读**函数（§4 数据面） |
| B3 | 不向 `.team/` 写任何缓存、布局或偏好 | 主题偏好等 UI 状态只存浏览器 localStorage（属浏览器,不属 `.team/`） |
| B4 | 允许的交互仅三类 | 查看详情、触发只读刷新、**复制命令文本**（§10 允许清单） |
| B5 | 每个视图都有 CLI 等价命令 | 各区域规格表标注;dashboard 挂了协议照跑 |
| B6 | 派生规则只实现一次 | 状态、needs_user、进度全部来自与 CLI 共库的 read-model;前端不复刻判定逻辑（如"blocks 边未满足"谓词应从 core 导出,而非页面内重写,见 §7） |

注:`statusRun` 会顺手持久化 `progress.json`（delete-and-recompute 的派生文件,[02](02-domain-model-and-team-storage.md) 允许）。这是 read-model 既有行为,不算 dashboard 新增写路径;若要绝对零写,属 watch 侧的独立议题,不由本文档改变。

---

## 2. v0.2 单页信息架构总览

一屏三栏 + 顶栏,信息密度优先,全中文界面,明暗双主题。所有区域消费同一份 `/api/state`（2.5s 轮询）+ 两个按需懒加载端点（§4）。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ① 顶栏  sigmarun · 只读 · team root        [② 需要你 (4)] [数据时刻] [主题] │
├────────────┬──────────────────────────────────────────────┬──────────────────┤
│ ③ 需求清单 │ ⑤ 中栏画布                                   │ ⑥ 详情侧栏       │
│  色带+进度 │   pane 头:RUN 标题·状态·进度·[DAG|任务表]  │   任务档案       │
│  (runs)    │   ┌────────────────────────────────────┐     │   evidence/checks│
│            │   │  DAG:状态着色节点·三种边·点选     │     │   事件时间线      │
│ ④ 窗口/    │   │  联动 ⑥;或切任务表(密表格)       │     │   (Temporal 式)  │
│   agents   │   └────────────────────────────────────┘     │                  │
│  卡片      │                                              │                  │
└────────────┴──────────────────────────────────────────────┴──────────────────┘
     264px                    自适应(min 560px)                    380px
```

| 区域 | 一句话职责 | 回答的用户问题 | 参考语言 |
|---|---|---|---|
| ① 顶栏 | 身份、只读声明、数据新鲜度、主题 | 我看的数据有多新?连接还活着吗? | — |
| ② needs-you 收件箱 | **跨 run** 汇聚一切等人的事,每条带可复制命令 | 我现在必须处理什么?复制哪条命令? | Linear inbox |
| ③ 需求清单 | run 列表,user_state 色带 + 进度,点选切换当前 run | 有哪些需求,各到什么程度,哪个在等我? | Vibe Kanban 泳道卡 |
| ④ agents 卡片 | 当前 run 的窗口:谁在做什么、心跳新鲜度 | 几个窗口活着?谁卡了? | Conductor per-agent 卡 |
| ⑤ DAG 画布 / 任务表 | 任务依赖图,节点=状态色+字形+风险角标;表格为密度视图 | 活儿怎么流的?卡在哪个节点?为什么没人领? | Dagster / GitHub Actions |
| ⑥ 详情侧栏 | 点选任务的档案、evidence checks 矩阵、事件时间线 | 这个任务改了什么、过了几关、经历了什么? | Dagster 侧栏 + Temporal 时间线 |

交互模型(全部只读):左栏点 run → 中栏/右栏切换;中栏点节点或表行 → 右栏渲染该任务;右栏依赖 chip 点击 → 跳选上游任务;一切"命令"只有复制按钮。

---

## 3. 数据面:`/api/state` 现状与扩展

### 3.1 现有 envelope(v0.2.4 已在跑,收件箱/左栏/中栏全靠它,无需新数据)

`GET /api/state` → `Envelope{ ok, message, data }`,`data`:

```
generated_at: ISO 时间戳                    → ① 顶栏数据时刻
runs: [                                     → ③ 需求清单(每 run 一卡)
  run:    { run_id, title, status, mode, lightweight,
            progress_pct,                   → ③ 进度数字
            user_state: {state, detail, command} }   → ③ 色带 + 状态行
  status: {                                 ← statusRun(computeProgress + user_state)
            run_status, computed_at,
            counts: {draft: n, ready: n, …},→ ③ by_status 堆叠微条 · ⑤ pane 头计数
            weight_total, weight_done, progress_pct,  → ⑤ pane 头进度
            risks: [{kind, task_id?, agent_id?, minutes_overdue?, …}], → ⑤ 节点风险角标 · ⑥ 档案风险行
            needs_user: [{kind, task_id?, detail, command}],           → ② 收件箱(全部字段)
            open_questions: n,
            agents: {total, with_claims, stale},      → ④ 汇总行(明细需 §3.2)
            user_state: {state, detail, command} }
  tasks:  [{ task_id, title, type, status, owner_agent_id, depends_on[] }] → ⑤ 任务表 · DAG join
  graph:  { nodes: [{task_id, title, type, status}],                       → ⑤ DAG 节点
            edges: [{edge_id?, from, to, kind, required?}] }               → ⑤ DAG 三种边
]
```

词汇表(全部来自 core/watch,展示层不造词):

- `user_state.state` ∈ `closed | paused | awaiting_publish | awaiting_gates | ready_to_integrate | ready_to_report | needs_you | in_progress | ready_to_work`(progress.ts `deriveUserState`)。
- `needs_user.kind` ∈ `ledger_broken | reclaim_confirm | blocker | blocked_unblock | open_question | approval_pending | awaiting_review | awaiting_verify | stale_owner | awaiting_rework | handoff_unstructured | deps_dead | ready_to_integrate | ready_to_report`(progress.ts;`ledger_broken` 恒排首位,`handoff_unstructured` 恒排同任务 gate 条目之后)。
- task `status` ∈ 13 态(core/state-machine.ts `TASK_STATUSES`);edge `kind` MVP 三种 `blocks | produces_context_for | soft_depends_on`([13](13-design-audit-and-next-breakdown.md) §7)。

### 3.2 需新增的只读聚合(⑥ 侧栏与 ④ 明细的数据缺口)

| 端点(建议) | 复用的 read-model 函数 | 供给区域 | 拉取时机 |
|---|---|---|---|
| `/api/task?run=&task=` | `taskShow` + `evidenceShow`(@sigmarun/watch,已存在);**扩展**:同 handler 顺读 `reviews/TASK-ID/REVIEW-*.json` 与 `verification/VERIFY-*.json`(按 `target.task_id` 过滤)、`listMessages`(@sigmarun/context,已存在,按 task 过滤) | ⑥ 档案(task.json 全量含 **previous_attempts**、claims、worktree)+ evidence 面板 + **评审轮次 + 验证记录 + 消息线程**(§4.⑥ C–F) | 点选任务时懒加载,选中期间随 tick 刷新 |
| `/api/events?run=&task=&since=&limit=` | `readEvents`(@sigmarun/core,已存在;`--since` 即 seq 游标) | ⑥ 事件时间线;顶栏"截至 seq N" | 点选任务时懒加载 + `since` 增量 |
| ④ agents 明细并入 `/api/state` 每 run | `agentList`(@sigmarun/watch,已存在) | ④ per-agent 卡(agent_id、label、tool、role、current_task、gate_kind、last_heartbeat_min、stale) | 随 state 轮询(文件量小) |

以上函数全是既有只读导出;reviews/verification 目录读取是**新增只读读取**(建议在 watch 加 `gateRecords(runId, taskId)` 一并返回两组文件,与 CLI `task show` 未来的 review/verify 段共库,B6),dashboard.ts 新增 import 不破 B1;懒加载避免 state 轮询按任务数放大(runs×tasks 次文件读)。

关键记录形状(实现与 mock 假数据共同的合同,出处为写入端源码):

- `task.previous_attempts[]`(claim-engine `applyReclaim`):`{attempt, agent_id, claim_id, last_heartbeat_at, ended_at, reclaim_reason, worktree_path?, branch?}`;worktree 同时置 `abandoned` 并把 owner 移入 `previous_owner_agent_ids`。
- `REVIEW-<TASK>-<round>.json`(review `submitReview`):`{review_id, round, reviewer_agent_id, evidence_revision, decision: approve|request_changes|block, checklist[], findings[]{severity, message, message_ref?}, scope_check{out_of_scope_files[], verdict}, acceptance_opinion[]}`;**must_fix findings 会镜像为 `request_changes` 消息**(`message_ref` 即闭环入口)。
- `VERIFY-NNNN.json`(verify/integrate):`{verify_id, target, verifier_agent_id, executed_at, checks[]{name, cmd, exit_code, output_ref, status}, gates, verdict: pass|fail, failures_mapped[]}`。

`readEvents` 返回 `events[]: {seq, ts, event, actor:{type,id}, task_id, claim_id, payload}` + `corrupt_lines[]`(账本破损即 ledger 健康信号,直接映射为 ② 的 `ledger_broken` 同源展示)。事件名词汇 = 状态事件(core `EVENT_STATUS` 19 键:task_created→draft … task_done→done)+ 非状态事件(run_*、agent_registered、heartbeat、path_*、worktree_*、memory_*、integration_* 等);时间线全量展示,状态事件按"落点状态"着色(§8)。

---

## 4. 区域规格 × 字段映射

### ① 顶栏

| 元素 | 数据 | 说明 |
|---|---|---|
| 品牌区 | 静态 | `sigmarun` 字标 + 「只读」徽章(常驻,B1 的界面承诺) |
| team root 路径 | 服务端已知(启动参数) | mono 截断显示,title 全路径 |
| 需要你按钮 | `Σ runs[].status.needs_user.length` | 徽标计数,红点=含 error 级(§8 severity);点击开 ② 面板 |
| 数据时刻 | `data.generated_at`(+ 选中任务时 events 最大 `seq`) | 「12:07:31 · seq 214」;只读产品必须诚实标注新鲜度 |
| 刷新指示 | fetch 结果 | 三态:●实时(上次 tick 成功)/ ●滞后(>2 个 tick 失败,黄)/ ●断开(红,「连接断开,重试中…」) |
| 主题切换 | localStorage | 自动(跟系统)/ 亮 / 暗;不写 `.team/`(B3) |

### ② needs-you 收件箱(Linear inbox 式,顶栏下拉面板)

数据:**跨 run** 拼接 `runs[].status.needs_user[]`,零新增接口。排序:severity(§8)降序 → 原数组序(read-model 已把 `ledger_broken` 置顶)。

| 元素 | 字段 | 展示 |
|---|---|---|
| 条目图标 + kind 标签 | `needs_user[].kind` | kind→中文短语 + severity 色图标(如 blocker→「阻塞待答」红;awaiting_review→「等独立评审」紫;handoff_unstructured→「交接欠结构」紫;approval_pending→「路径待批准」琥珀;ready_to_report→「可以收尾」绿) |
| 归属 chips | 外层 run 的 `run_id` + `needs_user[].task_id?` | run chip 恒显(收件箱是跨 run 的);task chip 点击=选中该 run+task 联动 ⑤⑥ |
| 正文 | `detail` | 最多两行,溢出折叠 |
| 命令行 | `command` | mono 一行 + 「复制」按钮(唯一动作,B4);无任何「运行」 |
| 空态 | `needs_user` 全空 | 「没有等你的事 —— 去喝口水」 |

CLI 等价:`sigmarun status <RUN>`(envelope `next_actions` 即首条 command)。

### ③ 需求清单(左栏上段)

数据:`runs[]`(runList 字段 + status.counts)。每 run 一张卡:

| 元素 | 字段 | 展示 |
|---|---|---|
| 左缘色带 3px | `run.user_state.state` | §8 user_state→色 token;卡片的第一视觉信号 |
| 标识行 | `run.run_id` + `run.lightweight` | mono ID + 「轻量/完整」小字 |
| 标题 | `run.title` | 一行截断 |
| 状态行 | `user_state.state`(中文)+ `detail` | 色点 + 短语,如「等你处理 · BLK-021 待答」;detail 一行截断 |
| 进度 | `run.progress_pct` + `status.counts` | 百分比数字 + **by_status 堆叠微条**(4px 高,段色=状态 token,段间 1px 表面缝,hover title 出计数) |
| 选中态 | 前端状态 | accent 描边;默认选 CLI 启动参数指定的 run,否则首个非 closed |

CLI 等价:`sigmarun run list`。

### ④ agents 卡片(左栏下段,Conductor 语言)

数据:§3.2 的 `agentList` 明细;汇总行用现有 `status.agents`。

| 元素 | 字段 | 展示 |
|---|---|---|
| 汇总行 | `agents.total / with_claims / stale` | 「4 窗口 · 3 在干活 · 1 失联」 |
| 卡片标识 | `agent_id`、`label`、`tool` | mono 短 ID + 工具徽标(claude-code/codex)+ role chip(implementer/reviewer/verifier) |
| 在做什么 | `current_task`、`gate_kind` | task chip(点击联动选中);gate 任务标「评审中/验证中」 |
| 心跳 | `last_heartbeat_min`、`stale` | 新鲜度点:绿 <TTL,琥珀+「N 分钟没心跳」= stale;stale 的卡整体降透明度 |

CLI 等价:`sigmarun agent list <RUN>`。

### ⑤ 中栏画布(DAG 默认,任务表可切)

pane 头(常驻):`run.title` + run status pill + `status.progress_pct` 大数字 + `weight_done/weight_total` + 视图切换 [DAG|任务表] + 边图例。

**DAG 视图**规格见 §7。**任务表**(密度视图,Vibe Kanban 的表格化):

| 列 | 字段 | 说明 |
|---|---|---|
| ID | `tasks[].task_id` | mono;行点击联动 ⑥ |
| 标题 | `title` | 截断 |
| 类型 | `type` | 小字 chip(implement/review/verify/…) |
| 状态 | `status` | 状态 pill(色 token + 字形 + 中文,§8) |
| owner | `owner_agent_id` | mono 或「—」 |
| 依赖 | `depends_on[]` | 上游 chip 列表,含未满足标记(上游非 done 时琥珀) |
| 风险 | `status.risks[]` 按 task_id 过滤 | ⏱ stale_lease(+超时分钟)、⛔ blocker 等角标 |

排序:状态机顺序分组(异常置顶)→ task_id。CLI 等价:`sigmarun task list <RUN>` / `sigmarun graph show <RUN>`。

### ⑥ 详情侧栏(Dagster 式,三段折叠)

数据:`/api/task`(§3.2)+ `/api/events`(§3.2)+ 已有 `tasks[]` 行内字段。未选中时空态:「点击 DAG 节点或任务行」+ run 级摘要(user_state.detail)。

**A. 任务档案**

| 元素 | 字段(来源) |
|---|---|
| 头部 | `task_id` + 状态 pill + `type` chip + `title`(tasks[] 行内即可先渲染,详情到达后补全) |
| owner/租约 | `owner_agent_id`;`claims[]` 活跃条目的 `lease_until` 倒计时、`last_heartbeat_at` 新鲜度(taskShow) |
| 目标 | `task.goal / acceptance`(taskShow → task.json) |
| 依赖 | `depends_on[]` chip,点击跳选;未满足标注与 DAG 同谓词 |
| 路径 | `task.paths.allow / requires_approval`(mono 列表;待批准项琥珀 + 对应 ② 条目) |
| 风险 | `status.risks[]` 该 task 的条目逐行(kind + 参数,如「租约超时 12 分钟」) |
| previous_attempts | `task.previous_attempts[]`(有则显示:attempt、原 agent、reclaim 原因) |

**B. Evidence / checks**(evidenceShow;无 evidence 时显示「尚未提交」)

| 元素 | 字段 |
|---|---|
| 版次 | `evidence.revision`(+`history[]` 计数「第 2 版,1 次归档」) |
| checks 矩阵 | `required_checks_results[]`:每行 `name`(mono)+ pass/fail pill;fail 行红且置顶 |
| 改动文件 | `changed_files[]`:mono 路径 + `in_scope=false` 的标「越界」琥珀角标([14](14-evidence-review-verification-contract.md) §2.3) |
| 摘要 | `summary` 段落;`outputs[]` 文件名列表(只列名,不内嵌大日志) |

**C. 评审轮次**(`reviews/TASK-ID/REVIEW-*-NN.json`;"失败→返工→再提交"的完整回路)

| 元素 | 字段 | 展示 |
|---|---|---|
| 轮次卡(每轮一张,逐轮并列不覆盖) | `review_id`、`decision`、`reviewer_agent_id`、`completed_at` | decision pill:通过=绿/要求修改=红/阻塞=红;评审人 chip |
| 版次对照 | `evidence_revision` | 「对 evidence 第 N 版」chip——回答"改完了吗":轮次数 vs 当前 evidence revision |
| findings 列表 | `findings[]{severity, message, message_ref}` | must_fix 红标置顶,建议绿标;`message_ref` chip 链到消息(F 段/收件箱闭环) |
| 越界裁定 | `scope_check.out_of_scope_files[]` | 「越界」标 + mono 文件列表(与 evidence `in_scope` 对照) |
| 进行中提示 | gate claim(review-claims) | 「第 N+1 轮评审进行中 · 评审租约 <AGENT> · 剩 M 分」;submitted 态则「等第 N+1 轮认领」 |

**D. 验证记录**(`verification/VERIFY-*.json` 按 `target.task_id` 过滤)

| 元素 | 字段 | 展示 |
|---|---|---|
| verdict 卡 | `verify_id`、`verdict`、`verifier_agent_id`、`executed_at` | ✓ 通过(深绿)/ ✗ 未过(红) |
| checks 矩阵 | `checks[]{name, exit_code, status}` | mono 命令 + exit code + pass/fail pill(与 evidence checks 同款组件) |
| 失败映射 | `failures_mapped[]` | fail 时逐条列出「哪个验收项挂了」 |
| 等待态 | 无记录 + task `approved` | 「◑ 等独立验证——认领命令在收件箱」(与 ② `awaiting_verify` 同源) |

**E. 重试档案**(`task.previous_attempts[]`;§3.2 形状)

| 元素 | 字段 | 展示 |
|---|---|---|
| 尝试行 | `attempt`、`agent_id`、`reclaim_reason`、`ended_at` | 「↻N <AGENT> 的租约被回收(超时清扫/手动)· 时刻」 |
| 遗留现场 | `worktree_path`、`branch` | 遗留分支 mono + 「worktree 已弃」+ **复制清理命令**(`git worktree remove …`,B4 只复制) |
| 联动 | — | 任务表风险列与 DAG 角标显示 ↻N(§5.5);当前 claim 行标「第 N+1 次尝试」 |

**F. 消息线程**(`context/messages.jsonl` 按 task 过滤;`listMessages`)

| 元素 | 字段 | 展示 |
|---|---|---|
| 消息卡 | `message_id`、`type`、`from_agent_id`、`body`、`in_reply_to` | 左缘色条按 type:blocker/request_changes=红、question=琥珀、answer/handoff=绿;body 两行折叠 |
| 未答状态 | answer 是否存在(与 needs_user 同判定) | 「未答 · 挂了 N 小时」红字;已答则绿「已答」并可展开 answer |
| 闭环 | — | C 段 must_fix 的 `message_ref`、② 收件箱条目、本段消息卡三处同一 `message_id` 互认 |

**G. 事件时间线**(Temporal 语言;readEvents 按 task 过滤)

| 元素 | 字段 | 展示 |
|---|---|---|
| 时间线条目 | `events[]` 逆序(新在上) | 左轨色点(状态事件按 `EVENT_STATUS` 落点状态着色;非状态事件中性灰),点间细线连接 |
| 条目主行 | `event` + `actor` | 事件中文短语(「提交 evidence」「认领评审」)+ actor chip(`agent:AG-02` / `user`) |
| 条目辅行 | `seq`、`ts`、`claim_id`、`payload` | mono `#187 · 12:03:41 · CLAIM-task-0001`;payload 结构化为**中文标注 chips**(版次/轮次/租约至/合并 sha/途径…,未知字段通用键值,`rev_after` 记账字段不入 chips);**点击事件行展开完整格式化 JSON**(含 actor/claim_id 全量,▸/▾ 指示) |
| 断层提示 | `corrupt_lines[]` 非空 | 时间线顶部红条「账本有 N 行不可读」联动 ② `ledger_broken` |
| 查看更多 | `total > shown` | 「共 N 条,复制 `sigmarun events RUN --task=T --limit=0`」(复制,不代跑) |

CLI 等价:`sigmarun task show / evidence show / events / msg list`(reviews/verification 文件读取待 §13 S4 落入 `task show`)。

## 4.5 失败、重试与历史的观测点(v0.2.1 增补)

回答两类此前无处安放的问题:**"这个任务翻过几次车、为什么"** 与 **"完成的旧任务堆在那怎么办"**。

失败/重试回路的四个事实源与其表面:

| 事实 | 源 | 表面 |
|---|---|---|
| 被回收/放弃的尝试 | `task.previous_attempts[]` | DAG 角标与任务表风险列 ↻N;侧栏 E 段;档案 claim 行「第 N+1 次尝试」 |
| 评审打回 | `REVIEW-*` `decision=request_changes` + must_fix | 侧栏 C 段逐轮卡;状态 pill「待返工」;must_fix→消息闭环 |
| 验证失败 | `VERIFY-*` `verdict=fail` + `failures_mapped` | 侧栏 D 段;时间线 `verification_failed` 红点 |
| 全部过程事实 | events 账本(`task_reclaimed`、`changes_requested`、`evidence_invalid`…) | 侧栏 G 时间线(每次失败都有 seq 可指认) |

多风险汇聚:节点角标一个位置显示**最高 severity 图标,多条时显示计数**(hover 列全);任务表风险列并排展示(`⏱ 12m ↻1`)。

历史与"删除"的诚实边界:**模型里没有删除**——账本 append-only,任务终态只有 `done/cancelled`,run 终态 `reported/archived`;任何"清理"都不毁史实。dashboard 相应地只做**收纳与转移**,不做移除:

| 需求 | 观测/交互(全只读) |
|---|---|
| DAG 里完成节点碍眼 | ⑤ 「折叠完成组」开关:`done/integrated/cancelled` 收进一个虚线聚合节点(边去重重定向,点击展开);>50 节点时默认折叠(原演进项提前为手动开关) |
| 任务表历史行堆积 | 「隐藏已收尾」过滤 chip,计数行注明「N/M 项(已收尾折叠——历史不删除,账本可回放)」 |
| 已收尾 run 占左栏 | closed run 排序沉底;数量多时折叠「历史需求」分组(演进) |
| 遗留 worktree/branch | 侧栏 E 段列 abandoned 现场 + 复制 `git worktree remove` 命令;不代执行(N5) |
| 留档与归档 | ② 收件箱的 `ready_to_report`→`sigmarun report`;export/archive 命令属 §10 复制允许清单 |

---

## 5. 布局与响应

| 项 | 规格 |
|---|---|
| 网格 | 顶栏 48px;下方三栏 `264px / minmax(560px,1fr) / 380px`,各自独立滚动(高密度前提) |
| 窄屏退化 | <1200px:右栏变覆盖式抽屉(点选任务滑出);<900px:左栏折叠为顶栏 run 下拉。mock 只做 ≥1200 主形态,退化属实现项 |
| 字号 | 正文 13px/1.55;表格与 meta 12px;pane 头进度数字 20px semibold;ID 一律 `ui-monospace` |
| 间距 | 4px 基数;卡片 padding 10–12px;区块间 12px |
| 主题 | CSS 变量双 token 组(§8);`prefers-color-scheme` 默认 + `data-theme` 手动覆盖 |

---

## 6. 参考语言的具体落点

| 参考 | 借了什么 | 落在 |
|---|---|---|
| Linear inbox | 收件箱=唯一"必须处理"入口:图标+两行摘要+右侧归属;零已读状态(只读产品不落已读) | ② |
| Conductor | per-agent 卡:身份+在做什么+新鲜度一眼齐;diff-first 理念转译为 evidence「改动文件」前置 | ④、⑥B |
| Vibe Kanban | 状态即颜色的看板扫读感 → 压缩为 by_status 堆叠微条 + 状态 pill 表格 | ③、⑤ |
| Dagster | DAG 居中 + 右侧资产详情侧栏的联动范式;节点状态描边着色 | ⑤⑥ |
| Temporal | 事件时间线:seq 编号、actor 归属、事件语义着色、增量游标 | ⑥C |
| GitHub Actions | DAG 极简主义:圆角矩形+连线,不做花哨布局;完成态低调、异常态醒目 | ⑤ |

---

## 7. DAG 视图规格(v0.2 修订)

| 项 | 规格 |
|---|---|
| 数据 | `graph.nodes[]`(status 已由 read-model join,残留 status 字段已被 showGraph 覆盖)+ `edges[]` |
| 布局 | 按 `blocks` 边拓扑分层(左→右),层内按 task_id 升序;同数据永远同图(确定性,继承 v0.1)。>50 节点折叠完成组,属演进项 |
| 节点(168×54) | 状态 tint 底(token 12% 不透明度)+ 1.5px 状态色描边;首行:状态字形 + `task_id`(mono)+ 风险角标;次行:`title` 截断;右下:owner 缩写 chip。**颜色永不孤立承载状态**——字形+文字恒在(§8) |
| draft 节点 | 虚线描边 + 降透明度(「还是计划」的幽灵感,GitHub Actions pending 语言) |
| cancelled 节点 | 灰 token + 标题删除线 |
| 选中态 | accent 2px 外圈 + 阴影;单选,与 ⑥ 联动 |
| `blocks` 边 | 实线 1.5px + 箭头。**未满足**(上游非 `done`,与 claim-next 依赖闸门同谓词,应从 core 导出复用而非前端复刻,B6):琥珀色 + 边中点「等上游」微标——它是「为什么没人领」的可视答案。已满足:中性灰 |
| `produces_context_for` 边 | 短划线(dash 6-4)紫灰;边中点 refs 计数徽标(有 `context_refs` 时) |
| `soft_depends_on` 边 | 点线(dash 2-4)低对比;不参与分层 |
| 图例 | pane 头右侧常驻三种边样例(线型即语义,不靠色相区分——CVD 安全)+「点节点看任务,点边看关系」提示 +「折叠完成组」开关 |
| 风险角标 | `status.risks[]` + `previous_attempts` 折算,落到节点右上:⛔ blocker > ⏱ stale_lease > ↻ 重试;**多条时显示计数**,hover 列全明细 |
| **节点点击** | 选中联动 ⑥ 任务详情;与边选中互斥(v0.2.1) |
| **边点击** | 每条边有 11px 透明命中层;点击 → ⑥ 渲染**关系卡**:kind、from→to 端点 chip(可跳选)、blocks 的闸门判定文案(已满足/未满足及上游当前状态)、`produces_context_for` 的 refs 逐行清单 + hydrate 说明;选中边加粗高亮(v0.2.1) |
| **hover 邻接高亮** | 悬停节点时非邻接节点与边淡出(opacity .18),只操作 class 不重渲染——大图上"看清一条链"的主要手段(v0.2.1) |
| **working 脉动** | `claimed/working` 节点描边 2.5s 呼吸动画,与轮询节拍一致,传达"活着"(v0.2.1) |
| **完成组折叠** | `done/integrated/cancelled` 收进虚线聚合节点「已收尾组 · 点击展开 N 个」;出边按 `kind→to` 去重重定向,来自聚合的 blocks 边视为已满足;refs 徽标随边保留;选中的边若被折叠则清选(§4.5) |
| 交互边界 | 以上全部只读:无拖拽、无编辑、无布局持久化(B3/B4) |
| CLI 等价 | `sigmarun graph show <RUN>` |

---

## 8. 状态色 = 语义色:token 表(v0.2 定稿)

原则:**色相族=语义**,与 dashboard.ts `COLOR` 表同源;明暗两套是同族色相的两组明度取值(暗色不是亮色的自动翻转);状态**永远伴随字形+文字**,颜色不孤立承载语义(色弱安全的底线)。全部数值经 dataviz 色板校验器逐对验证(相邻状态对 CVD ΔE、正常视力 ΔE、对表面对比度 ≥3:1)。

### 8.1 任务状态(13 态 → 8 语义族)

| 语义族 | 覆盖状态 | 字形 | Light | Dark | 相对 COLOR 表 |
|---|---|---|---|---|---|
| 计划 | `draft` | ○ | `#888780` | `#98978f` | 同 |
| 就绪 | `ready` | ◇ | `#ba7517` | `#d68a28` | 同族 |
| 执行 | `claimed` `working` | ▶ | `#15559c` | `#4a90dd` | 微调(原 `#185fa5`,为拉开与评审紫的 CVD 距离) |
| 评审 | `submitted` `reviewing` | ◐ | `#9b4fd0` | `#c793f5` | **修订**(原 `#534ab7` 与执行蓝 protan ΔE 3.2 几乎不可分;新值 9.3,全检通过) |
| 通过 | `approved` | ✓ | `#1d9e75` | `#52d49a` | 同 |
| 完成 | `verified` `integrated` `done` | ✓✓ | `#0f6e56` | `#1f8a66` | 同族(与品牌 accent 呼应) |
| 异常 | `blocked` `changes_requested` | ⛔ | `#a32d2d` | `#f28b82` | 同族(dark 取珊瑚,protan 下仍与完成绿可分) |
| 终止 | `cancelled` | × | `#5f5e5a` | `#7d7c75` | 同 |

用法:pill/节点=token 12% tint 底 + token 描边 + token 文字(而非纯色块+白字——密度更高、暗色不刺眼);进度堆叠微条用实色段。校验残留说明:两个灰族低饱和是**语义本身**(惰性状态读作灰);相邻族最差对均 ≥6(CVD)且全部有字形+文字二次编码,合规。

### 8.2 user_state(run 级色带)与 needs-you severity

| user_state | 色族 | | needs_user kind | severity/色族 |
|---|---|---|---|---|
| `needs_you` | 异常红 | | `ledger_broken` | error·红(恒置顶) |
| `awaiting_publish` `ready_to_work` | 就绪琥珀 | | `blocker` `blocked_unblock` `reclaim_confirm` `stale_owner` `deps_dead` | warn·琥珀→红(等待人裁决) |
| `in_progress` | 执行蓝 | | `open_question` `approval_pending` `awaiting_rework` | warn·琥珀 |
| `awaiting_gates` | 评审紫 | | `awaiting_review` `awaiting_verify` | 评审紫(缺独立第二窗口) |
| | | | `handoff_unstructured` | 评审紫·warn(评审窗口内的交接质量提示,[14](14-evidence-review-verification-contract.md) §2.4/AUD-041;数据源 `evidence_submitted` payload 旗标,恒排同任务 gate 条目之后;task 过窗即静默,长尾归 audit) |
| `ready_to_integrate` `ready_to_report` | 通过绿 | | `ready_to_integrate` `ready_to_report` | 正向绿(顺利收尾) |
| `closed` | 完成深绿 | | | |
| `paused` | 终止灰 | | | |

### 8.3 表面与文字 token(mock 已内嵌,实现照抄)

| token | Light | Dark |
|---|---|---|
| bg / card / 边线 | `#f6f8f7` / `#ffffff` / `#e2e9e6` | `#0d1413` / `#151f1d` / `#26322f` |
| 主文字 / 次文字 / 弱文字 | `#15211f` / `#4d5c58` / `#8a9995` | `#e7eeec` / `#9fb0ab` / `#6b7b76` |
| accent(品牌,选中态/链接,**不作状态色**) | `#0f6e56` | `#5dcaa5` |

---

## 9. 刷新与新鲜度模型(继承现状)

- 2.5s 轮询 `/api/state`;`generated_at` 直接展示为数据时刻,不做乐观更新。
- 懒加载端点(§3.2)在选中期间挂在同一 tick 后串行拉取;`/api/events` 用 `since=<最大已见 seq>` 增量。
- 失败退避:连续失败仅改变顶栏指示(●黄→●红),已渲染数据保留并标注「数据可能过期」;恢复即覆盖。
- 「触发只读刷新」=立即执行一个 tick;不调用任何写 primitive。

---

## 10. 只读边界(继承 v0.1 §7,原文有效)

禁止交互 N1–N8(不派活/不改状态/不编辑/不代跑 sweep/不执行 git 写/不执行粘贴命令/不写 `.team/`/不 import 写 primitive)与「复制命令」允许清单**原样继承 v0.1**(见 git 历史或 [17](17-cli-mcp-contract-and-error-model.md) §1 命令总表);v0.2 补充两条:

- 复制文本只能取自 read-model 输出的 `command`/`next_actions` 字段或 [17](17-cli-mcp-contract-and-error-model.md) 命令总表——收件箱的命令列即 `needs_user[].command` 原样透传,dashboard 不自造命令语法。
- 主题偏好存 localStorage,已读/折叠状态一律不持久化(只读产品无「已读」概念)。

---

## 11. 演进方向(原 v0.1 多页 IA 的去处)

| v0.1 规划 | v0.2 归宿 |
|---|---|
| P0 总览 / P1 run 详情 | 合并为单页(③ 即 P0,⑤⑥ 即 P1) |
| P2 task 详情页 | 压缩为 ⑥ 侧栏;diff 面板(git 事实 A8)、reviews 逐轮面板、context/handoff 面板为侧栏 P2 增强段 |
| P3 messages / open questions | 收件箱只吸收了 needs_user 投影;完整消息线程页仍是未来独立页 |
| P4 audit 报告 | 未落地;`risks[]` 徽标是其索引,点击跳 audit 页属演进项 |
| 方案 B(watch NDJSON 推送) | 仍属 P2;单页轮询已满足 2.5s 新鲜度 |

---

## 12. Mock 交付物说明

[23-dashboard-mock.html](23-dashboard-mock.html):纯静态单文件,零依赖零网络,浏览器直接打开。

- 假数据内嵌为 `MOCK` 对象,**字段名与 §3 的真实 envelope 完全一致**(runs[].run/status/tasks/graph、needs_user、agents、events、evidence)——它同时是前端渲染层的合同样本。
- 场景:3 个 run(完整 run 选中态 · 轻量 run 进行中 · 已收尾 run),10 节点 DAG 覆盖全部 8 语义族与三种边(含未满足 blocks 边、refs 计数)、4 条 needs-you(4 种 severity)、4 agent 卡(含 stale)。侧栏故事覆盖 §4.⑥ 全部 A–G 段:TASK-0004(两轮评审:第 1 轮 request_changes 含 2 条 must_fix→message_ref、第 2 轮进行中;evidence 第 2 版含越界文件)、TASK-0005(previous_attempts 重试档案 + 遗留 worktree 清理命令 + 租约超时,角标计数 2)、TASK-0006(blocker 消息线程未答)、TASK-0002(完整收尾链:评审通过 + VERIFY-0002 验证卡)、TASK-0003(验证 pending 态)。
- 可交互部分:明暗主题切换、收件箱开合、DAG/任务表切换、节点/表行/依赖 chip 点选联动侧栏、**边点击→关系卡(闸门判定/refs 清单)、节点 hover 邻接高亮、working 节点脉动、完成组折叠(聚合节点可展开)、任务表「隐藏已收尾」过滤**、复制按钮;其余静态。
- 不接真数据、不改 dashboard.ts —— 仅设计稿。

---

## 13. 实现拆解(mock → dashboard.ts 单页,供主会话排期)

现状 dashboard.ts ≈150 行(server 40 + PAGE 模板 85)。改造后 PAGE 预计 500–650 行,仍零依赖内联。按依赖顺序切五片,每片独立可交付:

| 片 | 改动块 | 内容 | 量级 |
|---|---|---|---|
| S1 布局+token | `PAGE` 的 `<style>` 全量重写;`COLOR` 常量 → §8 双主题 token 表(status/user_state/severity 三张映射 + data-theme 切换) | 三栏网格、顶栏、卡片/pill/chip 基础组件样式;**采纳 §8.1 的两处色值修订** | 纯 CSS+常量,~200 行,无逻辑风险 |
| S2 左栏+收件箱 | `renderRuns` 重写为色带卡片(user_state+堆叠微条);新增 `renderInbox`(跨 run 拼 `needs_user`)+顶栏三态刷新指示 | 全部消费现有 `/api/state`,零后端改动 | ~120 行前端 |
| S3 DAG 升级 | `drawDag` 重写:分层保留,节点改 tint+描边+字形+风险角标(多条计数)+点选;边按 kind 三样式+未满足判定+**11px 命中层可点**;**hover 邻接淡出、working 脉动、完成组折叠(聚合节点+边去重重定向)**(§7 v0.2.1 行) | 后端:core 导出「blocks 满足」谓词供复用(B6,替代前端 `from.status!=='done'` 硬编码);其余零后端 | ~220 行 SVG 前端 + core 一个纯函数导出 |
| S4 侧栏+新端点 | server 加 `/api/task`、`/api/events` 两个 handler;`/api/task` 聚合 `taskShow`+`evidenceShow`+**新增只读 `gateRecords`(reviews/verification 目录)**+`listMessages`;前端 `renderSidebar` A–G 七段(档案/evidence/评审轮次/验证/重试档案/消息/时间线)+**边关系卡**+选中态管理+懒加载 | 动后端最多的片;除 gateRecords 外均为既有只读函数,handler 各 ~10 行 | ~320 行前端 + ~45 行 server/watch |
| S5 表格+agents+打磨 | 任务表 tab(风险列含 ↻ 重试角标/依赖 chip/**「隐藏已收尾」过滤**)、`agentList` 并入 state 聚合与 ④ 卡片、复制按钮、空态/断连态、窄屏抽屉退化 | `dashboardState` 加一个 `agents` 字段(一行 join) | ~140 行 |

验收基线(每片交付都跑):架构测试(不 import 写 primitive)不红;`/api/state` 合同不破坏既有 `--once`/`--json` 消费者;`.team/` 前后哈希不变(v0.1 §10 零写验证);mock 与实现的视觉差异 ≤ 主题 token 内的舍入。

---

## 14. 遗留接口

- read-model 容器边界与共库方式 → [20](20-c4-l2-l3-component-contracts.md);「blocks 满足」谓词的 core 导出归 S3。
- 风险规则编号与 severity 定稿 → [18](18-audit-rule-catalog-and-trust-model.md)(§8.2 的 severity 映射为暂行)。
- diff 面板(git 事实)、reviews 逐轮、audit 页、watch 推送 → §11 演进项,不入本轮排期。

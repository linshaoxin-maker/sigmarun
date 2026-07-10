# FEAT-005 MVP Scope — Context Plane（DAG/消息/hydrate）

> 源：05 Slice 4 ｜ 锚：Slice 4 验收四条 + UC-009 读路径（D19 继承半场）+ AUD-021/022 + INV-011/012 ｜ 合同：12 §5–8、18 #39、事件目录"不存在 message_posted"声明

## In

- **新包 `@sigmarun/context`**（20 §3 context/memory-store 组件）：deps core+storage。
- `msg post`：追加 `context/messages.jsonl`（12 §6 全字段：message_id MSG-%04d（`next_msg`）、to 路由、type 十枚举、in_reply_to、refs、status open/resolved）；守卫：from 必须已注册、type/body 校验；body secret 扫描 **warn-only**（全量脱敏管道随 FEAT-007）；**不写 events**（INV-011——18 号目录外声明，测试显式锚定）。
- `msg list`：按 --task/--type/--open 过滤；`--open` = 派生开放问题（type=question 且无 in_reply_to 指向它的 answer——M23 派生化裁决）。
- `context hydrate <RUN> <TASK>`：组装 context pack（12 §8 形状）：
  - must_read：task.md → context/run-memory.md → **docs/team/MEMORY.md（存在即含，D19 继承读路径）** → 每条 blocks/produces_context_for 入边上游的 context/tasks/<U>.md 与 evidence/<U>/evidence.md（存在才列）。
  - messages：to=run / to=task:<TASK> / task_id=<TASK>；open_questions 同派生规则；risks：本 task paths.avoid + requires_approval 模板句。
  - previous_attempts 透传（15 §5.3 hydrate 可见）。
  - 写 `context_hydrated` 事件（#39，payload.must_read；actor=--agent 或 user）——AUD-028 对账的上游半场。
- `graph validate <RUN>`：只读体检 task-graph.json——AUD-021 环（防篡改复检）+ AUD-022 悬空边（from/to 不在 nodes 或 task 目录缺失）；error 返回 schema_invalid + 逐条明细。
- `memory update <RUN> --file=<md>`：整文件替换 context/run-memory.md（原子写）；secret 命中 **拒收**（BR-005 精神）；无 `Source:` 出处行 → warn（INV-012 弱化版，硬拒等 L4 promote/FEAT-011）。

## Out（书面）

- submit 侧写 handoff（context/tasks/<TASK>.md、context_ack 对账）→ FEAT-007（Slice 4 验收第 2 条的写半场；AUD-028 完整闭环随之）。
- status 中 blocker 可见（Slice 4 验收第 4 条的展示半场）→ FEAT-008；本 FEAT 交付 `msg list --open` 查询面。
- 语义压缩/`memory update` 的 refs 硬校验、L4 promote → FEAT-011（13 §5.1：gateway 只做机械动作）。
- context-index.json / open-questions.jsonl 物化 → derived（可删重算，M23），MVP 不落盘。

## 验收（Slice 4 四条的本 FEAT 承担面）

1. `graph validate` 检出环与悬空边 ✅（本 FEAT）
2. submit 写 handoff → FEAT-007（hydrate 读半场本 FEAT 就位）
3. 下游 claim 后 hydrate 上游 context ✅（本 FEAT）
4. blocker/question 入池 ✅ + status 展示 → FEAT-008

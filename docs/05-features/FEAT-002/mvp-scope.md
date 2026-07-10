# FEAT-002 MVP 范围定义 — plan 导入（payload → RUN/TASK）

> 源：Slice 2、[09](../../09-team-run-import-payload-schema.md) 全文、D17、UC-001 ｜ 验收锚：BDD-001-01…05、AUD-021（P0-inline）

## 本期交付

- `sigmarun run import <payload.json> [--force]`：校验 `team.plan_payload.v1` → 分配 `RUN-ID`/`TASK-ID`（client_task_key 映射）→ 落盘 run.json / team-task-list.json / task-graph.json / tasks/TASK-XXXX/{task.json,task.md} / plan.md / context/run-memory.md / counters.json → **events 最后追加 = 提交点**（17 §5.3 写序）。
- 校验：09 §8.1 必拒表（空 tasks、重复 key、悬空依赖、缺 title/objective/acceptance、priority/weight 越界、绝对路径/`..`、伪造运行态字段）；09 §8.2 警告（无 paths、无 checks、payload 文本命中 secret 模式——warn-only）。
- **DAG 环检测**（blocks 边，AUD-021 inline 拒绝）；task-graph nodes/edges **不含 status**（13 §5.5）。
- **D17 指纹防重**：规范化 payload 的 sha256 存 `run.json.source.payload_hash`；重复导入拒绝并指向既有 RUN，`--force` 越过。
- **project.lock 短事务**（RUN-ID 分配 + run 目录创建，M19）：mkdir 锁 + 退避重试 + 超时 `lock_timeout` + 简易 stale 接管（>30s）。
- events：`run_created` + `task_created`×N（team.event.v1：seq/actor/rev_after，18 §2/§3）。

## 本期不交付

- publish（FEAT-003；payload 请求 `initial_status: ready` 时本期降级为 draft + warning，书面记录）；run.lock 完整语义与 takeover 事件（FEAT-004）；`team task add`（P1）。

## 合同 backflow（本期发现并回填上游）

- 重复导入需要专属 reason code：**新增 `duplicate_payload`**（exit 6 冲突类）→ 已回填 [17 §3](../../17-cli-mcp-contract-and-error-model.md) 与 [09 §6](../../09-team-run-import-payload-schema.md)（backflow 记录见 self-check）。

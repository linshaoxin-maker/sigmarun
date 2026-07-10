# FEAT-002 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 09 §3–5 payload schema（含默认值 priority 50 / weight 1 / role implementer） | core/payload.ts `PayloadSchema` | 无 |
| 09 §8.1 必拒表 + §9 伪造字段 | `validatePayload`（FORBIDDEN_TASK_FIELDS 扫描） | 无 |
| 09 §8.2 警告（无 paths/无 checks/secret warn-only） | 同上 + storage/redaction | 无 |
| AUD-021 环检测 P0-inline | `findCycle`（DFS，报环路径） | 无 |
| 17 §5.3 写入顺序（events 最后 = 提交点） | run-import.ts 写序：tasks→list→graph→run→plan/memory→counters→events | 无 |
| 17 §6 ID 格式与计数器（project.lock 内分配） | id4 + counters read/bump（writeJsonStateAtomic） | 无 |
| 18 §2 #1/#10、§3 event schema（actor/seq/rev_after） | core/events.ts + run-import 事件段 | 无 |
| 17 §4 锁（退避/超时/stale 接管） | storage/lock.ts | 简化：本期接管不写 lock_takeover 事件（project 级无 run 账本），FEAT-004 落 run.lock 时补全——已在 mvp-scope 声明 |
| D17 指纹防重 | payloadHash（稳定序列化 sha256）+ findDuplicateRun | **backflow**：新增 reason code `duplicate_payload`，已回填 17 §3 / 09 §6 |
| 13 §5.5 graph 无 status | task-graph nodes/edges 生成 | 无 |
| 02 §5 run.json / 03 §3 task-list / 03 §5 task.json 字段 | run-import 各写块 | 无 |

## 测试结果

| 类型 | 通过/总数 | 覆盖率 |
|---|---|---|
| 全套（含 FEAT-001 回归） | 52/52 | 行 93.77% / 分支 80.81%（双达标） |
| RED 基线 | 新增 26 用例先行失败 | — |
| 真机冒烟 | 4/4 步（import→制品→dedup→清单） | — |

## 安全

- Secrets：redaction 模式集为本期交付物（8 类），fixture 命中验证；warn-only 语义符合 24 §4.1。
- SCA：npm audit 仍 BLOCKED（registry 端点，跨 FEAT 待办）；SAST N/A（P1 CI）。

## 代码质量 / 架构守护（inspection）

- 最大文件 run-import.ts ≈ 250 行（<500）✅；最大函数 importRun ≈ 150 行——**超 50 阈值**：单事务写序的线性罗列（拆分会打散提交点语义），豁免记录同 FEAT-001 doctor 先例；FEAT-004 引入 lifecycle 事务助手后重评。
- 依赖方向：payload/run-import 仅 storage+zod；cli 仅 core ✅；无环（import 清单核查）。
- TODO/FIXME：0。

## 偏离与待办

- 见 verification §5（ready 降级 scope cut、回滚 best-effort）。

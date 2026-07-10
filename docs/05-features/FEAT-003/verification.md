# Feature 验证报告：FEAT-003 publish

> 2026-07-10 ｜ 用户可见 ｜ RED 8/8 先行 → GREEN 60/60

## 1. 四可检验

| 项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | `task publish` 返回 published 数 + run 状态 + dispatch 提示；重复发布幂等警告 |
| 可演示 | ✅ | 真机：publish→`published: 1 run_status: active`；再发→`published: 0 warn: already_ready` |
| 可端到端 | ✅ | cli → run.lock 事务 → task.json+task-list 双写 → run 激活 → events 提交点 |
| 可独立上线 | ✅ | 依赖 001/002；发布后队列即可被 FEAT-004 消费 |

## 2. 场景锚

| 锚 | 测试 |
|---|---|
| BDD-002-01 全量发布+激活+事件序 | publish.test `publishes all draft tasks…`（events seq 4..6，task_published×2 + run_activated） |
| BDD-002-03 warn 重叠 | `warn policy…`（警告 + cross_run_overlap_detected 事件） |
| BDD-002-04 block 硬拦 | `block policy…`（cross_run_conflict、零变更断言、--force 越过） |
| 15 §2.4 状态门 | paused → run_not_active（exit 7） |
| 幂等/子集/未知 ID | already_ready 警告；--tasks 子集；run/task_not_found（exit 5） |
| BDD-002-02 claim 半场 | **归 FEAT-004**（书面留待，publish 侧状态门已测） |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/2/3 | PASS | build 0；契约表零偏离（重叠判定为书面声明的保守前缀法，FEAT-004 升级 minimatch）；60/60，覆盖 93.48%/80.51% |
| G5-4 回归 | PASS | FEAT-001/002 全部 52 用例同套件持续绿 |
| G5-5…12 | PASS | 本文件 + self-check + knowledge + 矩阵/CHANGELOG/progress + commit（Refs: FEAT-003） |
| G5-13 | N/A | 无量化 NFR 挂本 FEAT |
| G5-14 | Secrets PASS；SCA 仍 BLOCKED（跨 FEAT 待办） | — |
| G5-15 | PASS（inspection） | publish.ts 仅依赖 storage+envelope+events，方向合规 |
| G5-16…23 | N/A | 同前 |

## 4. 残余

- [FEAT-004] BDD-002-02（发布前 claim 拒绝）与 minimatch 级重叠判定。
- [记录] cross-run 检查读其他 run 时不加对方锁（只读快照，与 audit 同口径）。

# Feature 验证报告：FEAT-002 plan 导入

> 2026-07-10 ｜ 用户可见（`/team-plan` 的 gateway 半场）｜ 测试先行证据：实现前新增 26 用例 RED（5 文件失败）

## 1. 四可检验验收

| 检验项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | `run import` 返回 RUN-ID + 任务映射表 + warnings；`.team/runs/RUN-0001/` 全套制品可查 |
| 可演示 | ✅ | 真机冒烟：import → RUN-0001（含制品清单）→ 二次导入 `duplicate_payload`（§3） |
| 可端到端 | ✅ | payload 文件 → cli → 校验 → project.lock 短事务 → 状态文件 → events 提交点 |
| 可独立上线 | ✅ | 依赖仅 FEAT-001；导入即可被 status/publish 消费 |

## 2. BDD / 场景锚

| 锚 | 测试 |
|---|---|
| BDD-001-01 主流程 | import-success（5 用例：映射/制品/graph 无 status/events seq/计数器） |
| BDD-001-02/03 违规拒绝 | import-validation（10 参数化案 + 零残留） |
| BDD-001-04 指纹防重（D17） | import-dedup（拒绝指向 RUN-0001；--force → RUN-0002） |
| BDD-001-05 secret 警告 | import-warnings（warn-only，含无 paths / ready 降级） |
| AUD-021 环（P0-inline） | import-cycle（环路径提示 + 零残留） |
| 17 §4 锁 | storage lock 3 用例（超时/接管/复得） |

## 3. 演示脚本执行记录（真实二进制）

| 步骤 | 操作 | 实际 | 通过 |
|---|---|---|---|
| 1 | 临时仓库 init + 写 1 任务 payload | — | ✅ |
| 2 | `run import p.json --json` | `run_id: RUN-0001 ok: True warnings: []` | ✅ |
| 3 | 同文件再导入 | `dedup code: duplicate_payload` | ✅ |
| 4 | `ls .team/runs/RUN-0001` | context counters events.jsonl events.meta.json locks plan.md run.json task-graph.json tasks team-task-list.json | ✅ |

## 4. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1 构建 | PASS | tsc -b exit 0 |
| G5-2 契约符合性 | PASS | self-check 契约表；**1 项 backflow**（新增 `duplicate_payload` code，已回填 17 §3 / 09 §6，规则 3 显式处理，非静默偏离） |
| G5-3 测试 | PASS | 52/52（新增 26+1）；覆盖率行 93.77% / 分支 80.81% |
| G5-4 回归 | PASS | FEAT-001 全部 25 用例在同一套件持续绿（init/doctor/envelope 行为未变） |
| G5-5 验证报告 | PASS | 本文件 |
| G5-6 活文档 | PASS | 矩阵 P5 行、CHANGELOG、progress、17/09 backflow |
| G5-7 知识沉淀 | PASS | knowledge.md + project-knowledge/features/FEAT-002.md |
| G5-8 矩阵终版 | PASS | FEAT-002 行 Files/Tests/Result 无空白 |
| G5-9 commit | PASS | `Refs: FEAT-002`（见提交记录） |
| G5-10/11/12 | PASS | mvp-scope / implementation-plan / self-check |
| G5-13 性能 | N/A | 导入路径无量化 NFR（NFR-003 锁事务计时属 FEAT-004 压测宿主） |
| G5-14 安全 | Secrets PASS（模式集自身即本期交付物，fixture 验证）；SCA 仍 BLOCKED（同 FEAT-001，registry 端点） | — |
| G5-15 架构守护 | PASS（inspection） | 新增依赖仍守 cli→core→storage；payload/cycle/redaction 均无跨层 import |
| G5-16…23 | N/A | 同 FEAT-001 |

## 5. 残余与待办

- [记录] `publication.initial_status: ready` 本期降级 draft + 警告（书面 scope cut），FEAT-003 落 publish 后移除降级。
- [P2] import 后 run 目录回滚为 best-effort（io 异常路径），FEAT-008 repair 提供兜底。

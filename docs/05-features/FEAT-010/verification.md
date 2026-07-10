# Feature 验证报告：FEAT-010 verify + integrate + export

> 2026-07-11 ｜ 用户可见 ｜ RED 13/13 先行 → GREEN 172/172（新增 13）｜ **MVP 主链（FEAT-001…010）就此闭合**

## 1. 四可检验（复合三子项各自验收）

| 子项 | 可感知/可演示 |
|---|---|
| 010.1 verify | 真机：VERIFY-0001 pass → approved→verified；verifier 合成 verify_work |
| 010.2 integrate+report | 真机：拓扑序 + branch 指令 → record（path claim 释放）→ report（1 integrated/0 reverted）→ run reported |
| 010.3 export | 真机：7 文件 920 字节落 docs/team-runs/RUN-0001（plan/report/integration/evidence/reviews/verification.md/run-memory） |

北极星验收句达成：**plan→import→publish→dispatch→claim→worktree→submit→review→verify→integrate→report→export 单命令链真机走通。**

## 2. 场景锚

| 锚 | 测试 |
|---|---|
| 14 §4 task 级 pass | verify.test `pass: writes VERIFY record…`（记录/outputs/事件对/verified） |
| D11 结构校验 | `rejects exit_code/status mismatch and verdict contradicting…`（零变更） |
| BDD-006-06 run 级失败映射 | `fail verdict maps the task back…`（failures_mapped + owner claim 复活） |
| BDD-006-07 双向 | 正门=pass 记录驱动 verified；负门=`a verified task cannot be re-verified`（状态只经本原语，AUD-017 inline 化） |
| D15 verifier 合成 | `claim-next --role verifier synthesizes…`（独立性过滤：owner 拿不到自己的活） |
| BDD-008-01 拓扑序 | integrate.test `start: deterministic topo order…`（blocks 先于 priority；T1<T2） |
| BDD-008-02 单点回退 | `record: … --failed -> minimal VERIFY + changes_requested`（verify_id 保 #38 必带字段；集成继续） |
| 15 §4.2 hold 终点 | record 成功路径断言 path claim released |
| BDD-008-03 不碰 main | report 前后 `git rev-list --count` 相等 + run reported + 两清单 |
| BDD-008-04 阻断扫描 | export.test `aborts on a secret hit…`（export_redaction_hit + 命中清单 + 零写入） |
| BDD-008-05 正常留档 | `exports the default set…`（清单/大小/git add 提示） |
| 16 §7 目标守卫 | gitignore 目标拒 / .team 内拒 / 已存在需 --force |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/2/3 | PASS | build exit 0；172/172，覆盖 89.74%/73.46%（阈 80/70）；偏离书面（§4） |
| G5-4 回归 | PASS | 159 既有用例持续绿；**依赖门策略位** `deps_satisfied_when`（10 §6 既写的放宽档）实现——默认严格 ['done'] 不变，回归零破坏 |
| G5-5…12 | PASS | 全套制品 + commit（Refs: FEAT-010） |
| G5-13 NFR-004 | PASS | export 阻断式二次扫描用例 + 真机 |
| G5-14 | Secrets PASS（verify outputs 过 redactText；export 即防线本体）；SCA 仍 BLOCKED | — |
| G5-15 | PASS（inspection） | verify 在 dispatch、integrate/export 在 core（matrix 定位）；无新增环 |
| G5-16…23 | N/A | 同前 |

## 4. 残余（书面 → 收尾轮）

- review decision=block、task 级 review.required 覆盖（15 §9）、team-integrate/verify 等其余模板、conformance suite、rev_after 债、SCA 补跑、CI 矩阵。
- verifier 合成为无状态建议（14 §4 无 verify-claim schema）——双 verifier 竞态由 approved→verified 状态门天然去重，书面声明。
- [backflow 检查] `deps_satisfied_when` 策略字段名回填 docs/10 §6（放宽档已有文字，字段名实现期定）→ 收尾轮统一执行。

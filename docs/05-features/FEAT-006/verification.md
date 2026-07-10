# Feature 验证报告：FEAT-006 dispatch 端到端

> 2026-07-11 ｜ 用户可见 ｜ RED 13/13 先行 → GREEN 117/117（新增 6 worktree + 2 run-show + 5 adapters + 1 cli）

## 1. 四可检验

| 项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | `/team-plan`、`/team-dispatch`、`/team-publish` 命令文件与 Codex skill 装入仓库；`run show`/`worktree register/adopt` 三命令 |
| 可演示 | ✅ | 真机全链：run show（2 ready）→ claim → git worktree add → worktree register → run show（1 working, 1 ready）→ 双工具 adapter install → AGENTS.md 标记恰好一对 |
| 可端到端 | ✅ | Slice 5 全流程 register→claim→hydrate→worktree→working；--as/--task/--role/--loop 语义在模板第 2/3/10 步 + gateway 参数面（FEAT-004） |
| 可独立上线 | ✅ | 任一窗口拿到 /team-dispatch 即可入队工作；submit（FEAT-007）前以 release/heartbeat 收尾 |

## 2. 场景锚

| 锚 | 测试 |
|---|---|
| 15 §3.3 claimed→working（"worktree 已创建"前置） | worktree.test `registers the worktree…`（task.json+list 双翻转 + base_commit 采集） |
| 18 #42/#13 事件序 | 同上（[worktree_created, task_started] 尾序断言） |
| 16 §3.3 branch 规范 / 路径校验 | `rejects a non-owner…`（not_claim_owner / schema_invalid / io_error 三守卫 + 零变更） |
| 状态门 | `rejects when the task is not in claimed state`（invalid_transition） |
| 16 §3.5 回收保留 worktree | `reclaim: entry -> abandoned…`（owner 入历史 + previous_attempts 带 worktree_path/branch） |
| 16 §3.5 adopt + 18 #43 | `adopt: new owner takes…`（active/owner 转移/worktree_adopted.previous_owner/working） |
| adopt 空态 | `adopt with nothing abandoned is invalid_transition` |
| 19 §3.2 第 1 步依赖 | run-show.test 概要+rollup+计数；run_not_found |
| 19 §2 RULES 十诫逐字 + D12 命名 | install.test `claude-code: writes command templates…`（RULES 块、sigmarun 命令、无 \`team \` 残留断言、--loop/D5） |
| 22 §安装幂等 | `re-install skips…`（already_installed 警告 / --update 覆盖）+ AGENTS.md 标记恰一对 |
| 19 §4.1 Codex skill（D13 定稿触发词） | `codex: writes the dispatch skill…` |
| cli | `run show + adapter install routes` |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/2/3 | PASS | build exit 0；117/117，覆盖 92.65%/79.66%（阈 80/70）；契约偏离仅书面项（§4） |
| G5-4 回归 | PASS | FEAT-001…005 全部 103 既有用例同套件持续绿 |
| G5-5…12 | PASS | 本文件 + self-check + knowledge + 卡片 + 矩阵/CHANGELOG/progress + commit（Refs: FEAT-006） |
| G5-13 | N/A | UX-003 触发面未改动（D13 两轮实测数据仍有效，模板触发词未变） |
| G5-14 | Secrets PASS（模板为静态文本，无凭据面）；SCA 仍 BLOCKED | — |
| G5-15 | PASS（inspection） | adapters → core+storage；dispatch/worktree → claim-engine 内部复用；cli → adapters |
| G5-16…23 | N/A | 同前 |

## 4. 残余（书面）

- [FEAT-007] 模板第 7/8 步的 submit/evidence 命令面（模板文本已按 14 §2.1 预写，属前向引用——包随 v0.1.0 整体交付）。
- [FEAT-008] team-status 等其余 9 模板、AUD-029 worktree 巡检、conformance suite 挂 CI。
- [P1] user scope 安装、模板漂移 doctor 检测、`run show` 归位查询面时的 run list/task list 补全。

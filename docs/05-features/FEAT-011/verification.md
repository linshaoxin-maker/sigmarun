# Feature 验证报告：FEAT-011 project memory promote（L4）

> 2026-07-11 ｜ 用户可见 ｜ 测试先行（模块缺失期编写）→ GREEN 180/180（新增 8）｜ **P4 特性全集 FEAT-001…011 交付完毕**

## 1. 四可检验

| 项 | 结论 | 说明 |
|---|---|---|
| 可感知 | ✅ | `memory promote/candidates` + doctor 新检查；MEMORY.md 管理文件用户直读 |
| 可演示 | ✅ | 真机：decision 消息 → candidates 列出 → promote 落 MEM-0001（出处戳）→ 悬空 ref 拒 → doctor pass |
| 可端到端 | ✅ | 写路径闭环；读路径（hydrate 恒含 + plan 模板第 2 步）已随 FEAT-005/006 交付并有既有用例锁定 |
| 可独立上线 | ✅ | 无 promote 时 MEMORY.md 可手工维护（25 §7 过渡法既写）；有 promote 后含校验+事件+审计 |

## 2. 场景锚

| 锚 | 测试 |
|---|---|
| BDD-009-01 晋升主流程 | `promotes a decision with MEM id…`（骨架/分区插入/出处戳/memory_promoted/计数器递增） |
| BDD-009-02 无出处拒收 | `rejects entries without refs…`（四类 memory_entry_invalid + **零写入**断言） |
| BDD-009-06 supersedes 留痕 | `supersedes moves the old entry…`（Superseded 分区/双事件/悬空拒） |
| 25 §3.1 git-tracked 强制 | `refuses a gitignored memory target` + doctor `project_memory_committable`（真机 pass） |
| 25 §4 候选发现（只列不选） | `memory candidates lists decision messages` |
| AUD-036/038 | `hand-edited entry without stamp and dangling supersedes…`（+ rules_skipped 销账断言） |
| BDD-009-05 + AUD-037 | `oversize memory warns without blocking`（audit warn + status risk 双半场） |
| AUD-040 | `an agent holding more active claims than the cap` |
| BDD-009-03/04 读路径 | **复验引用**：FEAT-005 hydrate L4 用例、FEAT-006 plan 模板文本（不重复实现） |

## 3. Gate 5

| Gate | Status | Evidence |
|---|---|---|
| G5-1/3 | PASS | build exit 0；180/180，覆盖 89.44%/73.24%（阈 80/70） |
| G5-2 test-first | PASS（偏离登记） | 测试先于实现编写；本轮 RED 未单独留运行记录（前十个 FEAT 均有），登记为流程偏离一次 |
| G5-4 回归 | PASS | 172 既有用例持续绿（audit SKIPPED 表缩减为 rev_after/AUD-034 两项） |
| G5-5…12 | PASS | 全套制品 + commit（Refs: FEAT-011） |
| G5-13 | N/A | — |
| G5-14 | Secrets PASS（promote 即拒收面）；SCA 仍 BLOCKED | — |
| G5-15 | PASS（inspection） | memory-promote 在 context（memory-store 定位）；audit/watch 只读扩展 |
| G5-16…23 | N/A | 同前 |

## 4. 残余（书面 → 收尾轮）

- 收尾轮清单（progress 下一步队列）：rev_after 债（AUD-032）、AUD-034 重放、SCA 补跑、CI 三平台 + NFR-001 压测、review block/task 级覆盖、team-integrate/verify 模板、conformance suite、回填批（10 §6 字段名、04 §1.1 resume/新命令面对齐、17 §3 已回填两码复核）。
- CLAUDE.md `@import` 接线留用户手册（00 号）。

# P3 Design — sigmarun / Team Run Protocol

> 状态：视图文档（P3 是语料库最完整的一层，此处做 gate 记录与索引）｜ 2026-07-10

## 设计工件索引

| P3 要素 | 权威位置 |
|---|---|
| 4+1 视图 | [../11](../11-4-plus-1-architecture-view.md) |
| C4 L1/L2/L3 + 组件签名契约 | [../20](../20-c4-l2-l3-component-contracts.md) |
| 领域模型 / schema / 不变量（INV-001…014） | [../02](../02-domain-model-and-team-storage.md)、[../03](../03-team-task-list-and-task-schema.md)、[../21 §2](../21-schema-versioning-and-migration.md) |
| 状态机与生命周期 | [../15](../15-run-task-state-machine-and-lifecycle.md) |
| 并发与锁 | [../10](../10-claim-next-lock-and-conflict-rules.md)、[../17 §4–5](../17-cli-mcp-contract-and-error-model.md) |
| API/CLI 合同与错误模型 | [../17](../17-cli-mcp-contract-and-error-model.md)、payload 合同 [../09](../09-team-run-import-payload-schema.md) |
| Evidence/Review/Verify 合同 | [../14](../14-evidence-review-verification-contract.md) |
| 审计规则（AUD-001…035）+ 事件 schema | [../18](../18-audit-rule-catalog-and-trust-model.md) |
| 安全与数据卫生 | [../24](../24-security-permissions-and-data-hygiene.md) |
| Git/worktree 集成 | [../16](../16-git-worktree-and-team-root.md) |
| 版本与迁移 | [../21](../21-schema-versioning-and-migration.md) |
| Adapter 与触发实测 | [../19](../19-agent-adapter-pack-claude-codex.md) |
| 项目记忆 L4 | [../25](../25-project-memory-and-knowledge-promotion.md) |
| ADR | [../13 §2.1](../13-design-audit-and-next-breakdown.md) D1–D19（台账制，见 [../04-decisions/README.md](../04-decisions/README.md)） |

## Gate G3

| Gate | Status | Evidence / 原因 |
|---|---|---|
| G3-1 C4 L2/L3 | PASS | 20 §2–4（含八组件 TS 签名） |
| G3-2 4+1 视图 | PASS | 11 全文（场景先行） |
| G3-3 逻辑模型/schema/不变量 | PASS | 02/03 + INV-001…014 + 21 §2 全 schema 盘点 |
| G3-4 过程视图（时序/状态/并发） | PASS | 11 §4 + 15 全文 + 10 竞态场景 |
| G3-5 开发视图（模块/依赖规则） | PASS | 20 §3/§5（V1–V10 违例清单） |
| G3-6 物理/部署视图 | PASS | 11 §6 本地拓扑 + 16 team-root + 22 安装 |
| G3-7 API 合同链 UC/BDD/NFR | PASS | 合同（17/09/14）经 [traceability-matrix.md](traceability-matrix.md) 主矩阵 Component/Contract 列锚定 UC/BDD/NFR（2026-07-10 P1/P2 补齐后回填） |
| G3-8 核心函数契约 | PASS | 20 §4 八组件签名 + 14/17 事务规格 |
| G3-9 状态机无悬空 | PASS | 15 §3（reviewing 回退、blocked 出口均已闭合，经 18 号交叉核对） |
| G3-10 设计模式具名 | PASS | "事件为提交点"（17 §5.3）、"索引+详情"（03 §1）、"派生视图"（INV-006）等均有 rationale |
| G3-11 ADR | PASS | D1–D19 含背景/裁决/影响，含复议记录（D14） |
| G3-12 影响分析 | PASS | [P4-feature.md](P4-feature.md) Feature Impact Matrix（FEAT × 包 × 状态面 × 守门，2026-07-10） |
| G3-13 兼容性政策 | PASS | 21 全文（N-1 窗口、migrate、min_gateway_version） |
| G3-14 威胁模型 STRIDE | PASS | ../24 §1.4 STRIDE 六维全表（T/R/I/E 有防线，S/D 显式接受并写明边界，2026-07-10） |
| G3-15 性能预算 | PASS | M39 包络 + 锁毫秒级/超时 5s + lease 参数（02 §11、17 §4） |
| G3-16 数据演化 | PASS | 21 §5 migrate（备份/幂等/回滚） |
| G3-17 可观测性 | SKIPPED | events/audit/watch 已定；metrics/SLO 显式记为 Phase 2（11 §8 注记，用户认可的范围决策） |
| G3-18 traceability 设计列 | PASS | 主矩阵 Component/Contract 列全行回填（2026-07-10） |
| G3-19 project knowledge 检查 | PASS | 25 号 L4 设计即知识机制本体 |

**结论**：G3 全绿（G3-17 SKIPPED 留痕，metrics 属 Phase 2 范围决策）。2026-07-10 随 P1/P2 补齐关闭了 G3-7/12/14/18。

# Traceability Matrix — sigmarun

> 2026-07-10 回填 Story/UC/BDD/NFR 列（P1/P2 完成）。链：Story → UC → BDD → NFR → Component/Contract → FEAT → files/tests → result。
> Files/Tests/Result 列由 P5 逐 FEAT 回填；backflow 标注 `[needs backflow to P{N}]`。

## ID 体系权威

Story/R：[P1-requirement.md](P1-requirement.md) §3 ｜ UC：P1 §4 ｜ BDD：`BDD-UC-XXX.feature` ｜ NFR/UX/ASM：P1 §5–8 ｜ D1–D19：../13 §2.1 ｜ INV：../11 §3.3 ｜ AUD：../18 §4 ｜ FEAT：[P4-feature.md](P4-feature.md) ｜ 包：../20 §3。

## 主矩阵

| Story | R | UC | BDD | NFR | Component / Contract | FEAT | Files/Tests | Result |
|---|---|---|---|---|---|---|---|---|
| US-001 | R-001 R-002 | UC-001 | BDD-001-01…05 | NFR-009 | core/lifecycle + storage；09 payload 合同；D17 防重 | FEAT-002 | — | — |
| US-001 | R-002 | UC-002 | BDD-002-01…04 | NFR-009 | core/state-machine；15 §6；D18 | FEAT-003 | — | — |
| US-002 | R-003 R-004 | UC-003 | BDD-003-01…08（全组；-08 为 requires_approval 拦截） | NFR-001 NFR-002 NFR-003 | dispatch/claim-engine + path-conflict + storage/lock-manager；10；BR-001 | FEAT-004 FEAT-005 FEAT-006 | — | — |
| US-003 | R-005 | UC-004 | BDD-004-01…03（另复用 BDD-003-04/05 的上限与身份约束——多归属，见断链检查） | NFR-009 | claim-engine（--task）+ label 幂等注册；D17 | FEAT-006 | — | — |
| US-004 | R-006 R-013 | UC-005 | BDD-005-01…08（-08 为 requires_approval 双向） | NFR-004 NFR-009 | core/lifecycle(submit 事务) + storage/redaction；14 §2/§5；24 §4 | FEAT-007 | — | — |
| US-005 | R-007 | UC-006 | BDD-006-01…07 | NFR-009 | claim-engine(review claim/合成) + core/state-machine；14 §3–4；D15；INV-008 | FEAT-009 FEAT-010 | — | — |
| US-006 US-007 | R-008 R-009 R-010 | UC-007 | BDD-007-01…09（-08 批准闭环、-09 run cancel 级联） | NFR-002 NFR-005 NFR-008 | watch + claim-engine(sweep/reclaim) + audit-engine + repair；14 §5；15 §2/§5；17 §5；18 | FEAT-008（子项 008.1–008.4） | — | — |
| US-008 | R-011 R-013 | UC-008 | BDD-008-01…05 | NFR-004 | core/lifecycle(integrate/export) + redaction；16 §4/§7 | FEAT-010 | — | — |
| US-009 | R-012 | UC-009 | BDD-009-01…06 | — | context/memory-store + core/lifecycle(promote)；25；D19 | FEAT-011（读路径随 FEAT-002/005） | — | — |

## 横切 NFR → 验证宿主

| NFR | 验证宿主（不挂单一 UC） | FEAT |
|---|---|---|
| NFR-001 并发 | 17 §10 压测（16 并发、rev/seq 断言）+ BDD-003-02 | FEAT-004 |
| NFR-006 兼容 | 21 §10 场景 1/2（round-trip、版本握手） | FEAT-001 |
| NFR-007 跨平台 | CI 三平台矩阵（17 §10） | 全部 |
| UX-003 触发 | 19 §8 实测协议（已有两轮数据）+ conformance | FEAT-006 |

## 断链检查（2026-07-10）

- Story→UC→NFR：无空白（UC-004/006/009 的 NFR 列为"—/继承 NFR-009"，理由：纯流程分支类需求，无独立量化属性；NFR-009 全 UC 生效）。
- UC→BDD：55 场景全挂 UC，无孤儿；**多归属规则**（2026-07-10 外审 finding 5 修正）：BDD 场景按物理所在 feature 文件挂主 UC，被其他 UC 复用时在该行括注（如 BDD-003-04/05 主挂 UC-003、UC-004 复用）；BR-001 仅行 9（parallel_limit）无 BDD，书面豁免（P5 压测），行 8 已由 BDD-003-08/005-08/007-08 覆盖。
- FEAT 列：FEAT-001（enabler）不直接挂 UC，经 NFR-006/横切表锚定——符合 G4-1 enabler 豁免。

## P5 回填（逐 FEAT；backflow 按 `[needs backflow to P{N}]` 标注）

| FEAT | Files | Tests | Result |
|---|---|---|---|
| FEAT-001（enabler，锚 NFR-006/009 + BDD-001 背景） | packages/storage/src/index.ts；packages/core/src/{envelope,schemas,lifecycle,index}.ts；packages/cli/src/{cli,bin}.ts | storage/test/{team-dir,atomic-write}.test.ts；core/test/{envelope,init,doctor}.test.ts；cli/test/cli.test.ts —— 25/25 绿，RED 先行在案 | ✅ 交付（覆盖 91%/73%；G5 全表见 [FEAT-001/verification.md](../05-features/FEAT-001/verification.md)；SCA BLOCKED 待补跑） |

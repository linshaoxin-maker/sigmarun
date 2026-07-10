# FEAT-010 自检报告

## 契约符合性

| 契约 | 实现 | 偏离 |
|---|---|---|
| 14 §4 五规则 | 目标双态/五 gate+skip_reasons/exit_code×status 一致/verdict⇔gate/输出存在与落盘 | verification.md 派生索引在 export 生成（14 §4 规则 5 允许派生化） |
| 16 §4.2 七规则 | 拓扑+priority+id 确定性序；--no-ff 指令下发；失败 revert 记账不卡全局；不合 main；integration.md 双清单 | 冲突解决记录（integration worktree 侧）为 agent 动作，gateway 只收 record——模板补装收尾轮 |
| 16 §7 | 默认集/–full/阻断扫描/清单+大小/不代提交/目标四守卫 | reviews 导出为 json→md 渲染（默认集写 md——以渲染满足；原 json 走 --full 语义外，书面） |
| 15 §4.2 | path claim hold 至 integrated 释放（released_claim_ids 入 #20） | 无 |
| 18 #7/8/20/36–38 | 全部落，必带字段齐（--failed 自动最小 VERIFY 保 #38 verify_id） | 无 |
| 10 §6 依赖门 | 默认 ['done'] 严格；`deps_satisfied_when` 策略放宽（10 §6 预写档） | 字段名实现期定 → backflow 标记 |

## 测试 / 质量

- 172/172（新增 13）；覆盖 89.74%/73.46%；RED 13 先行（2 例失败源自依赖门冲突——BDD-008 背景 vs 10 §6 严格档，以既写策略位化解）；真机北极星全链。
- verify.ts ≈ 250 行 / integrate.ts ≈ 300 行 / export.ts ≈ 180 行——线性事务风格沿既有豁免；TODO 0。

## 安全

- export 是 D4 的唯一出 git 口：阻断式扫描（scanForSecrets 全文件）+ 目标不可 gitignore（防"看似归档实则不入库"）+ 不代提交。
- verify outputs 走 redactText 同管道。

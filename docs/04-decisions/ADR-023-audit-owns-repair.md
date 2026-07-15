# ADR-023：audit 包定位 = 规则 + 重放 + 修复

- 状态：已采纳（2026-07-15，D23）
- 背景：docs/20 §4.6 原文「audit 禁止写」，实况 repair 住在 audit 包（与检测共用 foldLedger 单真值源）。
- 决定：承认现状并收紧约束——audit 的**唯一**写路径是 repair，且必须经 TxKernel（acquireRunWriteLock：版本闸门+锁+接管留证）+ 备份先行。架构对账测试以「全仓仅一处 runLock 获取点」机械保障。
- 备选（未采）：repair 迁 core——需连带下沉重放引擎，搬家收益是名义性的。

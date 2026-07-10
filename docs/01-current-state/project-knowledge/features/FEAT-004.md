# FEAT-004 经验卡片（claim-next + 锁 + 回收）

- **一句话**：dispatch 包落地——run.lock 事务内 sweep→BR-001 九守卫→排序→task+path 双 claim；label 幂等注册、租约/心跳、release/manual/3×TTL 三路回收共用一个翻转函数；85/85、93.2%/80.2%。
- **可复用**：withRunLock 事务包装器；readOrDefault+saveState 惰性建档对；"定向给具体码、非定向给 excluded 明细"的失败设计。
- **坑**：sweep 必须在 agent 上限守卫之前（自己的死租约会挡住自己）；noUncheckedIndexedAccess 下排序取首要判空。
- **证据**：docs/05-features/FEAT-004/verification.md；`Refs: FEAT-004`。

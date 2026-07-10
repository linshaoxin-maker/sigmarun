# FEAT-003 经验卡片（publish）

- **一句话**：run.lock 事务内 draft→ready 双写 + planned→active 激活 + D18 跨 run warn/block；幂等跳过警告；60/60、覆盖 93.5%/80.5%。
- **可复用**：守卫→变更→事件三段式事务模板（第三次验证）；actor 按"谁做的决定"（user vs policy）标注。
- **坑**：跨 run 只读检查不得取对方锁（死锁面）。
- **证据**：docs/05-features/FEAT-003/verification.md；`Refs: FEAT-003`。

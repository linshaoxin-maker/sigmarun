# FEAT-002 经验卡片（plan 导入）

- **一句话**：payload 校验（10 案必拒 + 3 类警告）→ ID 分配 → 全套制品落盘 → events 提交点；D17 指纹防重与 AUD-021 环检测 inline；52/52 测试、覆盖 93.8%/80.8%。
- **可复用**：① 事务写序模板（状态→计数器→events 提交点）；② passthrough+禁字段扫描的双层校验法；③ backflow 定名新 code 而非借用近似 code。
- **坑**：字段顺序会骗过原文 hash——指纹必须稳定序列化。
- **证据**：docs/05-features/FEAT-002/{verification,self-check}.md；`Refs: FEAT-002`。

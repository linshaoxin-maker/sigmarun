# FEAT-005 经验卡片（Context Plane）

- **一句话**：context 包落地——消息池（INV-011 不进 events）、M23 派生开放问题、hydrate pack（brief→run-memory→L4→上游 handoff）+ context_hydrated 锚、graph validate（AUD-021/022 复检）、run memory 更新（secret 拒收）；103/103、92.6%/79.5%。
- **可复用**："warn 先行、拒收后至"安全分级；jsonl+计数器追加模板；派生视图纯函数共享。
- **坑**：跨包消费文件格式先读生产方代码（边字段是 `kind` 不是 `type`）。
- **证据**：docs/05-features/FEAT-005/verification.md；`Refs: FEAT-005`。

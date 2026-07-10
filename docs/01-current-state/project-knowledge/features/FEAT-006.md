# FEAT-006 经验卡片（dispatch 端到端）

- **一句话**：worktree register/adopt（claimed→working、16 §3.5 回收保留-认养链）+ run show + 适配器包安装器（19 全文模板、RULES 十诫、AGENTS 标记对幂等）；117/117、92.7%/79.7%。
- **可复用**：startTask 双翻转回调；模板版本头 + 标记对注入；字符串常量内嵌模板。
- **坑**：`git worktree add` 需已出生 HEAD；向文件注入段落必须带 begin/end 标记。
- **证据**：docs/05-features/FEAT-006/verification.md；`Refs: FEAT-006`。

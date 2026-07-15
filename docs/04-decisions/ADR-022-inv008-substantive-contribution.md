# ADR-022：INV-008 的 owner 判据改为「实质贡献」

- 状态：已采纳（2026-07-15，D22）
- 背景：原判据「曾持有 claim」与租约接管相乘将评审门对全体在场身份永久焊死（S1），并诱导第三身份洗白。
- 决定：评审/验证独立性的排除集 = **提交过任一 evidence revision 的 agent ∪ 当前 active/submitted claim 持有者**（`accountableAuthors`）；AUD-015 同判据复查；`historicalOwners` 仅保留为 unblock 的所有权判据。
- 残余风险（如实记档）：A 写了未提交代码、B 接管提交后 A 评审含自己旧行的提交。缓解：评审永久留痕 + AUD-015。

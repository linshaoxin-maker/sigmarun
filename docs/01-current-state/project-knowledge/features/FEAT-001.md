# FEAT-001 经验卡片（`.team` 基座 + init/doctor）

- **一句话**：三包（storage/core/cli）落地 team-root 解析、原子写 + rev、envelope、init/doctor；25 测试、覆盖 91%/73%，真机冒烟通过。
- **可复用**：① vitest src-alias + tsc -b 引用的 monorepo 测试/构建分离法；② "诊断命令 ok=true + checks 载荷"语义；③ fail detail 即修复命令的 NFR-009 套路。
- **坑**：macOS tmp 路径必须 realpath（/var vs /private/var）。
- **证据**：docs/05-features/FEAT-001/{verification,self-check}.md；提交 trailer `Refs: FEAT-001`。

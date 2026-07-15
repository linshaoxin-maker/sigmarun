# ADR-020：schema 迁移采用「自动读时迁移」（追认）

- 状态：已采纳（2026-07-13 产品负责人裁决于 roadmap Phase 2；2026-07-15 整改 R4 补档）
- 背景：docs/21 原设计为「写命令拦截 migration_required + N-1 读窗口 + data.kind 三分」。落地时判断精细窗口策略对本产品体量过度。
- 决定：读路径对旧 major **内存透明升级**（不写盘，lock-free audit 安全）；写命令顺手落新 major；`team migrate` 显式重写（备份先行、rev 保留、发 `run_migrated`）。写方向防线 = `min_gateway_version` 写闸门（TxKernel，`gateway_too_old`）。
- 后果：多工具并存故事由「拦旧工具的写」承担（闸门），不再依赖读窗口；docs/21 §4.1 已按此重写（2026-07-15）。

# FEAT-001 MVP 范围定义 — `.team` 基座 + init/doctor

> 类型：technical enabler（G4-1 正当性：一切事实源的载体）｜ 源：Slice 1、[17 §8](../../17-cli-mcp-contract-and-error-model.md)、[16 §1–2](../../16-git-worktree-and-team-root.md)、[02](../../02-domain-model-and-team-storage.md)

## 本期交付

- `sigmarun init`：在 git 仓库内创建 `.team/`（project.json、counters.json、templates/、locks/），向 `.gitignore` 追加 `.team/`（D4）；**幂等**（重复执行报告现状，不覆盖）。
- `sigmarun doctor`：逐项自检并输出 envelope——git 仓库/非 bare、team root 解析（含 worktree 一致性口径）、`.team` 已初始化、node ≥20、锁能力（mkdir 建/删自测）、`.gitignore` 含 `.team/`、tracked `.team` 污染检测（AUD-030 口径）、schema 版本可读。
- `--json` 全局 envelope（17 §2：ok/code/message/data/warnings/next_actions/meta，英文，D16）。
- storage 基元：team-root 解析（git common-dir，16 §2）、原子写（tmp+rename）、`rev` 乐观锁、**未知字段 round-trip 保留**（21 §4.2，NFR-006）。

## 本期不交付

- 一切 run/task 原语（FEAT-002 起）；锁的完整退避/takeover（FEAT-004，本期仅 doctor 探测）；redaction（FEAT-007）；watch/audit/repair（FEAT-008）；MCP/dashboard（契约期）。

## 验收锚

- BDD-001 Background（"项目已执行 sigmarun init 且 doctor 全绿"是后续全部场景的前置）。
- 17 §12 场景："doctor 在被污染仓库运行 → 明确报告 + 修复指引"。
- NFR-006：未知字段 round-trip 零丢失；NFR-009：全部失败 envelope 带 next_actions。
- 21 §10 场景 1/3：未知 major 拒绝（`unsupported_schema_version`）；min_gateway_version 写闸门（本期实现读侧检查）。

## 安全边界

- init 只写 repo 内 `.team/` 与 `.gitignore` 一行；不执行任何删除性操作；envelope 不回显文件内容（24 §5）。

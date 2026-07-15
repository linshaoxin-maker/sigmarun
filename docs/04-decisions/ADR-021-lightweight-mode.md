# ADR-021：轻量模式入宪（INV-007 显式豁免 + report 终局）

- 状态：已采纳（2026-07-15，D21）
- 背景：轻量模式（2026-07-13/14 交付）违反 INV-007 字面、audit 误伤其快乐路径、run 无终局（S3/S8/S10）。
- 决定：INV-007 修订为「full 模式永不放开；轻量 run 显式豁免且留痕」；`core/mode.ts` RunMode 为唯一分叉点（模式墙 `mode_mismatch`）；终局复用既有链 active→(全终态后显式 report)→reported→archived；audit 用 lightweight profile（AUD-011/016/017/019 降 info）。
- 规范：[docs/26](../26-lightweight-mode.md)（全文权威）。

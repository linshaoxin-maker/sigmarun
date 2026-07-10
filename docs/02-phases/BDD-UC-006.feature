# BDD for UC-006 评审与验证（源：14 §3–4、15 §3.3/§9、D15、INV-008）
Feature: 评审与验证
  作为项目负责人
  我想让代码必须过独立评审与真实验证
  以便"done"值得信任

  Background:
    Given "TASK-0003" 为 submitted，历任 owner 为 "AGENT-codex-001"

  # BDD-006-01 reviewer 自主领审（D15）
  Scenario: reviewer 角色经 claim 合成拿到评审工作
    Given 窗口 "审查员" 以 role "reviewer" dispatch
    Then 应领到 data.kind 为 "review_work" 的工作项指向 "TASK-0003"
    And 应落一条 active review claim

  # BDD-006-02 自批被拒（INV-008）
  Scenario: 历任 owner 领审被拒
    When "AGENT-codex-001" 尝试 review claim "TASK-0003"
    Then 返回 code 应为 "self_approval_forbidden"

  # BDD-006-03 退回必须有必改项
  Scenario: request_changes 无 must_fix 被拒
    Given "审查员" 持有 review claim
    When 其提交 decision 为 "request_changes" 且 findings 为空
    Then 提交应被拒并要求至少 1 条 must_fix

  # BDD-006-04 返工环无缝（15 §4.2）
  Scenario: 退回后 owner 复工不丢路径占用
    Given 评审结论为 request_changes
    When owner 复工
    Then 任务应为 "working" 且原 path claim 仍 active
    And 期间他人 claim 重叠路径应收到 "path_conflict"

  # BDD-006-05 评审租约过期回退（15 §3.3）
  Scenario: reviewer 掉线后任务不卡死
    Given review claim 已过期且经过一次 sweep
    Then 任务应回到 "submitted"
    And events 应含 "review_released"

  # BDD-006-06 验证失败映射返工
  Scenario: run 级验证失败驱动精确返工
    Given "TASK-0003" 已 approved
    When verifier 提交 verdict 为 fail 且 failures_mapped 指向 "TASK-0003"
    Then "TASK-0003" 应变为 "changes_requested"
    And events 应含 "verification_failed"

  # BDD-006-07 verified 需真实记录
  Scenario: 无 pass 记录不得 verified
    When 试图将 approved 任务直接标为 verified 而无 VERIFY 记录
    Then 转换应被拒（invalid_transition）

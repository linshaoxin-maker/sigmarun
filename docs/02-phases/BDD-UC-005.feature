# BDD for UC-005 提交证据（源：14 §2、24 §4、15 §9、F1）
Feature: 提交证据
  作为项目负责人
  我想让"完成"必须有机器可校验的证据
  以便不被口头汇报欺骗

  Background:
    Given "TASK-0003" 为 working，required_checks 为 "npm test -- auth"
    And owner 为 "AGENT-codex-001"

  # BDD-005-01 主流程
  Scenario: 合规证据提交成功
    When owner 提交含 checks 原始输出(exit 0)、验收逐条 met、context_ack、handoff 的 evidence
    Then 任务状态应变为 "submitted"
    And "evidence/TASK-0003/evidence.json" 与 "outputs/" 应存在
    And events 应含 "evidence_submitted"

  # BDD-005-02 扩展 2a：缺 check 输出
  Scenario: required_check 无输出文件被拒
    When 提交的 evidence 中 "npm test -- auth" 无 output_ref
    Then 返回 code 应为 "evidence_invalid"
    And data 应逐条指明缺失项
    And 任务应停留在 "working"

  # BDD-005-03 结果与退出码矛盾
  Scenario: 声称 pass 但 exit_code 非 0 被拒
    When evidence 中该 check 标 "pass" 而 exit_code 为 1
    Then 提交应被拒且指明不一致项

  # BDD-005-04 扩展 2b：越界改动
  Scenario Outline: 改动超出 path claim 按策略处理
    Given path claim 的 allow 为 "src/auth/**" 且越界策略为 "<策略>"
    When changed_files 含 "src/users/db.ts"
    Then 提交结果应为 "<结果>"
    Examples:
      | 策略   | 结果                       |
      | warn  | 成功但 warnings 含越界清单 |
      | error | 拒绝且指明越界文件         |

  # BDD-005-05 扩展 2c：secret 脱敏（NFR-004）
  Scenario: 输出中的 AWS key 被替换后落盘
    When check 输出包含 "AKIAIOSFODNN7EXAMPLE1"
    Then 落盘文件中该串应为 "[REDACTED:aws_key]"
    And evidence 头部 redaction_count 应 ≥ 1

  # BDD-005-06 口头完成不算数（F1）
  Scenario: 未 submit 的任务不会变完成
    When agent 在会话中声称 "TASK-0003 已完成" 但未执行 submit
    Then 任务状态应仍为 "working"
    And 租约到期后任务应可被回收重派

  # BDD-005-07 no-review 直通留痕（D6）
  Scenario: require_review=false 时直通 approved
    Given run policy 的 require_review 为 false
    When owner 提交合规 evidence
    Then 任务应直接变为 "approved"
    And 应存在 decision 为 "skipped_by_policy" 的 review 记录与 "review_skipped" 事件

  # BDD-005-08 requires_approval 在 submit 阶段的双向行为（14 §5、AUD-004）
  Scenario Outline: 改动命中需批准路径按批准状态放行或拒绝
    Given "src/users/**" 为 requires_approval 路径且批准状态为 "<批准>"
    When owner 提交的 changed_files 含 "src/users/port.ts"
    Then 提交结果应为 "<结果>"
    Examples:
      | 批准               | 结果                                    |
      | 已 granted 且未过期 | 成功，审计可见 granted_by 与 approval_id |
      | 无批准记录          | 拒绝（evidence_invalid，error 级）        |

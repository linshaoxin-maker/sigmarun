# BDD for UC-009 跨 run 决策传承（源：25、D19）
Feature: 跨 run 决策传承
  作为项目负责人
  我想让后续 run 自动继承之前的关键决策
  以便任务交接不丢上下文

  Background:
    Given 项目记忆文件为 "docs/team/MEMORY.md"（git-tracked）

  # BDD-009-01 晋升主流程
  Scenario: 决策经确认晋升入库
    Given "RUN-0001" 的消息池中有 decision "Session expiry is 7-day sliding"（MSG-0002）
    When run 收尾时用户确认晋升该条至 Architecture 分区
    Then MEMORY.md 应新增带 "MEM-" 编号的条目
    And 条目应含出处戳（RUN-0001、日期、refs 指向 MSG-0002）
    And events 应含 "memory_promoted"

  # BDD-009-02 无出处拒收（INV-012 延伸）
  Scenario: 缺 refs 的条目不能晋升
    When 晋升请求不含任何 refs
    Then 应被拒且 code 为 "memory_entry_invalid"

  # BDD-009-03 读路径：新 run 自动继承（25 §8 场景 1）
  Scenario: 三周后的新 run 规划自动带上历史决策
    Given MEMORY.md 含 "[MEM-0003] Session expiry is 7-day sliding"
    When 用户在新会话发起 "/team-plan 给 auth 加登出功能"
    Then planning agent 的必读集应含 MEMORY.md
    And 新任务的 context 应引用 MEM-0003 而无需用户转述

  # BDD-009-04 hydrate 恒含 L4
  Scenario: 任何任务领取都带项目记忆
    When 任一 agent claim 成功并 hydrate
    Then must_read 应包含 "docs/team/MEMORY.md"

  # BDD-009-05 体积纪律
  Scenario: 文件超限出警告
    Given MEMORY.md 超过 200 行
    When 用户执行 status 或 audit
    Then 应出现合并/淘汰的 warning（不阻断）

  # BDD-009-06 supersedes 留痕
  Scenario: 过时决策被新条替换
    When 以 "--supersedes MEM-0003" 晋升新条
    Then MEM-0003 应移入 Superseded 分区且保留出处
    And 新条应记录其替代关系

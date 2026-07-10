# BDD for UC-007 监工与恢复（源：08 §6.1、15 §5、17 §5.2/§5.3/§7、D9/D14、M32、F2/F4）
Feature: 监工与恢复
  作为项目负责人
  我想单点看到进度/风险/待我处理的事，且掉线不死锁
  以便放心地并行

  Background:
    Given "RUN-0001" active，"TASK-0005" 由 "AGENT-codex-002" 持有

  # BDD-007-01 status 三区块
  Scenario: status 展示进度、风险与 Needs user
    Given 存在 1 个待批准路径请求与 1 个 open blocker
    When 用户执行 "/team-status RUN-0001"
    Then 输出应含加权进度与各窗口在办任务
    And "Needs user" 区块应列出该批准与该 blocker
    And 每项应附可直接复制的命令

  # BDD-007-02 stale 派生标注（F2：状态永远现算）
  Scenario: 租约过期即时可见
    Given "TASK-0005" 的 lease_until 已过
    When 用户执行 status
    Then 该任务应被标注 stale 风险（非持久状态）
    And 删除 progress.json 后重算结果一致

  # BDD-007-03 自动回收带进展（D9/F4，NFR-002）
  Scenario: 超 3×TTL 由 sweep 自动回收
    Given "TASK-0005" 过期已超 3 倍 TTL
    When 任一写原语触发 sweep（或 watch 一轮）
    Then 旧 claim 应变 "reclaimed"，任务回 "ready"
    And task.json 的 previous_attempts 应含 worktree 与 git status 快照
    And events 应含 actor 为 sweep 的 "task_reclaimed"

  # BDD-007-04 blocked 豁免
  Scenario: blocked 任务不被误判 stale
    Given "TASK-0005" 状态为 blocked 且等待用户回答
    When 时间超过 3×TTL
    Then 该任务不应被自动回收
    And status 应显示其 blocked 时长而非 stale

  # BDD-007-05 直改检出（NFR-005）
  Scenario: 绕过工具直改账本被抓
    Given 有人手动编辑 task-claims.json 使 rev 未按规则递增
    When 下一次写原语执行或运行 audit
    Then 应报 "rev_conflict" 或 AUD 直改嫌疑规则
    And next_actions 应指向 "team audit run RUN-0001"

  # BDD-007-06 崩溃修复（M30）
  Scenario: 写事务中断后 repair 恢复一致
    Given 某写事务在事件追加前被 kill，状态文件与账本不一致
    When 用户执行 "team repair RUN-0001"
    Then 未提交残留应被回滚、缺失派生物被重算
    And 修复动作应写 "state_repaired" 事件且执行前有备份

  # BDD-007-07 watch 单实例
  Scenario: 第二个 watch 被拒
    Given 已有 watch 进程持有 watch.lock
    When 用户再启动一个 watch
    Then 新实例应警告并退出（--force 可越过）

  # BDD-007-08 批准请求走 Needs user 闭环（14 §5、M32）
  Scenario: 路径批准请求出现在待办并经用户裁决
    Given "左窗" 对 "src/users/**" 发起了 path_approval 请求
    When 用户执行 "/team-status RUN-0001"
    Then "Needs user" 区块应列出该请求并附可复制的 approve-paths 命令
    When 用户执行 "team approve-paths RUN-0001 TASK-0006 --paths src/users/**"
    Then events 应含 "path_approval_granted"（granted_by 为 user）
    And "左窗" 再次点名领取 "TASK-0006" 应成功

  # BDD-007-09 run 取消的级联语义（15 §2.3）
  Scenario: integrating 中的 run 被取消时级联终结
    Given "RUN-0001" 处于 "integrating" 且存在 2 个 active claim
    When 用户执行 "team run cancel RUN-0001" 并确认
    Then run 状态应变为 "cancelled"
    And 全部 active claim 应变为 "cancelled" 且 events 含 cascaded_claim_ids
    And 此后任何 claim 应返回 "run_not_active"

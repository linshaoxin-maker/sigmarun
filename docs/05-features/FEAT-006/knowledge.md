# FEAT-006 — 项目知识

## 决策记录

- worktree 生命周期与 claim 生命周期解耦但联动：回收不删 worktree（16 §3.5），entry 状态机 active→abandoned→(adopt)→active 由 applyReclaim/adoptWorktree 两点维护。
- `run show` 从查询面（FEAT-008）提前：dispatch 模板第 1 步硬依赖——改派以 mvp-scope 书面化，不静默扩权。
- 模板以字符串常量内嵌包内而非独立文件资产：tsc 构建产物自包含，npm 发布免 files 配置陷阱。

## 经验教训

- `git worktree add` 需要已出生的 HEAD：空仓库（init 后无 commit）会直接失败——fixture/新仓库场景先补空提交。
- 向既有文件注入段落必须用显式标记对（begin/end 注释）：幂等判断、将来卸载/更新都靠它。

## 可复用模式

- startTask（task.json+list 双翻转 + 延迟 commit 回调）——submit/block/unblock 的状态翻转同构。
- 模板版本头 `template_version:` 注释 → doctor 漂移检测（P1）的锚点已就位。

## 应避免的做法

- 不要在 gateway 里代替 agent 创建 worktree（git worktree add 属 agent/用户动作，gateway 只登记与校验——D11 gateway 不执行的边界）。

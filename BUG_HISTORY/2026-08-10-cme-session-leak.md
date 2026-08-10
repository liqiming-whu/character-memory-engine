# CME Terminal Session Leak（2026-08-10）

> 来源：Codex 深度审计（`reports/codex/cme-session-leak-audit.md`，370 行）。本文件是长期维护知识提炼，不替代原始报告。

## 问题现象

- CME worker 启动失败（`T1 后无 T3`，start_worker.log 空）。
- Operit 重启后仍存在 proot/bash 残留进程（跨重启残留）。
- 残留形态：`proot → bash -lc echo LOGIN_SUCCESSFUL → bash --noprofile --norc`，阻塞于 do_wait/pipe_read/do_select。

## 影响

- worker 无法正常启动，CME 记忆功能不可用。
- hiddenExec 创建多个孤儿 terminal（`cme_<timestamp>`），每次拉起最多两条 native 链。
- 普通 UI/App 重启无法恢复（进程实体不随前端销毁）。

## 根因

### Root Cause A（已由源码确认）：创建失败路径泄漏

`LocalTerminalProvider.kt` 的 `createHiddenExecShell()` 先启动进程、等待 `TERMINAL_READY`；失败时调 `closeHiddenExecShell(key)`，但新 shell 只在成功返回后才写入 `hiddenExecShells` Map。关闭函数按 key 从 Map remove，创建期失败时 Map 里没有对象 → 关闭空操作，刚创建的进程树失去管理。

证据：`terminal/src/main/java/com/ai/assistance/operit/terminal/provider/type/LocalTerminalProvider.kt:186-205,208-258,483-492`

### Root Cause B（已确认）：多层 timeout 不一致

| 层 | 超时 | 到时行为 |
|---|---|---|
| CME withRace | 5s | 只拒绝 JS Promise，native 继续；漂移 key 重试 |
| CME 外层 withTimeout | 7s | 同上 |
| TerminalCore ready | 30s | 返回 TIMEOUT，触发有缺陷的按 Map 关闭 |

结果：JS 已判失败并制造第二个 key 时，native 仍可能在创建。

证据：`main.js:66-94,331-338`；`LocalTerminalProvider.kt:119-159,261-305`

### Root Cause C（已确认）：hidden 会话缺生命周期 owner

- hidden shell 在私有 `hiddenExecShells` Map，可见会话在 `SessionManager`，两套 registry。
- 无 list/close hidden executor 的公开 API；终端 UI 删可见 session 清不到 hidden。
- `Application.onTerminate()` 是全量清理唯一路径，但 Android 生产环境不可靠（突然杀进程不执行）。

证据：`LocalTerminalProvider.kt:52-55,75-83`；`MainActivity.kt:456-473`；`OperitApplication.kt:598-627`

### 放大因素（CME 侧）

- `ensureWorkerUp()` 每次提交前强制 `freshKey()`；`hiddenExecSafe()` 首败再漂移一个新 key。
- JS 超时不取消 native；`start_worker.sh` 的 `/tmp/cme_start_worker.lock` SIGKILL 时 trap 不执行（次级风险）。

### 尚待区分（推测）

- 「启动早期」精确竞态点（TerminalManager 默认 visible session 异步初始化 vs hiddenExec 并发）。
- 旧 idle orphan 让全新 key 的下一次 hiddenExec 失败的精确机制（串行队列？资源压力？）。
- `do_wait/pipe_read/do_select` 单独不能判坏（健康持久 shell 也是此等待态）。

## 修复方向

- P0：创建失败直接关闭局部 shell（TerminalCore 最小修复，消除确定泄漏）。
- P0-B：统一 timeout/取消所有权（timeoutMs 覆盖完整调用；JS Promise.race 不能当取消）。
- P0-C：启动前查询 + owner-scoped 定向清理（hiddenExec 下层；不能让 CME 用坏通道自查）。
- P0-D：运行中保存 root PID/child PGID + `/proc` starttime 生命周期。
- P1：持久 registry + 内核锁处理跨重启；收敛 CME 的 freshKey/重试；修正 worker lock。
- 明确不采用：杀所有 bash/proot、只延迟 onAppCreate、只加熔断时间、让用户删终端页 session、CME 用 hiddenExec 跑清理脚本。

## 验证方式（新增 worker 启动测试必须覆盖）

- 无 orphan terminal 增长（连续 100 次启动早期 hiddenExec + App 重启）。
- 失败后 deadline + 清理宽限期内对应 root PID/child PGID 消失。
- 每个 owner/executorKey 同时最多一个 STARTING|READY|RUNNING 记录。
- `T1 后无 T3` 时日志能落到 ENV_INIT / PROCESS_START / WAIT_READY / WRITE_COMMAND / WAIT_RESULT / CLEANUP 中某一阶段。
- 清理零误杀（用户终端、其他插件、CME worker 均保持生命周期）。

## 关联

- 原始报告：`reports/codex/cme-session-leak-audit.md`
- 架构文档：`docs/architecture/terminal-session-lifecycle.md`
- 工作区索引：`/storage/emulated/0/Download/workspace/operit-developer-workspace/`（DECISION_LOG / PROJECT_STATUS / BUG_HISTORY）

# CME hiddenExec / session leak 修复决策审计

- 日期：2026-08-10
- 审计性质：方案对齐审计；只读核对源码与既有报告，未修改任何代码
- CME 基线：v2.4.9，源码基线 `2cf5a1a493a6daf533fcb91fd284e4c6b4f5224f`
- Operit 基线：`2e9c76e45c561d5fe34d43e71eb2aa7259576216`
- TerminalCore 审计基线：`f85be57944b806de4d863dee8b10d80d04daa236`

复核说明：当前 CME `HEAD` 为仅新增审计文档的 `a0dcc83`，本专项涉及的 `main.js`、`packages/memory_engine.js`、`start_worker.sh`、`manifest.json` 相对 `2cf5a1a` 无代码差异。Operit 仓库记录的 TerminalCore gitlink 为 `f85be579`；本环境可直接读取的 `/root/OperitTerminalCore` checkout 为 `e4442bc`，下文引用的关键控制流和首次源码审计所列 `f85be579` 行为一致。凡运行时现象仍以三份输入文档的证据分级为准，不把本次无法取得的原始设备日志提升为源码事实。

## 1. 最终决策

结论不是“CME 与 Operit 二选一负责”，而是三层结论：

1. **已验证的直接泄漏根因在 Operit TerminalCore。** `createHiddenExecShell()` 已经创建 `Process` 和本地 `HiddenExecShell`，但 ready 失败时按 `executorKey` 从 `hiddenExecShells` Map 关闭；对象此时尚未入 Map，关闭为空操作，局部 shell 及其进程树失去 native owner。证据：`/root/OperitTerminalCore/src/main/java/com/ai/assistance/operit/terminal/provider/type/LocalTerminalProvider.kt:194-205,208-258,483-492`。
2. **CME 的 5 秒 race 不是上述泄漏缺陷本身，而是明确的触发条件与放大因素。** 它让 JS 在 native 最长仍可创建 30 秒时先失败，并立即换 key 再提交一次；一次 Worker 拉起可并存两条 native 创建/执行链。证据：`main.js:66-94,329-338`；`/root/OperitTerminalCore/src/main/java/com/ai/assistance/operit/terminal/provider/type/LocalTerminalProvider.kt:119-159,261-305`。
3. **应拆成 CME patch 与 Operit patch，独立发布、独立验收。** CME patch 现在就止住自动触发与重复制造，并建立自己可管理的 Worker/可见控制 session 生命周期；Operit patch 修复 hidden shell 的资源所有权、deadline、取消和跨实例回收。CME 发布不应等待上游。
4. **CME 应立即加启动前防御，但只能清理“可证明由 CME 拥有”的可见控制 session、启动 attempt 和 Worker lock。** CME 当前无 API 枚举/关闭 hidden executor，更无法安全识别创建失败后未进 Map 的 orphan；hidden orphan 的自动 reconcile 必须位于 TerminalCore 下层。证据：`/root/operit/examples/types/system.d.ts:270-335`；`/root/OperitTerminalCore/src/main/java/com/ai/assistance/operit/terminal/provider/type/LocalTerminalProvider.kt:52-55,75-83`。
5. **V2.1 的“启动期零 terminal、普通业务离线快速失败、显式恢复优先 persistent terminal、hiddenExec 退出生产启动链”方向成立。** 但 persistent terminal 目前只能定性为“生命周期模型已有真机实验支持、CME 项目级闭环仍待验证”，不能写成已经完成的生产修复。证据：`reports/codex/input/CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md:33-62,558-584`。

本文中的标签含义：

- **已验证事实**：可由固定版本源码直接推出，或仅复述报告明确保存的实验结果；后者标为“实验记录”。
- **推断**：源码允许、现象支持，但缺少同轴时序或原始运行附件。
- **建议**：实施决策，不冒充既有行为。

## 2. 三份文档的对齐结果

三份文档的角色和采信顺序如下：

| 文档 | 本次用途 | 审计结论 |
|---|---|---|
| `reports/codex/cme-session-leak-audit.md` | 固定版本源码事实层 | 作为根因与证据边界的主基线。该文档明确区分源码事实、实验摘要和待证推测：`reports/codex/cme-session-leak-audit.md:11-34,38-50`。 |
| `reports/codex/input/CME_CODE_AUDIT_REPORT_2026-08-10.md` | CME 全局静态/动态审计 | 用于补充 Worker 部署、restart、bridge race、进程匹配等邻接缺陷；它的全项目优先级不被本专项重排覆盖。相关项见 `reports/codex/input/CME_CODE_AUDIT_REPORT_2026-08-10.md:368-456,708-750,856-890`。 |
| `reports/codex/input/CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md` | 已有架构方案 | 主方向采纳，但将“persistent terminal 已验证程度”“CME 可清理的 orphan 范围”和“5 秒 race 的因果地位”按源码事实收窄。V2.1 自身保留的待验证边界见 `reports/codex/input/CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md:64-85,558-584`。 |

### 2.1 已被源码证实、应保留的设计判断

| 设计判断 | 结论 | 证据与解释 |
|---|---|---|
| hidden shell 创建失败存在确定泄漏 | **已验证事实** | 新对象在 `createHiddenExecShell()` 成功返回后才写 Map；ready 失败却调用按 Map 查找的关闭函数。`LocalTerminalProvider.kt:194-205,208-258,483-492`；首次审计也在 `reports/codex/cme-session-leak-audit.md:134-155` 给出了相同控制流。 |
| CME 5 秒超时不会取消传入 Promise | **已验证事实** | `withRace()` 只设置 `done` 并 reject，未调用任何 cancel；catch 随即生成新 key 再调用。`main.js:66-94`。 |
| CME 5/7 秒与 native ready 30 秒不一致 | **已验证事实** | native 先执行 `getOrCreateHiddenExecShell()`，之后才进入 `withTimeout(timeoutMs)`；ready 内部固定 30 秒。`LocalTerminalProvider.kt:119-159,261-305`；CME 外层见 `main.js:331-338`。 |
| `freshKey()` 与失败换 key 会膨胀会话 | **已验证事实** | 每次提交前先 `freshKey()`，失败后又生成一个时间戳 key。`main.js:60-65,85-94,329-332`；工具子包也有同构实现：`packages/memory_engine.js:387-412`。 |
| `onAppCreate` 会自动进入 terminal | **已验证事实** | lifecycle hook 注册于 `main.js:707-712`；延迟后部署、版本检查、hiddenExec kill 和 `ensureWorkerUp()` 位于 `main.js:632-685`。Operit 在应用初始化早期异步派发 hook：`/root/operit/app/src/main/java/com/ai/assistance/operit/core/application/OperitApplication.kt:187-205`。 |
| 普通业务失败也会触发 Worker 拉起 | **已验证事实** | `run()` 对任意非 success 结果调用 `ensureWorkerUp()`，未区分离线错误与业务错误。`packages/memory_engine.js:444-454`；完整代码审计也指出这一点：`reports/codex/input/CME_CODE_AUDIT_REPORT_2026-08-10.md:732-750`。 |
| launch lease 不是原子 single-flight | **已验证事实** | CME 先读租约、后写租约，异常被吞；两个入口可同时通过检查。`main.js:309-325`、`packages/memory_engine.js:325-340`。真正到 shell 后才由 `mkdir` 裁决：`start_worker.sh:19-25`。 |
| `start_worker.sh` 不是“T1 后无 T3”的首要位置 | **已验证事实（有前提）** | 脚本一进入就先写 begin/T3，之后才抢锁。若日志目录存在且可写，长期没有 T3 说明阻塞发生在脚本入口之前。`start_worker.sh:13-24`。 |
| visible terminal 与 hidden executor 是两套 registry | **已验证事实** | `activeSessions` 与 `hiddenExecShells` 分开保存。`LocalTerminalProvider.kt:52-55`。公开 API 对可见 session 有 create/close/screen/input，对 hidden 只有 execute，无 list/close。`/root/operit/examples/types/system.d.ts:270-335`。 |
| visible persistent terminal 可按名称 create/find | **已验证事实** | Tool 执行器从全局 `terminalState.sessions` 中按 title 返回第一个同名会话，否则新建。`/root/operit/app/src/main/java/com/ai/assistance/operit/core/tools/defaultTool/standard/StandardTerminalCommandExecutor.kt:30-74`。这支持 V2.1 的控制 session 方案，但也说明它不是 ToolPkg owner-scoped。 |
| hiddenExec timeout 结果可能被 CME 当提交成功 | **已验证事实** | 标准工具把 native TIMEOUT 包装成 `success=true, timedOut=true`。`StandardTerminalCommandExecutor.kt:369-400`。CME 只 await，不校验 `timedOut`、`exitCode` 或 `launch_submitted:<launchId>`：`main.js:330-340`。 |
| App/UI 生命周期没有可靠清理兜底 | **已验证事实** | `MainActivity.onDestroy()` 不清 Terminal：`/root/operit/app/src/main/java/com/ai/assistance/operit/ui/main/MainActivity.kt:456-473`；`TerminalService.onDestroy()` 仅取消 job/callback：`/root/OperitTerminalCore/src/main/java/com/ai/assistance/operit/terminal/service/TerminalService.kt:103-107`；全量 destroy 仅在 `OperitApplication.onTerminate()`：`OperitApplication.kt:598-627`。 |
| hiddenExec 与 persistent terminal 应分健康域 | **已验证事实 + 合理设计结论** | 两者走不同 registry/API；hidden 失败不能从源码推出 visible session 也失败。registry 证据见 `LocalTerminalProvider.kt:52-55`，API 证据见 `system.d.ts:270-335`。V2.1 的状态拆分见 `CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md:422-473`。 |

### 2.2 V2.1 中需要修正或收窄的假设

| 原判断/暗含假设 | 修正后的定性 | 修正理由 |
|---|---|---|
| “5 秒 race 是根因” | **错误；应改为触发条件/放大因素。** | 不存在 CME race 时，TerminalCore 自身 30 秒 ready 失败仍会走错误关闭路径并泄漏；存在 race 但 native 最终 ready 成功时，shell 仍会入 Map，可能成为多余的已注册会话，但不必然成为 orphan。根缺陷是失败路径没有直接释放局部对象。 |
| “JS timeout 后 native owner 立即丢失” | **需要收窄。** | JS caller 放弃结果不等于 native registry owner 已丢失。真正可由源码证明的 owner 丢失发生在 native ready 失败且对象尚未入 Map时。`LocalTerminalProvider.kt:202-205,249-258,483-492`。 |
| “旧 orphan 会直接阻塞所有新 key” | **推断/实验相关性，尚未证明精确机制。** | 既有摘要支持残留与故障强相关，但缺少 app PID、native token、executor queue、PID/starttime 同轴时序。首次审计明确保留该边界：`reports/codex/cme-session-leak-audit.md:208-215,348-370`。 |
| “启动早期初始化竞态是历史故障根因” | **待证。** | TerminalManager 初始化时确实异步创建默认 visible session：`/root/OperitTerminalCore/src/main/java/com/ai/assistance/operit/terminal/TerminalManager.kt:127-147`；但这只能证明并发活动存在，不能证明具体锁、pipe 或 ready 竞态。V2.1 自身也已降级为待验证：`CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md:64-85`。 |
| `do_wait` / `pipe_read` / `do_select` 即坏会话 | **不能成立。** | 持久 shell 正常空闲或等待子命令时也可处于这些状态。判坏必须结合 owner/registry、PID starttime、协议 marker 和活跃 native 调用。首次审计边界：`cme-session-leak-audit.md:208-215`。 |
| “persistent terminal 已是 CME 已验证生产恢复链” | **过度表述。** | 已保存的实验只证明真实 ToolPkg 中 `terminal.create + terminal.input` 的任务可在 Tool 返回后继续；V2.1 明确承认 `start_worker.sh → HTTP ping_worker` 的 CME-specific 闭环仍未验证。`CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md:33-62,558-584`。 |
| persistent terminal “完全绕开 Terminal Manager” | **错误；它只绕开 hidden executor 子系统。** | 可见 session 和 hidden shell 最终仍由同一个 `TerminalManager`/provider 管理；persistent terminal 走 `SessionManager`/`activeSessions`，不是独立宿主服务。`TerminalManager.kt:155-188`；`LocalTerminalProvider.kt:52-55,85-117`。 |
| `terminal.create("cme-worker-control")` 天然 owner-scoped 且健康 | **错误。** | create/find 只按全局 session title 找第一个匹配项，不校验 ToolPkg owner、initState 或协议健康。`StandardTerminalCommandExecutor.kt:30-74`。必须使用包名命名空间、持久 registry 和 marker probe；仅“存在”不能等价于 healthy。 |
| CME 能在启动前枚举并清理 hidden orphan | **当前 API 下不可行且不安全。** | ToolPkg API 没有 `listHiddenExecutors` / `closeHiddenExecutor`；创建失败 orphan 甚至不在 native Map。`system.d.ts:300-317`；`LocalTerminalProvider.kt:249-252,483-492`。CME 不应通过 `/proc` 模糊匹配杀 bash/proot。 |
| 只要把 key 固定就能修复 | **条件不成立。** | 当前复用判断只检查 `process.isAlive`，没有 writer/reader/marker probe；固定 key 可能永久复用坏 pipe。`LocalTerminalProvider.kt:186-205`。只有平台先补协议健康检查和精确 close/recreate 后，稳定 key 才是上游正确策略。 |

### 2.3 完整代码审计报告对本议题的补充

`CME_CODE_AUDIT_REPORT_2026-08-10.md` 的全局 P0/P1 排序覆盖数据完整性、UI 和备份安全，不应被本报告的“session leak 专项 P0”替换。对本专项直接相关且应并入路线的内容有：

- `deploy_restart(force)` 实际会在 Worker 在线时提前返回，必须在迁移 launcher 时一并修正：`reports/codex/input/CME_CODE_AUDIT_REPORT_2026-08-10.md:368-405`；现源码为 `packages/memory_engine.js:318-322,892-900`。
- `start_worker.sh` 未注册为 ToolPkg resource，全新安装可能没有启动脚本：`CME_CODE_AUDIT_REPORT_2026-08-10.md:409-431`；现 manifest resources 为 `manifest.json:46-71`。
- 当前脚本用 `*worker.py*` 扫描并 kill，可能误杀其他项目：`CME_CODE_AUDIT_REPORT_2026-08-10.md:708-728`；现源码为 `start_worker.sh:50-62`。
- UI 局部 Promise race 同样不能取消底层调用，说明“取消语义只在表层”不是 Worker 启动链独有问题：`CME_CODE_AUDIT_REPORT_2026-08-10.md:435-456`。

## 3. 对三个重点问题的直接回答

### 3.1 a. hiddenExec 5s race 是主因还是放大因素？

**决策：它是确定的触发条件与放大因素，不是资源泄漏的主根因。**

已验证的完整顺序是：

```text
CME 调用 hiddenExec(timeoutMs=5s)
  → native 先创建 shell，并最多等 ready 30s
  → JS 5s race 先返回失败（不取消 native）
  → CME 换新 key 再发一次
  → 原 native 若 ready 成功：shell 入 Map，可能成为多余但仍受管的 session
  → 原 native 若 ready 失败：按 key 关闭尚未入 Map 的对象，形成 orphan
```

因此应把因果关系写成：

- **主根因**：TerminalCore 的资源所有权移交顺序与失败清理错误。
- **触发窗口**：shell ready 慢/失败，或调用异常终止，使 native 进入创建失败/取消路径。
- **放大器**：CME 5 秒 race、7 秒外层 race、fresh key 和二次重试。
- **尚未证明**：某个已 orphan 的 idle proot 通过哪一个具体全局锁/队列让下一条新 key 挂起。

这比“5 秒太短导致泄漏”更精确：把 5 秒改为 30 秒只能缩小分叉概率，不能修正 `create → fail → close` 的空操作。

### 3.2 b. CME 是否应立即做启动前检查和孤儿清理？

**决策：应立即做防御，但按资源所有权分层。**

CME patch 应立即做到：

1. 任何启动 attempt 前先做有限 HTTP health；已 ready 则不触碰 terminal。
2. 检查并原子领取 CME 自己的 `activeAttemptId`；已有有效 attempt 时只观察，不重复投递。
3. 使用全限定稳定名称，例如 `com.operit.character_memory_engine:worker-control`，保存 `sessionId + sessionName + attemptId + launchId + lastProbeAt`。
4. 对该可见控制 session 做 marker 往返健康检查；失败时仅关闭已从 CME registry 和精确 sessionId 证明归属的 session，再创建一个。
5. 启动前检查 Worker lock owner；只能按 `PID + /proc starttime + 完整 cmdline + launchId` 判断 stale，不能按 `*worker.py*` 或 `killall` 清理。
6. 投递后以 `launchId` 的结构化 result/日志和 HTTP `ping_worker` 判定成功，不以 input 已接受、session 存在或 shell 返回 0 判成功。

CME patch **不能**做到：

- 枚举或关闭 private `hiddenExecShells`；
- 修复已在 TerminalCore 创建失败路径中丢失 Map owner 的 shell；
- 仅凭 `proot`、`bash -lc`、wchan 或模糊 cmdline 自动杀进程；
- 用已损坏的 hiddenExec 通道运行 hiddenExec 清理脚本。

因此“发现孤儿清理”必须拆成两句话：

- **CME：**清理自己的 stale visible control session、启动 attempt 和 Worker lock。
- **Operit：**reconcile hidden executor/orphan，包括升级前遗留对象；需要 owner 元数据或受限迁移扫描。

上游最小修复只能阻止新的创建失败泄漏，不能自动消除升级前已有 orphan；这正是 CME 必须先停止自动进入 hiddenExec、平台还需提供 startup reconcile 的原因。

### 3.3 c. 是否拆成 CME patch 与 Operit patch？

**决策：必须拆。** 两个 patch 的责任、发布节奏和验收条件不同。

| Patch | 必须包含 | 明确不包含 | 可独立验收 |
|---|---|---|---|
| CME patch | `onAppCreate` health-only；普通业务离线快速失败；生产链移除 hiddenExec/fresh-key retry；全局 launch single-flight；可见控制 session registry/probe/精确重建；Worker lock stale 检查；ACK + HTTP 验证 | 不扫描或泛杀 hidden proot/bash；不假装 JS timeout 等于取消；不在 persistent terminal 失败后 fallback hiddenExec | 关闭 Worker 后启动 Operit不产生新 hidden executor；显式恢复只产生一个 CME 控制 session/attempt；hiddenExec 已坏时仍能按验证结果独立处理 persistent session |
| Operit patch | 创建局部 shell 失败直接关闭局部对象；deadline 覆盖 create/ready/command；可传播取消或返回前完成清理；按 owner 的 hidden registry/probe/reconcile；有界 wait/force-kill/后代校验 | 不把清理责任推给 ToolPkg；不依赖 `Application.onTerminate()`；不按模糊 cmdline 清理所有 shell | ready 前故障注入后 Map 无记录且 PID 树消失；调用 timeout 后宽限期内无对应 root/PGID；重启后 stale owner 可被定向回收 |

Operit patch 内部建议再分两个可审查提交：

1. **最小 P0 提交：**`create shell → ready fail → close(shell)`，修正确定泄漏且不依赖新 API。
2. **生命周期提交：**统一 deadline/cancel、持久 owner registry、startup reconcile、owner-scoped list/close 或平台自动回收。

这样不会让较大的 registry 设计阻塞确定 bug 的最小修复。

## 4. 责任边界

| 问题 | 责任归属 | 定性 |
|---|---|---|
| ready 失败关闭不到新建 shell | Operit TerminalCore | **直接根因；已验证事实** |
| API timeout 不覆盖 shell create/ready | Operit TerminalCore | **平台契约缺陷；已验证事实** |
| TIMEOUT 包装为 `success=true` | Operit bridge/工具层 | **容易被调用方误判；已验证事实** |
| hidden executor 无 owner-scoped list/close | Operit API | **平台能力缺口；已验证事实** |
| close 只有 writer close + `Process.destroy()`，无等待/升级/后代校验 | Operit TerminalCore | **实现缺口；实际必然残留与否仍需故障注入**。`LocalTerminalProvider.kt:483-492` |
| 生命周期仅依赖 `onTerminate()` 全量清理 | Operit App 生命周期 | **不可靠兜底；已验证事实** |
| `onAppCreate` 自动触发 hiddenExec | CME | **触发因素；已验证事实** |
| 5/7 秒 JS race 不取消 native | CME | **交互放大器；已验证事实** |
| fresh key + retry 产生并行调用/会话 | CME | **会话膨胀因素；已验证事实** |
| 不检查 `timedOut/exitCode/ACK` 就写 T2 | CME | **成功判据错误；已验证事实** |
| 两套 `ensureWorkerUp` + 非原子 lease | CME | **重复提交风险；已验证事实** |
| `mkdir` lock 可在 SIGKILL 后残留 | CME | **次级恢复风险；不是 T1 无 T3 根因**。`start_worker.sh:13-25` |
| JS 已放弃、native 仍创建，随后失败清理为空 | CME × Operit | **两者交互故障** |
| 旧 orphan 如何使所有新 key 挂起 | 未定案 | **推断/待证，不分配虚假精确责任** |

## 5. 重新评估的优先级

这里的 P0/P1 只针对 hiddenExec/session leak 与 Worker 恢复专项，不覆盖完整代码审计中的数据安全 P0。

### P0 必须

#### CME P0

1. `onAppCreate` 改为有限 HTTP health-only；删除其部署、版本 kill、persistent terminal 和 hiddenExec 启动动作。当前风险路径见 `main.js:632-685`。
2. 普通业务只在明确连接失败时返回 `WORKER_OFFLINE`，不得对任意业务失败自动 `ensureWorkerUp()`。当前行为见 `packages/memory_engine.js:444-454`。
3. 删除生产链中的 `freshKey()`、hiddenExec 自动二次重试和 60 秒自动解除 broken；legacy hiddenExec 默认关闭，仅留隔离诊断。当前实现见 `main.js:58-94,194-215,329-338`、`packages/memory_engine.js:268-298,387-412`。
4. 建立一个跨入口 launch coordinator：原子 single-flight、`attemptId/launchId`、状态机、幂等观察；不能继续依赖先读后写的软 lease。
5. 若本版本交付 persistent terminal 恢复，则其上线门槛必须包括：全限定稳定 session 名、CME registry、协议 probe、精确 close/recreate、结构化 ACK/result、最终 HTTP health，以及 V2.1 所列 CME-specific 真机闭环。待验证边界见 `CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md:558-584`。
6. 将 `start_worker.sh` 注册并部署为 ToolPkg resource，否则恢复架构在 fresh install 上不闭环。现缺口见 `manifest.json:46-71`。

#### Operit P0

1. ready 失败直接关闭局部 `HiddenExecShell`，并用 `try/finally` 覆盖创建过程中所有异常。不能再调用只查 Map 的 key 重载。
2. 让 API deadline 覆盖 environment init、get/create、ready、command 和 cleanup，或显式拆为 startup/command deadline；返回 caller 前必须完成取消或进入可查询的 `CLOSING` 状态。
3. close 实现加入：停止写入、终止当前 PGID、root process terminate、有界 wait、force kill、cancel/join reader、关闭 channel、后代与结果校验。
4. 修正 TIMEOUT 契约。当前类型声明“取消命令并保留 executor”：`system.d.ts:300-310`；实现却在 timeout 后异步关闭整个 shell：`LocalTerminalProvider.kt:150-163`；工具层又返回 `success=true, timedOut=true`：`StandardTerminalCommandExecutor.kt:377-400`。三者必须统一。

### P1 推荐

1. **CME Worker lock 生命周期：**优先使用环境已验证可用的 `flock`；否则 lock 记录 `pid + starttime + launchId` 并仅在 owner 精确失效时回收。当前裸 `mkdir`/trap 见 `start_worker.sh:19-25`。
2. **CME Worker 身份收紧：**停止使用 `*worker.py*` 泛匹配，至少核对完整脚本路径、端口、DB 路径、PID starttime。当前范围见 `start_worker.sh:50-62`。
3. **通道状态拆分：**Worker、persistent terminal、hiddenExec 分别保存状态；hiddenExec broken 不得推出整个 TerminalManager broken。V2.1 设计见 `CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md:422-473`。
4. **Operit owner-scoped registry：**保存 app instance、ToolPkg owner、session UUID、executor key、root PID/starttime、当前 PGID 和状态；同 key single-flight 并在新 app instance 启动时 reconcile。
5. **Operit public control plane：**提供 owner-scoped list/status/cancel/close，或平台内部全自动 reconcile；不能允许插件枚举其他插件/用户 terminal。
6. **legacy orphan 迁移清理：**对没有 registry 的旧版本残留只做严格特征、UID、路径、wrapper marker 和 PID/starttime 联合匹配；先审计记录，禁止 `killall bash/proot`。
7. 修正 `deploy_restart(force)`、结构化 result 文件、restart 的 PID/launchId 变化验收。当前假成功路径见 `packages/memory_engine.js:318-322,892-900`。

### 可延期

1. 新增通用 `terminal.execDetached` 可作为长期平台 API，但不应阻塞最小 leak fix 和 CME 止血。
2. persistent terminal 完成项目级闭环后，是否允许 UI `onLoad` 自动恢复可延期；`application_on_create` 自动启动不应恢复。
3. “干净冷启动 + 短 echo”用于区分初始化竞态与前序 poisoning 的研究可延期，不阻塞已知根因修复。
4. 自动清理无 owner 元数据的所有历史 proot/bash 不进入当前版本；在无法证明归属时宁可给用户明确的 force-stop/升级恢复指引，也不能误杀用户 terminal、其他 ToolPkg 或 SSH 任务。

## 6. 最终实施路线

### 6.1 CME 临时 workaround：立即发布，不等 Operit

建议分两步交付：

#### CME Hotfix（先止血）

```text
onAppCreate
  → HTTP health only
  → online: ready
  → offline: 记录 offline，结束

普通业务
  → HTTP
  → 明确 offline: 快速返回 WORKER_OFFLINE
  → 不自动启动、不碰 terminal

legacy hiddenExec
  → 默认关闭
  → 无 fresh key、无自动 retry、无定时自愈
```

验收：Worker offline、冷启动 Operit 20 次，CME 不创建 hidden executor，不出现因 CME 自动路径新增的 proot/bash；业务错误不触发 launcher。

#### CME Recovery Patch（显式恢复）

```text
用户点击“启动 Worker”
  → HTTP health
  → 原子领取 activeAttempt
  → reconcile CME registry 中的 visible control session
  → marker probe
      ├─ healthy: 复用
      └─ stale/broken 且 owner 可证: close(sessionId) → create
  → input 带 attemptId/launchId 的启动命令 + Enter
  → 读取结构化 result / HTTP ping_worker
  → ready 或明确 failed
```

控制 session 名使用全限定包名，降低 `create()` 只按 title 全局匹配造成的碰撞风险。公开 API 没有 visible session list；未知重复 session 无法由 CME 自动枚举，必须由平台补 owner 能力或仅管理 CME 已保存的精确 ID。API 边界见 `system.d.ts:270-335`，按 title 复用实现见 `StandardTerminalCommandExecutor.kt:46-74`。

该 patch 同时修正 Worker lock、资源部署、restart 和 ACK。上线前必须完成：

- Worker offline → persistent terminal → `start_worker.sh` → HTTP ready；
- hiddenExec 故意保持 broken 时，persistent terminal 独立启动 Worker；
- stale session、session 丢失、重复点击、脚本 SIGTERM/SIGKILL 后可恢复；
- 每次只有一个 attempt、一个有效 CME control session、一个 Worker。

### 6.2 Operit 上游修复建议

#### 上游最小修复

把生命周期所有权改为：

```text
ProcessBuilder.start()
  → 立即由局部 HiddenExecShell owner 承担清理责任
  → ready 成功后才转移到 Map owner
  → 转移前任意异常/超时：close(local shell)
  → 转移后关闭：remove(key) + close(shell)
```

这就是应最先合并的 `LocalTerminalProvider create shell → fail → close shell` patch。

#### 上游生命周期闭环

1. 整次 hiddenExec 使用单一 deadline/token，覆盖 init/create/ready/write/wait/cleanup。
2. shell 状态采用 `STARTING → READY → RUNNING → CLOSING → CLOSED`；Map/registry 在 `STARTING` 即登记，失败原子删除。
3. 复用不能只看 `process.isAlive`；必须 marker probe writer、reader 和协议往返。当前仅 isAlive 判断见 `LocalTerminalProvider.kt:186-205`。
4. 保存 owner-scoped 持久 registry；新 app instance 不能重接旧 Java pipe，应先按 PID/starttime 精确终止再重建。
5. 对旧版本 orphan 提供一次严格受限的 migration reconcile，并记录每个候选、匹配条件和清理结果。
6. App/Service 生命周期清理只是额外兜底，不能替代每次调用的结构化资源所有权。

### 6.3 长期架构优化

优先级从近到远为：

1. **近期生产架构：**`onAppCreate` health-only；显式 `PersistentTerminalLauncher`；hiddenExec diagnostics-only。
2. **平台成熟后：**提供真正 detached、owner-scoped、可查询、可取消、kill-on-timeout 的 one-shot API。其契约应包含 requestId、状态查询、进程组回收、App 重启 reconcile 和明确 ACK。
3. **CME launcher 抽象：**业务只依赖 `workerLauncher.start/status/cancel`；persistent terminal 与未来 detached exec 是可替换实现，legacy hiddenExec 不注册为生产 launcher。
4. **状态权威分离：**Worker 可用性的唯一最终判据是 HTTP health；launcher/session/result 文件只解释启动过程，不能替代 Worker readiness。

persistent terminal 是当前有实验支持的兼容路线，但仍共享 TerminalManager/visible provider，不是终局隔离。长期首选应是平台原生 `execDetached` 或等价的受管后台任务 API，而不是永久依赖一个用户可见 shell。

## 7. 验收门槛

### CME patch

- `application_on_create` 源码路径不调用任何 terminal API。
- Worker offline 时普通工具在有限时间内返回 `WORKER_OFFLINE`。
- 并发 10 次显式启动只产生一个 attempt 和一次实际脚本投递。
- CME 只关闭 registry 中可证明属于自己的 sessionId；无 `/proc` 模糊清理。
- session probe 失败可精确重建；未知 session 不误杀。
- `start_worker.sh` 是正式 resource，fresh install 可从空 ROOT_DIR 启动。
- SIGTERM/SIGKILL 故障注入后 Worker lock 可恢复。
- 成功必须同时满足匹配 launchId 的 result/ACK 与 HTTP `ping_worker`。

### Operit patch

- 在 `ProcessBuilder.start()` 后、`TERMINAL_READY` 前注入失败，deadline + cleanup grace 后 root PID 及后代全部消失。
- ready 延迟超过 caller deadline 时，不产生第二个由平台隐式存活的 starting shell。
- pipe 半断且 `process.isAlive=true` 时，协议 probe 判坏并精确重建。
- timeout、exception、App instance 更替三条路径均有确定的 registry 状态和 close 结果。
- 升级前 legacy orphan 的处理零误杀；无法证明 owner 的候选只报告、不自动 kill。
- visible terminal、其他 ToolPkg、SSH/用户会话不受 CME hidden executor 清理影响。

## 8. 最终定性

最终采用以下表述作为修复方案基线：

> TerminalCore 的 hidden shell 创建失败清理错误是已验证的直接泄漏根因；CME 的启动期 hiddenExec、5/7 秒非取消 race、fresh key 和自动重试是已验证的触发与放大因素。旧 orphan 使所有新 key 挂起的具体内部机制仍待同轴日志证明。立即拆分 CME 与 Operit 两个 patch：CME 先停止生产路径使用 hiddenExec，并只 reconcile 自己可证明拥有的 visible session/attempt/Worker lock；Operit 修复 `create → fail → close(local shell)`，随后补全统一 deadline、owner registry 和跨实例 orphan reconcile。长期以受管 `execDetached` 替代 persistent shell，HTTP health 始终是 Worker ready 的最终真值。

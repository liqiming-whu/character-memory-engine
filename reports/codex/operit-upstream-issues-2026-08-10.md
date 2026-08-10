# Operit 上游修复 Issue（2026-08-10）

> 来源：CME（Character Memory Engine）session leak 专项审计（`reports/codex/cme-session-leak-audit.md` + `cme-session-leak-implementation-plan.md` Phase 2）
> 证据基线：`AAswordman/Operit` @ `2e9c76e45c561d5fe34d43e71eb2aa7259576216`；`AAswordman/OperitTerminalCore` @ `e4442bc6a047b6165bf59103721ad143149c620d`；Operit `terminal` 子模块记录 `f85be57944b806de4d863dee8b10d80d04daa236`
> 行号均为上述检出的实施前锚点；实现后行号会移动，提交说明应同时保留符号名。

---

## Issue 1（P0）— hiddenExec 创建失败时 local shell/process tree 泄漏

**严重性**：高。每次 hidden shell 创建失败都会留下无人管理的 proot+bash 进程树；跨 Operit 重启残留，累积后全局挂起（CME 已多轮实锤）。

### 根因

`LocalTerminalProvider.kt`：
- `getOrCreateHiddenExecShell()`（:186-206）：`createHiddenExecShell()` 成功后才 `hiddenExecShells[executorKey] = created`（:203）。
- `createHiddenExecShell()`（:208-259）：`process.start()`（:214）之后、`awaitHiddenExecReady()`（:249）失败时调用 `closeHiddenExecShell(executorKey)`（:251）——**此时 shell 尚未入 Map**。
- `closeHiddenExecShell(executorKey)`（:483-493）：`hiddenExecShells.remove(executorKey)?.let { ... }`——Map 无 entry 时 `.remove()` 返回 null，**整个 cleanup 块（writer.close / process.destroy / readJob.cancel / outputChannel.close）全部跳过**。

**结果**：ready 失败 → key 版 close 是空操作 → local process/reader/channel 无 owner → 泄漏。这也解释了大量 `bash --noprofile --norc` 卡在 `pipe_read` 的孤儿进程。

### 修复建议

1. 新增幂等对象版 closer（如 `closeHiddenExecShell(shell: HiddenExecShell)`），至少：关闭 writer、destroy root、有界等待、必要时 force destroy、cancel/join reader、close channel，并记录结果。
2. `createHiddenExecShell()` 的 ready 失败分支改为直接调用对象版 closer（:251）。
3. Map 插入异常时同样直接 close 已创建的局部对象。
4. key 版 closer 只做 `remove(key)` 后委托对象版。
5. 故障注入测试：process start 后、ready 前失败 100 次，每次 deadline + cleanup grace 后 root PID 和全部后代均不存在；`hiddenExecShells[key]` 无残留；正常路径行为不变。

---

## Issue 2（P1）— hiddenExec 生命周期缺少统一 deadline（timeout 语义分裂）

**严重性**：中高。caller 的 `timeoutMs` 只包裹命令执行，不覆盖环境初始化与 ready 阶段；ready 硬编码 30 秒，与 JS 侧常见 5s 超时严重不一致——JS 已超时返回，native 仍在跑 30 秒（或更长），表现为「工具返回后 shell 还活着」并污染通道。

### 证据

- `TerminalManager.executeHiddenCommand()`（TerminalManager.kt:1365-1385）：`initializeEnvironment()`（:1370）在 timeout 之外执行；`timeoutMs` 直到 :1380 才传给 provider。环境初始化自身有独立 30 秒超时（TerminalManager.kt:173 `withTimeoutOrNull(30000)`）。
- `LocalTerminalProvider.awaitHiddenExecReady()`（LocalTerminalProvider.kt:261-305）：ready 等待硬编码 `withTimeout(30000L)`（:264），不接收 caller 剩余预算。
- `StandardTerminalCommandExecutor.kt`：timeout 由各调用点 `withTimeout(timeout)` 包裹（:134/:262/:362），`timedOut = didTimeout` 包装（:172/:323/:398）——JS 返回与 native 停止无同步保证。

### 修复建议

1. 单一 monotonic deadline：`executeHiddenCommand` 入口创建 deadline，覆盖 environment init、provider get/create、ready、mutex wait、write、command wait、cancel、cleanup 全链。
2. ready 等待使用 caller 剩余 deadline，不写死 30 秒；startup timeout 直接清局部 shell（配合 Issue 1 对象版 closer）。
3. 各 provider（TerminalProvider.kt:68-77、SSHTerminalProvider.kt:160-185）接口接收 deadline/remaining budget，避免 provider 间语义分叉。
4. 明确 JS 侧 `success/timedOut/exitCode` 契约：timeout 返回前目标 native command 已停止，或进入可查询且有界的 `CLOSING`。兼容性确认前保持返回数据 shape。
5. 端到端测试：`hiddenExec("trap '' TERM; sleep 120", { timeoutMs: 1000 })`，断言 `timedOut==true`、`jsReturn-jsStart<=timeout+grace`、`childPgid 不存在`。

---

## Issue 3（P2）— hidden shell 无持久 owner registry，App 进程丢失后无法精确回收

**严重性**：中。owner 只存在于 Java Map/Process handle；App 进程被 kill/崩溃后无持久记录可安全定位旧 root。CME 只能做「绝不清理」的 containment，无法自愈。

### 证据

- `LocalTerminalProvider.kt`：hidden shell 只登记在内存 `hiddenExecShells` Map（:187/:203），无磁盘持久化。
- `OperitApplication.kt:120-121,195`：`onCreate()` 派发 `AppLifecycleEvent.APPLICATION_CREATE`，无 hidden owner reconcile 步骤。
- `JsEngine.kt` / `JsNativeInterfaceDelegates.kt`（Operit 侧）：工具调用上下文未向 TerminalCore 传递 trusted caller owner scope。

### 修复建议

1. 新增 `HiddenExecOwnerRecord`：versioned record，含 `sessionUuid, ownerScope, executorKey, appInstanceId, appPid/appStartTicks, bootId, rootPid/rootStartTicks, currentCommandPgid, state, createdAt, updatedAt`。
2. 新增 `HiddenExecOwnerRegistry`：app-private 持久存储 + 原子事务/唯一约束；状态 `STARTING/READY/RUNNING/CLOSING/CLOSED`；每 `(ownerScope, executorKey)` single-flight。
3. 新增 `HiddenExecStartupReconciler`：只遍历 registry records，核对 bootId/PID/starttime/wrapper marker；stale 时定向 TERM/wait/KILL，记录审计，再原子删除。**不扫描全 /proc 找未登记 legacy orphan**。
4. `OperitApplication.kt` 在派发 APPLICATION_CREATE 前异步启动 hidden owner reconcile；hidden API await barrier。
5. trusted owner scope 必须来自 native execution context（JsEngine/JsNativeInterfaceDelegates 下传），不接受插件可伪造的普通参数；未贯通前 owner-scoped public close 不合并。
6. 测试：kill -9 App 重启后旧 registry root/PGID 消失、stale record 审计删除、新 hidden echo 成功、其他 owner/visible/SSH 零误杀。

---

## 建议提交顺序

1. **Umbrella bug issue**（本仓库）：附上述固定 SHA、最小复现控制流（CME 或独立脚本触发 hiddenExec 创建失败）、故障注入断言；不依赖进程截图。
2. **TerminalCore PR 1**（`fix(terminal): close hidden shell when startup fails`）→ 关闭 Issue 1；Operit 主仓单独 commit 更新 `terminal` gitlink。
3. **TerminalCore PR 2**（`fix(terminal): apply one deadline to hidden exec lifecycle`）+ Operit 协调 PR（`fix(tools): align hidden exec timeout contract`，更新 bridge/types/gitlink）→ 关闭 Issue 2。
4. **owner schema/design discussion** → **TerminalCore PR 3**（`feat(hidden-exec-owner-registry)`）+ Operit PR（`feat(hidden-exec-startup-reconcile)`）→ 关闭 Issue 3。
5. 可选：owner-scoped public control plane PR（鉴权完成后）。

> 约束：TerminalCore PR 合并后 Operit 用单独 commit 更新 gitlink，不把未合并临时 SHA 混入功能 PR；每阶段由上游复核现行 HEAD 后实施（行号会漂移）。

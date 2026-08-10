# CME worker 启动失败与 hiddenExec 会话残留审计

审计日期：2026-08-10  
审计方式：只读代码与既有记录；未修改源码，未运行构建或测试。  
审计版本：

- CME：`2cf5a1a493a6daf533fcb91fd284e4c6b4f5224f`（v2.4.9）
- Operit：`2e9c76e45c561d5fe34d43e71eb2aa7259576216`
- Operit TerminalCore 子模块：`f85be57944b806de4d863dee8b10d80d04daa236`

> 证据限制：当前工作区没有设备上的原始 `cold_probe.log`、`start_worker.log`、logcat、`/proc/*/{status,wchan,cmdline}` 快照，也没有既有记录所指的 `/sdcard/Download/CME暖启动复现实验记录.md`。因此，本文把“源码直接可证明的事实”“仓库中保存的实验摘要”“尚需原始运行证据验证的推测”严格分开。既有实验摘要见 `README.md:67-84`、`CHANGELOG.md:2-18`、`/root/workspace/operit-developer-workspace/BUG_HISTORY.md:9-24`。

## 一、结论摘要

### 1.1 已由源码证明

1. **TerminalCore 存在确定的 hidden shell 创建失败泄漏。** `createHiddenExecShell()` 先启动宿主进程，再等待 `TERMINAL_READY`；失败时调用 `closeHiddenExecShell(executorKey)`。但新 shell 只有在 `createHiddenExecShell()` 成功返回后才写入 `hiddenExecShells`。关闭函数只从这个 Map 取对象，所以创建期失败时关闭是空操作，刚创建的 `bash → proot → bash -lc → bash --noprofile --norc` 进程树失去管理。证据：`terminal/src/main/java/com/ai/assistance/operit/terminal/provider/type/LocalTerminalProvider.kt:186-205,208-258,483-492`。

2. **CME 的 JS 超时不取消原生 hiddenExec，并会自动再创建一个 key。** `withRace()` 只拒绝 JS Promise，没有取消传入 Promise；首个 5 秒超时后 `hiddenExecSafe()` 立即换 `cme_<timestamp>` 再调用一次。`ensureWorkerUp()` 外面还有 7 秒 `Promise.race`，同样不取消第二次原生调用。一次 worker 提交因此最多留下两条仍在 native 层运行的 hiddenExec 创建/执行链。证据：`main.js:66-94,329-338`。

3. **传给 hiddenExec 的 5 秒并不约束 hidden shell 的创建。** TerminalCore 在进入 `withTimeout(timeoutMs)` 之前先执行 `getOrCreateHiddenExecShell()`；创建中的 ready 等待写死为 30 秒。于是 CME 已在第 5/7 秒判失败、漂移 key 或熔断时，原生层仍可继续到第 30 秒。证据：`LocalTerminalProvider.kt:119-159,261-305`。

4. **hiddenExec 会话与可见终端会话是两套 registry。** 可见会话在 `activeSessions`/`SessionManager`，hidden shell 在私有 `hiddenExecShells`；公开 ToolPkg API 只有 hiddenExec，没有 hidden executor 的 list/close。终端 UI 删除可见 session 不能清理 hidden shell。证据：`LocalTerminalProvider.kt:52-55,75-83`；`examples/types/system.d.ts:270-317`。

5. **正常 UI/App 生命周期没有可靠兜住进程清理。** `MainActivity.onDestroy()` 不清理 Terminal；`TerminalService.onDestroy()` 只取消 service job/callback；Terminal 全量 `destroy()` 只在 `OperitApplication.onTerminate()` 调用。Android 生产环境的 `Application.onTerminate()` 不是正常退出/进程回收的可靠回调，突然杀进程也不能执行该清理。证据：`app/src/main/java/com/ai/assistance/operit/ui/main/MainActivity.kt:456-473`；`terminal/src/main/java/com/ai/assistance/operit/terminal/service/TerminalService.kt:103-107`；`app/src/main/java/com/ai/assistance/operit/core/application/OperitApplication.kt:598-627`。

6. **即使进入关闭路径，当前关闭动作也不完整。** hidden shell 关闭仅依次关闭 writer、`Process.destroy()`、取消 reader/channel；没有等待退出、强制升级、后代/进程组回收和结果校验。源码只能证明“未实现这些步骤”，不能据此断言每次 `destroy()` 都失败。证据：`LocalTerminalProvider.kt:483-492`。

### 1.2 审计定性

- **平台根缺陷**：TerminalCore 对 hidden shell 的创建期、取消期、跨进程重启期没有闭环生命周期管理；其中“创建失败关闭空操作”是确定的进程泄漏代码缺陷。
- **CME 放大因素**：启动钩子主动触发 hiddenExec；每次拉起先 `freshKey()`，失败又漂移一次；JS 超时早于 native 创建超时且不传播取消。这不改变资源所有权仍在 TerminalCore，但会增加触发次数与孤儿数量。
- **`start_worker.sh` 不是题述 `T1 后无 T3` 的首要根因**：脚本第一条业务动作就是写 begin/T3。若日志目录存在且可写，而 T3 始终没有出现，阻塞发生在脚本之前，即 hiddenExec shell 创建、命令投递或工具调度层。证据：`start_worker.sh:13-24`。
- **旧残留直接让下一次新 key 失败的精确机制仍未被源码或原始日志证明。** 可疑机制包括同进程工具执行队列仍被未取消的 native 调用占用、TerminalManager/provider 恢复竞态、以及多个 proot/管道残留造成的资源压力；这些都必须通过带 app instance、executor key、native token、PID 的时序日志验证，不能仅凭相关性定案。

## 二、背景与证据分级

### 2.1 既有实验摘要（不是本次可复核的原始日志）

仓库记录称：11 轮暖启动实验中，失败 4/4 均见残留、正常 7/7 无残留；失败时普通工具和可见 terminal 可用，CME hiddenExec 挂起，`start_worker.log` 为空，手动执行启动脚本约 2 秒成功；主动构造残留可复现，强杀清理后恢复。证据摘要：`/root/workspace/operit-developer-workspace/BUG_HISTORY.md:11-21`。

后续记录称：2026-08-10 通过 `/proc` 找到 proot、`bash -lc 'echo LOGIN_SUCCESSFUL; echo TERMINAL_READY; eval "$COMMAND_TO_EXEC"'` 及子 bash，清理后探针恢复为 `T1→T3→T4/T5→T6`。证据摘要：`README.md:67-83`。

这些摘要支持“残留与故障强相关、定向清理能恢复”，但由于原始 PID 树、时间戳和日志文件不在工作区，本次不能独立核验样本数、进程身份以及清理的最小充分集合。

### 2.2 事实、记录与推测的用词

- **事实**：可由当前固定版本源码直接推出，或仅复述当前代码行为。
- **实验记录**：仓库文档对真机结果的保存；没有原始附件时不提升为本次独立验证事实。
- **推测/待证**：源码允许但未证明实际发生，或只有现象相关性。

## 三、完整启动链路

### 3.1 App 生命周期进入 CME

1. Operit 在主应用初始化早期异步派发 `APPLICATION_CREATE`：`app/src/main/java/com/ai/assistance/operit/core/application/OperitApplication.kt:187-205`。
2. CME 注册 `application_on_create → onAppCreate`：`main.js:707-712`。
3. `onAppCreate()` 写 T0，检查 60 秒 channel broken 状态，然后延迟 10 秒执行部署、版本检查和 `ensureWorkerUp()`：`main.js:632-685`。
4. `ensureWorkerUp()` 先 HTTP ping；worker 已在线则直接返回。否则部署资源、检查/写入 90 秒 launch lease，然后进入 hiddenExec 提交：`main.js:287-325`。

注意：`launch_lease.json` 是“检查后再写”，不是原子锁；文件读写异常均被吞掉。它只能减少正常情况下的重复提交，不能保证冷启动单飞。脚本中的 `mkdir` 才是当前硬裁决。证据：`main.js:309-325`；`start_worker.sh:19-25`。

### 3.2 CME 从 fresh key 到 ToolPkg bridge

1. 每次真正提交前调用 `freshKey()`，把 key 改成 `cme_<timestamp>`：`main.js:60-65,329-330`。
2. 提交命令为：

   ```sh
   LAUNCH_ID=<id> nohup setsid bash /root/character_memory_engine/start_worker.sh </dev/null >>.../logs/start_worker.log 2>&1 & echo launch_submitted
   ```

   证据：`main.js:330`。
3. `hiddenExecSafe()` 以该 key 调 `Tools.System.terminal.hiddenExec(... timeoutMs=5000)`；JS 5 秒 race 失败后再生成一个新 key 并重试一次：`main.js:85-94`。
4. `ensureWorkerUp()` 又用 7 秒 race 包住整个 `hiddenExecSafe()`：`main.js:331-338`。
5. JS bridge 只把 `command`、`executor_key`、`timeout_ms` 转成 `execute_hidden_terminal_command` 工具调用：`app/src/main/java/com/ai/assistance/operit/core/tools/javascript/JsTools.kt:830-840`。
6. 标准工具执行器使用 `runBlocking` 调 Terminal；TIMEOUT 被包装成 `success=true, timedOut=true`，而 CME 没有检查 `timedOut`、`exitCode` 或输出是否含 `launch_submitted`。证据：`app/src/main/java/com/ai/assistance/operit/core/tools/defaultTool/standard/StandardTerminalCommandExecutor.kt:342-415`；`main.js:332`。

因此，T2 只表示 JS await 返回，并不严格证明启动命令已成功投递；T3 才是脚本确实进入的更强证据。

### 3.3 TerminalManager 到 hidden shell

1. `Terminal.executeHiddenCommand()` 转交给全局 `TerminalManager`：`app/src/main/java/com/ai/assistance/operit/core/tools/system/Terminal.kt:141-150`。
2. `TerminalManager.executeHiddenCommand()` 每次先 `initializeEnvironment()`，再取 singleton provider：`terminal/src/main/java/com/ai/assistance/operit/terminal/TerminalManager.kt:1360-1379`。
3. `TerminalManager` 构造时还会异步创建一个默认可见 Local session；这是启动早期并行活动的源码事实，但它是否就是题述竞态触发器仍是推测。证据：`TerminalManager.kt:127-184`。
4. Local provider 以 `executorKey` 查 `hiddenExecShells`，只用 `process.isAlive` 判定可复用；没有协议级 ping、管道可写性或 reader 健康检查：`LocalTerminalProvider.kt:186-205`。
5. 不存在时，`ProcessBuilder` 启动宿主 bash：

   ```text
   <app files>/usr/bin/bash -c 
     source $HOME/common.sh && login_ubuntu '/bin/bash --noprofile --norc'
   ```

   证据：`LocalTerminalProvider.kt:208-215,495-505,544-555`。
6. `login_ubuntu` 最终 `exec` proot，并在 Ubuntu 内运行：

   ```text
   /bin/bash -lc 'echo LOGIN_SUCCESSFUL; echo TERMINAL_READY; eval "$COMMAND_TO_EXEC"'
   ```

   其中 `COMMAND_TO_EXEC=/bin/bash --noprofile --norc`。证据：`terminal/src/main/java/com/ai/assistance/operit/terminal/TerminalManager.kt:1136-1141,1208-1253`。
7. reader 协程读 `process.inputStream`，`awaitHiddenExecReady()` 最多等待 30 秒直到看到 `TERMINAL_READY`：`LocalTerminalProvider.kt:216-249,261-305`。
8. ready 后，provider 将 CME 命令写入持久子 bash。命令被包装成临时脚本，再由 `setsid /bin/bash ... &` 启动；父 shell 记录 `$!` 并 `wait`，直到打印 END marker：`LocalTerminalProvider.kt:507-527`。

### 3.4 题述进程栈与源码的对应

题述进程可逐层映射为：

```text
Android/Java ProcessBuilder
└─ host bash -c "source common.sh && login_ubuntu ..."  （随后 exec）
   └─ proot
      └─ /bin/bash -lc "echo LOGIN_SUCCESSFUL; echo TERMINAL_READY; eval ..."
         └─ /bin/bash --noprofile --norc                 （持久 hidden shell）
            └─ setsid /bin/bash /tmp/operit_hidden_*.sh （一次命令）
```

- 顶层 `bash -lc` 等待持久子 bash，出现 `do_wait` 与设计一致。
- 持久子 bash 空闲时从 stdin/pipe 等命令，出现 `pipe_read`/`do_select` 也与设计一致。
- 执行 envelope 时，持久子 bash 会 `wait` 一次命令子进程，出现 `do_wait` 同样正常。

所以 **`S` 状态加 `do_wait/pipe_read/do_select` 只能识别“这像一条 hidden shell 进程树”，不能单独证明它坏了**。判坏至少还要结合：对应 registry/owner 是否存在、ready/命令 marker 是否能往返、是否有仍活跃的 native tool call、PID/starttime 是否属于旧 app instance。

### 3.5 hiddenExec 成功后到 worker ready

1. hidden envelope 收到提交命令后，外层命令后台启动 `start_worker.sh` 并输出 `launch_submitted`：`main.js:330`。
2. `start_worker.sh` 进入即写 begin/T3，再以 `/tmp/cme_start_worker.lock` 的原子 `mkdir` 做 single-flight：`start_worker.sh:13-25`。
3. 脚本准备目录、热备 DB、复制代码，按 pidfile 和 `/proc` 清理旧 `worker.py`：`start_worker.sh:27-63`。
4. 脚本以 `setsid`、完整 stdio 重定向启动 Python，并保存 `$!` 到 `worker.pid`：`start_worker.sh:65-73`。
5. `worker.py` 启动即再次写 `worker.pid` 和 T4；DB 初始化后、HTTP bind 前写 T5，随后监听 `127.0.0.1:8765`：`worker.py:31-46,1861-1887`。
6. CME 每 1.5 秒 HTTP ping，成功写 T6、删除 lease；45 秒未 ready 则写 60 秒保护窗口：`main.js:345-361`。

## 四、根因分析：事实与推测

### 4.1 确定根因 A：创建失败时关闭未注册对象，形成 orphan

关键顺序是：

```text
getOrCreateHiddenExecShell(key)
  ├─ created = createHiddenExecShell(key)
  │    ├─ ProcessBuilder.start()
  │    ├─ 构造本地 shell 对象
  │    ├─ awaitHiddenExecReady(shell)
  │    └─ 失败 → closeHiddenExecShell(key)  # 此时 Map 里还没有 created
  └─ hiddenExecShells[key] = created        # 仅成功返回后执行
```

`closeHiddenExecShell(key)` 的实现是 `hiddenExecShells.remove(key)?.let { ...destroy... }`。因此 ready 失败路径不会命中刚创建的局部变量，也不会销毁其 `Process`。这是无需运行时假设即可成立的逻辑错误。证据：`LocalTerminalProvider.kt:194-205,208-258,483-492`。

这也解释了为什么泄漏对象可能同时具备：

- 已有 proot 和 `bash -lc echo LOGIN_SUCCESSFUL...` 实体；
- Java hidden registry 中没有可关闭对象；
- 终端 UI 会话列表看不到；
- 后续 provider disconnect 无法按 key 枚举它。

### 4.2 确定根因 B：三层 timeout 语义不一致

当前存在三套时钟：

| 层 | 超时 | 到时行为 |
|---|---:|---|
| CME `withRace` | 5 秒 | 只拒绝 JS Promise；原调用继续；随后漂移 key 重试 |
| CME 外层 `withTimeout` | 7 秒 | 只拒绝包装 Promise；第二个原调用也可继续 |
| TerminalCore ready | 30 秒 | 返回 TIMEOUT；随后触发有缺陷的按 Map 关闭 |

证据：`main.js:66-94,331-338`；`LocalTerminalProvider.kt:119-159,261-305`。

另外，TerminalCore 的 `withTimeout(timeoutMs)` 只包住 ready 之后的 mutex/命令执行，不包含 `getOrCreateHiddenExecShell()`。这使 API 注释所表达的 timeout 不能覆盖完整 hiddenExec 操作。公开类型又声明 timeout 时“取消当前命令、保留 hidden executor”，与创建期行为没有明确契约。证据：`examples/types/system.d.ts:300-310`。

### 4.3 确定放大因素：fresh key 与 retry 不是“零膨胀”

`ensureWorkerUp()` 每次提交前强制 `freshKey()`；`hiddenExecSafe()` 首败再生成一个新 key。`README.md:88` 所写“固定 executorKey `cme`、正常 1 个会话零膨胀”与当前 worker 拉起路径不一致。事实是：worker 在线时 health check 避免提交；但每次真正拉起最多创建两个全新的 hidden executor，旧 key 没有显式关闭路径。证据：`main.js:60-65,85-94,303-332`。

这说明 CME 不是 TerminalCore 资源泄漏的所有者，但也不能简单定性为“完全不制造会话”：它确实触发并放大 hidden shell 创建。它不会创建实验摘要中的 `super_admin_default_session`，但会创建 `cme_<timestamp>` 会话。

### 4.4 为什么 Operit“重启”不能保证清理

这里必须区分三种重启语义。

#### A. 只销毁/重建 Activity 或插件 JS VM，App 进程仍在

- `TerminalManager.INSTANCE` 是进程内 singleton：`TerminalManager.kt:110-118`。
- `MainActivity.onDestroy()` 不调用 Terminal cleanup：`MainActivity.kt:456-473`。
- 因此 Java Map、正在执行的 `runBlocking`、proot 子进程都可继续存在。插件 VM 重建只会让 CME 内存熔断归零，不会碰 native Terminal 状态。

#### B. App 进程被杀后重新创建，但残留 Linux 子进程未被 UID/force-stop 清走

- Java singleton、Map、reader job 与 `Process` handle 全部丢失。
- OS 里的 proot/bash 是独立进程实体；没有代码能在新进程启动时从 `/proc` 重建或清理旧 hidden registry。
- 当前唯一全量清理挂在 `Application.onTerminate()`，而突然杀进程无法执行它；Android 生产运行也不能依赖 `onTerminate()` 作为退出回调。证据：`OperitApplication.kt:598-627`。
- 新进程即使看到旧 PID，也没有持久记录可证明 owner、executor key 和 PID starttime，故无法安全定向清理。

#### C. Android 设置里的“强行停止”或系统执行 UID 级清理

此路径通常会比普通 Activity/App UI “重启”更彻底，但具体厂商行为不能由本仓库源码证明。既有实验摘要称“强杀清理后恢复”：`BUG_HISTORY.md:12-15`。应在后续验证中把 force-stop 与普通划掉任务/重开严格分组。

### 4.5 可见 session 清理为什么无效

`Tools.System.terminal.close(sessionId)` 只走 `SessionManager`/visible provider；hidden executor 没有 sessionId 暴露，也不进入 `terminalState.sessions`。因此“打开终端页删除会话”清不到 `hiddenExecShells`，更清不到已经因创建失败而根本没进 Map 的 orphan。证据：`LocalTerminalProvider.kt:52-55,75-83,111-117`；`examples/types/system.d.ts:270-317`。

### 4.6 `start_worker.sh` 的独立残留风险

脚本的 `mkdir /tmp/cme_start_worker.lock` 在正常 `EXIT` 时由 trap 删除，但 SIGKILL、进程/容器异常退出时 trap 不执行。锁目录没有 owner PID、PID starttime 或租约；一旦残留，后续脚本都记录 `another instance running` 并以 0 退出。证据：`start_worker.sh:19-25`。

这是一个源码可证明的**潜在次级故障**，但不是题述 “T1 后无 T3 / start_worker.log 空” 的直接解释：只要脚本真正进入，begin/T3 在抢锁之前就应尝试写出。需通过实际日志确认是否存在 `another instance running`。

### 4.7 尚不能定案的部分

以下必须保持为推测：

1. **“启动早期”的精确竞态点。** TerminalManager 默认 visible session 会异步初始化，hiddenExec 同时调用 environment/provider；源码显示存在并行活动，但 `envInitMutex` 和 `providerMutex` 又提供了部分串行化。没有线程 dump/logcat，不能断言是哪一个锁或 IO 时序导致 ready 丢失。
2. **旧 idle orphan 如何让全新 key 的下一次 hiddenExec 失败。** 若旧 native tool call仍在同一进程的串行执行通道里，排队阻塞是合理假设；若 App 进程已完全重建，仅有 idle proot，则更可能是资源/Terminal 恢复问题。当前没有 executor queue、app PID、native token 的同轴时序证据。
3. **wchan 是否代表死锁。** `do_wait/pipe_read/do_select` 也是健康持久 shell 的正常等待态，不能单独作为“坏”判据。
4. **`Process.destroy()` 是否在该设备必然遗留后代。** 源码只证明没有等待、升级和后代校验；实际信号传播需进程快照验证。

## 五、最小修复方案与 trade-off

以下是建议，不是本次已实施变更。修复顺序很重要：先补平台生命周期闭环，再收敛 CME key/timeout；仅改 CME 无法安全清理由平台私有进程创建出的 orphan。

### P0-A：修掉创建期泄漏（TerminalCore，最小且必须）

把资源销毁从“按 key 查 Map”拆成“直接销毁对象”：

1. 新增内部 `closeHiddenExecShell(shell: HiddenExecShell)`，对传入对象执行关闭。
2. `createHiddenExecShell()` 的 ready 失败分支直接关闭局部 `shell`，放在 `try/finally` 或明确 failure branch；不要调用依赖 Map 的重载。
3. `closeHiddenExecShell(key)` 只负责从 Map remove 后委托对象版关闭。
4. 关闭顺序至少为：阻止新写入 → 终止当前命令 PGID → terminate root process → 有界 `waitFor` → 仍存活则 force kill → cancel/join reader → close channel；记录每一步结果。

Trade-off：改动集中、风险最低，能直接消除确定泄漏；但不能清理升级前已存在的 orphan，也不能单独解决跨重启 registry 问题。

### P0-B：统一 timeout 和取消所有权（TerminalCore + Tool bridge）

1. 让 `timeoutMs` 覆盖 `initializeEnvironment + get/create + ready + command` 的完整调用，或拆成明确的 `startupTimeoutMs`/`commandTimeoutMs`，但不能让调用方的 5 秒在 native 内变成 30 秒。
2. Tool bridge 必须提供可传播的 cancellation，或保证 native 自己在调用方 deadline 前完成清理。JS `Promise.race` 不能被当作取消机制。
3. TIMEOUT 不应被模糊包装为普通 success；若保留 `success=true` 兼容行为，CME 必须检查 `timedOut`、`exitCode` 和提交 ACK。

Trade-off：需要核对其他 ToolPkg 的 timeout 兼容性；但它从根上阻止“调用方已失败、native 仍在造会话”的分叉状态。

### P0-C：启动前查询与定向清理（必须位于 hiddenExec 下层）

不能让 CME 用 hiddenExec 自己扫描/清理 hiddenExec：通道坏时这个方案自相矛盾。应由 TerminalCore 在接受新 hiddenExec 前完成：

1. **同进程查询**：按 owner + executorKey 查 `hiddenExecShells`，不能只检查 `isAlive`；发送协议级 probe，验证 writer、reader、marker 往返。失败则关闭精确 shell 并重建。
2. **跨进程 orphan 查询**：读取持久 registry，核验 `UID + PID + /proc starttime + session UUID + cmdline/marker`。只有全部匹配且 owner lease 已失效，才清理该条进程树。
3. 对 ToolPkg 暴露 owner-scoped 的 `listHiddenExecutors` / `closeHiddenExecutor`，或由平台自动 reconcile；不要允许插件枚举/杀其他插件会话。
4. 对升级前没有 registry 的 legacy orphan，可做一次受限迁移扫描：只匹配 Operit UID、TerminalCore proot 根路径、确切 hidden wrapper 和 app instance marker；输出候选并审计，不要 `killall bash`。

Trade-off：平台改动范围比 CME workaround 大，但能同时保护所有插件，并避免误杀用户终端、worker、SSH shell。

### P0-D：运行中保存 root PID 与 child PGID 生命周期

当前 `Process` 只在内存对象中，命令 PGID 只通过输出中的 PID marker 临时解析。建议 registry 至少保存：

```text
sessionUuid, ownerToolPkgId, executorKey,
appInstanceId, appPid, appStartTicks,
rootPid, rootStartTicks, currentCommandPgid,
state(STARTING|READY|RUNNING|CLOSING), createdAt, updatedAt
```

创建 `Process` 后立即写 `STARTING`，ready 后改 `READY`，命令 child 建立后保存 PGID，正常关闭后原子删除。PID 必须配 `/proc/<pid>/stat` starttime，防止 PID 重用误杀。`cancelHiddenExecCommand()` 不能仅依赖可能永远读不到的 stdout PID marker；应让 wrapper 同时写 owner 私有 pid/状态文件，native 侧可回收。

Trade-off：状态机和异常路径更多，但这是安全定向清理、可观测性和跨重启恢复的基础。

### P1-A：使用持久 registry + 内核锁处理重启

1. TerminalManager 初始化、创建默认 session 之前，生成新的 `appInstanceId` 并持有进程级 owner lock。
2. registry 使用 app 私有目录中的 SQLite 或原子文件；每个 executorKey 用文件锁/数据库唯一约束实现跨协程、跨 manager instance 的 single-flight。
3. 新实例启动时：owner lock 已释放且 app PID/starttime 不匹配的记录视为 stale；**新 Java 进程不能重接旧 pipe，故应定向终止并重建，而不是盲目复用。**
4. 锁 fd 必须 close-on-exec，避免被 proot 子进程继承后让 owner lock永久不释放。

Trade-off：持久化会增加启动 reconcile 成本；可通过仅扫描 registry 中少量记录而不是全 `/proc` 控制成本。

### P1-B：收敛 CME 的 key 与重试

在 P0-A/P0-B/P0-C 到位后：

1. worker 启动使用稳定、owner-scoped key，例如 `com.operit.character_memory_engine:worker-launch`。
2. 删除 `freshKey()` 和 JS 侧自动漂移重试；同一次启动只允许一个可取消 native 请求。
3. 失败后由平台 probe/close/recreate 同一 key，而不是不断制造新 key。
4. 只有收到 `timedOut=false`、`exitCode=0`、输出含精确 `launch_submitted:<launchId>` 才写 T2 并进入健康轮询。

Trade-off：在当前 TerminalCore 只检查 `isAlive` 的前提下直接固定 key，可能反而永久复用坏 pipe，所以必须在平台健康探测之后实施。

### P1-C：修正 worker lock/registry

1. 若环境有可靠 `flock`，让 `start_worker.sh` 持有 fd lock；进程死亡时内核自动释放。
2. 若继续用 `mkdir`，目录内写 `pid + /proc starttime + launchId`；抢锁失败时验证 owner，owner 不存在或 starttime 不匹配才回收 stale lock。
3. `worker.pid` 也增加 starttime/launchId。当前按 cmdline 检查 `worker.py` 比盲杀 PID 安全，但 `/proc` fallback 的 `*worker.py*` 范围仍过宽：`start_worker.sh:50-62`。

Trade-off：`flock` 在精简环境中的可用性需确认；owner 文件方案更通用但实现更复杂。

### 不建议作为根修复

- **杀掉所有 bash/proot**：会误杀用户可见终端、其他 ToolPkg、SSH/MCP 任务，且不能修复下一次创建泄漏。
- **只延迟 onAppCreate**：能降低触发概率，不能修复创建失败清理、取消和跨重启回收。
- **只增加熔断时间**：能保护 UI，不能回收 native 进程；冷却后还会再次尝试。
- **让用户打开终端页删除 session**：hidden registry 与 visible registry 分离，技术上清不到目标。
- **CME 通过 hiddenExec 运行 `/proc` 清理脚本**：坏的正是该通道；且插件缺少足够 owner 元数据做安全判断。

## 六、验证建议

### 6.1 必加观测字段

每次 hiddenExec 在 logcat 记录同一条关联链：

```text
appInstanceId / appPid / executorKey / sessionUuid /
nativeToken / rootPid+startTicks / childPgid /
state transition / deadline / close reason / close result
```

CME 同时记录 `launchId`、实际 executorKey、native 结果 `timedOut/exitCode/output`。这样才能把 `T1` 与 TerminalCore token/PID、`T3` 与 worker PID串起来。

### 6.2 故障注入测试

1. **ready 前失败**：在 proot 启动后、`TERMINAL_READY` 前阻断输出；等待超过 deadline，断言 registry 无记录、root PID 与全部后代消失。
2. **ready 延迟 5-30 秒**：CME deadline 设 5 秒，断言只创建一个 session，调用结束前已完成 native 清理，不出现第二个 key。
3. **pipe 半断**：保留 `process.isAlive=true`，关闭/冻结 reader 或 writer；再次同 key 调用应由 protocol probe 判坏并重建，而不是永久 mutex 等待。
4. **命令超时且 PID marker 丢失**：断言仍能用持久 child PGID 清理。
5. **创建成功、提交成功**：断言 ACK 含相同 launchId，探针为 `T1→T2→T3→T4→T5→T6`，且只有一个 hidden root PID、一个 worker PID。

### 6.3 重启矩阵

分别记录操作前后 app PID、app starttime、root proot PID/starttime、registry：

| 场景 | 预期 |
|---|---|
| Activity finish/reopen | 同 app instance 的健康 shell可复用；坏 shell被 probe 后定向重建 |
| 划掉任务后重开 | 若 app 进程仍在，行为同上；若进程变更，startup reconcile 清旧 PID |
| `am force-stop` 后重开 | 不依赖系统代清；registry reconcile 后无旧 hidden PID |
| 系统杀进程/低内存恢复 | 新 app instance 不尝试重接旧 pipe；先定向清理再建新 shell |
| 设备重启 | boot id 变化时旧 registry 直接判 stale，但仍需防 PID 重用 |

### 6.4 start_worker 锁验证

在脚本持锁后分别 SIGTERM、SIGKILL，随后再次启动；两种情况下都必须能重新取得锁。并验证清理只影响 CME worker/lock，不影响其他 `bash`、可见 terminal 和其他 ToolPkg。

### 6.5 验收标准

- 连续 100 次“启动早期 hiddenExec + App 重启”无 orphan 增长。
- 任意失败后，调用 deadline + 清理宽限期内，对应 root PID/child PGID 均消失。
- 每个 owner/executorKey 同时最多一个 `STARTING|READY|RUNNING` 记录。
- `T1` 后无 T3 时，日志必须能明确落在 `ENV_INIT / PROCESS_START / WAIT_READY / WRITE_COMMAND / WAIT_RESULT / CLEANUP` 中某一阶段。
- 清理操作零误杀：用户终端、其他插件、CME worker（成功 detach 后）均保持预期生命周期。

## 七、最终判断

完整且有源码支撑的故障链为：

```text
Operit APPLICATION_CREATE
→ CME onAppCreate 延迟 10 秒
→ ensureWorkerUp health miss
→ fresh executorKey
→ JS hiddenExec 5 秒 race
→ TerminalManager 初始化/provider
→ LocalTerminalProvider 启动 host bash/proot/两层 bash
→ ready 延迟或失败
→ JS 先超时并漂移第二 key，native 仍运行
→ native 30 秒 ready 失败
→ 关闭函数因 shell 尚未注册而空操作
→ proot/bash 实体失去 registry/Process owner
→ 普通 UI/App 重启没有可靠 reconcile/cleanup
→ 后续 onAppCreate 再提交；若 hiddenExec 仍阻塞则 start_worker.sh 未收到命令
→ 无 T3/T4/T5，worker 8765 不 ready，CME 熔断/启动失败
```

其中，“创建失败会产生失去 registry 所有权的 orphan”由源码直接证明；“该 orphan 可跨非强制重启存活”由既有实验摘要支持，但本次缺少原始进程快照；“某一条旧 orphan 通过哪一个具体锁/队列/资源让下一条新 key 失败”仍需原始同轴日志确认。最小正确修复不是扩大 bash 清理范围，而是：**创建失败直接关闭局部 shell、统一可取消 deadline、保存 root/child PID 生命周期、用 owner-scoped 持久 registry/锁在新实例启动前定向 reconcile。**

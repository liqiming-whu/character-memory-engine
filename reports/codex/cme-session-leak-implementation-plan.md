# CME session leak 修复实施计划

- 日期：2026-08-10
- 文档性质：implementation plan；不是审计报告，不代表下述改动已经实施
- CME 当前检出：`e1d70610586c855444cba2be206e2bfbabdd5e34`
- Operit 当前检出：`2e9c76e45c561d5fe34d43e71eb2aa7259576216`
- 独立 TerminalCore 当前检出：`e4442bc6a047b6165bf59103721ad143149c620d`
- Operit `terminal` 子模块记录：`f85be57944b806de4d863dee8b10d80d04daa236`
- 行号说明：本文的 `文件:行号` 均指上述当前检出版本的实施前锚点；实现后行号会移动，提交说明应同时保留符号名。

## 1. 计划结论与发布边界

本计划把既有决策拆成四个独立验收阶段：

1. **Phase 0 — CME Hotfix：立即停止制造。** `application_on_create` 只观察 HTTP health；普通业务离线快速失败；所有自动 hiddenExec、fresh key、自动重试和按时间自愈退出生产路径。该版本允许 Worker 离线且不能由 CME 自动恢复，这是刻意接受的安全降级。
2. **Phase 1 — CME Recovery：恢复显式、可管理的启动。** 只有项目级 persistent-terminal 闭环通过后，才重新开放“启动 Worker/重启 Worker”。启动前只 reconcile CME 能用持久记录证明拥有的 visible control session、attempt 和 Worker lock。
3. **Phase 2 — Operit upstream：修根因和平台生命周期。** P0 修 `create → fail → close(local shell)`；P1 统一完整 deadline；P2 建 persistent owner registry 并在启动时 reconcile。
4. **Phase 3 — Verification：把泄漏、取消、重启和误杀边界变成自动化门禁。** 三个硬断言是创建失败前后 shell count 不增长、JS/API timeout 后 native 工作停止、App 重启后已登记 owner 不留 orphan。

### 1.1 不可破坏的安全不变量

- Phase 0 和 Phase 1 必须分开发版、分开验收；不能用“persistent terminal 方向正确”跳过 CME-specific 闭环。
- Phase 0 回滚只允许退到“Worker offline、启动关闭”的安全状态，**不得恢复自动 hiddenExec**。
- Phase 1 的 persistent terminal 失败时返回明确错误，**不得自动 fallback 到 hiddenExec**。
- HTTP `ping_worker` 是 Worker ready 的最终真值；session 存在、input 被接受、shell 返回 0、PID 文件存在或写出 `submitted` 都不是最终成功。
- CME 只关闭持久 registry 中带精确 `sessionId`、全限定名称和 installation owner token 的 visible session；不枚举、不识别、不清理 hidden executor。
- 任何阶段都禁止 `killall proot`、`killall bash`、`pkill -f worker.py` 或模糊扫描后杀进程。
- `worker_state.json`/session registry 是持久观察记录，不替代进程内原子 single-flight；`launch_lease.json` 的“先读后写”不能继续冒充锁。

### 1.2 目标控制流

Phase 0 发布后的生产流：

```text
Operit application_on_create
  → CME onAppCreate
  → WorkerSupervisor.observeHealth()          # HTTP only
      ├─ ready   → 记录 ready
      └─ offline → 记录 offline，结束

普通业务
  → HTTP Worker
      ├─ 收到 Worker 响应 → 原样表达业务结果
      └─ 明确 transport offline → WORKER_OFFLINE
  → 不启动、不部署、不碰 terminal

显式启动/重启
  → Phase 0 暂时返回 WORKER_RECOVERY_DISABLED
  → 不恢复 legacy hiddenExec
```

Phase 1 验收后的显式恢复流：

```text
用户显式点击启动/重启
  → WorkerSupervisor.start()
  → HTTP health
  → WorkerLaunchLock 原子领取 active promise
      ├─ A 成为 owner
      └─ B/C await 同一 promise 或只观察同一 attempt，不重复投递
  → reconcileKnownOwnedResources()
      ├─ 精确 visible control session
      ├─ active attempt
      └─ 精确 CME Worker lock
  → persistent terminal marker probe
  → terminal.input(start_worker.sh + attemptId/launchId) + Enter
  → 匹配 launchId 的结构化 result/ACK
  → HTTP ping_worker
  → ready / failed
```

## 2. 依据、事实分级与实施前确认门

本计划已读取并交叉核对以下必需输入：

- 方案决策：`reports/codex/cme-session-leak-fix-decision.md`；作为最终责任边界和修复取舍的主依据。
- 源码事实：`reports/codex/cme-session-leak-audit.md`；作为直接根因、timeout 链和证据边界的主依据。
- 历史方案：`reports/codex/input/CME_ONAPPCREATE_HIDDENEXEC_FIX_PLAN_V2.1_2026-08-10.md`；采纳 health-only、offline fast-fail、persistent terminal 方向，按最终决策收窄其已验证程度和可清理范围。
- CME 当前源码：`main.js`、`packages/memory_engine.js`、`start_worker.sh`、`manifest.json`。
- Operit 当前源码：可读的 `/root/OperitTerminalCore` 与 `/root/operit`，包括 provider、manager、JS bridge、标准 terminal tool、ToolPkg runtime 和公开类型定义。

### 2.1 本计划依据的已验证事实

以下项目已由固定版本源码直接验证，不需要在实施时重新猜测：

| 已验证事实 | 当前证据锚点 | 对实施的约束 |
|---|---|---|
| TerminalCore ready 失败会按 key 关闭尚未入 Map 的局部 shell，关闭为空操作 | `/root/OperitTerminalCore/.../LocalTerminalProvider.kt:186-205,208-258,483-492` | Phase 2 P0 必须直接关闭局部对象；CME workaround 不能被称为根修复。 |
| CME 5 秒 `withRace` 只 reject JS Promise，不取消 native；随后换 key 重试 | `main.js:58-94`；`packages/memory_engine.js:387-412` | Phase 0 删除自动 retry/fresh key，而不是只加长 timeout。 |
| native ready 最长 30 秒且发生在命令 `timeoutMs` 包裹之前 | `LocalTerminalProvider.kt:119-159,261-305` | Phase 2 P1 的 deadline 必须覆盖 init/create/ready/command/cleanup 全链。 |
| `onAppCreate` 延迟后部署、版本 kill 并调用 `ensureWorkerUp` | `main.js:632-685`，hook 在 `main.js:707-712` | hook 保留，但函数体改成 health-only，源码路径不得触达 terminal。
| 普通业务任意 `success=false` 都会调用 `ensureWorkerUp` | `packages/memory_engine.js:444-454` | 必须先区分 transport offline 与 Worker 返回的业务错误，再停止自动启动。 |
| main 与 subpackage 各有一套 launcher，文件租约是非原子先读后写 | `main.js:287-361`；`packages/memory_engine.js:302-376` | 删除双实现，统一进入一个 supervisor/lock。 |
| `start_worker.sh` 进入即写 begin/T3，之后才 `mkdir` | `start_worker.sh:13-25` | T1 后无 T3 的主故障点在脚本前；脚本锁只能作为第二道防线。 |
| 当前脚本锁 SIGKILL 后可残留且无 owner 元数据 | `start_worker.sh:19-25` | Phase 1 改为可证明 owner 的锁，并做 SIGTERM/SIGKILL 验收。 |
| 当前脚本按 `*worker.py*` 遍历 `/proc` 并 kill | `start_worker.sh:50-62` | 收紧为 PID/starttime/完整路径/端口/launchId；禁止泛杀。 |
| visible session 与 hidden shell 是两套 registry | `LocalTerminalProvider.kt:52-55,75-83` | CME visible session cleanup 不能被表述为 hidden orphan cleanup。 |
| ToolPkg API 对 visible session 有 create/close/screen/input，对 hidden 只有 execute | `/root/operit/examples/types/system.d.ts:270-339` | CME 无法安全 list/close hidden orphan；Phase 2 才能补 owner registry/control plane。 |
| visible `create` 只按全局 title 返回第一个同名 session | `/root/operit/.../StandardTerminalCommandExecutor.kt:30-74` | session 名必须带包名和 installation owner；未知同名 session 不接管、不关闭。 |
| timeout 目前会被工具层包装成 `success=true, timedOut=true` | `StandardTerminalCommandExecutor.kt:342-415` | 所有 caller 必须检查 `timedOut/exitCode/ACK`；上游契约变更需兼容性决定。 |
| main/subpackage ToolPkg 使用同一个按 container 缓存的 execution engine，非注册调用使用持久 module cache | `/root/operit/.../JsToolManager.kt:125-139`；`ToolPkgManager.kt:118-140`；`JsExecutionScriptBuilder.kt:282-287,670-672,1222-1228` | 可以设计模块级 active Promise，但必须做实际并发集成测试，不能只依赖静态阅读。 |
| `start_worker.sh` 尚未注册为 resource | `manifest.json:46-71` | Phase 0 即补资源声明，Phase 1 fresh install 才有闭环基础。 |

既有真机实验记录支持“persistent `terminal.create + terminal.input` 可在 Tool 返回后继续任务”，但只属于保存的实验记录；尚未证明 CME 的 `start_worker.sh → ping_worker` 完整生产链。这个边界是 Phase 0/1 分拆的直接理由。

### 2.2 需实施时再确认的项

以下是实施 gate，不得在提交说明中提前写成已验证：

| 待确认项 | 确认方法 | 决策规则 |
|---|---|---|
| 实施时 upstream HEAD 是否仍保持相同控制流/行号 | 开始编码前 `git fetch` 后对目标符号做只读 diff | 若控制流变化，先更新本计划锚点和根因复核，再改代码。 |
| ToolPkg 并发调用是否在目标发布版共享同一 `worker_supervisor.js` module instance | 加两个同时进入的集成 probe，记录 module instance UUID 和实际 launch count | 共享则使用模块级 `WorkerLaunchLock`；若不共享，在编码前改为单一 main-runtime IPC coordinator。两者只能选一个，不写运行时 fallback。 |
| `flock` 在 Operit 的目标 proot 镜像是否存在且语义可靠 | 真机执行 `command -v flock`，并做持锁进程 SIGKILL 后立即重取锁 | 通过则使用 fd lock；不通过则实现带 `pid+starttime+launchId` 的包名命名 `mkdir` owner lock。两者只能选一个。 |
| visible session 在 Activity 重建、App 进程重建后的实际存活边界 | 用相同 sessionId 做 marker/result-file probe | 只把 probe 成功的 session 标记 healthy；“存在”不等于 healthy。 |
| `Tools.Files.move` 在 Android 数据目录是否提供同目录原子替换 | 写临时 JSON、并发读、断电/kill 故障注入 | 若不满足，不用它承担互斥；持久状态仍只作 observation。 |
| 全限定 session 名碰撞与丢失 registry 时的行为 | 删除 CME registry 后调用 `terminal.create`，检查 `isNewSession` 和 owner marker | `isNewSession=false` 且 owner 无法证明时返回 ownership error，不接管。 |
| Operit hiddenExec timeout 契约是否已对外发布、是否允许改变 `success` | 实施 Phase 2 P1 前由维护者确认发布兼容要求 | 默认保留返回数据形状，先修 deadline/cleanup；行为变更写 migration note，不静默破坏调用方。 |
| trusted ToolPkg owner 如何传入 TerminalCore | 追踪 JS execution session 到 `StandardTerminalCommandExecutor` 的调用上下文 | owner 必须来自 native trusted context，不能信任插件自己传的普通字符串参数。若 P2 首 PR 尚不能贯通，registry 先限定 app-instance owner，不开放 owner-scoped public close。 |
| 设备测试能否读取全 `/proc` | 在 root/engineering 测试机确认 `adb shell su -c`；CI 则使用 test-only PID registry | 进程扫描只用于观测断言，不用于产品清理。 |

## 3. Phase 0 — CME Hotfix（立即止血）

### 3.1 目标

- 让 CME 在 Operit 启动期不创建、不复用任何 terminal session。
- Worker 离线时，普通业务在有限时间内返回 `WORKER_OFFLINE`，不触发启动。
- legacy hiddenExec 从所有生产启动、restart、普通诊断链中移除；不再 fresh key、不再自动 retry、不再 60 秒自动自愈。
- 建立唯一 `WorkerSupervisor` 和进程内原子 `WorkerLaunchLock`；Phase 0 先完成协调器和可测试状态机，生产 launcher 保持 disabled，Phase 1 再接 persistent terminal transport。
- 将 Phase 0 的安全退化明确呈现给 UI/调用方：Worker 已离线时功能不可用，但不会危及 Operit terminal 生命周期。

### 3.2 修改点（实施前文件:行号）

| 任务 | 文件:行号 | 具体改动 |
|---|---|---|
| P0-1 health-only hook | `main.js:185-246,632-685,707-712` | 保留 hook 注册和 T0/日志；`onAppCreate()` 只在 2–5 秒后调用 `WorkerSupervisor.observeHealth({source:'application_on_create'})`。删除 hook 内部署、版本读取/kill、`ensureWorkerUp`、channel breaker 清理以及所有 terminal API。health 使用独立短 deadline，在线写 ready，离线写 offline 后结束，不重试。 |
| P0-2 删除 main 启动链 | `main.js:58-120,192-225,256-361` | 删除 `KEY_FILE/getKey/saveKey/freshKey/withRace/hiddenExecSafe/execTerminal`；删除 60 秒 `isChannelBroken` 自动解除；从 main 删除 `ensureWorkerUp/pollWorkerReady` 双实现。资源准备函数可移到 supervisor，但不得由 app-create 调用。 |
| P0-3 HTTP 错误域 | `packages/memory_engine.js:129-138,189-231` | `httpCall` 返回结构化 `errorDomain`/`code`：连接拒绝、connect timeout、无响应为 `WORKER_OFFLINE`；已收到 Worker JSON 的参数、数据、LLM、备份等失败保持原业务 code；非 JSON/协议错误为 `WORKER_PROTOCOL_ERROR`。删除消息中“自动启动”暗示。 |
| P0-4 普通业务快速失败 | `packages/memory_engine.js:444-454` | `run()` 只执行一次 HTTP；成功或 Worker 业务失败都直接返回。仅 transport offline 映射为 `{success:false, code:'WORKER_OFFLINE'}`；不调用 launcher，不重放原业务请求。 |
| P0-5 删除 subpackage legacy 生产链 | `packages/memory_engine.js:268-413,428-441,809-837,892-900` | 删除 channel broken 的定时解除、`ensureWorkerUp/pollWorkerReady`、key 文件、freshKey、二次 retry、`execSh`。`diag_engine` 改为 HTTP + Files 日志/状态诊断，不再为“诊断”自动进入 hiddenExec。Phase 0 的 `deploy_restart` 返回 `WORKER_RECOVERY_DISABLED`，不启动、不 kill。 |
| P0-6 唯一 supervisor/lock | 新增 `packages/worker_supervisor.js:1` | 定义 `observeHealth/start/status` 和 `WorkerLaunchLock`。`start()` 在任何 `await` 前同步设置 `activeLaunchPromise/attemptId`；A 执行，B/C 选择 `wait` 时 await 同一 Promise，选择 `observe` 时返回同一 attempt 状态。`finally` 仅在 attempt terminal state 后释放。Phase 0 的 transport 明确为 disabled；测试用依赖注入 fake launcher 验证单飞，不在生产内放 hiddenExec。 |
| P0-7 资源闭环准备 | `manifest.json:46-71`；`packages/memory_engine.js:233-266` | 将 `start_worker.sh` 注册为 `engine_start_worker_sh` resource；显式资源准备时复制到 `DATA_DIR/start_worker.sh` 和 `ROOT_DIR/start_worker.sh` 并校验内容版本/摘要。onAppCreate 不执行该步骤。 |
| P0-8 UI 安全退化 | `ui/memory_system_ui/screen.js:192-242`；`ui/memory_system_ui/tabs/deploy.js:31-54,103-145,149-176` | 自动分析收到 `WORKER_OFFLINE` 时停止轮询并显示离线，不启动 Worker；Phase 0 部署页将启动/重启按钮置为“恢复功能暂不可用”，显示明确原因。不要把 hiddenExec broken 表述成整个 terminal broken。 |
| P0-9 状态与文档 | 新增 `logs/worker_state.json` schema（运行时文件，不入库）；`DEVELOPMENT_PLAN.md` 当前架构章节；`README.md` 已知问题/启动说明 | `worker_state` 仅保存 `state, observedAt, attemptId?, launchId?, launchChannel?`，不承担锁。更新重大架构计划：application-create health-only、Phase 0 safe-off、Phase 1 门槛、hiddenExec diagnostics-only。 |
| P0-10 自动测试 | 新增 `tests/worker_supervisor.test.js:1`、`tests/offline_behavior.test.js:1`、`tests/session_leak_static.test.js:1` | 用 fake `Tools` 验证 hook 零 terminal、业务错误不启动、offline 快速失败、10 个并发 start 只有一次 fake launch、B/C 共享 attempt/result、异常后 lock 释放。静态测试阻止 production 文件重新出现 `Tools.System.terminal.hiddenExec`。 |

legacy hiddenExec 如确需保留隔离研究，应新建 `packages/hiddenexec_diagnostics.js:1`，满足以下全部条件：不被 METADATA 普通工具或 UI 自动调用；需要显式 diagnostic build/开关；只用一个稳定且有限的 key；单次调用；无 `Promise.race`；无换 key；无自动 retry；timeout 后持久记录 broken 且本轮停止。Phase 0 可以选择完全不打包该模块，这是更小的 hotfix 范围。

### 3.3 改动前后行为

| 场景 | 改动前 | Phase 0 后 |
|---|---|---|
| Operit application create，Worker offline | 10 秒后部署、版本检查、hiddenExec 提交 `start_worker.sh` | 一次短 HTTP health，记录 offline，结束；terminal 调用数为 0。 |
| 普通 CRUD 返回参数错误 | `success=false` 后误进 `ensureWorkerUp`，可能启动/重试业务 | 原业务错误原样返回；启动调用数为 0；业务请求不重放。 |
| Worker 连接拒绝 | 自动进入 hiddenExec 拉起并重试业务 | 有界返回 `WORKER_OFFLINE`；不部署、不拉起、不重放。 |
| hiddenExec 5 秒未返回 | JS reject，fresh key，再投第二次，60 秒后自动允许重试 | 生产代码不调用 hiddenExec；无 key 文件、无第二次投递、无定时清 broken。 |
| 用户点击 restart，Worker offline | `ensureWorkerUp(true)` 仍可能被 health 提前返回或进入 hiddenExec | Phase 0 明确返回 `WORKER_RECOVERY_DISABLED`；用户按发布说明手动恢复，等待 Phase 1。 |
| A/B/C 并发显式启动 | 两套 launcher + 非原子 lease，三者都可能越过 JS 检查 | 唯一 supervisor；A 持有 active Promise，B/C 等待或观察同一 attempt；Phase 0 transport disabled，Phase 1 接入后仍保持同一锁。 |

### 3.4 验收标准

- `application_on_create → onAppCreate` 的可达源码路径不包含 `terminal.create/exec/input/hiddenExec/close`，也不包含部署、kill 或 launcher start。
- Worker offline 时连续 20 次冷/暖启动，CME 产生的 hidden shell root count 增量为 0；`LocalTerminalProvider` 日志中无 CME executor key/create 记录。
- 普通业务 transport offline 的本机 p95 返回时间不超过 2 秒、单次硬上限不超过 3 秒；返回 code 为 `WORKER_OFFLINE`。
- 注入 Worker `{success:false, code:'INVALID_ARGUMENT'}` 后，结果仍为业务错误，fake launcher count 为 0，请求 count 为 1。
- 生产文件 `main.js`、`packages/memory_engine.js`、`packages/worker_supervisor.js` 中没有 `Tools.System.terminal.hiddenExec`；若诊断模块存在，静态门禁只允许该单一隔离文件出现一次。
- 10 个同 tick 的 `start({mode:'wait'})` 只有一个 attemptId、一次 fake transport invocation；10 个 caller 得到相同 terminal result。`observe` caller 不新增 invocation。
- 60 秒后、App restart 后、UI reload 后都不会自动尝试 hiddenExec；不存在按时间清除 hiddenExec broken 的逻辑。
- `manifest.json` 可解析且包含 `engine_start_worker_sh`；fresh package 展开后能读出脚本 resource。
- Phase 0 发布说明明确写出功能退化和手动恢复步骤，未暗示“重启 Operit 即可清理 hidden orphan”。

### 3.5 风险与回滚

| 风险 | 控制 | 回滚 |
|---|---|---|
| Worker 原本依赖自动拉起，用户会看到离线 | UI 明确 `WORKER_OFFLINE`，提供人工执行已知精确脚本的运维步骤，并优先推进 Phase 1 | 关闭/回退 UI 新入口或 supervisor 新功能，保留 health-only 与 offline fast-fail；不得恢复自动 hiddenExec。 |
| HTTP offline 阈值过短造成慢设备误判 | health 与业务 deadline 分开；只把 transport failure 定为 offline，不把慢业务当离线 | 调整 health deadline，不改变“离线不启动”的不变量。 |
| 共享 module cache 假设不成立 | 实施前并发 probe；不通过则改为单 main-runtime IPC coordinator | 回退到 Phase 0 `WORKER_RECOVERY_DISABLED`；不能退回文件软 lease或双 launcher。 |
| 删除通用 `hiddenExecSafe` 影响现有诊断 | `diag_engine` 改为 Files/HTTP；平台专项诊断独立打包 | 暂时关闭专项诊断，不把 helper 放回生产文件。 |
| resource 复制路径/权限异常 | Phase 0 只注册和显式准备，不在启动期复制大文件 | 回退资源部署变更，不影响 health-only；Phase 1 不放行直到 fresh-install 测试通过。 |

### 3.6 不做的事

- 不在 Phase 0 实现 persistent terminal，也不声称 Worker 恢复已修复。
- 不用固定 30 秒延迟替代 readiness。
- 不延长 hiddenExec timeout，不保留 fresh key，不保留“一次兼容重试”。
- 不在普通业务、UI onLoad、onAppCreate 或 restart 中自动启动 Worker。
- 不扫描 `/proc` 查 hidden orphan，不关闭 visible session，不杀任何 proot/bash。
- 不以 `launch_lease.json`、`worker_state.json` 或 UI busy flag 代替 `WorkerLaunchLock`。

## 4. Phase 1 — CME Recovery（处理 CME 已知坏状态并恢复显式启动）

### 4.1 进入条件与目标

进入条件：Phase 0 已发布并通过其全部门禁；目标设备上的 visible persistent-terminal 生命周期 probe 已通过；`start_worker.sh` resource 可在 fresh install 部署。

目标：

- 只对用户显式的“启动 Worker/重启 Worker”恢复生产 launcher。
- 每次实际 worker start 之前先 inspect 已知 session、active attempt 和 Worker lock。
- 只清理 CME registry 能证明拥有的 visible control session、attempt 和 Worker lock。
- 用 package-qualified persistent terminal 投递带 attemptId/launchId 的脚本；不依赖 hiddenExec。
- 让结构化 ACK/result 与最终 HTTP health 能完整还原一次启动。

### 4.2 状态模型和所有权证明

运行时文件建议固定为：

```text
DATA_DIR/logs/worker_state.json
DATA_DIR/logs/runtime_channels.json
DATA_DIR/logs/control_session.json
DATA_DIR/logs/launch_history.jsonl
DATA_DIR/logs/launch_results/<launchId>.json
ROOT_DIR/worker_identity.json
/tmp/com.operit.character_memory_engine.worker-launch.lock/
```

`control_session.json` 最小字段：

```json
{
  "schemaVersion": 1,
  "ownerPackage": "com.operit.character_memory_engine",
  "installationOwnerId": "随机生成并持久化、安装期稳定的 UUID",
  "logicalName": "com.operit.character_memory_engine:worker-control:<installationOwnerId>",
  "sessionId": "Operit visible session id",
  "lastSuccessfulProbeAt": 0,
  "activeAttemptId": null,
  "lastLaunchId": null
}
```

“CME 可证明拥有”必须同时满足：schema 可解析、`ownerPackage` 精确匹配、installation owner 文件匹配、session 名按同一 owner 派生、sessionId 非空。对健康复用还必须完成本轮 nonce marker 往返。

未知同名 session 的处理规则：

- `terminal.create(logicalName)` 返回 `isNewSession=true`：写入 registry，发送 owner 初始化 marker，再 probe。
- 返回 `isNewSession=false` 且 registry/owner marker 匹配：允许复用。
- 返回 `isNewSession=false` 但 owner 无法证明：返回 `PERSISTENT_TERMINAL_OWNERSHIP_UNPROVEN`；不输入命令、不 close、不改名接管。

### 4.3 修改点（实施前文件:行号）

| 任务 | 文件:行号 | 具体改动 |
|---|---|---|
| P1-1 完成 supervisor 状态机 | `packages/worker_supervisor.js:1`（Phase 0 新文件） | 实现 `IDLE → INSPECTING → PREPARING → SUBMITTING → VERIFYING → READY/FAILED`；所有生产 start/restart 都经 `WorkerLaunchLock`。A 写 active attempt；B/C await/observe A；不得重新投递。状态落盘只用于恢复/观察。 |
| P1-2 资源准备 | `packages/memory_engine.js:233-266`；`manifest.json:46-71` | 提取 `prepareWorkerResources()`：部署 worker/embed/model/start script，校验目标文件；只在显式启动/安装路径执行。fresh install 不依赖 `/root` 历史残留。 |
| P1-3 known session reconcile | `packages/worker_supervisor.js:1` | 启动前读取并校验 `control_session.json`。对已知 sessionId 发送 nonce probe 命令并通过独立 result 文件读取匹配 nonce/owner；healthy 复用。known stale/broken 时，仅按 registry 精确 ID 调 `terminal.close(sessionId)`，记录 close 结果，再 create。未知 session 不关闭。 |
| P1-4 persistent launcher | `packages/worker_supervisor.js:1` | 使用 `Tools.System.terminal.create(logicalName)` 与两次 `terminal.input`（命令、Enter）投递，不用同步长 `terminal.exec`。命令带经过严格 shell quoting 的 `ATTEMPT_ID`、`LAUNCH_ID`、`CME_OWNER_ID`；input accepted 仅记 `SUBMITTED`。 |
| P1-5 启动前 Worker lock inspect | `start_worker.sh:19-25`；`packages/worker_supervisor.js:1` | 按 2.2 gate 二选一实现 fd `flock` 或 owner-aware `mkdir`。若为 mkdir，owner 文件含 shell PID、`/proc/<pid>/stat` starttime、launchId、完整脚本路径；抢锁失败只观察有效 owner，owner 精确失效才删除该包名锁目录并重试一次。不得根据锁去杀进程。 |
| P1-6 Worker 身份收紧 | `start_worker.sh:50-72` | 删除 `*worker.py*` 全 `/proc` kill。`worker_identity.json` 保存 PID、starttime、launchId、完整 worker path、port、db；restart 只对全部字段匹配的旧 CME worker 发 TERM、有界等待，再按相同身份 KILL。普通 start 先 HTTP health，在线不 kill。 |
| P1-7 结构化 result | `start_worker.sh:13-73` | 每阶段原子写 `launch_results/<launchId>.json`：`ENTERED/LOCK_ACQUIRED/RESOURCES_READY/OLD_WORKER_STOPPED/WORKER_SPAWNED/FAILED`，含 attemptId、launchId、owner、pid/starttime、stage、exitCode、timestamp。日志继续写，但解析结果不依赖自然语言日志。 |
| P1-8 ACK + health 验证 | `packages/worker_supervisor.js:1`；当前 `main.js:345-361`/`packages/memory_engine.js:360-376` 的旧轮询逻辑作为迁移参考 | 先等匹配 launchId 的结构化 `WORKER_SPAWNED` 或明确 FAILED，再有界 HTTP `ping_worker`；只有两者匹配才 READY。超时写 FAILED，保留可诊断状态，不自动重投。 |
| P1-9 显式工具与 restart | `packages/memory_engine.js:71-76,502-505,877-901` | 新增/导出 `start_worker`；`deploy_restart` 改名或保持兼容入口但内部调用 `WorkerSupervisor.restart()`。force restart 必须验证旧/new PID、starttime、launchId 变化；在线 health 不再让 force 提前成功。 |
| P1-10 UI 恢复入口 | `ui/memory_system_ui/tabs/deploy.js:13-20,31-54,103-176` | 显示 Worker、Persistent Terminal、Legacy hiddenExec 三个独立状态；提供“重新检查”“启动 Worker”“重启 Worker”。按钮并发都进入同一 supervisor；B/C 展示同一 attempt。闭环完成前不启用 UI onLoad 自动恢复。 |
| P1-11 main 只观察 supervisor | `main.js:632-685` | 继续保持 Phase 0 health-only；不得因 Phase 1 可恢复而把 start 放回 application hook。 |
| P1-12 测试与文档 | 新增 `tests/persistent_launcher.test.js:1`、`tests/owned_reconcile.test.js:1`、`tests/start_worker_lock.sh:1`；`DEVELOPMENT_PLAN.md`、`README.md` | 覆盖 session known healthy/stale/unknown、attempt 恢复、重复点击、ACK mismatch、health timeout、restart 身份变化、lock SIGTERM/SIGKILL。记录 persistent-terminal CME-specific 验证状态。 |

### 4.4 启动前 inspect/reconcile 的精确顺序

1. 做一次短 HTTP health；已 ready 的普通 start 直接返回，restart 继续但记录旧身份。
2. `WorkerLaunchLock` 在第一次 `await` 前创建 attemptId 和 active Promise。
3. 读取 `worker_state/control_session`；不合法记录只报告，不据此 close 或 kill。
4. 若持久状态有未完成 activeAttempt：
   - HTTP 已 ready 且 launchId/result 匹配：收敛为 READY；
   - result 明确 FAILED：收敛为 FAILED；
   - known control session/Worker lock 仍由匹配 owner 活跃持有：观察，不重复投递；
   - owner PID/starttime 已失效：只清理该 attempt 记录和精确包名 lock，标记 `RECOVERED_STALE_ATTEMPT`。
5. reconcile known control session：probe healthy 则复用；registry 证明 owned 但 probe 失败则精确 close/recreate；unknown session 返回 ownership error。
6. 通过健康 control session inspect 精确 Worker lock owner；有效 owner则等待/观察，无效且可证明属于 CME 才移除 lock。
7. `prepareWorkerResources()`，校验脚本和 worker 版本。
8. 只投递一次带 attemptId/launchId 的启动命令和 Enter。
9. 等结构化 result，再等 HTTP health；二者必须关联同一 launchId。
10. terminal state 后写 history、清 active Promise；不删除能够解释失败的 result/log。

### 4.5 改动前后行为

| 场景 | 改动前 | Phase 1 后 |
|---|---|---|
| 用户显式启动 | hiddenExec + fresh key + retry | package-qualified visible persistent session，单次 input 投递。 |
| 已有启动 A，B/C 到达 | 软 lease 后各自可能投递 | B/C 等待或观察 A 的 attempt；transport invocation 保持 1。 |
| known session pipe 失效 | 只看存在/可能继续使用 | nonce/result-file probe 失败；仅 close registry 中精确 sessionId，再创建。 |
| 未知同名 session | `create` 可能全局复用并被 CME使用 | owner 无法证明则拒绝接管，不 close。 |
| stale Worker lock | 裸目录永久阻塞，或脚本退出 0 | 核对 owner PID/starttime/launchId/路径；只移除精确 stale lock。 |
| restart | Worker 在线时 health 可能提前返回，未真实重启 | 旧身份精确停止，新 PID/starttime/launchId 必须变化，随后 ACK + HTTP ready。 |
| persistent terminal 异常 | 可能 fallback hiddenExec | 返回 `PERSISTENT_TERMINAL_UNAVAILABLE`，保留 hiddenExec 独立状态，不 fallback。 |

### 4.6 验收标准

- Worker offline → 显式 start → `terminal.create/input` → `start_worker.sh` → matching result → `ping_worker` 成功的真机闭环通过。
- 故意保持 hiddenExec broken 时，persistent terminal 仍可恢复 Worker；期间 hiddenExec 调用数为 0，broken 状态不被自动清除。
- 并发 10 次显式 start 只有一个 attemptId、一个 launchId、一次实际 input 命令投递、一个有效 Worker。
- known healthy session 被复用；known stale session 只关闭 registry 精确 ID；unknown same-title session 零 close、零 input。
- control probe 必须看到本轮 nonce + installation owner 的结构化结果；旧屏幕文本、命令 echo 或 session 存在不能误判 healthy。
- `start_worker.sh` 持锁进程分别 SIGTERM/SIGKILL 后均可再次启动；有效 incumbent 存在时竞争者只报告/观察，不删除锁。
- restart 前后 PID 或 starttime 至少一项变化，launchId 必须变化；旧进程在 grace 后不存在，新 Worker HTTP ready。
- fresh install 从空 `ROOT_DIR` 显式启动成功，`start_worker.sh` 来源可追溯到 manifest resource。
- 所有清理日志均列出 owner 证据和精确 target；用户 visible terminal、其他 ToolPkg、SSH、未知 proot/bash 零影响。

### 4.7 风险与回滚

| 风险 | 控制 | 回滚 |
|---|---|---|
| visible `create` 按全局 title 复用错误 session | 包名 + installation UUID；owner marker；unknown 拒绝接管 | 禁用显式 recovery，退回 Phase 0 safe-off；不切 hiddenExec。 |
| screen/command echo 造成 probe 假阳性 | 使用独立原子 result 文件和 nonce，不只搜索 screen 文本 | 标记 channel unknown，退回 Phase 0 safe-off。 |
| module single-flight 在 VM 重建时消失 | persistent attempt/result/lock 用于新实例观察；新实例先 reconcile | 禁用新 launcher；保留状态文件供诊断，不恢复旧软 lease。 |
| stale 判定误杀活 Worker | PID 必须配 starttime、完整 path、port、db、launchId；TERM/KILL 前二次核对 | restart 入口下线；普通 health/业务保持 Phase 0 行为。 |
| result 已写但 HTTP 未 ready | 明确 FAILED/timeout，不自动再次投递；保留脚本阶段 | 用户显式重试前重新 reconcile，不后台自愈。 |
| persistent terminal 宿主回归 | 独立 channel state 和项目级回归测试 | feature flag/版本开关关闭 persistent launcher，退回 Phase 0 `WORKER_RECOVERY_DISABLED`；绝不 fallback hiddenExec。 |

### 4.8 不做的事

- 不清理、枚举、probe 或“迁移”任何 hidden orphan。
- 不根据 `proot`、`bash -lc`、`TERMINAL_READY` 字符串、wchan 或 `S` 状态杀进程。
- 不关闭 registry 未记录或 owner 无法证明的 visible session。
- 不在 application_on_create、普通业务、UI onLoad 自动启动。
- 不把 persistent terminal 说成绕开整个 TerminalManager；它只绕开 hidden executor 子系统。
- 不用 terminal input accepted、PID 文件或结构化 `SUBMITTED` 代替 HTTP ready。
- 不在 Phase 1 修改 Operit 私有 hidden registry；平台改动独立进入 Phase 2。

## 5. Phase 2 — Operit upstream

### 5.1 总体提交策略

先在 `AAswordman/Operit` 提交一个可复现的 umbrella bug issue，附固定 SHA、最小控制流、故障注入断言和本计划链接摘要；不要用缺少 owner 证据的进程截图替代复现。随后按优先级拆 PR，避免 owner registry 大设计阻塞确定 P0。

仓库与分支约束：

- TerminalCore 实现提交到 `AAswordman/OperitTerminalCore`，分支使用 `fix/...` 或 `feat/...`。
- Operit bridge、types、startup hook、submodule gitlink 提交到 `AAswordman/Operit`，目标分支 `main`。
- 每个 TerminalCore PR 合并后，Operit 用单独 commit 更新 `terminal` gitlink；不要把未合并的临时 SHA混入功能 PR。
- 推荐三组独立 PR：P0 create cleanup；P1 deadline/timeout contract；P2 owner registry/reconcile。P0 可先发布。

### 5.2 P0：create failure cleanup

#### 目标

保证 `ProcessBuilder.start()` 之后、Map ownership 转移之前的任意异常/ready failure 都直接关闭局部 shell/process；不再按 key 查一个尚不存在的 Map entry。

#### 提交位置与最小改动范围

| 仓库/文件:行号 | 改动 |
|---|---|
| `/root/OperitTerminalCore/.../LocalTerminalProvider.kt:38-45` | 如有必要为 `HiddenExecShell` 增加关闭状态/幂等 guard；不在 P0 引入持久 registry。 |
| `LocalTerminalProvider.kt:186-205` | 保持“ready 成功后才放入 Map”；明确 ownership handoff 点。若 Map 插入异常，也直接 close created object。 |
| `LocalTerminalProvider.kt:208-258` | 用 `try/catch/finally` 覆盖 process start 后的构造、reader 启动、ready 等异常；ready 失败调用对象版 `closeHiddenExecShell(shell)`。若 shell 对象尚未完整构造，至少直接 close process/stream/job/channel。 |
| `LocalTerminalProvider.kt:483-493` | 新增幂等对象版 closer；key 版只做 `remove(key)` 后委托对象版。P0 最小 closer 至少关闭 writer、destroy root、等待、必要时 force destroy、cancel/join reader、close channel，并记录结果。 |
| 新增 `/root/OperitTerminalCore/src/androidTest/java/.../HiddenExecCreateCleanupInstrumentedTest.kt:1` | 真实进程故障注入：process start 后、ready 前失败；断言局部 root/后代退出、Map 无 entry、前后 count 不增长。 |

建议 commit：`fix(terminal): close hidden shell when startup fails`。建议先开 bug issue，再以一个 TerminalCore PR 关闭 issue；Operit 主仓只做 gitlink bump 和 release note。不要在此 PR 改 public API、deadline 语义或 owner schema。

#### 改动前后

- 前：ready failure → `closeHiddenExecShell(executorKey)` → Map 无对象 → local process tree失去 owner。
- 后：ready failure → `closeHiddenExecShell(localShell)` → cleanup 完成 → 抛出 start failure；只有成功返回后才转移给 Map owner。

#### 验收标准

- 在 start 后/ready 前 100 次故障注入中，每次 deadline + cleanup grace 后 root PID 和记录的全部后代均不存在。
- `hiddenExecShells[executorKey]` 无残留；closer 重复调用无异常、无误杀。
- 正常 create/ready/command 路径行为不变；visible terminal 和 SSH provider 不受影响。

#### 风险与回滚

- 风险是强制关闭次序导致 reader 卡住或协程泄漏；用有界 join 和幂等 closer 控制。
- 若 P0 引发正常路径回归，可回退对象 closer实现，但 CME 必须继续保持 Phase 0 containment；不能以恢复 CME hiddenExec 作为回滚。
- P0 回滚会重新暴露已知平台 leak，应作为阻断发布问题，而不是长期状态。

#### 不做的事

- 不在 P0 扫描升级前 orphan，不加 owner API，不改变 executor key 策略。
- 不用 `hiddenExecShells[executorKey] = shell` 提前登记来掩盖 cleanup 问题，除非同时实现完整状态机；最小 PR 保持 ownership handoff 清晰。

### 5.3 P1：deadline unify

#### 目标

一个 caller 提供的 `timeoutMs` 使用单一 monotonic deadline，覆盖 environment init、provider get/create、ready、mutex wait、write、command wait、cancel 和 cleanup；返回 JS 前 native 已停止目标命令，或进入可查询且有界的 `CLOSING`。

#### 提交位置与最小改动范围

| 仓库/文件:行号 | 改动 |
|---|---|
| `/root/OperitTerminalCore/.../TerminalManager.kt:1365-1385` | 在进入 `initializeEnvironment()` 前创建 deadline，并把 remaining time 向下传；init 也计入总 timeout。 |
| `TerminalProvider.kt:68-77`；`SSHTerminalProvider.kt:160-185` | 内部接口接收 deadline/remaining budget；SSH 映射同一契约，避免 provider 间语义分叉。public JS 参数仍可保持 `timeoutMs`。 |
| `LocalTerminalProvider.kt:119-171` | 移除“create 在 timeout 外”；timeout/exception 不再异步 fire-and-forget close。command timeout 先精确终止 PGID并 settle；协议仍健康才保留 shell，否则同步 close。 |
| `LocalTerminalProvider.kt:208-305` | ready 使用 caller 剩余 deadline，不写死独立 30 秒；startup timeout 直接清局部 shell。 |
| `LocalTerminalProvider.kt:308-352,415-446` | child PGID 必须在 marker 丢失时仍可查询；cancel 后有界等待并校验停止结果。 |
| `LocalTerminalProvider.kt:483-493` | closer 接收 cleanup grace；返回结构化 close result，不能只发 `Process.destroy()` 就返回。 |
| `/root/operit/.../Terminal.kt:141-150`；`StandardTerminalCommandExecutor.kt:342-415` | 贯通 deadline result；明确 TIMEOUT 的 success/timedOut/exitCode 契约。兼容性确认前保持数据 shape，禁止 timeout 被 caller 当普通提交成功。 |
| `/root/operit/.../JsTools.kt:830-840`；`examples/types/system.d.ts:300-310` | 文档与实现一致：timeout 覆盖 startup + command；说明 timeout 后目标 native command 在 grace 内停止，shell 是否保留由健康状态决定。 |
| 新增 TerminalCore deadline 单测/仪器测试；新增 Operit app JS bridge 仪器测试 | 分别验证 create delay、mutex wait、command sleep、cancel marker 丢失、JS 返回与 native stop 的时序。 |

建议提交方式：

1. TerminalCore PR，分支 `fix/hidden-exec-deadline`，commit `fix(terminal): apply one deadline to hidden exec lifecycle`。
2. Operit 协调 PR，分支 `fix/hidden-exec-timeout-contract`，更新 bridge/types/gitlink，commit `fix(tools): align hidden exec timeout contract`。
3. 两个 PR 关联同一 issue；TerminalCore CI/设备结果先于主仓 gitlink 合并。

#### 改动前后

- 前：caller `timeoutMs=5s`，native 仍可在 create/ready 中运行 30 秒；command catch 异步 close；JS 返回与 native停止无同步关系。
- 后：5 秒是整个调用 deadline；startup/command/cancel 共用剩余预算；JS 收到 timeout 时，对应 command 已停止，startup shell 已清理，或 close state 可被测试查询且在固定 grace 内完成。

#### 验收标准

- create/ready/command 各阶段注入延迟时，总耗时不超过 `timeoutMs + cleanupGrace + 允许调度误差`。
- JS API 返回 `timedOut=true` 后，记录的 child PGID 在 grace 内不存在；startup timeout 的 root/后代也不存在。
- 同一个 key 在 timeout 后没有第二个隐式存活的 STARTING shell；健康 shell 保留策略与 types 文档一致。
- `success/timedOut/exitCode` 的兼容测试覆盖旧调用方；CME 不依赖 `success=true` 判启动成功。

#### 风险与回滚

- 风险是 timeout 行为对现有 ToolPkg 可见；先做调用面搜索、兼容测试和 release note。
- 风险是 cleanup 占用 caller 时间；设置固定小 grace并公开指标，不能改回 fire-and-forget。
- 回滚 public result 语义时可保留内部 deadline/cleanup；不要整包回退生命周期修复。

#### 不做的事

- 不把任意用户自写 `Promise.race` 自动宣称为 cancellation API。支持契约是 `hiddenExec(...,{timeoutMs})`；若未来提供 AbortSignal/requestId，另开 API 设计。
- 不在 timeout 后自动换 executor key，不无限等待 child，不依赖 stdout PID marker作为唯一回收依据。

### 5.4 P2：persistent owner registry + startup reconcile

#### 目标

在进程启动后立即登记 hidden root ownership，在 App/Java owner 丢失后仍能凭持久记录精确回收；新 App instance 接受 hiddenExec 前完成 startup reconcile。只清理 registry 证明拥有的对象。

#### 提交位置与最小改动范围

| 仓库/文件:行号 | 改动 |
|---|---|
| 新增 `/root/OperitTerminalCore/.../hidden/HiddenExecOwnerRecord.kt:1` | 定义 versioned record：`sessionUuid, ownerScope, executorKey, appInstanceId, appPid/appStartTicks, bootId, rootPid/rootStartTicks, currentCommandPgid, state, createdAt, updatedAt`。 |
| 新增 `HiddenExecOwnerRegistry.kt:1` | app-private 持久存储 + 原子事务/唯一约束；状态 `STARTING/READY/RUNNING/CLOSING/CLOSED`；每 `(ownerScope,executorKey)` single-flight。 |
| 新增 `HiddenExecStartupReconciler.kt:1` | 只遍历 registry records，核对 bootId、PID、starttime、确切 wrapper marker和 owner lease；stale 时定向 TERM/wait/KILL，记录审计，再原子删除。**不扫描全 `/proc` 寻找未登记 legacy orphan。** |
| `LocalTerminalProvider.kt:38-55,119-171,186-258,433-493` | process start 后立即写 STARTING；ready/command/close 更新状态和 PGID；Map 与 registry ownership handoff 原子化；复用除 `isAlive` 外增加协议 probe。 |
| `TerminalManager.kt:127-147,1365-1385` | 建立 reconcile barrier；任何 hidden call await barrier。默认 visible session 不应被 hidden reconcile 阻塞超过有界预算。 |
| `/root/operit/.../OperitApplication.kt:174-205` | 在派发 ToolPkg `APPLICATION_CREATE` 前异步启动 hidden owner reconcile，并记录 appInstanceId；hidden API 自身仍 await barrier，因此不依赖 hook 顺序碰运气。 |
| `/root/operit/.../JsEngine.kt:2288-2327`、`JsNativeInterfaceDelegates.kt:707-755`、`StandardTerminalCommandExecutor.kt:342-375` | 设计并贯通 trusted caller owner scope。owner 来源必须是 native execution context，不接受插件可伪造的普通参数。未贯通前 owner-scoped public close 不合并。 |
| `Terminal.kt:141-150`、TerminalCore `TerminalProvider.kt:68-77` | 将 trusted owner scope 下传到 provider/registry；AI 内置调用与 ToolPkg 调用使用不同 namespace。 |
| 可选 owner-scoped public control plane及 `system.d.ts` | 仅在鉴权完成后提供 status/cancel/close；调用方只能看到自身 records。自动 reconcile 已能满足 P2 最小目标时，public API可另 PR。 |
| 新增 registry 单测、startup instrumentation、外部 restart harness | 覆盖 PID reuse、boot change、app kill -9、owner lock stale、record corruption、其他 owner 零影响。 |

建议提交方式：

1. 先在 issue 中评审 schema、trusted owner propagation 和 migration 边界。
2. TerminalCore 分支 `feat/hidden-exec-owner-registry`：registry/state machine/reconciler 一个 PR；不要混 detached exec 新功能。
3. Operit 分支 `feat/hidden-exec-startup-reconcile`：appInstance/trusted owner/startup barrier/types/gitlink 一个协调 PR。
4. 若 owner-scoped public list/close 需要扩大 API，单独 feature PR；不要阻塞平台内部 startup reconcile。

#### 改动前后

- 前：owner 只存在 Java Map/Process handle；App 进程丢失后无记录可安全定位旧 root。
- 后：root 创建即持久登记；新实例只核验少量 registry records，精确清理旧 owner，再允许新 hidden call。

#### 验收标准

- kill -9 App 进程并重启后，旧 registry root/PGID 在 reconcile grace 后消失，stale record 被审计并删除，新 hidden echo 成功。
- PID 被复用但 starttime 不匹配时，不向新进程发信号；record 标记 stale/mismatch并人工审计。
- 每个 ownerScope/executorKey 同时最多一个 `STARTING|READY|RUNNING` record。
- record corruption 只隔离/报告该 record，不做广域扫描或 kill。
- visible terminal、SSH、其他 ToolPkg owner、CME 已 detach 的 Worker 均不受 hidden reconcile 影响。

#### 风险与回滚

- registry schema/锁会增加复杂度：使用 versioning、原子迁移和小记录集；先 internal-only。
- owner provenance 若不可信会造成越权 close：未完成 trusted context 前不开放 public owner close。
- startup reconcile 可能延长启动：App hook异步，只有 hidden API等待有界 barrier；metrics记录耗时。
- 回滚时可关闭 registry 新建/公共 API，但保留 P0/P1 cleanup；CME 继续 Phase 0/1 containment。不得回滚成全 `/proc` 扫描。

#### 不做的事

- 不自动发现或 kill 没有 registry 的 legacy hidden orphan。
- 不以 UID 单项、cmdline 子串、wchan、进程名任一条件证明 owner。
- 不依赖 `Application.onTerminate()` 作为主要清理路径。
- 不在此阶段实现通用 `execDetached`、后台任务平台或 CME 专属逻辑。

## 6. Phase 3 — Verification（测试矩阵与具体命令）

### 6.1 目标

- 将 Phase 0/1 的安全不变量变成 CME host 与真机回归门禁。
- 将 Phase 2 的 create failure、deadline 和 startup reconcile 变成可重复故障注入，不再依赖人工看进程截图。
- 对每个测试同时验证“目标资源消失”和“非目标资源仍存活”，把零误杀列为同等重要的断言。
- 固定输出 attemptId/launchId/appInstanceId/owner/rootPid+starttime/childPgid，使一次失败能跨 JS、bridge、TerminalCore 和 Linux 进程树关联。

### 6.2 修改点（实施前文件:行号）

| 测试任务 | 文件:行号 | 最小改动 |
|---|---|---|
| CME supervisor/离线/静态门禁 | 新增 `tests/worker_supervisor.test.js:1`、`tests/offline_behavior.test.js:1`、`tests/session_leak_static.test.js:1` | fake Tools/transport、并发 barrier、production source scan；不连接真实用户数据。 |
| CME persistent recovery | 新增 `tests/persistent_launcher.test.js:1`、`tests/owned_reconcile.test.js:1`、`tests/start_worker_lock.sh:1` | 覆盖 known/unknown owner、ACK/health、10-way single-flight、lock 信号恢复。 |
| TerminalCore create/deadline instrumentation | 新增 `/root/OperitTerminalCore/src/androidTest/java/.../HiddenExecCreateCleanupInstrumentedTest.kt:1`、`HiddenExecDeadlineInstrumentedTest.kt:1`；`/root/OperitTerminalCore/build.gradle.kts:1-104` | 只增加必要 test dependency/fault seam；fault seam 不进入 release 可调用 API。 |
| Operit JS bridge E2E | 新增 `/root/operit/app/src/androidTest/java/.../HiddenExecDeadlineBridgeAndroidTest.kt:1`；现有 JS test assets 位于 `/root/operit/app/src/androidTest/js/...` | 从真实 JS `Tools.System.terminal.hiddenExec` 调到 native，记录 JS return 与 native stop 同轴时序。 |
| restart reconcile harness | 新增 `/root/operit/ci/script/test_hidden_exec_restart_reconcile.sh:1` | root/engineering device 上 kill App、重启、读取 owner registry、验证旧 PID 消失和 sentinel 存活。 |
| CI/PR 命令登记 | `/root/operit/docs/doc-src/dev-core/CONTRIBUTING.md:44-95` 或对应测试文档；Operit/TerminalCore PR 描述 | 将实际执行命令、设备/ABI、iteration 和结果纳入 PR；不把设备测试伪装成普通 JVM test。 |

### 6.3 改动前后行为

| 验证对象 | 改动前 | Phase 3 后 |
|---|---|---|
| create failure | 静态源码能证明 leak，但没有自动进程回收断言 | fault injection 每轮断言 `afterCount == beforeCount` 且精确 PID/后代消失。 |
| timeout | JS、ready、command 使用多套时钟，主要靠日志推断 | 同一测试记录完整 deadline；JS/API 返回与 native stop 建立硬时序断言。 |
| App restart | 没有持久 owner，人工观察旧 proot/bash | harness kill -9/relaunch，断言 registry stale owner被精确回收且 sentinel 不受影响。 |
| CME launch | UI busy、软 lease、shell lock分散，难证明单飞 | host fake + 真机 result 双重断言一个 attempt/launch/input/Worker。 |
| 回归处置 | 可能通过加 sleep、换 key或扩大 kill pattern掩盖 | gate 失败必须修 ownership/deadline 状态机，禁止概率性“修测试”。 |

### 6.4 测试环境与共同观测

准备两类环境：

- host/CI：Node 测 CME coordinator 和静态门禁；Gradle JVM test 测 registry/deadline纯逻辑。
- arm64 root/engineering Android 设备：真实 proot/bash、PID/starttime、App kill/restart。`/proc` 只读扫描只用于测试断言，不进入产品代码。

共同变量：

```bash
export CME_REPO=/root/projects/CME
export OPERIT_REPO=/root/operit
export OPERIT_PKG=com.ai.assistance.operit
export TEST_OUT=/tmp/cme-session-leak-verification
mkdir -p "$TEST_OUT"
adb get-state
```

只读 hidden shell snapshot（测试观察，不清理）：

```bash
adb shell su -c 'for p in /proc/[0-9]*; do
  [ -r "$p/cmdline" ] || continue
  c=$(tr "\000" " " < "$p/cmdline" 2>/dev/null)
  case "$c" in
    *"TERMINAL_READY; eval"*)
      pid=${p##*/}
      st=$(awk "{print \$22}" "$p/stat" 2>/dev/null)
      printf "%s %s %s\n" "$pid" "$st" "$c"
      ;;
  esac
done' | sort -n > "$TEST_OUT/hidden.snapshot"
wc -l "$TEST_OUT/hidden.snapshot"
```

该 snapshot 只能回答“形态/count 是否变化”，不能判某进程一定坏，更不能作为 kill target。上游 instrumentation 还必须记录其实际创建的 rootPid/starttime/descendant set，断言以记录的精确 PID 为主。

### 6.5 Phase 0 host 门禁

命令：

```bash
cd "$CME_REPO"
node --check main.js
node --check packages/memory_engine.js
node --check packages/worker_supervisor.js
python3 -m json.tool manifest.json >/dev/null
node --test \
  tests/worker_supervisor.test.js \
  tests/offline_behavior.test.js \
  tests/session_leak_static.test.js
```

断言/预期：

- 退出码全为 0。
- `onAppCreate` mock 中 `Tools.System.terminal` 任一方法被调用都会令测试失败，实际调用数为 0。
- Worker transport reject 时返回 `WORKER_OFFLINE`，launcher count 0，业务调用 count 1。
- Worker 返回 `INVALID_ARGUMENT` 时不转成 offline、不启动、不重放。
- 10 个并发 start 的 fake transport count 为 1，attemptId 集合大小为 1。

生产路径静态断言：

```bash
cd "$CME_REPO"
if rg -n 'Tools\.System\.terminal\.hiddenExec|freshKey\(|hiddenExecSafe\(' \
  main.js packages/memory_engine.js packages/worker_supervisor.js; then
  echo 'FAIL: legacy hiddenExec reached production files' >&2
  exit 1
fi
if rg -n 'ensureWorkerUp\(' main.js packages/memory_engine.js; then
  echo 'FAIL: duplicate legacy launcher remains' >&2
  exit 1
fi
```

预期两次 `rg` 均无匹配。

### 6.6 Phase 0 真机：启动期零新增

前置：用精确 worker identity 停止 CME Worker；不得 `pkill -f worker.py`。测试 harness 应核对 `ROOT_DIR/worker_identity.json` 的 PID/starttime/path 后发 TERM。

```bash
rm -f "$TEST_OUT/hidden.before" "$TEST_OUT/hidden.after"
# 先执行 6.4 的 snapshot 命令，再保存基线
cp "$TEST_OUT/hidden.snapshot" "$TEST_OUT/hidden.before"
for i in $(seq 1 20); do
  adb shell am force-stop "$OPERIT_PKG"
  adb shell monkey -p "$OPERIT_PKG" 1 >/dev/null
  sleep 6
done
# 再执行一次 6.4 的 snapshot 命令，保存结果
cp "$TEST_OUT/hidden.snapshot" "$TEST_OUT/hidden.after"
before_count=$(wc -l < "$TEST_OUT/hidden.before")
after_count=$(wc -l < "$TEST_OUT/hidden.after")
test "$after_count" -le "$before_count"
adb logcat -d | rg 'LocalTerminalProvider.*Created hidden exec shell: cme|executorKey=cme_' && exit 1 || true
```

断言/预期：

- `after_count <= before_count`，且无新增 CME hidden root；若设备有其他插件并发活动，使用 instrumentation 的 owner/key日志过滤，CME create count 必须为 0。
- 每轮 application-create health 在 3 秒内结束；无 T1/T2/T3，因为 Phase 0 不发起 launch。
- `worker_state.json` 最终为 `offline`，没有 active attempt。

### 6.7 Phase 1 persistent recovery 矩阵

| 场景 | 操作 | 断言 | 预期 |
|---|---|---|---|
| Worker offline、session healthy | 显式 `start_worker` | 一个 session/attempt/launch；matching result；HTTP ready | 成功，hiddenExec count 不变。 |
| 10 次重复点击 | 同时发 10 次 start | transport/input command count=1；attemptId/launchId 各 1 | B/C wait/observe A。 |
| known stale session | 保存 registry 后关闭该 visible session，再 start | 只 close registry ID；新 session probe 成功 | Worker 恢复。 |
| unknown same-title | 删除 registry，预建同名无 owner marker session | close count=0、input count=0 | `PERSISTENT_TERMINAL_OWNERSHIP_UNPROVEN`。 |
| hiddenExec broken | 用隔离测试 fixture 制造/保留 broken 状态 | persistent start 成功；hidden state不清除 | 三个健康域相互独立。 |
| lock SIGTERM/SIGKILL | 脚本持锁时分别发信号，再显式 start | 新 attempt 可获取锁；只处理包名锁 | 无永久 stale lock。 |
| restart | 记录 old identity，调用 restart | old/new launchId 不同；PID/starttime变化；old消失；new HTTP ready | 真重启，不是假成功。 |

host mock：

```bash
cd "$CME_REPO"
node --test tests/persistent_launcher.test.js tests/owned_reconcile.test.js
bash tests/start_worker_lock.sh
```

真机一次完整启动后读取并交叉断言：

```bash
adb shell su -c 'cat /sdcard/Download/Operit/character_memory_engine/logs/worker_state.json'
adb shell su -c 'cat /sdcard/Download/Operit/character_memory_engine/logs/control_session.json'
adb shell su -c 'ls -1 /sdcard/Download/Operit/character_memory_engine/logs/launch_results'
adb shell su -c 'cat /root/character_memory_engine/worker_identity.json'
curl -fsS http://127.0.0.1:8765 \
  -H 'Content-Type: application/json' \
  --data '{"action":"ping_worker","params":{}}'
```

若 `curl` 在 host 无法访问设备 loopback，改用 `adb forward tcp:18765 tcp:8765` 后访问 `127.0.0.1:18765`。预期四份状态中的 attemptId/launchId/owner 一致，HTTP JSON `success=true`。

### 6.8 上游 P0：创建失败前后 shell count 无增长

新增测试类后，在已更新 `terminal` 子模块的 Operit 根执行：

```bash
cd "$OPERIT_REPO"
./gradlew :terminal:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.ai.assistance.operit.terminal.provider.type.HiddenExecCreateCleanupInstrumentedTest#readyFailureClosesRootAndDescendants
```

测试内部步骤必须是：

1. snapshot baseline hidden shell count。
2. fault injector 在 `ProcessBuilder.start()` 返回后、`TERMINAL_READY` 前抛错/阻断。
3. 保存本次 rootPid/starttime 和后代集合。
4. 等 `deadline + cleanupGrace`。
5. snapshot after；检查 Map/registry。

硬断言：

```text
afterCount == beforeCount
hiddenExecShells[testKey] == null
rootPid/starttime 不存在
本次记录的 descendant PID/starttime 全部不存在
```

预期测试连续循环 100 次仍通过。这里只允许 count 相等；“增长后再由下一轮清掉”不算通过。

### 6.9 上游 P1：JS/API timeout 后 native 停止

TerminalCore 阶段测试：

```bash
cd "$OPERIT_REPO"
./gradlew :terminal:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.ai.assistance.operit.terminal.provider.type.HiddenExecDeadlineInstrumentedTest
```

Operit JS bridge 端到端测试：

```bash
cd "$OPERIT_REPO"
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.ai.assistance.operit.core.tools.javascript.HiddenExecDeadlineBridgeAndroidTest
```

端到端用例执行：

```js
await Tools.System.terminal.hiddenExec(
  "trap '' TERM; sleep 120",
  { executorKey: "deadline-e2e", timeoutMs: 1000 }
);
```

测试记录 `jsStart/jsReturn/nativeStart/rootPid/childPgid/nativeStopped`。硬断言：

```text
result.timedOut == true
jsReturn - jsStart <= 1000ms + cleanupGrace + schedulerTolerance
nativeStopped <= jsReturn（或 API 明确允许的极小、固定 closing grace）
childPgid 不存在
若在 create/ready 阶段 timeout，则 rootPid 及后代也不存在
```

另测 ready 延迟、mutex wait 和 PID marker 丢失。预期任何阶段都不再出现“JS 已 timeout，native 继续到 30 秒”的状态。自写的更短 `Promise.race` 不属于此 API 断言；禁止在 CME 重新引入它。

### 6.10 上游 P2：重启后无 owned orphan

建议提交可重复 harness：`/root/operit/ci/script/test_hidden_exec_restart_reconcile.sh`。执行：

```bash
cd "$OPERIT_REPO"
bash ci/script/test_hidden_exec_restart_reconcile.sh \
  --serial "$(adb get-serialno)" \
  --package "$OPERIT_PKG" \
  --iterations 20
```

harness 每轮必须：

1. 用测试 API 创建一个 owner-scoped hidden shell并读取 registry，记录 appInstanceId/rootPid/rootStartTicks。
2. 用 root `kill -9 <appPid>` 模拟 Java owner 丢失，不用 `am force-stop` 代替该场景。
3. `adb shell monkey -p "$OPERIT_PKG" 1` 重启 App。
4. 等待明确 `HIDDEN_EXEC_RECONCILE_COMPLETE appInstanceId=<new>` 日志/测试 signal。
5. 读取 registry 并检查旧 PID/starttime；再执行新 owner 的短 echo。

硬断言：

```text
旧 rootPid/rootStartTicks 不存在
旧 child PGID 不存在
旧 record 不再是 STARTING/READY/RUNNING
新 appInstanceId 与旧值不同
新 hidden echo 成功
其他 owner/visible/SSH test sentinel PID 仍存在
```

设备重启另做 5 轮，bootId 改变时 stale record 仍需按 PID/starttime防重用；不能只因 bootId 变化向任意同 PID 发信号。

### 6.11 验收标准与完整 release gate

| Gate | Phase 0 | Phase 1 | Phase 2 P0 | Phase 2 P1 | Phase 2 P2 |
|---|---:|---:|---:|---:|---:|
| app-create terminal calls = 0 | 必须 | 必须保持 | N/A | N/A | 必须不由 CME 回归 |
| 普通业务 offline fast-fail | 必须 | 必须保持 | N/A | N/A | N/A |
| 10-way launch single-flight | fake transport | 真 persistent transport | N/A | N/A | owner/key single-flight |
| 创建失败 count before=after | CME 不触发 | CME 不触发 | 必须 | 必须保持 | 必须保持 |
| timeout 后 native stop | CME 无生产 hidden | 同左 | startup failure cleanup | 必须 | 必须保持 |
| restart 后 owned orphan=0 | CME known resources | 必须 | 不覆盖跨实例 | 不覆盖持久 owner | 必须 |
| hidden/visible/SSH 零误杀 | 必须 | 必须 | 必须 | 必须 | 必须 |

任一硬 gate 失败时不得通过增加 sleep、延长 breaker、换 key 或扩大 kill pattern 来“修测试”。必须回到对应资源所有权或 deadline 状态机修正。

### 6.12 风险与回滚

| 风险 | 控制 | 回滚/处置 |
|---|---|---|
| `/proc` 权限或 OEM 行为让 count 不稳定 | 精确 PID registry 为主，形态 count 为辅；固定 root/engineering 设备和镜像 | 标记该设备 lane 无效并换合格设备；不能删除精确 PID 断言后宣称通过。 |
| fault seam 泄漏到 release | build variant/test-only sourceSet 隔离，release compile 检查无测试入口 | 回退 fault seam 暴露，保留测试抽象；不回退生产 cleanup。 |
| 设备并发有其他插件 terminal 活动 | 用 owner/key/appInstanceId 过滤，另设非目标 sentinel | 隔离测试账号/设备并重跑，不扩大清理范围。 |
| timing 测试偶发抖动 | timeout、cleanup grace、scheduler tolerance 分开记录；断言资源最终状态 | 只调整已量化的 scheduler tolerance，不加任意 sleep，不放宽 native stop 条件。 |
| restart harness 的 root kill 破坏设备状态 | 专用测试机、每轮前健康检查、保留 log/registry artifact | 中止本轮并恢复测试 App；不在用户设备执行，不把 harness 打进产品。 |
| 新测试阻塞紧急 P0 发布 | P0 最小 instrumentation 为必需；P1/P2 大矩阵按各自 PR gate | 只允许按 Phase 边界延期未进入范围的测试；不能以人工验证替代该 Phase 的硬 gate。 |

### 6.13 不做的事

- 不在测试 harness 中执行 `killall`/模糊 `pkill`，即使设备是测试机。
- 不把 `do_wait/pipe_read/do_select`、`S` 状态或单一 cmdline substring 当成 orphan 判据。
- 不用 `am force-stop` 代替 P2 的“Java owner 丢失但子进程可能存活”kill -9 场景；force-stop 只作为另一组生命周期样本。
- 不接受只检查 Map/registry、不检查 Linux PID树的 create cleanup 测试。
- 不接受只检查 JS 返回时间、不检查 native stop 的 timeout 测试。
- 不通过删除未知 legacy orphan 让 restart 测试变绿；P2 只处理持久 registry 已登记 owner。
- 不执行本计划生成过程中的构建或真机测试；这些命令属于实施后的验证步骤。

## 7. 分阶段交付清单

### Phase 0 建议提交

1. `fix(cme): make app create health only`
2. `fix(cme): fail fast when worker is offline`
3. `refactor(cme): remove legacy hidden exec launcher`
4. `feat(cme): add worker supervisor single flight`
5. `build(cme): package worker start script`
6. `test(cme): guard session leak hotfix invariants`
7. `docs(cme): document safe-off worker lifecycle`

发布标签应说明：Worker 离线不再自动恢复；显式 recovery 暂停；安全收益是不再触发 hiddenExec leak 链。

### Phase 1 建议提交

1. `feat(cme): add owned persistent terminal launcher`
2. `fix(cme): make worker lock owner aware`
3. `fix(cme): verify worker restart identity`
4. `feat(cme): expose explicit worker recovery status`
5. `test(cme): cover persistent recovery and owned cleanup`
6. `docs(cme): mark persistent worker recovery verified`（只能在真机闭环通过后提交）

### Phase 2 建议 issue/PR 顺序

1. Umbrella bug issue：固定 SHA、create failure 控制流、timeout mismatch、三项硬测试。
2. TerminalCore P0 PR → Operit gitlink bump。
3. TerminalCore P1 PR + Operit timeout contract PR。
4. owner schema/design discussion。
5. TerminalCore P2 registry PR + Operit startup/trusted owner PR。
6. 可选 owner-scoped public control plane PR。

## 8. 完成定义

本专项只有在以下陈述均有自动化或真机证据时才算完成：

- CME application-create 永久 health-only，普通业务离线不启动。
- CME 生产 Worker 生命周期不存在 hiddenExec、fresh key、自动 retry 或定时自愈。
- Phase 1 显式 recovery 只有一个 attempt/launch/control session/Worker，并只 reconcile CME-owned resources。
- Phase 1 回滚可安全退回 Phase 0，不恢复 hiddenExec。
- TerminalCore create failure 会直接 close local shell，前后 shell count 不增长。
- `timeoutMs` 覆盖完整 native lifecycle，JS/API timeout 后目标 native 工作停止。
- persistent owner registry 能在 App instance 更替后精确 reconcile 已登记 stale owner，未知 legacy orphan 不自动 kill。
- 全部测试对 visible terminal、其他 ToolPkg、SSH 和用户 shell 保持零误杀。

仍然不属于完成定义、应继续标记为待研究的是：“某一条历史 idle orphan 通过哪个具体锁、队列或资源让所有新 key 挂起”。这项未知不阻塞上述已知根因、CME containment 和 owner lifecycle 的实施。

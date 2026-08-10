# CME `onAppCreate`、`hiddenExec` 坏会话与 Worker 恢复：分析与修复方案 V2.1

- 日期：2026-08-10
- 文档版本：V2.1
- 项目：Character Memory Engine（CME）
- 当前版本背景：CME v2.4.9
- 问题范围：Operit `application_on_create`、Terminal Manager、`hiddenExec`、持久 terminal session、Worker 自动预热与恢复
- 文档性质：架构分析与修复建议；基于 V1 报告与 2026-08-10 新增真机故障注入结果修订
- V2 核心变化：将 `hiddenExec` 从“正常 Worker 恢复通道”降级为“高风险兼容/诊断通道”；推荐长期改为不依赖 `hiddenExec` 的持久 terminal session 或平台级 detached exec
- V2.1 核心变化：基于 2026-08-10 新增 ToolPkg 真机验证，确认 `terminal.create + terminal.input` 的持久 session 生命周期模型成立；persistent terminal 从“待验证目标”升级为 CME Worker 的首选恢复架构。`hiddenExec` 与 persistent terminal 改为独立健康域，禁止因 legacy hiddenExec 损坏而错误熔断正常 persistent terminal。

---

## 1. 核心判断

这个问题的本质不是“10 秒不够长”，也不再只是“Operit 冷启动时 Terminal Manager 可能存在初始化竞态”。

V2.1 基于新增真机实验，将问题拆成三个层面：

### 1.1 已确认的 hiddenExec 故障事实

1. Operit 重启后，Terminal Manager 中可能仍存在跨 App 实例残留或不可用的 executor / PRoot / bash 会话；
2. CME 的 `onAppCreate` 在固定延迟后主动调用 `hiddenExec`，会进入一个宿主层无法可靠取消的通道；
3. JS 层超时、`Promise.race` 返回或 Tool 调用被终止，**不能证明 native / Terminal Manager / PRoot 调用已经停止**；
4. 2026-08-10 真机实验已复现：
   - `hiddenExec` 执行长任务或异常终止后，可留下 `proot + bash` 残留；
   - 残留会话中的 `proot` 可阻塞在 `do_wait`，子 shell 可阻塞在 `pipe_read` / `do_select`；
   - 故障后旧 `executorKey` 与全新 `executorKey` 的短命令都可能一起挂起；
   - 同时 `terminal.exec` / 可见 terminal 仍可正常工作；
   - 该残留进程形态与 CME 历史“坏会话”现场高度一致；
5. 坏会话可能跨 Operit App 重启残留，因此“重启 App”不能作为可靠清理手段。

### 1.2 已确认的 persistent terminal 生命周期事实

2026-08-10 针对真实 ToolPkg 的生命周期验证已经通过：

```text
ToolPkg
  → terminal.create("codex-control")
  → terminal.input("sleep 30; ...")
  → 发送 Enter
  → Tool 立即返回
  → terminal session 在 Tool 返回后继续执行
  → 30 秒后成功生成 result.json
```

该实验确认：

1. `terminal.create` 可以建立/找到专用持久 session；
2. `terminal.input` 可将长任务投递到该 session；
3. ToolPkg 调用不需要等待长任务结束即可返回；
4. session 内任务可在 Tool 返回后继续运行；
5. 状态文件可作为后续 Tool 调用的查询通道；
6. 该路径完全绕开了 `hiddenExec` 的 executor / hidden terminal 生命周期。

这证明：

> **persistent terminal 的生命周期模型已经成立，可以作为 CME Worker 启动的新首选架构。**

但必须保持边界清晰：

> 当前实验验证的是“持久 terminal 承载长任务”的执行模型；CME 仍需做一次 `start_worker.sh → HTTP ping_worker` 的项目级闭环验证，之后才能标记为 CME 已验证生产恢复通道。

### 1.3 尚未单独证明的历史根因

历史上观察到的“Operit 重启后首次 `hiddenExec` 偶发挂起”曾被归因为 Terminal Manager 初始化竞态。V2.1 不否定这一可能性，但当前证据还不能证明：

> CME 历史上的所有冷启动坏会话都由初始化竞态独立产生。

新的证据说明，至少还存在另一条可复现路径：

```text
健康 hiddenExec
  → 长任务 / 后台化 / 调用被终止
  → native / executor 未完全结束
  → proot + bash 残留
  → hiddenExec 通道进入全局挂起
```

因此，后续应通过“干净冷启动 + 仅执行短 `echo`”的控制实验单独验证初始化竞态是否独立存在。

### 1.4 CME 能控制与不能控制的边界

CME 能控制：

- 是否在 App 启动阶段进入 terminal 通道；
- 是否自动调用 `hiddenExec`；
- 是否选择 persistent terminal 作为 Worker 正常启动通道；
- 同一个 App 实例是否允许重复提交；
- Worker 离线时是快速失败还是自动恢复；
- 用户是否能显式发起恢复；
- 是否通过 HTTP health 判断 Worker 在线；
- 是否按执行通道分别持久化健康/故障状态；
- 是否允许 legacy hiddenExec 进入正常业务恢复流程。

CME 不能可靠控制：

- Operit Terminal Manager 是否已真正恢复；
- 一个超时或被取消的 `hiddenExec` native 调用是否真的结束；
- 残留 executor 会话是否跨 Operit 重启继续存在；
- 宿主何时释放坏会话；
- `hiddenExec` 内部对 pipe / PTY / EOF / executor 生命周期的具体判定逻辑；
- persistent terminal 在极端宿主异常下是否一定永远存活，因此仍需 session health probe 与重建逻辑。

因此，V2.1 的总原则是：

> **`onAppCreate` 启动期零 terminal；普通业务离线快速失败；Worker 正常恢复优先走 persistent terminal；legacy hiddenExec 不参与正常 Worker 生命周期。**
>
> **hiddenExec 与 persistent terminal 必须作为两个独立健康域管理：hiddenExec 损坏不能自动推导出 persistent terminal 不可用。**
>
> **最终成功判据始终是 HTTP `ping_worker`，而不是 terminal 命令返回、session 存在或 PID 文件存在。**

---

## 2. 当前链路及故障位置

当前启动链大致为：

```text
Operit application_on_create
  → 等待 10 秒
  → deployWorkerToData()
  → HTTP ping_worker
  → Worker 不在线
  → hiddenExec(start_worker.sh)
  → HTTP 轮询 Worker 就绪
```

`start_worker.sh` 内部已经具备：

- `/tmp` 目录锁单飞；
- PID 文件；
- 旧 Worker 清理；
- `setsid` 后台启动；
- stdio 重定向；
- Worker health 轮询；
- launch lease；
- channel breaker。

这些机制只能在命令已经进入 shell 后生效。

本问题可能卡在更前面：

```text
QuickJS
  → Tools.System.terminal.hiddenExec
  → Operit bridge
  → Terminal Manager / executor session
  → 命令尚未真正进入 shell
```

如果故障发生在这里：

- `start_worker.sh` 的 mkdir 锁没有机会执行；
- PID 清理没有机会执行；
- shell 层单飞无效；
- launch lease 只能阻止其他 JS 入口继续提交，不能取消当前 native 调用；
- `Promise.race` 超时不等于 native 取消；
- 换 executorKey 可能再制造一个残留会话。

---

## 3. 为什么固定延迟不能作为修复

`setTimeout(..., 10000)` 只能证明经过了 10 秒，不能证明：

- Terminal Manager 已初始化完成；
- proot executor 已恢复；
- 上一 App 实例的 terminal 会话已清理；
- Shizuku/权限/宿主服务已就绪；
- 先前超时调用已经结束。

实际状态可能包括：

1. 冷启动 2 秒即正常；
2. 10 秒时仍处在宿主恢复窗口；
3. 30 秒后仍有坏会话；
4. 无论等待多久，残留会话都不会自行恢复；
5. 打开终端页面或手动删除会话后才恢复。

因此，固定延迟不是 readiness probe，只是概率性避让。

---

## 4. 当前实现中会放大问题的行为

## 4.1 `onAppCreate` 自动跨入高风险通道

App 每次启动都会在无人操作时尝试进入 terminal 通道。即使用户本次并不打开 CME，也可能创建或复用坏会话。

这使插件从“按需功能”变成“影响 Operit 启动稳定性的后台参与者”。

## 4.2 `hiddenExecSafe()` 超时后换 key 再试一次

当前策略大致为：

```js
try {
  return await hiddenExec(oldKey);
} catch (e) {
  return await hiddenExec(newKey);
}
```

如果第一次只是 JS 层超时，而 native 调用仍未取消，则立即形成：

```text
未结束的调用 A
+ 新 executorKey 的调用 B
```

如果 Terminal Manager 是全局故障，B 也会挂。结果是一次自动预热制造两个调用或会话。

对不可取消通道而言，“失败后立即漂移 key 重试”不是自愈，可能是故障放大器。

## 4.3 每次启动前 `freshKey()`

主动生成新 key 可以绕开单个坏 key，但平台没有可靠会话销毁保障时，会增加 executor 会话数量。

长期效果可能从“固定一个坏会话”变为“不断积累新会话”。

## 4.4 60 秒自动解除熔断

JS 超时后，不能证明 native 调用会在 60 秒内结束。冷却到期后自动重试可能继续堆积。

对该故障类型，熔断应优先采用：

- 当前 App 实例永久熔断；
- 用户明确触发恢复后只允许一次尝试；
- 或经过可验证的宿主会话清理后再解除。

不建议单纯按时间自动解除。

## 4.5 两套 `ensureWorkerUp()`

`main.js` 与 `packages/memory_engine.js` 各有一套启动实现。虽然共享文件租约，但租约是软裁决：

```text
读取租约 → 判断 → 写入租约
```

它不是严格原子抢占。即使解决了 JS 竞态，真正 shell 互斥也要等命令进入脚本后才生效，无法处理 bridge 层挂起。

---

## 4.6 2026-08-10 新增实机证据：`hiddenExec` 可被调用异常“污染”

针对 Codex Control Plugin 的最小后台实验得到以下结果：

### 实验链

```text
真实 ToolPkg
  → Tools.System.terminal.hiddenExec(...)
  → 长任务 / sleep
  → Tool 调用长时间不返回
  → 仅终止 Tool 调用，不手工 kill 后台 PID
  → 后续 hiddenExec 短命令也挂起
```

随后分别测试：

- 原 `executorKey`：挂起；
- 全新 `executorKey`：挂起；
- `super_admin:terminal`：正常；
- ToolPkg `terminal.exec`：正常。

这基本排除了“单个 executorKey 被锁住”，说明故障至少可以扩展到 `hiddenExec` 子系统的共享执行链。

### `/proc` 现场

挂起时抓到大量残留会话：

```text
proot
  └─ bash -lc 'echo LOGIN_SUCCESSFUL; echo TERMINAL_READY; eval "$COMMAND_TO_EXEC"'
       └─ /bin/bash --noprofile --norc
```

以及部分可见 terminal 的 `/bin/bash -il` 会话。

典型状态：

```text
proot:
  STATE=S
  WCHAN=do_wait

child bash:
  STATE=S
  WCHAN=pipe_read / do_select
```

这与 CME 历史“坏会话”现场高度一致。

### V2 对该证据的解释

当前最稳妥的结论不是“初始化竞态已被推翻”，而是：

> **`hiddenExec` 存在一种可复现的 executor poisoning / 残留会话故障模式：长任务、后台化或调用被异常终止后，宿主层可能仍保留未完成的 PRoot/bash/pipe 状态，从而影响后续 `hiddenExec`。**

这意味着：

- `hiddenExec` 不适合承载 Codex 一类分钟级长任务；
- CME Worker 启动虽然理论上只是“提交后台脚本”，但仍可能踩到相同生命周期问题；
- “用户显式点击 + 单次 hiddenExec”可以减少触发频率，但**不能被视为最终根治方案**；
- 后续应把 Worker 正常启动从 `hiddenExec` 迁出。

---

## 5. 推荐方案：启动期零 terminal，persistent terminal 作为首选恢复通道

V2.1 正式将 Worker 恢复路径调整为：

```text
第一层：onAppCreate
  → 只做 HTTP health
  → 绝不进入 terminal

第二层：普通业务调用
  → Worker 在线：正常执行
  → Worker 离线：快速返回 WORKER_OFFLINE
  → 不自动拉起

第三层：显式恢复
  → persistent terminal 为首选正常通道
  → session 内投递 start_worker.sh
  → Tool 快速返回
  → HTTP / result 文件查询结果

第四层：legacy hiddenExec
  → 不参与正常 Worker 生命周期
  → 仅保留诊断、兼容或隔离实验用途

第五层：平台未来能力
  → 若提供具备明确生命周期契约的 execDetached
  → 可替换 persistent terminal
```

## 5.1 `onAppCreate` 只做有限 HTTP health 检查

推荐将 `onAppCreate` 改成：

1. 延迟 2–5 秒；
2. 对 `http://127.0.0.1:8765` 做一次有限 health；
3. 在线则记录 ready；
4. 离线则记录 offline；
5. 不部署资源；
6. 不调用 `hiddenExec`；
7. 不调用 `terminal.create` / `terminal.exec` / `terminal.input`；
8. 不自动重试。

### 优点

- CME 不再参与 Operit 启动期的 terminal 风险窗口；
- 历史 hiddenExec 坏会话跨重启时，CME 也不会自动撞入故障通道；
- persistent terminal 只在用户真正需要恢复 Worker 时创建/复用；
- Worker 已在线时仍可直接工作。

## 5.2 Worker 离线时默认快速失败

普通业务工具调用建议：

```text
HTTP 请求
  → 在线：正常执行
  → 明确连接失败：立即返回 WORKER_OFFLINE
  → 不自动进入 Worker 启动路径
```

必须区分：

- `WORKER_OFFLINE`：连接拒绝、连接超时、health 失败；
- `BUSINESS_ERROR`：参数错误、记录不存在、备份格式错误；
- `LLM_ERROR`：模型网络或解析失败；
- `WORKER_START_FAILED`：启动脚本已执行但 Worker 未就绪；
- `PERSISTENT_TERMINAL_UNAVAILABLE`：persistent terminal 无法创建、复用或投递；
- `HIDDENEXEC_CHANNEL_BROKEN`：legacy hiddenExec 已知损坏；
- `TERMINAL_MANAGER_UNAVAILABLE`：只有在有证据表明可见 terminal / persistent terminal 也整体不可用时才使用。

特别注意：

> `HIDDENEXEC_CHANNEL_BROKEN` 不得自动升级成 `TERMINAL_MANAGER_UNAVAILABLE`。

因为真机实验已经证明 hiddenExec 可损坏而 `terminal.exec` / persistent terminal 仍正常。

## 5.3 部署页提供显式“启动 Worker”

部署页建议显示：

```text
Worker：offline
Persistent Terminal：healthy / unknown / broken
Legacy hiddenExec：healthy / broken / unknown
[重新检查] [启动 Worker]
```

点击“启动 Worker”后：

1. 再做一次 HTTP health；
2. 在线则直接成功；
3. 检查是否已有启动任务；
4. 检查 persistent terminal 状态；
5. 找到或创建 `cme-worker-control` session；
6. 通过 `terminal.input` 投递 `start_worker.sh` 启动命令并发送 Enter；
7. Tool 立即返回或进入短轮询状态；
8. 后续仅通过 HTTP health / result 文件判断成功；
9. persistent terminal 本身异常时，标记该通道故障并给出恢复指引；
10. 不 fallback 到 hiddenExec 自动重试。

### 为什么不再自动 fallback hiddenExec

因为当前证据已经表明：

```text
persistent terminal 可用
hiddenExec 可损坏
```

所以正常通道失败后自动切回 hiddenExec，不是“兜底”，而是把业务重新送回已知高风险接口。

## 5.4 建立“Worker 状态 + 通道状态”双层模型

不要再用一个笼统的：

```text
terminal_channel_broken.json
```

表示整个 terminal 系统。

建议拆成：

```text
logs/runtime_channels.json
```

例如：

```json
{
  "hiddenExec": {
    "state": "broken",
    "reason": "native_call_not_confirmed_cancelled",
    "requiresVerifiedCleanup": true
  },
  "persistentTerminal": {
    "state": "healthy",
    "sessionId": "..."
  }
}
```

Worker 自身状态另外维护：

```json
{
  "state": "ready|offline|starting|failed",
  "attemptId": "A_...",
  "launchChannel": "persistent-terminal",
  "launchId": "L_..."
}
```

核心安全不变量：

- hiddenExec broken 不阻止 persistent terminal 工作；
- persistent terminal broken 不代表 Worker 必然 offline；
- Worker ready 时不需要主动修复 hiddenExec；
- App 重启不得自动清除 hiddenExec broken；
- 通道恢复必须通过对应通道自己的 probe 验证；
- 不通过时间自动解除 broken；
- 不通过换 executorKey 假装恢复 hiddenExec。

## 5.5 persistent terminal 正式成为 V1 正常启动通道

推荐专用逻辑名称：

```text
cme-worker-control
```

状态至少保存：

```text
logicalSessionName
sessionId
state
lastProbeAt
activeAttemptId
```

正常启动流程：

```text
start_worker()
  → HTTP health
  → 已在线：ready
  → offline
  → 检查 activeAttemptId
  → 已有任务：复用
  → 检查保存的 sessionId
  → probe session
      ├─ healthy → 复用
      └─ missing/broken → create 新 session
  → terminal.input(start_worker command)
  → terminal.input(Enter)
  → 记录 attemptId / launchChannel
  → HTTP / result 文件轮询
```

### 关键约束

1. 第一版只允许一个 `cme-worker-control` session；
2. 第一版只允许一个 Worker 启动任务；
3. 不用 `terminal.exec` 同步等待长任务；
4. 不用 `hiddenExec` 承载 Worker 启动；
5. ToolPkg 只负责投递和查询；
6. 长任务生命周期由 persistent terminal session 承载；
7. `start_worker.sh` 必须写结构化 result / launch 日志；
8. 最终成功仍由 `ping_worker` 判断。

## 5.6 legacy hiddenExec 降级为诊断/兼容通道

V2 中还保留“显式单次 hiddenExec fallback”。

V2.1 调整为：

> **默认关闭，不参与正常 Worker 恢复。**

只允许用于：

- 独立故障研究；
- 平台兼容性测试；
- 用户明确进入诊断模式；
- 验证 Operit hiddenExec 官方修复后的回归测试。

不得用于：

- `onAppCreate`；
- UI onLoad 自动启动；
- 普通业务工具离线自愈；
- persistent terminal 启动失败后的自动 fallback；
- Worker restart 的正常路径。

## 5.7 executorKey 策略移入 legacy 诊断层

`executorKey` 不再属于 Worker 正常恢复状态机。

如果诊断模式仍测试 hiddenExec：

- 使用有限、稳定 key；
- 不时间戳无限生成；
- 不换 key 重试；
- 不把换 key 当作故障隔离；
- 一旦出现不可确认取消的超时，停止该轮测试并记录 hiddenExec broken。

## 5.8 CME 项目级 persistent terminal 闭环仍需一次验证

虽然生命周期模型已经在真实 ToolPkg 中通过，但 CME 仍需做最后一个项目级 probe：

```text
1. Worker 确认 offline
2. terminal.create/find("cme-worker-control")
3. terminal.input("bash /root/character_memory_engine/start_worker.sh ...")
4. 发送 Enter
5. Tool 立即返回
6. HTTP 轮询 127.0.0.1:8765
7. ping_worker 成功
8. 检查 attemptId / launchId / result 文件
9. 检查没有新增 hiddenExec 型坏会话
```

只有该闭环通过后，文档状态可从：

```text
persistent terminal 生命周期已验证
```

升级为：

```text
CME persistent terminal Worker 恢复链已验证
```

## 5.9 未来平台 `execDetached`

若 Operit 未来提供具有明确契约的 detached exec，并真正保证调用与 Tool 生命周期解耦、超时真正取消、调用结束自动清理、不跨 App 实例残留，则可以评估用它替换 persistent terminal。

在此之前，persistent terminal 是当前实测最可靠的 Worker 启动方向。

---

## 6. 资源部署与 Worker 启动通道解耦

`deployWorkerToData()` 使用文件 API，不应与 terminal 启动机制混为一个步骤。

建议拆分：

```text
prepareWorkerResources()
  - 部署 worker.py
  - 部署 embed.py
  - 部署 start_worker.sh
  - 部署模型
  - 校验文件存在和版本

workerLauncher.start()
  - 当前首选：persistent terminal
  - 未来：platform execDetached

pollWorkerHealth()
  - 仅 HTTP
  - 必要时读取 result/log 文件
```

legacy hiddenExec 不再进入 `workerLauncher.start()` 的正常路由。

`onAppCreate` 最好连资源复制也不做，避免启动期复制 23 MiB 模型。资源准备可在 ToolPkg 安装/升级流程、部署页显式操作或第一次按需启动前完成。

另外，当前 `start_worker.sh` 没有注册为 ToolPkg resource，必须补齐，否则 fresh install 依赖历史残留。

### 6.1 `workerLauncher` 抽象层

建议业务层只依赖：

```js
await workerLauncher.start({ attemptId, force });
```

V2.1 当前实现目标：

```text
PersistentTerminalLauncher
```

未来可增加：

```text
DetachedExecLauncher
```

而 `LegacyHiddenExecLauncher` 只属于 diagnostics，不注册为正常生产 launcher。

### 6.2 运行状态目录建议

```text
logs/
├── worker_state.json
├── runtime_channels.json
├── launch_history.jsonl
└── start_worker.log
```

避免一个笼统 broken 文件同时代表 Worker、hiddenExec 和 persistent terminal。

---

## 7. 建议的完整恢复流程

```text
用户调用 CME 工具或进入部署页
  │
  ├─ HTTP health 成功
  │    └─ 正常使用
  │
  └─ HTTP health 失败
       │
       ├─ 普通业务工具
       │    └─ 快速返回 WORKER_OFFLINE
       │
       └─ 用户点击“启动 Worker”
            │
            ├─ 已有 activeAttempt
            │    └─ 复用当前启动状态
            │
            └─ idle
                 ├─ prepareWorkerResources()
                 ├─ persistent terminal health
                 │    ├─ 已有健康 session → 复用
                 │    └─ 无/坏 → create("cme-worker-control")
                 ├─ terminal.input(start_worker.sh ...)
                 ├─ Enter
                 ├─ Tool 快速返回
                 └─ pollWorkerHealth()
                      ├─ ping_worker 成功 → ready
                      ├─ 启动脚本明确失败 → failed + 展示日志
                      └─ persistent terminal 自身异常
                           └─ 标记 persistentTerminal broken
```

同时：

```text
legacy hiddenExec broken
  └─ 记录诊断
  └─ 不阻止上述 persistent terminal 正常恢复
```

恢复链最终真值始终是：

```text
HTTP ping_worker 成功
```

而不是 terminal command 已投递、session 仍存在、shell 返回 0、PID 文件存在或 result 写了 submitted。

---

## 8. 是否保留自动启动

V2.1 对自动启动分两层处理。

### 8.1 `application_on_create`：永久禁止

无论 persistent terminal 已经多稳定：

> **Operit `application_on_create` 期间都不自动启动 Worker。**

启动阶段只做 HTTP health。

理由不仅是 hiddenExec 风险，还包括：

- 避免 CME 参与 Operit 冷启动关键路径；
- 避免启动阶段资源部署；
- 避免无用户需求时创建 terminal session；
- 将故障范围限制在用户真正使用 CME 时。

### 8.2 用户进入 CME UI 后：persistent terminal 完成 CME 闭环验证后可选

如果产品体验需要“用户打开 CME → Worker offline → 自动恢复”，必须满足：

1. persistent terminal 的 CME Worker 闭环已完成真机验证；
2. UI 根节点 `onLoad` 已稳定；
3. HTTP health 已失败；
4. 没有 activeAttempt；
5. persistent terminal 未标记 broken；
6. 用户设置允许自动恢复；
7. 全局单飞成立。

即：

```text
onAppCreate 自动启动：禁止
UI onLoad + persistent terminal：验证后可选
UI onLoad + hiddenExec：禁止
用户显式 hiddenExec：仅诊断
```

---

## 9. 平台侧最佳修复

CME 侧只能规避。真正根治需要 Operit 平台提供以下能力：

1. `hiddenExec` 超时时真正取消底层任务；
2. 返回唯一 requestId/sessionId；
3. 支持查询任务状态；
4. 支持显式 cancel；
5. 支持列出、关闭和删除 executor 会话；
6. App 生命周期结束时可靠清理插件创建的会话；
7. executor 故障隔离，单个坏会话不能阻塞全局 bridge；
8. 提供不依赖持久 terminal session 的 one-shot detached exec；
9. 对重复 executorKey 返回明确错误，而不是无限等待；
10. 支持 readiness API，让插件判断 terminal/proot 是否可用。

如果能修改 Operit 官方实现，最理想的是新增类似：

```text
terminal.execDetached({
  command,
  timeoutMs,
  sessionPolicy: 'ephemeral',
  killOnTimeout: true
})
```

其契约必须保证：

- 会话临时；
- 超时杀掉进程组；
- 调用结束后销毁会话；
- 不跨 App 实例残留。

---

## 10. 不推荐的方案

## 10.1 只把 10 秒改成 30 秒

只能降低概率，不能检测 readiness，也不能清理残留会话。

## 10.2 超时后无限换 executorKey

可能制造更多残留会话，加剧 Terminal Manager 压力；新 key 已实测不能保证隔离。

## 10.3 JS `Promise.race` 后立即重试

不能证明 native 调用被取消，会造成并发堆积。

## 10.4 在 `onAppCreate` 中创建 persistent terminal 自动启动

即使 persistent terminal 已验证生命周期可靠，也不建议进入 Operit 启动关键路径。它是更可靠的按需恢复通道，不是把旧自动启动原样搬过去。

## 10.5 依赖 shell 锁解决 bridge 挂起

命令未进入 shell 时，锁无机会执行。

## 10.6 60 秒自动解除熔断

没有证据表明 hiddenExec native 调用会在 60 秒内结束。

## 10.7 Operit 重启后无条件清除 hiddenExec broken

项目已有实测表明坏会话可能跨 Operit 重启残留。

## 10.8 把 hiddenExec broken 解释成整个 Terminal Manager broken

当前真机实验已经证明：

```text
hiddenExec ❌
terminal.exec ✅
persistent terminal ✅
```

因此必须按通道维护健康状态。

## 10.9 persistent terminal 失败后自动 fallback hiddenExec

V2.1 明确禁止。一个安全通道失败后自动进入已知高风险通道，不是合理降级。

## 10.10 将 legacy hiddenExec 长期保留为正常 Worker 启动路径

V2.1 已有更可靠的 persistent terminal 生命周期验证，因此不再有必要把 hiddenExec 作为正常生产恢复路径。

---

## 11. 按文件建议修改范围

## `main.js`

- 将 `onAppCreate()` 改为纯 HTTP health；
- 删除启动期 `deployWorkerToData()`；
- 删除启动期 `ensureWorkerUp()`；
- 不在 onAppCreate 清除 hiddenExec broken；
- 不在 onAppCreate 创建 persistent terminal；
- 保留只读状态写入和诊断探针；
- 移除 `hiddenExecSafe` 自动二次重试；
- 建立 Worker 当前状态入口，启动职责下沉至 launcher。

## `packages/memory_engine.js`

- 普通 `run()` 离线时快速返回，不自动拉起；
- 新增显式 `start_worker`，或将 `deploy_restart` 拆成 `start_worker/restart_worker`；
- 所有启动请求共享全局单飞；
- 正常启动只调用 `PersistentTerminalLauncher`；
- 不自动 fallback 到 hiddenExec；
- `force=true` 必须真实重启；
- 区分 Worker、persistent terminal、hiddenExec、业务、LLM 等错误域。

## `manifest.json`

- 注册 `start_worker.sh` 为 resource；
- 如果新增 `start_worker` 工具，同步更新 METADATA 和 exports；
- 如 persistent terminal API 需要声明，按当前 Operit 类型定义补齐。

## `start_worker.sh`

- 保留 shell 层 mkdir 单飞；
- 收紧旧进程匹配，必须匹配 CME 完整脚本路径和端口；
- 记录 launchId；
- 启动失败写明确阶段和退出码；
- 写结构化 result 文件；
- 不承担 Terminal Manager / hiddenExec 层重试职责。

## `ui/memory_system_ui/tabs/deploy.js`

- 展示 Worker / persistent terminal / legacy hiddenExec 三类状态；
- 提供“重新检查”“启动 Worker”；
- hiddenExec broken 不应禁用 persistent terminal 启动按钮；
- persistent terminal broken 时给出对应恢复指引；
- 所有启动调用走共享全局串行队列；
- CME 闭环验证前，不做 UI onLoad 自动恢复。

## 新增建议：`worker_launcher.js`

生产职责：

```text
start()
status()
probePersistentTerminal()
createOrReuseSession()
```

生产实现：

```text
PersistentTerminalLauncher
```

诊断模块另置：

```text
hiddenexec_diagnostics.js
```

## `README.md`

- 说明 onAppCreate 不再自动进入 terminal；
- 说明 persistent terminal 是正常 Worker 恢复通道；
- 说明 hiddenExec 已降级为 legacy diagnostics；
- 说明坏 hiddenExec 会话可能跨 Operit 重启残留；
- 说明 hiddenExec broken 不代表 persistent terminal broken；
- 记录 CME persistent terminal 验证状态。

---

## 12. 验证计划

## 12.1 静态和单元测试

至少验证：

1. `onAppCreate` 源码路径不包含任何 terminal 启动 API；
2. Worker 在线时 health 正常；
3. Worker 离线时 onAppCreate 在有限时间内结束；
4. 普通业务工具离线快速返回；
5. 两个并发“启动 Worker”调用只产生一次 attempt；
6. 生产启动路径不调用 hiddenExec；
7. hiddenExec broken 不阻止 persistent terminal；
8. persistent terminal broken 与 Worker offline 分开表达；
9. App 重启不自动清除 hiddenExec broken；
10. fresh install 能部署 `start_worker.sh`；
11. restart 后 PID / launchId 确实变化；
12. 业务错误不会触发 Worker 拉起。

## 12.2 真机故障注入

### 场景 A：Worker 已在线

- 重启 Operit；
- onAppCreate 只有 HTTP ping；
- 不产生 terminal 会话；
- CME 可直接使用。

### 场景 B：Worker 离线、persistent terminal 正常

- 停止 Worker；
- 重启 Operit；
- 启动期不创建 terminal；
- 打开 CME 显示 offline；
- 点击启动；
- create/find `cme-worker-control`；
- input `start_worker.sh`；
- Tool 快速返回；
- HTTP health 成功。

### 场景 C：hiddenExec 已损坏，但 persistent terminal 正常

- 保留已知 hiddenExec 坏会话；
- 确认 hiddenExec probe 失败；
- 确认 persistent terminal probe 成功；
- Worker offline；
- 使用 persistent terminal 启动 Worker；
- `ping_worker` 成功；
- CME 正常业务恢复；
- hiddenExec broken 状态仍保留，不自动清除。

这是 V2.1 最关键的新验收场景之一。

### 场景 D：persistent terminal session 丢失

- 保存旧 sessionId；
- 主动关闭/使 session 失效；
- 调用启动；
- probe 发现旧 session 不可用；
- create 新 session；
- 不产生并发启动；
- Worker 最终恢复。

### 场景 E：重复快速点击启动

- 连续触发多次；
- 只有一个 activeAttempt；
- 只有一个实际 `start_worker.sh`；
- 只有一个有效 launchId。

### 场景 F：persistent terminal 生命周期回归

```text
terminal.create
→ terminal.input("sleep 30; echo result")
→ Tool 立即返回
→ 30 秒后 result 存在
```

作为后续版本升级后的回归测试。

### 场景 G：legacy hiddenExec poisoning 回归

只在隔离诊断环境执行；验证历史残留形态，并确认生产 Worker 启动仍可走 persistent terminal，不受该 broken 状态阻塞。

### 场景 H：冷启动竞态独立性实验

每轮：

```text
清理到已知健康状态
→ 重启 Operit
→ 第一条 hiddenExec 只执行 echo COLD_OK
```

重复 10–20 轮，区分初始化竞态与前序异常调用 poisoning。该实验不阻塞 CME 正常功能发布。

### 场景 I：长时间静置和真冷启动

- 静置数小时或关机后开机；
- 对照旧版和 V2.1；
- 比较 Operit 启动稳定性、Worker恢复耗时、hiddenExec残留、persistent terminal 状态。

---

## 13. 成功标准

V2.1 修复完成应满足：

- `application_on_create` 期间 CME 不调用任何 terminal 启动 API；
- Worker 离线不会导致 Operit 启动卡顿；
- 普通工具离线快速返回 `WORKER_OFFLINE`；
- 单个 App 实例最多一个 Worker 启动 attempt；
- Worker 正常启动完全不依赖 hiddenExec；
- persistent terminal 的 Tool-return 后继续执行模型保持成立；
- hiddenExec broken 与 persistent terminal health 分开管理；
- hiddenExec 损坏时，只要 persistent terminal 正常，CME 仍可恢复 Worker；
- persistent terminal session 丢失后可以安全重建；
- Worker 启动最终通过 HTTP health 验证；
- fresh install 不依赖 `/root` 历史残留；
- 日志可通过 attemptId / launchId / launchChannel / sessionId 还原完整链路；
- 历史 hiddenExec 根因研究不再阻塞 CME 生产恢复路径。

---

## 14. 推荐实施顺序

### 第一阶段：保留 V2 止血

1. 禁用 onAppCreate 的所有 terminal 自动拉起；
2. 删除 hiddenExec 超时后的自动换 key 重试；
3. 删除时间型自动解除 hiddenExec broken；
4. 普通工具 Worker 离线快速失败；
5. 注册并部署 `start_worker.sh` resource。

### 第二阶段：完成 CME persistent terminal 项目级闭环

6. 增加 `cme-worker-control` 专用 session；
7. 用 `terminal.create + terminal.input` 启动 `start_worker.sh`；
8. Tool 必须快速返回；
9. HTTP `ping_worker` 最终成功；
10. 记录 attemptId / launchId / sessionId；
11. 确认不产生 hiddenExec 型坏会话。

### 第三阶段：正式迁移生产启动

12. 建立 `workerLauncher`；
13. 生产启动只使用 `PersistentTerminalLauncher`；
14. hiddenExec 从生产 Worker 生命周期删除；
15. 建立 Worker / persistentTerminal / hiddenExec 三类独立状态；
16. UI 展示通道状态；
17. 修正 restart / 进程匹配 / result 文件。

### 第四阶段：验证故障隔离

18. 人工保留 hiddenExec broken；
19. 验证 persistent terminal 仍可启动 Worker；
20. 验证 hiddenExec broken 不再阻塞 CME 正常业务。

### 第五阶段：独立研究历史 hiddenExec 根因

21. 做“干净冷启动 + 短 echo”控制实验；
22. 区分初始化竞态与异常调用 poisoning；
23. 更新 CME 故障文档。

### 第六阶段：平台协同

24. 向 Operit 平台提交 hiddenExec 真取消、requestId/sessionId、list/cancel/delete、executor 故障隔离、readiness API、ephemeral detached exec 等需求；
25. 若平台提供可靠 `execDetached`，再评估是否替换 persistent terminal。

---

## 15. 最终建议

对于当前 CME，V2.1 推荐最终架构：

```text
Operit onAppCreate
  → HTTP health only

CME 普通业务
  → HTTP Worker
  → offline 时快速失败

用户显式恢复
  → PersistentTerminalLauncher
  → terminal.create/find("cme-worker-control")
  → terminal.input(start_worker.sh)
  → Tool 快速返回
  → HTTP ping_worker
  → ready

legacy hiddenExec
  → diagnostics only
  → 不参与正常 Worker 生命周期
```

核心判断已经从 V2 的：

> persistent terminal 是优先验证目标

升级为：

> **persistent terminal 生命周期模型已经真机验证成立，是 CME Worker 恢复的首选实现方向。**

仍然需要的最后一项 CME-specific 验证是：

```text
persistent terminal
→ start_worker.sh
→ Worker
→ HTTP ping_worker
```

这项通过后，可以正式宣布 CME Worker 恢复链迁移完成。

同时必须保留一个重要的新安全原则：

> **hiddenExec、persistent terminal、Worker 是三个独立健康域。**

因此：

```text
hiddenExec broken
≠ persistent terminal broken
≠ Worker offline
```

特别是：

> **legacy hiddenExec 即使已经被坏会话污染，也不应再阻止 CME 通过 persistent terminal 正常恢复 Worker。**

这会把 hiddenExec 坏会话问题从：

```text
CME 可用性的阻塞故障
```

降级成：

```text
Terminal Manager / legacy channel 的维护与诊断问题
```

这正是 V2.1 相比 V2 最大的架构收益。

对于历史“冷启动初始化竞态”结论，继续保留为独立待验证假设，不影响正常恢复架构实施。

报告结束。

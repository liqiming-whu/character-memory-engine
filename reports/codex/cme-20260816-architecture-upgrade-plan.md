# CME 更新后的开发计划：架构升级与历史审计闭环

- 文档标识日期：2026-08-16
- 本轮审计执行时间：2026-08-15（UTC）
- CME 基线：`master` / `b8ea6b0` / tag `v2.6.0`
- 官方参考：`/root/projects/operit-official/examples/sidebar_account_book`
- 历史输入：`CME_CODE_AUDIT_REPORT_2026-08-10.md`、`cme-audit-verification-and-fix-plan.md`
- 审计方式：源码与 Git 元数据只读核验；本轮没有启动 Worker、没有运行会创建临时文件或改写 PID 的测试
- 写入边界：本文件是本轮唯一新增文件

## 1. 结论摘要

1. **建议迁移到“薄 Compose DSL 壳 + `UI.WebView` + Worker 托管本地 Web UI/API”**，但必须渐进迁移并保留 Compose 侧离线恢复壳。CME 当前 7 个正式 Tab 全部由一个 1459 行 `screen.js` 组织，根 `onLoad` 人为保持 120 秒 action 窗口，render 中仍有 `setState`、`setTimeout`、工具调用调度和 UI 状态持久化；这些正是既往渲染风暴、状态不刷新、bridge 排队和 ANR 的结构性放大器。WebView 能把频繁状态更新、列表渲染和定时任务移到浏览器渲染模型中，显著降低 Compose 全树重绘风险。
2. **不需要另起 Node 服务。** 当前 `worker.py` 已使用 `ThreadingHTTPServer` 监听 `127.0.0.1:8765`，可以增加安全的 `GET` 静态文件处理、health 与同源 `/api/v1/*` 路由。当前源码尚未具备该能力：`Handler` 只有 `do_POST()`，且所有 action 都走根路径 JSON RPC。因此“可由 Worker 托管”是可实施结论，不是当前已完成事实。
3. **不能把部署页完全依赖于 Worker 网页。** 从零安装、依赖缺失、端口占用或 Worker 崩溃时，网页本身无法打开。Compose 壳必须能在不依赖 Worker 的条件下完成资源检查、依赖安装、启动、重试和结构化诊断；Worker 健康后才切到 WebView。部署 Tab 的完整信息页可迁入 Web，但离线恢复操作必须留在壳层。
4. **`main.js` 应拆。** 官方 `main.ts` 只负责注册 UI 路由与导航；CME 的 `main.js` 同时承担注册、HTTP 客户端、资源部署、冷启动探针、自动分析、记忆注入、trigger 文件和生命周期钩子。目标应是薄注册入口，业务分别进入 Worker runtime、engine client、自动分析、注入和诊断模块。
5. **根目录 `deploy.js` 不应原样提交。** Git 显示它是未跟踪文件，内容是 `ui/memory_system_ui/tabs/deploy.js` 的旧副本，且使用 `require("../shared")`/`require("../theme")`，放在根目录时路径语义错误；相较正式文件还少 51 行 v2.6.0 安装状态与轮询逻辑。它不是可纳入的新部署业务模块，应删除该工作区孤儿；新建的部署模块应从现有 Worker 生命周期代码提炼，并以新的明确路径纳入版本管理。根目录另有同类未跟踪旧副本 `memory_engine.js`，也应在发布清洁门禁中处理。
6. **v2.6.0 的从零安装经验需要固化为显式状态机。** 当前能力分散在 env 标记、`.installing`、`worker_state.json`、三类日志、`safeAutoLaunch()`、`installDepsViaTerminal()` 与 `start_worker.sh` 中；状态检查还会经 `run()` 隐式拉起 Worker。建议统一成“未部署 → 部署资源 → 依赖缺失/安装中 → 启动中 → 健康/降级/失败”的监督器，health 是最终真值，日志和标记只是诊断证据。
7. **历史 20 项在 v2.6.0 的状态为：已修 3 项、部分修复 2 项、未修 15 项。** 已修的是 P0-1 角色页初始化顺序、P1-4 `start_worker.sh` 资源闭环、P2-7 业务错误不再一律重放；P0-2 水位线与 P1-3 restart 属于部分修复。备份覆盖安全、索引一致性、UI render 副作用、日志越界读取、LLM 解析、请求体上限等仍在。

## 2. 证据标记与审计边界

本文用以下标记区分结论来源：

- **[官方参考]**：直接来自 `sidebar_account_book` 当前源码。
- **[CME 源码]**：直接来自 CME `b8ea6b0` 及当前工作树可见源码。
- **[历史证据]**：来自两份 2026-08-10 报告或 CME 已记录的实机实验；本轮没有重新执行。
- **[审计推导]**：在上述事实基础上的架构判断或实施建议。

只读限制带来的边界：

- 本轮没有执行 `test_worker.py`/`test_worker_a.py`。两者会创建临时数据库，且 `import worker` 当前会在模块加载阶段写 `/root/character_memory_engine/worker.pid` 和 cold probe，不符合本轮只读约束。
- 没有重跑历史恶意 ZIP、任意文件读取、向量一致性、ANR 或从零安装实机实验；相关动态结果只标作 **[历史证据]**。
- 已读取 Git 状态。审计开始和成文前均看到两个原有未跟踪文件：`deploy.js`、`memory_engine.js`；本轮不处理它们。

## 3. 官方架构与 CME 现状对照

| 关注点 | 官方 `sidebar_account_book` | CME v2.6.0 | 判定 |
|---|---|---|---|
| 根入口 | **[官方参考]** `src/main.ts` 只 import screen，并注册 route/navigation | **[CME 源码]** `main.js` 562 行，注册之外还含部署、探针、HTTP、自动分析、注入与 trigger 逻辑 | CME 应拆为薄入口 |
| UI | **[官方参考]** `index.ui.ts` 是 loading/error/retry + `UI.WebView` 壳 | **[CME 源码]** 7 个正式 Tab 全量 Compose；`screen.js` 1459 行，Tab 文件合计数千行 | 值得渐进迁移 |
| Web 生命周期 | **[官方参考]** `account_book_web_runtime.ts` 负责资源部署、依赖检查、启动、health、进度和日志尾部 | **[CME 源码]** 生命周期散布在 `packages/memory_engine.js`、`start_worker.sh`、`worker.py`、部署 Tab 与 `main.js` | 建立唯一 supervisor/runtime |
| 本地服务 | **[官方参考]** 单独 Node/Express 服务同时提供 API 和静态页 | **[CME 源码]** 已有 Python `ThreadingHTTPServer`，但只有 POST JSON action | CME 可直接扩展 Worker，不需 Node |
| 子包工具面 | **[官方参考]** `account_book_core.ts` 独立导出 CRUD 工具 | **[CME 源码]** `packages/memory_engine.js` 有 31 个显式工具，但混入部署、诊断、拉起和协议包装 | 保留工具兼容面，拆出 runtime/client |
| manifest 资源 | **[官方参考]** Web assets 与 server runtime 均声明为目录资源 | **[CME 源码]** 已声明 worker/embed/model/start script，没有 Web assets | 新增版本化 Web 目录资源 |
| 状态表达 | **[官方参考]** 顺序编排 + progress event + 结构化 result/status；并非严格枚举状态机 | **[CME 源码]** env/文件/日志/health 多套信号 | CME 状态机是基于官方模式的进一步抽象，不能说成官方原样实现 |

需要避免机械照搬官方示例：

- **[官方参考]** 示例 Web 页从 `unpkg.com` 加载 React；**[审计推导]** CME 的首次安装、离线恢复和隐私场景要求前端运行依赖随 ToolPkg 打包，不能把 CDN 当启动前提。
- **[官方参考]** 示例服务处理简单 JSON 文件；**[CME 源码]** CME 有 SQLite、向量、备份恢复、LLM 分析和角色注入，API 安全与迁移回滚要求更高。
- **[CME 源码]** Worker 随 Operit/proot 生命周期而非真正跨 App 永久常驻；文档中的“常驻”应解释为“当前 proot 生命周期内的长期 HTTP 进程”。

## 4. A：UI 层升级审计

### 4.1 是否可以、是否值得

**结论：可以，且值得；采用渐进双轨迁移，不做一次性重写。**

主要收益：

1. **消除 Compose action 窗口黑魔法。** **[CME 源码]** 根节点 `onLoad` 明确 `await` 120 秒以维持 stateChange 订阅；Web 页面使用标准事件循环和组件状态，无需长时间悬挂宿主 action。
2. **降低全树重绘与 render 副作用耦合。** **[CME 源码]** `screen.js` 在 render 路径恢复 env state、写 state、调度数据加载、角色加载、知识加载、UI 状态防抖保存；`character.js`、`messages.js` 也有 render 期副作用。浏览器端可以用 effect、request generation、虚拟列表和局部 DOM 更新隔离这些行为。
3. **绕开 `ctx.callTool` UI bridge 排队。** Web 页面可同源 `fetch('/api/v1/...')` 直接访问 Worker，避免当前全局串行队列只覆盖一部分调用、各 Tab 又直接 `ctx.callTool` 的混合模型。
4. **长列表和筛选更自然。** 当前 100 条上限是对 Compose 全量渲染的折中；Web 端可先保持相同上限，再引入分页/窗口化，而不改变 SQLite 权威数据。
5. **开发与测试边界更清晰。** Web 组件、API client、状态管理可在普通浏览器和 mock server 中测试，Compose 只需覆盖启动/恢复壳。

不能夸大的收益：

- WebView 不会自动修复 Worker 启动、SQLite 一致性、LLM 解析或备份覆盖问题。
- 如果 Web 页继续高频轮询、一次渲染超大 DOM 或在主线程处理大量数据，仍会卡顿。
- 首屏需要 Worker 健康；因此 supervisor 必须先于 UI 迁移完成。

### 4.2 历史渲染风暴与卡死的源码归因

- **[历史证据]** `docs/RENDER_STORM_PLATFORM_ANALYSIS.md` 记录 Compose `setState` 引发全量重绘，render 内 I/O、重复 load 和删除后未本地移除会放大成队列雪崩；v2.3.0/v2.3.3 已通过限频和时间闸缓解。
- **[CME 源码]** 缓解并未消除结构根因：`screen.js` 仍有 120 秒 onLoad 窗口、多个 render 条件分支中的 `setTimeout`/异步加载、初始化 render 的状态写、状态快照持久化；部署页又有最长 6 分钟的递归轮询。
- **[审计推导]** WebView 迁移的核心价值不是“浏览器一定更快”，而是让 Compose 不再为 7 Tab 每次状态变化重建整棵 DSL 树，同时让副作用回到标准生命周期中。

### 4.3 Worker 直接托管 Web 的目标形态

```text
Operit navigation
  -> thin Compose shell
       -> worker_runtime.ensure/status/install/retry/diagnostic
       -> HEALTHY 后 UI.WebView(http://127.0.0.1:8765/ui/...)
  -> Python Worker :8765
       -> GET /healthz
       -> GET /ui/*                 静态资源
       -> /api/v1/*                 Web UI API
       -> POST /                    兼容现有 ToolPkg JSON action
       -> SQLite / embedding / LLM
```

具体边界：

- `worker.py::Handler` 增加 `do_GET()`，只允许从固定、解析后仍位于 `WEB_ROOT` 的路径读取静态文件；SPA fallback 只对 `/ui/*` 生效。
- 新 API 复用 `ACTIONS`/服务层，不复制 CRUD 实现。现有 `POST /` 保留至少一个完整发布周期，供 `packages/memory_engine.js` 和 prompt hook 使用。
- health 返回 `workerVersion`、`apiVersion`、`schemaVersion`、`webBuildId`、`vecAvailable`、`dbReady`；壳层校验版本匹配后才打开页面。
- 只绑定 `127.0.0.1`，默认拒绝跨域；涉及写入/恢复的请求使用每次运行生成的 UI session token，并限制 body、Content-Type、方法和路径。不得因为是 loopback 就跳过 CSRF/本机其他应用访问风险。
- Web 产物完整打包到 ToolPkg，禁止依赖公网 CDN。manifest 增加类似官方的目录资源 `engine_web_assets`；runtime 用 `ToolPkg.readResource()`、临时目录解压、校验 build manifest，再原子切换版本目录。
- 静态资源使用带 hash 文件名；`index.html` no-cache，hash assets immutable，避免 Worker 更新后 WebView 仍读旧 JS。

### 4.4 迁移顺序

1. **基础设施先行**：supervisor 状态机、Web 静态资源部署、health/version、API v1、token、安全边界。
2. **薄壳落地**：Compose 只保留进度、错误、安装、重试、诊断和 WebView；暂时通过 feature flag 默认进入旧 Compose UI。
3. **只读垂直切片**：先迁“概览”，验证主题、API、缓存、前后台切换、版本更新与首屏时间。
4. **高收益数据页**：知识 → 时间线 → 待办。它们最受列表全量渲染、筛选和连续操作影响。
5. **角色页**：迁移角色上下文、四类角色记忆、创建/删除和注入预览；必须先有 request generation 与角色隔离测试。
6. **设置/备份**：备份 overwrite 安全修复完成后再迁，避免把现有 P0 风险复制进新 UI。
7. **部署页**：健康状态下的详细部署页迁到 Web；离线最小恢复卡片永久留在 Compose 壳。
8. **移除旧 UI**：7 Tab 实机验收完成并经历至少一个可回滚版本后，删除旧全量 Compose 页面。`messages.js` 的 `currentTab === 99` 预留路径和未注册消息页先做产品确认；若不恢复则移除，不纳入 7 Tab 迁移完成定义。

### 4.5 工作量、风险与回滚

- Web host/API/资源部署：4～6 人日。
- 薄 Compose 壳：2～3 人日。
- 7 Tab Web 实现与回归：12～20 人日。
- 自动化、真机矩阵和灰度：4～6 人日。
- 主要风险：首屏依赖 Worker、WebView 缓存旧资源、Android WebView 差异、备份/文件选择桥接、主题与安全 token、旧 UI 与新 UI 双写状态。
- 回滚：保留 `CME_UI_RUNTIME=compose|web`（或等价受控配置）至少一个发布周期；API 保持向后兼容；Web assets 使用版本目录，切回前一 `webBuildId` 不回滚数据库。

## 5. B：入口模块化与孤儿文件治理

### 5.1 目标模块

建议先在现有 CommonJS 形态中拆分，降低同时引入 TypeScript 构建链的风险；完成后再评估采用官方 `src/*.ts -> dist/*.js` 结构。

| 目标文件 | 从现有代码迁入的职责 | 主要导出 |
|---|---|---|
| `main.js` | 仅常量、screen/hook import、route/navigation/lifecycle/prompt hook 注册 | `registerToolPkg` 及宿主要求的命名导出 |
| `shared/engine_client.js` | 两处重复的 Worker URL、timeout、HTTP JSON 解析与 error domain | `callEngine`、`readHealth` |
| `shared/worker_runtime.js` | `deployWorkerToData`、launch lock、install/start/restart/status/diagnostic | `ensureRuntime`、`installRuntime`、`restartRuntime`、`getRuntimeStatus` |
| `features/auto_analysis.js` | `autoAnalyzeChat`、trigger 原子读写、cooldown/watermark 调度 | `onPromptFinalizeAnalysis` |
| `features/memory_injection.js` | settings/history、scoring、附件构造、prompt input/finalize 注入 | `onPromptInput`、`injectForFinalize` |
| `shared/diagnostics.js` | `cmeProbe`、`jsLog`、结构化诊断归一化 | logging/probe API |
| `ui/memory_system_ui/index.ui.js` | 未来薄 Compose 壳 | default screen |

**[官方参考]** 官方根入口使用 `registerUiRoute()` 和固定 route 常量；**[审计推导]** CME 迁薄壳时应在目标 Operit 版本验证并优先采用同一正式注册方式，旧 `registerToolboxUiModule()` 只作为兼容回滚路径。

### 5.2 必须消除的重复与矛盾

- `main.js` 和 `packages/memory_engine.js` 各有 `httpCall()`、资源部署和日志逻辑，错误文案与 timeout 不一致。
- `packages/memory_engine.js::run()` 的注释与行为已明确为 transport 离线时自动 `safeAutoLaunch()` 并重放一次；这与历史统一计划“普通业务离线快速失败、不启动”冲突。目标策略必须统一为：`onAppCreate`、prompt hooks、普通 CRUD 只 health/调用并快速失败；只有显式 runtime/UI 恢复动作可部署、安装或启动。
- `deploy_status` 当前经 `run('deploy_status')`，Worker 离线时会产生启动副作用，不是纯状态查询。
- `deployStatus()` 和 `installDepsViaTerminal()` 以同步方式读取 `Tools.Files.read()` 的返回值，而同文件其他位置将其作为 Promise `await`；状态标记读取必须统一异步化并有 timeout。
- 在线 `deploy_install` 最长可能在 Worker 内执行 600 秒 pip，而 JS HTTP 外层约 70 秒超时；超时后的 catch 会转入 terminal 安装路径，存在同一安装被第二次投递的风险。状态机必须使 install 拥有唯一 attemptId 并可查询，而不是由调用者超时推断失败。

### 5.3 `deploy.js` 的版本管理结论

**[CME 源码/Git]** 根目录 `deploy.js` 是未跟踪、过时的部署 Tab 副本，不是业务部署模块：

- 正式被 import 的文件是 `ui/memory_system_ui/tabs/deploy.js`。
- 根副本相对 require 路径在根目录不成立。
- 根副本缺少正式文件中 51 行 v2.6.0 安装中处理与自动轮询。

处理计划：

1. 实施变更前删除根目录未跟踪 `deploy.js`；不要 `git add deploy.js`。
2. 新的生命周期模块以 `shared/worker_runtime.js`（或 TypeScript 版本）创建并正常提交，避免复用有歧义的根文件名。
3. 同步清理未跟踪根 `memory_engine.js`；它相较 `packages/memory_engine.js` 也已落后。
4. 增加发布包 allow-list/校验脚本：manifest 主入口、subpackage entries、resources、Web build 产物必须存在；根目录同名孤儿和未跟踪源码使 CI 失败。
5. 每个架构提交都保持单一意图：先移动无行为变化，再切调用方，再删除旧实现，便于 `git revert`。

入口模块化工作量 3～5 人日；主要风险是 Operit CommonJS 加载与命名导出识别。回滚方式是保留旧入口的单提交快照，模块抽取阶段不改变 manifest/tool 名称和 hook id。

## 6. C：Worker 生命周期统一状态机

### 6.1 当前链路事实

- **[CME 源码]** v2.6.0 已具备：`start_worker.sh` manifest resource、项目 venv、三依赖完整性 gate、visible terminal 重试、`.installing`、install.log 分阶段日志、安装后自动启动、前端 5 秒轮询。
- **[历史证据]** CHANGELOG 记录从空目录一次点击安装、约 75 秒后 Worker/向量全绿并完成自动分析的实机闭环。
- **[CME 源码]** 状态仍散落：`MEMORY_ENGINE_INSTALLING`、`MEMORY_ENGINE_NEED_INSTALL`、`.installing`、`worker_state.json`、`start_worker.log`、`install.log`、HTTP ping。
- **[CME 源码]** `safeAutoLaunch()` 只有 JS VM 内 active Promise；shell 的 `/tmp/cme_start_worker.lock` 无 owner/时间/自动陈旧恢复。
- **[CME 源码]** `start_worker.sh` 和 `worker.py::_find_worker_processes()` 仍按 `worker.py` 宽匹配，可误杀/误报其他项目。
- **[CME 源码]** `deploy_restart` 目前明确返回 `WORKER_RECOVERY_DISABLED`，已经停止“假成功”，但没有真正的重启闭环。

### 6.2 状态与转换

建议唯一状态枚举：

```text
UNKNOWN
  -> NOT_DEPLOYED
  -> DEPLOYING_ASSETS
  -> DEPENDENCIES_MISSING
  -> INSTALLING_DEPENDENCIES
  -> STARTING
  -> HEALTHY
  -> DEGRADED
  -> STOPPED
  -> FAILED
```

语义：

- `NOT_DEPLOYED`：worker/start script/model/web manifest 任一缺失或版本不匹配。
- `DEPENDENCIES_MISSING`：venv 不存在或模块 probe 有缺失清单。
- `INSTALLING_DEPENDENCIES`：存在有效、可证明 owner 的 install attempt；不能仅凭永久 marker。
- `STARTING`：已提交唯一 launchId，等待匹配的 launch result 与 health。
- `HEALTHY`：HTTP health 成功，版本、DB、Web build 和必需依赖满足。
- `DEGRADED`：基础 CRUD 可用但向量/模型等可选能力不可用；UI 必须显示降级项。
- `FAILED`：包含 `stage`、稳定 `code`、`retryable`、`attemptId`、`diagnostic`、`logTail`，不能只返回自然语言。

health 是最终真值；持久状态只描述最近一次 attempt，启动时必须 reconcile，不能把旧 `ready` 文件当在线证明。

### 6.3 文件/函数级改动

1. `shared/worker_runtime.js`
   - 实现 `inspectRuntimeLayout()`、`prepareRuntimeResources()`、`inspectDependencies()`、`installDependencies()`、`startWorker()`、`restartWorker()`、`readHealth()`、`reconcileRuntimeState()`。
   - 统一 `RuntimeResult`：`success/state/stage/code/message/progress/retryable/attemptId/launchId/startedAt/updatedAt/checks/health/logTail`。
   - 单进程 active Promise 之外，用 owner-aware attempt 文件完成跨模块/跨 VM 单飞；文件原子替换。
   - 先在真机 capability probe 验证官方示例采用的 `terminal.execStreaming()`；可用则用于依赖进度。不可用时保留 v2.6.0 `terminal.input()` 路径，但必须由 result 文件回报完成，禁止靠 HTTP timeout 再投递。
2. `packages/memory_engine.js`
   - 删除内嵌 lifecycle 实现，工具 `deploy_status/install/restart/diag` 转发 runtime。
   - `run()` 不再隐式启动；transport offline 结构化快速失败，业务错误不重放。
   - `deploy_status` 变成只读操作。
3. `start_worker.sh`
   - `set +e` 改为阶段显式检查；每阶段原子写 `launch_result.<launchId>.json`。
   - lock 写 owner PID/starttime/attemptId；优先 `flock`，否则 owner-aware mkdir，并能安全判断 stale。
   - Worker identity 必须匹配完整脚本路径、`--port 8765`、`--db`、PID starttime 和 launchId；删除 `*worker.py*` 广域 kill。
   - 启动后等待或由 supervisor 验证匹配 health，不把“后台命令已提交”当成功。
4. `worker.py`
   - `ping_worker`/`GET /healthz` 返回 launchId、PID/starttime、版本、API/schema/web build、DB quick state、向量降级状态。
   - PID/probe 写入从 import 阶段移入 HTTP server 启动分支。
5. `ui/memory_system_ui/index.ui.js`
   - 消费 progress event，展示阶段、百分比、缺失依赖、可重试错误和日志尾部。
   - 离线时保留“安装/重试/诊断”；`HEALTHY|DEGRADED` 才创建 WebView。

### 6.4 生命周期策略

- `application_on_create` 永久 health-only，不部署、不安装、不创建 terminal、不 kill。
- prompt input/finalize 与普通记忆工具不启动 Worker；离线时快速跳过注入/分析并留结构化状态。
- 打开 CME UI 可以自动部署内置资源和尝试启动已完整安装的 Worker；安装网络依赖必须有明确用户动作。
- restart 只由显式 UI/tool 触发，成功条件是旧 identity 退出、新 launchId 与 health 匹配。
- 不允许 fallback 到 `hiddenExec`。

### 6.5 工作量、风险与回滚

- 监督器与结果契约：4～6 人日。
- shell identity/lock/result：2～3 人日。
- UI 壳进度与诊断：2～3 人日。
- 真机故障注入：2～3 人日。
- 风险：Operit terminal API 在冷启动阶段的能力差异、安装进程跨 action 生命周期、proot 被系统回收、旧 marker/lock 迁移。
- 回滚：状态机以新显式工具和 feature flag 启用；旧 v2.6.0 start script 保留为上一版本 resource；失败只允许回滚到 health-only + 手动恢复，不回到 hiddenExec 或广域 kill。

## 7. D：2026-08-10 历史审计 20 项复核

### 7.1 汇总

| 状态 | 数量 | 项目 |
|---|---:|---|
| 已修 | 3 | P0-1、P1-4、P2-7 |
| 部分修复 | 2 | P0-2、P1-3 |
| 未修 | 15 | P0-3；P1-1/2/5/6/7/8；P2-1/2/3/4/5/6/8/9 |

### 7.2 逐项状态

| 原 ID | v2.6.0 状态 | 当前源码事实 | 纳入计划 |
|---|---|---|---|
| P0-1 角色页初始化顺序异常 | **已修** | `character.js::render()` 已在读取 `localChangeState[0]` 前初始化该 state | 旧 Compose 存续期补渲染回归；Web 迁移后删除旧实现 |
| P0-2 分析失败仍推进水位线 | **部分修复** | `triggerAnalysis()` 仅在 `rOk` 时推进；失败保留水位线并记 fail count。但 `rOk` 仍是包装层推断，没有 Worker `analyzed=true` 契约、原子多 writer/CAS 和有限退避 | P0-03 |
| P0-3 无效备份可 overwrite | **未修** | `inspect_engine()` 只验 manifest/文件存在；`restore_engine(overwrite)` 直接复制活动 DB，未 quick_check/schema/hash/维护门/原子替换后复检 | P0-01 |
| P1-1 update 不刷新 hash/vector | **未修** | `update_memory()` 没有重算 `semantic_hash`，没有更新 `vec_items` | P0-02 |
| P1-2 bulk delete 不清 vector | **未修** | `bulk_delete_memories()` 只写 `is_deleted` | P0-02 |
| P1-3 restart 在线不真正重启 | **部分修复** | 当前不再假报成功，而是恒定返回 `WORKER_RECOVERY_DISABLED`；真正 restart 尚未实现 | P0-04 |
| P1-4 fresh install 缺 start script resource | **已修** | manifest 已有 `engine_start_worker_sh`，资源部署到 DATA/ROOT，v2.6.0 有从零实机记录 | 状态机回归门禁保留 |
| P1-5 UI bridge 队列覆盖不全 | **未修** | `serialCall()` 只覆盖根页面部分调用；character/messages/deploy/todos 仍直接 `ctx.callTool` | P1-03/P1-04，通过 Web 同源 API 消除主路径 |
| P1-6 render 中副作用 | **未修** | 根 screen 与多个 Tab 仍有 render 期 state 写、timer、异步调度；根 onLoad 持续 120 秒 | P1-03/P1-04 |
| P1-7 `get_logs(path)` 任意读 | **未修** | `worker.py::get_logs()` 直接采用任意 path | P0-05 |
| P1-8 LLM JSON 解析不足 | **未修** | 仍为单次请求 + 贪婪 `{...}` 正则 + 无 schema；v2.5.1 仅新增关闭 thinking | P1-05 |
| P2-1 长对话截断扩增 | **未修** | `>12000` 时仍取前后各 10000，12001～19999 会重叠并变长 | P2-01 |
| P2-2 total 忽略 query | **未修** | 列表 SQL 有 LIKE，count SQL 无 query | P2-01 |
| P2-3 删除不存在仍成功 | **未修** | `delete_memory()` 不检查 rowcount | P1-07 |
| P2-4 更新软删项仍成功 | **未修** | 初查/回读不筛 `is_deleted`，UPDATE 不检查 rowcount | P1-07 |
| P2-5 UI 配置非原子写 | **未修** | `save_ui_state()`/`set_injection_settings()` 直接 `open(...,'w')`，注入 history 也直接覆盖 | P1-06 |
| P2-6 宽匹配误杀 worker | **未修** | shell 与 `_find_worker_processes()` 仍按 `worker.py` 子串 | P0-04 |
| P2-7 所有失败都尝试拉起 | **已修（原问题）** | errorDomain 已区分，business/protocol 不拉起、不重放；transport 仍自动拉起是新的策略冲突 | P0-04 将普通调用改回 fast-fail |
| P2-8 HTTP body 无上限 | **未修** | `Handler.do_POST()` 信任 Content-Length 并一次性 read | P0-05 |
| P2-9 日志无轮转 | **未修** | Python/JS/start/install 日志仍追加，无统一 rotation/retention | P2-02 |

## 8. 更新后的优先级计划

以下优先级按当前风险重新排序，不机械沿用 2026-08-10 的编号。

### P0：发布阻断与架构地基

#### P0-01 安全恢复闭环（4～6 人日）

- 文件/函数：`worker.py::backup_engine`、`inspect_engine`、`restore_engine`、`handle_action`。
- 改动：立即禁止或 feature-flag 关闭 overwrite；manifest 写每个文件 SHA-256/size；解压后只读打开 SQLite，执行 quick_check、schema/table/column/version 校验；全局 maintenance gate 阻止新请求并等待在途写请求结束；SQLite backup 生成保护副本；同目录临时 DB + fsync + `os.replace`；重开复检；失败自动回滚。merge 也必须先通过相同校验。
- 依赖：定义 schema version 与全局 request gate。
- 风险：ThreadingHTTPServer 在途连接、WAL/SHM、一半恢复状态。
- 回滚：保持 overwrite disabled，仅保留已验证 merge；数据库保护副本绝不自动删除。
- 验证：纯文本 DB、坏 schema、hash 不符、截断 ZIP、zip-slip、磁盘满、replace 前后故障注入；实机恢复期间并发读写必须得到 maintenance 响应，失败后 quick_check 和数据计数不变。

#### P0-02 记忆正文/哈希/向量一致性（3～5 人日）

- 文件/函数：`worker.py::create_memory` 去重合并分支、`update_memory`、`delete_memory`、`bulk_update_memories`、`bulk_delete_memories`、`search_memories`。
- 改动：统一 `MemoryIndexService`；正文/角色/category 改变时重算 semantic hash；同一事务删除旧 vec、写正文/hash，再写或标记待重建向量；批删按实际命中 ID 清 vec；增加 orphan/stale 检测与可恢复 rebuild action。
- 依赖：明确 embedding 失败策略（事务回滚或 `index_state=pending`）。
- 风险：vec0 与普通表跨步骤失败、历史脏索引。
- 回滚：先提供只读一致性报告与重建备份；新逻辑可关闭向量写并降级文本检索，不能回滚正文。
- 验证：更新新旧文本召回、旧 hash 不再命中、角色迁移、批删两种入口、向量异常注入、全库 rebuild 前后有效行数和抽样 top-k。

#### P0-03 自动分析完成契约与原子水位线（2～4 人日）

- 文件/函数：`worker.py::analyze_chat`；`features/auto_analysis.js`（由 `main.js`/`packages/memory_engine.js::triggerAnalysis` 抽取）。
- 改动：Worker 返回 `analyzed:true`、`extractedCount`、`acceptedCount`、`requestId`；0 条是明确成功；transport/parse/schema/write 任一失败均 `analyzed:false`。trigger 状态采用单 writer 或版本/CAS + 原子替换；失败保留水位线，记录 nextRetryAt 和有上限退避；同 chat 单飞、不同 chat 合并不互相覆盖。
- 依赖：P1-05 parser 可后续增强，但先定义契约。
- 风险：旧 trigger 文件兼容和重复分析。
- 回滚：保留旧字段读取；新 writer 双读单写，异常时宁可不推进。
- 验证：连接拒绝、超时、坏 JSON、成功 0 条、部分写失败、两个 chat 并发、同 chat 重入；实机断网恢复后失败批次能重试且不重复已成功批次。

#### P0-04 Worker supervisor 状态机与精确身份（8～12 人日）

- 文件/函数：新增 `shared/worker_runtime.js`；重构 `packages/memory_engine.js` lifecycle；改造 `start_worker.sh`、`worker.py::ping_worker/deploy_status/_find_worker_processes/main`；薄壳消费状态。
- 改动：落实第 6 节状态机；普通调用 fast-fail；显式 install/start/restart；attemptId/launchId/result；资源和依赖校验；精确 PID/starttime/path/port/db 身份；owner-aware lock；结构化 progress/diagnostic；清理旧 marker reconcile。
- 依赖：官方 terminal API 真机 capability probe；P0-05 health/API 基础字段。
- 风险与回滚：见第 6.5 节。
- 验证：10 并发 ensure 只有一次资源部署/terminal input/Worker；SIGTERM/SIGKILL、stale lock、terminal create/input 失败、端口被占、旧 Worker、半成品 venv、空 ROOT/DATA；其他项目 `worker.py` 不受影响；冷/暖启动 terminal 增量符合策略。

#### P0-05 Worker HTTP 与诊断安全边界（2～3 人日）

- 文件/函数：`worker.py::Handler`、`get_logs`、统一错误响应；Web API middleware。
- 改动：body 上限（建议普通 JSON 2 MiB，备份走文件路径而非大 body）；非法/负/超限 Content-Length 返回结构化 400/411/413；日志改固定枚举并 realpath 校验、输出限长与脱敏；只绑定 loopback；Web 写 API 加 session token、严格方法/Content-Type、无通配 CORS；错误不返回 traceback/密钥。
- 依赖：Web API 路径与 token 设计。
- 风险：现有 UI 依赖日志 path 字段。
- 回滚：保留日志类型到真实路径的服务端映射，不保留任意 path。
- 验证：`/etc/hostname`、`../`、symlink escape、超限/负长度、慢请求、无 token 写请求、跨域预检；Worker 内存和线程保持稳定。

### P1：结构升级与功能迁移

#### P1-01 薄入口与模块抽取（3～5 人日）

- 按第 5.1 节创建模块；`main.js` 只注册。
- 第一提交只搬代码与测试，不改行为；第二提交统一 engine client；第三提交切 supervisor；最后删除重复函数。
- 更新 `DEVELOPMENT_PLAN.md`、`docs/ARCHITECTURE_DESIGN.md` 和生命周期文档。
- 验证：manifest/subpackage 工具集合、hook id、route/navigation、CommonJS load；实机 prompt input/finalize、应用创建和侧栏入口。

#### P1-02 Worker 静态 Web/API 与 manifest resources（4～6 人日）

- 新增 `resources/webapp/`（或构建产物目录）、build manifest、打包内依赖；`manifest.json` 新增目录 resource。
- `shared/worker_runtime.js::prepareRuntimeResources()` 采用官方的 readResource → copy → stage unzip → verify → versioned atomic switch。
- `worker.py::Handler.do_GET()` 服务 `/ui/*` 与 `/healthz`；新增 `/api/v1/*` adapter 并复用 service/ACTIONS。
- 验证：离线安装不访问 CDN；路径穿越、cache/version、资源损坏、旧 Web/新 Worker 版本不匹配；真机 WebView JS、DOM storage、中文输入、前后台恢复。

#### P1-03 薄 Compose 壳与双轨开关（2～3 人日）

- 文件：新的 `ui/memory_system_ui/index.ui.js`；旧 `screen.js` 暂留为 legacy screen；`main.js` route 注册。
- 状态：progress、loading、error、diagnostic、serverUrl、reloadToken、Web page progress。
- 离线提供安装/重试/诊断；健康后 WebView。去掉任何 120 秒 action 保持。
- 验证：未部署、安装中、启动中、健康、降级、失败、页面加载错误、reload；退出页面后 timer/attempt 不回写已卸载壳。

#### P1-04 7 Tab 渐进迁移（12～20 人日）

- 顺序：概览 → 知识 → 时间线 → 待办 → 角色 → 设置 → 部署详情。
- 每页保持现有字段与操作契约，先复刻后优化；共享 Web API client、query cache、request generation、错误/空态、移动端导航和可访问性。
- 设置页 overwrite 在 P0-01 前不得启用；部署离线卡片不从 Compose 移除。
- 验证：每 Tab CRUD/筛选/空态/错误态；快速切换 50 次、连续操作、100 条列表、旧请求晚返回、角色切换；Web 与 legacy 对同一只读 fixture 截图/字段对照；真机不出现 ANR/闪退。

#### P1-05 LLM 响应解析与审计（3～4 人日）

- 文件/函数：`worker.py::_call_llm/analyze_chat`，建议抽 `llm_parser.py`。
- 严格 JSON 优先，随后 fenced block/raw_decode/平衡扫描；根对象和各分类数组 schema；item 类型/字段长度/数值归一；有限网络重试和最多一次格式修复；日志只记 requestId、阶段、长度/hash 与脱敏摘要。
- 依赖：P0-03 analyzed 契约。
- 回滚：解析失败不写库、不推进水位线；关闭修复请求仍可严格失败。
- 验证：多 JSON、前后解释、截断、字符串代替数组、非对象 item、超长字段、HTTP 429/5xx/IncompleteRead。

#### P1-06 小型状态文件原子化（2～3 人日）

- 文件/函数：`worker.py::save_ui_state/set_injection_settings`；注入 history 移入 Worker service，停止 `main.js` 直接覆盖。
- 同一 lock、同目录 tmp、flush/fsync、`os.replace`；parse 失败保留原件并写 `.corrupt` 诊断；可选 version/CAS。
- 验证：两个 writer 并发、kill 写入、坏 JSON、磁盘满；UI 与 injection 字段均不丢。

#### P1-07 CRUD 错误语义（1～2 人日）

- 文件/函数：`worker.py::delete_memory/update_memory/bulk_update_memories`。
- 初查/更新/回读统一 `is_deleted=0`；检查 rowcount；定义 `NOT_FOUND/ALREADY_DELETED/UNCHANGED`；批量计数按实际命中，不按输入长度。
- 验证：不存在、已删、重复删、批量混合 ID、并发删除/更新；Web 与 ToolPkg 展示一致。

### P2：正确性、运维与清理

#### P2-01 查询与截断正确性（1～2 人日）

- `list_memories()` 复用同一 filter builder 生成 rows/count；limit/offset 有类型与上限。
- `analyze_chat()` 按最终 12000 字预算取不重叠前后窗口，marker 计入预算。
- 测试 query/category/character/deleted 组合；长度 12000/12001/13000/20000/超长。

#### P2-02 日志、import 副作用与 schema 失败（2～4 人日）

- 日志统一 size-based rotation、有限份数、敏感字段脱敏；start/install/result 同样有 retention。
- Worker PID/probe 仅 HTTP server 启动时写，`import worker` 无线上副作用。
- 基础 DDL 失败记录语句标识并阻断启动；只有 vec0 可降级。
- 验证：日志越阈轮转、磁盘满、import 不写、基础表建表失败、vec 扩展缺失仍进入 DEGRADED。

#### P2-03 遗留 UI、文档与发布洁净度（1～2 人日）

- 产品确认 `messages.js/currentTab=99` 与未注册 messages/contacts 代码去留；不使用则删除 require、state 和分支。
- 删除未跟踪根 `deploy.js`/`memory_engine.js`；CI 检查工作树/包内容、manifest resource 与 entry。
- 修正 `main.js`、`start_worker.sh`、`ARCHITECTURE_DESIGN.md` 中“一次性 CLI”“hiddenExec 提交”“旧 venv”等过时描述。
- 重大架构变化同步 `DEVELOPMENT_PLAN.md`，记录 WebView/Worker ownership、数据边界和回滚开关。

## 9. 里程碑与依赖关系

| 里程碑 | 内容 | 依赖 | 预计 | 退出条件 |
|---|---|---|---:|---|
| M0 基线与契约 | 冻结 API/数据 fixture、定义 health/runtime/analyzed/error schema，建立只读一致性报告 | 无 | 1～2 人日 | 契约评审通过，旧 API fixture 固化 |
| M1 数据安全 | P0-01、P0-02、P0-03、P0-05 | M0 | 8～12 人日 | 恶意备份/索引/水位线/HTTP 安全门禁通过 |
| M2 生命周期与入口 | P0-04、P1-01 | M0；部分依赖 M1 health | 8～12 人日 | fresh install、start/restart、并发单飞、精确 identity 真机通过；main 薄化 |
| M3 Web 基础设施 | P1-02、P1-03、概览垂直切片 | M2 | 6～9 人日 | 离线资源 + WebView + API + 回滚开关真机通过 |
| M4 业务 UI 迁移 | P1-04 七 Tab | M1、M3 | 12～20 人日 | 7 Tab 功能对等、快速操作无 ANR、legacy 可切回 |
| M5 历史审计收口 | P1-05/06/07、P2-01/02/03 | M1～M4 | 7～11 人日 | 20 项全部变为已修或有明确接受风险 |
| M6 灰度发布 | 双轨灰度、指标、文档、清理旧 UI 的决策 | M5 | 3～5 人日 | 至少一个版本稳定；满足删除 legacy 的门禁 |

主依赖链：

```text
契约 M0
  -> 数据/HTTP 安全 M1
  -> supervisor + 薄入口 M2
  -> Web host + 薄壳 M3
  -> 7 Tab 迁移 M4
  -> 历史项收口 M5
  -> 灰度与旧 UI 下线 M6
```

总量估计：**35～50 人日**。若只完成“安全地基 + 概览垂直切片”，约 **17～25 人日**；不建议在 P0 数据安全和 supervisor 未完成前直接全量重写 7 Tab。

## 10. 验证计划

### 10.1 自动化与静态门禁

- JS/TS module load、manifest/metadata/exports 集合一致、资源存在与 build manifest hash。
- Worker unit/integration：CRUD、hash/vector、backup/restore、parser、body limit、static path、API auth、runtime reducer。
- UI：Web component/API mock、request generation、分页/筛选、错误/空态；薄壳状态快照测试。
- shell：`bash -n`、锁/owner/identity 的隔离测试；不允许 `hiddenExec` 和宽泛 `*worker.py*` kill 模式。
- 测试改造后才运行 `import worker`：必须先消除 import 写 PID/probe 的副作用。

### 10.2 必做实机矩阵

1. **从零安装**：专用测试设备清空 CME runtime/data 后，从 ToolPkg resource 开始；一次点击安装，资源、venv、三依赖、Worker、Web build、向量全绿。
2. **冷/暖启动**：冷启动立即进入、等待 10 秒进入、后台恢复、划掉 App 后重进，各 20 轮；`application_on_create` terminal 增量必须为 0。
3. **故障注入**：terminal create/input 失败、安装断网/429、半成品 venv、缺模型、旧 resource、端口 8765 被占、stale lock/marker、Worker 启动后立即崩溃。
4. **并发与身份**：10 个并发 ensure/start/restart；只能有一个 attempt/launch/Worker；其他路径同名 `worker.py` 进程保持不变。
5. **WebView**：7 Tab 中文输入、滚动、筛选、连续删除、快速切换 50 次、前后台切换、WebView reload、资源升级；无 ANR、闪退、白屏和旧回调覆盖。
6. **数据正确性**：更新/批删后 hash/vector 一致；自动分析失败后网络恢复可重试；成功 0 条推进；跨角色不串数据。
7. **备份恢复**：合法 merge/overwrite、坏 ZIP/DB/schema/hash、恢复时并发请求、故障自动回滚；活动库 quick_check 始终为 ok。
8. **安全**：任意日志路径、静态路径穿越、无 token 写 API、超限 body、跨域页面访问均被拒绝。

### 10.3 建议指标与验收阈值

- Worker 已健康时 Web 首屏可交互 p95 ≤ 1.5 秒；Worker 冷启动但依赖齐全 p95 ≤ 12 秒。
- 普通业务在 Worker 离线时 p95 ≤ 2 秒、硬上限 ≤ 3 秒，且 terminal attempt 为 0。
- 同一 install/start/restart 并发 10 次：terminal submit = 1、launchId = 1、Worker = 1。
- 7 Tab 快速切换/连续操作测试：0 ANR、0 crash、0 重复写、0 旧请求回写新角色。
- 日志与状态文件大小有明确上限；连续 24 小时压力后不无限增长。
- DB quick_check、memory/hash/vector 一致性、备份摘要门禁全部通过。

## 11. 回滚总策略

1. UI 使用双轨开关；WebView 出现设备兼容问题时只切回 legacy Compose，不回滚 Worker 数据结构。
2. Web assets 版本目录化，runtime 记录 last-known-good build；资源升级失败保持上一版本。
3. Worker API 先增量新增 v1，再迁客户端；旧 POST action 至少保留一个发布周期。
4. 数据迁移前自动一致性备份；数据库变更只前向、幂等，回滚应用代码不得降级 schema。
5. supervisor 失败回到 health-only + 显式手动恢复；绝不恢复 hiddenExec、隐式普通业务拉起或宽泛 kill。
6. overwrite restore 在安全闭环完成前保持禁用；这是可接受的功能降级，不以数据安全换功能完整。

## 12. 完成定义

- `main.js` 只剩注册与 hook 接线，生命周期、分析、注入和诊断均有独立模块与测试。
- Compose 层只负责 Worker 生命周期/恢复和 WebView；不再用 120 秒 action 窗口承载业务 UI。
- Worker 同一端口安全提供 health、版本化静态资源、Web API 与旧 ToolPkg action 兼容面；无 Node 运行时依赖。
- 从零安装、启动、降级、失败、restart 均由唯一状态机解释，返回结构化诊断；普通业务不隐式启动。
- 历史审计 20 项全部修复，或经书面风险接受且有隔离/回滚；P0-3、P1-1/2、P1-7、P2-8 不允许以“接受风险”关闭。
- 7 个正式 Tab 在真机功能对等，快速切换与连续操作无 ANR/闪退；部署离线恢复不依赖 Worker 网页。
- 根目录孤儿 `deploy.js`、`memory_engine.js` 不进入版本库/发布包；manifest resources、subpackage 和实际包内容可自动核验。
- `DEVELOPMENT_PLAN.md` 与架构文档同步反映最终 ownership、状态机、WebView、API、安全和回滚边界。

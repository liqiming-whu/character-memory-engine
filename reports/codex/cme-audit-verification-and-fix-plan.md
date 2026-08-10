# CME 审计核验与统一修复计划

- 核验日期：2026-08-10
- 当前源码提交：`761f74fd9d8f7e6752838761552baae5fb612545`
- 待核验报告：`reports/codex/input/CME_CODE_AUDIT_REPORT_2026-08-10.md`（报告审计提交为 `2cf5a1a`）
- 合并计划：`reports/codex/cme-session-leak-implementation-plan.md`（计划记录的 CME 提交为 `e1d7061`）
- 核验范围：当前 CME 源码；未读取、未逆向 `/root/operit` 或 `/root/OperitTerminalCore`
- 判定口径：`属实`=当前源码可直接证明；`部分属实`=源码事实成立但部分后果依赖宿主或运行态；`不属实`=与当前源码冲突；`无法验证`=本轮输入不足以复核动态/实机证据。

## 一、结论摘要

审计报告列出的 20 项 P0/P1/P2 问题，在当前源码中的问题主体没有发现“不属实”项：19 项可由 CME 源码直接确认，P1-5 的“存在串行队列但大量子页绕过队列”可确认，但“Operit bridge 必然响应错配”属于宿主侧后果，本轮只能判为部分属实。

报告的源码行号整体仍可定位，但报告、session-leak 计划与当前检出是三个不同提交，部分行号已有 1～数行偏移。后续提交说明应使用“函数/符号名 + 新行号”，不能继续把旧行号当稳定标识。

审计报告中的实机状态、线上日志、隔离动态复现输出和日志目录体积，本轮未重跑，因此这些证据本身为“无法验证”；它们不影响下表中可由当前源码确定的缺陷结论。

统一排序采用“取更高风险”的规则：session leak 计划要求立即止血的普通业务自动拉起、`start_worker.sh` 资源缺失等，分别从原审计 P2/P1 提升为统一 P0；启动脚本广域杀进程从原审计 P2 提升为统一 P1。

## 二、任务一：逐项核验

### P0

| 审计项 | 判定 | 当前源码证据与行号核对 |
|---|---|---|
| P0-1 角色页渲染期异常 | 属实 | `ui/memory_system_ui/tabs/character.js:47-56` 在 `screenFiltered.length > 0` 时读取 `localChangeState[0]`，变量到 `:80` 才执行 `ctx.useState(...)`。`var` 声明提升但赋值不提升，故该分支可确定抛出 TypeError。报告的 `35-57/81` 与当前行号略有偏移，但根因准确。该 render 还在 `:34-35,59-61,92-112` 直接写状态。 |
| P0-2 自动分析失败仍推进水位线 | 属实 | `packages/memory_engine.js:762-763` 得到 `r/rOk`；`:764-779` 不以 `rOk` 为条件，仍将 `maxTs` 写入 `watermarks[chatId]`，并仅用 `lastResult` 区分成功/失败。下次筛选依据 `:726-730` 的水位线，失败批次会被跳过。报告行号 `761-789` 与当前一致。报告引用的实际失败日志本轮未复核。 |
| P0-3 无效备份可通过校验并覆盖数据库 | 属实 | `worker.py:1602-1625` 只检查 manifest 格式/版本和 `engine.db` 是否存在，未打开 SQLite、未 quick_check、未校验表/字段/摘要；`:1648-1679` 的 overwrite 仅受 `_RESTORE_LOCK` 包围，关闭当前连接后直接 `shutil.copy`；`:1801,1874` 显示该锁为进程锁且服务为 `ThreadingHTTPServer`，不能冻结其他已进入请求。报告行号较当前约偏 1 行，根因准确。动态恶意 ZIP 复现本轮未重跑。 |

### P1

| 审计项 | 判定 | 当前源码证据与行号核对 |
|---|---|---|
| P1-1 普通更新不刷新语义哈希和向量 | 属实 | `worker.py:689-720` 的 `update_memory()` 只更新正文等字段和 `updated_at`，没有重算 `semantic_hash()`，也没有更新 `vec_items`。对照 `create_memory()` 的 `:605-608,641-649,674-682` 可见新建/去重路径才维护哈希或向量。报告 `690-721` 约偏 1 行。 |
| P1-2 批量删除不清向量 | 属实 | 单删在 `worker.py:723-731` 删除 `vec_items`；批删 `:770-791` 只更新 `is_deleted`，两条分支均未删除向量。报告 `771-792` 约偏 1 行。 |
| P1-3 在线 `deploy_restart` 没有真正重启 | 属实 | `packages/memory_engine.js:892-896` 调用 `ensureWorkerUp(true)`；但 `ensureWorkerUp()` 在 `:318-321` 对在线 ping 无条件返回 `alreadyUp`，没有检查 `force`。虽然 `force` 在 `:310,331` 被用于绕过保护窗/租约，它到不了这些分支。报告根因及行号准确。 |
| P1-4 fresh install 缺 `start_worker.sh` 资源链 | 属实 | `manifest.json:46-71` 仅注册 worker/embed/model；`main.js:256-276` 与 `packages/memory_engine.js:233-264` 只读取这些资源；两处启动命令分别为 `main.js:330`、`packages/memory_engine.js:345`，均直接依赖 `/root/character_memory_engine/start_worker.sh`。脚本 `start_worker.sh:41-44` 只能在已经被执行后从 DATA_DIR 自同步，无法解决首次引导。 |
| P1-5 UI 全局串行 bridge 只覆盖部分调用 | 部分属实 | `screen.js:175-183` 定义 `serialCall`，但 `character.js:124,301,356`、`messages.js:71,116,153,241,343,460`、`deploy.js:37,61,86,108,130`、`todos.js:32,47` 仍直接 `ctx.callTool`。`character.js:120-131` 的 Promise.race 也只结束本地等待。是否必然发生“响应错配”及底层取消语义需 Operit 运行态/上游源码证明，本轮不验证。报告位置总体准确。 |
| P1-6 render 中直接产生副作用 | 属实 | `character.js:34-35,50-63,92-112` 在 render 写 state；`messages.js:65-93` 在 render 启动异步调用，`:537-542` 在渲染末项时调度加载；`screen.js:186-196` 在初始化 render 写状态并启动定时链，其他调度点可见 `:211,259,319,343,362` 等。具体 ANR 历史属于运行态证据，本轮未复核。 |
| P1-7 `get_logs(path)` 任意文本读取 | 属实 | `worker.py:982-1006` 直接采用 `params.path`，随后 `os.path.exists(path)` 和 `open(path)`，没有枚举白名单或 `realpath` 目录边界。报告行号准确；`/etc/hostname` 动态复现本轮未重跑。 |
| P1-8 LLM JSON 解析与校验不足 | 属实 | `worker.py:1341-1378` 单次请求后用贪婪正则 `\{[\s\S]*\}` 和一次 `json.loads`；`:1425-1453` 无网络/解析修复重试、无根对象/分类数组 schema 校验，`:1436-1437` 直接遍历并 `dict(item)`。报告行号较当前约偏 1 行，根因准确。 |

### P2

| 审计项 | 判定 | 当前源码证据与行号核对 |
|---|---|---|
| P2-1 长对话截断扩增/重复 | 属实 | `worker.py:1393-1395` 在长度大于 12000 时保留前后各 10000；对 12001～19999 长度输入必有重叠，且注释称“各 6000”与实现不符。报告行号约偏 1 行。 |
| P2-2 列表 `total` 忽略 `query` | 属实 | 列表 SQL 在 `worker.py:569-572` 加 LIKE；计数 SQL `:577-583` 只拼 deleted/character/category，未拼 query。报告行号准确。 |
| P2-3 删除不存在 ID 仍成功 | 属实 | `worker.py:723-732` 不检查 UPDATE 的 `rowcount`，总是返回 `success: True`。报告行号约偏 1 行。 |
| P2-4 更新已软删记忆仍成功 | 属实 | `worker.py:691` 的初查不筛 `is_deleted`；`:703-717` 的 UPDATE 才限制 `is_deleted=0`，且未检查 rowcount；`:719-720` 又无条件查询并返回成功。报告行号约偏 1 行。 |
| P2-5 共享 UI 配置非原子写 | 属实 | `worker.py:1227-1261` 与 `:1273-1301` 分别对同一 `last_ui_state.json` 做无共享锁的读改写并直接 `open(...,"w")`；解析失败会回落空对象。`main.js:393-403` 的 injection history 也直接覆盖。报告位置基本准确。 |
| P2-6 启动/诊断按 `worker.py` 子串宽匹配 | 属实 | `start_worker.sh:50-62` 的 PID 文件与 `/proc` 兜底均只用 `*worker.py*`；`worker.py:1010-1040` 的查找也仅约束 python + worker.py，`worker.py:1215-1223` 会据此 kill。报告只列脚本 `57-61`，但实际宽匹配还包括 `:53-55`。 |
| P2-7 所有业务失败都尝试拉起 Worker | 属实 | `packages/memory_engine.js:444-453` 只要第一次 `httpCall` 未返回 `success=true`，无论业务错误还是 transport 错误都会 `ensureWorkerUp()` 并可能重放业务请求。报告行号准确。 |
| P2-8 HTTP 请求体无大小限制 | 属实 | `worker.py:1768-1775` 信任 `Content-Length` 并一次性 `read(length)`，没有上限或 413 分支。报告行号约偏 1～2 行。 |
| P2-9 日志永久追加、无轮转 | 属实 | `worker.py:116-122` 以 append 写 `engine.log`；`main.js:41-53`、`packages/memory_engine.js:146-156,856-868` 也持续追加或退化为全量读后覆盖。项目未见 `RotatingFileHandler/maxBytes/backupCount` 等轮转实现。报告中的“约 1.2 MiB”运行时体积本轮无法验证。 |

### 其他维护观察

| 报告观察 | 判定 | 当前源码证据 |
|---|---|---|
| `worker.py` import 阶段有线上副作用 | 属实 | `worker.py:31-46` 在模块加载时写固定的 cold probe 和 `/root/character_memory_engine/worker.pid`，不要求进入 `main()`。测试 import 确有覆盖运行 PID 文件的风险。 |
| `main.js` 启动架构注释过时 | 属实 | `main.js:13-15` 仍称“Worker 不常驻、一次性进程”，而 `:632-685` 和当前 HTTP health/launcher 明确采用常驻 Worker。 |
| 基础 DDL 失败被吞掉 | 属实 | `worker.py:225-230` 对每条基础 SCHEMA 语句 catch 后仅 rollback，不记录 SQL/异常，也不终止启动；只有 vec0 才应是可选降级。 |
| 输入参数缺少统一边界校验 | 属实 | 例如 `worker.py:553-554,987` 直接 `int(...)`，未统一限制负数、上限或错误类型；同类模式散布多个 action。 |

### 补充：session leak 计划的 CME 侧前提核对

session-leak 实施计划明确写明“尚未实施”，当前源码也印证这一点：

- `main.js:58-94` 和 `packages/memory_engine.js:391-412` 仍保留 fresh executor key、JS Promise race 和 hiddenExec 二次重试。
- `main.js:632-685` 的 application-create 仍部署资源、检查版本、调用 hiddenExec kill 并进入 `ensureWorkerUp()`，不是 health-only。
- `main.js:287-361` 与 `packages/memory_engine.js:302-376` 仍各有一套 launcher；租约仍为先读后写文件，不是原子 single-flight。
- `packages/memory_engine.js:444-453` 的普通业务仍会自动拉起并重放。
- `start_worker.sh:19-25` 的 mkdir 锁无 owner 元数据，SIGKILL 后可能遗留；`:50-62` 仍广域匹配并 kill。
- `manifest.json:46-71` 仍未注册 `start_worker.sh`；仓库中也没有计划要求的 `packages/worker_supervisor.js`。

上游的 create-cleanup、完整 deadline 和 persistent owner registry 根因/行号，本轮遵照范围要求未读取 Operit 源码，故统一计划仅继承已有文档的责任边界和待上游验证/实施状态，不重新声称已验证。

## 三、任务二：统一修复计划

### 计划原则

1. 先完成 CME containment，再恢复显式启动；Phase 0 和 Phase 1 必须分开发版、分开验收。
2. P0/P1/P2 是最终执行优先级，不机械沿用原审计等级；同一问题在 session leak 计划中风险更高时取更高等级。
3. application-create 永久 health-only；普通业务不启动 Worker；Phase 1 只恢复用户显式 start/restart。
4. Phase 1 persistent terminal 失败不得 fallback 到 hiddenExec；HTTP health 是 Worker ready 的最终真值。
5. CME 只清理能够用持久 registry 精确证明归属的 visible session/attempt/Worker；不扫描或清理未知 hidden orphan，不模糊杀进程。
6. 涉及数据模型/Worker 生命周期的重大变更同步更新 `DEVELOPMENT_PLAN.md`。

### P0 紧急

| ID | 修复项与交付内容 | 责任方 | 依赖 | 验收要点 |
|---|---|---|---|---|
| P0-C1 | application-create 改为短 HTTP health-only；删除该路径的部署、版本 kill、terminal、自动启动和定时自愈。 | CME 侧 | 无；不等待上游 | 冷/暖启动各 20 次，terminal 调用增量为 0；离线只记录 `WORKER_OFFLINE`。 |
| P0-C2 | `run()` 区分 transport offline、Worker 业务错误和协议错误；普通业务只请求一次，离线快速失败，业务错误原样返回，不启动、不重放。 | CME 侧 | 与 P0-C1 共用错误模型 | offline p95 ≤2 秒、硬上限 ≤3 秒；注入 `INVALID_ARGUMENT` 时 launcher=0、请求数=1。 |
| P0-C3 | 从生产路径删除 hiddenExec、fresh key、二次 retry、60 秒自动清 broken；合并双 launcher，新增唯一 `worker_supervisor.js` 和进程内 active Promise single-flight。Phase 0 的 `start/restart` 明确返回 `WORKER_RECOVERY_DISABLED`。 | CME 侧 | P0-C1、P0-C2 | 生产文件无 hiddenExec；10 个并发 start 只有一个 fake attempt；异常后锁释放。 |
| P0-C4 | 将 `start_worker.sh` 注册为 manifest resource，建立可校验的 DATA_DIR/ROOT_DIR 准备函数；只供显式安装/Phase 1 使用，不在 onAppCreate 执行。 | CME 侧 | P0-C3 的 supervisor 接口 | fresh package 能读出脚本；空 ROOT_DIR 的资源来源可追踪。 |
| P0-C5 | 修复自动分析水位线：仅在 Worker 明确 `analyzed=true` 时推进；0 条提取是成功；失败保留原水位线并记录错误/次数/有限退避；水位线写入采用合并写或单写者。 | CME 侧 | 先定义 Worker `analyzed` 契约；与 P1-C6 parser 可并行 | 连接拒绝、超时、坏 JSON 均不推进；成功 0 条推进；并发完成不覆盖别的 chat 水位线。 |
| P0-C6 | 暂停 overwrite restore；随后实现临时解压、manifest 摘要、SQLite 只读 quick_check、必需 schema 校验、全局维护门、同目录原子替换、替换后复检和自动回滚。 | CME 侧 | 数据库维护锁设计；恢复期间统一请求门 | 纯文本/坏 schema/摘要不符均拒绝且活动库不变；故障注入后可自动恢复保护副本。 |
| P0-C7 | 调整 `localChangeState` 初始化顺序，并移除角色页 render 中的 setState；增加有角色快照的最小渲染测试。 | CME 侧 | 无 | 一条角色记忆输入不抛异常；重复 render 不产生状态写或工具调用。 |
| P0-U1 | 修复 hidden shell create/ready 失败时直接关闭尚未移交 Map 的局部 shell/process。 | Operit 上游 | 上游复核现行 HEAD 后实施；不阻塞 P0-C1～C7 | 100 次 start 后/ready 前故障注入，shell/process count 不增长。 |

### P1 重要

| ID | 修复项与交付内容 | 责任方 | 依赖 | 验收要点 |
|---|---|---|---|---|
| P1-C1 | Phase 1 显式 recovery：supervisor 状态机、owner-qualified visible persistent control session、nonce probe、精确 known-session reconcile、单次 input 投递、结构化 launch result + matching launchId + HTTP health。 | CME 侧 | 全部 P0 containment；真机 persistent-terminal probe；P0-C4 | offline→显式 start 真机闭环通过；10 并发仅 1 attempt/launch/input/Worker；unknown same-title session 零 close/零 input。 |
| P1-C2 | 加固 `start_worker.sh`：按环境 gate 选择 `flock` 或 owner-aware mkdir；结果文件记录阶段；Worker identity 包含 PID/starttime/完整路径/port/db/launchId；删除 `*worker.py*` 广域 kill。 | CME 侧 | P1-C1 的 attempt/launch/owner schema | SIGTERM/SIGKILL 后锁可恢复；restart 只停止精确旧 Worker；其他项目 worker 零影响。 |
| P1-C3 | 修复 restart 语义：显式 restart 先精确热备/停止旧身份，再启动新身份；force 不得被在线 health 提前返回；验证 PID/starttime/launchId 变化。 | CME 侧 | P1-C1、P1-C2 | UI 返回成功时旧身份已退出、新 launchId 已 HTTP ready。 |
| P1-C4 | 更新记忆时在同一事务语义中同步正文、`semantic_hash` 和向量；向量失败要有可恢复状态/重建路径。 | CME 侧 | 明确嵌入失败策略 | 更新后新文本可召回，旧文本不再去重命中；事务故障不留下正文/哈希不一致。 |
| P1-C5 | 批量删除同步删除 vec rowid；增加孤立向量一致性检查和安全重建工具。 | CME 侧 | 可与 P1-C4 共用索引维护服务 | IDs/条件批删后均无对应向量；重建前后有效记忆数一致。 |
| P1-C6 | 重写 LLM 返回解析：有限网络重试、严格 JSON/fence/raw_decode、schema 校验与字段归一、可选一次 JSON 修复、脱敏错误阶段/请求 ID。 | CME 侧 | P0-C5 的成功契约 | 多对象、截断、数组/字符串错型均明确失败或安全修复；不按字符写入记忆；重试有上限。 |
| P1-C7 | 统一 UI bridge 调用入口，所有依赖返回值的 Tab 调用进入同一队列并校验响应；日志限频/低优先级；用 generation token 丢弃旧实例结果。 | CME 侧 | 需在目标 Operit 版本做集成测试 | 并发点击/超时/切页不重复提交，不让旧回调更新新页面；关键响应字段匹配。 |
| P1-C8 | 清理全部 render 副作用：加载放根 onLoad，交互放 action，滚动加载做显式事件；取消/失效旧 timer 和请求结果。 | CME 侧 | 建议与 P1-C7 同批 UI 重构 | render 多次调用不发起 callTool/setTimeout/setState；卸载后不回写。 |
| P1-C9 | 将 `get_logs(path)` 改为固定日志类型枚举，或限定 realpath 在 `DATA_DIR/logs`；对输出做大小上限和脱敏。 | CME 侧 | 无 | `/etc/hostname`、`../`、symlink escape 均拒绝。 |
| P1-U1 | 统一 hiddenExec monotonic deadline，覆盖 init/create/ready/command/cancel/cleanup；timeout 返回前 native 工作已停止或进入有界可查询 closing。 | Operit 上游 | P0-U1；兼容性评审 | 各阶段注入延迟时总耗时 ≤ timeout + cleanup grace；timeout 后 PGID 在 grace 内消失。 |

### P2 一般

| ID | 修复项与交付内容 | 责任方 | 依赖 | 验收要点 |
|---|---|---|---|---|
| P2-C1 | 长对话按最终总预算截断，前后窗口不重叠，注释与实现一致。 | CME 侧 | 与 P1-C6 prompt 测试可合并 | 覆盖 12000/12001/13000/20000/超长输入，输出不超过预算、不重复。 |
| P2-C2 | 列表 count 复用与结果 SQL 相同的 filter builder，把 query/character/category/deleted 全部纳入。 | CME 侧 | 无 | 多组合筛选下 `total` 与完整结果数一致。 |
| P2-C3 | delete/update 检查 rowcount；不存在、已删除与幂等删除使用明确 code；初查/回读统一 `is_deleted=0`。 | CME 侧 | API 错误码约定 | 不存在和已删不会伪报“已更新”；UI 可区分 not-found/unchanged。 |
| P2-C4 | `last_ui_state.json` 和 injection history 使用同一进程锁、同目录临时文件、flush/fsync + replace；解析失败保留原件，可选版本号 CAS。 | CME 侧 | 若 Tools.Files 原子替换能力不明，Worker 内 Python 路径先实现 | 并发写不丢字段；写中断后旧文件仍可解析。 |
| P2-C5 | HTTP body 设置 2～8 MiB 的明确上限，非法/负 Content-Length 与超限返回 400/413 结构化错误。 | CME 侧 | 确定备份/API 最大合法 payload | 超限请求不分配声明大小内存且 Worker 保持可用。 |
| P2-C6 | engine/dbg/ui/start 日志按大小轮转、有限保留并脱敏；稳定版降低 debug 量。 | CME 侧 | P1-C9 的日志枚举 | 超阈值自动轮转，份数受限，UI 仍能读取允许的最新日志。 |
| P2-C7 | 将 PID/probe 写入移到 `main()` 服务启动分支，保证 import 无线上副作用；修正 `main.js` 过时 CLI 注释。 | CME 侧 | 无 | 隔离测试 import `worker` 不写线上 PID/probe；启动服务仍按预期记录身份。 |
| P2-C8 | 基础 schema DDL 失败记录具体语句并阻断启动，仅 vec0 允许降级；增加统一参数校验器限制 limit/offset/字符串长度与类型。 | CME 侧 | 与数据库迁移/HTTP 错误码约定协调 | 基础表故障启动失败且可诊断；超界和错型输入返回结构化 4xx/业务错误。 |
| P2-U1 | persistent hidden owner registry + startup reconcile，只按 trusted owner 记录精确清 stale owner，不扫描 legacy orphan。 | Operit 上游 | P0-U1、P1-U1；trusted owner provenance 设计 | App kill -9/restart 后已登记 stale owner 被精确回收；PID reuse、其他 ToolPkg、visible/SSH 零误杀。 |

## 四、建议交付顺序与依赖主线

1. **CME Hotfix 1（P0-C5、P0-C7）**：先止住记忆丢失与角色页确定崩溃，改动面较小，可独立发布。
2. **CME Hotfix 2（P0-C1～P0-C4）**：完成 session-leak containment 和 safe-off；发布说明明确 Worker 离线不会自动恢复。
3. **CME Hotfix 3（P0-C6）**：先禁用 overwrite，再交付安全恢复闭环。
4. **Operit 上游并行线（P0-U1 → P1-U1 → P2-U1）**：不作为 CME containment 的前置条件；每阶段需由上游自行复核 HEAD 和设备测试。
5. **CME Recovery（P1-C1～P1-C3）**：仅在 Phase 0 全部门禁、脚本 resource fresh-install、persistent terminal 真机 probe 通过后启用。
6. **数据一致性（P1-C4、P1-C5）**：共用索引维护层和迁移/重建工具。
7. **解析与 UI 稳定性（P1-C6～P1-C9）**：其中 P1-C6 同时支撑 P0-C5 的自动分析可靠性；P1-C7/C8 应同一重构批次。
8. **P2 正确性与运维项**：在 P0/P1 门禁稳定后依次收尾。

## 五、统一完成定义

- 自动分析失败不推进水位线；成功 0 条有明确契约；不存在并发覆盖别的 chat 水位线。
- 非 SQLite/坏 schema/摘要不符备份无法覆盖活动库；恢复失败自动回滚。
- 角色页与主要 Tab 的 render 无工具调用、timer 或 state 写副作用。
- 正文、semantic hash、向量对 create/update/delete/bulk delete 保持一致。
- CME application-create 永久 health-only；普通业务离线不启动、不重放。
- CME 生产 Worker 生命周期没有 hiddenExec、fresh key、自动 retry 或定时自愈。
- 显式 recovery 只有一个 attempt/launch/control session/Worker，且只处理 CME 可证明拥有的资源；回滚只回到 Phase 0 safe-off。
- restart 成功必须证明旧/new Worker 身份变化并通过 matching launch result + HTTP health。
- 上游 create failure、deadline、owner registry 各自具备故障注入测试；未知 legacy orphan、其他 ToolPkg、visible terminal、SSH 和用户 shell均不被清理。
- 对上述每项新增自动化或真机门禁，并更新 `DEVELOPMENT_PLAN.md`、README 的生命周期与安全边界说明。

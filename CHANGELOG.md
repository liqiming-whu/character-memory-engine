# Changelog
## v2.4.1（2026-08-09，onAppCreate 预热链路修复——withTimeout 未定义）
### 修复：main.js 引用未定义 withTimeout → onAppCreate 自动预热从未生效
- **现象**：恢复 DISABLE_APP_CREATE_LAUNCH=0 后 engine.log 报 `onAppCreate: worker 未就绪: 提交 worker 启动失败: 'withTimeout' is not defined`
- **根因**：v2.4.0 重构 ensureWorkerUp/pollWorkerReady 时引入 `withTimeout` 调用（health 先检/提交/轮询共 3 处），但 main.js 只定义了 `withRace`（功能等价、名字不同），未定义 `withTimeout`。memory_engine.js 有自己的 withTimeout 定义所以 UI 路径正常；main.js 的 onAppCreate 路径每次执行：health 先检抛错被 catch 吞掉 → 误判 worker 不在线 → 提交必失败 → 删租约 + 写 30s BLOCK。DISABLE_APP_CREATE_LAUNCH=1 归因实验期间该路径从未执行，缺陷被掩盖，恢复后首曝
- **修复**：main.js 补 `withTimeout`（与 memory_engine.js 同实现，Promise.race + finally 清 timer）
- **验证**：重启 app → onAppCreate 10.1s 到点 → T1(source=onAppCreate) → 提交 1.25s → T6 就绪 3.0s → 用户进 CME health 直过（T7 无第二条 T1，秒开无卡顿）；cold_probe 单条 T1、start_worker.log 单条 begin+launched、pid 唯一、engine.log 零 WARN
## v2.4.0（2026-08-09，冷启动加固——启动脚本异步化+原子单飞+探针升级）
### 修复：hiddenExec 同步执行重型启动脚本 → 冷启动阻塞平台工具通道 30-35s → UI 卡死闪退
- **根因链**（源码 + 实测实锤）：双入口（main.js onAppCreate / memory_engine.js UI 路径）各自 ensureWorkerUp → freshKey 换 key → 并发 hiddenExec 提交完整重脚本（/proc 遍历 kill 旧 worker、cp models、sync_db）→ 同 executorKey 常驻 shell mutex 串行 + wait $pid → 平台工具通道被占 30s+ → UI 卡死闪退；双入口无有效互斥 → 互相 kill 新起的 worker
- **修复**：
  - P0 hiddenExec 轻提交：只提交 `nohup setsid bash start_worker.sh &`（毫秒级），重活全部移入 start_worker.sh 后台执行
  - start_worker.sh：`mkdir /tmp/cme_start_worker.lock` 原子互斥（双提交第二个立即退出）+ 三路 stdio 完全脱离 + LAUNCH_ID 透传
  - P1 原子单飞：JS 层 launch_lease.json 租约软裁决（launchId/source/createdAt/expiresAt=90s）+ shell 层原子互斥兜底，双入口统一 health 先检 → 租约 → 轻提交 → pollWorkerReady 轮询（T6，1.5s×45s）
  - 探针升级：T1 带 launchId/source、新增 T3（脚本内）/T6（health）；worker.py v2.1.8（LAUNCH_ID 透传 + worker.pid 落盘）
  - onAppCreate 实验开关 DISABLE_APP_CREATE_LAUNCH（归因实验用）
- **验证**：T1→T2 从数秒/冷启动 30s+ 缩短至 0.5s；双提交被 shell 原子互斥拦截（start_worker.log "another instance running, exit"）；worker pid 唯一无二次替换；实机冷启动/暖启动多次验收通过
## v2.3.3（2026-08-09，渲染风暴时间闸修复——前端卡死闪退）
### 修复：角色页/知识页渲染闭包调度无节流 → 渲染风暴 → ANR 闪退（app 被杀连带 worker）
- **现象**：侧边栏打开后前端卡死闪退；重启 app 卡顿不消失（旧代码风暴每次打开必复现，代码级）；卡死瞬间无日志（JS 线程被占满写不出）
- **证据链**（dbg_ui.log 实锤）：00:59 段 13 秒 93 次渲染（r=20→113）；01:25:44-48 五秒内 loadPersona 触发 10 次、list_memories 调用 10 次；01:26-01:27 analyze_chat 两次 52-63s（LLM 流中断 IncompleteRead）期间 loadData 延迟 40s → 主线程堆积
- **根因**：screen.js 渲染闭包内调度分支仅靠 useRef 防同帧（currentTab===4 分支），未命中缓存路径每次渲染都触发 loadScreenPersona → setState → 再渲染 → 再触发（渲染-调度循环）；v2.3.2 的 120s onLoad 窗口把风暴渲染全部推送到平台主线程（此前 600ms 窗口大多丢弃）→ 渲染过载 + 工具调用排队 → ANR → app 被杀 → proot/worker 连带死亡
- **修复**：角色页（tab4）/知识页（tab3）渲染闭包调度加 5s 时间闸（characterLoadAtRef/memoryLoadAtRef），ref 防重入 + 时间闸阻断循环
- **验证**：实机角色页停留 98 秒——loadPersona 触发间隔 8s/79s/10s（全部 ≥5s 闸值），触发密度较崩溃段下降一个数量级，渲染节奏正常，卡顿消失
## v2.3.2（2026-08-08，ANR 闪退修复 + 项目 venv 改造）
### 修复：worker 离线时 32s 探测阻塞 → UI 卡死 / Operit 闪退
- **现象**：实机两次卡住 + app 闪退；`dbg_call.log` 实测 `load_life_data ms=32218` / `save_ui_state ms=32271` / `list_memories ms=32128` 各卡 32s 后失败，误报「未找到可用的 python3」（实际 python 存在）
- **根因链**：① worker 绑定 proot 实例，proot 被平台回收时 worker 连带被杀（setsid 无效）② `detectPython` 用 hiddenExec 探测，proot 未就绪/会话失效时每候选卡 8s（失败漂移 key 重试 6s），4 候选 ≈32-48s ③ 32s 同步阻塞堵平台回调队列 → UI 卡死 → ANR → 闪退
- **修复**：`detectPython` 改用 `Tools.Files.exists(path, 'linux')` 毫秒级判存在，彻底移除 hiddenExec 探测路径；候选改为项目 venv → 旧全局 venv → 系统 python3
### 改造：依赖只装项目 venv（不再写入系统 python）
- `worker.py` 新增 `VENV_DIR`/`VENV_PY`（基于脚本目录 `.venv`）；`deploy_install` 重写为 `python3 -m venv` 创建 → venv 解释器 probe → venv 的 pip 安装（无 `--break-system-packages`）→ venv 内二次确认 → 提示重启 Worker
- `deploy_status` venv 检查优先报告项目 venv；所有手动启动命令/README 更新为 `/root/character_memory_engine/.venv/bin/python3.12`
- 实机验证：`deploy_install` 48s 创建 venv + 安装三依赖 PASS；项目 venv 重启 worker `vec_available: true` PASS
### 遗留
- 真机回归（重启 Operit 后验证快速失败路径）；任务②剩余项（worker 离线快速失败 / triggerAnalysis 就绪检查 / analyzeChat 失败推进水位线）

## v2.3.0（2026-08-08，渲染性能大修 + 删除链路最终闭环）
### 性能：渲染风暴 I/O 归零（dbgUi 限频 500ms，`89076ea`）
- **现象**：连续切 tab / 连续删除时 UI 卡死（实测 13 秒 21 次渲染，每次渲染发 1 次 log_ui 工具调用 + 1 次 setEnv，工具调用往返又触发状态变化 → 恶性循环）
- **根因**（对比 CMS v1.8.4 实证）：Operit 每次 setState 全量重绘本身不卡，卡的是渲染闭包内埋的 I/O（工具调用 + setEnv）——每次渲染 1 次工具调用是风暴放大器
- **修复**：dbgUi 工具调用与 env 环形缓冲均限频 500ms（渲染风暴时 ≤2 次/秒），关键事件日志能力保留
### 性能：loadData 300ms 防抖（`fc4e7b4`）
- 高频删除/勾选/切换时合并全量拉取，消除 Operit 全量重绘风暴（实测 1 分钟 45+ 次渲染导致 UI 卡顿）
### 性能：loadPersona 缓存命中 5 秒节流（`c419de9`）
- 连切角色页避免反复 setEnv/setState 开销
### 修复：删除链路本地即时移除 + loadMem 300ms 防抖（`220bf35`）
- `deleteItem`/`deleteMemory` 成功或失败都先本地移除该行——连点不再命中过期行报 memory not found（实测每个 id 被连点 4 次）
- `loadKnowledgeMemories` 加 300ms 防抖——连续删除合并刷新，消除 loadMem 排队 1-6 秒
- `dropMemoryFromCache` 修复为按 id 优先（原按 title 比较但调用传 id，not found 时删不掉）
### 修复：两段式确认用 useRef 做权威判断（`eeaec1d`）
- Operit 渲染器偶发不重绘导致 onClick 闭包读到旧 state，确认态丢失看起来像 UI 卡住；加 5 秒确认态超时防残留
### 修复：角色页防重入锁（`c107acf` → `d8f0bde` → `220d777`）
- 先按 id 精确拦截（修复全局 2 秒锁误拦快速点不同条目），后按用户要求整体移除并改两段式确认；补漏声明 `__cmeDeleteLockId`（严格模式 is not defined）
### 修复：空数据显示空态（`d8f0bde`）
- `loadForPersona` 区分「查询成功但为空」（显示 0 条）与「查询失败」（才显示读取失败 + 重试）
### 打包：修复 .toolpkg 缺 embed.py/models（2026-08-08）
- `debug_install_toolpkg` 目录打包漏 manifest resources 里的 python 资源（embed.py/models 不在包内，Operit 启动扫描报 `Cannot find resource path 'embed.py'`）
- 规范：手动 `zip -r 输出.toolpkg . -x '*.git*' -x '__pycache__/*' -x '*.pyc'` 打包，再 archive 方式烧录
### 下版本预告：v2.3.1 优先解决自动分析水位线问题
- 根因已实证：main.js onPromptFinalize 每次消息发送时整写 trigger.json（仅 5 字段）→ 清空 `watermarks`/`lastAnalyzedAt` → 水位线周期性丢失 → 打开插件时永远全量分析

## v2.2.2（2026-08-07，删除刷新根因闭环 + 全前端异步 action 规范修复）

### 修复：角色页删除记忆"要点两次才消失"（根因闭环）
- **现象**：点击删除后数据库删除成功、setState 已执行，但界面不刷新；需二次点击或退出重进才正确
- **根因**：删除按钮 `onClick: function() { deleteMemory(memory.id); }` 未返回 Promise——Operit action 分发器只在等待事件处理器返回的 Promise 期间订阅 stateChange；onClick 立即返回 undefined → action 窗口关闭 → `await ctx.callTool` 之后的 setState 只写 state store、不触发 recomposition
- **修复**（一行）：`onClick: function() { return deleteMemory(memory.id); }`，把 Promise 返回给分发器，渲染窗口保持到异步完成
- **对照证据**：创建按钮 `onClick: createMemory`（直接传引用，自然返回 Promise）一直正常；实验 6 模拟删除（跳过工具调用、全程同步）正常；实验 8 一行 return 后立即正常
- 排查过程完整记录：`docs/BUG_REPORT_delete_memory_recomposition.md`（实验 0/1/2/3/6/7/8，逐层排除数组 diff、mount 恢复、工具特殊处理等）

### 修复：全前端同类异步 action 隐患（fire-and-forget 排查）
按新规范全库扫描 `onClick/onLoad/onChange` 中调用异步函数但未返回 Promise 的绑定，共修复 8 处：
- character.js：删除按钮（见上）
- deploy.js：日志级别筛选按钮 `loadLogs()` → `return loadLogs()`
- screen.js：记忆引擎"分析"按钮 `doAnalyze()` → `return doAnalyze()`
- todos.js：删除确认 `deleteItem()`、待办勾选 `toggleTodoItem()`（2 处）→ 加 return
- knowledge.js / timeline.js：删除确认 `actions.deleteItem()` → 加 return
- messages.js：单条消息"分析" `ctx.callTool(...).then(...)` → return Promise 链
- 复查确认：其余 onClick 均为同步 setState，无异步隐患

### 开发规范（新增，见 docs/DEVELOPMENT_GUIDELINES.md）
> 所有在异步操作完成后更新 UI 的事件处理器，都必须把 Promise 返回给宿主（`return doAsyncWork()` 或 `async () => { await doAsyncWork(); }`）。不要在事件回调中直接调用异步函数而丢弃其返回值——否则 await 后的 setState 脱离 action 渲染窗口，UI 不刷新（表现为"数据变了界面不变"的隐蔽 bug）。

### 清理：诊断探针移除
- 删除实验期的 `[R]`/`[MEM]`/`[EXP*]` 日志探针与 `delVerState` 实验 state（dbg_ui.log 噪音大幅下降）
- 保留 `[del]` 轻量诊断日志与墓碑/本地快照防御（防旧快照覆盖、防重复触发）

## v2.2.1（2026-08-07，会话去重开关 + 注入兜底修复版）

### 新增：allowRepeatedMemorySearch 开关（对齐官方 message_insert）
- 配置项 `allowRepeatedMemorySearch`（默认 false）：false=按会话 id 去重（同一会话已注入过的记忆优先不重复）；true=允许重复检索（每次注入重新召回，可能重复）
- UI 设置面板新增「允许重复检索」开关（正语义，直接绑定字段，无取反）
- worker `set_injection_settings` 支持 `allow_repeated_memory_search` 参数；main.js 注入时按开关决定是否传 `exclude_ids`

### 新增：注入内容随消息保存（对齐官方 persistInjectedContent）
- persist=true：新增 `onPromptInput` hook（before_process 阶段）把注入内容**直接拼进消息文本**，随消息一起保存到聊天记录（不走附件）
- persist=false：保持 `onPromptFinalize`（before_send_to_model）附件注入——只发给模型，不写入聊天记录
- 两阶段互斥：persist=true 时 finalize 跳过附件注入，避免内容双份
- 实测：persist=true → 文本拼接注入 370 chars、消息无 Memory 附件；enabled=false → 完全不注入（消息无文本无附件）

### 修复：UI 保存失效（开关重进状态丢失）
- **根因**：screen.js 传驼峰键 `allowRepeatedMemorySearch` 给 `ctx.callTool`，工具声明参数为下划线 `allow_repeated_memory_search`，callTool 参数处理导致值丢失/错乱 → 保存后配置未变（重进显示旧状态）
- **修复**：saveInjectionSettings 构造与工具声明完全一致的下划线 payload（`max_memories` / `allow_repeated_memory_search`）
- 验证：dbg_ui.log 确认 patch/payload 与实际保存一致；关→重进保持关、开→重进保持开

### 修复：注入结果 0（历史排空）
- **根因**：`memory_injection_history.json` 按会话累积已注入 id，角色库仅 22 条时历史可覆盖全部 → `exclude_ids` 排除所有候选 → 注入 0 条
- **修复**：worker `search_memories` 增加兜底——排除后候选不足 limit 时，从最早注入的记忆开始释放（按相似度补回），保证注入永不返回空；新记忆优先、旧记忆轮换复用
- 实测：历史 22 条全排后仍返回 15 条候选、注入 5 条

### 排查发现（记录备查）
- 向量检索候选池 k 全量取回（v2.2.0 ③）后角色过滤正常；本轮进一步确认 worker 部署链路：app 重启时 `deployWorkerToData` 若静默失败，`ensureWorkerUp` 会用旧 DATA_DIR 副本覆盖 /root 新代码——热更新后务必确认三处（dev / DATA_DIR / /root）worker.py 一致

## v2.2.0（2026-08-07，记忆注入 + P7/P8 完成版）

### 核心功能：记忆自动注入（对齐官方 message_insert 模式）
- `onPromptFinalize` 在 `before_send_to_model` 阶段：读 `last_ui_state.json` 注入配置（enabled/persist/maxMemories）→ 消息文本去除附件/XML 标签作查询词 → worker `search_memories` 按当前角色语义召回 → 构造 `<attachment id="cme_memory_bundle_...">【相关记忆】...</attachment>` 随原消息返回
- 查询词清洗：剔除 `<attachment>` / `<workspace_attachment>` 及所有 XML 标签，只留干净消息文本（修复：工作区内容干扰召回）
- 修复：`readInjectionSettings` 缺 `await` 导致读不到配置静默跳过（注入无效的根因）

### P8 注入优化（端到端真机验证通过）
- **① 技术降权排序**：`memoryInjectScore()` 按 importance 加权（high=1000/medium=500/其他=100），命中 `TECH_RE` 再降 -60；实测问"我的习惯"时"熟悉Python"沉底、生活习惯类浮出
- **② snapshot 跨轮去重**：worker `search_memories` 新增 `exclude_ids`；main.js 按 chatId 读写 `memory_injection_history.json`（超 50 条截断保留最近）；实测三轮消息注入 9 条零重复
- **③ 语义检索候选池修复**：向量召回 `k=limit*3` 太小，全局技术噪音霸占近邻名额导致角色库记忆被挤出（排除已注入后候选为空 → 注入 0 条）；改为全量取回 `k=max(limit*50, 200)` 再做角色过滤

### P7 剩余优化
- **P1-3 setEnv 兜底持久化**：screen.js 三处 useState 初始化时从 env 恢复缓存（`MEMORY_ENGINE_DATA_LOADED` / `CACHED_MEMORIES` / `MEMORY_ENGINE_ACTIVE_PERSONA_ID`），写入侧成功后同步 env
- **P1-4 缓存优先后台刷新**：依托 P1-3 缓存，进入界面先展示缓存再后台刷新
- **P1-5 requestId 防旧覆盖**：loadData / loadScreenPersona / loadKnowledgeMemories 三处校验 `rid !== reqIdCounter.xxx` 直接丢弃过期响应
- **踩坑记录**：渲染函数顶层无条件 setState 恢复缓存 → 每次渲染新对象 → 无限重渲染 → UI 卡死；修复为 `if (!state[0])` 仅空状态恢复一次

### 部署规范
- 统一 `debug_install_toolpkg` 热更新烧录；worker.py 由 main.js `onAppCreate` 自动部署到 /root；烧录后需重启 app 加载新 JS 模块（Shizuku 直启）

## v2.1.7（2026-08-06，tab 切换 action 链窗口版）

### tab 切换也保持 action 链窗口（源码级修复第二刀）
- Operit 平台实锤：compose_dsl UI 是 **action 驱动渲染**——异步 setState（Promise/setTimeout 回调）只写 stateStore 不触发 UI 重绘；仅 action 分发期间（Promise pending）订阅 stateChange 实时推送
- 修复：tab onClick（切到知识页/角色页）改为 async + 保持 600ms 窗口——覆盖 character.js 加载 / loadMem 的 setState 实时推送
- 症状：切 tab 到角色页仍卡“正在读取”（v2.1.6 只覆盖了 onLoad 路径）
### 实测（11:07-11:15，快速连切 8 次）
- 所有 tab 切换渲染全程畅通，loadMem/loadPersona setState 全部窗口内推送
- 进入角色页不再空载/卡读取；仅保留正常加载转圈（时间短，可接受）

## v2.1.6（2026-08-06，onLoad action 链窗口版）

### 源码级实锤：action 驱动渲染 + onLoad 保持窗口
- 拉取 Operit 官方源码（JsComposeDslRuntimeScript.kt / JsComposeDslBridge.kt / ToolPkgComposeDslScreen.kt）实锤渲染机制：UI 树只在 ①初始渲染 ②action 分发 ③文本输入同步 ④显式 rerender 时重建
- 异步 setState 只写 stateStore 不触发 UI 重绘；**action 分发期间（Promise pending）订阅 stateChange 实时推送**，action 完成后订阅取消
- 修复：onLoad（本身是 action）恢复 `await loadData()` + 保持 600ms 窗口，让本帧所有异步 setState 落在订阅窗口内实时推送
- 症状：v2.1.5 自驱重试数据层全恢复但 UI 不重绘（“正在读取”卡死）

## v2.1.5（2026-08-06，失败自驱重试版）

### 重试从“被动等 render”改为“失败自驱”
- v2.1.4 暴露：render 驱动重试依赖下一次渲染（相同值 setState 不触发重渲染）→ 无用户操作则冻结
- data 封装 `retryLoadData()`：失败在 finally 主动排队下一次（退避 300/600/1200/2400ms，最多 5 次，成功归零）
- persona chars=0 无旧值自驱重试 5 次；memory 空壳且无缓存自驱重试 5 次
- 实测发现数据层恢复但 UI 不重绘 → 触发源码级深挖（v2.1.6）

## v2.1.4（2026-08-06，P0-2 保险丝版）

### 失败重试保险丝（评估后轻量实施）
- data 调度失败退避：连续失败延迟按 `0/300/600/1200/2400ms` 递增；**连续 5 次失败停止自动重试**（避免空壳竞态下高频空转）；成功归零
- sched 探针增加 `failCount=` 输出，可观测重试状态
- loadKnowledgeMemories 改为**成功才写时间戳**（空壳且无缓存时置 0，与 data 同款自动重试闭环；此前失败也写时间戳导致记忆区空等 60 秒）
- 删除 onLoad 中重复的 `loadScreenPersona()`（已由 render 内 characterLoadScheduledRef 调度）——**消除 req#1/req#2 并发覆盖**（"未识别角色卡"竞态来源）

### 实测（6 次进入，09:36-09:37）
- 空壳 100% 拦截，0 次空覆盖，dataState 全程 27e
- persona 全程单请求（req#2 消失），chars=0 → 重试 → chars=2 恢复
- failCount 0→1→成功归零，无高频空转

## v2.1.3（2026-08-06，P0-1 空覆盖守卫版）

### 空壳响应守卫（根因实锤后第一刀）
- loadData：`extracted` 为空 **且** 已有数据 → 保留旧数据，返回 false（白屏直接元凶）
- loadScreenPersona：`chars=0` **且** 已有 persona → 保留旧值，return（"未识别角色卡"直接元凶）
- loadKnowledgeMemories：返回空数组 **且** 已有记忆 → 保留旧缓存

### 实测（5 次进入，09:24-09:25）
- 5 次空壳全部拦截，0 次空覆盖；守卫 return false → dataLoadedTs 未写 → 现有调度器自动重试 → 全部一次重试成功

## v2.1.2（2026-08-06，诊断实验版）

### mount/unmount 实验（根因实锤）
- [mount] 实例创建探针：每次组件实例创建输出 `[mount] 实例创建 tab=X`
- 渲染计数器升级为 globalThis 模块级（`__dbgRC`）：同模块跨渲染递增，模块重新执行才归 1
- **实验结论（三次进入铁证）**：
  - Operit 每次进入插件界面**重新执行整个 JS 模块**（globalThis 计数器归零）
  - 新模块执行早期工具调用约 2/3 概率返回"成功但空壳"（extracted=无 / chars=0，2-23ms 快速返回）→ **第二层初始化竞态实锤**
  - useState key 持久化部分失效（dataState 保留、persona/dataLoadedTs 丢失）
  - 空壳结果覆盖已有 27 条数据 = 白屏直接原因；chars=0 先返回覆盖 = "未识别角色卡"直接原因
- 完整根因与修复计划见 `docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md`

## v2.1.1（2026-08-05，三探针诊断版）

- 前端加载链路诊断探针（区分空加载类型 A/B/C）
- 前端诊断日志写文件 dbg_ui.log（log_ui 工具，不经 worker）
- 前端三探针：state 写入 / render 快照 / requestId
- 诊断结论：问题类型锁定 A（数据没返回）；空覆盖好数据；dataLoadedTs 持久化部分失效

## v2.1.0（2026-08-05）

### 核心功能：AI 自动提取角色四类记忆
- worker `analyze_chat` 调用 DeepSeek（deepseek-v4-flash）自动提取**角色信息 / 关系记忆 / 偏好 / 互动规则**四类记忆，写入 SQLite（带角色 character_id、source=ai_role）
- 对话截断窗口 6000 → 10000（前后各保留），覆盖对话中段的角色口述素材（此前被"中段省略"吃掉导致四类提取不到）
- max_tokens 4096 → 8192 → 16384（实测 deepseek-v4-flash 接受，AI 输出不再被截断）
- **版本不同步根治**：deployWorkerToData 的 copy `overwrite=false` → `true`（/root 旧 worker 永不覆盖的问题）；onAppCreate 增加版本检查（文件 VERSION vs 运行进程版本不一致则 kill 重启）
- 提取结果验证：四类 8 条全部落库（character 2 / relationship 3 / preference 1 / interaction_rule 2）

### UI 修复（角色页 + 全局）
- 分类 chip：点击已选中=取消、默认全不选展示全部四类（不含六类）、切换**前端过滤秒切（零工具调用）**
- **假"正在读取"兜底**：数据已就绪但 loading 残留 true 时强制清除刷新（Operit 相同值 setState 不触发重渲染导致界面卡住）
- 角色页 persona：优先使用 screen 传入角色 + 共享 persona 缓存（60 秒）+ 未就绪时显示"正在识别角色…"而非报错
- 守卫时间戳化：`dataLoadedState` / `memoryLoadedState` 改为 60 秒过期时间戳，跨重启残留自动失效（此前残留 true 导致"以为加载过但数据为空"）
- 数据型 tab（总览/待办/时间线）未就绪时显示"正在加载数据…"占位，不再裸空白
- 渲染死循环根治：5 处无条件 setState 加"值相同则跳过"
- 分类切换竞态、跨重启残留锁（contextLoadingRef / loadedForRef / analyzing）加时间戳过期
- 工具调用超时提示改为"后台仍在进行"（Operit 工具调用约 12 秒超时，worker 实际 30-80 秒完成）

### 性能实测（无瓶颈）
- 后端 SQLite 查询：单次 7-46ms；四次分类查询合计约 97ms；一次全量查询 14ms
- 工具调用（插件内 HTTP + worker，60 次实测）：最快 6ms / 最慢 38ms / **平均 16.8ms**
- 分析链路实测：短对话 13.5s 成功、2 万字符长对话 15s 成功
- **结论：后端与工具调用层无性能瓶颈**

### 工具链可行性
- 完整链路跨平台验证通过：Operit 插件（UI/subpackage）→ HTTP 桥接 → Python worker（proot Ubuntu 24）→ SQLite
- Android 真机 + Ubuntu 子系统双向可用，无需外部服务器

### 疑难问题（待解决，低优先级）
- [ ] 界面加载优化：**未识别角色卡 / 正在读取 / 读取失败 / 界面数据未加载为空**
  - 现象：退出插件界面再进入时，角色页偶发"未识别到角色卡"或"正在读取"，其他 tab 偶发空白；过一会儿 / 切 tab / 重进可恢复
  - ⚠️ **2026-08-06 v2.1.2 实验已实锤根因**：Operit 每次进入插件界面重新执行整个 JS 模块；新模块执行早期工具调用约 2/3 概率返回"成功但空壳"（第二层初始化竞态）；空壳结果覆盖已有数据 → 白屏；chars=0 先返回 → 未识别角色卡。详见 `docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md`（修复方案已对齐，待执行）
  - 已做缓解（共享缓存 / 时间戳守卫 / 占位 / 自动重试），正式修复按根因文档第六节顺序执行
- [ ] 前端状态管理重构（外部审查建议，P6 方案参考）：
  - 已归档两份外部审查：`docs/Character_Memory_Frontend_Source_Review.md`（生命周期/竞态/多状态源分析）与 `docs/Character_Memory_Engine_review_notes.md`（架构评价与优化优先级）
  - 核心建议：统一状态管理（MemoryController 单一状态源，页面只做展示）、状态机化（INITIALIZING/WORKER_READY/LOADING/READY/EMPTY/ERROR）、区分 `null`（未加载）与 `[]`（已加载但为空）、延迟分析任务至空闲期、保留 executor 启动保护
  - 结论：后端无性能瓶颈，问题集中在 Operit 启动生命周期适配与前端状态管理；不继续修改后端架构
- 后续方向：**恶性 bug 与功能问题优先**

### 调试设施
- `makeTool` 计时探针（保留）：每次工具调用记录 `[timing] action ms=xx` 到 `logs/dbg_call.log`，用于性能与故障定位；开销毫秒级

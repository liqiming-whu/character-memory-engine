# Changelog

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

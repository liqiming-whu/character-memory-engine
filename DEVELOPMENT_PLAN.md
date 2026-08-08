# Character Memory Engine 开发计划

## 0. 文档路由（主入口，2026-08-08 确立）
| 文档 | 用途 | 位置 |
|---|---|---|
| 高级记忆能力优化计划（自改进/记忆质量路线图） | ChatGPT 制定，2026-08-08 审查入档。P0-P4：分析链路稳定性与记忆质量、记忆准入与更新、自更新系统、主动召回、Skill 自更新；分析水位线问题根因已实证、排期 v2.3.1（该文档 4.2 小节） | `docs/CME_高级记忆能力优化计划.md` |
| 渲染风暴平台分析（已收尾） | 连续删除/快速切 tab 渲染风暴：实验过程/稳定复现/依据/原因；验收标准=不报错不闪退，停止极限性能优化 | `docs/RENDER_STORM_PLATFORM_ANALYSIS.md` |
| 开发规范 | 异步 action 返回 Promise、渲染闭包禁 I/O 等铁律 | `docs/DEVELOPMENT_GUIDELINES.md` |

---

## 1. 项目定位

Character Memory Engine 是为Operit平台开发的独立的角色长期记忆引擎。

目标：

- 支持大量角色记忆存储
- 支持高效检索
- 支持语义召回
- 支持角色状态和关系管理
- 为 AI 角色长期陪伴提供基础设施

参考 Character Memory System 项目：
https://github.com/liqiming-whu/character-memory-system
本地：D:\Character-Memory-System

本项目不是 Character Memory System 的简单重构，也不是 Operit Memory 的扩展。

核心原则：

- 不使用 Operit 官方 Memory 作为角色数据库。
- 不批量写入官方 Memory。
- 角色记忆由独立 Engine 管理。
- Operit 仅作为运行环境和交互入口。

---

## 2. 总体架构

Character Memory Engine 采用本地 Worker 架构。

```
                Operit Plugin

                     |
              JSON API通信

                     |
          Character Memory Worker

        ┌────────────┼────────────┐
        |
    Storage Layer
        |
      SQLite
        |
    sqlite-vec

        |
  Embedding Worker
        |
 ONNX Runtime Mobile
        |
 BGE-small-zh

        |
 Retrieval Layer

        |
 Character State Layer
```

设计原则：

- 插件层负责 UI、交互和 ToolPkg 接入。
- Worker 层负责数据库、检索、模型调用。
- JSON 作为通信协议，不作为主要存储格式。
- 数据库和模型服务与 UI 解耦。

---

## 3. Storage Layer

目标：替代 JSON 作为主要数据库。

最终方案：

SQLite

负责：

- memories
- events
- characters
- relationships
- states
- metadata
- embeddings

JSON仅用于：

- 导入
- 导出
- 备份
- Worker 与插件之间的数据通信

参考：

docs/reference_plugins/com-community-dual-life-hub-v1.0.3.toolpkg

学习：

- SQLite 数据管理方式
- Worker 与插件分离方式
- JSON payload 通信方式

.toolpkg 本质为 ZIP 格式压缩包，可以直接解压查看。

注意：

不直接复制 dual-life-hub 实现，仅参考架构思想。

---

## 4. Retrieval Layer

负责：

- 关键词检索
- 时间过滤
- 重要性排序
- 语义召回
- Prompt上下文构建

---

## 5. Embedding Layer

开发独立词嵌入模型插件。

目标：

在 Android 本地运行 embedding 模型。

最终方案：

SQLite + sqlite-vec + ONNX Runtime Mobile + BGE-small-zh

运行方式：

Embedding Worker 独立运行。

职责：

- 模型加载
- 文本向量生成
- embedding 更新
- 向量查询接口

流程：

文本记忆
↓
Embedding Worker
↓
ONNX Runtime Mobile
↓
BGE-small-zh
↓
向量存储
↓
sqlite-vec检索

要求：

- 本地运行
- 离线可用
- 不依赖云端embedding服务
- 不阻塞 Operit UI

---

## 6. Character Layer

负责：

- 角色身份
- 关系状态
- 长期偏好
- 互动规则
- 当前状态

---

## 6. Runtime Worker Layer

Worker 是 Character Memory Engine 的核心运行服务。

负责：

- 数据库访问
- 记忆处理
- 检索服务
- Embedding调用

通信：

Plugin ↔ Worker 使用 JSON API。

设计参考：
"D:\Character-Memory-Engine\docs\reference_plugins\com-community-dual-life-hub-v1.0.3.toolpkg"

dual-life-hub v1.0.3：

terminal.hiddenExec + worker + SQLite + JSON payload

但本项目不限定 Python 实现，可根据 Android 环境选择合适技术方案。

---

## 7. 开发阶段

## P0 架构设计

- 数据模型设计
- 模块边界设计
- SQLite方案确定

## P1 独立存储

- SQLite实现
- CRUD接口
- 数据迁移

## P2 记忆管理

- 记忆分类
- 时间线
- 角色隔离
- 管理界面

## P3 Embedding插件

- ONNX Runtime Mobile
- BGE-small-zh
- embedding生成
- 向量更新

## P4 语义检索

- sqlite-vec
- 相似度搜索
- 召回排序

## P5 Operit集成

- ToolPkg接口
- Prompt注入
- 上下文构建

## P6 高级能力

未来：

- 自动总结
- 记忆压缩
- Reflection
- 自我优化

---

## 待办（高优先级，2026-08-07 确立）

### 1. 前端 bug 优化

- 目标：整理并修复记忆引擎前端（memory_system_ui）现存 bug
- 步骤：先收集已知问题（CHANGELOG 疑难清单 + 用户反馈 + 实际复现），按影响面排序修复，不盲目重构

#### 收集结论（2026-08-07 走查全前端）
- ✅ 已确认健康（无需动）：竞态防线全家桶（空壳守卫 v2.1.3 / 重试+保险丝 v2.1.4-5 / action 链窗口 v2.1.6-7 / requestId 防旧覆盖 P1-5 / 缓存优先后台刷新 P1-4 / setEnv 兜底 P1-3）；注入设置 UI（序号竞态保护 + limit 防抖 + 错误回滚 + 下划线传参 v2.2.1）；角色页 60s 缓存（personaCacheRef）；消息页分页（防重入 + 200ms 节流）；错误提示可见（resultText 顶部气泡）
- ✅ 已修复：知识页每次进入强制重载记忆（tab3 点击 `memoryLoadedState[1](0)` 打破 60s 新鲜度窗口，每次切 tab 重复 list_characters+list_memories）→ 移除强制重置，改为 60s 新鲜度（stale-while-revalidate）；知识页记忆只读展示故安全，生活数据删除后已有 loadData 主动刷新
- ✅ 已修复：角色页删除记忆"要点两次才消失"——**根因闭环（v2.2.2）**：删除按钮 `onClick: function() { deleteMemory(memory.id); }` 未返回 Promise，action 分发器窗口提前关闭，await 后 setState 不触发 recomposition；一行 `return` 修复。排查全程（实验0/1/2/3/6/7/8）记录于 `docs/BUG_REPORT_delete_memory_recomposition.md`，规范入 `docs/DEVELOPMENT_GUIDELINES.md`
- ✅ 已修复（同规范排查）：deploy.js 日志筛选、screen.js 分析按钮、todos.js 删除/勾选、knowledge.js/timeline.js 删除确认、messages.js 单条分析——全部补 return Promise（共 8 处）
- ✅ 已验证：保存修好了，刷新也在（11:11 真机）
- 📋 暂不做（记录理由）：MemoryController 单一状态源大重构（外部审查建议）——当前散 useState + 守卫体系已稳定运行、无实际 bug 支撑，重构风险高收益不确定；待出现具体状态一致性 bug 再评估
- 🔍 待实测验证：知识页 60s 新鲜度生效后，快速切 tab 时 loadKnowledgeMemories / loadScreenPersona 不再重复触发（日志 loadMem/persona 触发次数）
- 已知线索：
  - 前端状态管理重构建议（外部审查：MemoryController 单一状态源 / 状态机化 / 区分 null 未加载与 [] 已加载空，见 docs/Character_Memory_Frontend_Source_Review.md）
  - 空壳竞态残留场景（P6 已修主路径，边缘场景仍需验证）
  - Operit action 驱动渲染约束（异步 setState 需在 action 窗口内，UI 改动必须实测）
  - 注入结果异常需排查（2026-08-07 10:27 消息注入返回 0，历史已排除 9 条，候选不应为空）→ ✅ **已修复（v2.2.1）**：根因①历史累积 22 条覆盖角色库全部 → worker 兜底释放；根因②UI 驼峰传参导致开关保存失效 → 下划线键；详见 CHANGELOG v2.2.1

### 2. 自动分析提取稳定性（长会话）

- 背景：`analyze_chat` 自动提取角色记忆，**会话长时不稳定**（截断窗口 6000→10000、max_tokens 8192→16384 已调过仍不稳）
- 优化方向（先复现再动手）：
  - 复现长会话提取失败/质量差场景，确认是截断、超时、还是提取结果问题
  - 长会话分段/滑动窗口提取，替代单次全量截断
  - 提取结果去重合并强化（与入库侧三级语义去重配合，避免重复条目）
  - 提取节流与失败重试策略（当前 20 分钟冷却 + 换对话/换角色立即分析）
- 约束：不改后端架构（现有 worker 无性能瓶颈），聚焦分析链路本身

---

## 待办（低优先级，不占阶段号）
### env 缓存问题（低优，2026-08-08 排查 API 配置来源时发现）
- 现象：`env_preferences.xml`（/data/user/0/com.ai.assistance.operit/shared_prefs/）已达 92KB+——CME 把 `CACHED_MEMORIES`/`CACHED_PERSONA`/`CACHED_CHAR_MEMORIES`/`MEMORY_ENGINE_UI_STATE`/`MEMORY_SYSTEM_UI_STATE` 等大 JSON 缓存直接 setEnv 到 Operit 平台 env
- 影响：功能正常（env 是 Operit 平台持久化，卸载插件不清除，跨重启可用），但大值 env 每次读写序列化整个 XML，性能一般；且与 `MEMORY_SYSTEM_*` 配置混存，文件持续膨胀
- 优化方向（待评估）：缓存类数据改为落文件（DATA_DIR 下 json）或独立存储；env 只留配置与轻量状态
- 附带实锤（同一轮）：CME/CMS 的 API 配置（MEMORY_SYSTEM_ENDPOINT/KEY/MODEL）就存在该 env 文件里，两插件共用同一套键；卸载重装插件不清 env，故配置"不需要重新设置"

### 转圈优化（Skeleton 轻量版，P3，2026-08-07 评估入档）

- 方案：loading 渲染从「转圈 + 正在读取角色…」改为静态占位（头像灰色块 + 「正在同步记忆…」），**不做 shimmer 动画**（compose_dsl 动画可能踩渲染坑，不值）
- 评估结论（ChatGPT 三方案对照）：
  - ① 缓存首屏状态：**= P7 P1-3/P1-4 已完成**（setEnv 兜底持久化 + 缓存优先后台刷新），不再做
  - ② Skeleton 轻量版：可做，纯 UI 改动约 0.5–1 小时，**仅改善感知**——真实耗时瓶颈在工具调用链与空壳重试（非数据读取，本地 SQLite 单次查询 7–46ms）
  - ③ 减少初始化链：**不推荐**——本地查询毫秒级，拆链只会增加工具调用往返并制造新的并发覆盖面（P6 刚修复两层初始化竞态，避免复活）

### 空壳重试优化（待评估，2026-08-07 入档）

- 背景：**转圈最长时间来自缓存失效后的空壳重试**——Operit 新模块执行早期工具调用约 2/3 概率返回"成功但空壳"（P6 实锤，见 `docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md`），触发 0/300/600/1200/2400ms 退避重试；缓存失效（app 重启/env 丢失/首次进入）时用户看到的就是这一串重试
- 当前已缓解：P6 空壳守卫（空结果不覆盖已有数据）+ P1-3 env 缓存（缓存有效时首屏直接渲染，无需重试）
- 优化方向（待评估，先实测再动手）：
  - 提高缓存命中率：env 缓存覆盖更多状态 / 增加过期策略
  - 缩短感知等待：首档 0ms 改为"立即渲染缓存 + 后台重试"，空壳判定后不等重试成功先展示旧数据
  - 重试节奏自适应：连续空壳时不再逐档等待，直接进入下一轮加载
- 约束（红线）：不引入新竞态——P6 两层初始化竞态修复是底线；任何改动需先复现"缓存失效 + 空壳"场景再实施
### 渲染风暴极限性能（**已收尾**，2026-08-08 用户确认）
- 结论：连续删除/快速切换导致的渲染风暴，根因在 Operit 平台「每次 setState 全量重绘」机制，插件侧无法根治；插件侧放大器（渲染闭包 I/O、loadData/loadMem 无防抖、删除后无本地移除）已全部修复（v2.3.0）
- 验收标准：**不报错、不闪退**即达标；连续删除/快速切换不是本插件正常使用场景，不测试极限性能，停止继续优化
- 完整实验过程/稳定复现/依据/原因分析：`docs/RENDER_STORM_PLATFORM_ANALYSIS.md`
- 后续：向 Operit 官方反馈全量重绘问题（建议差异更新/懒渲染）；平台支持后再评估分页/懒渲染方案

### 记忆过多时的展示与管理方案（下版本计划，2026-08-08 入档）
- 背景：与 CMS 同步入档。当前记忆/信息 `limit=100` 一次性加载 + 全量渲染 + 本地 filter 搜索 + 逐条删除；记忆增长后超过 100 条的部分静默不可见、长列表渲染性能下降、搜索不到更早记忆、清理只能逐条删
- 方案：
  - 展示层：分页/加载更多（每批 50，`list_memories` 走 SQLite 天然支持 OFFSET/LIMIT）→ 分组折叠 → 长列表懒渲染 → 统计卡「已加载 x / 共 y」
  - 管理层：搜索升级走后端全量检索（`list_memories` query）→ 多选批量删除（SQLite 批量删，双端中优先落地）→ 容量感知与清理引导（配合备份导出）
  - 性能验证：500+/1000+ 条记忆下 UI 流畅度与内存
- 约束：与 CMS 方案保持一致（详见 CMS DEVELOPMENT_PLAN.md 第 13 节）；落地顺序：分页 → 后端搜索 → 批量删 → 性能验证
### 自动分析水位线丢失（**v2.3.1 ① 已修复**，2026-08-08 02:04 定位根因，16:00 实装）
- 现象：`trigger_analysis` 启动后台分析后，UI 长时间不显示完成；每次发消息后打开插件都触发全量分析（30-40s），表现为"分析中"迟迟不回报
- 根因（已实证）：**main.js onPromptFinalize 每次消息发送时整写 trigger.json（仅 5 字段：chatId/cooldownStart/callerCardId/personaName）**，把 trigger_analysis 写入的 `watermarks`/`lastAnalyzedAt` 清空 → 水位线周期性丢失 → 打开插件时永远全量分析
- 佐证：engine.log 02:03:02/47/55 三次 analyze_chat 成功（32-38s 全量量级）；dbg_call.log 02:03:55 正常返回 no_new_content（当时水位线存在）；此后 trigger.json 被 onPromptFinalize 覆盖，watermarks 消失
- 修复（已实施，v2.3.1 ①，2026-08-08 16:00）：
  1. main.js onPromptFinalize 写 trigger.json 前先读旧值构造 nextTrigger，**合并保留** `watermarks`/`lastAnalyzedAt`/`lastAnalyzedChatId`/`lastAnalyzedNewCount`/`lastResult`/`lastCheckedAt`/`lastCheckedChatId`；两处整写（首次写入 + 更新写入）统一改为写 nextTrigger
  2. 验证：`node --check` 语法通过；合并逻辑断言全 PASS（旧字段保留、新 chatId/cooldownStart/personaName 生效）
  3. 待真机验证：发消息后 trigger.json 的 watermarks 不再消失；下次打开插件为增量分析而非全量
- 剩余项：setEnv('MEMORY_SYSTEM_TRIGGER_RESULT') 沙盒可用性仍待确认（CME 已 try-catch 包裹、失败静默）；CMS 12.2（自动分析完成但 UI 不刷新）同源问题在 CMS 侧另行处理
- 状态：**代码已完成，真机验证待 v2.3.1 整体打包后确认**
### 冷启动 ANR 卡死（**v2.3.1 优先，2026-08-08 09:00 实锤**）
- 现象：Operit 冷启动后**第一次打开 CME 卡死、app 闪退**；重启 Operit 后第二次打开 CME 完全正常
- 证据链（2026-08-08 09:00 实测）：
  - `/data/anr/anr_2026-08-08-09-01-03-338` + event log：`am_anr: Input dispatching timed out`（MainActivity 等待 MotionEvent 5s 无响应）→ 09:01:05 `am_proc_died` 进程被杀；08:58:58 冷启动，09:01:09 用户重启后正常
  - engine.log：09:00:35 `onAppCreate: worker 未就绪: 未找到可用的 python3`（冷启动早期 terminal 未就绪，detectPython 4 个候选路径各 8s 超时 = 最多 32s）
  - dbg_call.log：09:00:43 `save_ui_state ms=32218`（32s 阻塞后报"未找到可用的 python3"）；09:00:11/09:00:43 前端 `trigger_analysis` 在 worker 离线时仍启动 analyze（chatLen=20007 白跑一次）
- 根因链：冷启动 terminal/executor 未就绪 → `detectPython()` 硬等 32s 失败 → worker 拉不起 → **每个依赖 worker 的工具调用内部又同步触发 ensureWorkerUp → 再走 32s 阻塞** → 主线程被长阻塞工具调用拖死 → ANR 被杀
- 修复项（2026-08-08 用户确认入档，随 v2.3.1 完成）：
  1. **detectPython 冷启动早期快速失败 + 延迟重试**：terminal 未就绪时别硬等 32s；先快速探测一次（缩短单次超时），失败则 60s 后自动重试——worker 在后台自己起来，用户打开时即就绪
  2. **worker 离线时工具调用快速失败**：`run()` 内不要同步触发 `ensureWorkerUp` 长阻塞；UI 先返回失败，拉起操作放后台（配合 1 的自动重试）
  3. **triggerAnalysis 入口加 worker 就绪检查**（最核心）：先 `ping_worker`，失败直接返回 `{skipped:true, reason:'worker_not_ready'}`，不启动 analyzeChat——避免 worker 离线时前端照样启动分析、白调 LLM
  4. **analyzeChat 保存失败时也推进水位线/标记失败**：避免"分析失败 → 水位线不动 → 下次全量重分析"死循环（与水位线任务联动）
- **竞态机制确认（2026-08-08 用户推测 + 实验验证）**：
  - 机制：Operit 重启后 Ubuntu/proot 初始化需要约 30-80 秒；期间调用 hiddenExec 触发 executor 会话竞态（main.js onAppCreate 注释早有认知：*"Operit 重启早期（数秒内）调用 hiddenExec 有 executor 会话竞态风险，可能创建坏会话导致后续永久卡；30s 是保守兜底值"*，但**用户手动打开插件无延迟保护**）
  - 触发链：重启后快速进入 app 点开插件（<30s）→ UI 初始化调 hiddenExec（detectPython/ensureWorkerUp）→ 竞态命中 → 探测超时/坏会话 → 后续调用永久卡
  - 进程对比实验（2026-08-08）：进程 C（09:23 重启，1 分钟内触发 hiddenExec）→ 环境探测持续超时 23 分钟未恢复；进程 D（09:46 重启，80 秒后才触发）→ diag_engine 完全正常（python3 探测全通过）
  - 修复方向补充：**工具层加 Ubuntu 就绪保护**——首次 hiddenExec 探测失败不立即抛错、也不硬等，进入后台延迟重试队列（30s/60s）；UI 侧先显示"worker 初始化中"，就绪后自动拉起
  - **proot 重建速度实测（2026-08-08 六次）**：Operit 启动 → proot 进程创建稳定 **2 秒**（10:09:03→05 / 10:11:46→48 / 10:22:33→35 / 10:25:19→21 / 10:33:07→09 / 10:37:47→49）；worker 全链路拉起（探测→启动→模型加载→listening）固定 **7-8 秒**。热重建窗口极短，正常使用场景几乎不构成竞态
  - **待验证假设（pending，需受控长放置实验实锤）**：长时间不启动（如睡一觉、proot 完全终止 + 缓存冷）后冷启动快速点开插件可能命中竞态——今早 08:58 ANR 与进程 C/D 对比为自然样本（强支持），但缺少一次"人为放置 → 冷启动 → 快速点开"的受控验证
  - **用户使用经验（2026-08-08）**：① 实验难做（无法保证每次点开速度够快），但**一般第二次退出重进即可恢复**，不算大问题；② 实用规避：**使用时不秒进插件，等待约 10 秒再点开**（proot 2s 就绪 + worker 7-8s 拉起，10s 是保守余量）即可避开竞态窗口
- **沙盒实验记录（2026-08-08）**：diag_engine 在进程 D 的 hiddenExec 环境探测返回 `env.py`: `/usr/bin/python3 | Python 3.12.3 | /usr/bin/python3.12 | /root/.venv/bin/python3.12 | whoami=root`——**沙盒 hiddenExec 能正常探测到全部 python3 路径**；此前"未找到可用的 python3"全部为超时误报
- **划掉/退出 app 连带杀死 worker（2026-08-08 实验实锤）**：worker 进程跑在 proot 内、proot 是 Operit 的子进程（PPID=Operit）——**退出/划掉 app → Operit 被杀 → proot 连带被杀 → worker 必死**。此前“没有 kill worker、worker 应该还活着”的假设是错觉：只要 app 重启过，worker 一定需要重新拉起，**不存在 worker 存活跨 app 重启的状态**
- **UI 转圈机制最终实锤（2026-08-08 七轮对照实验，替代早前“两次对比实验”记录）**：
  - 表象：screen.js 初始化 `await ctx.callTool('trigger_analysis')` 阻塞 UI 渲染；秒进时 [init] 2-4s 返回，转圈时 [init] 8s 返回
  - **根因 = save_ui_state（Operit 平台在 UI 挂载时自动调用）与 trigger_analysis（UI JS init 调用）的并发时序竞争**：
    - 并行（碰巧同时发起）：save_ui_state 在 worker 离线时同步等拉起（约 5s）→ 堵住平台回调队列 → trigger_analysis 结果（早已完成）排队延迟回传 → [init] 延迟 → 转圈
    - 串行（trigger_analysis 先回传）：[init] 2-3s 返回 → UI 先渲染 → save_ui_state 的 5s 等待后台化 → 秒进
  - **与是否 kill worker 无关**：不 kill 5 次 = 秒进 2 / 转圈 3（约 50/50 随机）；kill 2 次全秒进但样本小，疑似巧合。worker 拉起耗时固定 ~7s（proot 2s 就绪 + 探测 + 启动/onnx 模型加载 5s），与死法无关
  - 七轮数据：秒进 [init]=3s/4s/2s/2s，转圈 [init]=8s/8s/8s；save_ui_state 每次 4948-5183ms（同步等 worker），worker listening 每次约 7s
  - 结论：**任何工具调用在 worker 离线时都不能同步等待**（治本），无论 save_ui_state 与 trigger_analysis 如何并发，平台回调队列都不被堵 → 转圈从根上消失；印证修复项 2/3 方向
- **ensureWorkerUp 拉起后等待窗口不足（2026-08-08 实锤）**：拉起脚本后仅 `sleep 3s` 就 ping2，但 worker 启动需 4-5s（onnx 模型加载 + GPU 探测）→ 三次实测（10:33:14/10:36:33/10:37:54）均出现 listening 与“拉起后 worker 仍未响应”同秒误报；实际 worker 稍后就绪，靠下次调用 alreadyUp 兜底——**修复：拉起后轮询 ping（每 2s，最长 10-15s）替代固定 3s 等待**
- **LLM 不返回标准 JSON 实锤（2026-08-08）**：10:12:08 `analyze_chat ms=13138ms ok=False msg=AI 提取失败或返回格式错误`——后台分析 13s 后因 LLM 返回格式异常失败。**验证了 ChatGPT 计划文档（docs/CME_高级记忆能力优化计划.md 2.2 小节）的预判“输出可能不完整或 JSON 结构异常”**；分析链路需要 JSON 解析容错（修复/重试），并配合修复项 4（保存失败也推进水位线，避免全量重分析死循环）
- 附加记录：**CME 日志时间戳体系（2026-08-08 最终态）**——worker.py 已改 `time.gmtime(time.time()+8*3600)` **固定北京时间输出（不依赖 proot/TZ）**；CME JS 日志（jsLog/dbgUi/dbgLog）`_localTs()/_localMd()` 跟随系统时区（进程缓存）；**operit.log 跟随系统时区（Java 进程启动时缓存默认时区，重启才刷新）**——2026-08-08 UTC 实验实锤：`cmd alarm set-timezone Etc/UTC` 后重启 Operit，operit.log 全程 UTC；此前"固定北京时间"为误解。**proot Ubuntu 已改回 UTC 惯例**（/etc/profile.d/tz.sh → Etc/UTC、/etc/localtime → Etc/UTC、/etc/timezone → Etc/UTC），重装/重置后无需再配；三处日志统一为北京时间
---
## 8. 开发原则

- 不依赖官方 Memory 数据库。
- 不使用大JSON作为数据库。
- 模块化设计。
- 数据模型优先。
- 重大架构修改同步更新本文档。

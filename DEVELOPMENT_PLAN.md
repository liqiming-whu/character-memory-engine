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
### 自动分析水位线丢失（**v2.3.1 优先解决**，2026-08-08 02:04 已定位根因，2026-08-08 用户确认排期）
- 现象：`trigger_analysis` 启动后台分析后，UI 长时间不显示完成；每次发消息后打开插件都触发全量分析（30-40s），表现为"分析中"迟迟不回报
- 根因（已实证）：**main.js onPromptFinalize 每次消息发送时整写 trigger.json（仅 5 字段：chatId/cooldownStart/callerCardId/personaName）**，把 trigger_analysis 写入的 `watermarks`/`lastAnalyzedAt` 清空 → 水位线周期性丢失 → 打开插件时永远全量分析
- 佐证：engine.log 02:03:02/47/55 三次 analyze_chat 成功（32-38s 全量量级）；dbg_call.log 02:03:55 正常返回 no_new_content（当时水位线存在）；此后 trigger.json 被 onPromptFinalize 覆盖，watermarks 消失
- 修复方向（下版本）：
  1. **根因**：main.js 写 trigger.json 前先读旧值，合并保留 `watermarks`/`lastAnalyzedAt` 再写
  2. 验证 `setEnv('MEMORY_SYSTEM_TRIGGER_RESULT')` 在 CME 沙盒是否可用（CME 此前无 setEnv 使用先例，已 try-catch 包裹、失败静默）；不可用则改前端轮询读 result.json 文件
  3. 与 CMS 12.2（自动分析完成但 UI 不刷新）同源问题一并修：CMS 是分析完成但 UI 不刷新；CME 是水位线丢失导致反复全量
- 优先级：**高（v2.3.1 首个任务，2026-08-08 用户确认）**——根因已实证、修复方向明确（写 trigger.json 前合并保留 watermarks/lastAnalyzedAt），预计随 v2.3.1 完成；CMS 12.2（分析完成但 UI 不刷新）同源问题一并处理
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
- 附加记录：**CME 日志时间戳体系**（2026-08-08 排查实锤）——JS 侧日志（jsLog/dbgUi/dbgLog）用 `new Date().toISOString()` **固定 UTC**，改系统时区无效；worker.py 用 `time.strftime` 跟随 proot 环境时区；operit.log 固定北京时间（疑似 Java 进程时区缓存，待 UTC 实验验证）。排查日志时注意换算，JS 日志 = UTC（北京 -8h）
---
## 8. 开发原则

- 不依赖官方 Memory 数据库。
- 不使用大JSON作为数据库。
- 模块化设计。
- 数据模型优先。
- 重大架构修改同步更新本文档。

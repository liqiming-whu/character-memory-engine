# Character Memory Engine 开发计划

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

---

## 8. 开发原则

- 不依赖官方 Memory 数据库。
- 不使用大JSON作为数据库。
- 模块化设计。
- 数据模型优先。
- 重大架构修改同步更新本文档。

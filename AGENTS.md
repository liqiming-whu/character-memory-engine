# AGENTS.md

## Character Memory Engine 开发规范

## 项目目标

开发运行于 Operit 平台的独立角色记忆引擎。

目标：

- 为 AI 角色提供长期记忆存储
- 提供高效检索与语义召回
- 管理角色状态、关系和经历

Character Memory Engine 不替代 Operit 平台，而是在 Operit 插件环境中提供独立记忆能力。

---

## 核心原则

1. 不依赖 Operit 官方 Memory 作为角色记忆数据库。
2. 不批量向官方 Memory 写入角色经历。
3. 保持 Engine 数据独立可维护。
4. 保持与 Operit Plugin API 的兼容。
5. UI、存储、检索、模型服务保持模块化。

---

## Operit 兼容要求

虽然 Engine 使用独立存储，但必须兼容 Operit 插件生态。

开发时必须参考：

- Operit 官方源码：
  https://github.com/AAswordman/Operit
  `D:\Operit` 是本地权威 Git 仓库；需要最新 API 时可按全局代理规则执行 `git pull`，再核对 `docs/`、`examples/types/` 和实际实现。

用途：

- 确认 ToolPkg API
- 确认插件生命周期
- 确认工具调用方式
- 确认 UI 和运行环境接口

不得脱离 Operit 实际接口设计。

---

## 旧插件参考规则

旧项目：

https://github.com/liqiming-whu/character-memory-system

用途：

- 分析已有 ToolPkg 实现
- 参考 UI 实现
- 参考字段设计
- 参考角色记忆交互方式

注意：

参考实现，不继承旧架构。

禁止直接继承：

- 官方 Memory 作为数据库
- JSON作为运行时数据库
- 旧数据同步逻辑

---

## 本地参考源码

开发环境中如果存在本地 Character-Memory-System 源码：

用途：

- UI迁移参考
- 字段兼容分析
- 用户体验参考

不是：

- 架构依据
- 数据层实现依据

---

## 开发原则

- 优先设计数据模型，再实现功能。
- 优先确定模块接口。
- 避免大 JSON 作为运行时存储。
- 重大架构变化更新 DEVELOPMENT_PLAN.md。

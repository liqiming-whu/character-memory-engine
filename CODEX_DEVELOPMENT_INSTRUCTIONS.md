# Codex 开发规范

## 项目定位

Character Memory Engine 是独立的角色长期记忆引擎。

目标：

为 AI 角色提供：

- 大规模记忆存储
- 高效检索
- 语义召回
- 角色状态管理
- 关系管理

不是：

- Operit Memory 增强插件
- 官方 Memory 替代接口


## 架构原则

分层：

- Plugin Layer
- Worker Runtime Layer
- Storage Layer
- Retrieval Layer
- Embedding Layer
- Character State Layer
- API Layer
- Operit Adapter Layer

原则：

Plugin 不承担核心计算。
Worker 负责数据库、检索和模型调用。


## 数据原则

- SQLite 作为主要数据库。
- JSON 仅用于导入、导出和备份。
- 不使用大 JSON 文件作为运行时存储。
- 不直接依赖官方 Memory 数据库。


## Embedding 方向

最终目标：

SQLite + sqlite-vec + ONNX Runtime Mobile + BGE-small-zh

要求：

- 支持 Android 本地运行。
- 支持离线 embedding。
- Embedding 模块独立。


## 开发流程

1. 阅读 DEVELOPMENT_PLAN.md。
2. 设计数据模型。
3. 定义模块接口。
4. 编写测试。
5. 实现功能。

任何架构变化必须同步更新 DEVELOPMENT_PLAN.md。

## Operit 参考规则：

官方仓库：
https://github.com/AAswordman/Operit
`D:\Operit` 是本地权威 Git 仓库。
用于确认 ToolPkg API、插件生命周期、UI接口和插件能力，保证实现兼容。

## 旧项目参考规则

旧仓库：

https://github.com/liqiming-whu/character-memory-system
本地：D:\Character-Memory-System
本地 Character-Memory-System 源码用于参考 UI 和字段实现。

禁止：

- 完全复制旧架构；
- 完全使用旧 Memory 设计；
- 恢复官方 Memory 写入方案。


## 兼容开发要求

Character Memory Engine 采用独立架构，但作为 Operit 插件开发必须保持：

- ToolPkg API兼容；
- 插件生命周期兼容；
- UI交互兼容；
- 必要字段迁移兼容。

参考旧插件时重点分析：

- UI结构；
- 字段命名；
- 用户操作流程。

不要复制旧存储架构。

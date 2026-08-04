# Codex 第一条指令

你现在接手 Character Memory Engine 项目。

首先阅读：

- DEVELOPMENT_PLAN.md
- AGENTS.md
- CODEX_DEVELOPMENT_INSTRUCTIONS.md
- docs/SOURCE_REFERENCE.md
- docs/TOOLPKG_DEVELOPMENT.md

任务：

1. 分析当前 Engine 目标和模块边界。
2. 设计独立角色记忆引擎架构。
3. 分析 SQLite 存储、检索层、Embedding 层的实现方案。
4. 输出架构分析报告和开发路线。

限制：

- 不立即编写大量代码。
- 不将旧 Character Memory System 架构直接迁移。
- 不使用 Operit 官方 Memory 作为角色数据库。
- 不批量写入官方 Memory。
- 优先确定数据模型和接口边界。


参考来源：

Operit 官方仓库：
https://github.com/AAswordman/Operit
本地：`D:\Operit` 是本地权威 Git 仓库；需要最新 API 时可按全局代理规则执行 `git pull`，再核对 `docs/`、`examples/types/` 和实际实现。

必须参考以保证插件 API 兼容。重点确认 ToolPkg API、插件生命周期、UI接口和运行环境。

旧项目仓库：
https://github.com/liqiming-whu/character-memory-system
本地： D:\Character-Memory-System

仅用于：
- 学习已有 ToolPkg 实现方式；
- 分析可复用经验、UI实现方式和字段设计。

不要继承旧项目的：
- 数据存储方案；
- Memory模型；
- 开发计划。

第一阶段重点：
- 分析 Worker 架构；
- 设计 Storage / Retrieval / Embedding 模块边界；
- 不直接开发 UI 或大量业务代码。

完成分析后等待下一步指令。


补充要求：
- 分析 Operit API 兼容边界。
- 分析本地 Character-Memory-System UI 和字段实现，作为迁移参考。

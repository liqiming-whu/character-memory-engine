# Character Memory Engine

运行于 Operit 平台的独立角色长期记忆引擎。

为 AI 角色提供大规模记忆存储、高效检索、语义召回与角色状态/关系管理，不依赖 Operit 官方 Memory 数据库。

## 背景

官方记忆库（Operit Memory）缺乏列表展示、批量操作与语义去重，记忆维护困难。本项目自建独立记忆引擎解决这些痛点：

- **SQLite 独立存储**：三表（memories / characters / relationships），支持增删查改与批量操作
- **语义去重**：写入时自动识别近似记忆并合并（方案甲）
- **角色隔离**：单库 + `character_id` 列
- **语义检索**（方案 A）：sqlite-vec + onnxruntime + BGE-small-zh 向量召回
- **前端复用**：兼容旧项目 Character Memory System 的 UI 与字段

## 架构

```
        Operit Plugin (ToolPkg)
               |
        JSON API 通信
               |
     Character Memory Worker (Python 3.12, proot Ubuntu 24)
               |
      SQLite (sqlite-vec) + Embedding (onnxruntime + BGE)
```

- 插件层：UI、交互、ToolPkg 接入
- Worker 层：数据库、检索、模型调用
- JSON 作为通信协议，不作为主要存储格式

## 技术验证

完整技术栈已在 Operit 内置 proot Ubuntu 24 环境验证通过：
- Python 3.12 + venv + pip
- sqlite-vec 0.1.9（aarch64 wheel）
- onnxruntime 1.28.0（CPU）
- BGE-small-zh int8（23.9MB，512 维）
- 语义相似度：奶茶 vs 爱喝奶茶 = 0.95，奶茶 vs 健身房 = 0.47

详见 [docs/TECH_VALIDATION.md](docs/TECH_VALIDATION.md)。

## 项目结构

```
worker.py        SQLite 数据层（CRUD / 语义去重 / 角色隔离 / HTTP JSON 服务）
test_worker.py   数据层测试（20 项，全绿）
docs/
  ARCHITECTURE_DESIGN.md   架构设计
  WORKER_API.md            memory_engine 接口规范
  TECH_VALIDATION.md       P0 技术验证记录
```

## 开发进度

- [x] P0 技术验证（SQLite + sqlite-vec + onnxruntime + BGE 可行）
- [x] P1 Worker 骨架 + SQLite 三表 + CRUD + 语义去重（方案 B）
- [ ] P2 语义去重增强（文本相似度 + 向量去重方案 A）
- [ ] P3 插件接入（worker 部署 + memory_engine 工具 + 前端复用）
- [ ] P4 语义检索（sqlite-vec 向量召回）

## 开发规范

阅读 [AGENTS.md](AGENTS.md) / [CODEX_DEVELOPMENT_INSTRUCTIONS.md](CODEX_DEVELOPMENT_INSTRUCTIONS.md) / [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 参考

- 旧项目 Character Memory System：https://github.com/liqiming-whu/character-memory-system（UI/字段参考）
- Operit：https://github.com/AAswordman/Operit（ToolPkg API）
- dual-life-hub（worker + SQLite + JSON payload 参考）

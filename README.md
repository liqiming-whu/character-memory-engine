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
               │
      subpackage 工具（memory_engine.js）
               │  HTTP POST JSON（Tools.Net.http → 127.0.0.1:8765）
               ▼
     Character Memory Worker (Python 3.12, proot Ubuntu 24)
               │
      SQLite (sqlite-vec) + Embedding (onnxruntime + BGE)
```
- 插件层：UI（compose_dsl）、subpackage 工具、ToolPkg 接入
- Worker 层：常驻 HTTP 服务，数据库、检索、模型调用
- 前端与 Worker 之间通过 HTTP 桥接通信，不依赖 Operit 终端环境（Android shell 无 python3）

### 数据目录（自包含）
`/sdcard/Download/Operit/character_memory_engine/`
```
worker.py        Worker 本体（与包内同版）
embed.py         BGE 嵌入封装
models/          config.json + model_int8.onnx + tokenizer.json（24MB）
engine.db        记忆库
logs/            engine.log（worker 侧日志）/ dbg_call.log（subpackage 探针）
```
Worker 启动：
```
nohup /root/.venv/bin/python3.12 /sdcard/Download/Operit/character_memory_engine/worker.py \
  --port 8765 --db /sdcard/Download/Operit/character_memory_engine/engine.db &
```

### 已知限制与运维
- **Operit 重启后 Worker 需重新拉起**：Operit 内置终端是 Android 原生 shell（无 python3、无法访问 proot rootfs），`onAppCreate` 自动拉起依赖 Termux（`/data/data/com.termux/files/usr/bin/python3`）；未装 Termux 时需在 proot 会话手动拉起。
- **部署状态自检**：`deploy_status` 走 `/proc` 遍历（不依赖 pgrep，proot/Termux 通用）。
- **调试广播**（需 `--user 0`）：
  - `am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_INSTALL_TOOLPKG --es package_name com.operit.character_memory_engine --es file_path <toolpkg绝对路径> --ez reset_subpackage_states false`
  - `am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_REFRESH_PACKAGES --ez reactivate_active_packages true`

## 技术验证

完整技术栈已在 Operit 内置 proot Ubuntu 24 环境验证通过：
- Python 3.12 + venv + pip
- sqlite-vec 0.1.9（aarch64 wheel）
- onnxruntime 1.28.0（CPU）
- BGE-small-zh int8（23.9MB，512 维）
- 语义相似度：奶茶 vs 爱喝奶茶 = 0.95，奶茶 vs 健身房 = 0.47
- 方案 A 8 项全 PASS、方案 B 22 项全 PASS、旧备份导入幂等 PASS

详见 [docs/TECH_VALIDATION.md](docs/TECH_VALIDATION.md)。

## 项目结构

```
worker.py        SQLite 数据层（CRUD / 语义去重 / 角色隔离 / HTTP JSON 服务）
packages/memory_engine.js  subpackage 工具（HTTP 桥接 + 自动拉起 + data 包装）
main.js          ToolPkg 注册（UI / hook / 自动拉起）
ui/memory_system_ui/   compose_dsl 前端（复用旧项目 UI）
test_worker.py   数据层测试（22 项，全绿）
docs/
  ARCHITECTURE_DESIGN.md   架构设计
  WORKER_API.md            memory_engine 接口规范
  TECH_VALIDATION.md       P0 技术验证记录
  TOOLPKG_DEVELOPMENT.md   ToolPkg 集成协议与踩坑记录
```

## 开发进度

- [x] P0 技术验证（SQLite + sqlite-vec + onnxruntime + BGE 可行）
- [x] P1 Worker 骨架 + SQLite 三表 + CRUD + 语义去重（方案 B）
- [x] P2 语义去重增强（文本相似度 + 向量去重方案 A，8/8 PASS）
- [x] P3 插件接入（HTTP 桥接 + subpackage 工具 + 前端复用，真机全绿）
- [x] P4 语义检索（sqlite-vec 向量召回 + 旧备份幂等导入）

## 开发规范

阅读 [AGENTS.md](AGENTS.md) / [CODEX_DEVELOPMENT_INSTRUCTIONS.md](CODEX_DEVELOPMENT_INSTRUCTIONS.md) / [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 参考

- 旧项目 Character Memory System：https://github.com/liqiming-whu/character-memory-system（UI/字段参考）
- Operit：https://github.com/AAswordman/Operit（ToolPkg API）
- dual-life-hub（worker + SQLite + JSON payload 参考）

# Character Memory Engine

运行于 Operit 平台的独立角色长期记忆引擎。

为 AI 角色提供大规模记忆存储、高效检索、语义召回与角色状态/关系管理，不依赖 Operit 官方 Memory 数据库。

## 主要功能

官方记忆库（Operit Memory）缺乏列表展示、批量操作与语义去重，记忆维护困难。本项目自建独立记忆引擎解决这些痛点：

- **SQLite 独立存储**：三表（memories / characters / relationships），支持增删查改与批量操作
- **语义去重**：写入时自动识别近似记忆并合并
- **角色隔离**：单库 + `character_id` 列
- **语义检索**：sqlite-vec + onnxruntime + BGE-small-zh 向量召回
- **前端复用**：兼容旧项目 Character Memory System 的 UI 与字段

除此之外，本记忆引擎还支持：

- **分析**： 自动或手动分析聊天记录；
- **提取**： 从历史对话中提取长期记忆；
- **管理**： 角色背景、事件和关系；
- **召回**： 基于语义检索自动召回相关记忆；
- **注入**： 将检索结果注入提示词，提高 AI 角色长期交互的一致性。
- **备份与恢复**： 支持记忆数据库的导出与备份，支持旧项目**角色记忆系统**(Character Memory System)插件的备份数据的导入。

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
- 前端与 Worker 之间通过 HTTP 桥接通信（Worker 实际运行于 Operit 内置 proot Ubuntu，Python 3.12 可用；HTTP 桥接用于进程隔离与稳定性，不依赖 UI 侧终端环境）

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
- **自动拉起 Worker（v2.0.20+）**：`onAppCreate` 自动拉起，无需手动干预——hiddenExec 环境实为 Operit 内置 proot Ubuntu（root，python3.12 + venv 可用），拉起脚本经 `setsid` 后台分离。**注意：Operit 重启早期调用 hiddenExec 存在 executor 会话竞态风险**（实测数秒后即可正常拉起；`onAppCreate` 延迟 30s 是保守兜底，并非 Ubuntu 实际需要初始化这么久），提前调用可能创建坏会话导致卡死/闪退。
- **hiddenExec 会话策略**：固定 executorKey `cme`（永远复用 1 个会话，零膨胀）+ `Promise.race` 硬超时；卡死超时报错不建新会话；每次拉起强制 `freshKey` 全新会话，坏会话绝不复用。
- **部署状态自检**：`deploy_status` 走 `/proc` 遍历（不依赖 pgrep，proot/Termux 通用）。
- **调试广播**（需 `--user 0`）：
  - `am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_INSTALL_TOOLPKG --es package_name com.operit.character_memory_engine --es file_path <toolpkg绝对路径> --ez reset_subpackage_states false`
  - `am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_REFRESH_PACKAGES --ez reactivate_active_packages true`

## 当前版本（v2.1.7）：初始化竞态修复

**修复目标**：Operit 前端"JS 模块重载 + 工具调用初始化竞态"导致的**空加载（白屏）/ 卡"正在读取" / "未识别角色卡"** 三类问题。

**两层竞态**：
1. **第一层（v2.0.20 已解决）**：Operit 重启早期 hiddenExec executor 会话竞态 → `onAppCreate` 延迟 30s + `ensureWorkerUp` freshKey 自愈
2. **第二层（v2.1.3~v2.1.7 已解决）**：每次进入插件界面重新执行整个 JS 模块 + 新模块早期工具调用约 2/3 概率返回"成功但空壳" + useState key 部分持久化失效 + 空壳覆盖已有数据 + 并发乱序

**已实施修复（按版本）**：
- v2.1.3 空壳响应守卫（data / persona / memory 三处，空结果绝不覆盖非空状态）
- v2.1.4 重试保险丝（退避 + 上限 + memory 成功才写时间戳 + 消除 persona 并发）
- v2.1.5 失败自驱重试（不再依赖 render 触发）
- v2.1.6/v2.1.7 **action 链渲染窗口**（源码级实锤：Operit compose_dsl 为 action 驱动渲染，异步 setState 默认不触发 UI 重绘；onLoad 与 tab 切换保持 600ms 订阅窗口实时推送）

**验证结果**：连续多次退出重进 / 快速切 tab，0 次空载、0 次卡读取、0 次未识别角色卡；仅保留正常加载转圈（时间短，可接受）。

完整排查历程、实验证据与修复细节见 [docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md](docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 技术验证

完整技术栈已在 Operit 内置 proot Ubuntu 24 环境验证通过：
- Python 3.12 + venv + pip
- sqlite-vec 0.1.9（aarch64 wheel）
- onnxruntime 1.28.0（CPU）
- BGE-small-zh int8（23.9MB，512 维）
- 语义相似度：奶茶 vs 爱喝奶茶 = 0.95，奶茶 vs 健身房 = 0.47
- 方案 A 8 项全 PASS、方案 B 22 项全 PASS、旧备份导入幂等 PASS
- **自动拉起（v2.0.17）**：重启 Operit 后 `onAppCreate` 秒级拉起 worker，无需手动干预（hiddenExec 固定会话 + setsid 后台分离）
- **AI 自动提取四类角色记忆（v2.1.0）**：worker `analyze_chat` 调 DeepSeek 自动提取角色信息/关系/偏好/互动规则，四类 8 条验证落库
详见 [docs/TECH_VALIDATION.md](docs/TECH_VALIDATION.md)。

### 性能实测（v2.1.0，无瓶颈）
- **后端 SQLite 查询**：单次 7-46ms；四次分类查询合计约 97ms；一次全量查询 14ms
- **工具调用（插件内 HTTP + worker，60 次实测）**：最快 6ms / 最慢 38ms / 平均 16.8ms
- **分析链路**：短对话 13.5s 成功、2 万字符长对话 15s 成功
- **结论**：后端与工具调用层无性能瓶颈；体感慢主要来自 Operit 前端框架调度层与持久化状态机制

### 工具链可行性（v2.1.0）
完整链路跨平台验证通过：Operit 插件（UI/subpackage）→ HTTP 桥接 → Python worker（proot Ubuntu 24）→ SQLite。Android 真机 + Ubuntu 子系统双向可用，无需外部服务器。

### 已知疑难（已解决）
- [x] **界面加载优化（v2.1.7 已解决）**：未识别角色卡 / 正在读取卡住 / 空加载白屏。根因：**Operit 每次进入插件界面重新执行整个 JS 模块** + **新模块早期工具调用约 2/3 概率返回"成功但空壳"**（两层初始化竞态的第二层）；叠加 useState key 部分持久化失效、空壳覆盖已有数据、并发乱序。已实施修复：空壳守卫（v2.1.3）+ 重试保险丝（v2.1.4）+ 失败自驱重试（v2.1.5）+ **action 链渲染窗口**（v2.1.6/v2.1.7，源码级实锤 Operit 为 action 驱动渲染，异步 setState 默认不触发 UI 重绘）。详见 [docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md](docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md)。

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
  INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md  初始化竞态根因与修复计划（两层竞态 → bug → 修复 全链路）
```
### 相关文档路由
- **初始化竞态根因与修复**：`docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md`（两层竞态实锤证据、导致的三个症状、v2.1.3~v2.1.7 修复记录、剩余 P1 项）
- **ToolPkg 平台踩坑**：`docs/TOOLPKG_DEVELOPMENT.md`（Operit 集成协议、hiddenExec 会话、action 驱动渲染等平台特性）
- **版本历史**：`CHANGELOG.md`

## 开发进度

- [x] P0 技术验证（SQLite + sqlite-vec + onnxruntime + BGE 可行）
- [x] P1 Worker 骨架 + SQLite 三表 + CRUD + 语义去重（方案 B）
- [x] P2 语义去重增强（文本相似度 + 向量去重方案 A，8/8 PASS）
- [x] P3 插件接入（HTTP 桥接 + subpackage 工具 + 前端复用，真机全绿）
- [x] P4 语义检索（sqlite-vec 向量召回 + 旧备份幂等导入）
- [x] P5 AI 自动提取角色四类记忆 + UI 性能优化（v2.1.0，见 CHANGELOG.md）
- [x] P6 界面加载疑难问题（v2.1.7 已解决：两层初始化竞态 → 空加载/卡读取/未识别角色卡，见 docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md）
- [ ] P7 剩余优化（P1-3 setEnv 兜底持久化、P1-4 缓存优先后台刷新、P1-5 requestId 防旧覆盖，见根因文档第五节）
- [ ] P8 注入优化（v2.1.10，方案参考 https://github.com/liqiming-whu/character-memory-system）：
  - ① 技术降权排序：注入拼装处按 importance 加权（high=1000/medium=500/low=100），标题或正文命中 `TECH_RE = /技术|调试|bug|报错|error|修复|配置|接口|API/` 再降 -60，开发记录类记忆沉底，人物/生活记忆优先浮出；
  - ② snapshot 跨轮去重：worker `search_memories` 增加可选参数 `exclude_ids`；main.js 注入成功后按 chatId 记录本次注入的记忆 id 到 `memory_injection_history.json`，下次注入读取并传入 `exclude_ids`，同一会话已注入过的记忆不再重复注入（等价宿主 query_memory 的 snapshot_id 机制）。
  - 设计边界（已确认，勿改）：**注入源保持 CME 自己 SQLite 为特性**，不做宿主记忆库注入；注入前去重维持字符串级（seenKeys），入库侧三级语义去重（精确 hash → 文本相似度 → 向量去重）已承担主责。

## 开发规范

阅读 [AGENTS.md](AGENTS.md) / [CODEX_DEVELOPMENT_INSTRUCTIONS.md](CODEX_DEVELOPMENT_INSTRUCTIONS.md) / [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 参考

- 旧项目 Character Memory System：https://github.com/liqiming-whu/character-memory-system（UI/字段参考）
- Operit：https://github.com/AAswordman/Operit（ToolPkg API）
- dual-life-hub（worker + SQLite + JSON payload 参考）

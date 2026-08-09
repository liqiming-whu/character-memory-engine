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
nohup /root/character_memory_engine/.venv/bin/python3.12 /root/character_memory_engine/worker.py \
  --port 8765 --db /root/character_memory_engine/engine.db &
```
> 依赖只装进**项目 venv**（`/root/character_memory_engine/.venv`，由「安装依赖」按钮经 `python3 -m venv` 创建），不再写入系统 python。

### 已知问题与解决方案

#### 1. 首次或重启 Operit 后进入插件，worker 拉起时会卡顿
- **现象**：Operit 刚启动（或重启后）首次进入插件界面，可能出现短暂卡顿 / 加载转圈 / 工具调用延迟。
- **原因**：worker 是常驻进程（proot Ubuntu 内），Operit 重启后需要重新拉起；`onAppCreate` 延迟 10s 后自动提交启动脚本（`start_worker.sh` 后台执行，加载模型约数秒），期间进入插件触发的工具调用会先走 `health 先检 → 租约单飞 → 轻提交 → 轮询就绪` 链路，首次拉起耗时为模型加载时间，UI 表现为卡顿。
- **解决方案**：
  1. **正常等待即可**：worker 拉起是自愈的，`pollWorkerReady` 最多轮询 45s，就绪后后续调用秒回；首次进入卡顿是单次性的，之后进入均直连常驻 worker。
  2. **避免启动后立刻进入**：重启 Operit 后等 10~15s 再打开插件，通常已自动拉起完成（`onAppCreate` 路径）。
  3. 若卡顿超过 45s 且提示「worker 45s 内未就绪」，按下方问题 2 排查坏会话。

#### 2. 坏会话导致 worker 拉起失败
- **现象**：Operit 重启后偶发首次 `hiddenExec` 提交挂起（20s+），worker 无法拉起，工具报 `TERMINAL_CHANNEL_UNAVAILABLE` 或一直转圈。
- **原因**：Operit 重启早期 terminal executor 会话存在竞态，可能创建**坏会话**（残留跨启动）；坏会话上的命令永久挂起，导致提交/探测卡死（11 轮实验实锤：卡死 4/4 全残留、正常 7/7 无残留）。
- **⚠️ 打开终端页面无效**（2026-08-10 实测）：hiddenExec 会话不在终端页面的会话列表里，**看不到坏会话、也无法清理**——旧建议不成立，请勿依赖。
- **解决方案（按推荐顺序）**：
  1. **【不重启】途径 A：/proc 定位并清理坏会话**（2026-08-10 实测有效，无需重启）
     - 定位：`for p in /proc/[0-9]*; do c=$(tr '\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in *proot*) echo "$p";; esac; done` 列出 proot 实例，再逐实例找子进程 `/bin/bash -lc 'echo LOGIN_SUCCESSFUL; echo TERMINAL_READY; eval "$COMMAND_TO_EXEC"'`（hiddenExec 会话）
     - 识别坏会话：子 shell（`bash --noprofile --norc` 或 `bash -il`）状态为 S + `wchan` 为 `pipe_read` / `do_select`（卡在管道/IO 等待）
     - 清理：`kill -9 <子shell> <bash会话> <对应proot>`（先杀子 shell 再杀 bash 再杀 proot）；Operit 会自动重建新 proot 与 hiddenExec 会话
     - 收尾：删除 `logs/channel_broken.json` / `logs/launch_blocked_until` / `logs/launch_lease.json`（清除熔断与保护窗口），再调用任一工具触发拉起
     - **验证恢复（2026-08-10 实机记录）**：清理前 cold_probe 显示 T1（提交）后无 T2/T3（挂起）；清理并清熔断后，再次调用工具触发拉起，cold_probe 出现 **T1→T3（脚本内）→T4/T5（worker 启动 pid）→T6（就绪）** 完整链路，start_worker.log 记录 `launched`——以 T3 是否出现为 hiddenExec 通道恢复的标志
  2. **【不重启】途径 B：绕过 hiddenExec 直接拉起 worker**（2026-08-10 实测有效）
     - worker 是 HTTP 常驻服务（127.0.0.1:8765），不依赖 hiddenExec 通道
     - 执行：`LAUNCH_ID=L_manual_$(date +%s) setsid nohup bash /root/character_memory_engine/start_worker.sh </dev/null >> /sdcard/Download/Operit/character_memory_engine/logs/start_worker.log 2>&1 &`
     - 验证：`curl -X POST http://127.0.0.1:8765 -d '{"action":"ping_worker","params":{}}'` 返回 pong
     - 收尾：删除熔断/保护窗口/租约三文件（同上），插件 health 先检即直连已在线 worker
  3. **重启 Operit**：最可靠但最重——`onAppCreate` 会清除熔断标记并重新拉起；重启后等待 10~15s 再进入插件。
  4. **等待熔断冷却过期**：会话级熔断 60s 冷却后自动允许重试一次；若坏会话仍残留，重试可能再次失败（仅作兜底，不主动依赖）。

### 已知限制与运维
- **自动拉起 Worker**：`onAppCreate` 自动拉起，无需手动干预——hiddenExec 环境实为 Operit 内置 proot Ubuntu（root，python3.12 + venv 可用），拉起脚本经 `setsid` 后台分离。**注意：Operit 重启早期调用 hiddenExec 存在 executor 会话竞态风险**（实测数秒后即可正常拉起；`onAppCreate` 延迟 10s 是保守兜底，并非 Ubuntu 实际需要初始化这么久），提前调用可能创建坏会话导致卡死/闪退。
- **hiddenExec 会话策略**：固定 executorKey `cme`（永远复用 1 个会话，零膨胀）+ `Promise.race` 硬超时；卡死超时报错不建新会话；每次拉起强制 `freshKey` 全新会话，坏会话绝不复用。
- **部署状态自检**：`deploy_status` 走 `/proc` 遍历（不依赖 pgrep，proot/Termux 通用）。
- **调试广播**（需 `--user 0`）：
  - `am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_INSTALL_TOOLPKG --es package_name com.operit.character_memory_engine --es file_path <toolpkg绝对路径> --ez reset_subpackage_states false`
  - `am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_REFRESH_PACKAGES --ez reactivate_active_packages true`

## 当前版本：初始化竞态修复

**修复目标**：Operit 前端"JS 模块重载 + 工具调用初始化竞态"导致的**空加载（白屏）/ 卡"正在读取" / "未识别角色卡"** 三类问题。

**两层竞态**：
1. **第一层（已解决）**：Operit 重启早期 hiddenExec executor 会话竞态 → `onAppCreate` 延迟 10s + `ensureWorkerUp` freshKey 自愈
2. **第二层（已解决）**：每次进入插件界面重新执行整个 JS 模块 + 新模块早期工具调用约 2/3 概率返回"成功但空壳" + useState key 部分持久化失效 + 空壳覆盖已有数据 + 并发乱序

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
- **自动拉起**：重启 Operit 后 `onAppCreate` 秒级拉起 worker，无需手动干预（hiddenExec 固定会话 + setsid 后台分离）
- **AI 自动提取四类角色记忆**：worker `analyze_chat` 调 DeepSeek 自动提取角色信息/关系/偏好/互动规则，四类 8 条验证落库
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
- [x] P7 剩余优化（v2.2.0 已完成：P1-3 setEnv 兜底持久化、P1-4 缓存优先后台刷新、P1-5 requestId 防旧覆盖，见根因文档第五节与 CHANGELOG.md v2.2.0）
- [x] P8 注入优化（v2.2.0 已完成并真机端到端验证，方案参考 https://github.com/liqiming-whu/character-memory-system）：
  - ① 技术降权排序：注入拼装处按 importance 加权（high=1000/medium=500/low=100），标题或正文命中 `TECH_RE = /技术|调试|bug|报错|error|修复|配置|接口|API/` 再降 -60，开发记录类记忆沉底，人物/生活记忆优先浮出（实测：问"我的习惯"时"熟悉Python"沉底、生活习惯类浮出）；
  - ② snapshot 跨轮去重：worker `search_memories` 增加可选参数 `exclude_ids`；main.js 注入成功后按 chatId 记录本次注入的记忆 id 到 `memory_injection_history.json`（超 50 条截断保留最近），下次注入读取并传入 `exclude_ids`，同一会话已注入过的记忆不再重复注入（等价宿主 query_memory 的 snapshot_id 机制；实测三轮消息注入 9 条零重复）；
    - **开关（v2.2.1）**：配置项 `allowRepeatedMemorySearch`（对齐官方 message_insert，默认 false=去重）：false 时按会话 id 排除已注入记忆；true 时每次全量重新检索（允许重复）。UI 设置面板「允许重复检索」开关（正语义直接绑定，无取反）。⚠️ UI 传参必须用与工具声明一致的下划线键 `allow_repeated_memory_search`（驼峰键会被 callTool 参数处理弄丢，曾导致开关保存失效）。
-    - **兜底（v2.2.1）**：worker 排除后候选不足 limit 时从最早注入的记忆开始释放（按相似度补回），保证注入永不返回空（角色库 22 条 < 历史累积量时不再 0 条）；新记忆优先、旧记忆轮换复用。
-    - **随消息保存（v2.2.1）**：persist=true 时新增 `onPromptInput`（before_process）把注入内容直接拼进消息文本（随消息落库、不走附件）；persist=false 时保持 finalize 附件注入（只给模型看不落库）；两阶段互斥防双份。
  - ③ 语义检索候选池修复（v2.2.0 附带）：向量召回 `k=limit*3` 太小导致全局技术噪音霸占近邻名额、角色库记忆被挤出（排除已注入后候选为空 → 注入 0 条），改为全量取回 `k=max(limit*50, 200)` 再做角色过滤。
  - 设计边界（已确认，勿改）：**注入源保持 CME 自己 SQLite 为特性**，不做宿主记忆库注入；注入前去重维持字符串级（seenKeys），入库侧三级语义去重（精确 hash → 文本相似度 → 向量去重）已承担主责。

## 开发规范

阅读 [AGENTS.md](AGENTS.md) / [CODEX_DEVELOPMENT_INSTRUCTIONS.md](CODEX_DEVELOPMENT_INSTRUCTIONS.md) / [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

## 参考

- 旧项目 Character Memory System：https://github.com/liqiming-whu/character-memory-system（UI/字段参考）
- Operit：https://github.com/AAswordman/Operit（ToolPkg API）
- dual-life-hub（worker + SQLite + JSON payload 参考）

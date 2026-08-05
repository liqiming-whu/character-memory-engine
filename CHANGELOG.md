# Changelog

## v2.1.0（2026-08-05）

### 核心功能：AI 自动提取角色四类记忆
- worker `analyze_chat` 调用 DeepSeek（deepseek-v4-flash）自动提取**角色信息 / 关系记忆 / 偏好 / 互动规则**四类记忆，写入 SQLite（带角色 character_id、source=ai_role）
- 对话截断窗口 6000 → 10000（前后各保留），覆盖对话中段的角色口述素材（此前被"中段省略"吃掉导致四类提取不到）
- max_tokens 4096 → 8192 → 16384（实测 deepseek-v4-flash 接受，AI 输出不再被截断）
- **版本不同步根治**：deployWorkerToData 的 copy `overwrite=false` → `true`（/root 旧 worker 永不覆盖的问题）；onAppCreate 增加版本检查（文件 VERSION vs 运行进程版本不一致则 kill 重启）
- 提取结果验证：四类 8 条全部落库（character 2 / relationship 3 / preference 1 / interaction_rule 2）

### UI 修复（角色页 + 全局）
- 分类 chip：点击已选中=取消、默认全不选展示全部四类（不含六类）、切换**前端过滤秒切（零工具调用）**
- **假"正在读取"兜底**：数据已就绪但 loading 残留 true 时强制清除刷新（Operit 相同值 setState 不触发重渲染导致界面卡住）
- 角色页 persona：优先使用 screen 传入角色 + 共享 persona 缓存（60 秒）+ 未就绪时显示"正在识别角色…"而非报错
- 守卫时间戳化：`dataLoadedState` / `memoryLoadedState` 改为 60 秒过期时间戳，跨重启残留自动失效（此前残留 true 导致"以为加载过但数据为空"）
- 数据型 tab（总览/待办/时间线）未就绪时显示"正在加载数据…"占位，不再裸空白
- 渲染死循环根治：5 处无条件 setState 加"值相同则跳过"
- 分类切换竞态、跨重启残留锁（contextLoadingRef / loadedForRef / analyzing）加时间戳过期
- 工具调用超时提示改为"后台仍在进行"（Operit 工具调用约 12 秒超时，worker 实际 30-80 秒完成）

### 性能实测（无瓶颈）
- 后端 SQLite 查询：单次 7-46ms；四次分类查询合计约 97ms；一次全量查询 14ms
- 工具调用（插件内 HTTP + worker，60 次实测）：最快 6ms / 最慢 38ms / **平均 16.8ms**
- 分析链路实测：短对话 13.5s 成功、2 万字符长对话 15s 成功
- **结论：后端与工具调用层无性能瓶颈**

### 工具链可行性
- 完整链路跨平台验证通过：Operit 插件（UI/subpackage）→ HTTP 桥接 → Python worker（proot Ubuntu 24）→ SQLite
- Android 真机 + Ubuntu 子系统双向可用，无需外部服务器

### 疑难问题（待解决，低优先级）
- [ ] 界面加载优化：**未识别角色卡 / 正在读取 / 读取失败 / 界面数据未加载为空**
  - 现象：退出插件界面再进入时，角色页偶发"未识别到角色卡"或"正在读取"，其他 tab 偶发空白；过一会儿 / 切 tab / 重进可恢复
  - 疑似 Operit 平台层：useState/useRef 跨重启持久化、onLoad 异步竞态、相同值 setState 不触发重渲染、工具调用调度层开销
  - 已做缓解（共享缓存 / 时间戳守卫 / 占位 / 自动重试），残余问题暂不深挖
- [ ] 前端状态管理重构（外部审查建议，P6 方案参考）：
  - 已归档两份外部审查：`docs/Character_Memory_Frontend_Source_Review.md`（生命周期/竞态/多状态源分析）与 `docs/Character_Memory_Engine_review_notes.md`（架构评价与优化优先级）
  - 核心建议：统一状态管理（MemoryController 单一状态源，页面只做展示）、状态机化（INITIALIZING/WORKER_READY/LOADING/READY/EMPTY/ERROR）、区分 `null`（未加载）与 `[]`（已加载但为空）、延迟分析任务至空闲期、保留 executor 启动保护
  - 结论：后端无性能瓶颈，问题集中在 Operit 启动生命周期适配与前端状态管理；不继续修改后端架构
- 后续方向：**恶性 bug 与功能问题优先**

### 调试设施
- `makeTool` 计时探针（保留）：每次工具调用记录 `[timing] action ms=xx` 到 `logs/dbg_call.log`，用于性能与故障定位；开销毫秒级

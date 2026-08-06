# ToolPkg 开发说明（实战版）

本项目为运行于 Operit 的 ToolPkg 插件（自建记忆引擎，独立 SQLite，不依赖官方 Memory 数据库）。

## 权威来源
- Operit 源码：https://github.com/AAswordman/Operit
- 本地开发：`/sdcard/Download/Operit/dev_package/Character-Memory-Engine/`（git 仓库，.git 在 /root/git-dirs/，工作区用 gitfile 指向）
- API 判断：上游源码 > examples/types > 实际运行时行为

## Operit 集成协议（源码级结论，踩坑换来的）

### 1. subpackage 返回必须带 `data` 字段
- UI 侧 `ctx.callTool` 的返回处理（`JsInitRuntimeScriptBuilder.kt` 的 `parseToolResult`）：
  - **成功**：只返回 `result.data`；没有 `data` 字段 → UI 拿到 `undefined` → 显示"未知错误"
  - **失败**：抛异常，异常信息取 `result.message`
- 因此 subpackage 工具成功必须返回 `{success:true, data:<结果>, message:'...'}`；失败返回 `{success:false, message:'...'}`
- 本项目统一在 `finish()` 里包装：成功时 `{success:true, data:result, message:'OK'}`

### 2. UI 的 `ctx.callTool` 返回 JSON 字符串
- compose_dsl UI 里 `ctx.callTool` 实际返回 **JSON 字符串**（不是对象）
- 必须 `JSON.parse` 后再用；本项目 `shared.js` 的 `parseResult` 统一处理：
  - 字符串 → JSON.parse
  - 解析结果若带 `success` + `data` → 解包一层（兼容 subpackage 包装）

### 3. complete() 与 return 双路径
- `JsEngine.kt`：脚本中出现 `complete(` 调用时 `waitsForExplicitComplete=true`，等待 `complete()` 被调用才返回；否则取函数 return 值
- 稳妥写法：`try { complete(result); } catch(e) {} return result;`（双保险）
- `normalizeComposeResult` 只处理 `{composeDsl:{screen:...}}` 特殊结构，普通结果原样透传

### 4. hiddenExec 终端环境与执行模型（v1.0.6 探针实证）
- `Tools.System.terminal.hiddenExec` 跑在 **Operit 内置 proot Ubuntu（root）**：`/usr/bin/python3`（3.12.3）与 `/root/.venv/bin/python3.12` 均可用；`ps`/`pgrep` 不存在（procps 未装）→ 进程检测一律用 `/proc` 遍历
- **会话按 executorKey 持久复用**（proot + bash，`eval "$COMMAND_TO_EXEC"` 执行）：卡死命令会永久锁死该会话，后续同 key 命令排队等待；`timeoutMs` 对排队无效（命令尚未开始执行）
- **Operit 每次工具调用会重新加载 JS 模块**：模块级变量不保留 → 会话 key 必须用常量，不能用模块变量（曾因此每轮新建会话导致 proot 实例爆炸、Operit 闪退）
- **推荐策略（v2.0.17）**：固定 key 常量（永远复用 1 个会话，零膨胀）+ `Promise.race` 硬超时（与调用方超时对齐；超时直接报错、不建新会话）；会话真被污染时重启 Operit 即恢复
- **⚠️ 禁用 default 会话**：不传 executorKey 走 `default` 会话。default 被多个包共享，一旦被某包卡死命令污染 → 所有走 default 的命令都阻塞（探测时好时坏、命令假死都是这个症状）。必须用**自定义固定 key**（本项目用 `cme`）
- **⚠️ Operit 重启早期 hiddenExec 会话竞态（v2.0.20）**：实测 Operit 重启后**数秒内**调用 hiddenExec 可能触发 executor 会话竞态，创建坏会话 → 后续所有调用永久卡 → 转圈 → ANR 闪退；`onAppCreate` 延迟 30s 是**保守兜底**（并非 Ubuntu 实际需要初始化这么久，数秒后即可正常拉起）。`ensureWorkerUp` 每次强制 `freshKey` 全新会话（坏会话绝不复用，自愈不依赖 Operit 重启）。症状：重启后立即卡死/闪退——先怀疑启动初期调用
- **⚠️ 第二层竞态：UI 工具调用环境初始化（v2.1.2 实验实锤，v2.1.3~v2.1.7 已解决）**：Operit **每次进入插件界面会重新执行整个 JS 模块**（globalThis 计数器归零实证）；新模块执行早期的 `ctx.callTool` 约 2/3 概率返回"成功但空壳"响应（`success=true` 但 `extracted=无` / `chars=0`，2-23ms 快速返回，非真实查询失败）。已解决第一层（worker 拉起）不等于 UI 层就绪。防御已落地：① 空结果绝不覆盖非空状态（v2.1.3 守卫）；② 失败自驱重试直到返回非空（v2.1.5，纯 setTimeout 盲等无效——实测延迟 5s 后首次调用仍可能空壳）；③ action 链渲染窗口（v2.1.6/v2.1.7）。详见 `docs/INIT_RACE_ROOT_CAUSE_AND_FIX_PLAN.md`
- **⚠️ UI 渲染模型：action 驱动渲染（v2.1.6 源码级实锤）**：Operit compose_dsl UI 树只在 ①初始渲染 ②action 分发 ③文本输入同步 ④显式 rerender（`__operit_rerender_compose_dsl`）时重建。**异步 setState（Promise/setTimeout 回调）只写 stateStore，不触发 UI 重绘**；但 **action 分发期间（Promise pending）会订阅 stateChange → setState 触发"中间渲染"实时推送，action 完成后订阅取消**。症状：数据层全恢复但界面卡"正在读取"；"点重载/切 tab（走 action 链）有效、自动加载卡死（setTimeout 不在 action 链）"。修复模式：**让关键加载进入 action 链窗口**——onLoad/tab onClick 改为 async handler + `await 600ms` 保持订阅窗口（v2.1.6/v2.1.7）
- **⚠️ 相同值 setState 不触发重渲染**：`dataLoadedState[1](0)` 这类相同值写入不会触发 render → 依赖 render 的重试机制会冻结（无用户操作则永不恢复）→ 必须失败自驱：失败后自行 setTimeout 排队下一次（v2.1.5 已验证）
- **返回值解析**：hiddenExec 返回结构不稳定（string / stdout / data 对象均可能出现）→ 解析需覆盖 `stdout/output/body/result/text/data`，最后 `JSON.stringify` 兜底（曾因缺 data 处理导致 python 探测时好时坏）
### 4.5 bash 拼接大坑（`&;` 语法错误）
- 脚本用 `.join('; ')` 拼接时，若某元素以 `&` 结尾、下一元素独立 → 生成 `... &; echo ...` → **bash 语法错误（rc=2），整个 eval 直接失败**，后台命令从未执行、无任何报错痕迹
- 正确写法：后台命令与后续命令合并为同一数组元素：`"setsid " + pyCmd + " ... < /dev/null & echo started"`
- 症状参考：ensureWorkerUp 返回"拉起后 worker 仍未响应"且 engine.log 无任何新记录——先怀疑这类拼接错误

### 5. 调试广播（重装/刷新不用重启 Operit）
```bash
# 安装/覆盖指定包
am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_INSTALL_TOOLPKG \
  --es package_name com.operit.character_memory_engine \
  --es file_path /storage/emulated/0/Android/data/com.ai.assistance.operit/files/packages/com-operit-character-memory-engine-v2.0.17.toolpkg \
  --ez reset_subpackage_states false

# 刷新 packages（只重扫，不保证重装已缓存包）
am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_REFRESH_PACKAGES --ez reactivate_active_packages true
```
注意：必须 `--user 0`（否则 SecurityException）；实际可靠重载仍是重启 Operit。

### 6. 其他坑
- `Tools.Files.append` 不存在 → 用 `Tools.Files.write(path, content, true, 'android')`
- manifest 的 `subpackages` 声明是 subpackage 注册的唯一入口（id + entry + enabled_by_default）
- main.js 需导出 `registerToolPkg` / `onAppCreate`（Operit 旧版要求 `registerAppLifecycleHook` 模块级导出，新版兼容 API 注册）
- **hook 处理函数必须模块级导出**（v2.1.9 实锤）：`registerPromptInputHook` 注册后，对应处理函数必须 `exports.onPromptInput = onPromptInput` 显式导出；漏导出会报 `Script error: registerPromptInputHook function must be exported from a toolpkg module` 导致**整包 Failed to parse toolpkg**（不只是该 hook 失效）
- **包解析失败看 package log**（v2.1.9 实锤）：Operit 把包解析错误写到 `/sdcard/Download/Operit/packageLogs/` 下带时间戳的 log（如 `20260806_195921_997.log`），取最新一个直接看根因；logcat 里通常没有 ToolPkg 错误输出，别在 logcat 上浪费时间
- pgrep 在 proot 可能不存在 → 进程检测用 `/proc` 遍历（`_find_worker_processes`）
- Android 存储层 `.l2s` 懒写入会破坏 git 写对象 → `.git` 放 /root（ext4），工作区 gitfile 指向

## 构建与发布
```bash
# 打包（排除 .git/dist/包/db/log）
cd /sdcard/Download/Operit/dev_package/Character-Memory-Engine
zip -rq ../com-operit-character-memory-engine-v2.0.3.toolpkg . \
  -x '.git/*' -x '*.toolpkg' -x 'dist/*' -x '*.db' -x '*.db-wal' -x '*.db-shm' -x '*.log'

# 安装（三处部署位，缺一不可）
cp ../com-operit-character-memory-engine-v2.0.3.toolpkg \
  /sdcard/Download/Operit/packages/
cp ../com-operit-character-memory-engine-v2.0.3.toolpkg \
  /sdcard/Download/Operit/files/packages/
cp ../com-operit-character-memory-engine-v2.0.3.toolpkg /sdcard/Download/

# ⚠️ 部署铁律：清旧包 + 清缓存（否则 Operit 扫描可能加载旧版）
rm -f /sdcard/Download/Operit/packages/*v2.0.2*.toolpkg   # 删除所有旧版本包
rm -rf /data/user/0/com.ai.assistance.operit/files/toolpkg_cache/*
rm -rf /data/user/0/com.ai.assistance.operit/cache/*
# 重启 Operit 生效
```
- **版本残留自检**：`find /sdcard/Download -name '*旧版本号*' | head` 应为空；`toolpkg_cache` 和 app cache 必须清空
- **worker.py 同步部署**：改 worker 后需同步 `/root/character_memory_engine/worker.py` 并重启进程（`pkill -f 'character_memory_engine/worker.py'` + nohup 拉起）

## Operit Compose DSL 铁律（v1.6.9 实战验证）

> 来源：character-memory-system v1.6.8 定位的根因——render 阶段调用 state setter（即使写入相同值）会触发 XML 重建闭环：render -> setState -> 重渲染 -> 新 XML -> liveXmlContent 变化 -> LaunchedEffect 重启 -> 无限 remount（每秒数百次，整机卡死/闪退）。

**Rule 1：render() 必须无副作用。**
禁止在 render、UI 构造函数、节点生成阶段调用任何 state setter（`xxxState[1](...)`）、加载函数（`loadOnEnter()` 等）、文件写入。

**Rule 2：数据同步只发生在 action / onLoad 生命周期。**
数据由 screen 根 onLoad 加载（setTimeout 调度亦可），通过 props 传入子组件 render；render 只读 props 渲染。

**Rule 3：子组件渲染体不反向修正 state。**
父组件已传入的数据，子组件不得在渲染体里写回自己的 state（`personaState[1](personaFromScreen)` 这类同步是循环引信）。

**Rule 4：事件回调内的 setState 安全。**
用户触发的 onClick / onValueChange 里的 setter 不构成渲染循环，可正常使用。

**验证方法**：渲染体探针（mount 在函数入口、mount2 在 return 前）1:1 且每秒数百次 = 平台层循环；此时检查渲染体内是否调用了 setter。

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

### 4. 终端环境限制（关键）
- Operit 内置 `Tools.System.terminal` 跑在 **Android 原生 shell**：无 python3、无 /root、无法直接访问 proot rootfs
- 手动拼 `proot` 命令在 untrusted_app 下会报 "foreign binary"（SELinux 拦 /proc 架构探测）
- **自动拉起 worker 的正解是 Termux**：`/data/data/com.termux/files/usr/bin/python3`（Android 原生可执行）
- 未装 Termux 时：proot 会话（super_admin terminal）手动拉起

### 5. 调试广播（重装/刷新不用重启 Operit）
```bash
# 安装/覆盖指定包
am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_INSTALL_TOOLPKG \
  --es package_name com.operit.character_memory_engine \
  --es file_path /storage/emulated/0/Android/data/com.ai.assistance.operit/files/packages/com-operit-character-memory-engine-v2.0.3.toolpkg \
  --ez reset_subpackage_states false

# 刷新 packages（只重扫，不保证重装已缓存包）
am broadcast --user 0 -a com.ai.assistance.operit.DEBUG_REFRESH_PACKAGES --ez reactivate_active_packages true
```
注意：必须 `--user 0`（否则 SecurityException）；实际可靠重载仍是重启 Operit。

### 6. 其他坑
- `Tools.Files.append` 不存在 → 用 `Tools.Files.write(path, content, true, 'android')`
- manifest 的 `subpackages` 声明是 subpackage 注册的唯一入口（id + entry + enabled_by_default）
- main.js 需导出 `registerToolPkg` / `onAppCreate`（Operit 旧版要求 `registerAppLifecycleHook` 模块级导出，新版兼容 API 注册）
- pgrep 在 proot 可能不存在 → 进程检测用 `/proc` 遍历（`_find_worker_processes`）
- Android 存储层 `.l2s` 懒写入会破坏 git 写对象 → `.git` 放 /root（ext4），工作区 gitfile 指向

## 构建与发布
```bash
# 打包（排除 .git/dist/包/db/log）
cd /sdcard/Download/Operit/dev_package/Character-Memory-Engine
zip -rq ../com-operit-character-memory-engine-v2.0.3.toolpkg . \
  -x '.git/*' -x '*.toolpkg' -x 'dist/*' -x '*.db' -x '*.db-wal' -x '*.db-shm' -x '*.log'

# 安装
cp ../com-operit-character-memory-engine-v2.0.3.toolpkg \
  /storage/emulated/0/Android/data/com.ai.assistance.operit/files/packages/
# 重启 Operit 生效
```

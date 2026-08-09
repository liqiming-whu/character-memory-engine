"use strict";
/*
METADATA
{
    "name": "memory_engine",
    "display_name": { "zh": "角色记忆引擎工具", "en": "Character Memory Engine Tools" },
    "description": { "zh": "SQLite 记忆 CRUD、语义去重、语义检索（经 Worker HTTP 桥接）", "en": "SQLite memory CRUD, semantic dedup, semantic search via Worker HTTP" },
    "tools": [
        { "name": "list_memories", "description": { "zh": "列出记忆", "en": "List memories" }, "parameters": [
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID；传则隔离，不传仅通用记忆" },
            { "name": "category", "type": "string", "required": false, "description": "分类过滤" },
            { "name": "query", "type": "string", "required": false, "description": "关键词模糊搜索" },
            { "name": "limit", "type": "integer", "required": false, "description": "最大返回数，默认100" },
            { "name": "offset", "type": "integer", "required": false, "description": "偏移" },
            { "name": "include_deleted", "type": "boolean", "required": false, "description": "包含软删除" }
        ]},
        { "name": "get_memory", "description": { "zh": "获取单条记忆", "en": "Get single memory" }, "parameters": [
            { "name": "id", "type": "integer", "required": true, "description": "记忆ID" }
        ]},
        { "name": "create_memory", "description": { "zh": "新建记忆（含语义去重）", "en": "Create memory (with semantic dedup)" }, "parameters": [
            { "name": "category", "type": "string", "required": true, "description": "分类" },
            { "name": "title", "type": "string", "required": false, "description": "标题" },
            { "name": "content", "type": "string", "required": false, "description": "内容" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "update_memory", "description": { "zh": "更新记忆", "en": "Update memory" }, "parameters": [
            { "name": "id", "type": "integer", "required": true, "description": "记忆ID" }
        ]},
        { "name": "delete_memory", "description": { "zh": "软删除记忆", "en": "Soft delete memory" }, "parameters": [
            { "name": "id", "type": "integer", "required": true, "description": "记忆ID" }
        ]},
        { "name": "search_memories", "description": { "zh": "语义检索记忆", "en": "Semantic search memories" }, "parameters": [
            { "name": "query", "type": "string", "required": true, "description": "检索词" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" },
            { "name": "category", "type": "string", "required": false, "description": "分类过滤" },
            { "name": "limit", "type": "integer", "required": false, "description": "最大返回数，默认20" }
        ]},
        { "name": "load_life_data", "description": { "zh": "加载六类生活数据", "en": "Load six life data categories" }, "parameters": [
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "upsert_life_item", "description": { "zh": "新增/更新六类条目", "en": "Upsert life data item" }, "parameters": [
            { "name": "category", "type": "string", "required": true, "description": "分类" },
            { "name": "item", "type": "object", "required": true, "description": "条目对象" },
            { "name": "index", "type": "integer", "required": false, "description": "更新索引" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "delete_life_item", "description": { "zh": "删除六类条目（id 优先；无 id 时按 index）", "en": "Delete life data item (id first, fallback index)" }, "parameters": [
            { "name": "category", "type": "string", "required": true, "description": "分类" },
            { "name": "id", "type": "integer", "required": false, "description": "条目ID（推荐，精确删除）" },
            { "name": "index", "type": "integer", "required": false, "description": "索引（无 id 时使用）" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "toggle_todo", "description": { "zh": "切换待办状态（id 优先；无 id 时按 index）", "en": "Toggle todo status (id first, fallback index)" }, "parameters": [
            { "name": "id", "type": "integer", "required": false, "description": "待办ID（推荐）" },
            { "name": "index", "type": "integer", "required": false, "description": "索引（无 id 时使用）" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "list_characters", "description": { "zh": "列出角色", "en": "List characters" }, "parameters": []},
        { "name": "save_character", "description": { "zh": "保存角色", "en": "Save character" }, "parameters": [
            { "name": "id", "type": "string", "required": true, "description": "角色卡ID" },
            { "name": "name", "type": "string", "required": true, "description": "角色名" }
        ]},
        { "name": "get_relationship", "description": { "zh": "获取关系", "en": "Get relationship" }, "parameters": [
            { "name": "character_id", "type": "string", "required": true, "description": "角色卡ID" },
            { "name": "target", "type": "string", "required": true, "description": "关系对象" }
        ]},
        { "name": "import_legacy_backup", "description": { "zh": "从旧版本备份导入数据（ZIP或目录），幂等", "en": "Import data from legacy backup (zip or dir), idempotent" }, "parameters": [
            { "name": "path", "type": "string", "required": true, "description": "备份ZIP路径或目录" },
            { "name": "character_id", "type": "string", "required": false, "description": "导入到指定角色；不传则通用" }
        ]},
        { "name": "deploy_status", "description": { "zh": "检查部署状态（进程/依赖/模型）", "en": "Check deployment status" }, "parameters": [
            { "name": "db", "type": "string", "required": false, "description": "数据库路径" },
            { "name": "port", "type": "integer", "required": false, "description": "端口" }
        ]},
        { "name": "deploy_install", "description": { "zh": "安装缺失依赖", "en": "Install missing dependencies" }, "parameters": []},
        { "name": "deploy_restart", "description": { "zh": "杀掉多余 worker 进程", "en": "Kill duplicate worker processes" }, "parameters": []},
        { "name": "save_ui_state", "description": { "zh": "保存界面状态", "en": "Save UI state" }, "parameters": [
            { "name": "state_json", "type": "string", "required": true, "description": "界面状态JSON" }
        ]},
        { "name": "analyze_chat", "description": { "zh": "AI 分析对话并提取结构化记忆", "en": "AI analyze chat and extract structured memory" }, "parameters": [
            { "name": "chat_id", "type": "string", "required": false, "description": "对话ID；不传取最近对话" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" },
            { "name": "persona_name", "type": "string", "required": false, "description": "角色名" }
        ]},
        { "name": "backup_engine", "description": { "zh": "导出引擎备份（SQLite+配置 ZIP）", "en": "Export engine backup (SQLite + config ZIP)" }, "parameters": [
            { "name": "reason", "type": "string", "required": false, "description": "备份原因" }
        ]},
        { "name": "inspect_engine", "description": { "zh": "校验引擎备份", "en": "Validate engine backup" }, "parameters": [
            { "name": "path", "type": "string", "required": true, "description": "备份ZIP路径" }
        ]},
        { "name": "restore_engine", "description": { "zh": "从引擎备份恢复", "en": "Restore from engine backup" }, "parameters": [
            { "name": "path", "type": "string", "required": true, "description": "备份ZIP路径" },
            { "name": "mode", "type": "string", "required": false, "description": "merge 或 overwrite" }
        ]},
        { "name": "save_relationship", "description": { "zh": "保存关系", "en": "Save relationship" }, "parameters": [
            { "name": "character_id", "type": "string", "required": true, "description": "角色卡ID" },
            { "name": "target", "type": "string", "required": true, "description": "关系对象" },
            { "name": "stage", "type": "string", "required": false, "description": "关系阶段" },
            { "name": "notes", "type": "string", "required": false, "description": "备注" }
        ]},
        { "name": "ping_js", "description": { "zh": "纯 JS 诊断探针（不经 worker、不调 ensureWorkerUp，用于区分平台 Tool 通道阻塞与 CME 内部传播）", "en": "Pure JS diag probe (no worker), distinguish platform channel block vs CME internal propagation" }, "parameters": [
            { "name": "q", "type": "string", "required": false, "description": "任意标识" }
        ]},
        { "name": "ping_worker", "description": { "zh": "检查 worker 是否可用", "en": "Check worker availability" }, "parameters": []},
        { "name": "get_logs", "description": { "zh": "读取日志文件尾部", "en": "Read log tail" }, "parameters": [
            { "name": "limit", "type": "integer", "required": false, "description": "返回行数，默认 300（UI 加载 300，页面渲染显示最近 100）" },
            { "name": "level", "type": "string", "required": false, "description": "级别过滤：ERROR/WARN/INFO/DEBUG" },
            { "name": "path", "type": "string", "required": false, "description": "日志文件路径（默认 engine.log）" }
        ]},
        { "name": "diag_engine", "description": { "zh": "插件侧诊断（不经 worker）：进程/启动日志/engine.log", "en": "Diagnose engine without worker" }, "parameters": []},
        { "name": "log_ui", "description": { "zh": "前端诊断日志写文件（不经 worker）", "en": "Frontend diag log to file" }, "parameters": [
            { "name": "line", "type": "string", "required": true, "description": "日志行内容" }
        ]},
        { "name": "trigger_analysis", "description": { "zh": "打开插件时自动检测新对话并后台分析", "en": "Auto detect new messages and analyze in background" }, "parameters": [
            { "name": "chat_id", "type": "string", "required": false, "description": "对话ID；不传取 trigger.json 记录的当前对话" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "get_trigger_result", "description": { "zh": "读取最近一次后台分析的完成结果（文件通道，工具脚本无 setEnv）", "en": "Get last trigger analysis result (file channel)" }, "parameters": []},
        { "name": "set_injection_settings", "description": { "zh": "设置记忆注入配置（启用/持久化/最大条数/是否按会话去重）", "en": "Set memory injection settings" }, "parameters": [
            { "name": "enabled", "type": "boolean", "required": false, "description": "是否启用注入" },
            { "name": "persist", "type": "boolean", "required": false, "description": "是否跨对话持久化" },
            { "name": "max_memories", "type": "integer", "required": false, "description": "每次注入最大条数，默认5" },
            { "name": "allow_repeated_memory_search", "type": "boolean", "required": false, "description": "是否允许重复记忆检索（true=不去重，false=按会话id去重，默认false）" }
        ]}
    ]
}
*/

// ===== HTTP 桥接架构 =====
// worker 以常驻 HTTP 服务运行（python worker.py --port 8765），前端经 Tools.Net.http 调用。
// 不再依赖终端 python3 路径与 /root 可见性；worker 不在线时尝试自动拉起并给出指引。

var WORKER_URL = 'http://127.0.0.1:8765';
try { WORKER_URL = getEnv('MEMORY_ENGINE_WORKER_URL') || WORKER_URL; } catch (e) {}
var DATA_DIR = '/sdcard/Download/Operit/character_memory_engine';
try { DATA_DIR = getEnv('MEMORY_ENGINE_DIR') || DATA_DIR; } catch (e) {}
// worker 运行目录：/root（ext4 稳定，WAL 支持）；db 也在此运行，数据目录保留部署副本
var ROOT_DIR = '/root/character_memory_engine';

// ===== 调试探针（临时）：记录每次工具调用的返回，用于定位 UI "未知错误" =====
var DBG_LOG = '/sdcard/Download/Operit/character_memory_engine/logs/dbg_call.log';
function _localTs() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function dbgLog(action, obj) {
  try {
    var line = _localTs() + ' [' + action + '] ' + JSON.stringify(obj).slice(0, 600) + '\n';
    try { Tools.Files.write(DBG_LOG, line, true, 'android'); }
    catch (e) {
      try {
        var old = Tools.Files.read(DBG_LOG);
        var oldText = (old && (old.content || old.text)) || '';
        Tools.Files.write(DBG_LOG, oldText + line, false, 'android');
      } catch (e2) {}
    }
  } catch (e) {}
}

// ===== 冷启动探针：T0-T8 时间戳（单调时钟+UTC墙钟），写入 cold_probe.log =====
function cmeProbe(tag, extra) {
  try {
    var mono = 0;
    try { if (typeof performance !== 'undefined' && performance.now) mono = Math.round(performance.now() * 10) / 10; } catch (e) {}
    var line = tag + ' wall=' + new Date().toISOString() + ' mono=' + mono;
    if (extra) line += ' ' + extra;
    Tools.Files.write('/sdcard/Download/Operit/character_memory_engine/logs/cold_probe.log', line + '\n', true, 'android');
  } catch (e) {}
}

// 统一收尾：按 Operit 约定包装结果。
// 关键：Operit UI 侧 parseToolResult 成功时只返回 result.data；
// 失败时抛异常（message 取 result.message）。所以成功必须带 data 字段。
function finish(result) {
  var out = result;
  if (result && typeof result === 'object' && typeof result.success === 'boolean') {
    if (result.success) {
      out = { success: true, data: result, message: result.message || 'OK' };
    } else {
      out = { success: false, message: result.message || '操作失败' };
    }
  }
  try { dbgLog('finish', out); } catch (e) {}
  try { complete(out); } catch (e) {}
  return out;
}

function withTimeout(promise, ms, message) {
  var timer;
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error(message || "操作超时。")); }, ms);
    })
  ]).finally(function () { clearTimeout(timer); });
}

// 经 HTTP 调用 worker；worker 不在线时给出可执行的启动指引
async function httpCall(action, payload) {
  var resp;
  try {
    if (!(typeof globalThis !== 'undefined' && globalThis.__cmeT7)) { if (typeof globalThis !== 'undefined') globalThis.__cmeT7 = 1; cmeProbe('T7'); }
    resp = await withTimeout(
      Tools.Net.http({
        url: WORKER_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
        body: JSON.stringify({ action: action, params: payload || {} }),
        connect_timeout: 5,
        read_timeout: 60,
        validateStatus: false
      }),
      70000,
      'worker 调用超时。'
    );
  } catch (e) {
    return { success: false, message: 'worker 未响应（' + WORKER_URL + '）：' + (e && e.message ? e.message : String(e)) + '。启动命令：nohup ' + ROOT_DIR + '/.venv/bin/python3.12 ' + ROOT_DIR + '/worker.py --port 8765 --db ' + ROOT_DIR + '/engine.db &' };
  }
  var text = String(resp && (resp.content || resp.body || '') || '');
  var data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (data && typeof data === 'object') {
    if (resp && resp.statusCode >= 400 && data.success === undefined) {
      data.success = false;
      data.httpStatus = resp.statusCode;
    }
    return data;
  }
  return { success: false, message: 'worker 返回无法解析: HTTP ' + (resp && resp.statusCode) + ' ' + text.slice(0, 200) };
}

// 部署 worker.py / embed.py / models 到 DATA_DIR（用 dual-life-hub 验证的 readResource 签名）。
// readResource JS 签名是 (key, outputFileName, internal)，自动解析当前 toolpkg。
async function deployWorkerToData() {
  try {
    await withTimeout(Tools.Files.mkdir(DATA_DIR, true, 'android'), 8000, '创建数据目录超时。');
    await withTimeout(Tools.Files.mkdir(DATA_DIR + '/models', true, 'android'), 8000, '创建 models 目录超时。');
    // worker.py
    try {
      var wSrc = await ToolPkg.readResource('engine_worker_py', 'worker.py', false);
      // 强制覆盖，避免 /root 残留旧版 worker.py 导致分析/截断修复不生效
      if (wSrc) await Tools.Files.copy(String(wSrc), ROOT_DIR + '/worker.py', true, 'android', 'linux');
    } catch (e) {}
    // embed.py
    try {
      var eSrc = await ToolPkg.readResource('engine_embed_py', 'embed.py', false);
      if (eSrc) await Tools.Files.copy(String(eSrc), DATA_DIR + '/embed.py', false, 'android', 'linux');
    } catch (e) {}
    // models
    var modelFiles = [
      ['engine_model_config', 'config.json'],
      ['engine_model_onnx', 'model_int8.onnx'],
      ['engine_model_tokenizer', 'tokenizer.json']
    ];
    for (var mi = 0; mi < modelFiles.length; mi++) {
      try {
        var mSrc = await ToolPkg.readResource(modelFiles[mi][0], modelFiles[mi][1], false);
        if (mSrc) await Tools.Files.copy(String(mSrc), DATA_DIR + '/models/' + modelFiles[mi][1], false, 'android', 'linux');
      } catch (e) {}
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ===== 会话级熔断（与 main.js 同构，文件通道——工具脚本环境无 setEnv）=====
// 首次 hiddenExec 提交超时 → 写 channel_broken.json（60s 冷却）→ 本次 App 实例内不再重复提交
// 恢复：App 重启 onAppCreate 清除；60s 过期自动允许重试一次；用户打开终端页面后重试
// 内存标志兜底——文件写失败时（第 17 轮实锤 JS 写入早期不可用）本 VM 内后续提交仍立即熔断
var _memBrokenAt = 0;
var CHANNEL_BROKEN_FILE = DATA_DIR + '/logs/channel_broken.json';
function isChannelBroken() {
  // 内存标志优先（本 VM 生命周期内生效）
  if (_memBrokenAt > 0) {
    if (Date.now() - _memBrokenAt > 60000) { _memBrokenAt = 0; return false; }
    return true;
  }
  try {
    var f = Tools.Files.read(CHANNEL_BROKEN_FILE);
    var t = (f && (f.content || f.text)) || '';
    if (!t) return false;
    var j = JSON.parse(t);
    if (!(j && j.broken)) return false;
    if (Date.now() - (j.at || 0) > 60000) { clearChannelBroken(); return false; }
    _memBrokenAt = j.at || Date.now(); // 同步进内存
    return true;
  } catch (e) { return false; }
}
function setChannelBroken() {
  _memBrokenAt = Date.now(); // 内存先行：文件写失败也不丢熔断状态
  try { Tools.Files.write(CHANNEL_BROKEN_FILE, JSON.stringify({ broken: true, at: _memBrokenAt }), false, 'android'); } catch (e) {}
}
function clearChannelBroken() {
  _memBrokenAt = 0;
  try { Tools.Files.deleteFile(CHANNEL_BROKEN_FILE, false, 'android'); } catch (e) {}
}

// 尝试拉起常驻 worker（幂等：已在线则跳过；force=true 时强制完整重启）。
// python 探测优先级：proot venv（含完整向量依赖）> 系统 python3。
async function ensureWorkerUp(force) {
  // v2.4：冷启动保护窗口 + 租约单飞 + 轻提交（hiddenExec 只提交，重活在 start_worker.sh 后台执行）+ health 轮询
  // 修复：旧版 hiddenExec 执行完整重脚本，冷启动时阻塞平台工具通道 30-35s → UI 卡死闪退（2026-08-09 实锤）
  var BLOCK_FILE = DATA_DIR + '/logs/launch_blocked_until';
  try {
    var bf = Tools.Files.read(BLOCK_FILE);
    var bfText = (bf && (bf.content || bf.text)) || '';
    var bfTs = parseInt(bfText, 10) || 0;
    if (bfTs > Date.now() && !force) {
      return { success: false, message: 'worker 拉起进入冷启动保护窗口（' + Math.ceil((bfTs - Date.now()) / 1000) + 's 后自动恢复），请稍候重试。' };
    }
  } catch (e) {}
  // 会话级熔断——首次提交超时后本次 App 实例内不再重复提交（避免同坏通道上排队堆积）
  if (isChannelBroken()) {
    return { success: false, code: 'TERMINAL_CHANNEL_UNAVAILABLE', message: '后台终端通道初始化异常（上次启动失败），请重新启动 Operit 后重试；若仍失败，按 README「已知问题 2」清理残留坏会话。' };
  }
  // ① health 先检（httpCall 通道，快，不占 hiddenExec）
  var ping = null;
  try { ping = await withTimeout(httpCall('ping_worker', {}), 4000, 'ping timeout'); } catch (e) {}
  if (ping && ping.success) return { success: true, alreadyUp: true };
  // ② 部署最新 worker.py 等（JS 层复制，不走 hiddenExec）
  try { await deployWorkerToData(); } catch (e) {}
  // ③ 租约软裁决（跨模块状态落盘）：有效租约 → 不重复启动，直接轮询
  var LEASE = DATA_DIR + '/logs/launch_lease.json';
  var launchId = 'L' + Date.now() + '_' + Math.floor(Math.random() * 100000);
  var now = Date.now();
  try {
    var lf = Tools.Files.read(LEASE);
    var lfText = (lf && (lf.content || lf.text)) || '';
    if (lfText && !force) {
      var lj = null;
      try { lj = JSON.parse(lfText); } catch (e2) {}
      if (lj && lj.expiresAt && lj.expiresAt > now) {
        return await pollWorkerReady(lj.launchId || launchId, 'wait-lease');
      }
    }
  } catch (e) {}
  // ④ 抢租约
  try { Tools.Files.write(LEASE, JSON.stringify({ launchId: launchId, source: 'ensureWorkerUp', createdAt: now, expiresAt: now + 90000 }), false, 'android'); } catch (e) {}
  // ⑤ T1 + 轻提交：hiddenExec 只提交 start_worker.sh（毫秒级返回），重活后台执行
  cmeProbe('T1', 'launchId=' + launchId + ' source=ensure');
  try {
    freshKey();
    var submitCmd = 'LAUNCH_ID=' + launchId + ' nohup setsid bash /root/character_memory_engine/start_worker.sh </dev/null >>' + DATA_DIR + '/logs/start_worker.log 2>&1 & echo launch_submitted';
    // 提交超时 20s→内部5s/外部7s（正常提交 1.1~1.4s，余量充分；挂起时快速失败不拖 UI）
    await withTimeout(hiddenExecSafe(submitCmd, 5000), 7000, '提交启动命令超时。');
  } catch (e) {
    try { Tools.Files.deleteFile(LEASE, false, 'android'); } catch (e2) {}
    // BLOCK 30s→60s + 会话级熔断（ChatGPT 建议：JS 超时不等于 native 取消，过快重试会在坏通道上堆积）
    try { Tools.Files.write(BLOCK_FILE, String(Date.now() + 60000), false, 'android'); } catch (e2) {}
    setChannelBroken();
    return { success: false, code: 'TERMINAL_CHANNEL_UNAVAILABLE', message: '后台终端通道初始化异常（提交启动命令超时），请重新启动 Operit 后重试；若仍失败，按 README「已知问题 2」清理残留坏会话。' };
  }
  cmeProbe('T2', 'launchId=' + launchId);
  // ⑥ health 轮询（httpCall 通道，不占 hiddenExec；worker 就绪即返回）
  return await pollWorkerReady(launchId, 'submitted');
}

async function pollWorkerReady(launchId, src) {
  var LEASE = DATA_DIR + '/logs/launch_lease.json';
  var deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 1500); });
    var p = null;
    try { p = await withTimeout(httpCall('ping_worker', {}), 4000, 'ping timeout'); } catch (e) {}
    if (p && p.success) {
      cmeProbe('T6', 'launchId=' + launchId + ' src=' + src);
      try { Tools.Files.deleteFile(LEASE, false, 'android'); } catch (e) {}
      return { success: true, started: true, launchId: launchId };
    }
  }
  // 超时：释放租约 + 保护窗口（30s→60s，避免坏通道上过快重试堆积），允许下次重试
  try { Tools.Files.deleteFile(LEASE, false, 'android'); } catch (e) {}
  try { Tools.Files.write(BLOCK_FILE, String(Date.now() + 60000), false, 'android'); } catch (e) {}
  return { success: false, message: 'worker 45s 内未就绪（launchId=' + launchId + '），请稍候重试。' };
}

// detectPython 不再做任何 JS 侧文件探测——
// ① hiddenExec 探测会卡 8s×N（32s 阻塞 → ANR/闪退，2026-08-08 实锤）；
// ② Tools.Files.exists(...,'linux') 在当前 Operit 版本不可靠（实测返回空对象，误报 python3 不存在）。
// python 路径由 deploy_install 固定创建（项目 venv），存在性校验下沉到启动脚本 bash [ -x ]（毫秒级）。
async function detectPython() {
  return ROOT_DIR + '/.venv/bin/python3.12';
}

// hiddenExec 会话策略（多轮实测）: // 1. 会话按 executorKey 持久复用；Operit 后台期间 proot 可能被系统回收 → 会话失效 → 调用永久卡（取消机制也失效）
// 2. 方案：key 持久化到文件（跨模块重载有效）+ 失败自动漂移新 key（自愈），正常时固定 1 个会话零膨胀
var KEY_FILE = '/sdcard/Download/Operit/character_memory_engine/logs/exec_key';
function getKey() {
  try { var k = Tools.Files.read(KEY_FILE); var t = (k && (k.content || k.text)) || ''; return (t && t.length < 64) ? t : 'cme'; } catch (e) { return 'cme'; }
}
function saveKey(k) { try { Tools.Files.write(KEY_FILE, k, false, 'android'); } catch (e) {} }
function freshKey() { var k = 'cme_' + Date.now(); saveKey(k); return k; }
function withRace(p, ms, msg) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; reject(new Error(msg || 'timeout')); } }, ms);
    Promise.resolve(p).then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}
async function hiddenExecSafe(cmd, timeoutMs) {
  var key = getKey();
  try {
    return await withRace(Tools.System.terminal.hiddenExec(cmd, { timeoutMs: timeoutMs, executorKey: key }), timeoutMs, 'hiddenExec 超时');
  } catch (e) {
    // 会话疑似失效/被锁 → 漂移全新 key（文件持久化，跨模块重载保留），自愈重试一次
    var nk = 'cme_' + Date.now();
    saveKey(nk);
    return withRace(Tools.System.terminal.hiddenExec(cmd, { timeoutMs: timeoutMs, executorKey: nk }), timeoutMs, 'hiddenExec 二次超时');
  }
}
function grabOut(r) {
  if (typeof r === 'string') return r;
  if (!r) return '';
  if (r.stdout) return r.stdout;
  if (r.output) return r.output;
  if (r.body) return r.body;
  if (r.result) return r.result;
  if (r.text) return r.text;
  if (r.data !== undefined) {
    if (typeof r.data === 'string') return r.data;
    try { return JSON.stringify(r.data); } catch (e) { return String(r.data); }
  }
  try { return JSON.stringify(r); } catch (e) { return String(r); }
}
// 执行 shell 并返回输出。
// 与探针一致：直接传命令给 hiddenExec（不包 bash -lc，探针验证这样能正常返回输出）
async function execSh(cmd) {
  var terminal = Tools.System && Tools.System.terminal;
  if (!terminal) return '';
  try {
    if (typeof terminal.hiddenExec === 'function') {
      return grabOut(await hiddenExecSafe(cmd, 6000));
    }
    var sess = await terminal.create('cme_sh');
    var rr = await terminal.exec(sess.sessionId, cmd, 10000);
    try { await terminal.close(sess.sessionId); } catch (e) {}
    return grabOut(rr);
  } catch (e) { return ''; }
}

// 工具调用入口：HTTP 直调；失败时尝试拉起 worker 一次再重试
function run(action, payload) {
  return httpCall(action, payload || {}).then(function (r) {
    if (r && r.success) return r;
    // worker 不在线或调用失败：尝试拉起一次再重试
    return ensureWorkerUp().then(function (up) {
      if (up && !up.success) return up;
      return httpCall(action, payload || {});
    });
  });
}

// 工具导出：显式 exports（Operit subpackage 解析器识别显式导出名）
function makeTool(action) {
  return function (params) {
    // 计时探针——记录每次工具调用从 UI 发起点到返回的总耗时（定位 Operit 调用层开销）
    var t0 = Date.now();
    return run(action, params || {}).then(function (result) {
      dbgLog('timing', { action: action, ms: Date.now() - t0 });
      return finish(result);
    }).catch(function (e) {
      dbgLog('timing', { action: action, ms: Date.now() - t0, error: String((e && e.message) || e) });
      return finish({ success: false, message: e && e.message ? e.message : String(e) });
    });
  };
}

exports.list_memories = makeTool("list_memories");
// 诊断探针：纯 JS 轻量工具（不依赖 worker、不调 ensureWorkerUp）
// 用于区分「平台 Tool 回调通道整体阻塞」vs「CME 内部 ensureWorkerUp 锁传播」
// 用法：暖启动卡死时调用本工具，若延迟 ~20s → 平台通道被阻塞；若立即返回 → CME 内部传播
function pingJs(params) {
  var t0 = Date.now();
  try {
    var mono = 0;
    try { if (typeof performance !== 'undefined' && performance.now) mono = Math.round(performance.now() * 10) / 10; } catch (e) {}
    var result = { pong: true, ts: Date.now(), mono: mono, input: (params && params.q) || '' };
    dbgLog('timing', { action: 'ping_js', ms: Date.now() - t0 });
    return finish({ success: true, data: result });
  } catch (e) {
    return finish({ success: false, message: String((e && e.message) || e) });
  }
}
exports.ping_js = pingJs;
exports.get_memory = makeTool("get_memory");
exports.create_memory = makeTool("create_memory");
exports.update_memory = makeTool("update_memory");
exports.delete_memory = makeTool("delete_memory");
exports.search_memories = makeTool("search_memories");
exports.load_life_data = makeTool("load_life_data");
exports.upsert_life_item = makeTool("upsert_life_item");
exports.delete_life_item = makeTool("delete_life_item");
exports.toggle_todo = makeTool("toggle_todo");
exports.list_characters = makeTool("list_characters");
exports.save_character = makeTool("save_character");
exports.get_relationship = makeTool("get_relationship");
exports.save_relationship = makeTool("save_relationship");
exports.import_legacy_backup = makeTool("import_legacy_backup");
// deploy_* 用自定义实现：优先走 worker，worker 未运行时插件侧直连 terminal
exports.deploy_status = deployStatus;
exports.deploy_install = deployInstall;
exports.deploy_restart = deployRestart;
exports.save_ui_state = makeTool("save_ui_state");

// ===== 分析完成结果落文件（工具脚本环境无 setEnv，env 通道不可用；改用文件通道）=====
async function writeTriggerResultFile(obj) {
    var p = '/sdcard/Download/Operit/character_memory_engine/trigger_result.json';
    var tmp = p + '.tmp';
    try {
        await Tools.Files.write(tmp, JSON.stringify(obj, null, 2), false, 'android');
        await Tools.Files.move(tmp, p);
    } catch (e) {
        try { await Tools.Files.write(p, JSON.stringify(obj, null, 2), false, 'android'); } catch (e2) {}
    }
}
async function getTriggerResult() {
    try {
        var raw = await Tools.Files.read('/sdcard/Download/Operit/character_memory_engine/trigger_result.json');
        if (raw && raw.content) {
            var parsed = JSON.parse(raw.content);
            if (parsed && typeof parsed === 'object') return finish({ success: true, result: JSON.stringify(parsed) });
        }
    } catch (e) {}
    return finish({ success: true, result: '' });
}

exports.trigger_analysis = triggerAnalysis;
exports.get_trigger_result = getTriggerResult;
exports.set_injection_settings = makeTool("set_injection_settings");
exports.backup_engine = makeTool("backup_engine");
exports.inspect_engine = makeTool("inspect_engine");
exports.restore_engine = makeTool("restore_engine");
exports.ping_worker = makeTool("ping_worker");
exports.get_logs = makeTool("get_logs");

// ===== analyze_chat：取对话 + 读 LLM 配置 + worker 分析 =====
async function analyzeChat(params) {
    try {
        var chatId = (params && params.chat_id) || '';
        // 优先用 trigger.json 的当前对话（main.js 每次消息都会更新，最可靠）
        if (!chatId) {
            try {
                var tj = await readTriggerJson();
                if (tj && tj.chatId) chatId = String(tj.chatId);
            } catch (e) {}
        }
        // 未指定对话时，取最近对话（listChats 排序参数不可靠，拉回一批后本地按 updatedAt 排序）
        if (!chatId) {
            try {
                var chatList = await Tools.Chat.listChats({ limit: 20 });
                var chats = (chatList && chatList.chats) || [];
                if (chats.length > 0) {
                    chats.sort(function (a, b) {
                        return (b.updatedAt || b.updated_at || 0) - (a.updatedAt || a.updated_at || 0);
                    });
                    chatId = chats[0].id;
                }
            } catch (e) {}
        }
        if (!chatId) {
            return finish({ success: false, message: '没有找到对话' });
        }
        // 取对话消息（限 200 条防超长）
        var messages = [];
        try {
            // 取最近 200 条（order:'asc' 会取旧窗口漏掉新消息，必须 desc+reverse）
            var msgResult = await Tools.Chat.getMessages(chatId, { order: 'desc', limit: 200 });
            if (msgResult && msgResult.messages) msgResult.messages.reverse();
            if (msgResult && msgResult.messages) messages = msgResult.messages;
        } catch (e) {}
        if (messages.length === 0) {
            return finish({ success: false, message: '对话内容为空' });
        }
        // 拼 chat_text（过滤附件）
        var lines = [];
        for (var mi = 0; mi < messages.length; mi++) {
            var m = messages[mi];
            var c = (m.content || '').replace(/<attachment[^>]*>[\s\S]*?<\/attachment>/g, '').trim();
            if (!c) continue;
            if (c.length > 500) c = c.substring(0, 500) + '...';
            var role = (m.sender === 'user' || m.sender === 'USER') ? '用户' : 'AI';
            lines.push(role + ': ' + c);
        }
        var chat_text = lines.join('\n');
        if (chat_text.length > 20000) chat_text = chat_text.substring(0, 20000) + '...（截断）';
        if (chat_text.length < 10) {
            return finish({ success: false, message: '对话内容过短' });
        }
        // 读 LLM 配置（沿用旧 env）
        var rawEndpoint = '';
        try { rawEndpoint = getEnv('MEMORY_SYSTEM_ENDPOINT') || ''; } catch (e) {}
        var endpoint = rawEndpoint.replace(/\/+$/, '');
        if (endpoint && endpoint.indexOf('/chat/completions') < 0) endpoint = endpoint + '/chat/completions';
        var apiKey = '';
        try { apiKey = getEnv('MEMORY_SYSTEM_KEY') || ''; } catch (e) {}
        var model = '';
        try { model = getEnv('MEMORY_SYSTEM_MODEL') || 'gpt-4o-mini'; } catch (e) {}
        if (!endpoint || !apiKey) {
            return finish({ success: false, message: '未配置 API Endpoint 或 Key（请在设置中配置 MEMORY_SYSTEM_*）' });
        }
        try { dbgLog('analyze-cfg', { endpoint: endpoint ? 'ok' : 'EMPTY', key: apiKey ? 'ok' : 'EMPTY', model: model }); } catch (e) {}
        // 传给 worker 分析（CLI 一次性调用）
        try { dbgLog('analyze', { chatId: chatId, chatLen: chat_text.length, characterId: (params && params.character_id) || '' }); } catch (e) {}
        try { dbgLog('analyze-run', { chatId: chatId, chatLen: chat_text.length }); } catch (e) {}
        var result = await run('analyze_chat', {
            chat_text: chat_text,
            endpoint: endpoint,
            api_key: apiKey,
            model: model,
            character_id: (params && params.character_id) || undefined,
            persona_name: (params && params.persona_name) || ''
        });
        // 手动分析成功同样推进水位线，避免下次打开插件重复全量分析
        if (result && result.success) {
            try {
                var wmMax = 0;
                for (var wmi = 0; wmi < messages.length; wmi++) {
                    var wt = tsToMs(messages[wmi].timestamp);
                    if (wt > wmMax) wmMax = wt;
                }
                var wtr = await readTriggerJson() || {};
                if (!wtr.watermarks) wtr.watermarks = {};
                if (wmMax > 0) wtr.watermarks[chatId] = wmMax;
                wtr.lastAnalyzedAt = new Date().toISOString();
                wtr.lastAnalyzedChatId = chatId;
                try {
                    await writeTriggerAtomic(wtr);
                } catch (e) {}
            } catch (e) {}
        }
        return finish(result);
    } catch (e) {
        return finish({ success: false, message: '分析异常: ' + (e.message || String(e)) });
    }
}
exports.analyze_chat = analyzeChat;

// ===== trigger.json 原子读写（防并发半写损坏导致水位线丢失）=====
async function writeTriggerAtomic(obj) {
    var p = '/sdcard/Download/Operit/character_memory_engine/trigger.json';
    var tmp = p + '.tmp';
    try {
        await Tools.Files.write(tmp, JSON.stringify(obj, null, 2), false, 'android');
        await Tools.Files.move(tmp, p);
    } catch (e) {
        await Tools.Files.write(p, JSON.stringify(obj, null, 2), false, 'android');
    }
}
// 读 trigger.json：parse 失败重试 3 次（间隔 150ms），防并发半写
async function readTriggerJson() {
    var p = '/sdcard/Download/Operit/character_memory_engine/trigger.json';
    for (var i = 0; i < 3; i++) {
        try {
            var raw = await Tools.Files.read(p);
            if (raw && raw.content) {
                var parsed = JSON.parse(raw.content);
                if (parsed && typeof parsed === 'object') return parsed;
            } else {
                return null;
            }
        } catch (e) {}
        await new Promise(function (res) { setTimeout(res, 150); });
    }
    return null;
}
// ===== 时间戳健壮化：兼容 epoch 毫秒 / 秒 / ISO / 本地串 =====
function tsToMs(v) {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    var s = String(v);
    var n = Number(s);
    if (!isNaN(n) && s.indexOf('-') < 0) return n > 1e12 ? n : n * 1000;
    try {
        var ds = s;
        if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(ds)) {
            ds = ds.replace(' ', 'T');
            if (ds.indexOf('T') < 0) ds += 'T00:00:00';
        }
        var t = new Date(ds).getTime();
        return isNaN(t) ? 0 : t;
    } catch (e) { return 0; }
}
// ===== trigger_analysis：侧边栏打开时自动检测新对话 + 后台分析（与 CMS 行为一致）=====
// 行为：
//   1) 确定 chatId：params.chat_id → trigger.json.chatId → 最近对话
//   2) getMessages desc+200（取最近窗口）→ 过滤空消息 → 按水位线过滤新消息
//   3) 无新消息：返回 { skipped:true, reason:'no_new_content' }，不阻塞
//   4) 有新消息：后台异步调 analyzeChat（fire-and-forget），立即返回 { started:true, newMessageCount:N }
//   5) 分析完成后：推进水位线 + 写 trigger_result.json 文件通知前端轮询刷新（工具脚本无 setEnv，env 通道不可用）
async function triggerAnalysis(params) {
    try {
        cmeProbe('T8');
        var chatId = (params && params.chat_id) || '';
        var tr = await readTriggerJson() || {};
        if (!chatId && tr.chatId) chatId = String(tr.chatId);
        if (!chatId) {
            try {
                var chatList = await Tools.Chat.listChats({ limit: 20 });
                var chats = (chatList && chatList.chats) || [];
                if (chats.length > 0) {
                    chats.sort(function (a, b) {
                        return (b.updatedAt || b.updated_at || 0) - (a.updatedAt || a.updated_at || 0);
                    });
                    chatId = chats[0].id;
                }
            } catch (e) {}
        }
        if (!chatId) {
            return finish({ success: false, skipped: true, reason: 'no_chat', message: '未找到最近对话' });
        }
        // 拉最近 200 条（order:'asc' 会取旧窗口漏掉新消息，必须 desc+reverse）
        var allMessages = [];
        try {
            var msgResult = await Tools.Chat.getMessages(chatId, { order: 'desc', limit: 200 });
            if (msgResult && msgResult.messages) allMessages = msgResult.messages.reverse();
        } catch (e) {}
        // 过滤空消息和附件
        allMessages = allMessages.filter(function (m) {
            var c = (m.content || '').replace(/<attachment[^>]*>[\s\S]*?<\/attachment>/g, '').trim();
            return c && c.length > 0;
        });
        // 水位线过滤
        var watermarks = tr.watermarks || {};
        var lastProcessedTs = watermarks[chatId] || 0;
        var newMessages = lastProcessedTs
            ? allMessages.filter(function (m) { return tsToMs(m.timestamp) > lastProcessedTs; })
            : allMessages;
        if (newMessages.length === 0) {
            tr.lastCheckedAt = new Date().toISOString();
            tr.lastCheckedChatId = chatId;
            try {
                await writeTriggerAtomic(tr);
            } catch (e) {}
            return finish({
                success: true,
                skipped: true,
                reason: 'no_new_content',
                lastProcessedTs: lastProcessedTs,
                lastAnalyzedAt: tr.lastAnalyzedAt || null,
                message: '没有新内容，跳过分析'
            });
        }
        // 有新消息：后台异步分析，立即返回不阻塞 UI
        var count = newMessages.length;
        // 启动分析前先写"进行中"标记（无 finishedAt），
        // 防止 UI 轮询 get_trigger_result 读到上一次的失败/旧结果而误显示（如"未找到可用 python3"）。
        try {
            await writeTriggerResultFile({
                status: 'analyzing',
                startedAt: new Date().toISOString(),
                chatId: chatId,
                newMessageCount: count
            });
        } catch (e) {}
        var callerCardId = (params && params.character_id) || tr.callerCardId || '';
        var personaName = tr.personaName || '';
        (async function () {
            try {
                var r = await analyzeChat({ chat_id: chatId, character_id: callerCardId, persona_name: personaName });
                var rOk = !!(r && r.success && (!r.data || r.data.success !== false));
                // 推进水位线
                var maxTs = 0;
                for (var mi = 0; mi < allMessages.length; mi++) {
                    var t = tsToMs(allMessages[mi].timestamp);
                    if (t > maxTs) maxTs = t;
                }
                var tr2 = await readTriggerJson() || {};
                if (!tr2.watermarks) tr2.watermarks = {};
                if (maxTs > 0) tr2.watermarks[chatId] = maxTs;
                tr2.lastAnalyzedAt = new Date().toISOString();
                tr2.lastAnalyzedChatId = chatId;
                tr2.lastAnalyzedNewCount = count;
                tr2.lastResult = rOk ? 'has_data' : 'failed';
                try {
                    await writeTriggerAtomic(tr2);
                } catch (e) {}
                try {
                    await writeTriggerResultFile({
                        finishedAt: new Date().toISOString(),
                        chatId: chatId,
                        newMessageCount: count,
                        success: rOk,
                        hasData: rOk,
                        error: rOk ? '' : ((r && (r.message || (r.data && r.data.message))) || '未知错误')
                    });
                } catch (e) {}
            } catch (e) {
                try {
                    await writeTriggerResultFile({
                        finishedAt: new Date().toISOString(),
                        chatId: chatId,
                        newMessageCount: count,
                        success: false,
                        hasData: false,
                        error: (e.message || String(e))
                    });
                } catch (e2) {}
            }
        })();
        return finish({ success: true, started: true, newMessageCount: count, message: '已启动后台分析' });
    } catch (e) {
        return finish({ success: false, message: '检测异常: ' + (e.message || String(e)) });
    }
}

// ===== diag_engine：插件侧诊断（不经 worker，worker 未运行时也能用）=====
// 解决死锁：worker 起不来时部署页无法通过 worker 查状态/看日志。
// 这里直接用 Tools.System.terminal + Tools.Files 读启动日志/进程/engine.log。
// 注意：所有异步调用都必须 withTimeout 保护，否则 hiddenExec 卡住会让整个诊断挂起。
async function diagEngine(params) {
    try {
        var out = { worker_up: false, tmp_log_tail: '', engine_log_tail: '', process_count: 0, pids: [], messages: [], env: {} };

        // 0) 探测 hiddenExec 环境（python 可用性、proot 环境）
        try {
            var pyCheck = await withTimeout(
                hiddenExecSafe("command -v python3; echo '---'; python3 --version 2>&1; echo '---'; command -v python3.12; echo '---'; ls /root/character_memory_engine/.venv/bin/python3.12 2>&1; echo '---'; echo 'whoami='$(whoami)", 8000),
                10000, '环境探测超时。'
            );
            out.env.py = String(pyCheck && (pyCheck.stdout || pyCheck.output || pyCheck) || '').trim();
        } catch (e) { out.messages.push('环境探测失败: ' + (e.message || String(e))); }

        // 1) 检查 worker 进程（/proc 遍历，pgrep 在 proot 不存在）
        try {
            var pg = await withTimeout(
                hiddenExecSafe("F=''; for p in /proc/[0-9]*; do if [ -r \"$p/cmdline\" ]; then c=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null); case \"$c\" in *worker.py*) F=\"$F $(basename $p)\";; esac; fi; done; echo $F", 6000),
                8000, '进程扫描超时。'
            );
            var pgs = String(pg && (pg.stdout || pg.output || pg) || '').trim();
            if (pgs) {
                out.process_count = pgs.split(/\s+/).filter(Boolean).length;
                out.pids = pgs.split(/\s+/).filter(Boolean);
            }
        } catch (e) { out.messages.push('进程扫描失败: ' + (e.message || String(e))); }

        // 2) 读 worker 启动日志（旧 CLI 架构路径已废弃；HTTP 常驻架构日志在 engine.log，见步骤 3）

        // 3) 读 engine.log（worker 自身日志，若有）
        try {
            var el = await withTimeout(Tools.Files.read('/sdcard/Download/Operit/character_memory_engine/logs/engine.log'), 5000, '读 engine.log 超时。');
            var etxt = el && (el.content || el.text || '') || '';
            out.engine_log_tail = String(etxt).split('\n').slice(-15).join('\n');
        } catch (e) { /* engine.log 可能尚未生成 */ }

        out.worker_up = out.process_count > 0;
        return finish({ success: true, diag: out });
    } catch (e) {
        return finish({ success: false, message: '诊断异常: ' + (e.message || String(e)) });
    }
}
exports.diag_engine = diagEngine;

// ===== log_ui：前端诊断日志写文件（不经 worker，worker 未启动也能写）=====
// 供 screen.js 的 dbgUi 埋点调用，追加到 dbg_ui.log。
function logUi(params) {
  try {
    var line = String(params && (params.line || params.message) || '');
    var DBG = '/sdcard/Download/Operit/character_memory_engine/logs/dbg_ui.log';
    try { Tools.Files.write(DBG, line, true, 'android'); }
    catch (e) {
      try {
        var old = Tools.Files.read(DBG);
        var oldText = (old && (old.content || old.text)) || '';
        Tools.Files.write(DBG, oldText + line, false, 'android');
      } catch (e2) {}
    }
    return finish({ success: true });
  } catch (e) {
    return finish({ success: false, message: e && e.message ? e.message : String(e) });
  }
}
exports.log_ui = logUi;

// ===== deploy_*：通过 worker CLI 一次性调用 =====
function deployStatus(params) {
  return run('deploy_status', params || {}).then(function (result) {
    return finish(result);
  }).catch(function (e) {
    return finish({ success: false, message: e && e.message ? e.message : String(e) });
  });
}
function deployInstall(params) {
  return run('deploy_install', params || {}).then(function (result) {
    return finish(result);
  }).catch(function (e) {
    return finish({ success: false, message: e && e.message ? e.message : String(e) });
  });
}
function deployRestart(params) {
  // 先热备当前 db（worker 在线时），再强制完整重启（kill + db 同步 + 拉起）
  return Promise.resolve()
    .then(function () { try { return run('sync_db', {}); } catch (e) { return null; } })
    .then(function () { return ensureWorkerUp(true); })
    .then(function (result) {
      return finish(result);
    }).catch(function (e) {
      return finish({ success: false, message: e && e.message ? e.message : String(e) });
    });
}

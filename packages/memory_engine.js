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

// 经 HTTP 调用 worker；P0-C2 增加错误域标记（errorDomain）：
//   'transport' —— 连接拒绝/connect timeout/无响应（worker 离线）
//   'protocol'  —— 收到响应但非 JSON / HTTP 错误无 success 字段
//   'business'  —— Worker 正常返回 JSON（success 由 Worker 决定，业务错误/参数错误等）
// 普通业务调用方据此决定是否可自动拉起（transport 才可能拉起，且 Phase 0 不自动拉起）
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
    return { success: false, code: 'WORKER_OFFLINE', errorDomain: 'transport', message: 'worker 未响应（' + WORKER_URL + '）：' + (e && e.message ? e.message : String(e)) + '。启动命令：nohup ' + ROOT_DIR + '/.venv/bin/python3.12 ' + ROOT_DIR + '/worker.py --port 8765 --db ' + ROOT_DIR + '/engine.db &' };
  }
  var text = String(resp && (resp.content || resp.body || '') || '');
  var data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (data && typeof data === 'object') {
    if (resp && resp.statusCode >= 400 && data.success === undefined) {
      data.success = false;
      data.httpStatus = resp.statusCode;
      data.errorDomain = 'protocol';
    } else if (data.errorDomain === undefined) {
      // Worker 正常 JSON 响应：业务域（success 由 Worker 决定）
      data.errorDomain = 'business';
    }
    return data;
  }
  return { success: false, code: 'WORKER_PROTOCOL_ERROR', errorDomain: 'protocol', message: 'worker 返回无法解析: HTTP ' + (resp && resp.statusCode) + ' ' + text.slice(0, 200) };
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
    // start_worker.sh（P0-C4：注册为 manifest resource，首次安装可部署；DATA_DIR 副本用于 ROOT_DIR 自同步）
    try {
      var swSrc = await ToolPkg.readResource('engine_start_worker_sh', 'start_worker.sh', false);
      if (swSrc) {
        await Tools.Files.copy(String(swSrc), DATA_DIR + '/start_worker.sh', true, 'android', 'linux');
        try { await Tools.Files.mkdir(ROOT_DIR, true, 'linux'); } catch (e3) {}
        await Tools.Files.copy(String(swSrc), ROOT_DIR + '/start_worker.sh', true, 'android', 'linux');
      }
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

// ===== WorkerLaunchLock：进程内原子单飞（P0-C3/选项A 2026-08-10）=====
// 并发 start 时 A 持有 active promise，B/C await 同一 promise；不重复投递。
var _launchActive = null; // { promise, at }
function launchLock() {
  if (_launchActive && _launchActive.promise && (Date.now() - _launchActive.at) < 30000) {
    return _launchActive.promise;
  }
  var p = null;
  var holder = { at: Date.now() };
  _launchActive = holder;
  var release = function () { if (_launchActive === holder) _launchActive = null; };
  p = new Promise(function (resolve) {
    safeLaunchInternal().then(function (r) { release(); resolve(r); },
      function (e) { release(); resolve({ success: false, message: String((e && e.message) || e) }); });
  });
  holder.promise = p;
  return p;
}

// 安全拉起：用 visible persistent terminal（terminal.create + input）投递 start_worker.sh，
// 替代已废弃的 hiddenExec 链（P0-C3）。visible session 不产生 hidden 坏会话。
// worker 确认 ready 时刷新 worker_state.json（观察状态，非锁；让部署页/诊断看到最新 ready）。
function writeWorkerStateReady(source, launchId, startedMs) {
  try {
    // worker 在线确认：清除「安装中」标记（env 为主通道，文件标记由 terminal 命令尾部自行清理）
    try { setEnv('MEMORY_ENGINE_INSTALLING', ''); } catch (e) {}
    var st = { state: 'ready', observedAt: new Date().toISOString(), source: source, ms: startedMs !== undefined ? startedMs : 0 };
    if (launchId) st.launchId = launchId;
    Tools.Files.write(DATA_DIR + '/logs/worker_state.json', JSON.stringify(st), false, 'android');
  } catch (e) {}
}
async function safeLaunchInternal() {
  try {
    var _t0 = Date.now();
    // ① health 先检（快，不占 terminal）
    var ping0 = null;
    try { ping0 = await withTimeout(httpCall('ping_worker', {}), 3000, 'ping timeout'); } catch (e) {}
    if (ping0 && ping0.success) {
      writeWorkerStateReady('safeAutoLaunch_health', null, Date.now() - _t0);
      return { success: true, alreadyUp: true };
    }
    // ② 资源部署（P0-C4：含 start_worker.sh）
    try { await deployWorkerToData(); } catch (e) {}
    // ③ visible terminal 投递（terminal.create + input + Enter，立即返回）
    var launchId = 'L' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    var submitCmd = 'LAUNCH_ID=' + launchId + ' nohup setsid bash /root/character_memory_engine/start_worker.sh </dev/null >>' + DATA_DIR + '/logs/start_worker.log 2>&1 & echo submitted_' + launchId;
    var term = Tools.System && Tools.System.terminal;
    if (!term || typeof term.create !== 'function' || typeof term.input !== 'function') {
      return { success: false, code: 'TERMINAL_UNAVAILABLE', message: 'visible terminal 不可用，无法自动拉起 Worker' };
    }
    var sess = null;
    try {
      sess = await term.create('cme_worker_launch');
    } catch (e) {
      return { success: false, code: 'TERMINAL_CREATE_FAILED', message: 'terminal.create 失败: ' + (e && e.message ? e.message : String(e)) };
    }
    if (!sess || !sess.sessionId) {
      return { success: false, code: 'TERMINAL_NO_SESSION', message: '未获得 terminal session id' };
    }
    cmeProbe('T1', 'launchId=' + launchId + ' source=safeAutoLaunch');
    try {
      await term.input(sess.sessionId, { input: submitCmd, control: 'enter' });
    } catch (e) {
      return { success: false, code: 'TERMINAL_INPUT_FAILED', message: 'terminal.input 失败: ' + (e && e.message ? e.message : String(e)) };
    }
    cmeProbe('T2', 'launchId=' + launchId);
    // ④ 有界等待 health（≤20s，轮询间隔 1.5s；start_worker.sh 报告 NO_VENV 时快速失败，不等超时）
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, 1500); });
      // 快速失败：项目 venv 未安装（start_worker.sh NO_VENV/NEED_INSTALL 退出）→ 立即返回 NEED_INSTALL
      // 只检测最近记录（最后 4 行）：start_worker.log 是 append 累积文件，全文搜索会命中历史残留
      // （依赖装完后旧 NEED_INSTALL 仍在文件里 → 已启动仍误判「需要安装」→ 状态检查反复失败）
      try {
        var slog = await withTimeout(Tools.Files.read(DATA_DIR + '/logs/start_worker.log'), 4000, 'read start_worker.log timeout');
        var slogTxt = String(slog && (slog.content || slog.text || '') || '');
        var slogLines = slogTxt.split(/\n+/).filter(function (l) { return l && l.trim(); });
        var recent = slogLines.slice(-4).join('\n');
        if ((recent.indexOf('NEED_INSTALL') >= 0 || recent.indexOf('NO_VENV') >= 0) && recent.indexOf('launched') < 0) {
          try { setEnv('MEMORY_ENGINE_NEED_INSTALL', '1'); } catch (e) {}
          return { success: false, code: 'NEED_INSTALL', message: '首次运行：请点击「安装依赖」初始化运行环境（部署页），安装完成后 Worker 自动拉起。' };
        }
      } catch (e) {}
      var p = null;
      try { p = await withTimeout(httpCall('ping_worker', {}), 3000, 'ping timeout'); } catch (e) {}
      if (p && p.success) {
        try { setEnv('MEMORY_ENGINE_NEED_INSTALL', ''); } catch (e) {}
        cmeProbe('T6', 'launchId=' + launchId + ' src=safeAutoLaunch');
        writeWorkerStateReady('safeAutoLaunch', launchId, Date.now() - _t0);
        return { success: true, started: true, launchId: launchId };
      }
    }
    return { success: false, code: 'LAUNCH_TIMEOUT', message: 'Worker 20s 内未就绪（launchId=' + launchId + '）。请检查 start_worker.log 或手动启动。' };
  } catch (e) {
    return { success: false, message: '自动拉起异常: ' + (e && e.message ? e.message : String(e)) };
  }
}

// 对外统一入口：安全拉起（单飞）
function safeAutoLaunch() {
  return launchLock();
}

// detectPython 不再做任何 JS 侧文件探测——
// ① hiddenExec 探测会卡 8s×N（32s 阻塞 → ANR/闪退，2026-08-08 实锤）；
// ② Tools.Files.exists(...,'linux') 在当前 Operit 版本不可靠（实测返回空对象，误报 python3 不存在）。
// python 路径由 deploy_install 固定创建（项目 venv），存在性校验下沉到启动脚本 bash [ -x ]（毫秒级）。
async function detectPython() {
  return ROOT_DIR + '/.venv/bin/python3.12';
}

// P0-C3（2026-08-10）：删除 hiddenExec 生产链（getKey/saveKey/freshKey/withRace/hiddenExecSafe/execSh/grabOut）。
// 拉起统一走 safeAutoLaunch（visible terminal）；生产代码不再触碰 hiddenExec。

// 工具调用入口（P0-C2/P0-C3 2026-08-10）：普通业务只请求一次。
// transport 离线 → 尝试 safeAutoLaunch（visible terminal 安全拉起，单飞），成功则重试一次业务；
//                     拉起失败/超时 → WORKER_OFFLINE 快速失败。
// business/protocol → 原样返回，不重放。
function run(action, payload) {
  // 依赖未安装标记：普通业务直接短路返回 NEED_INSTALL（不再 safeAutoLaunch 空等 20s）。
  // 首次安装场景：进入即快速提示「请点击安装依赖」；deploy_status 不短路（用户要查进度）。
  // 标记可能已过期（install_deps/safeAutoLaunch 已把 worker 拉起）：短路前先 ping 探测，
  // 在线则清标记并继续执行业务 → UI 状态自动回显（否则 worker 已在线但 UI 一直显示「请点击安装依赖」）。
  try {
    if (action !== 'deploy_status' && getEnv('MEMORY_ENGINE_NEED_INSTALL') === '1') {
      return httpCall('ping_worker', {}).then(function (p) {
        if (p && p.success) {
          try { setEnv('MEMORY_ENGINE_NEED_INSTALL', ''); } catch (e) {}
          return httpCall(action, payload || {});
        }
        return { success: false, code: 'NEED_INSTALL', errorDomain: 'business', message: '首次运行：请点击「安装依赖」初始化运行环境（部署页）' };
      }).catch(function () {
        return { success: false, code: 'NEED_INSTALL', errorDomain: 'business', message: '首次运行：请点击「安装依赖」初始化运行环境（部署页）' };
      });
    }
  } catch (e) {}
  return httpCall(action, payload || {}).then(function (r) {
    if (r && r.success) {
      // worker 在线确认：刷新 worker_state.json 为 ready + 清除依赖未安装标记（观察状态）
      writeWorkerStateReady('run_ok', null, 0);
      try { setEnv('MEMORY_ENGINE_NEED_INSTALL', ''); } catch (e) {}
      return r;
    }
    if (r && r.errorDomain === 'transport') {
      // 选项A：离线时用 visible terminal 安全拉起（不制造 hidden 坏会话），最多一次
      return safeAutoLaunch().then(function (up) {
        if (up && up.success) {
          return httpCall(action, payload || {}); // 拉起成功，重试一次原业务
        }
        return { success: false, code: 'WORKER_OFFLINE', errorDomain: 'transport', message: (up && up.message) || 'Worker 离线，自动拉起失败。请手动启动后重试：' + ROOT_DIR + '/.venv/bin/python3.12 ' + ROOT_DIR + '/worker.py --port 8765 --db ' + ROOT_DIR + '/engine.db &' };
      });
    }
    // business / protocol：原样返回（业务失败如实呈现，不重放）
    return r;
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
        // 首次安装/依赖未装：不启动后台分析（分析必然失败；且避免「检测到新对话正在分析」提前触发、混淆安装引导）
        try {
            if (getEnv('MEMORY_ENGINE_NEED_INSTALL') === '1') {
                return finish({ success: false, code: 'NEED_INSTALL', skipped: true, started: false, message: '依赖未安装：请先在「部署」页点击「安装依赖」' });
            }
        } catch (e) {}
        // worker 离线（含首次进入尚未拉起）：跳过自动分析，前端不进入轮询；安装完成后自动恢复
        try {
            var _ping = await withTimeout(httpCall('ping_worker', {}), 3000, 'ping timeout');
            if (!_ping || !_ping.success) {
                return finish({ success: true, skipped: true, started: false, reason: 'worker_offline', message: 'Worker 未就绪，跳过自动分析' });
            }
        } catch (e) {
            return finish({ success: true, skipped: true, started: false, reason: 'worker_offline', message: 'Worker 未就绪，跳过自动分析' });
        }
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
                // P0-C5：只在分析明确成功时推进水位线；失败保留原水位线，
                // 失败批次下次可重试（否则失败被跳过导致记忆永久丢失）
                var tr2 = await readTriggerJson() || {};
                if (!tr2.watermarks) tr2.watermarks = {};
                if (rOk) {
                    var maxTs = 0;
                    for (var mi = 0; mi < allMessages.length; mi++) {
                        var t = tsToMs(allMessages[mi].timestamp);
                        if (t > maxTs) maxTs = t;
                    }
                    if (maxTs > 0) tr2.watermarks[chatId] = maxTs;
                    tr2.lastAnalyzedAt = new Date().toISOString();
                    tr2.lastAnalyzedChatId = chatId;
                    tr2.lastAnalyzedNewCount = count;
                    tr2.lastResult = 'has_data';
                    tr2.lastError = '';
                    tr2.analyzeFailCount = 0;
                } else {
                    // 失败：不推进水位线，记录错误与失败次数（供诊断/退避参考）
                    tr2.lastAnalyzedChatId = chatId;
                    tr2.lastAnalyzedNewCount = count;
                    tr2.lastResult = 'failed';
                    tr2.lastError = (r && (r.message || (r.data && r.data.message))) || '未知错误';
                    tr2.analyzeFailCount = (tr2.analyzeFailCount || 0) + 1;
                }
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
// P0-C3：移除 hiddenExec 探测（已废弃）；改为 HTTP health + Files 读日志 + start_worker.log。
// 注意：所有异步调用都必须 withTimeout 保护。
async function diagEngine(params) {
    try {
        var out = { worker_up: false, tmp_log_tail: '', engine_log_tail: '', start_worker_log_tail: '', process_count: 0, pids: [], messages: [], env: {} };

        // 0) HTTP health 探测（不碰 terminal，worker 在线/离线都能回答）
        try {
            var ping = await withTimeout(httpCall('ping_worker', {}), 4000, 'ping timeout');
            out.worker_up = !!(ping && ping.success);
            out.env.py = 'worker=' + (out.worker_up ? (ping.version || 'ok') : 'offline');
            if (out.worker_up) { out.process_count = 1; out.pids = [ping.version || '?']; }
        } catch (e) { out.worker_up = false; out.messages.push('health 探测失败: ' + (e.message || String(e))); }

        // 1) 读 start_worker.log（启动脚本日志，worker 未启动也有）
        try {
            var sl = await withTimeout(Tools.Files.read('/sdcard/Download/Operit/character_memory_engine/logs/start_worker.log'), 5000, '读 start_worker.log 超时。');
            out.start_worker_log_tail = String(sl && (sl.content || sl.text || '') || '').split('\n').slice(-8).join('\n');
        } catch (e) { out.messages.push('start_worker.log 不可读'); }

        // 2) 读 engine.log（worker 自身日志，若有）
        try {
            var el = await withTimeout(Tools.Files.read('/sdcard/Download/Operit/character_memory_engine/logs/engine.log'), 5000, '读 engine.log 超时。');
            var etxt = el && (el.content || el.text || '') || '';
            out.engine_log_tail = String(etxt).split('\n').slice(-15).join('\n');
        } catch (e) { /* engine.log 可能尚未生成 */ }

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
  // 安装中：返回「安装中」状态而非失败——安装期间状态检查应明确提示进行中
  // env 标记为主通道（跨调用可靠），文件标记为辅助（terminal 写，装完自删）
  try {
    if (getEnv('MEMORY_ENGINE_INSTALLING') === '1') {
      return Promise.resolve(finish({ success: true, installing: true, status: { installing: true, message: '依赖安装中' }, message: '依赖安装中，请稍候…（安装完成后 Worker 自动启动）' }));
    }
  } catch (e) {}
  try {
    var _m = Tools.Files.read(DATA_DIR + '/.installing');
    if (_m && String(_m.content || _m.text || '').length > 0) {
      return Promise.resolve(finish({ success: true, installing: true, status: { installing: true, message: '依赖安装中' }, message: '依赖安装中，请稍候…（安装完成后 Worker 自动启动）' }));
    }
  } catch (e) {}
  return run('deploy_status', params || {}).then(function (result) {
    return finish(result);
  }).catch(function (e) {
    return finish({ success: false, message: e && e.message ? e.message : String(e) });
  });
}
function deployInstall(params) {
  // 优先 worker 在线路径（worker.py 安装到项目 venv，完成后自动重启 worker 让新依赖生效）；
  // worker 离线（首次安装，venv 未建）→ visible terminal 直接安装（系统 python3 建 venv + pip）。
  return httpCall('deploy_install', params || {}).then(function (result) {
    if (result && result.success) {
      try { setEnv('MEMORY_ENGINE_NEED_INSTALL', ''); } catch (e) {}
      return restartWorkerAfterInstall();
    }
    if (result && result.errorDomain === 'transport') return installDepsViaTerminal();
    return finish(result);
  }).catch(function (e) {
    return installDepsViaTerminal();
  });
}
// 安装完成后重启 worker：kill 旧 worker（旧解释器/旧依赖状态，VEC_AVAILABLE 可能固化 False）→ safeAutoLaunch 用新 venv 拉起
function restartWorkerAfterInstall() {
  var term = Tools.System && Tools.System.terminal;
  if (!term || typeof term.create !== 'function' || typeof term.input !== 'function') {
    return finish({ success: true, message: '依赖已安装。请手动重启 Worker 生效：kill $(cat ' + ROOT_DIR + '/worker.pid 2>/dev/null) 后重新拉起。' });
  }
  var cmd = 'kill $(cat ' + ROOT_DIR + '/worker.pid 2>/dev/null) 2>/dev/null; sleep 1; pkill -f "' + ROOT_DIR + '/worker.py" 2>/dev/null; echo cme_worker_killed';
  return term.create('cme_restart_worker').then(function (sess) {
    if (!sess || !sess.sessionId) return finish({ success: true, message: '依赖已安装。请点击「检查状态」拉起 Worker（新 venv 生效）。' });
    return term.input(sess.sessionId, { input: cmd, control: 'enter' }).then(function () {
      return safeAutoLaunch().then(function (up) {
        if (up && up.success) return finish({ success: true, message: '依赖安装完成，Worker 已用新 venv 重启（向量能力已就绪）。' });
        return finish({ success: true, message: '依赖已安装。Worker 自动重启未就绪，请点击「检查状态」手动拉起。' });
      });
    }).catch(function (e) {
      return finish({ success: true, message: '依赖已安装。请点击「检查状态」拉起 Worker。' });
    });
  }).catch(function (e) {
    return finish({ success: true, message: '依赖已安装。请点击「检查状态」拉起 Worker。' });
  });
}
// 首次安装：visible terminal 投递「系统 python3 建 venv + pip 装依赖」（不依赖 worker 在线）
// 装完自动执行 start_worker.sh：依赖完整性检查通过后自动拉起 worker（一次点击闭环，无需再手动点）
// .installing 标记：安装进行中去重（重复点击返回「安装中」不再投递）+ UI 区分「安装中」vs「完成」
function installDepsViaTerminal() {
  var marker = DATA_DIR + '/.installing';
  // 已在安装（env 主通道 + 文件标记辅助）：直接返回「安装中」，不重复投递
  try {
    if (getEnv('MEMORY_ENGINE_INSTALLING') === '1') {
      return Promise.resolve(finish({ success: true, installing: true, message: '依赖正在安装中，请稍候…（安装完成后 Worker 自动启动，无需重复点击）' }));
    }
  } catch (e) {}
  try {
    var _prev = Tools.Files.read(marker);
    if (_prev && String(_prev.content || _prev.text || '').length > 0) {
      return Promise.resolve(finish({ success: true, installing: true, message: '依赖正在安装中，请稍候…（安装完成后 Worker 自动启动，无需重复点击）' }));
    }
  } catch (e) {}
  // 命令链容错：pip install 用「;」连接（失败也尝试 start_worker.sh，其依赖检查会 NEED_INSTALL 兜底），
  // 避免 pip 某条命令退出码非 0 导致装完也不拉起 worker
  // install.log 诊断：记录 BEGIN/VENV_DONE/PIP_DEPS_RC/START_RC，定位「装完不自动拉起」断在哪一步
  var cmd = 'M=' + marker + '; L=' + DATA_DIR + '/logs/install.log; mkdir -p "$(dirname $M)" "$(dirname $L)" 2>/dev/null; echo "[$(date "+%F %T")] BEGIN" >> $L; if [ -f $M ] && [ -s $M ]; then echo "[$(date "+%F %T")] SKIP_ALREADY" >> $L; echo CME_SKIP_ALREADY_INSTALLING; else echo 1 > $M; echo "[$(date "+%F %T")] VENV_START" >> $L; mkdir -p ' + ROOT_DIR + ' && cp -f ' + DATA_DIR + '/start_worker.sh ' + ROOT_DIR + '/start_worker.sh 2>/dev/null; chmod +x ' + ROOT_DIR + '/start_worker.sh 2>/dev/null; cd ' + ROOT_DIR + ' && python3 -m venv .venv && echo "[$(date "+%F %T")] VENV_DONE" >> $L && ./.venv/bin/pip install --upgrade pip && echo "[$(date "+%F %T")] PIP_UPGRADE_DONE" >> $L && ./.venv/bin/pip install onnxruntime sqlite-vec tokenizers; echo "[$(date "+%F %T")] PIP_DEPS_RC=$?" >> $L; echo "[$(date "+%F %T")] PRE_START lock=$(ls -d /tmp/cme_start_worker.lock 2>/dev/null || echo none) sw=$(test -s ' + ROOT_DIR + '/start_worker.sh && echo ok || echo missing)" >> $L; LAUNCH_ID=install_deps_' + Date.now() + ' bash ' + ROOT_DIR + '/start_worker.sh; echo "[$(date "+%F %T")] START_RC=$? workers=$(pgrep -fc "worker.py" 2>/dev/null || echo 0)" >> $L; echo "[$(date "+%F %T")] DONE" >> $L; rm -f $M; fi';
  var term = Tools.System && Tools.System.terminal;
  if (!term || typeof term.create !== 'function' || typeof term.input !== 'function') {
    return finish({ success: false, code: 'TERMINAL_UNAVAILABLE', message: '终端服务未就绪（Operit 冷启动早期），请 3-5 秒后再点一次「安装依赖」。手动执行：' + cmd });
  }
  // 冷启动早期 terminal.create 可能失败（踩坑 10.3/10.4：早期 terminal/executor 未就绪）——
  // 有限重试 3 次（1s/3s/5s）后再放弃，避免「刚进入点安装显示失败」的体验。
  function tryCreate(retry) {
    return term.create('cme_install_deps').then(function (sess) {
      if (!sess || !sess.sessionId) throw new Error('no session');
      return sess;
    }).catch(function (e) {
      if (retry < 3) {
        return new Promise(function (res) { setTimeout(res, retry === 0 ? 1000 : (retry === 1 ? 3000 : 5000)); }).then(function () { return tryCreate(retry + 1); });
      }
      throw e;
    });
  }
  return tryCreate(0).then(function (sess) {
    return term.input(sess.sessionId, { input: cmd, control: 'enter' }).then(function () {
      try { setEnv('MEMORY_ENGINE_INSTALLING', '1'); } catch (e) {}
      return finish({ success: true, installing: true, message: '已在终端启动依赖安装（需几分钟）。安装完成后 Worker 将自动用新 venv 启动，向量能力自动生效。' });
    }).catch(function (e) {
      return finish({ success: false, code: 'TERMINAL_INPUT_FAILED', message: 'terminal.input 失败: ' + (e && e.message ? e.message : String(e)) });
    });
  }).catch(function (e) {
    return finish({ success: false, code: 'TERMINAL_CREATE_FAILED', message: '终端会话创建失败（已重试 3 次）：' + (e && e.message ? e.message : String(e)) + '。请 5 秒后再点一次「安装依赖」。' });
  });
}
function deployRestart(params) {
  // P0-C3（2026-08-10）：Phase 0 显式重启返回 WORKER_RECOVERY_DISABLED，
  // 不再走 ensureWorkerUp/hiddenExec 强制重启链。用户需手动启动或等待后续 Phase 1 显式 recovery。
  return finish({ success: false, code: 'WORKER_RECOVERY_DISABLED', message: 'Worker 重启功能在当前版本暂不可用（Phase 0 safe-off）。如需重启请手动执行：kill $(cat ' + ROOT_DIR + '/worker.pid 2>/dev/null); ' + ROOT_DIR + '/.venv/bin/python3.12 ' + ROOT_DIR + '/worker.py --port 8765 --db ' + ROOT_DIR + '/engine.db &' });
}

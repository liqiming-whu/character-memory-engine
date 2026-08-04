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
            { "name": "limit", "type": "integer", "required": false, "description": "最大返回数，默认200" },
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
        { "name": "delete_life_item", "description": { "zh": "删除六类条目", "en": "Delete life data item" }, "parameters": [
            { "name": "category", "type": "string", "required": true, "description": "分类" },
            { "name": "index", "type": "integer", "required": true, "description": "索引" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "toggle_todo", "description": { "zh": "切换待办状态", "en": "Toggle todo status" }, "parameters": [
            { "name": "index", "type": "integer", "required": true, "description": "索引" },
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
        { "name": "ping_worker", "description": { "zh": "检查 worker 是否可用", "en": "Check worker availability" }, "parameters": []},
        { "name": "get_logs", "description": { "zh": "读取日志文件尾部", "en": "Read log tail" }, "parameters": [
            { "name": "limit", "type": "integer", "required": false, "description": "返回行数，默认 200" },
            { "name": "level", "type": "string", "required": false, "description": "级别过滤：ERROR/WARN/INFO/DEBUG" },
            { "name": "path", "type": "string", "required": false, "description": "日志文件路径（默认 engine.log）" }
        ]},
        { "name": "diag_engine", "description": { "zh": "插件侧诊断（不经 worker）：进程/启动日志/engine.log", "en": "Diagnose engine without worker" }, "parameters": []}
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

// ===== 调试探针（临时）：记录每次工具调用的返回，用于定位 UI "未知错误" =====
var DBG_LOG = '/sdcard/Download/Operit/character_memory_engine/logs/dbg_call.log';
function dbgLog(action, obj) {
  try {
    var line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' [' + action + '] ' + JSON.stringify(obj).slice(0, 600) + '\n';
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
    return { success: false, message: 'worker 未响应（' + WORKER_URL + '）：' + (e && e.message ? e.message : String(e)) + '。启动命令：nohup /root/.venv/bin/python3.12 ' + DATA_DIR + '/worker.py --port 8765 --db ' + DATA_DIR + '/engine.db &' };
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

// 尝试拉起常驻 worker（幂等：已在线则跳过）
async function ensureWorkerUp() {
  var ping = await httpCall('ping_worker', {});
  if (ping && ping.success) return { success: true, alreadyUp: true };
  var terminal = Tools.System && Tools.System.terminal;
  if (!terminal) return { success: false, message: '无终端能力，无法自动拉起 worker。请手动执行：nohup /root/.venv/bin/python3.12 ' + DATA_DIR + '/worker.py --port 8765 --db ' + DATA_DIR + '/engine.db &' };
  var script = [
    "mkdir -p " + DATA_DIR + "/logs",
    "pgrep -f 'worker.py --port' >/dev/null 2>&1 || (",
    "  nohup /root/.venv/bin/python3.12 " + DATA_DIR + "/worker.py --port 8765 --db " + DATA_DIR + "/engine.db >> " + DATA_DIR + "/logs/engine.log 2>&1 &",
    "  echo started",
    ") || echo already-running"
  ].join('; ');
  try {
    if (typeof terminal.hiddenExec === 'function') {
      await withTimeout(terminal.hiddenExec('bash -lc ' + "'" + script.replace(/'/g, "'\\''") + "'", { executorKey: 'character_memory_engine', timeoutMs: 20000 }), 25000, '拉起 worker 超时。');
    } else {
      var sess = await withTimeout(terminal.create('memory_engine_start'), 8000, '创建终端会话超时。');
      await withTimeout(terminal.exec(sess.sessionId, 'bash -lc ' + "'" + script.replace(/'/g, "'\\''") + "'", 20000), 25000, '拉起 worker 超时。');
      try { await terminal.close(sess.sessionId); } catch (e) {}
    }
  } catch (e) {
    return { success: false, message: '拉起 worker 失败: ' + (e && e.message ? e.message : String(e)) + '。请手动执行：nohup /root/.venv/bin/python3.12 ' + DATA_DIR + '/worker.py --port 8765 --db ' + DATA_DIR + '/engine.db &' };
  }
  await new Promise(function (r) { setTimeout(r, 3000); });
  var ping2 = await httpCall('ping_worker', {});
  if (ping2 && ping2.success) return { success: true, started: true };
  return { success: false, message: '拉起后 worker 仍未响应。请手动执行：nohup /root/.venv/bin/python3.12 ' + DATA_DIR + '/worker.py --port 8765 --db ' + DATA_DIR + '/engine.db &' };
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
    return run(action, params || {}).then(function (result) {
      return finish(result);
    }).catch(function (e) {
      return finish({ success: false, message: e && e.message ? e.message : String(e) });
    });
  };
}

exports.list_memories = makeTool("list_memories");
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
exports.trigger_analysis = makeTool("trigger_analysis");
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
            var msgResult = await Tools.Chat.getMessages(chatId, { order: 'asc', limit: 200 });
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
        // 传给 worker 分析（CLI 一次性调用）
        var result = await run('analyze_chat', {
            chat_text: chat_text,
            endpoint: endpoint,
            api_key: apiKey,
            model: model,
            character_id: (params && params.character_id) || undefined,
            persona_name: (params && params.persona_name) || ''
        });
        return finish(result);
    } catch (e) {
        return finish({ success: false, message: '分析异常: ' + (e.message || String(e)) });
    }
}
exports.analyze_chat = analyzeChat;

// ===== diag_engine：插件侧诊断（不经 worker，worker 未运行时也能用）=====
// 解决死锁：worker 起不来时部署页无法通过 worker 查状态/看日志。
// 这里直接用 Tools.System.terminal + Tools.Files 读启动日志/进程/engine.log。
async function diagEngine(params) {
    try {
        var out = { worker_up: false, tmp_log_tail: '', engine_log_tail: '', process_count: 0, pids: [], messages: [] };

        // 1) 检查 worker 进程（pgrep）
        try {
            var pg = await Tools.System.terminal.hiddenExec("pgrep -f worker.py || true", { timeoutMs: 5000 });
            var pgs = String(pg && (pg.stdout || pg.output || pg) || '').trim();
            if (pgs) {
                out.process_count = pgs.split(/\s+/).filter(Boolean).length;
                out.pids = pgs.split(/\s+/).filter(Boolean);
            }
        } catch (e) { out.messages.push('pgrep 失败: ' + (e.message || String(e))); }

        // 2) 读 worker 启动日志（/tmp/engine_worker.log 尾部）
        try {
            var tr = await Tools.Files.read('/tmp/engine_worker.log');
            var txt = tr && (tr.content || tr.text || '') || '';
            out.tmp_log_tail = String(txt).split('\n').slice(-15).join('\n');
        } catch (e) { out.messages.push('读 /tmp/engine_worker.log 失败: ' + (e.message || String(e))); }

        // 3) 读 engine.log（worker 自身日志，若有）
        try {
            var el = await Tools.Files.read('/sdcard/Download/Operit/character_memory_engine/logs/engine.log');
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
  return run('deploy_restart', params || {}).then(function (result) {
    return finish(result);
  }).catch(function (e) {
    return finish({ success: false, message: e && e.message ? e.message : String(e) });
  });
}

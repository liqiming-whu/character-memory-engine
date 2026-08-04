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

// ===== 一次性 CLI 调用架构（参考 dual-life-hub）=====
// 每次操作：部署 worker → 写 payload.json → bash -lc 调 python worker.py --cli action payload
// → 解析 __LIFE_HUB_JSON__ 标记行。不做常驻 HTTP，避免端口/进程/连接状态问题。

var LINUX_DIR = '/root/character_memory_engine';
var WORKER_PATH = LINUX_DIR + '/worker.py';
var MARKER = '__LIFE_HUB_JSON__';
var _deployed = false;
var _queue = Promise.resolve();

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
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

// 部署 worker.py + embed.py + models（正确用法：await ToolPkg.readResource(key)，签名 (key, outputFileName, internal)）
async function ensureWorker() {
  if (_deployed) return WORKER_PATH;
  try {
    await withTimeout(Tools.Files.mkdir(LINUX_DIR, true, "linux"), 8000, "创建运行目录超时。");
    // 部署 worker.py
    var resource = await withTimeout(
      ToolPkg.readResource("engine_worker_py", "engine_worker_public.py"),
      10000,
      "读取 worker 程序超时。"
    );
    if (!resource) throw new Error("worker 程序资源缺失。");
    await withTimeout(
      Tools.Files.copy(String(resource), WORKER_PATH, false, "android", "linux"),
      10000,
      "部署 worker 程序超时。"
    );
    // 部署 embed.py（worker 依赖 from embed import Embedder）
    try {
      var embedSrc = await ToolPkg.readResource("engine_embed_py", "engine_embed_public.py");
      if (embedSrc) {
        await Tools.Files.copy(String(embedSrc), LINUX_DIR + "/embed.py", false, "android", "linux");
      }
    } catch (e) {}
    // 部署 models（worker 用 _SCRIPT_DIR/models 探测）
    try {
      await Tools.Files.mkdir(LINUX_DIR + "/models", true, "linux");
      var modelFiles = [
        ["engine_model_config", "config.json"],
        ["engine_model_onnx", "model_int8.onnx"],
        ["engine_model_tokenizer", "tokenizer.json"]
      ];
      for (var mi = 0; mi < modelFiles.length; mi++) {
        try {
          var mSrc = await ToolPkg.readResource(modelFiles[mi][0], "engine_" + modelFiles[mi][1]);
          if (mSrc) {
            await Tools.Files.copy(String(mSrc), LINUX_DIR + "/models/" + modelFiles[mi][1], false, "android", "linux");
          }
        } catch (e) {}
      }
    } catch (e) {}
    _deployed = true;
  } catch (e) {
    throw e;
  }
  return WORKER_PATH;
}

function parseCliOutput(result) {
  var output = String(result && result.output || "");
  var pos = output.lastIndexOf(MARKER);
  if (pos < 0) {
    throw new Error("worker 没有返回有效结果。\n" + output.slice(-1000));
  }
  var line = output.slice(pos + MARKER.length).split(/\r?\n/)[0].trim();
  var parsed;
  try { parsed = JSON.parse(line); }
  catch (_error) { throw new Error("worker 结果无法解析。\n" + line.slice(0, 1000)); }
  return parsed;
}

async function execWorker(command) {
  var terminal = Tools.System && Tools.System.terminal;
  if (!terminal) throw new Error("Operit 未提供终端执行能力。");
  if (typeof terminal.hiddenExec === "function") {
    return withTimeout(
      terminal.hiddenExec(command, { executorKey: "character_memory_engine", timeoutMs: 30000 }),
      35000,
      "worker 操作超时。"
    );
  }
  var session = await withTimeout(
    terminal.create("character_memory_engine_once"),
    8000,
    "创建终端会话超时。"
  );
  if (!session || !session.sessionId) throw new Error("无法创建终端会话。");
  try {
    return await withTimeout(
      terminal.exec(session.sessionId, command, 30000),
      35000,
      "worker 操作超时。"
    );
  } finally {
    try { await terminal.close(session.sessionId); } catch (_closeError) {}
  }
}

async function runOnce(action, payload) {
  var worker = await ensureWorker();
  var payloadPath = LINUX_DIR + "/payload_" + Date.now() + "_" + Math.floor(Math.random() * 1000000) + ".json";
  await withTimeout(
    Tools.Files.write(payloadPath, JSON.stringify(payload || {}), false, "linux"),
    8000,
    "写入操作参数超时。"
  );
  try {
    var script = [
      "unset PYTHONHOME PYTHONPATH",
      "export PYTHONUTF8=1 LC_ALL=C LANG=C",
      "python_bin=\"$(command -v python3 2>/dev/null || true)\"",
      "[ -n \"$python_bin\" ] || { echo 'python3 not found'; exit 127; }",
      "\"$python_bin\" " + shellQuote(worker) + " --cli " + shellQuote(String(action)) + " " + shellQuote(payloadPath)
    ].join("; ");
    var result = await execWorker("bash -lc " + shellQuote(script));
    return parseCliOutput(result);
  } finally {
    try { await Tools.Files.deleteFile(payloadPath, false, "linux"); } catch (_deleteError) {}
  }
}

function run(action, payload) {
  var task = function () { return runOnce(action, payload || {}); };
  var current = _queue.then(task, task);
  _queue = current.catch(function () {});
  return current;
}

// 工具导出：显式 exports（Operit subpackage 解析器识别显式导出名）
function makeTool(action) {
  return function (params) {
    return run(action, params || {}).then(function (result) {
      complete(result);
    }).catch(function (e) {
      complete({ success: false, message: e && e.message ? e.message : String(e) });
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
            complete({ success: false, message: '没有找到对话' });
            return;
        }
        // 取对话消息（限 200 条防超长）
        var messages = [];
        try {
            var msgResult = await Tools.Chat.getMessages(chatId, { order: 'asc', limit: 200 });
            if (msgResult && msgResult.messages) messages = msgResult.messages;
        } catch (e) {}
        if (messages.length === 0) {
            complete({ success: false, message: '对话内容为空' });
            return;
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
            complete({ success: false, message: '对话内容过短' });
            return;
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
            complete({ success: false, message: '未配置 API Endpoint 或 Key（请在设置中配置 MEMORY_SYSTEM_*）' });
            return;
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
        complete(result);
    } catch (e) {
        complete({ success: false, message: '分析异常: ' + (e.message || String(e)) });
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
        complete({ success: true, diag: out });
    } catch (e) {
        complete({ success: false, message: '诊断异常: ' + (e.message || String(e)) });
    }
}
exports.diag_engine = diagEngine;

// ===== deploy_*：通过 worker CLI 一次性调用 =====
function deployStatus(params) {
  run('deploy_status', params || {}).then(function (result) {
    complete(result);
  }).catch(function (e) {
    complete({ success: false, message: e && e.message ? e.message : String(e) });
  });
}

function deployInstall(params) {
  run('deploy_install', params || {}).then(function (result) {
    complete(result);
  }).catch(function (e) {
    complete({ success: false, message: e && e.message ? e.message : String(e) });
  });
}

function deployRestart(params) {
  run('deploy_restart', params || {}).then(function (result) {
    complete(result);
  }).catch(function (e) {
    complete({ success: false, message: e && e.message ? e.message : String(e) });
  });
}

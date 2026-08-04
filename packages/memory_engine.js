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

// Worker HTTP 地址（可经 env 覆盖）
function workerUrl() {
    var u = '';
    try { u = getEnv('MEMORY_ENGINE_WORKER_URL') || ''; } catch (e) {}
    return u || 'http://127.0.0.1:8765';
}

// 写日志：经 worker log_event 落到 engine.log（fire-and-forget，失败不影响业务）
function logLocal(level, msg) {
    try {
        Tools.Net.http({
            url: workerUrl(),
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'log_event', params: { level: level, message: msg } }),
            connect_timeout: 2000,
            read_timeout: 2000,
            ignore_ssl: true
        }).catch(function() {});
    } catch (e) {}
}

// 调 worker：POST JSON { action, params }
async function callEngine(action, params) {
    var url = workerUrl();
    try {
        var response = await Tools.Net.http({
            url: url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: action, params: params || {} }),
            connect_timeout: 5000,
            read_timeout: 60000,
            ignore_ssl: true
        });
        var body = '';
        if (typeof response === 'string') body = response;
        else if (response && response.body) body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
        else if (response && response.content) body = response.content;
        if (!body) {
            logLocal('ERROR', 'callEngine ' + action + ': worker 无响应');
            return { success: false, message: 'worker 无响应' };
        }
        return JSON.parse(body);
    } catch (e) {
        // worker 可能刚启动尚未就绪：等 1.5s 重试一次（应用冷启动首批调用常见）
        logLocal('DEBUG', 'callEngine ' + action + ' 首次失败，1.5s 后重试: ' + (e.message || String(e)));
        await new Promise(function (res) { setTimeout(res, 1500); });
        try {
            var retry = await Tools.Net.http({
                url: url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: action, params: params || {} }),
                connect_timeout: 5000,
                read_timeout: 60000,
                ignore_ssl: true
            });
            var rbody = '';
            if (typeof retry === 'string') rbody = retry;
            else if (retry && retry.body) rbody = typeof retry.body === 'string' ? retry.body : JSON.stringify(retry.body);
            else if (retry && retry.content) rbody = retry.content;
            if (rbody) return JSON.parse(rbody);
        } catch (e2) {}
        logLocal('ERROR', 'callEngine ' + action + ': ' + (e.message || String(e)));
        return { success: false, message: 'worker 调用失败: ' + (e.message || String(e)), action: action };
    }
}

// 工具导出：显式 exports（Operit subpackage 解析器识别显式导出名）
function makeTool(action) {
    return async function (params) {
        try {
            var result = await callEngine(action, params || {});
            complete(result);
        } catch (e) {
            complete({ success: false, message: e.message || String(e) });
        }
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
        // 传给 worker 分析
        var result = await callEngine('analyze_chat', {
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

// ===== deploy_*：优先走 worker，worker 未运行时插件侧直连 =====
async function execTerminal(cmd, timeoutMs) {
    try {
        var r = await Tools.System.terminal.hiddenExec(cmd, { timeoutMs: timeoutMs || 15000 });
        var out = '';
        if (typeof r === 'string') out = r;
        else if (r && (r.stdout || r.output)) out = r.stdout || r.output;
        else if (r && r.body) out = r.body;
        return String(out || '').trim();
    } catch (e) {
        try {
            var sess = await Tools.System.terminal.create('engine_deploy');
            await Tools.System.terminal.exec(sess.sessionId, cmd, timeoutMs || 15000);
            return '';
        } catch (e2) {
            return '';
        }
    }
}

async function deployStatus(params) {
    // 优先 worker（能拿到完整状态）；worker 未运行则插件侧降级诊断
    try {
        var wr = await pingWorker();
        if (wr) {
            var result = await callEngine('deploy_status', params || {});
            complete(result);
            return;
        }
    } catch (e) {}
    // worker 未运行：插件侧直连检查
    var status = { worker_running: false, plugin_diag: true };
    try {
        var pgs = await execTerminal('pgrep -f worker.py || true', 5000);
        if (pgs) { status.worker_running = true; status.worker_pid = pgs.split(/\s+/)[0]; }
    } catch (e) {}
    try {
        var tmp = await Tools.Files.read('/tmp/engine_worker.log');
        if (tmp && (tmp.content || tmp.text)) {
            status.tmp_log_tail = String(tmp.content || tmp.text).split('\n').slice(-8).join('\n');
        }
    } catch (e) {}
    complete({ success: true, status: status, degraded: true, message: 'Worker 未运行，显示插件侧降级状态' });
}

async function deployInstall(params) {
    // 优先 worker 内 pip install；worker 未运行则插件侧直连 pip
    try {
        var wr = await pingWorker();
        if (wr) {
            var result = await callEngine('deploy_install', params || {});
            complete(result);
            return;
        }
    } catch (e) {}
    // 插件侧直连：用 venv python -m pip install 缺失依赖
    var missing = [];
    for (var mi = 0; mi < ['onnxruntime', 'sqlite-vec', 'tokenizers'].length; mi++) {
        var mod = ['onnxruntime', 'sqlite-vec', 'tokenizers'][mi];
        var ck = await execTerminal('/root/.venv/bin/python3 -c "import ' + mod + '" && echo OK || echo MISSING', 8000);
        if (ck.indexOf('OK') < 0) missing.push(mod);
    }
    if (missing.length === 0) {
        complete({ success: true, installed: [], message: '依赖已齐全' });
        return;
    }
    var pipCmd = '/root/.venv/bin/python3 -m pip install ' + missing.join(' ') + ' 2>&1 | tail -5';
    var out = await execTerminal(pipCmd, 300000);
    // 验证是否装成功
    var installed = [];
    for (var vi = 0; vi < missing.length; vi++) {
        var m = missing[vi];
        var ck2 = await execTerminal('/root/.venv/bin/python3 -c "import ' + m + '" && echo OK || echo MISSING', 8000);
        if (ck2.indexOf('OK') >= 0) installed.push(m);
    }
    complete({ success: true, installed: installed, missing: missing, output: String(out).slice(-300), message: installed.length ? ('已安装: ' + installed.join(', ')) : '安装未完成，请查看输出' });
}

async function deployRestart(params) {
    try {
        var wr = await pingWorker();
        if (wr) {
            var result = await callEngine('deploy_restart', params || {});
            complete(result);
            return;
        }
    } catch (e) {}
    // 插件侧直连：杀 worker 进程（实际重启由 onAppCreate/ensureWorkerRunning 兜底）
    var killed = [];
    try {
        var pgs = await execTerminal('pgrep -f worker.py || true', 5000);
        var pids = pgs ? pgs.split(/\s+/).filter(Boolean) : [];
        for (var ki = 0; ki < pids.length; ki++) {
            await execTerminal('kill ' + pids[ki] + ' 2>/dev/null || true', 3000);
            killed.push(pids[ki]);
        }
    } catch (e) {}
    complete({ success: true, killed: killed, restart: '已杀进程，下次插件启动时自动拉起 worker' });
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;
exports.onAppCreate = onAppCreate;
exports.onPromptFinalize = onPromptFinalize;

var index_ui_js_1 = __importDefault(require("./ui/memory_system_ui/screen.js"));

// ===== Worker 部署与启动 =====
// 参考 dual-life-hub：用 ToolPkg.readResource 把 worker.py 从包资源复制到固定路径，
// 不依赖 toolpkg_cache 解压位置（该位置在 Operit 升级/清理时会变）。
var TOOLPKG_ID = 'com.operit.character_memory_engine';
var WORKER_DIR = '/root/character_memory_engine'; // 与 venv 同目录，root 下可写
var WORKER_PATH = WORKER_DIR + '/worker.py';
var EMBED_PATH = WORKER_DIR + '/embed.py';
var WORKER_PORT = 8765;
var TRIGGER_FILE = WORKER_DIR + '/trigger.json';
var COOLDOWN_MS = 20 * 60 * 1000; // 连续静默 20 分钟后结算旧对话
var AUTO_ANALYZE_ENABLED = true; // 自动分析开关

// Worker 地址：统一走 env 覆盖（与 memory_engine.js workerUrl 一致），默认 8765
function workerUrl() {
    var u = '';
    try { u = getEnv('MEMORY_ENGINE_WORKER_URL') || ''; } catch (e) {}
    return u || 'http://127.0.0.1:' + WORKER_PORT;
}

// 写日志：经 worker log_event 落到 engine.log（fire-and-forget，失败不影响业务）
function jsLog(level, msg) {
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

async function execTerminal(cmd, timeoutMs) {
    try {
        var r = await Tools.System.terminal.hiddenExec(cmd, { timeoutMs: timeoutMs || 15000 });
        var s = '';
        if (typeof r === 'string') s = r;
        else if (r && (r.stdout || r.output)) s = r.stdout || r.output;
        else if (r && r.body) s = r.body;
        return String(s || '');
    } catch (e) {
        try {
            var sess = await Tools.System.terminal.create('engine_start');
            await Tools.System.terminal.exec(sess.sessionId, cmd, timeoutMs || 15000);
        } catch (e2) {}
        return '';
    }
}

// 把 worker.py / embed.py / models 从包资源部署到固定路径（dual-life-hub 同款模式）
var _deployed = false;
async function deployWorkerFiles() {
    if (_deployed) return true;
    try {
        await execTerminal('mkdir -p ' + WORKER_DIR + '/models', 8000);
        // readResource 返回复制到缓存后的绝对路径，再 copy 到固定目录
        var workerSrc = ToolPkg.readResource(TOOLPKG_ID, 'engine_worker_py', 'worker.py', 'false');
        if (workerSrc) {
            await Tools.Files.copy(String(workerSrc), WORKER_PATH, false, 'android', 'linux');
        }
        var embedSrc = ToolPkg.readResource(TOOLPKG_ID, 'engine_embed_py', 'embed.py', 'false');
        if (embedSrc) {
            await Tools.Files.copy(String(embedSrc), EMBED_PATH, false, 'android', 'linux');
        }
        // 模型资源：config.json / model_int8.onnx / tokenizer.json → models/
        var modelFiles = [
            ['engine_model_config', 'config.json'],
            ['engine_model_onnx', 'model_int8.onnx'],
            ['engine_model_tokenizer', 'tokenizer.json']
        ];
        for (var mi = 0; mi < modelFiles.length; mi++) {
            try {
                var mSrc = ToolPkg.readResource(TOOLPKG_ID, modelFiles[mi][0], modelFiles[mi][1], 'false');
                if (mSrc) {
                    await Tools.Files.copy(String(mSrc), WORKER_DIR + '/models/' + modelFiles[mi][1], false, 'android', 'linux');
                }
            } catch (e) {
                jsLog('WARN', 'deployWorkerFiles: 模型 ' + modelFiles[mi][1] + ' 部署失败: ' + (e.message || String(e)));
            }
        }
        var ok = await execTerminal('test -f ' + WORKER_PATH + ' && echo OK', 5000);
        _deployed = String(ok).indexOf('OK') >= 0;
        if (!_deployed) jsLog('ERROR', 'deployWorkerFiles: worker.py 复制到 ' + WORKER_PATH + ' 失败');
        return _deployed;
    } catch (e) {
        jsLog('ERROR', 'deployWorkerFiles: ' + (e.message || String(e)));
        return false;
    }
}

// ensureWorkerRunning 单例：并发调用共享同一次启动，避免重复拉起 worker
var _ensureRunningPromise = null;
function ensureWorkerRunning() {
    if (!_ensureRunningPromise) {
        _ensureRunningPromise = doEnsureWorkerRunning().finally(function() {
            _ensureRunningPromise = null;
        });
    }
    return _ensureRunningPromise;
}

async function doEnsureWorkerRunning() {
    try {
        // 1) 检查 worker HTTP 是否已在运行
        var ok = await pingWorker();
        if (ok) return true;
        jsLog('DEBUG', 'ensureWorkerRunning: worker 未运行，准备启动');

        // 2) 部署 worker.py / embed.py 到固定路径
        var deployed = await deployWorkerFiles();
        if (!deployed) {
            jsLog('ERROR', 'ensureWorkerRunning: worker.py 部署失败，无法启动');
            return false;
        }

        // 3) 选择 python：优先 /root/.venv（真机已验证），否则系统 python3
        var pyCmd = '';
        try {
            var venvOk = await execTerminal("test -x /root/.venv/bin/python3 && echo OK", 5000);
            if (String(venvOk).indexOf('OK') >= 0) {
                pyCmd = '/root/.venv/bin/python3';
            }
        } catch (e) {}
        if (!pyCmd) pyCmd = 'python3';

        // 4) 启动 worker（后台，日志重定向到 /tmp/engine_worker.log）
        var cmd = 'cd ' + WORKER_DIR + ' && nohup ' + pyCmd + ' worker.py --port ' + WORKER_PORT + ' > /tmp/engine_worker.log 2>&1 &';
        jsLog('INFO', 'ensureWorkerRunning: 启动 worker -> ' + cmd);
        try {
            await Tools.System.terminal.hiddenExec(cmd, { timeoutMs: 15000 });
        } catch (e) {
            // 无 hiddenExec 时降级
            try {
                var sess = await Tools.System.terminal.create('engine_worker');
                await Tools.System.terminal.exec(sess.sessionId, cmd, 15000);
            } catch (e2) {
                jsLog('WARN', 'ensureWorkerRunning: 启动 worker 失败: ' + (e2.message || String(e2)));
            }
        }

        // 5) 等待 worker 就绪
        for (var i = 0; i < 12; i++) {
            await new Promise(function(res) { setTimeout(res, 1000); });
            if (await pingWorker()) return true;
        }
        jsLog('ERROR', 'ensureWorkerRunning: 12 秒内 ping 不通 worker');
        return false;
    } catch (e) {
        jsLog('ERROR', 'ensureWorkerRunning: ' + (e.message || String(e)));
        return false;
    }
}

async function pingWorker() {
    try {
        var url = workerUrl();
        var resp = await Tools.Net.http({
            url: url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'ping_worker', params: {} }),
            connect_timeout: 3000,
            read_timeout: 5000
        });
        var body = '';
        if (typeof resp === 'string') body = resp;
        else if (resp && resp.body) body = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
        else if (resp && resp.content) body = resp.content;
        if (!body) return false;
        try {
            var parsed = JSON.parse(body);
            return parsed && parsed.success === true;
        } catch (e) {
            return false;
        }
    } catch (e) {
        return false;
    }
}

// ===== 自动分析：PromptFinalize 冷却期结算旧对话 → worker AI 提取 =====
async function autoAnalyzeChat(chatId, callerCardId, personaName) {
  if (!chatId || !AUTO_ANALYZE_ENABLED) {
    jsLog('DEBUG', 'autoAnalyze: 跳过 chatId=' + (chatId || '(空)') + ' enabled=' + AUTO_ANALYZE_ENABLED);
    return;
  }
  jsLog('INFO', 'autoAnalyze 开始 chatId=' + chatId);
  try {
    // 取对话
    var msgResult = await Tools.Chat.getMessages(chatId, { order: 'asc', limit: 200 });
    if (!msgResult || !msgResult.messages || msgResult.messages.length === 0) {
      jsLog('DEBUG', 'autoAnalyze: 取对话为空 chatId=' + chatId);
      return;
    }
    var lines = [];
    for (var mi = 0; mi < msgResult.messages.length; mi++) {
      var m = msgResult.messages[mi];
      var c = (m.content || '').replace(/<attachment[^>]*>[\s\S]*?<\/attachment>/g, '').trim();
      if (!c) continue;
      if (c.length > 500) c = c.substring(0, 500) + '...';
      var role = (m.sender === 'user' || m.sender === 'USER') ? '用户' : 'AI';
      lines.push(role + ': ' + c);
    }
    var chatText = lines.join('\n');
    if (chatText.length < 10) {
      jsLog('DEBUG', 'autoAnalyze: 对话内容过短 chatId=' + chatId);
      return;
    }
    // 读 LLM 配置
    var endpoint = '';
    try { endpoint = (getEnv('MEMORY_SYSTEM_ENDPOINT') || '').replace(/\/+$/, ''); } catch (e) {}
    if (endpoint && endpoint.indexOf('/chat/completions') < 0) endpoint += '/chat/completions';
    var apiKey = '';
    try { apiKey = getEnv('MEMORY_SYSTEM_KEY') || ''; } catch (e) {}
    var model = 'gpt-4o-mini';
    try { model = getEnv('MEMORY_SYSTEM_MODEL') || 'gpt-4o-mini'; } catch (e) {}
    if (!endpoint || !apiKey) {
      jsLog('WARN', 'autoAnalyze: 未配置 LLM（endpoint/key），跳过 chatId=' + chatId);
      return;
    }
    // 调 worker analyze_chat
    var payload = {
      action: 'analyze_chat',
      params: {
        chat_text: chatText,
        endpoint: endpoint,
        api_key: apiKey,
        model: model,
        character_id: callerCardId ? String(callerCardId) : undefined,
        persona_name: personaName || ''
      }
    };
    var url = workerUrl();
    var resp = await Tools.Net.http({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      connect_timeout: 5000,
      read_timeout: 120000,
      ignore_ssl: true
    });
    var rbody = '';
    if (typeof resp === 'string') rbody = resp;
    else if (resp && resp.body) rbody = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    else if (resp && resp.content) rbody = resp.content;
    var resObj = null;
    if (typeof rbody === 'string') { try { resObj = JSON.parse(rbody); } catch (e) {} }
    else resObj = rbody;
    if (resObj && resObj.success) {
      jsLog('INFO', 'autoAnalyze 完成 chatId=' + chatId + ' stats=' + JSON.stringify(resObj.stats || {}));
    } else {
      jsLog('ERROR', 'autoAnalyze 失败 chatId=' + chatId + ' resp=' + String(rbody).slice(0, 300));
    }
  } catch (e) {
    jsLog('ERROR', 'autoAnalyze 异常 chatId=' + chatId + ': ' + (e.message || String(e)));
  }
}

// PromptFinalize：冷却期检查 + 自动分析（必须命名导出）
async function onPromptFinalize(input) {
  var evt = (input && input.eventPayload) || {};
  var stage = String(evt.stage ?? input.eventName ?? "");
  if (stage !== "before_send_to_model") return null;
  try {
    var now = Date.now();
    var currentChatId = String(evt.chatId || "").trim();
    var activePrompt = evt.metadata && evt.metadata.activePrompt;
    var callerCardId = (activePrompt && activePrompt.type === 'character_card') ? String(activePrompt.id || '') : '';
    var personaName = (activePrompt && activePrompt.name) ? String(activePrompt.name || '') : '';

    var trigger = null;
    try {
      var tr = await Tools.Files.read(TRIGGER_FILE);
      if (tr && tr.content) trigger = JSON.parse(tr.content);
    } catch (e) {
      jsLog('DEBUG', 'onPromptFinalize: 读 trigger 失败: ' + (e.message || String(e)));
    }

    if (!trigger) {
      try {
        await Tools.Files.write(TRIGGER_FILE, JSON.stringify({ chatId: currentChatId, cooldownStart: now, callerCardId: callerCardId, personaName: personaName }, null, 2), false, 'android');
      } catch (e) {
        jsLog('DEBUG', 'onPromptFinalize: 写 trigger 失败: ' + (e.message || String(e)));
      }
    } else {
      var cooldownPassed = (now - (trigger.cooldownStart || now)) >= COOLDOWN_MS;
      var processChatId = trigger.chatId || currentChatId;
      var chatIdChanged = trigger.chatId && trigger.chatId !== currentChatId;
      if (cooldownPassed || chatIdChanged) {
        jsLog('INFO', 'onPromptFinalize: 触发自动分析 chatId=' + processChatId + ' cooldownPassed=' + cooldownPassed + ' chatChanged=' + chatIdChanged);
        autoAnalyzeChat(processChatId, trigger.callerCardId || callerCardId, trigger.personaName || personaName).catch(function() {});
      }
      try {
        await Tools.Files.write(TRIGGER_FILE, JSON.stringify({ chatId: currentChatId, cooldownStart: now, callerCardId: callerCardId, personaName: personaName }, null, 2), false, 'android');
      } catch (e) {
        jsLog('DEBUG', 'onPromptFinalize: 更新 trigger 失败: ' + (e.message || String(e)));
      }
    }
  } catch (e) {
    jsLog('WARN', 'onPromptFinalize 异常: ' + (e.message || String(e)));
  }
  return null;
}

// 应用创建时启动 worker（必须命名导出，Operit 要求 hook function 从模块导出）
function onAppCreate() {
    ensureWorkerRunning().then(function(ok) {
        try { setEnv('MEMORY_ENGINE_WORKER_READY', ok ? '1' : '0'); } catch (e) {}
        if (!ok) jsLog('ERROR', 'onAppCreate: worker 启动失败（READY=0）');
    }).catch(function(e) {
        jsLog('ERROR', 'onAppCreate: ensureWorkerRunning 异常: ' + (e && e.message ? e.message : String(e)));
    });
    return { ok: true };
}

function registerToolPkg() {
    // 侧边栏 UI 模块（复用前端）
    ToolPkg.registerToolboxUiModule({
        id: "memory_engine_ui",
        runtime: "compose_dsl",
        screen: index_ui_js_1.default,
        params: {},
        title: { zh: "记忆引擎", en: "Memory Engine" }
    });

    ToolPkg.registerNavigationEntry({
        id: "memory_engine_nav",
        route: "toolpkg:com.operit.character_memory_engine:ui:memory_engine_ui",
        surface: "main_sidebar_plugins",
        title: { zh: "记忆引擎", en: "Memory Engine" },
        icon: "memory",
        order: 51
    });

    // 应用创建时尝试启动 worker
    ToolPkg.registerAppLifecycleHook({
        id: "memory_engine_worker_start",
        event: "application_on_create",
        function: onAppCreate
    });

    // 自动分析：对话结算时触发 AI 提取
    ToolPkg.registerPromptFinalizeHook({
        id: "memory_engine_prompt_finalize",
        function: onPromptFinalize
    });

    return true;
}

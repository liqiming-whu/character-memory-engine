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
// CLI 架构（参考 dual-life-hub）：worker 不常驻，每次工具调用起一次性进程。
// 数据按 DATA_DIR 规范落到 /sdcard/Download/Operit/character_memory_engine。
var WORKER_PORT = 8765;
var TRIGGER_FILE = '/sdcard/Download/Operit/character_memory_engine/trigger.json';
var COOLDOWN_MS = 20 * 60 * 1000; // 连续静默 20 分钟后结算旧对话
var AUTO_ANALYZE_ENABLED = true; // 自动分析开关

// 写日志：追加到 engine.log（不经 worker，CLI 架构下 worker 不常驻）
function jsLog(level, msg) {
  try {
    var logPath = '/sdcard/Download/Operit/character_memory_engine/logs/engine.log';
    var line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + String(level).toUpperCase().padEnd(5) + ' [js] ' + msg + '\n';
    // 先尝试 append（Operit Files 可能无 append，退化为先读后写）
    try {
      Tools.Files.append ? Tools.Files.append(logPath, line, false, 'android') : null;
    } catch (e) {
      try {
        var old = Tools.Files.read(logPath);
        var oldText = (old && (old.content || old.text)) || '';
        Tools.Files.write(logPath, oldText + line, false, 'android');
      } catch (e2) {}
    }
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
    // 调 worker analyze_chat（CLI 一次性调用，参考 dual-life-hub）
    var payload = {
      chat_text: chatText,
      endpoint: endpoint,
      api_key: apiKey,
      model: model,
      character_id: callerCardId ? String(callerCardId) : undefined,
      persona_name: personaName || ''
    };
    var resObj = await runCliOnce('analyze_chat', payload);
    if (resObj && resObj.success) {
      jsLog('INFO', 'autoAnalyze 完成 chatId=' + chatId + ' stats=' + JSON.stringify(resObj.stats || {}));
    } else {
      jsLog('ERROR', 'autoAnalyze 失败 chatId=' + chatId + ' resp=' + JSON.stringify(resObj || {}).slice(0, 300));
    }
  } catch (e) {
    jsLog('ERROR', 'autoAnalyze 异常 chatId=' + chatId + ': ' + (e.message || String(e)));
  }
}

// CLI 一次性调用 worker（main.js 侧独立实现，与 memory_engine.js 相同模式）
var _mainCliDir = '/root/character_memory_engine';
var _mainCliDeployed = false;
var _mainCliQueue = Promise.resolve();
async function runCliOnce(action, payload) {
  var worker = await ensureMainWorker();
  var payloadPath = _mainCliDir + "/payload_" + Date.now() + "_" + Math.floor(Math.random() * 1000000) + ".json";
  await execTerminal("mkdir -p " + _mainCliDir, 5000);
  try {
    await Tools.Files.write(payloadPath, JSON.stringify(payload || {}), false, "linux");
    var script = [
      "unset PYTHONHOME PYTHONPATH",
      "export PYTHONUTF8=1 LC_ALL=C LANG=C",
      "python_bin=\"$(command -v python3 2>/dev/null || true)\"",
      "[ -n \"$python_bin\" ] || { echo 'python3 not found'; exit 127; }",
      "\"$python_bin\" " + worker + " --cli " + action + " " + payloadPath
    ].join("; ");
    var out = await execTerminal("bash -lc " + "'" + script.replace(/'/g, "'\\''") + "'", 120000);
    var MARKER = '__LIFE_HUB_JSON__';
    var pos = String(out).lastIndexOf(MARKER);
    if (pos < 0) return { success: false, message: 'worker 无返回' };
    var line = String(out).slice(pos + MARKER.length).split(/\r?\n/)[0].trim();
    try { return JSON.parse(line); } catch (e) { return { success: false, message: '解析失败' }; }
  } finally {
    try { await Tools.Files.deleteFile(payloadPath, false, "linux"); } catch (e) {}
  }
}
async function ensureMainWorker() {
  if (_mainCliDeployed) return _mainCliDir + '/worker.py';
  await execTerminal("mkdir -p " + _mainCliDir + "/models", 5000);
  var resource = await ToolPkg.readResource("engine_worker_py", "engine_worker_public.py");
  if (!resource) throw new Error('worker 资源缺失');
  await Tools.Files.copy(String(resource), _mainCliDir + "/worker.py", false, "android", "linux");
  // embed.py（worker 依赖 from embed import Embedder）
  try {
    var embedSrc = await ToolPkg.readResource("engine_embed_py", "engine_embed_public.py");
    if (embedSrc) await Tools.Files.copy(String(embedSrc), _mainCliDir + "/embed.py", false, "android", "linux");
  } catch (e) {}
  // models
  try {
    var modelFiles = [
      ["engine_model_config", "config.json"],
      ["engine_model_onnx", "model_int8.onnx"],
      ["engine_model_tokenizer", "tokenizer.json"]
    ];
    for (var mi = 0; mi < modelFiles.length; mi++) {
      try {
        var mSrc = await ToolPkg.readResource(modelFiles[mi][0], "engine_" + modelFiles[mi][1]);
        if (mSrc) await Tools.Files.copy(String(mSrc), _mainCliDir + "/models/" + modelFiles[mi][1], false, "android", "linux");
      } catch (e) {}
    }
  } catch (e) {}
  _mainCliDeployed = true;
  return _mainCliDir + '/worker.py';
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

// 应用创建时部署 worker（CLI 架构：不启动常驻进程，首次工具调用时自动部署）
function onAppCreate() {
    // 预部署 worker.py 到固定路径，避免首次调用时等待
    try {
        ensureMainWorker().then(function() {
            try { setEnv('MEMORY_ENGINE_WORKER_READY', '1'); } catch (e) {}
        }).catch(function(e) {
            jsLog('ERROR', 'onAppCreate: worker 预部署失败: ' + (e && e.message ? e.message : String(e)));
            try { setEnv('MEMORY_ENGINE_WORKER_READY', '0'); } catch (e2) {}
        });
    } catch (e) {}
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

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
// 复用真机已验证的部署：代码在 /sdcard/Download/character_memory_engine，
// venv 在 /root/.venv，模型在 models/。
var ENGINE_DIR = '/sdcard/Download/character_memory_engine';
var WORKER_PORT = 8765;
var TRIGGER_FILE = '/sdcard/Download/character_memory_engine/trigger.json';
var COOLDOWN_MS = 20 * 60 * 1000; // 连续静默 20 分钟后结算旧对话
var AUTO_ANALYZE_ENABLED = true; // 自动分析开关

// 写日志：经 worker log_event 落到 engine.log（fire-and-forget，失败不影响业务）
function jsLog(level, msg) {
  try {
    Tools.Net.http({
      url: 'http://127.0.0.1:' + WORKER_PORT,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'log_event', params: { level: level, message: msg } }),
      connect_timeout: 2000,
      read_timeout: 2000,
      ignore_ssl: true
    }).catch(function() {});
  } catch (e) {}
}

async function ensureWorkerRunning() {
    try {
        // 1) 检查 worker HTTP 是否已在运行
        var ok = await pingWorker();
        if (ok) return true;
        jsLog('DEBUG', 'ensureWorkerRunning: worker 未运行，准备启动');

        // 2) 启动 worker（后台，用 venv python）
        var cmd = 'cd ' + ENGINE_DIR + ' && nohup /root/.venv/bin/python3 worker.py --port ' + WORKER_PORT + ' > /tmp/engine_worker.log 2>&1 &';
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

        // 3) 等待 worker 就绪
        for (var i = 0; i < 10; i++) {
            await new Promise(function(res) { setTimeout(res, 1000); });
            if (await pingWorker()) return true;
        }
        jsLog('ERROR', 'ensureWorkerRunning: 10 秒内 ping 不通 worker');
        return false;
    } catch (e) {
        jsLog('ERROR', 'ensureWorkerRunning: ' + (e.message || String(e)));
        return false;
    }
}

async function pingWorker() {
    try {
        var url = 'http://127.0.0.1:' + WORKER_PORT;
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
        else if (resp && resp.body) body = resp.body;
        else if (resp && resp.content) body = resp.content;
        return body && body.indexOf('"success"') >= 0;
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
        character_id: callerCardId || undefined,
        persona_name: personaName || ''
      }
    };
    var url = 'http://127.0.0.1:' + WORKER_PORT;
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
    else if (resp && resp.body) rbody = resp.body;
    else if (resp && resp.content) rbody = resp.content;
    var resObj = null;
    try { resObj = JSON.parse(rbody); } catch (e) {}
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
  var stage = String(input.eventPayload.stage ?? input.eventName ?? "");
  if (stage !== "before_send_to_model") return null;
  try {
    var now = Date.now();
    var currentChatId = String(input.eventPayload.chatId || "").trim();
    var activePrompt = input.eventPayload.metadata && input.eventPayload.metadata.activePrompt;
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

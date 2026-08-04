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

// 写日志：追加到 engine.log（Tools.Files.write 支持 append=true）
function jsLog(level, msg) {
  try {
    var logPath = '/sdcard/Download/Operit/character_memory_engine/logs/engine.log';
    var line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + String(level).toUpperCase().padEnd(5) + ' [js] ' + msg + '\n';
    try {
      Tools.Files.write(logPath, line, true, 'android');
    } catch (e) {
      // append 不可用时退化为先读后写
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
    var resObj = await httpCall('analyze_chat', payload);
    if (resObj && resObj.success) {
      jsLog('INFO', 'autoAnalyze 完成 chatId=' + chatId + ' stats=' + JSON.stringify(resObj.stats || {}));
    } else {
      jsLog('ERROR', 'autoAnalyze 失败 chatId=' + chatId + ' resp=' + JSON.stringify(resObj || {}).slice(0, 300));
    }
  } catch (e) {
    jsLog('ERROR', 'autoAnalyze 异常 chatId=' + chatId + ': ' + (e.message || String(e)));
  }
}

// HTTP 桥接调用 worker（与 memory_engine.js 同模式：常驻 HTTP，避免终端 python3 依赖）
var WORKER_URL = 'http://127.0.0.1:8765';
try { WORKER_URL = getEnv('MEMORY_ENGINE_WORKER_URL') || WORKER_URL; } catch (e) {}
var DATA_DIR = '/sdcard/Download/Operit/character_memory_engine';
try { DATA_DIR = getEnv('MEMORY_ENGINE_DIR') || DATA_DIR; } catch (e) {}

async function httpCall(action, payload) {
  try {
    var resp = await Tools.Net.http({
      url: WORKER_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' },
      body: JSON.stringify({ action: action, params: payload || {} }),
      connect_timeout: 5,
      read_timeout: 60,
      validateStatus: false
    });
    var text = String(resp && (resp.content || resp.body || '') || '');
    var data = null;
    try { data = JSON.parse(text); } catch (e) {}
    if (data && typeof data === 'object') return data;
    return { success: false, message: 'worker 返回无法解析: HTTP ' + (resp && resp.statusCode) + ' ' + text.slice(0, 200) };
  } catch (e) {
    return { success: false, message: 'worker 未响应（' + WORKER_URL + '）：' + (e && e.message ? e.message : String(e)) };
  }
}

// 尝试拉起常驻 worker（幂等）
async function ensureWorkerUp() {
  var ping = await httpCall('ping_worker', {});
  if (ping && ping.success) return { success: true, alreadyUp: true };
  var script = [
    "mkdir -p " + DATA_DIR + "/logs",
    "pgrep -f 'worker.py --port' >/dev/null 2>&1 || (",
    "  nohup /root/.venv/bin/python3.12 " + DATA_DIR + "/worker.py --port 8765 --db " + DATA_DIR + "/engine.db >> " + DATA_DIR + "/logs/engine.log 2>&1 &",
    "  echo started",
    ") || echo already-running"
  ].join('; ');
  try {
    if (Tools.System && Tools.System.terminal && typeof Tools.System.terminal.hiddenExec === 'function') {
      await Tools.System.terminal.hiddenExec('bash -lc ' + "'" + script.replace(/'/g, "'\\''") + "'", { executorKey: 'character_memory_engine', timeoutMs: 20000 });
    }
  } catch (e) {
    return { success: false, message: '拉起 worker 失败: ' + (e && e.message ? e.message : String(e)) };
  }
  await new Promise(function (r) { setTimeout(r, 3000); });
  var ping2 = await httpCall('ping_worker', {});
  if (ping2 && ping2.success) return { success: true, started: true };
  return { success: false, message: '拉起后 worker 仍未响应，请手动启动：nohup /root/.venv/bin/python3.12 ' + DATA_DIR + '/worker.py --port 8765 --db ' + DATA_DIR + '/engine.db &' };
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

// 应用创建时尝试拉起常驻 worker（HTTP 架构：worker 常驻，首次调用即通）
function onAppCreate() {
    try {
        ensureWorkerUp().then(function (up) {
            try { setEnv('MEMORY_ENGINE_WORKER_READY', (up && up.success) ? '1' : '0'); } catch (e) {}
            if (!up || !up.success) jsLog('WARN', 'onAppCreate: worker 未就绪: ' + (up && up.message ? up.message : '未知原因'));
        }).catch(function(e) {
            jsLog('ERROR', 'onAppCreate: worker 拉起异常: ' + (e && e.message ? e.message : String(e)));
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

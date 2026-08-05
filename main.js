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

// hiddenExec 会话策略（v1.0.6+多轮实测）：
// 1. 会话按 executorKey 持久复用；Operit 后台期间 proot 可能被系统回收 → 会话失效 → 调用永久卡（取消机制也失效）
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
async function execTerminal(cmd, timeoutMs) {
    try {
        var r = await hiddenExecSafe(cmd, timeoutMs || 15000);
        return grabOut(r);
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

// 探测可用 python3：优先 proot venv（完整向量），备选系统 python3。
// 用 ls 判断路径存在（比 test -x 更少依赖 shell 行为差异）
async function detectPython() {
  var candidates = [
    '/root/.venv/bin/python3.12',
    '/root/.venv/bin/python3',
    '/usr/bin/python3',
    'python3'
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      var r = await execTerminal("ls -la " + candidates[i] + " 2>/dev/null || true", 8000);
      if (String(r).indexOf('python3') >= 0) return candidates[i];
    } catch (e) {}
  }
  return '';
}

// 部署 worker.py / embed.py / models 到 DATA_DIR（readResource 签名 (key, outputFileName, internal)）
async function deployWorkerToData() {
  try {
    await Tools.Files.mkdir(DATA_DIR + '/models', true, 'android');
    var pairs = [
      ['engine_worker_py', 'worker.py'],
      ['engine_embed_py', 'embed.py']
    ];
    for (var i = 0; i < pairs.length; i++) {
      try {
        var src = await ToolPkg.readResource(pairs[i][0], pairs[i][1], false);
        if (src) await Tools.Files.copy(String(src), DATA_DIR + '/' + pairs[i][1], false, 'android', 'linux');
      } catch (e) {}
    }
    var mf = [['engine_model_config','config.json'],['engine_model_onnx','model_int8.onnx'],['engine_model_tokenizer','tokenizer.json']];
    for (var j = 0; j < mf.length; j++) {
      try {
        var ms = await ToolPkg.readResource(mf[j][0], mf[j][1], false);
        if (ms) await Tools.Files.copy(String(ms), DATA_DIR + '/models/' + mf[j][1], false, 'android', 'linux');
      } catch (e) {}
    }
    return true;
  } catch (e) {
    return false;
  }
}

// 尝试拉起常驻 worker（幂等）。
// 方案：worker.py/embed.py/models 复制到 /root/character_memory_engine（ext4 稳定），
// 用 venv python 运行（完整向量），数据经 --db 落到 /sdcard（用户可访问）。
// setsid 隔离进程组，确保 hiddenExec 结束后后台进程存活。
async function ensureWorkerUp() {
  // 防重入锁：文件标记（跨模块重载有效），60 秒内重复触发直接跳过，避免并发 hiddenExec 锁死会话
  var LOCK = DATA_DIR + '/logs/launching.lock';
  try {
    var lk = Tools.Files.read(LOCK);
    var lkText = (lk && (lk.content || lk.text)) || '';
    var lkTs = parseInt(lkText, 10) || 0;
    if (Date.now() - lkTs < 60000) {
      return { success: false, message: 'worker 正在拉起中，请稍候再试。' };
    }
  } catch (e) {}
  try { Tools.Files.write(LOCK, String(Date.now()), false, 'android'); } catch (e) {}
  freshKey(); // 每次拉起强制全新会话：Operit 重启初期 terminal 未就绪会留下坏会话，绝不复用
  var ping = await httpCall('ping_worker', {});
  if (ping && ping.success) return { success: true, alreadyUp: true };
  // 先确保 worker.py 等在 DATA_DIR
  try { await deployWorkerToData(); } catch (e) {}
  var pyCmd = await detectPython();
  if (!pyCmd) {
    return { success: false, message: '未找到可用 python3，请手动启动：setsid /root/.venv/bin/python3.12 ' + DATA_DIR + '/worker.py --port 8765 --db ' + DATA_DIR + '/engine.db &' };
  }
  // 复制全部 python 文件 + models 到 /root（ext4 稳定），worker 用 venv python 在 /root 运行
  var ROOT_DIR = '/root/character_memory_engine';
  // 无条件杀掉旧 worker 再启动（pgrep 守护不可靠：僵尸/死进程匹配会阻止重启）
  var script = [
    "mkdir -p " + ROOT_DIR + "/models " + DATA_DIR + "/logs",
    "cp -f " + DATA_DIR + "/*.py " + ROOT_DIR + "/ 2>/dev/null || true",
    "cp -rf " + DATA_DIR + "/models/. " + ROOT_DIR + "/models/ 2>/dev/null || true",
    "if [ ! -f " + ROOT_DIR + "/worker.py ]; then echo 'NO_WORKER'; exit 1; fi",
    "for p in /proc/[0-9]*; do if [ -r \"$p/cmdline\" ]; then c=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null); case \"$c\" in *worker.py*) kill $(basename $p) 2>/dev/null;; esac; fi; done; sleep 1",
    "setsid " + pyCmd + " " + ROOT_DIR + "/worker.py --port 8765 --db " + DATA_DIR + "/engine.db >> " + DATA_DIR + "/logs/engine.log 2>&1 < /dev/null & echo started"
  ].join('; ');
  try {
    if (Tools.System && Tools.System.terminal && typeof Tools.System.terminal.hiddenExec === 'function') {
      // 探针验证 hiddenExec 直接执行多语句命令可用，无需 bash -lc 包装
      await hiddenExecSafe(script, 30000);
    }
  } catch (e) {
    return { success: false, message: '拉起 worker 失败: ' + (e && e.message ? e.message : String(e)) };
  }
  await new Promise(function (r) { setTimeout(r, 3000); });
  var ping2 = await httpCall('ping_worker', {});
  try { Tools.Files.write(LOCK, '', false, 'android'); } catch (e) {}
  if (ping2 && ping2.success) return { success: true, started: true, python: pyCmd };
  return { success: false, message: '拉起后 worker 仍未响应（python=' + pyCmd + '），请手动启动：setsid /root/.venv/bin/python3.12 ' + ROOT_DIR + '/worker.py --port 8765 --db ' + DATA_DIR + '/engine.db &' };
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
// 延迟 30 秒：Operit 重启后 terminal/proot 子系统需时间初始化，过早调用会创建坏会话导致后续永久卡
function onAppCreate() {
    try {
        setTimeout(function () {
            ensureWorkerUp().then(function (up) {
                try { setEnv('MEMORY_ENGINE_WORKER_READY', (up && up.success) ? '1' : '0'); } catch (e) {}
                if (!up || !up.success) jsLog('WARN', 'onAppCreate: worker 未就绪: ' + (up && up.message ? up.message : '未知原因'));
            }).catch(function (e) {
                jsLog('ERROR', 'onAppCreate: worker 拉起异常: ' + (e && e.message ? e.message : String(e)));
                try { setEnv('MEMORY_ENGINE_WORKER_READY', '0'); } catch (e2) {}
            });
        }, 30000);
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

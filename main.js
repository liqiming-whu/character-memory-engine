"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;
exports.onAppCreate = onAppCreate;
exports.onPromptFinalize = onPromptFinalize;
exports.onPromptInput = onPromptInput;

var index_ui_js_1 = __importDefault(require("./ui/memory_system_ui/screen.js"));

// ===== Worker 部署与启动 =====
// CLI 架构（参考 dual-life-hub）：worker 不常驻，每次工具调用起一次性进程。
// 数据按 DATA_DIR 规范落到 /sdcard/Download/Operit/character_memory_engine。
var WORKER_PORT = 8765;
var TRIGGER_FILE = '/sdcard/Download/Operit/character_memory_engine/trigger.json';
// v2.1.0：上次已保存的角色卡 id（变化才写 characters 表）
var lastSavedCardId = '';
var COOLDOWN_MS = 20 * 60 * 1000; // 连续静默 20 分钟后结算旧对话
var AUTO_ANALYZE_ENABLED = true; // 自动分析开关

// 写日志：追加到 engine.log（Tools.Files.write 支持 append=true）
// v2.3.1：时间戳跟随系统本地时区（原 toISOString 固定 UTC，排查需换算）
function _localTs() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function jsLog(level, msg) {
  try {
    var logPath = '/sdcard/Download/Operit/character_memory_engine/logs/engine.log';
    var line = _localTs() + ' ' + String(level).toUpperCase().padEnd(5) + ' [js] ' + msg + '\n';
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
    // 取最近 200 条（order:'asc' 会取旧窗口漏掉新消息，必须 desc+reverse）
    var msgResult = await Tools.Chat.getMessages(chatId, { order: 'desc', limit: 200 });
    if (msgResult && msgResult.messages) msgResult.messages.reverse();
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
var ROOT_DIR = '/root/character_memory_engine';
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
      // 显式标记输出：ls 的 stderr（含路径名）会被 grabOut 兜回导致误判，只认 PY_OK
      var r = await execTerminal("if [ -x " + candidates[i] + " ]; then echo PY_OK; else echo PY_NO; fi", 8000);
      if (String(r).indexOf('PY_OK') >= 0) return candidates[i];
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
        if (src) await Tools.Files.copy(String(src), DATA_DIR + '/' + pairs[i][1], true, 'android', 'linux');
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
// 方案：worker.py/embed.py/models/db 复制到 /root/character_memory_engine（ext4 稳定），
// 用 venv python 运行（完整向量），db 在 /root 运行（WAL），数据目录保留部署副本（sync_db 热备）。
// setsid 隔离进程组，确保 hiddenExec 结束后后台进程存活。
async function ensureWorkerUp() {
  var ROOT_DIR = '/root/character_memory_engine';
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
    return { success: false, message: '未找到可用 python3，请手动启动：setsid /root/.venv/bin/python3.12 ' + ROOT_DIR + '/worker.py --port 8765 --db ' + ROOT_DIR + '/engine.db &' };
  }
  // 复制全部 python 文件 + models + db 到 /root（ext4 稳定），worker 用 venv python 在 /root 运行
  // db 策略：权威在 /root（worker 首次运行自动生成）；数据目录是热备副本（sync_db 写回）
  // 1) worker 在线时先 HTTP 热备 2) 兜底文件写回 3) 仅首次迁移（/root 无 db 且数据目录有，老版本升级）
  var script = [
    "mkdir -p " + ROOT_DIR + "/models " + DATA_DIR + "/logs",
    "python3 -c \"import urllib.request,json;urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765',data=json.dumps({'action':'sync_db'}).encode()),timeout=3)\" 2>/dev/null || true",
    "if [ -f " + ROOT_DIR + "/engine.db ]; then cp -f " + ROOT_DIR + "/engine.db " + DATA_DIR + "/engine.db 2>/dev/null || true; fi",
    "if [ ! -f " + ROOT_DIR + "/engine.db ] && [ -f " + DATA_DIR + "/engine.db ]; then cp -f " + DATA_DIR + "/engine.db " + ROOT_DIR + "/engine.db; fi",
    "cp -f " + DATA_DIR + "/*.py " + ROOT_DIR + "/ 2>/dev/null || true",
    "cp -rf " + DATA_DIR + "/models/. " + ROOT_DIR + "/models/ 2>/dev/null || true",
    "if [ ! -f " + ROOT_DIR + "/worker.py ]; then echo 'NO_WORKER'; exit 1; fi",
    "for p in /proc/[0-9]*; do if [ -r \"$p/cmdline\" ]; then c=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null); case \"$c\" in *worker.py*) kill $(basename $p) 2>/dev/null;; esac; fi; done; sleep 1",
    "setsid " + pyCmd + " " + ROOT_DIR + "/worker.py --port 8765 --db " + ROOT_DIR + "/engine.db >> " + DATA_DIR + "/logs/engine.log 2>&1 < /dev/null & echo started"
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
  return { success: false, message: '拉起后 worker 仍未响应（python=' + pyCmd + '），请手动启动：setsid /root/.venv/bin/python3.12 ' + ROOT_DIR + '/worker.py --port 8765 --db ' + ROOT_DIR + '/engine.db &' };
}

// PromptFinalize：冷却期检查 + 自动分析（必须命名导出）
// ===== v2.2.0 记忆注入：按官方额外信息注入插件（message_insert）模式实现 =====
// before_send_to_model 阶段召回当前角色记忆，构造 <attachment> 附加到消息返回。
var MEMORY_INJECTION_ATTACHMENT_PREFIX = 'cme_memory_bundle_';
async function readInjectionSettings() {
  try {
    var raw = await Tools.Files.read(DATA_DIR + '/last_ui_state.json');
    if (raw && raw.content) {
      var data = JSON.parse(raw.content);
      var inj = data && data.data && data.data.injection;
      if (inj && typeof inj === 'object') return inj;
    }
    jsLog('DEBUG', 'memory injection: 未找到注入配置 raw=' + (raw ? 'ok' : 'null'));
  } catch (e) {
    jsLog('DEBUG', 'memory injection: 读配置失败 ' + (e.message || String(e)));
  }
  return null;
}
function escapeXmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function collapseWs(s, maxLen) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (maxLen && t.length > maxLen) t = t.substring(0, maxLen) + '…';
  return t;
}
// ===== P8② snapshot 跨轮去重：按 chatId 记录已注入记忆 id =====
var MEMORY_INJECTION_HISTORY_FILE = DATA_DIR + '/memory_injection_history.json';
async function readInjectionHistory() {
  try {
    var raw = await Tools.Files.read(MEMORY_INJECTION_HISTORY_FILE);
    if (raw && raw.content) return JSON.parse(raw.content) || {};
  } catch (e) {}
  return {};
}
function writeInjectionHistory(h) {
  try { Tools.Files.write(MEMORY_INJECTION_HISTORY_FILE, JSON.stringify(h), false, 'android'); } catch (e) {}
}
// ===== P8① 技术降权排序：importance 加权 + 技术类降权，开发记录沉底 =====
var TECH_RE = /技术|调试|bug|报错|error|修复|配置|接口|API/;
function memoryInjectScore(m) {
  var imp = String((m && m.importance) || '').toLowerCase();
  var s = imp === 'high' ? 1000 : (imp === 'medium' ? 500 : 100);
  var text = ((m && m.title) || '') + ' ' + ((m && m.content) || '');
  if (TECH_RE.test(text)) s -= 60;
  return s;
}
async function buildMemoryInjectionText(messageText, callerCardId, chatIdParam) {
  var settings = await readInjectionSettings();
  if (!settings || !settings.enabled) {
    jsLog('DEBUG', 'memory injection: 未启用或配置缺失 enabled=' + (settings && settings.enabled));
    return null;
  }
  var limit = Math.min(Math.max(parseInt(settings.maxMemories, 10) || 5, 1), 20);
  var searchText = String(messageText || '').replace(/<attachment[^>]*>[\s\S]*?<\/attachment>/g, '').replace(/<workspace_attachment[^>]*>[\s\S]*?<\/workspace_attachment>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!searchText) return null;
  // P8②：读取本会话已注入记忆 id，传给 worker 排除
  var chatId = String(chatIdParam || '').trim();
  var history = await readInjectionHistory();
  var prevIds = (chatId && history[chatId]) ? history[chatId] : [];
  // 对齐官方 message_insert：allowRepeatedMemorySearch=true 时允许重复检索（不去重），
  // false（默认）时按会话 id 去重——同一会话已注入过的记忆不再重复注入
  var allowRepeat = settings.allowRepeatedMemorySearch === true;
  var usePrevIds = (!allowRepeat && prevIds.length > 0) ? prevIds : [];
  jsLog('DEBUG', 'inject: q=' + searchText.substring(0, 40) + ' | card=' + (callerCardId || '(空)') + ' | chat=' + chatId + ' | prev=' + usePrevIds.length + ' | allowRepeat=' + allowRepeat);
  var res = await httpCall('search_memories', {
    query: searchText.length > 200 ? searchText.substring(0, 200) : searchText,
    limit: limit * 3,
    character_id: callerCardId || undefined,
    exclude_ids: usePrevIds.length > 0 ? usePrevIds : undefined
  });
  var memories = (res && res.memories) || [];
  jsLog('DEBUG', 'inject: res.success=' + (res && res.success) + ' mems=' + memories.length + (res && res.message ? ' | msg=' + res.message : ''));
  // P8①：importance 加权 + 技术类降权，重排后取前 limit 条（人物/生活记忆优先浮出）
  memories.sort(function(a, b) { return memoryInjectScore(b) - memoryInjectScore(a); });
  memories = memories.slice(0, limit);
  // P8②：记录本次注入的记忆 id（同会话后续轮次不再重复注入）
  if (chatId && memories.length > 0) {
    var used = memories.map(function(m) { return String(m.id); });
    var merged = history[chatId] || [];
    used.forEach(function(id) { if (merged.indexOf(id) < 0) merged.push(id); });
    if (merged.length > 50) merged = merged.slice(-50);
    history[chatId] = merged;
    writeInjectionHistory(history);
  }
  var lines = ['【相关记忆】', '查询: ' + searchText.substring(0, 80), '上限: ' + limit, '结果: ' + memories.length];
  memories.forEach(function(m, i) {
    var title = (m && m.title) || '';
    var content = (m && m.content) || '';
    if (!title) {
      title = (m && m.description) ? collapseWs(m.description, 40) : ('[' + ((m && m.category) || '记忆') + ']');
    }
    lines.push('');
    lines.push('#' + (i + 1));
    lines.push('标题: ' + collapseWs(title, 80));
    if (content) lines.push('内容: ' + collapseWs(content, 300));
  });
  return lines.join('\n');
}
async function injectMemoryAttachment(processedInput, callerCardId, chatId) {
  try {
    var content = await buildMemoryInjectionText(processedInput, callerCardId, chatId);
    if (!content) return null;
    var ts = Date.now();
    var id = MEMORY_INJECTION_ATTACHMENT_PREFIX + ts;
    var filename = 'Memory:' + ts;
    var tag = '<attachment id="' + escapeXmlText(id) + '" filename="' + escapeXmlText(filename) + '" type="text/plain" size="' + content.length + '">' + escapeXmlText(content) + '</attachment>';
    return String(processedInput || '').replace(/\s+$/, '') + ' ' + tag;
  } catch (e) {
    jsLog('WARN', 'memory injection 失败: ' + (e.message || String(e)));
    return null;
  }
}
// v2.2.1：注入内容随消息保存（对齐官方 persistInjectedContent）：
// persist=true → before_process 阶段把注入内容直接拼进消息文本（随消息落库，不走附件）；
// persist=false → 不在此处处理，由 onPromptFinalize 以附件形式临时注入（只给模型看不落库）。
async function onPromptInput(input) {
  var evt = (input && input.eventPayload) || {};
  var stage = String(evt.stage ?? input.eventName ?? "");
  if (stage !== "before_process") return null;
  try {
    var settings = await readInjectionSettings();
    if (!settings || settings.persist !== true) return null;
    var processedInput = String(evt.processedInput ?? evt.rawInput ?? "").trim();
    if (!processedInput) return null;
    var activePrompt = evt.metadata && evt.metadata.activePrompt;
    var callerCardId = (activePrompt && activePrompt.type === 'character_card') ? String(activePrompt.id || '') : '';
    if (!callerCardId) return null;
    var chatId = String(evt.chatId || "").trim();
    var content = await buildMemoryInjectionText(processedInput, callerCardId, chatId);
    if (!content) return null;
    jsLog('DEBUG', 'onPromptInput: persist=true 文本拼接注入 ' + content.length + ' chars');
    return String(processedInput).replace(/\s+$/, '') + '\n\n' + content;
  } catch (e) {
    jsLog('WARN', 'onPromptInput异常: ' + (e.message || String(e)));
    return null;
  }
}
// ===== v2.3.1：trigger.json 原子读写（防并发半写损坏导致水位线丢失）=====
async function writeTriggerAtomicMain(obj) {
  var tmp = TRIGGER_FILE + '.tmp';
  try {
    await Tools.Files.write(tmp, JSON.stringify(obj, null, 2), false, 'android');
    await Tools.Files.move(tmp, TRIGGER_FILE);
  } catch (e) {
    await Tools.Files.write(TRIGGER_FILE, JSON.stringify(obj, null, 2), false, 'android');
  }
}
// 读 trigger.json：返回 {ok:true,data} / {ok:false,missing:true} / {ok:false,missing:false}(损坏)
async function readTriggerJsonMain() {
  for (var i = 0; i < 3; i++) {
    try {
      var raw = await Tools.Files.read(TRIGGER_FILE);
      if (raw && raw.content) {
        var parsed = JSON.parse(raw.content);
        if (parsed && typeof parsed === 'object') return { ok: true, data: parsed };
      } else {
        return { ok: false, missing: true };
      }
    } catch (e) {}
    await new Promise(function (res) { setTimeout(res, 150); });
  }
  return { ok: false, missing: false };
}
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

    // v2.1.0：自动保存当前角色卡到 characters 表（角色页依赖它识别；变化时才写）
    if (callerCardId) {
      try {
        setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_ID', callerCardId);
        setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_NAME', personaName || '未命名角色');
        setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_TYPE', 'character_card');
      } catch (e) {}
      if (callerCardId !== lastSavedCardId) {
        lastSavedCardId = callerCardId;
        try {
          var sv = await httpCall('save_character', { id: callerCardId, name: personaName || '未命名角色' });
          if (!(sv && sv.success)) jsLog('DEBUG', 'save_character 失败: ' + ((sv && sv.message) || 'unknown'));
        } catch (e) {
          jsLog('DEBUG', 'save_character 异常: ' + (e.message || String(e)));
        }
      }
    }

    var trigger = null;
    var triggerReadOk = false;
    var triggerMissing = false;
    try {
      var tr = await readTriggerJsonMain();
      if (tr && tr.ok) { trigger = tr.data; triggerReadOk = true; }
      else if (tr && tr.missing) { triggerMissing = true; }
    } catch (e) {
      jsLog('DEBUG', 'onPromptFinalize: 读 trigger 失败: ' + (e.message || String(e)));
    }

    // v2.3.1：写前合并保留水位线等字段（旧逻辑整写会清空 watermarks/lastAnalyzedAt，导致每次重复全量分析）
    var nextTrigger = { chatId: currentChatId, cooldownStart: now, callerCardId: callerCardId, personaName: personaName };
    if (trigger) {
      if (trigger.watermarks) nextTrigger.watermarks = trigger.watermarks;
      if (trigger.lastAnalyzedAt) nextTrigger.lastAnalyzedAt = trigger.lastAnalyzedAt;
      if (trigger.lastAnalyzedChatId) nextTrigger.lastAnalyzedChatId = trigger.lastAnalyzedChatId;
      if (trigger.lastAnalyzedNewCount !== undefined) nextTrigger.lastAnalyzedNewCount = trigger.lastAnalyzedNewCount;
      if (trigger.lastResult) nextTrigger.lastResult = trigger.lastResult;
      if (trigger.lastCheckedAt) nextTrigger.lastCheckedAt = trigger.lastCheckedAt;
      if (trigger.lastCheckedChatId) nextTrigger.lastCheckedChatId = trigger.lastCheckedChatId;
    }
    if (!triggerReadOk && !triggerMissing) {
      // v2.3.1：trigger.json 读取异常（并发半写/损坏）→ 跳过本次更新，保留旧文件与水位线
      jsLog('WARN', 'onPromptFinalize: trigger.json 读取异常，本次跳过更新（避免清空水位线）');
    } else if (!trigger) {
      try {
        await writeTriggerAtomicMain(nextTrigger);
      } catch (e) {
        jsLog('DEBUG', 'onPromptFinalize: 写 trigger 失败: ' + (e.message || String(e)));
      }
      // v2.1.0：首次识别到角色卡立即分析一次（不等 20 分钟冷却），让角色页尽快有数据
      if (callerCardId) {
        autoAnalyzeChat(currentChatId, callerCardId, personaName).catch(function() {});
      }
    } else {
      var cooldownPassed = (now - (trigger.cooldownStart || now)) >= COOLDOWN_MS;
      var processChatId = trigger.chatId || currentChatId;
      var chatIdChanged = trigger.chatId && trigger.chatId !== currentChatId;
      // v2.1.0：角色卡变化也立即分析（切换角色后快速建立该角色的记忆）
      var cardChanged = !!callerCardId && (trigger.callerCardId || '') !== callerCardId;
      if (cooldownPassed || chatIdChanged || cardChanged) {
        jsLog('INFO', 'onPromptFinalize: 触发自动分析 chatId=' + processChatId + ' cooldownPassed=' + cooldownPassed + ' chatChanged=' + chatIdChanged + ' cardChanged=' + cardChanged);
        autoAnalyzeChat(processChatId, trigger.callerCardId || callerCardId, trigger.personaName || personaName).catch(function() {});
      }
      try {
        await writeTriggerAtomicMain(nextTrigger);
      } catch (e) {
        jsLog('DEBUG', 'onPromptFinalize: 更新 trigger 失败: ' + (e.message || String(e)));
      }
    }
    // v2.2.0：记忆注入（官方额外信息注入插件模式）——召回当前角色记忆附加到消息
    // v2.2.1：persist=true 时注入内容已在 onPromptInput（before_process）阶段拼进消息文本，
    // 此处跳过附件注入避免双份；persist=false 时保持附件注入（只给模型看不落库）
    try {
      var processedInput = String(evt.processedInput ?? evt.rawInput ?? "").trim();
      if (processedInput && callerCardId) {
        var injSettings = await readInjectionSettings();
        if (!(injSettings && injSettings.persist === true)) {
          var injected = await injectMemoryAttachment(processedInput, callerCardId, currentChatId);
          if (injected) return injected;
        } else {
          jsLog('DEBUG', 'onPromptFinalize: persist=true 跳过附件注入（已在 onPromptInput 拼接）');
        }
      }
    } catch (e2) {
      jsLog('WARN', 'onPromptFinalize 注入异常: ' + (e2.message || String(e2)));
    }
  } catch (e) {
    jsLog('WARN', 'onPromptFinalize 异常: ' + (e.message || String(e)));
  }
  return null;
}

// 应用创建时尝试拉起常驻 worker（HTTP 架构：worker 常驻，首次调用即通）
// 延迟 30 秒：实测 Operit 重启早期（数秒内）调用 hiddenExec 有 executor 会话竞态风险，
// 可能创建坏会话导致后续永久卡；30s 是保守兜底值（并非 Ubuntu 实际需要初始化这么久）
function onAppCreate() {
    try {
        setTimeout(function () {
            (async function () {
                // v2.1.0：先强制部署最新 worker.py 到 /root（覆盖旧版残留）
                try { await deployWorkerToData(); } catch (e) {}
                // 版本检查：文件 VERSION 与运行中进程不一致则 kill，下次调用自动拉起新版
                try {
                    var f = await Tools.Files.read(ROOT_DIR + '/worker.py');
                    var ft = (f && (f.content || f.text)) || '';
                    var m = /VERSION\s*=\s*["']([^"']+)["']/.exec(ft);
                    var fileVer = m ? m[1] : '';
                    if (fileVer) {
                        var pingV = await httpCall('ping_worker', {});
                        if (pingV && pingV.success && pingV.version && pingV.version !== fileVer) {
                            jsLog('INFO', 'worker 版本变化 ' + pingV.version + ' -> ' + fileVer + '，重启 worker');
                            var killCmd = "for p in /proc/[0-9]*; do if [ -r \"$p/cmdline\" ]; then c=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null); case \"$c\" in *worker.py*) kill $(basename $p) 2>/dev/null;; esac; fi; done";
                            await hiddenExecSafe(killCmd, 10000);
                        }
                    }
                } catch (e) {}
                var up = await ensureWorkerUp();
                try { setEnv('MEMORY_ENGINE_WORKER_READY', (up && up.success) ? '1' : '0'); } catch (e) {}
                if (!up || !up.success) jsLog('WARN', 'onAppCreate: worker 未就绪: ' + (up && up.message ? up.message : '未知原因'));
            })().catch(function (e) {
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
    // v2.2.1：注入内容随消息保存（persist=true 时 before_process 文本拼接注入）
    ToolPkg.registerPromptInputHook({
        id: "memory_engine_prompt_input",
        function: onPromptInput
    });
    return true;
}

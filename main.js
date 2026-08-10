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
// 上次已保存的角色卡 id（变化才写 characters 表）
var lastSavedCardId = '';
var COOLDOWN_MS = 20 * 60 * 1000; // 连续静默 20 分钟后结算旧对话
var AUTO_ANALYZE_ENABLED = true; // 自动分析开关

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

// 写日志：追加到 engine.log（Tools.Files.write 支持 append=true）
// 时间戳跟随系统本地时区（原 toISOString 固定 UTC，排查需换算）
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

// P0-C3（2026-08-10）：删除 hiddenExec 生产链（getKey/saveKey/freshKey/withRace/hiddenExecSafe/execTerminal）。
// hiddenExec 已被证实可制造跨重启残留的 proot+bash 坏会话；生产代码不再触碰 hiddenExec。
function withTimeout(promise, ms, message) {
  var timer;
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error(message || "操作超时。")); }, ms);
    })
  ]).finally(function () { clearTimeout(timer); });
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

// detectPython 不再做任何 JS 侧文件探测——
// ① hiddenExec 探测会卡 8s×N（32s 阻塞 → ANR/闪退，2026-08-08 实锤）；
// ② Tools.Files.exists(...,'linux') 在当前 Operit 版本不可靠（实测返回空对象，误报 python3 不存在）。
// python 路径由 deploy_install 固定创建（项目 venv），存在性校验下沉到启动脚本 bash [ -x ]（毫秒级）。
async function detectPython() {
  return ROOT_DIR + '/.venv/bin/python3.12';
}

// 部署 worker.py / embed.py / models 到 DATA_DIR（readResource 签名 (key, outputFileName, internal)）
async function deployWorkerToData() {
  try {
    await Tools.Files.mkdir(DATA_DIR + '/models', true, 'android');
    var pairs = [
      ['engine_worker_py', 'worker.py'],
      ['engine_embed_py', 'embed.py'],
      ['engine_start_worker_sh', 'start_worker.sh']
    ];
    for (var i = 0; i < pairs.length; i++) {
      try {
        var src = await ToolPkg.readResource(pairs[i][0], pairs[i][1], false);
        if (src) await Tools.Files.copy(String(src), DATA_DIR + '/' + pairs[i][1], true, 'android', 'linux');
        // start_worker.sh 同时部署到 ROOT_DIR（P0-C4：首次安装即可用，不依赖脚本自同步时序）
        if (pairs[i][1] === 'start_worker.sh') {
          try { await Tools.Files.mkdir(ROOT_DIR, true, 'linux'); } catch (e3) {}
          await Tools.Files.copy(String(src), ROOT_DIR + '/start_worker.sh', true, 'android', 'linux');
        }
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

// 显式资源部署（P0-C4：start_worker.sh 注册为 manifest resource，首次安装可用）。
// 由显式安装路径调用（Phase 1）；onAppCreate 不调用（P0-C1 health-only）。
// 注意：main.js 侧不再有自动拉起路径（P0-C3 删除 ensureWorkerUp/hiddenExec 链）。

// PromptFinalize：冷却期检查 + 自动分析（必须命名导出）
// ===== 记忆注入：按官方额外信息注入插件（message_insert）模式实现 =====
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
// 注入内容随消息保存（对齐官方 persistInjectedContent）: // persist=true → before_process 阶段把注入内容直接拼进消息文本（随消息落库，不走附件）；
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
// ===== trigger.json 原子读写（防并发半写损坏导致水位线丢失）=====
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

    // 自动保存当前角色卡到 characters 表（角色页依赖它识别；变化时才写）
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

    // 写前合并保留水位线等字段（旧逻辑整写会清空 watermarks/lastAnalyzedAt，导致每次重复全量分析）
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
      // trigger.json 读取异常（并发半写/损坏）→ 跳过本次更新，保留旧文件与水位线
      jsLog('WARN', 'onPromptFinalize: trigger.json 读取异常，本次跳过更新（避免清空水位线）');
    } else if (!trigger) {
      try {
        await writeTriggerAtomicMain(nextTrigger);
      } catch (e) {
        jsLog('DEBUG', 'onPromptFinalize: 写 trigger 失败: ' + (e.message || String(e)));
      }
      // 首次识别到角色卡立即分析一次（不等 20 分钟冷却），让角色页尽快有数据
      if (callerCardId) {
        autoAnalyzeChat(currentChatId, callerCardId, personaName).catch(function() {});
      }
    } else {
      var cooldownPassed = (now - (trigger.cooldownStart || now)) >= COOLDOWN_MS;
      var processChatId = trigger.chatId || currentChatId;
      var chatIdChanged = trigger.chatId && trigger.chatId !== currentChatId;
      // 角色卡变化也立即分析（切换角色后快速建立该角色的记忆）
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
    // 记忆注入（官方额外信息注入插件模式）——召回当前角色记忆附加到消息
    // persist=true 时注入内容已在 onPromptInput（before_process）阶段拼进消息文本，
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
// 延迟 10 秒：实测 Operit 重启早期（数秒内）调用 hiddenExec 有 executor 会话竞态风险，
// 可能创建坏会话导致后续永久卡；原 30s 为保守兜底，2026-08-09 冷启动实测 proot 0.6s/worker 2s，
// 10s 余量充足（暖启动 2s 就绪）；若实测不稳定再回退 30s
// P0-C1（2026-08-10）：application_on_create 改为 health-only。
// 目标：启动期 CME 不创建/不复用任何 terminal session、不部署、不 kill、不 hiddenExec。
// Worker 离线时只记录 offline，不自动拉起——刻意接受的安全降级（Phase 0 safe-off），
// 恢复启动由显式路径（Phase 1 或用户手动）承担。HTTP ping 是唯一 Worker ready 真值。
function onAppCreate() {
    try {
        cmeProbe('T0');
        // health-only：一次性短 HTTP health（独立短 deadline），在线写 ready，离线写 offline 后结束
        setTimeout(function () {
            (async function () {
                var t0 = Date.now();
                var ping = null;
                try {
                    ping = await withTimeout(httpCall('ping_worker', {}), 4000, 'ping timeout');
                } catch (e) {}
                var up = !!(ping && ping.success);
                try { setEnv('MEMORY_ENGINE_WORKER_READY', up ? '1' : '0'); } catch (e) {}
                try {
                    var st = { state: up ? 'ready' : 'offline', observedAt: new Date().toISOString(), source: 'application_on_create', ms: Date.now() - t0 };
                    Tools.Files.write(DATA_DIR + '/logs/worker_state.json', JSON.stringify(st), false, 'android');
                } catch (e) {}
                if (up) {
                    jsLog('INFO', 'onAppCreate: worker ready（' + (ping.version || '?') + ', ' + (Date.now() - t0) + 'ms）');
                } else {
                    jsLog('INFO', 'onAppCreate: worker offline（' + (Date.now() - t0) + 'ms），不自动拉起（Phase 0 safe-off）');
                }
            })().catch(function (e) {
                jsLog('ERROR', 'onAppCreate health 异常: ' + (e && e.message ? e.message : String(e)));
            });
        }, 2000);
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
    // 注入内容随消息保存（persist=true 时 before_process 文本拼接注入）
    ToolPkg.registerPromptInputHook({
        id: "memory_engine_prompt_input",
        function: onPromptInput
    });
    return true;
}

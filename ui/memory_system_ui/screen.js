"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;

const shared = require("./shared");
const { relationMap, parseResult, pad2, fmtErr } = shared;
const theme = require("./theme");
const overviewTab = require("./tabs/overview");
const todosTab = require("./tabs/todos");
const timelineTab = require("./tabs/timeline");
const knowledgeTab = require("./tabs/knowledge");
const contactsTab = require("./tabs/contacts");
const messagesTab = require("./tabs/messages"); // 预留：消息Tab
const characterTab = require("./tabs/character");
const deployTab = require("./tabs/deploy");

// ===== Tab 注册表 =====
const TAB_REGISTRY = [
  { id: 0, icon: 'dashboard',     label: '概览' },
  { id: 1, icon: 'checklist',     label: '待办' },
  { id: 2, icon: 'timeline',      label: '时间线' },
  { id: 3, icon: 'menu_book',     label: '知识' },
  { id: 4, icon: 'person',        label: '角色' },
  { id: 5, icon: 'settings',      label: '设置' },
  { id: 6, icon: 'build',         label: '部署' },
];

function Screen(ctx) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);

  // ===== 状态 =====
  var cachedData = { events: [], contacts: [], info: [], finance: [], todos: [], menstrual: [] };
  try {
    var _cached = ctx.getEnv('CACHED_ALL_DATA');
    if (_cached) cachedData = JSON.parse(_cached);
  } catch(e) {}

  // ===== 从 env 同步读取上次离开时的 UI 状态 =====
  // 这是"同步恢复"的关键：与 msg_watcher 的 CACHED_ALL_DATA 模式一致
  // 渲染上下文里 ctx.getEnv 是同步的，无需 await
  var uiBoot = {};
  try {
    var _uiRaw = ctx.getEnv('MEMORY_ENGINE_UI_STATE');
    if (_uiRaw) uiBoot = JSON.parse(_uiRaw) || {};
  } catch(e) { uiBoot = {}; }

  var tabState = ctx.useState('tab', (uiBoot.tab !== undefined ? uiBoot.tab : 0));
  // 首次启动默认打开部署页：无首次运行标记时，初始 tab 指向部署页(6)
  var firstRunRef = ctx.useRef('firstRun', false);
  try {
    if (!ctx.getEnv('MEMORY_ENGINE_FIRST_RUN')) {
      firstRunRef.current = true;
      if (uiBoot.tab === undefined) tabState[1](6);
      try { ctx.setEnv('MEMORY_ENGINE_FIRST_RUN', '1'); } catch(e) {}
    }
  } catch(e) {}
  var showSearchState = ctx.useState('showSearch', false);
  var dataState = ctx.useState('allData', cachedData);
  var dataLoadedState = ctx.useState('allDataLoaded', false);
  // P1-3：dataLoadedTs 用 setEnv 兜底持久化——跨模块实例恢复"已加载"状态（仅空时恢复一次，防渲染循环）
  if (!dataLoadedState[0]) {
    try { if (ctx.getEnv('MEMORY_ENGINE_DATA_LOADED')) dataLoadedState[1](true); } catch(e) {}
  }
  var analyzingState = ctx.useState('analyzing', false);
  var resultState = ctx.useState('resultText', '');
  var renderTickState = ctx.useState('renderTick', 0); // v2.3.1: 异步 setState 不触发渲染的强制刷新 tick
  var showCfgState = ctx.useState('showCfg', false);
  var queryState = ctx.useState('query', (uiBoot.query !== undefined ? uiBoot.query : ''));
  var dateStartState = ctx.useState('dateStart', (uiBoot.dateStart !== undefined ? uiBoot.dateStart : ''));
  var dateEndState = ctx.useState('dateEnd', (uiBoot.dateEnd !== undefined ? uiBoot.dateEnd : ''));
  var filterTypeState = ctx.useState('filterType', (uiBoot.filterType !== undefined ? uiBoot.filterType : ''));
  var showCalState = ctx.useState('showCal', false);
  var memoryState = ctx.useState('memories', []);
  // P1-3：记忆列表 setEnv 兜底持久化——跨模块实例恢复缓存（P1-4 缓存优先基础；仅空时恢复一次，防渲染循环）
  if (!memoryState[0] || memoryState[0].length === 0) {
    var _bootMems = [];
    try {
      var _cachedMems = ctx.getEnv('CACHED_MEMORIES');
      if (_cachedMems) _bootMems = JSON.parse(_cachedMems) || [];
    } catch(e) { _bootMems = []; }
    if (_bootMems.length > 0) memoryState[1](_bootMems);
  }
  var memoryLoadedState = ctx.useState('memoriesLoaded', false);
  var memoryQueryState = ctx.useState('memQuery', (uiBoot.memQuery !== undefined ? uiBoot.memQuery : ''));
  var injectionState = ctx.useState('injectionSettings', null);
  var injectionSavingState = ctx.useState('injectionSaving', false);
  var injectionLimitInputState = ctx.useState('injectionLimitInput', '');
  // 注入设置保存竞态保护：序号保证旧响应不覆盖新状态；时间戳防 loadData 异步覆盖
  var injectionSaveSeqRef = ctx.useRef('injectionSaveSeq', 0);
  var lastInjectionSaveRef = ctx.useRef('lastInjectionSave', 0);
  // 数据备份
  var backupBusyState = ctx.useState('backupBusy', false);
  var backupResultState = ctx.useState('backupResult', '');
  var backupModeState = ctx.useState('backupMode', 'merge');
  var screenPersonaState = ctx.useState('screenPersona', null);
  // P1-3：persona 用 setEnv 兜底持久化——跨模块实例恢复已确认角色（仅空时恢复一次，防渲染循环）
  if (!screenPersonaState[0]) {
    try {
      var _bootPid = ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_ID') || '';
      if (_bootPid) {
        var _bootPname = ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_NAME') || '未命名角色';
        screenPersonaState[1]({ id: _bootPid, name: _bootPname, type: 'character_card' });
      }
    } catch(e) {}
  }
  var screenCharMemoriesState = ctx.useState('screenCharMemories', []);
var uiSaveRef = ctx.useRef('uiSaveRef', '');
var _uiSaveTimer = null; // v2.3.1: save_ui_state 磁盘写防抖
  var memoryLoadingState = ctx.useState('memLoading', false);
  var pendingDeleteState = ctx.useState('pendingDelete', '');
  // 联系人 Tab：选中联系人同步恢复
  var selContactState = ctx.useState('selContact', (uiBoot.selContact !== undefined ? uiBoot.selContact : -1));
  // 消息Tab专用状态
  var chatsState = ctx.useState('msgs_chats', []);
  // 消息Tab：选中的对话同步恢复（注意 chatDetail 不持久化——它是网络请求结果，下次进入会重新加载）
  var selectedChatState = ctx.useState('msgs_selectedChat', (uiBoot.selectedChatId ? { chatId: uiBoot.selectedChatId } : null));
  var chatDetailState = ctx.useState('msgs_chatDetail', null);
  var loadingChatsState = ctx.useState('msgs_loadingChats', false);
  var loadingDetailState = ctx.useState('msgs_loadingDetail', false);
  var msgQueryState = ctx.useState('msgs_query', (uiBoot.msgQuery !== undefined ? uiBoot.msgQuery : ''));
  var hasMoreState = ctx.useState('msgs_hasMore', true);
  // 消息Tab：加载偏移同步恢复，避免回到列表头
var offsetState = ctx.useState('msgs_offset', (uiBoot.msgOffset !== undefined ? uiBoot.msgOffset : 0));
var analyzedChatsState = ctx.useState('msgs_analyzedChats', []);
var selectedMessagesState = ctx.useState('msgs_selectedMessages', []); // 多选的消息索引
// 后端真实对话总数（来自 list_chats_brief 的 data.totalCount），不会因为前端追加而变化
// 这个数字代表"你一共有多少对话"，不是"已拉取多少"——按用户原话："我需要看到实际拉取数量"
var totalChatsState = ctx.useState('msgs_totalChats', (uiBoot.totalChats !== undefined ? uiBoot.totalChats : 0));

  var cfgEndpoint = ctx.useState('cfgEndpoint', ctx.getEnv('MEMORY_SYSTEM_ENDPOINT') || '');
  var cfgKey = ctx.useState('cfgKey', ctx.getEnv('MEMORY_SYSTEM_KEY') || '');
  var cfgModel = ctx.useState('cfgModel', ctx.getEnv('MEMORY_SYSTEM_MODEL') || 'gpt-4o-mini');
  var endpoint = cfgEndpoint[0], setEndpoint = cfgEndpoint[1];
  var apiKey = cfgKey[0], setApiKey = cfgKey[1];
  var model = cfgModel[0], setModel = cfgModel[1];
var initRef = ctx.useRef('init', false);
  // v2.3.1: 统一结果文案——setState 后强制 tick 触发渲染（实测：异步 setState 不触发重渲染，需用户交互才显示）
  var _resultTickTimer = null;
  // v2.3.2b 最终态：异步渲染依赖根节点 onLoad 的 120s action 窗口（平台 action 分发订阅
  // stateChange → 中间渲染推送平台重绘，19:48 真机生效）；此处的 renderTick 仅作窗口关闭后兜底。
  function _operitRerender() {
    // v2.3.2b 最终态：异步渲染依赖根节点 onLoad 的 120s action 窗口（平台 action 分发订阅
    // stateChange → 中间渲染推送），此处的 renderTick 仅作窗口关闭后的兜底。
    try { renderTickState[1](Date.now()); } catch (e) {}
  }
  function setResultText(t) {
    resultState[1](t);
    try {
      if (_resultTickTimer) clearTimeout(_resultTickTimer);
      _resultTickTimer = setTimeout(function() { _resultTickTimer = null; _operitRerender(); }, 0);
    } catch(e) {}
  }
  // v2.3.2b：异步数据更新后的强制渲染 tick（平台异步 setState 不触发重绘，需用户交互才显示；
  // 归并防抖：同一批次多次调用合并为一次，避免渲染风暴）
  var _forceTickTimer = null;
  function forceRenderTick(delayMs) {
    try {
      if (_forceTickTimer) clearTimeout(_forceTickTimer);
      _forceTickTimer = setTimeout(function() { _forceTickTimer = null; _operitRerender(); }, delayMs || 0);
    } catch(e) {}
  }
var triggerPollRef = ctx.useRef('triggerPoll', 0);
var dataLoadScheduledRef = ctx.useRef('dataLoadScheduled', false);
  var dataLoadFailCountRef = ctx.useRef('dataLoadFailCount', 0);
  var personaFailCountRef = ctx.useRef('personaFailCount', 0);
  var personaHitAtRef = ctx.useRef('personaHitAt', 0);
  var memoryFailCountRef = ctx.useRef('memoryFailCount', 0);
var personaCacheRef = ctx.useRef('personaCache', { id: '', name: '', type: '', ts: 0 });
var memoryLoadScheduledRef = ctx.useRef('memoryLoadScheduled', false);
var characterLoadScheduledRef = ctx.useRef('characterLoadScheduled', false);
// v2.3.3: 渲染闭包调度时间闸——角色页/知识页每次渲染都进调度分支(ref仅防同帧)，未命中缓存路径每次触发都 callTool→setState→再渲染→再触发(渲染风暴)；120s onLoad 窗口内风暴渲染全部推送平台主线程→过载 ANR 闪退(2026-08-09 实锤)
var characterLoadAtRef = ctx.useRef('characterLoadAt', 0);
var memoryLoadAtRef = ctx.useRef('memoryLoadAt', 0);
// ===== v2.3.1：全局串行调用队列（bridge 响应错配免疫，CMS 同款方案）=====
function serialCall(toolName, params) {
  var g = (typeof globalThis !== 'undefined' ? globalThis : window);
  g.__cmeSerialCtx = g.__cmeSerialCtx || { p: Promise.resolve() };
  var run = g.__cmeSerialCtx.p.then(function () {
    return ctx.callTool(toolName, params);
  });
  g.__cmeSerialCtx.p = run.catch(function () {});
  return run;
}
var dbgRenderCount = ((typeof globalThis !== 'undefined' ? globalThis : window).__dbgRC = ((typeof globalThis !== 'undefined' ? globalThis : window).__dbgRC || 0) + 1); // v2.1.2实验：模块级计数器——同实例/同WebView内递增，整页重载才归1
  if (!initRef.current) {
 initRef.current = true;
 dbgUi('mount', '实例创建 tab=' + (tabState[0] !== undefined ? tabState[0] : '?') + ' r=' + dbgRenderCount); // v2.1.2实验：组件实例创建标记（配合模块级计数器判断重建 vs 整页重载）
 dbgUi('init', '首次渲染，触发分析'); // v2.1.0：重置上次会话残留的分析中状态（useState 跨重启持久化可能导致按钮卡住）
 analyzingState[1](false);
  setResultText(''); // v2.3.1: 清持久化残留（重进不再显示上次分析结果）
  // ===== 自动触发分析：检测上次以来是否有新对话内容 =====
  // v2.3.2b：延迟 8s 触发——Operit 重启早期（proot 未就绪）立即调用 trigger_analysis
  // 会经 ensureWorkerUp 触发 hiddenExec 会话竞态（坏会话→后续拉起永久卡，19:15 实锤）；
  // 8s 让 proot 完成重建（实测 2s）+ 保守余量。onAppCreate 另有 30s 延迟兜底。
  setTimeout(function() {
  (async function() {
   try {
     var startTriggerPoll = function(countHint, hintText) {
       triggerPollRef.current += 1;
       var pollId = triggerPollRef.current;
       var startMs = Date.now();
       var maxMs = 90000;
       var lastSnapshot = '';
       (function pollOnce() {
         if (pollId !== triggerPollRef.current) return;
         if (Date.now() - startMs > maxMs) {
           if (hintText) analyzingState[1](false); setResultText('分析状态超时，请稍后手动刷新');
           return;
         }
         setTimeout(async function() {
           try {
             var envResult = '';
             try { var rRaw = await serialCall('memory_engine:get_trigger_result', {}); var rRes = parseResult(rRaw); if (rRes && rRes.success && rRes.result) envResult = rRes.result; } catch(e) {}
             if (envResult && envResult !== lastSnapshot) {
               lastSnapshot = envResult;
               try {
                 var parsed = JSON.parse(envResult);
                 if (parsed && parsed.finishedAt) {
                    analyzingState[1](false); // v2.3.1: 分析结束→按钮复位
                   if (parsed.success && parsed.hasData) {
                     setResultText('后台分析完成：发现 ' + (parsed.newMessageCount || countHint || 0) + ' 条新内容');
                     await loadData();
                   } else if (parsed.success && !parsed.hasData) {
                     setResultText('后台分析完成：未发现可提取内容');
                   } else {
                     setResultText('分析失败：' + (parsed.error || '未知错误'));
                   }
                   return;
                 }
               } catch(pe) {}
             }
             pollOnce();
           } catch(e) {
             pollOnce();
           }
         }, 3000);
       })();
     };
     var raw = await serialCall('memory_engine:trigger_analysis', {});
     var r = parseResult(raw);
     dbgUi('init', 'trigger_analysis 返回 started=' + (r && r.started) + ' skipped=' + (r && r.skipped) + ' success=' + (r && r.success));
     if (r && r.started) {
        // 异步分析已启动 → 显示"分析中"并轮询刷新数据
        var __estSec = Math.max(15, Math.min(120, Math.ceil((r.newMessageCount || 0) * 3)));
        setResultText('检测到 ' + (r.newMessageCount || 0) + ' 条新对话，正在后台分析（预计约 ' + __estSec + ' 秒），你可以先做其他事，分析完成后将自动刷新');
        analyzingState[1](true); // v2.3.1: 自动分析启动→按钮显示分析中
       triggerPollRef.current += 1;
       var pollId = triggerPollRef.current;
       var startMs = Date.now();
       var maxMs = 90000; // 最多轮询 90 秒
       var lastSnapshot = '';
       (function pollOnce() {
         if (pollId !== triggerPollRef.current) return; // 已被新触发取代
         if (Date.now() - startMs > maxMs) {
           analyzingState[1](false); setResultText('分析超时，请稍后手动刷新');
           return;
         }
         setTimeout(async function() {
           try {
             // 读 env 看分析是否结束
             var envResult = '';
             try { var rRaw = await serialCall('memory_engine:get_trigger_result', {}); var rRes = parseResult(rRaw); if (rRes && rRes.success && rRes.result) envResult = rRes.result; } catch(e) {}
             if (envResult && envResult !== lastSnapshot) {
               lastSnapshot = envResult;
               try {
                 var parsed = JSON.parse(envResult);
                 if (parsed && parsed.finishedAt) {
                    analyzingState[1](false); // v2.3.1: 分析结束→按钮复位
                   // 分析已结束
                   if (parsed.success && parsed.hasData) {
                     setResultText('后台分析完成：发现 ' + (parsed.newMessageCount || 0) + ' 条新内容');
                     await loadData();
                   } else if (parsed.success && !parsed.hasData) {
                     setResultText('后台分析完成：未发现可提取内容');
                   } else {
                     setResultText('分析失败：' + (parsed.error || '未知错误'));
                   }
                   return;
                 }
               } catch(pe) {}
             }
             pollOnce();
           } catch(e) {
             pollOnce();
           }
         }, 3000);
       })();
     } else if (r && r.skipped) {
       // 没有新内容：静默（也可选显示一句提示）
       analyzingState[1](false); setResultText('无新对话内容 (' + (r.lastAnalyzedAt ? '上次分析：' + new Date(r.lastAnalyzedAt).toLocaleString() : '首次检测') + ')');
     } else if (r && !r.success) {
       setResultText('检测失败：' + (fmtErr(r.message || r.error || '未知')));
     } else {
       // v2.3.1：响应异常（bridge 错配/形状未知）→ 保守启动兜底轮询，分析完成仍能刷新
       dbgUi('init', '响应异常（started/skipped 缺失），启动兜底轮询');
       setResultText('正在检测对话内容…');
       startTriggerPoll(0, '正在检测对话内容…');
    }
  } catch(e) {}
 })();
  }, 8000);
}

  // 首次状态为空时读取一次；后续由根节点 onLoad、分析完成或用户操作明确刷新。
  // 用 state（dataLoadedState）作唯一权威：只要数据未加载就重新调度，避免 useRef 在
  // 快速切换实例复用时残留 true 导致加载永久跳过。
  // v2.1.0：时间戳守卫——已加载 60 秒内不重载；跨重启残留旧时间戳自动过期，避免"以为加载过但数据为空"
  var dataLoadedTs = Number(dataLoadedState[0] || 0);
  // v2.1.5 P0-2b：失败自驱重试——不再依赖 render 驱动（Operit 相同值 setState 不触发重渲染，
  // 失败后若无用户操作会冻结在"正在读取"；失败时自排队下一次，成功或达上限才停止）
  function retryLoadData() {
    if (dataLoadScheduledRef.current) return;
    var _f = Number(dataLoadFailCountRef.current || 0);
    if (_f >= 5) return; // 连续 5 次失败停止自动重试
    dataLoadScheduledRef.current = true;
    var _rd = _f === 0 ? 0 : Math.min(300 * Math.pow(2, _f - 1), 3000);
    dbgUi('sched', 'loadData 调度（dataLoadedTs=' + dataLoadedState[0] + ' failCount=' + _f + '）');
    setTimeout(function() {
      loadData().then(function(ok) {
        dataLoadedState[1](ok ? Date.now() : 0); // 成功记时间戳；失败置 0
        if (ok) { dataLoadFailCountRef.current = 0; }
        else { dataLoadFailCountRef.current = (dataLoadFailCountRef.current || 0) + 1; }
      }).finally(function() {
        dataLoadScheduledRef.current = false;
        // 失败自驱：不等 render，主动排队下一次
        var _f2 = Number(dataLoadFailCountRef.current || 0);
        if (_f2 > 0 && _f2 < 5 && !Number(dataLoadedState[0] || 0)) {
          retryLoadData();
        }
      });
    }, _rd);
  }
  if (!dataLoadedTs || (Date.now() - dataLoadedTs) > 60000) {
    retryLoadData();
  }
  // ===== 初始化时加载记忆 =====
  var currentTab = tabState[0];
  var memoryLoadedTs = Number(memoryLoadedState[0] || 0);
  if ((currentTab === 3) && (!memoryLoadedTs || (Date.now() - memoryLoadedTs) > 60000) && !memoryLoadingState[0] && !memoryLoadScheduledRef.current && (Date.now() - (memoryLoadAtRef.current || 0)) > 5000) {
    memoryLoadScheduledRef.current = true;
    memoryLoadAtRef.current = Date.now();
    setTimeout(function() {
      loadKnowledgeMemories().finally(function() { memoryLoadScheduledRef.current = false; });
    }, 0);
  }

  // ===== render 探针：记录本次渲染看到的数据快照 =====
  try {
    dbgUi('render', 'dataState=' + (dataState[0] ? (dataState[0].events.length + 'e/' + dataState[0].todos.length + 't/' + dataState[0].contacts.length + 'c/' + dataState[0].info.length + 'i/' + dataState[0].finance.length + 'f/' + dataState[0].menstrual.length + 'm') : 'null') +
      ' | memoryState=' + (memoryState[0] ? memoryState[0].length : 'null') +
      ' | persona=' + (screenPersonaState[0] ? screenPersonaState[0].id : 'null') +
      ' | dataLoadedTs=' + (dataLoadedState[0] || 0) +
      ' | tab=' + currentTab);
  } catch (e) {}

  // ===== 角色页：进入时自动加载角色上下文与记忆（与知识页同款 setTimeout 模式）=====
  // 每次进入角色 tab 都重新加载，不因之前加载过而跳过；ref 仅防同帧重复。
  if (currentTab === 4 && !characterLoadScheduledRef.current && (Date.now() - (characterLoadAtRef.current || 0)) > 5000) {
    characterLoadScheduledRef.current = true;
    characterLoadAtRef.current = Date.now();
    setTimeout(function() {
      loadScreenPersona().finally(function() { characterLoadScheduledRef.current = false; });
    }, 0);
  }

  // ===== 初始化时加载已分析对话列表（用于消息Tab标记）=====
  var analyzedChatsInitRef = ctx.useRef('analyzedChatsInit', false);
  if (currentTab === 99 && !analyzedChatsInitRef.current) {
    analyzedChatsInitRef.current = true;
    (async function() {
      try {
        var raw = await serialCall('memory_engine:get_analyzed_chats', {});
        var r = parseResult(raw);
        if (r && r.success && r.chats) {
          analyzedChatsState[1](r.chats);
        }
      } catch(e) {}
    })();
  }

  // ===== 消息Tab：每次进入都强制刷新一次对话列表 =====
// 用户的诉求："点击侧边栏进入就算一次刷新"——不依赖 state 缓存，
// 每次从侧边栏进入消息 Tab 时都主动触发 list_chats_brief 重新拉取。
// 实现要点：
//  1. 用 useRef 防止同一次进入内重复触发；
//  2. 同时用 env 同步检查时间戳：如果距上次刷新超过 3 秒，认为是"新一次进入"，
//     重置 ref 并强制刷新——这样无论 OP 的 useRef 是持久化还是被销毁，都能保证刷新。
var lastMsgsLoadAt = 0;
try {
var _lm = ctx.getEnv('MEMORY_SYSTEM_LAST_MSGS_LOAD');
if (_lm) lastMsgsLoadAt = parseInt(_lm, 10) || 0;
} catch(__e) {}
var nowMs = Date.now();
var isFreshEnter = (lastMsgsLoadAt === 0) || ((nowMs - lastMsgsLoadAt) > 3000);
var msgsChatsEnterRef = ctx.useRef('msgsChatsEnter', false);
// 如果 env 判断是新进入，重置 ref
if (isFreshEnter) msgsChatsEnterRef.current = false;
if (currentTab === 99 && !msgsChatsEnterRef.current) {
msgsChatsEnterRef.current = true;
// 标记本次刷新时间，避免 3 秒内重复触发
try { ctx.setEnv('MEMORY_SYSTEM_LAST_MSGS_LOAD', String(Date.now())); } catch(__e2) {}
// 重置"已加载"标记，让 messages.js 内部也能正常兜底加载
try { ctx.setEnv('MEMORY_SYSTEM_MSGS_ENTER_LOADED', '0'); } catch(__eRst) {}
// 始终先清空旧列表 + 显示加载状态，避免误导用户
chatsState[1]([]);
selectedChatState[1](null);
chatDetailState[1](null);
loadingChatsState[1](true);
hasMoreState[1](true);
offsetState[1](0);
(async function() {
try {
// 注意：listChat 不支持 offset，所以一次性拉大数（200），
// 真实对话数通过 totalCount 显示给用户，不再分页。
var raw = await serialCall('chat_exporter:list_chats_brief', {
limit: 200,
sort_order: 'desc'
});
var r = parseResult(raw);
if (r && r.success && r.data && r.data.chats) {
chatsState[1](r.data.chats);
hasMoreState[1](r.data.chats.length >= 200);
offsetState[1](r.data.chats.length);
// 记录后端真实总数（用于顶部"实际拉取数量"显示）
if (r.data.totalCount !== undefined) totalChatsState[1](r.data.totalCount);
// 标记"已加载"，防止 messages.js 内部再次触发重复请求
try { ctx.setEnv('MEMORY_SYSTEM_MSGS_ENTER_LOADED', '1'); } catch(__eSetFlag) {}
} else {
hasMoreState[1](false);
}
} catch(e) {
hasMoreState[1](false);
}
loadingChatsState[1](false);
})();
}

  // ===== 动作函数 =====
  // ===== 诊断探针：区分空加载类型（A=数据没返回 / B=返回但UI没更新 / C=初始化没执行）=====
  var _dbgTs = 0;
  var _dbgLastTool = 0;
  var _dbgLastEnv = 0;
  // 写 dbg_ui.log（经 log_ui 工具，不经 worker）+ env 环形缓冲兜底
  // v2.2.4（CMS v1.8.4 迁移）：工具调用与 env 缓冲均限频 500ms——
  // 渲染风暴时从"每次渲染 1 次工具调用 + 1 次 setEnv"降到 ≤2 次/秒，
  // 消除渲染闭包内 I/O 对 Operit 全量重绘的放大作用；关键事件日志能力保留。
  function _localMd(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function dbgUi(tag, info) {
    try {
      var now = Date.now();
      var dt = _dbgTs ? (now - _dbgTs) : 0;
      _dbgTs = now;
      var line = _localMd(now) +
        ' [' + tag + '] +' + dt + 'ms ' + (info || '') + ' r=' + dbgRenderCount + '\n';
      if (now - _dbgLastTool >= 500) {
        _dbgLastTool = now;
        try { serialCall('memory_engine:log_ui', { line: line }).catch(function() {}); } catch (e) {}
      }
      if (now - _dbgLastEnv >= 500) {
        _dbgLastEnv = now;
        var old = '';
        try { old = ctx.getEnv('DBG_UI_CACHE') || ''; } catch (e2) {}
        var buf = old + line;
        var lines = buf.split('\n');
        if (lines.length > 40) lines = lines.slice(lines.length - 40);
        try { ctx.setEnv('DBG_UI_CACHE', lines.join('\n')); } catch (e3) {}
      }
    } catch (e) {}
  }
  // state 写入探针：确认 setState 是否真的执行、值是什么
  function dbgState(name, newVal, oldVal) {
    try {
      var nv = typeof newVal === 'object' && newVal ? (newVal.length !== undefined ? name + '.length=' + newVal.length : name + '=' + JSON.stringify(newVal).slice(0, 60)) : name + '=' + String(newVal).slice(0, 60);
      var ov = typeof oldVal === 'object' && oldVal ? (oldVal.length !== undefined ? name + '.length=' + oldVal.length : name + '=' + JSON.stringify(oldVal).slice(0, 60)) : name + '=' + String(oldVal).slice(0, 60);
      dbgUi('state', 'set ' + nv + ' | old ' + ov);
    } catch (e) {}
  }
  // requestId：每次加载请求分配递增 id，返回时带 id，定位覆盖关系
  var reqIdCounter = { data: 0, persona: 0, mem: 0 };
  function nextReqId(kind) { reqIdCounter[kind] = (reqIdCounter[kind] || 0) + 1; return reqIdCounter[kind]; }

  // v2.2.3：loadData 防抖——高频操作（连续删除/勾选/切换）300ms 内合并为一次全量拉取，
  // 避免每次操作都触发全量请求 + Operit 全量重绘（UI 卡顿根源：1 分钟 45+ 次渲染）
  var _loadDataTimer = null;
  var _loadDataPending = null;
  async function loadData() {
    if (_loadDataTimer) return _loadDataPending;
    _loadDataPending = new Promise(function(__resolve) {
      _loadDataTimer = setTimeout(function() {
        _loadDataTimer = null;
        _loadDataPending = null;
        _loadDataImpl().then(__resolve);
      }, 300);
    });
    return _loadDataPending;
  }
  async function _loadDataImpl() {
    var rid = nextReqId('data');
    dbgUi('loadData', 'req#' + rid + ' 触发');
    try {
      var raw = await serialCall('memory_engine:load_life_data', {});
      var r = parseResult(raw);
      dbgUi('loadData', 'req#' + rid + ' 返回 success=' + (r && r.success) + ' extracted=' + (r && r.extracted ? (r.extracted.events.length + 'e/' + r.extracted.todos.length + 't/' + r.extracted.contacts.length + 'c/' + r.extracted.info.length + 'i') : '无'));
      if (r && r.success) {
            // v2.1.3 P0-1：空壳响应守卫（实验实锤：新模块早期工具调用约 2/3 概率返回 success=true 但 extracted 为空）
            // 空壳 + 已有数据 → 保留旧数据，绝不覆盖（白屏直接元凶）
            var _ext = r.extracted;
            var _isEmpty = !_ext || (
              !(_ext.events && _ext.events.length) &&
              !(_ext.todos && _ext.todos.length) &&
              !(_ext.contacts && _ext.contacts.length) &&
              !(_ext.info && _ext.info.length) &&
              !(_ext.finance && _ext.finance.length) &&
              !(_ext.menstrual && _ext.menstrual.length)
            );
            var _oldD = dataState[0];
            var _oldHas = !!(_oldD && (
              ((_oldD.events && _oldD.events.length) || 0) +
              ((_oldD.todos && _oldD.todos.length) || 0) +
              ((_oldD.contacts && _oldD.contacts.length) || 0) +
              ((_oldD.info && _oldD.info.length) || 0) +
              ((_oldD.finance && _oldD.finance.length) || 0) +
              ((_oldD.menstrual && _oldD.menstrual.length) || 0)
            ) > 0);
            if (_isEmpty && _oldHas) {
              dbgUi('loadData', 'req#' + rid + ' 空壳响应：保留已有数据（不清空）');
              return false;
            }
            var newData = {
                events: r.extracted && r.extracted.events || [],
                contacts: r.extracted && r.extracted.contacts || [],
                info: r.extracted && r.extracted.info || [],
                finance: r.extracted && r.extracted.finance || [],
                todos: r.extracted && r.extracted.todos || [],
                menstrual: r.extracted && r.extracted.menstrual || []
            };
            // P1-5：requestId 防旧覆盖——非最新请求直接丢弃（防御旧响应覆盖新数据）
            if (rid !== reqIdCounter.data) {
              dbgUi('loadData', 'req#' + rid + ' 过期丢弃（当前#' + reqIdCounter.data + '）');
              return false;
            }
            dbgState('dataState', newData, dataState[0]);
            dataState[1](newData);
            forceRenderTick(0); // v2.3.2b: 异步更新数据后强制渲染（否则需切 tab 才显示分析结果）
            if (r.injection) {
              // 竞态保护：用户刚保存过（3秒内），跳过 loadData 的旧值覆盖
              if (Date.now() - (lastInjectionSaveRef.current || 0) > 3000) {
                injectionState[1](r.injection);
                if (r.injection.maxMemories) injectionLimitInputState[1](String(r.injection.maxMemories));
              }
            }
            if (r.uiState && r.uiState.data) {
                var saved = r.uiState.data;
                if (saved.tab !== undefined) tabState[1](saved.tab);
                if (saved.query !== undefined) queryState[1](saved.query);
                if (saved.filterType !== undefined) filterTypeState[1](saved.filterType);
                if (saved.dateStart !== undefined) dateStartState[1](saved.dateStart);
                if (saved.dateEnd !== undefined) dateEndState[1](saved.dateEnd);
            }
        try {
          ctx.setEnv('CACHED_ALL_DATA', JSON.stringify({
            events: r.extracted && r.extracted.events || [],
            contacts: r.extracted && r.extracted.contacts || [],
            info: r.extracted && r.extracted.info || [],
            finance: r.extracted && r.extracted.finance || [],
            todos: r.extracted && r.extracted.todos || [],
            menstrual: r.extracted && r.extracted.menstrual || []
          }));
          // P1-3：成功标记持久化（跨模块实例恢复"已加载"）
          ctx.setEnv('MEMORY_ENGINE_DATA_LOADED', '1');
        } catch(ex) {}
        return true;
      }
    } catch (e) {}
    return false;
  }

  async function loadScreenPersona() {
    var rid = nextReqId('persona');
    dbgUi('loadPersona', 'req#' + rid + ' 触发');
    // v2.1.0：60 秒内复用已确认角色，避免每次进入页面重复 list_characters（框架调度层开销大）
    var pC = personaCacheRef.current || {};
    if (pC.id && (Date.now() - (pC.ts || 0)) < 60000) {
      // v2.2.4: 缓存命中路径 5 秒节流，连切角色页避免反复 setEnv/setState 开销
      var _hitNow = Date.now();
      if (personaHitAtRef.current && (_hitNow - personaHitAtRef.current) < 5000) return;
      personaHitAtRef.current = _hitNow;
      dbgUi('loadPersona', 'req#' + rid + ' 缓存命中 id=' + pC.id);
      personaFailCountRef.current = 0;
      ctx.setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_ID', String(pC.id || ''));
      ctx.setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_NAME', String(pC.name || ''));
      var curC = screenPersonaState[0];
      var npC = { id: String(pC.id || ''), name: String(pC.name || ''), type: String(pC.type || 'character_card') };
      // P1-5：requestId 防旧覆盖（缓存命中路径同样校验）
      if (rid !== reqIdCounter.persona) {
        dbgUi('loadPersona', 'req#' + rid + ' 过期丢弃（当前#' + reqIdCounter.persona + '）');
        return;
      }
      if (!curC || curC.id !== npC.id || curC.name !== npC.name || curC.type !== npC.type) {
        dbgState('screenPersonaState', npC, curC);
        screenPersonaState[1](npC);
      }
      return;
    }
    try {
      var pRaw = await serialCall('memory_engine:list_characters', {});
      var pResult = parseResult(pRaw);
      var chars = pResult && pResult.success && pResult.characters ? pResult.characters : [];
      dbgUi('loadPersona', 'req#' + rid + ' 返回 success=' + (pResult && pResult.success) + ' chars=' + chars.length);
      // v2.1.3 P0-1：空壳响应守卫——chars=0 且已有非空 persona 时保留旧值（"未识别角色卡"直接元凶）
      if (!chars || chars.length === 0) {
        var _curSP0 = screenPersonaState[0];
        if (_curSP0 && _curSP0.id) {
          dbgUi('loadPersona', 'req#' + rid + ' chars=0 空壳：保留已有 persona id=' + _curSP0.id);
          return;
        }
        // v2.1.5：无旧值场景——置空后自驱重试（不依赖 render，否则停在"正在读取"需手动重载/切 tab 才恢复）
        personaFailCountRef.current = (personaFailCountRef.current || 0) + 1;
        if (personaFailCountRef.current <= 5) {
          dbgUi('loadPersona', 'req#' + rid + ' chars=0 无旧值：自驱重试 ' + personaFailCountRef.current + '/5');
          setTimeout(function() { loadScreenPersona(); }, Math.min(300 * Math.pow(2, personaFailCountRef.current - 1), 3000));
        }
      }
      var p = chars.length > 0
        ? { id: String(chars[0].id || ''), name: String(chars[0].name || ''), type: 'character_card' }
        : { id: '', name: '', type: '' };
      ctx.setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_ID', String(p.id || ''));
      ctx.setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_NAME', String(p.name || ''));
      // P1-5：requestId 防旧覆盖（正常路径同样校验）
      if (rid !== reqIdCounter.persona) {
        dbgUi('loadPersona', 'req#' + rid + ' 过期丢弃（当前#' + reqIdCounter.persona + '）');
        return;
      }
      // v2.1.0：相同角色不重复 setState（防渲染死循环）
      var curSP = screenPersonaState[0];
      var np = { id: String(p.id || ''), name: String(p.name || ''), type: String(p.type || '') };
      if (!curSP || curSP.id !== np.id || curSP.name !== np.name || curSP.type !== np.type) {
        dbgState('screenPersonaState', np, curSP);
        screenPersonaState[1](np);
      }
      // v2.1.0：不再主动查询角色记忆——避免每次切回都覆盖用户的分类选择；
      // 角色页列表由 character 组件内部按当前分类自行加载
      personaFailCountRef.current = 0;
      personaCacheRef.current = { id: String(p.id || ''), name: String(p.name || ''), type: String(p.type || ''), ts: Date.now() };
    } catch (e) {}
  }

  var _loadMemTimer = null;
  var _loadMemPending = null;
  // v2.3.1：loadMem 300ms 防抖——连续删除记忆时合并为一次全量刷新（同 loadData 模式）
  async function loadKnowledgeMemories() {
    if (_loadMemTimer) return _loadMemPending;
    _loadMemPending = new Promise(function(__resolve) {
      _loadMemTimer = setTimeout(function() {
        _loadMemTimer = null;
        _loadMemPending = null;
        _loadKnowledgeMemoriesImpl().then(__resolve);
      }, 300);
    });
    return _loadMemPending;
  }
  async function _loadKnowledgeMemoriesImpl() {
    var rid = nextReqId('mem');
    dbgUi('loadMem', 'req#' + rid + ' 触发');
    memoryLoadingState[1](true);
    try {
      var personaRaw = await serialCall('memory_engine:list_characters', {});
      var personaResult = parseResult(personaRaw);
      var personaId = personaResult && personaResult.success && personaResult.characters && personaResult.characters.length > 0
        ? String(personaResult.characters[0].id || '') : '';
      var raw = await serialCall('memory_engine:list_memories', {
        limit: 100,
        character_id: personaId || undefined
      });
      var result = parseResult(raw);
      dbgUi('loadMem', 'req#' + rid + ' 返回 success=' + (result && result.success) + ' memories=' + (result && result.memories ? result.memories.length : '无'));
      if (result && result.success) {
        // v2.1.3 P0-1：空壳响应守卫——返回空数组且已有记忆时保留旧缓存（不覆盖）
        var _mems = result.memories || [];
        var _oldM = memoryState[0];
        if (_mems.length === 0 && _oldM && _oldM.length > 0) {
          dbgUi('loadMem', 'req#' + rid + ' 空壳响应：保留已有记忆 ' + _oldM.length + ' 条');
        } else {
          // P1-5：requestId 防旧覆盖——非最新请求直接丢弃
          if (rid !== reqIdCounter.mem) {
            dbgUi('loadMem', 'req#' + rid + ' 过期丢弃（当前#' + reqIdCounter.mem + '）');
            memoryLoadingState[1](false);
            return;
          }
          dbgState('memoryState', _mems, _oldM);
          memoryState[1](_mems);
          // P1-3：记忆列表 setEnv 兜底持久化（P1-4 缓存优先基础）
          try { ctx.setEnv('CACHED_MEMORIES', JSON.stringify(_mems)); } catch(ex) {}
        }
      }
      else setResultText('记忆读取失败：' + (fmtErr((result && result.message) || '未知错误')));
    } catch(e) {
      dbgUi('loadMem', 'req#' + rid + ' 异常 ' + (fmtErr(e.message || String(e))));
      setResultText('记忆读取失败：' + (fmtErr(e.message || String(e))));
    }
    // v2.1.4 P0-2：成功才写时间戳（空壳且无缓存时置 0，与 data 同款自动重试闭环）
    var _memsOk = result && result.success && (result.memories || []).length > 0;
    var _cacheOk = memoryState[0] && memoryState[0].length > 0;
    memoryLoadedState[1]((_memsOk || _cacheOk) ? Date.now() : 0);
    memoryLoadingState[1](false);
    // v2.1.5：空壳且无缓存时自驱重试（不依赖 render，避免冻结在"正在读取"）
    if (!_memsOk && !_cacheOk) {
      memoryFailCountRef.current = (memoryFailCountRef.current || 0) + 1;
      if (memoryFailCountRef.current <= 5) {
        dbgUi('loadMem', 'req#' + rid + ' 空壳无缓存：自驱重试 ' + memoryFailCountRef.current + '/5');
        setTimeout(function() { loadKnowledgeMemories(); }, Math.min(300 * Math.pow(2, memoryFailCountRef.current - 1), 3000));
      }
    } else {
      memoryFailCountRef.current = 0;
    }
  }
  async function saveConfig() {
    await ctx.setEnv('MEMORY_SYSTEM_ENDPOINT', endpoint);
    await ctx.setEnv('MEMORY_SYSTEM_KEY', apiKey);
    await ctx.setEnv('MEMORY_SYSTEM_MODEL', model);
    setResultText('✅ 配置已保存');
  }

  async function saveInjectionSettings(patch) {
    var seq = (injectionSaveSeqRef.current = (injectionSaveSeqRef.current || 0) + 1);
    var current = injectionState[0] || { enabled: false, persist: true, maxMemories: 5, allowRepeatedMemorySearch: false };
    var next = {
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      persist: patch.persist !== undefined ? patch.persist : current.persist,
      maxMemories: current.maxMemories,
      allowRepeatedMemorySearch: patch.allowRepeatedMemorySearch !== undefined ? patch.allowRepeatedMemorySearch : current.allowRepeatedMemorySearch
    };
    dbgUi('saveInjection', 'patch=' + JSON.stringify(patch) + ' next=' + JSON.stringify(next));
    injectionState[1](next);
    try {
      // 参数名与工具声明完全一致（下划线），避免 callTool 对驼峰键的过滤/重命名干扰
      var toolPayload = {
        enabled: next.enabled,
        persist: next.persist,
        max_memories: next.maxMemories,
        allow_repeated_memory_search: next.allowRepeatedMemorySearch
      };
      dbgUi('saveInjection', 'callTool payload=' + JSON.stringify(toolPayload));
      var raw = await serialCall('memory_engine:set_injection_settings', toolPayload);
      var r = parseResult(raw);
      if (seq !== injectionSaveSeqRef.current) return; // 已有更新的保存请求，旧响应不覆盖
      if (r && r.success && r.injection) {
        injectionState[1](r.injection);
        lastInjectionSaveRef.current = Date.now();
        setResultText('✅ 记忆注入设置已保存');
      } else {
        injectionState[1](current);
        setResultText('❌ ' + (fmtErr((r && r.message) || '注入设置保存失败')));
      }
    } catch (e) {
      if (seq !== injectionSaveSeqRef.current) return;
      injectionState[1](current);
      setResultText('❌ ' + (fmtErr(e.message || String(e))));
    }
  }

  var injectionLimitTimerRef = ctx.useRef('injectionLimitTimer', null);

  function onInjectionLimitChange(value) {
    // 只接受纯数字，限制 2 位，避免中间态
    var digits = String(value || '').replace(/\D/g, '').slice(0, 2);
    injectionLimitInputState[1](digits);
    if (injectionLimitTimerRef.current) {
      try { clearTimeout(injectionLimitTimerRef.current); } catch (e) {}
    }
    injectionLimitTimerRef.current = setTimeout(function() {
      injectionLimitTimerRef.current = null;
      saveInjectionLimitWith(digits);
    }, 600);
  }

  async function saveInjectionLimitWith(rawValue) {
    var limit = parseInt(rawValue, 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 20) {
      setResultText('❌ 注入记忆条数必须是 1-20 的整数');
      return;
    }
    injectionSavingState[1](true);
    try {
      var raw = await serialCall('memory_engine:set_injection_settings', { max_memories: limit });
      var r = parseResult(raw);
      if (r && r.success && r.injection) {
        injectionState[1](r.injection);
        injectionLimitInputState[1](String(r.injection.maxMemories));
        setResultText('✅ 注入记忆条数已保存');
      } else {
        setResultText('❌ ' + (fmtErr((r && r.message) || '注入记忆条数保存失败')));
      }
    } catch (e) {
      setResultText('❌ ' + (fmtErr(e.message || String(e))));
    }
    injectionSavingState[1](false);
  }

  // ===== 数据备份 =====
  async function doExportBackup() {
    if (backupBusyState[0]) return;
    backupBusyState[1](true);
    backupResultState[1]('🔄 正在导出备份...');
    try {
      var raw = await serialCall('memory_engine:backup_engine', { reason: 'manual' });
      var r = parseResult(raw);
      if (r && r.success) {
        backupResultState[1]('✅ 备份已导出：' + (r.fileName || '') + '\n路径：' + (r.path || ''));
      } else {
        backupResultState[1]('❌ ' + (fmtErr((r && r.message) || '导出失败')));
      }
    } catch (e) {
      backupResultState[1]('❌ ' + (fmtErr(e.message || String(e))));
    }
    backupBusyState[1](false);
  }

  async function doPickAndRestore() {
    if (backupBusyState[0]) return;
    if (typeof ctx.openFilePicker !== 'function') {
      backupResultState[1]('❌ 当前环境不支持文件选择');
      return;
    }
    backupBusyState[1](true);
    backupResultState[1]('🔄 选择备份文件...');
    try {
      var picked = await ctx.openFilePicker({ mimeTypes: ['application/zip', 'application/octet-stream'] });
      if (picked && picked.cancelled) {
        backupResultState[1]('已取消选择');
        backupBusyState[1](false);
        return;
      }
      var file = picked && picked.files && picked.files[0];
      if (!file) {
        backupResultState[1]('❌ 未选择文件');
        backupBusyState[1](false);
        return;
      }
      var filePath = file.path || file.uri || '';
      backupResultState[1]('🔄 正在校验备份...');
      var isNewFormat = false;
      var inspMsg = '';
      try {
        var inspRaw = await serialCall('memory_engine:inspect_engine', { path: filePath });
        var insp = parseResult(inspRaw);
        if (insp && insp.success && insp.valid === true) {
          isNewFormat = true;
        } else if (insp && insp.message) {
          inspMsg = insp.message;
        }
      } catch (e) {
        // Operit 对失败工具调用抛异常（message 取工具返回），视为非新格式
        inspMsg = (e && e.message) ? e.message : String(e);
      }
      if (isNewFormat) {
        // 新格式（engine.db + manifest v1）：直接恢复
        backupResultState[1]('🔄 备份有效，正在恢复（' + (backupModeState[0] === 'overwrite' ? '覆盖' : '合并') + '模式）...');
        var resRaw = await serialCall('memory_engine:restore_engine', { path: filePath, mode: backupModeState[0] });
        var res = parseResult(resRaw);
        if (res && res.success) {
          backupResultState[1]('✅ 恢复完成（' + (res.mode || 'merge') + ' 模式' + (res.fileCount !== undefined ? '，' + res.fileCount + ' 个文件' : '') + '）');
          await loadData();
        } else {
          backupResultState[1]('❌ ' + (fmtErr((res && res.message) || '恢复失败')));
        }
      } else {
        // 新格式校验失败：尝试旧版本（v1.5.x）数据导入（data/<cat>.json 结构）
        backupResultState[1]('🔄 新格式校验未通过（' + (inspMsg || '格式不符') + '），尝试按旧版本数据导入...');
        try {
          var impRaw = await serialCall('memory_engine:import_legacy_backup', { path: filePath });
          var imp = parseResult(impRaw);
          if (imp && imp.success) {
            var st = imp.stats || imp.imported || {};
            backupResultState[1]('✅ 旧版本数据导入完成：' + (st.items || 0) + ' 条' + ((st.deduped || 0) ? '（去重 ' + st.deduped + '）' : '') + ((st.characters || 0) ? '，角色 ' + st.characters + ' 个' : '') + ((st.errors || 0) ? '，错误 ' + st.errors : ''));
            await loadData();
          } else {
            backupResultState[1]('❌ 旧版本导入失败：' + ((imp && imp.message) || '格式不支持'));
          }
        } catch (e2) {
          backupResultState[1]('❌ 旧版本导入失败：' + ((e2 && e2.message) ? e2.message : String(e2)));
        }
      }
    } catch (e) {
      backupResultState[1]('❌ ' + (fmtErr(e.message || String(e))));
    }
    backupBusyState[1](false);
  }

  async function doAnalyze() {
    analyzingState[1](true);
    setResultText('分析中（约30-80秒，可切换页面，分析会继续）');
    var analyzeTimer = setTimeout(function() {
      analyzingState[1](false);
      setResultText('分析仍在后台进行（约30-80秒），请稍后刷新角色页查看');
      try { if (typeof globalThis !== 'undefined') globalThis.__cmeAnalyzeStamp = Date.now(); } catch (e) {}
    }, 120000);
    try {
      // v2.1.0：先查 characters 表拿当前角色（worker 跨进程可靠通道）；
      // env 只做兜底（UI 的 ctx.getEnv 可能读不到 main.js setEnv 的跨进程值）
      var actId = '';
      var actName = '';
      try {
        var cRaw = await serialCall('memory_engine:list_characters', {});
        var cR = parseResult(cRaw);
        if (cR && cR.success && cR.characters && cR.characters.length > 0) {
          actId = String(cR.characters[0].id || '');
          actName = String(cR.characters[0].name || '');
        }
      } catch (e) {}
      if (!actId) {
        try { actId = String(ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_ID') || ''); } catch (e) {}
        try { actName = String(ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_NAME') || ''); } catch (e) {}
      }
      var raw = await serialCall('memory_engine:analyze_chat', {
        character_id: actId || undefined,
        persona_name: actName || ''
      });
      var r = parseResult(raw);
      if (r && r.success) {
        await loadData();
        var st = r.stats || {};
        setResultText('✅ 分析完成：提取 ' + (st.items || 0) + ' 条（合并 ' + (st.deduped || 0) + ' 条重复）');
      } else {
        setResultText(fmtErr((r && r.message) || '❌ 分析失败'));
      }
      // v2.1.0：分析结束（成功/失败）标记全局时间戳，角色页下次进入强制刷新最新数据
      try { if (typeof globalThis !== 'undefined') globalThis.__cmeAnalyzeStamp = Date.now(); } catch (e) {}
    } catch (e) {
      // v2.1.0：Operit 工具调用约 12 秒超时，但 worker 后台仍在分析（可达 80 秒）
      setResultText('分析请求超时，后台仍在进行（约30-80秒），请稍后刷新角色页查看');
      try { if (typeof globalThis !== 'undefined') globalThis.__cmeAnalyzeStamp = Date.now(); } catch (e) {}
    }
    clearTimeout(analyzeTimer);
    analyzingState[1](false);
  }
  async function deleteItem(category, idOrIndex) {
    try {
      // v2.3.0：前端统一传条目 id（精确删除）；失败（not found/out of range）也刷新列表消除过期行
      var raw = await serialCall('memory_engine:delete_life_item', { category: category, id: idOrIndex });
      var r = parseResult(raw);
      // v2.3.1：成功或失败都先本地移除该行——连点不再命中过期行；loadData 后台刷新兜底（300ms 防抖已覆盖）
      dropLifeItemFromData(category, idOrIndex);
      if (r && r.success) {
        await loadData();
        setResultText('✅ 已删除');
      } else {
        // 条目可能已不存在（重复点击/列表过期）：刷新消除幽灵行
        await loadData();
        setResultText('⚠️ ' + (r && r.message ? r.message : '删除失败'));
      }
    } catch(e) {
      setResultText('❌ ' + (fmtErr(e.message || String(e))));
    }
  }

  // v2.3.1：本地移除六类数据中的指定 id（成功/失败通用——失败说明行已过期，移除避免重复点击）
  function dropLifeItemFromData(category, idOrIndex) {
    var cur = dataState[0];
    if (!cur) return;
    var key = String(category || '');
    var list = cur[key];
    if (!Array.isArray(list)) return;
    var sid = String(idOrIndex);
    var next = list.filter(function(it) { return String(it && it.id) !== sid; });
    if (next.length !== list.length) {
      var nxt = {};
      for (var k in cur) { nxt[k] = cur[k]; }
      nxt[key] = next;
      dataState[1](nxt);
    }
  }
  async function deleteMemory(memoryId) {
    try {
      var raw = await serialCall('memory_engine:delete_memory', { id: memoryId });
      var r = parseResult(raw);
      // v2.3.1：成功或失败都先本地移除该条（按 id）——连点不再命中过期行；loadMem 防抖刷新兜底
      dropMemoryFromCache(memoryId);
      if (r && r.success) {
        await loadKnowledgeMemories();
        setResultText('✅ 已删除');
      } else if (r && r.message && /memory not found/i.test(r.message)) {
        setResultText('✅ 已删除');
      } else {
        setResultText('❌ ' + (fmtErr(r ? r.message : '未知错误')));
      }
    } catch(e) {
      var __em = String((e && e.message) || e);
      if (/memory not found/i.test(__em)) {
        dropMemoryFromCache(memoryId);
        setResultText('✅ 已删除');
      } else {
        setResultText('❌ ' + (fmtErr(__em)));
      }
    }
  }
  // v2.3.1：按 id 优先移除（title 兜底）——调用方传 id，原实现按 title 比较删不掉
  function dropMemoryFromCache(memoryId) {
    var cur = memoryState[0] || [];
    var sid = String(memoryId);
    var next = cur.filter(function(m) {
      if (m && m.id !== undefined && String(m.id) === sid) return false;
      if (m && m.title !== undefined && String(m.title) === sid) return false;
      return true;
    });
    if (next.length !== cur.length) {
      memoryState[1](next);
      try { ctx.setEnv('CACHED_MEMORIES', JSON.stringify(next)); } catch (e) {}
    }
  }

  // ===== 状态读取 =====
  var allData = dataState[0];
  var analyzing = analyzingState[0];
  var resultText = resultState[0];
  var showCfg = currentTab === 5;
  var q = queryState[0] || '';
  var dateStart = dateStartState[0] || '';
  var dateEnd = dateEndState[0] || '';
  var filterType = filterTypeState[0] || '';
  var showCal = showCalState[0];
  var calYearState = ctx.useState('calY', dateStart ? parseInt(dateStart.substring(0,4)) : new Date().getFullYear());
  var calMonthState = ctx.useState('calM', dateStart ? parseInt(dateStart.substring(5,7)) : new Date().getMonth() + 1);
  var calYear = calYearState[0];
  var calMonth = calMonthState[0];

  try {
// UI 状态快照：覆盖各 Tab 需要"恢复"的字段
//  - 公共：tab/query/filterType/dateStart/dateEnd/calYear/calMonth/memQuery
//  - 联系人 Tab：selContact（当前选中联系人）
//  - 消息 Tab：selectedChatId（当前展开的对话）、msgQuery（消息搜索词）、offset（已加载偏移）
// 注意：loading/analyzing/analyzedChats/chats/chatDetail/selectedMessages 故意不保存（运行时数据，下次进入会重新加载）
var __uiSnapshot = JSON.stringify({
tab: tabState[0],
query: queryState[0],
filterType: filterTypeState[0],
dateStart: dateStartState[0],
dateEnd: dateEndState[0],
memQuery: memoryQueryState[0],
calYear: calYear,
calMonth: calMonth,
selContact: selContactState[0],
selectedChatId: (selectedChatState[0] && selectedChatState[0].chatId) || '',
msgQuery: msgQueryState[0],
msgOffset: offsetState[0],
hasMore: hasMoreState[0],
totalChats: totalChatsState[0]
});
if (uiSaveRef.current !== __uiSnapshot) {
uiSaveRef.current = __uiSnapshot;
// 主路径：ctx.setEnv 同步写入；下次进入 getEnv 同步读取，无需异步等待
// 这是 msg_watcher 的 CACHED_ALL_DATA 同款模式
try { ctx.setEnv('MEMORY_ENGINE_UI_STATE', __uiSnapshot); } catch(__eSet) {}
// 兜底：异步触发工具保存到磁盘，保证重启后也能恢复（v2.3.1：防抖 500ms，渲染风暴时不放大 I/O）
if (!_uiSaveTimer) {
_uiSaveTimer = setTimeout(function() {
_uiSaveTimer = null;
try {
var __uiParams2 = JSON.stringify({ state_json: uiSaveRef.current || __uiSnapshot });
if (typeof NativeInterface !== 'undefined' && typeof NativeInterface.callTool === 'function') {
NativeInterface.callTool('memory_engine', 'save_ui_state', __uiParams2);
} else if (typeof Operit !== 'undefined' && Operit.NativeInterface && typeof Operit.NativeInterface.callTool === 'function') {
Operit.NativeInterface.callTool('memory_engine', 'save_ui_state', __uiParams2);
}
} catch(__eSave) {}
}, 500);
}
}
} catch (e) {}

  // ===== 日历点击处理 =====
  function handleCalClick(ds) {
    if (!dateStart || (dateStart && dateEnd)) {
      dateStartState[1](ds); dateEndState[1]('');
    } else {
      if (ds < dateStart) { dateEndState[1](dateStart); dateStartState[1](ds); }
      else { dateEndState[1](ds); }
      showCalState[1](false);
    }
  }

  // ===== 日历面板 =====
  var calPanel = [];
  if (showCal) {
    var fd = new Date(calYear, calMonth - 1, 1).getDay();
    var dim = new Date(calYear, calMonth, 0).getDate();
    var td = new Date();
    var todayStr = td.getFullYear() + '-' + pad2(td.getMonth()+1) + '-' + pad2(td.getDate());
    var cells = [];
    for (var b = 0; b < fd; b++) cells.push(null);
    for (var d = 1; d <= dim; d++) {
      var ds = calYear + '-' + pad2(calMonth) + '-' + pad2(d);
      cells.push({ day: d, dateStr: ds, isStart: ds === dateStart, isEnd: ds === dateEnd, isInRange: dateStart && dateEnd && ds > dateStart && ds < dateEnd, isToday: ds === todayStr });
    }
    var weekH = ['日','一','二','三','四','五','六'];
    var weekR = [];
    for (var w2 = 0; w2 < 7; w2++) weekR.push(UI.Column({ horizontalAlignment: 'center', weight: 1 }, [UI.Text({ text: weekH[w2], style: 'labelSmall', color: colors.outline, fontSize: 10, fontWeight: 'bold' })]));
    var dateRows = [UI.Row({ fillMaxWidth: true }, weekR)];
    var curRow = [];
    for (var ci2 = 0; ci2 < cells.length; ci2++) {
      (function(cell) {
        if (!cell) {
          curRow.push(UI.Column({ horizontalAlignment: 'center', weight: 1 }, [UI.Text({ text: '', style: 'labelSmall' })]));
        } else {
          var bg = cell.isStart || cell.isEnd ? colors.primary : cell.isInRange ? colors.primaryContainer : cell.isToday ? colors.errorContainer : 'transparent';
          var fg = cell.isStart || cell.isEnd ? colors.onPrimary : cell.isToday ? colors.error : colors.onSurface;
          curRow.push(UI.Column({ horizontalAlignment: 'center', weight: 1 }, [
            UI.Surface({ width: 28, height: 28, shape: { cornerRadius: 14 }, containerColor: bg, onClick: function() { handleCalClick(cell.dateStr); } }, [
              UI.Row({ fillMaxWidth: true, fillMaxHeight: true, horizontalArrangement: 'center', verticalAlignment: 'center' }, [
                UI.Text({ text: String(cell.day), style: 'labelSmall', color: fg, fontSize: 11 }),
              ]),
            ]),
          ]));
        }
        if (curRow.length === 7 || ci2 === cells.length - 1) {
          dateRows.push(UI.Row({ fillMaxWidth: true }, curRow));
          curRow = [];
        }
      })(cells[ci2]);
    }
    calPanel = [
      UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surface, border: { width: 1, color: colors.outlineVariant }, padding: 10 }, [
        UI.Column({ spacing: 4 }, [
          UI.Row({ fillMaxWidth: true, horizontalArrangement: 'spaceBetween', verticalAlignment: 'center' }, [
            UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.surfaceVariant, padding: { left: 6, right: 6, top: 2, bottom: 2 }, onClick: function() {
              var pm = calMonth - 1; var py = calYear;
              if (pm < 1) { pm = 12; py--; }
              calYearState[1](py); calMonthState[1](pm);
            } }, [UI.Icon({ name: 'chevron_left', tint: colors.onSurfaceVariant, size: 18 })]),
            UI.Text({ text: calYear + '年' + calMonth + '月', style: 'labelMedium', color: colors.onSurface, fontWeight: 'bold' }),
            UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.surfaceVariant, padding: { left: 6, right: 6, top: 2, bottom: 2 }, onClick: function() {
              var nm = calMonth + 1; var ny = calYear;
              if (nm > 12) { nm = 1; ny++; }
              calYearState[1](ny); calMonthState[1](nm);
            } }, [UI.Icon({ name: 'chevron_right', tint: colors.onSurfaceVariant, size: 18 })]),
          ]),
        ].concat(dateRows)),
      ]),
      UI.Spacer({ height: 4 }),
    ];
  }

  // ===== 顶部卡片 =====
  var pendingTodoCount = (allData.todos || []).filter(function(t) { return !t.completed; }).length;
  var headerCard = UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.primaryContainer, padding: 12 }, [
    UI.Column({ fillMaxWidth: true }, [
      UI.Row({ fillMaxWidth: true, horizontalArrangement: 'spaceBetween', verticalAlignment: 'center' }, [
        UI.Column({}, [
          UI.Text({ text: '📋 记忆引擎', style: 'labelMedium', color: colors.primary }),
          UI.Text({ text: (allData.todos || []).length + ' 待办 · ' + pendingTodoCount + ' 待完成 · ' + (allData.events || []).length + ' 事件', style: 'labelSmall', color: colors.onSurfaceVariant }),
        ]),
        UI.Row({ verticalAlignment: 'center' }, [
          UI.Surface({ shape: { cornerRadius: 12 }, containerColor: analyzing ? colors.errorContainer : colors.primary, padding: { left: 10, right: 10, top: 4, bottom: 4 }, onClick: function() { if (!analyzing) return doAnalyze(); else setResultText('正在分析中，请稍候（约30-60秒）'); } }, [
            UI.Text({ text: analyzing ? '⏳ 分析中' : '🤖 分析', style: 'labelSmall', color: analyzing ? colors.error : colors.onPrimary, fontWeight: 'bold' }),
          ]),
        ]),
      ]),
      resultText ? UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.primaryContainer, padding: { left: 8, right: 8, top: 4, bottom: 4 }, margin: { top: 8 } }, [
        UI.Text({ text: resultText, style: 'labelSmall', color: colors.primary, fontSize: 11 }),
      ]) : null,
    ].filter(Boolean)),
  ]);

  // ===== 配置面板 =====
  var cfgSection = [];
  if (showCfg) {
    cfgSection = [
      UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.errorContainer, padding: 12, border: { width: 1, color: colors.error } }, [
        UI.Column({ spacing: 8 }, [
          UI.Text({ text: '🔧 API 配置', style: 'labelMedium', fontWeight: 'bold', color: colors.error }),
          UI.TextField({ value: endpoint, onValueChange: setEndpoint, placeholder: 'Endpoint', singleLine: true }),
          UI.TextField({ value: apiKey, onValueChange: setApiKey, placeholder: 'API Key', singleLine: true }),
          UI.TextField({ value: model, onValueChange: setModel, placeholder: '模型名', singleLine: true }),
          UI.Button({ text: '保存配置', onClick: saveConfig, fillMaxWidth: true }),
        ]),
      ]),
      UI.Spacer({ height: 6 }),
    ];
  }

  // ===== 搜索栏（按需展开）=====
  var showSearch = showSearchState[0];
  var searchBar = UI.Surface({ shape: { cornerRadius: 10 }, containerColor: colors.surfaceVariant, padding: { left: 8, right: 8, top: 4, bottom: 4 }, fillMaxWidth: true }, [
    showSearch ? UI.Row({ verticalAlignment: 'center' }, [
      UI.Icon({ name: 'search', tint: colors.outline, size: 16 }),
      UI.Spacer({ width: 6 }),
      UI.TextField({ value: q, onValueChange: queryState[1], placeholder: '搜索...', weight: 1, singleLine: true }),
      (q || dateStart || dateEnd) ? UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.errorContainer, padding: { left: 6, right: 6, top: 2, bottom: 2 }, onClick: function() { queryState[1](''); dateStartState[1](''); dateEndState[1](''); } }, [
        UI.Text({ text: '清除', style: 'labelSmall', color: colors.error, fontSize: 10 }),
      ]) : null,
      UI.Spacer({ width: 4 }),
      UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.surfaceVariant, padding: { left: 6, right: 6, top: 2, bottom: 2 }, onClick: function() { showSearchState[1](false); } }, [
        UI.Icon({ name: 'close', tint: colors.outline, size: 16 }),
      ]),
    ].filter(Boolean)) : UI.Row({ verticalAlignment: 'center' }, [
      UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.primaryContainer, padding: { left: 12, right: 12, top: 5, bottom: 5 }, onClick: function() { showSearchState[1](true); } }, [
        UI.Row({ verticalAlignment: 'center' }, [
          UI.Icon({ name: 'search', tint: colors.primary, size: 16 }),
          UI.Spacer({ width: 6 }),
          UI.Text({ text: '搜索', style: 'labelSmall', color: colors.primary, fontWeight: 'bold' }),
        ]),
      ]),
    ]),
  ]);

  // ===== 工具栏 =====
  var toolRow = UI.Row({ fillMaxWidth: true, spacing: 4 }, [
    UI.Surface({ shape: { cornerRadius: 8 }, containerColor: (dateStart || dateEnd) ? colors.primaryContainer : colors.surfaceVariant, padding: { left: 8, right: 8, top: 3, bottom: 3 }, onClick: function() { showCalState[1](!showCal); } }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'calendar_month', tint: (dateStart || dateEnd) ? colors.primary : colors.outline, size: 14 }),
        UI.Spacer({ width: 4 }),
        UI.Text({ text: dateStart && dateEnd ? dateStart + ' ~ ' + dateEnd : dateStart ? dateStart + ' ~ ?' : '日期', style: 'labelSmall', color: (dateStart || dateEnd) ? colors.primary : colors.outline, fontSize: 10 }),
      ]),
    ]),
    UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.primary, padding: { left: 8, right: 8, top: 3, bottom: 3 }, onClick: function() { tabState[1](1); } }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'add', tint: colors.onPrimary, size: 14 }),
        UI.Spacer({ width: 4 }),
        UI.Text({ text: '新增', style: 'labelSmall', color: colors.onPrimary, fontSize: 10, fontWeight: 'bold' }),
      ]),
    ]),
  ]);

  // ===== 筛选 Chips =====
  var typeFilters = [];
  function makeFilterChip(label, value) {
    var isActive = filterType === value;
    // v1.8.5：FilterChip 白框改实色按钮（选中 primary 实底白字粗体，未选中 surfaceContainerHigh 浅底）
    typeFilters.push(UI.Surface({ shape: { cornerRadius: 8 }, containerColor: isActive ? colors.primary : colors.surfaceContainerHigh, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: function() { filterTypeState[1](isActive ? '' : value); } }, [
      UI.Text({ text: label, style: 'labelSmall', color: isActive ? colors.onPrimary : colors.onSurfaceVariant, fontWeight: 'bold' }),
    ]));
    // 与角色页分类按钮一致：显式 Spacer 分隔（Row spacing 参数不可靠）
    typeFilters.push(UI.Spacer({ width: 30 }));
  }

  if (currentTab === 2) {
    makeFilterChip('活动', 'activity');
    makeFilterChip('日程', 'schedule');
    makeFilterChip('支出', 'expense');
    makeFilterChip('收入', 'income');
    makeFilterChip('经期', 'menstrual');
    typeFilters.pop();
  }

  var filterRow = typeFilters.length > 0 ? [
    UI.Row({ fillMaxWidth: true, horizontalArrangement: 'center' }, typeFilters),
    UI.Spacer({ height: 4 }),
  ] : [];

  // ===== Tab 导航栏 =====
  var tabItems = [];
  for (var ti = 0; ti < TAB_REGISTRY.length; ti++) {
    (function(t) {
      var isSel = currentTab === t.id;
      tabItems.push(UI.Surface({ weight: 1, height: 58, shape: { cornerRadius: 12 }, containerColor: isSel ? colors.primaryContainer : 'transparent', onClick: async function() { tabState[1](t.id); filterTypeState[1](''); if (t.id === 3 || t.id === 4) { await new Promise(function(__res) { setTimeout(__res, 600); }); } } }, [
        UI.Column({ fillMaxWidth: true, fillMaxHeight: true, horizontalAlignment: 'center', verticalArrangement: 'center' }, [
          UI.Box({ fillMaxWidth: true, contentAlignment: 'center' }, [
            UI.Icon({ name: t.icon, tint: isSel ? colors.primary : colors.outline, size: 21 }),
          ]),
          UI.Spacer({ height: 2 }),
          UI.Box({ fillMaxWidth: true, contentAlignment: 'center' }, [
            UI.Text({ text: t.label, style: 'labelSmall', color: isSel ? colors.primary : colors.onSurfaceVariant, maxLines: 1 }),
          ]),
        ]),
      ]));
    })(TAB_REGISTRY[ti]);
  }

  // ===== 渲染当前Tab内容 =====
  var states = {
    query: q,
    dateStart: dateStart,
    dateEnd: dateEnd,
    filterType: filterType,
    pendingDelete: pendingDeleteState[0],
    selContact: selContactState[0],
    memQuery: memoryQueryState[0] || '',
    // 消息Tab状态
    chats: chatsState[0],
    selectedChat: selectedChatState[0],
    chatDetail: chatDetailState[0],
    loadingChats: loadingChatsState[0],
    loadingDetail: loadingDetailState[0],
    msgQuery: msgQueryState[0],
    hasMore: hasMoreState[0],
    offset: offsetState[0],
    analyzedChats: analyzedChatsState[0],
    selectedMessages: selectedMessagesState[0],
    totalChats: totalChatsState[0]
  };

  var actions = {
    loadData: loadData,
    setResult: resultState[1],
    setPendingDelete: pendingDeleteState[1],
    deleteItem: deleteItem,
    deleteMemory: deleteMemory,
    // 消息Tab actions
    setChats: chatsState[1],
    setSelectedChat: selectedChatState[1],
    setChatDetail: chatDetailState[1],
    setLoadingChats: loadingChatsState[1],
    setLoadingDetail: loadingDetailState[1],
    setMsgQuery: msgQueryState[1],
    setHasMore: hasMoreState[1],
    setOffset: offsetState[1],
    setAnalyzedChats: analyzedChatsState[1],
    setSelectedMessages: selectedMessagesState[1],
    setTotalChats: totalChatsState[1]
  };

  var tabContent;
  switch (currentTab) {
    case 0: tabContent = overviewTab.render(ctx, allData, { onOpenTodos: function() { tabState[1](1); } }); break;
    case 1: tabContent = todosTab.render(ctx, allData, states, actions); break;
    case 2: tabContent = timelineTab.render(ctx, allData, states, actions); break;
    case 3: tabContent = knowledgeTab.render(ctx, allData, states, actions, memoryState[0]); break;
    case 4: tabContent = characterTab.render(ctx, screenPersonaState[0], screenCharMemoriesState[0]); break;
    case 5: tabContent = [
      UI.Text({ text: '设置', style: 'titleMedium', color: colors.onSurface, fontWeight: 'bold' }),
      UI.Text({ text: '长期记忆由本插件记忆引擎提供（SQLite + 向量检索）；提取模型仅用于结构化分析。', style: 'bodySmall', color: colors.onSurfaceVariant }),
      UI.Spacer({ height: 4 }),
      UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceContainerHigh, padding: 12, border: { width: 1, color: colors.outlineVariant } }, [
        UI.Column({ spacing: 8 }, [
          UI.Text({ text: '🧠 记忆注入', style: 'labelMedium', fontWeight: 'bold', color: colors.primary }),
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Column({ weight: 1, spacing: 2 }, [
              UI.Text({ text: '记忆注入', style: 'bodySmall', color: colors.onSurface, fontWeight: 'bold' }),
              UI.Text({ text: '发送消息时附加相关记忆附件。', style: 'labelSmall', color: colors.onSurfaceVariant }),
            ]),
            UI.Switch({ checked: !!(injectionState[0] && injectionState[0].enabled), onCheckedChange: function(v) { saveInjectionSettings({ enabled: v }); } }),
          ]),
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Column({ weight: 1, spacing: 2 }, [
              UI.Text({ text: '注入内容随消息保存', style: 'bodySmall', color: colors.onSurface, fontWeight: 'bold' }),
              UI.Text({ text: '开启：附件随用户消息一起落盘；关闭：仅发送给模型，不写入聊天记录。', style: 'labelSmall', color: colors.onSurfaceVariant }),
            ]),
            UI.Switch({ checked: !!(injectionState[0] && injectionState[0].persist), onCheckedChange: function(v) { saveInjectionSettings({ persist: v }); } }),
          ]),
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Column({ weight: 1, spacing: 2 }, [
              UI.Text({ text: '允许重复检索', style: 'bodySmall', color: colors.onSurface, fontWeight: 'bold' }),
              UI.Text({ text: '开启：每次注入重新检索，已注入过的记忆可能再次出现；关闭：同一会话已注入过的记忆优先不重复（历史排空时自动复用最早的）。对齐官方 allowRepeatedMemorySearch。', style: 'labelSmall', color: colors.onSurfaceVariant }),
            ]),
            UI.Switch({ checked: !!(injectionState[0] && injectionState[0].allowRepeatedMemorySearch), onCheckedChange: function(v) { saveInjectionSettings({ allowRepeatedMemorySearch: v }); } }),
          ]),
          UI.Column({ fillMaxWidth: true, spacing: 4 }, [
            UI.Column({ spacing: 2 }, [
              UI.Text({ text: '每次注入记忆条数', style: 'bodySmall', color: colors.onSurface, fontWeight: 'bold' }),
              UI.Text({ text: '输入 1-20 自动保存（默认 5）。', style: 'labelSmall', color: colors.onSurfaceVariant }),
            ]),
            UI.TextField({ value: injectionLimitInputState[0], onValueChange: onInjectionLimitChange, placeholder: (injectionState[0] && injectionState[0].maxMemories ? String(injectionState[0].maxMemories) : '5'), singleLine: true }),
          ]),
        ]),
      ]),
      UI.Spacer({ height: 8 }),
      UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceContainerHigh, padding: 12, border: { width: 1, color: colors.outlineVariant } }, [
        UI.Column({ spacing: 8 }, [
          UI.Text({ text: '💾 数据备份', style: 'labelMedium', fontWeight: 'bold', color: colors.primary }),
          UI.Text({ text: '备份生活数据、记忆库（SQLite）、注入设置、角色上下文与对账标记。', style: 'labelSmall', color: colors.onSurfaceVariant }),
          UI.Row({ fillMaxWidth: true, spacing: 8 }, [
            UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.primary, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: doExportBackup }, [
              UI.Row({ verticalAlignment: 'center' }, [
                UI.Icon({ name: 'upload', tint: colors.onPrimary, size: 16 }),
                UI.Spacer({ width: 4 }),
                UI.Text({ text: '导出备份', style: 'labelSmall', color: colors.onPrimary, fontWeight: 'bold' }),
              ]),
            ]),
            UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.primaryContainer, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: doPickAndRestore }, [
              UI.Row({ verticalAlignment: 'center' }, [
                UI.Icon({ name: 'download', tint: colors.primary, size: 16 }),
                UI.Spacer({ width: 4 }),
                UI.Text({ text: '导入恢复', style: 'labelSmall', color: colors.primary, fontWeight: 'bold' }),
              ]),
            ]),
          ]),
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Text({ text: '恢复模式', style: 'bodySmall', color: colors.onSurface, fontWeight: 'bold' }),
            UI.Spacer({ width: 8 }),
            UI.Surface({ shape: { cornerRadius: 8 }, containerColor: backupModeState[0] === 'merge' ? colors.primary : colors.surfaceContainerHigh, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: function() { backupModeState[1]('merge'); } }, [
              UI.Text({ text: '合并（保留现有）', style: 'labelSmall', color: backupModeState[0] === 'merge' ? colors.onPrimary : colors.onSurfaceVariant, fontWeight: 'bold' }),
            ]),
            UI.Spacer({ width: 8 }),
            UI.Surface({ shape: { cornerRadius: 8 }, containerColor: backupModeState[0] === 'overwrite' ? colors.primary : colors.surfaceContainerHigh, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: function() { backupModeState[1]('overwrite'); } }, [
              UI.Text({ text: '覆盖', style: 'labelSmall', color: backupModeState[0] === 'overwrite' ? colors.onPrimary : colors.onSurfaceVariant, fontWeight: 'bold' }),
            ]),
          ]),
          backupResultState[0] ? UI.Text({ text: backupResultState[0], style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 11 }) : null,
        ]),
      ]),
      UI.Spacer({ height: 8 }),
    ].concat(cfgSection);
      break;
    case 6: tabContent = deployTab.render(ctx); break;
    default: tabContent = overviewTab.render(ctx, allData, { onOpenTodos: function() { tabState[1](1); } });
  }
  // v2.1.0：数据型 tab 未就绪时显示加载占位，避免快速切换出现空白
  var dts0 = Number(dataLoadedState[0] || 0);
  var dd0 = dataState[0];
  var dataReady0 = dd0 && (dd0.events || dd0.info || dd0.todos || dd0.contacts || dd0.finance);
  if (!dts0 && !dataReady0 && (currentTab === 0 || currentTab === 1 || currentTab === 2)) {
    tabContent = [
      UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.surfaceContainerHigh, padding: 24 }, [
        UI.Column({ horizontalAlignment: 'center', spacing: 8 }, [
          UI.Text({ text: '正在加载数据…', style: 'titleMedium', color: colors.onSurface }),
          UI.Text({ text: '首次读取可能需要几秒，请稍候', style: 'bodySmall', color: colors.onSurfaceVariant }),
        ]),
      ]),
    ];
  }

  // ===== 返回 =====
  return UI.Column({ fillMaxSize: true, padding: 8, onLoad: async function() {
    // v2.1.6：action 链保持——Operit 平台异步 setState 默认不触发 UI 重建，
    // 只有 action 分发期间（Promise pending）订阅 stateChange 并通过中间渲染实时推送。
    // onLoad 本身是 action：await 关键加载 + 保持窗口，让本帧所有异步 setState 落在订阅窗口内。
    if (!dataLoadScheduledRef.current && !Number(dataLoadedState[0] || 0)) {
      try { await loadData(); } catch (__e) {}
    }
    // 保持 action 链窗口：覆盖 render 调度块触发的 persona/memory/角色页等异步加载的 setState 推送
    // v2.3.2b：延长到 120s——onLoad 是 action 分发，期间订阅 stateChange → 任何 setState（含
    // 自动分析 setTimeout 链）都会触发中间渲染推送平台重绘（源码级机制；dispatch 自调不可达平台，
    // 19:45 实证 sendIntermediateResult 未注入）。120s 覆盖自动分析周期，结束后窗口自动关闭。
    await new Promise(function(__res) { setTimeout(__res, 120000); });
  } }, [
  headerCard,
  UI.Spacer({ height: 6 }),
  ].concat((currentTab === 2 || currentTab === 3) ? [searchBar] : []).concat(currentTab === 2 ? calPanel : []).concat(filterRow).concat([
    UI.LazyColumn({ fillMaxWidth: true, weight: 1, spacing: 4 }, tabContent),
    UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 16 }, containerColor: colors.surfaceVariant, padding: 5 }, [
      UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, tabItems),
    ]),
  ]));
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;

const shared = require("./shared");
const { relationMap, parseResult, pad2 } = shared;
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
  var analyzingState = ctx.useState('analyzing', false);
  var resultState = ctx.useState('resultText', '');
  var showCfgState = ctx.useState('showCfg', false);
  var queryState = ctx.useState('query', (uiBoot.query !== undefined ? uiBoot.query : ''));
  var dateStartState = ctx.useState('dateStart', (uiBoot.dateStart !== undefined ? uiBoot.dateStart : ''));
  var dateEndState = ctx.useState('dateEnd', (uiBoot.dateEnd !== undefined ? uiBoot.dateEnd : ''));
  var filterTypeState = ctx.useState('filterType', (uiBoot.filterType !== undefined ? uiBoot.filterType : ''));
  var showCalState = ctx.useState('showCal', false);
  var memoryState = ctx.useState('memories', []);
  var memoryLoadedState = ctx.useState('memoriesLoaded', false);
  var memoryQueryState = ctx.useState('memQuery', (uiBoot.memQuery !== undefined ? uiBoot.memQuery : ''));
  var injectionState = ctx.useState('injectionSettings', null);
  var injectionSavingState = ctx.useState('injectionSaving', false);
  var injectionLimitInputState = ctx.useState('injectionLimitInput', '');
  // 数据备份
  var backupBusyState = ctx.useState('backupBusy', false);
  var backupResultState = ctx.useState('backupResult', '');
  var backupModeState = ctx.useState('backupMode', 'merge');
  var screenPersonaState = ctx.useState('screenPersona', null);
  var screenCharMemoriesState = ctx.useState('screenCharMemories', []);
var uiSaveRef = ctx.useRef('uiSaveRef', '');
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
var triggerPollRef = ctx.useRef('triggerPoll', 0);
var dataLoadScheduledRef = ctx.useRef('dataLoadScheduled', false);
var memoryLoadScheduledRef = ctx.useRef('memoryLoadScheduled', false);
var characterLoadScheduledRef = ctx.useRef('characterLoadScheduled', false);
  if (!initRef.current) {
 initRef.current = true;
 // ===== 自动触发分析：检测上次以来是否有新对话内容 =====
 (async function() {
   try {
     var raw = await ctx.callTool('memory_system:trigger_analysis', {});
     var r = parseResult(raw);
     if (r && r.started) {
       // 异步分析已启动 → 显示"分析中"并轮询刷新数据
       resultState[1]('🔄 检测到 ' + (r.newMessageCount || 0) + ' 条新对话，正在后台分析...');
       triggerPollRef.current += 1;
       var pollId = triggerPollRef.current;
       var startMs = Date.now();
       var maxMs = 90000; // 最多轮询 90 秒
       var lastSnapshot = '';
       (function pollOnce() {
         if (pollId !== triggerPollRef.current) return; // 已被新触发取代
         if (Date.now() - startMs > maxMs) {
           resultState[1]('⏱️ 分析超时，请稍后手动刷新');
           return;
         }
         setTimeout(async function() {
           try {
             // 读 env 看分析是否结束
             var envResult = '';
             try { envResult = ctx.getEnv('MEMORY_SYSTEM_TRIGGER_RESULT') || ''; } catch(e) {}
             if (envResult && envResult !== lastSnapshot) {
               lastSnapshot = envResult;
               try {
                 var parsed = JSON.parse(envResult);
                 if (parsed && parsed.finishedAt) {
                   // 分析已结束
                   if (parsed.success && parsed.hasData) {
                     await loadData();
                     resultState[1]('✅ 后台分析完成：发现 ' + (parsed.newMessageCount || 0) + ' 条新内容');
                   } else if (parsed.success && !parsed.hasData) {
                     resultState[1]('✅ 后台分析完成：未发现可提取内容');
                   } else {
                     resultState[1]('⚠️ 分析失败：' + (parsed.error || '未知错误'));
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
       resultState[1]('✅ 无新对话内容 (' + (r.lastAnalyzedAt ? '上次分析：' + new Date(r.lastAnalyzedAt).toLocaleString() : '首次检测') + ')');
     } else if (r && !r.success) {
       resultState[1]('⚠️ 检测失败：' + (r.message || r.error || '未知'));
     }
   } catch(e) {}
 })();
}

  // 首次状态为空时读取一次；后续由根节点 onLoad、分析完成或用户操作明确刷新。
  // 用 state（dataLoadedState）作唯一权威：只要数据未加载就重新调度，避免 useRef 在
  // 快速切换实例复用时残留 true 导致加载永久跳过。
  if (!dataLoadedState[0] && !dataLoadScheduledRef.current) {
    dataLoadScheduledRef.current = true;
    setTimeout(function() {
      loadData().then(function() { dataLoadedState[1](true); })
        .finally(function() { dataLoadScheduledRef.current = false; });
    }, 0);
  }
  // ===== 初始化时加载记忆 =====
  var currentTab = tabState[0];
  if ((currentTab === 3) && !memoryLoadedState[0] && !memoryLoadingState[0] && !memoryLoadScheduledRef.current) {
    memoryLoadScheduledRef.current = true;
    setTimeout(function() {
      loadKnowledgeMemories().finally(function() { memoryLoadScheduledRef.current = false; });
    }, 0);
  }

  // ===== 角色页：进入时自动加载角色上下文与记忆（与知识页同款 setTimeout 模式）=====
  // 每次进入角色 tab 都重新加载，不因之前加载过而跳过；ref 仅防同帧重复。
  if (currentTab === 3 && !characterLoadScheduledRef.current) {
    characterLoadScheduledRef.current = true;
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
        var raw = await ctx.callTool('memory_system:get_analyzed_chats', {});
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
var raw = await ctx.callTool('chat_exporter:list_chats_brief', {
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
  async function loadData() {
    try {
      var raw = await ctx.callTool('memory_engine:load_life_data', {});
      var r = parseResult(raw);
      if (r && r.success) {
            dataState[1]({
                events: r.extracted && r.extracted.events || [],
                contacts: r.extracted && r.extracted.contacts || [],
                info: r.extracted && r.extracted.info || [],
                finance: r.extracted && r.extracted.finance || [],
                todos: r.extracted && r.extracted.todos || [],
                menstrual: r.extracted && r.extracted.menstrual || []
            });
            if (r.injection) {
              injectionState[1](r.injection);
              if (r.injection.maxMemories) injectionLimitInputState[1](String(r.injection.maxMemories));
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
        } catch(ex) {}
      }
    } catch (e) {}
  }

  async function loadScreenPersona() {
    // 每次进入都重新加载角色上下文与记忆；不因之前加载过而跳过，
    // 避免快速切换实例复用时持久 ref/state 残留导致角色页显示异常。
    try {
      var pRaw = await ctx.callTool('memory_engine:list_characters', {});
      var pResult = parseResult(pRaw);
      var chars = pResult && pResult.success && pResult.characters ? pResult.characters : [];
      var p = chars.length > 0
        ? { id: String(chars[0].id || ''), name: String(chars[0].name || ''), type: 'character_card' }
        : { id: '', name: '', type: '' };
      ctx.setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_ID', String(p.id || ''));
      ctx.setEnv('MEMORY_ENGINE_ACTIVE_PERSONA_NAME', String(p.name || ''));
      screenPersonaState[1]({ id: String(p.id || ''), name: String(p.name || ''), type: String(p.type || '') });
      if (p.id) {
        try {
          var mRaw = await ctx.callTool('memory_engine:list_memories', {
            category: 'character',
            character_id: String(p.id),
            limit: 100
          });
          var mResult = parseResult(mRaw);
          if (mResult && mResult.success && mResult.memories) {
            screenCharMemoriesState[1](mResult.memories);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  async function loadKnowledgeMemories() {
    memoryLoadingState[1](true);
    try {
      var personaRaw = await ctx.callTool('memory_engine:list_characters', {});
      var personaResult = parseResult(personaRaw);
      var personaId = personaResult && personaResult.success && personaResult.characters && personaResult.characters.length > 0
        ? String(personaResult.characters[0].id || '') : '';
      var raw = await ctx.callTool('memory_engine:list_memories', {
        limit: 100,
        character_id: personaId || undefined
      });
      var result = parseResult(raw);
      if (result && result.success) memoryState[1](result.memories || []);
      else resultState[1]('记忆读取失败：' + ((result && result.message) || '未知错误'));
    } catch(e) {
      resultState[1]('记忆读取失败：' + (e.message || String(e)));
    }
    memoryLoadedState[1](true);
    memoryLoadingState[1](false);
  }

  async function saveConfig() {
    await ctx.setEnv('MEMORY_SYSTEM_ENDPOINT', endpoint);
    await ctx.setEnv('MEMORY_SYSTEM_KEY', apiKey);
    await ctx.setEnv('MEMORY_SYSTEM_MODEL', model);
    resultState[1]('✅ 配置已保存');
  }

  async function saveInjectionSettings(patch) {
    if (injectionSavingState[0]) return;
    var current = injectionState[0] || { enabled: false, persist: true, maxMemories: 5 };
    var next = {
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      persist: patch.persist !== undefined ? patch.persist : current.persist,
      maxMemories: current.maxMemories
    };
    injectionSavingState[1](true);
    injectionState[1](next);
    try {
      var raw = await ctx.callTool('memory_system:set_injection_settings', next);
      var r = parseResult(raw);
      if (r && r.success && r.injection) {
        injectionState[1](r.injection);
        resultState[1]('✅ 记忆注入设置已保存');
      } else {
        injectionState[1](current);
        resultState[1]('❌ ' + ((r && r.message) || '注入设置保存失败'));
      }
    } catch (e) {
      injectionState[1](current);
      resultState[1]('❌ ' + (e.message || String(e)));
    }
    injectionSavingState[1](false);
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
      resultState[1]('❌ 注入记忆条数必须是 1-20 的整数');
      return;
    }
    injectionSavingState[1](true);
    try {
      var raw = await ctx.callTool('memory_system:set_injection_settings', { max_memories: limit });
      var r = parseResult(raw);
      if (r && r.success && r.injection) {
        injectionState[1](r.injection);
        injectionLimitInputState[1](String(r.injection.maxMemories));
        resultState[1]('✅ 注入记忆条数已保存');
      } else {
        resultState[1]('❌ ' + ((r && r.message) || '注入记忆条数保存失败'));
      }
    } catch (e) {
      resultState[1]('❌ ' + (e.message || String(e)));
    }
    injectionSavingState[1](false);
  }

  // ===== 数据备份 =====
  async function doExportBackup() {
    if (backupBusyState[0]) return;
    backupBusyState[1](true);
    backupResultState[1]('🔄 正在导出备份...');
    try {
      var raw = await ctx.callTool('memory_engine:backup_engine', { reason: 'manual' });
      var r = parseResult(raw);
      if (r && r.success) {
        backupResultState[1]('✅ 备份已导出：' + (r.fileName || '') + '\n路径：' + (r.path || ''));
      } else {
        backupResultState[1]('❌ ' + ((r && r.message) || '导出失败'));
      }
    } catch (e) {
      backupResultState[1]('❌ ' + (e.message || String(e)));
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
      var inspRaw = await ctx.callTool('memory_engine:inspect_engine', { path: filePath });
      var insp = parseResult(inspRaw);
      if (!insp || !insp.success || insp.valid !== true) {
        backupResultState[1]('❌ 备份校验失败：' + ((insp && insp.message) || '文件损坏或格式不正确'));
        backupBusyState[1](false);
        return;
      }
      backupResultState[1]('🔄 备份有效，正在恢复（' + (backupModeState[0] === 'overwrite' ? '覆盖' : '合并') + '模式）...');
      var resRaw = await ctx.callTool('memory_engine:restore_engine', { path: filePath, mode: backupModeState[0] });
      var res = parseResult(resRaw);
      if (res && res.success) {
        backupResultState[1]('✅ 恢复完成（' + res.mode + ' 模式，' + (res.fileCount || 0) + ' 个文件）');
        await loadData();
      } else {
        backupResultState[1]('❌ ' + ((res && res.message) || '恢复失败'));
      }
    } catch (e) {
      backupResultState[1]('❌ ' + (e.message || String(e)));
    }
    backupBusyState[1](false);
  }

  async function doAnalyze() {
    analyzingState[1](true);
    resultState[1]('🔄 分析中...');
    try {
      var raw = await ctx.callTool('memory_system:analyze_saved_messages', {});
      var r = parseResult(raw);
      if (r && r.success) {
        await loadData();
        resultState[1]('✅ 完成：' + (r.events||0) + ' 事件，' + (r.todos||0) + ' 待办');
      } else {
        resultState[1]((r && r.message) || '❌ 分析失败');
      }
    } catch (e) {
      resultState[1]('❌ ' + (e.message || String(e)));
    }
    analyzingState[1](false);
  }

  async function deleteItem(category, index) {
    try {
      var raw = await ctx.callTool('memory_engine:delete_life_item', { category: category, index: index });
      if (parseResult(raw) && parseResult(raw).success) {
        await loadData();
        resultState[1]('✅ 已删除');
      }
    } catch(e) {
      resultState[1]('❌ ' + (e.message || String(e)));
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
// 兜底：异步触发工具保存到磁盘，保证重启后也能恢复
try {
var __uiParams = JSON.stringify({ state_json: __uiSnapshot });
if (typeof NativeInterface !== 'undefined' && typeof NativeInterface.callTool === 'function') {
NativeInterface.callTool('memory_engine', 'save_ui_state', __uiParams);
} else if (typeof Operit !== 'undefined' && Operit.NativeInterface && typeof Operit.NativeInterface.callTool === 'function') {
Operit.NativeInterface.callTool('memory_engine', 'save_ui_state', __uiParams);
}
} catch(__eSave) {}
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
          UI.Surface({ shape: { cornerRadius: 12 }, containerColor: analyzing ? colors.errorContainer : colors.primary, padding: { left: 10, right: 10, top: 4, bottom: 4 }, onClick: function() { if (!analyzing) doAnalyze(); } }, [
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
    typeFilters.push(UI.FilterChip({
      label: UI.Text({ text: label, style: 'labelSmall' }),
      selected: isActive,
      onClick: function() { filterTypeState[1](isActive ? '' : value); }
    }));
  }

  if (currentTab === 2) {
    makeFilterChip('活动', 'activity');
    makeFilterChip('日程', 'schedule');
    makeFilterChip('支出', 'expense');
    makeFilterChip('收入', 'income');
    makeFilterChip('经期', 'menstrual');
  }

  var filterRow = typeFilters.length > 0 ? [
    UI.Row({ fillMaxWidth: true, spacing: 4 }, typeFilters),
    UI.Spacer({ height: 4 }),
  ] : [];

  // ===== Tab 导航栏 =====
  var tabItems = [];
  for (var ti = 0; ti < TAB_REGISTRY.length; ti++) {
    (function(t) {
      var isSel = currentTab === t.id;
      tabItems.push(UI.Surface({ weight: 1, height: 58, shape: { cornerRadius: 12 }, containerColor: isSel ? colors.primaryContainer : 'transparent', onClick: function() { tabState[1](t.id); filterTypeState[1](''); if (t.id === 3) memoryLoadedState[1](false); } }, [
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
    case 0: tabContent = overviewTab.render(ctx, allData); break;
    case 1: tabContent = todosTab.render(ctx, allData, states, actions); break;
    case 2: tabContent = timelineTab.render(ctx, allData, states, actions); break;
    case 3: tabContent = knowledgeTab.render(ctx, allData, states, actions, memoryState[0]); break;
    case 4: tabContent = characterTab.render(ctx, screenPersonaState[0], screenCharMemoriesState[0]); break;
    case 5: tabContent = [
      UI.Text({ text: '设置', style: 'titleMedium', color: colors.onSurface, fontWeight: 'bold' }),
      UI.Text({ text: '提取模型配置仅用于结构化分析；长期记忆使用 Operit 原生 Memory。', style: 'bodySmall', color: colors.onSurfaceVariant }),
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
          UI.Text({ text: '备份六类生活数据、注入设置、角色上下文与对账标记；不备份 Operit 原生 Memory。', style: 'labelSmall', color: colors.onSurfaceVariant }),
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
            UI.FilterChip({
              label: UI.Text({ text: '合并（保留现有）', style: 'labelSmall', color: backupModeState[0] === 'merge' ? colors.primary : colors.onSurfaceVariant }),
              selected: backupModeState[0] === 'merge',
              onClick: function() { backupModeState[1]('merge'); }
            }),
            UI.Spacer({ width: 4 }),
            UI.FilterChip({
              label: UI.Text({ text: '覆盖', style: 'labelSmall', color: backupModeState[0] === 'overwrite' ? colors.primary : colors.onSurfaceVariant }),
              selected: backupModeState[0] === 'overwrite',
              onClick: function() { backupModeState[1]('overwrite'); }
            }),
          ]),
          backupResultState[0] ? UI.Text({ text: backupResultState[0], style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 11 }) : null,
        ]),
      ]),
      UI.Spacer({ height: 8 }),
    ].concat(cfgSection);
      break;
    case 6: tabContent = deployTab.render(ctx); break;
    default: tabContent = overviewTab.render(ctx, allData);
  }

  // ===== 返回 =====
  return UI.Column({ fillMaxSize: true, padding: 8, onLoad: async function() {
    await loadData();
    await loadScreenPersona();
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

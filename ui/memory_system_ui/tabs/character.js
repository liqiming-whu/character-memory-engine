"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { parseResult, fmtErr } = shared;
const theme = require("../theme");

const CATEGORIES = [
  { id: 'character', label: '角色信息' },
  { id: 'relationship', label: '关系记忆' },
  { id: 'preference', label: '偏好' },
  { id: 'interaction_rule', label: '互动规则' },
];

// v2.1.2：模块级删除防重入锁——本渲染器 onClick 存在"双触发"现象（同一点击事件
// 会间隔数百毫秒~数秒再次调用），模块级变量跨闭包绝对共享，拦截第二次调用
var __cmeDeleteLock = 0;
// v2.1.3：模块级"本地变更权威快照"——删除/创建成功后记录最新列表与时间戳；
// 每次渲染强制应用（任何异步路径覆盖列表都会被拉回），30 秒后过期恢复正常加载。
// 模块级变量跨渲染/跨闭包绝对共享，不依赖 useState/useRef 的可靠性。
var __cmeLocalList = null;
var __cmeLocalTs = 0;

function render(ctx, personaFromScreen, memoriesFromScreen) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);
  // 分类 chip 用 primary/tertiary 交替强调
  var catColors = [colors.primary, colors.tertiary, colors.error, colors.secondary];
  var personaState = ctx.useState('character_persona_context', {
    id: String(ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_ID') || ''),
    name: String(ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_NAME') || ''),
    type: String(ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_TYPE') || '')
  });
  // 外部传入的角色上下文优先：screen 根 onLoad 加载后传入，避免依赖子组件副作用
  if (personaFromScreen && (!personaState[0] || !personaState[0].id) && personaFromScreen.id) {
    personaState[1](personaFromScreen);
  }
  var personaId = String((personaState[0] && personaState[0].id) || '');
  var personaName = String((personaState[0] && personaState[0].name) || '');
  var personaType = String((personaState[0] && personaState[0].type) || '');
  var memoriesState = ctx.useState('character_memories', []);
  // v2.1.1：记录最近一次接受的 screen 快照签名——本地变更（删除/创建）后 screen 重渲染仍会传旧快照，
  // 只有快照内容变化（screen 重新拉取）才接受，避免"删了又回来"需要点两次
  var lastScreenMemRef = ctx.useRef('character_last_screen_mem_sig', '');
  // v2.1.1：screen 快照只接受角色四分类（character/relationship/preference/interaction_rule），
  // 防止 info 等知识分类记忆（未选分类误存）混入角色页
  var screenRoleSet = ['character', 'relationship', 'preference', 'interaction_rule'];
  var screenFiltered = (Array.isArray(memoriesFromScreen) && memoriesFromScreen.length > 0)
    ? memoriesFromScreen.filter(function(m) { return screenRoleSet.indexOf(m.category) >= 0; })
    : [];
  if (screenFiltered.length > 0) {
    var sig = JSON.stringify(screenFiltered);
    var curM0 = memoriesState[0] || [];
    // v2.1.2：本地变更（删除/创建）后 30 秒内不接受 screen 快照覆盖——本地列表为准，
    // 防止删除/添加后重渲染时 screen 旧快照把已删记忆"救回来"（表现为要点两次）
    // v2.1.4：用 useState 时间戳（跨 mount 持久，模块级变量 mount 后重置会失效）
    var localFresh = localChangeState[0] && (Date.now() - localChangeState[0]) < 30000;
    if (!localFresh && sig !== lastScreenMemRef.current) {
      lastScreenMemRef.current = sig;
      if (JSON.stringify(curM0) !== sig) {
        memoriesState[1](screenFiltered);
      }
    }
  }
  var loadingState = ctx.useState('character_loading', false);
  var loadedForRef = ctx.useRef('character_loaded_for', '');
  // v2.1.0：全量四类缓存——chip 切换前端过滤，秒切零调用
  var allMemoriesRef = ctx.useRef('character_all_memories_v2', []);
  // v2.1.0：复用 screen.js 的 persona 缓存（同 key 'personaCache'），onLoad 未完成时避免重复 list_characters
  var personaCacheRef2 = ctx.useRef('personaCache', { id: '', name: '', type: '', ts: 0 });
  var lastAnalyzeSeenRef = ctx.useRef('character_last_analyze_seen', 0);
  var categoryState = ctx.useState('character_category_v2', '');
  // v2.1.1：分类即时 ref——chips onClick 里先同步 ref 再 setState，
  // 防止"选完分类立刻点保存"时保存按钮闭包仍捕获旧分类（导致存成 info/通用记忆）
  var categoryStateRef = ctx.useRef('character_category_ref_v2', '');
  // v2.1.1：本地变更时间戳（删除/创建成功时刷新）——用于抑制 screen 旧快照覆盖
  var localChangeRef = ctx.useRef('character_local_change_v2', 0);
  // v2.1.2：本地变更时间戳（useState 版，跨渲染绝对可靠）——渲染风暴/异步等待期间，
  // useRef 读取可能拿到旧值导致保护失效；useState 与列表更新同机制，30 秒内禁止
  // loadOnEnter 自动加载与 screen 快照覆盖，列表完全由本地维护
  var localChangeState = ctx.useState('character_local_change_v3', 0);
  // v2.1.4：已删记忆"墓碑"（useState 跨 mount 持久）——删除成功后记录 id，
  // 每次渲染强制从列表过滤；即使组件重新挂载（mount）后重新加载返回含已删记忆的
  // 旧列表，渲染时也会被墓碑过滤掉，60 秒后过期恢复正常同步
  var localOpsState = ctx.useState('character_local_ops_v1', '[]');
  var localOpsTsState = ctx.useState('character_local_ops_ts_v1', 0);
  // 渲染时强制墓碑过滤（在 screen 快照逻辑之前执行，保证任何来源的列表都被过滤）
  var opsTsNow = localOpsTsState[0];
  if (opsTsNow && (Date.now() - opsTsNow) < 60000) {
    var opsList = [];
    try { opsList = JSON.parse(localOpsState[0] || '[]'); } catch (e) {}
    if (opsList.length) {
      var curL = memoriesState[0] || [];
      var filteredL = curL.filter(function(x) { return opsList.indexOf(String(x.id)) < 0; });
      if (filteredL.length !== curL.length) {
        memoriesState[1](filteredL);
      }
    }
  }
  // v2.1.3：渲染时强制应用模块级本地快照——删除/创建后 30 秒内，无论其他路径
  // （异步加载/快照覆盖）把 memoriesState 改成了什么，渲染时都拉回权威列表
  if (__cmeLocalList && __cmeLocalTs && (Date.now() - __cmeLocalTs) < 30000) {
    var curSnap = memoriesState[0] || [];
    if (JSON.stringify(curSnap) !== JSON.stringify(__cmeLocalList)) {
      memoriesState[1](__cmeLocalList);
    }
  }
  var titleState = ctx.useState('character_title', '');
  var contentState = ctx.useState('character_content', '');
  var resultState = ctx.useState('character_result', '');
  var contextLoadingRef = ctx.useRef('character_context_loading', false);
  var retryAtRef = ctx.useRef('character_retry_at', 0);
  var autoLoadAtRef = ctx.useRef('character_auto_load_at', 0);

  async function callToolWithTimeout(name, params, timeoutMs) {
    var timer = null;
    try {
      return await Promise.race([
        ctx.callTool(name, params),
        new Promise(function(_, reject) {
          timer = setTimeout(function() { reject(new Error('读取超时')); }, timeoutMs || 12000);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function loadForPersona(targetPersonaId, catOverride, silent) {
    if (!targetPersonaId) {
      memoriesState[1]([]);
      return;
    }
    // v2.1.0：silent（分类 chip 切换）不显示"正在读取"，列表直接更新，避免卡转圈
    if (!silent) loadingState[1](true);
    try {
      // v2.1.0：全不选 = 一次查全部（前端过滤四类）+ 更新缓存；单分类 = 查该分类
      var cat = catOverride || categoryState[0] || '';
      var merged = [];
      if (!cat) {
        var rr = parseResult(await callToolWithTimeout('memory_engine:list_memories', { character_id: targetPersonaId, limit: 200 }, 12000));
        var roleSet = ['character', 'relationship', 'preference', 'interaction_rule'];
        merged = (rr && rr.success && rr.memories) ? rr.memories.filter(function(m) { return roleSet.indexOf(m.category) >= 0; }) : [];
        allMemoriesRef.current = merged;
      } else {
        var rr2 = parseResult(await callToolWithTimeout('memory_engine:list_memories', { category: cat, character_id: targetPersonaId, limit: 100 }, 12000));
        if (rr2 && rr2.success && rr2.memories) merged = rr2.memories;
      }
      if (merged.length > 0 || cat) {
        // v2.1.0：相同内容不重复 setState（防并发重复渲染）
        var curM1 = memoriesState[0] || [];
        if (JSON.stringify(curM1) !== JSON.stringify(merged)) {
          memoriesState[1](merged);
        }
        loadedForRef.current = targetPersonaId + ':' + Date.now();
        retryAtRef.current = 0;
      } else {
        // v2.1.0：查询失败/超时（Operit 工具调用层偶发波动）——不清空列表，5 秒后自动重试一次
        resultState[1]('读取失败：暂时无法读取，5 秒后自动重试…');
        retryAtRef.current = Date.now() + 5000;
        var pidR = personaState[0] && personaState[0].id;
        if (pidR) {
          setTimeout(function() {
            loadForPersona(pidR, '').catch(function() {});
          }, 5000);
        }
      }
      loadingState[1](false);
      return;
    } catch (e) {
      loadingState[1](false);
      resultState[1]('读取失败：' + (e && e.message ? e.message : String(e)));
      retryAtRef.current = Date.now() + 30000;
      return;
    }
  }
  async function loadContext() {
    // v2.1.0：防重入锁带过期（20秒）——useRef 跨重启持久化，残留 true 会锁死加载
    if (contextLoadingRef.current && (Date.now() - contextLoadingRef.current) < 20000) return;
    contextLoadingRef.current = Date.now();
    try {
      // v2.1.0：优先用 screen.js 传入的已确认角色（避免每次进入重复 list_characters 工具调用）
      var persona = null;
      if (personaFromScreen && personaFromScreen.id) {
        persona = { id: String(personaFromScreen.id), name: String(personaFromScreen.name || '未命名角色'), type: String(personaFromScreen.type || 'character_card') };
      }
      if (!persona) {
        // v2.1.0：查 screen.js persona 缓存（60 秒内），onLoad 未完成时避免重复 list_characters
        var pc2 = personaCacheRef2.current || {};
        if (pc2.id && (Date.now() - (pc2.ts || 0)) < 60000) {
          persona = { id: String(pc2.id), name: String(pc2.name || '未命名角色'), type: String(pc2.type || 'character_card') };
        }
      }
      if (!persona) {
        // 兜底：先读 env（main.js onPromptFinalize 已写入当前角色卡）
        var envId = String(ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_ID') || '');
        var envName = String(ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_NAME') || '');
        var envType = String(ctx.getEnv('MEMORY_ENGINE_ACTIVE_PERSONA_TYPE') || '');
        if (envId) {
          persona = { id: envId, name: envName || '未命名角色', type: envType || 'character_card' };
        } else {
          var raw = await callToolWithTimeout('memory_engine:list_characters', {}, 8000);
          var result = parseResult(raw);
          var chars = result && result.success && result.characters ? result.characters : [];
          // 取第一个角色作为当前角色（Engine 侧 maintain 最近角色）
          persona = chars.length > 0
            ? { id: String(chars[0].id || ''), name: String(chars[0].name || ''), type: 'character_card' }
            : null;
        }
      }
      if (!persona) {
        personaState[1]({ id: '', name: '', type: '' });
        memoriesState[1]([]);
        retryAtRef.current = Date.now() + 30000;
        return;
      }
      // v2.1.0：相同角色不重复 setState（防渲染死循环）
      var curP = personaState[0];
      if (!curP || curP.id !== persona.id || curP.name !== persona.name || curP.type !== persona.type) {
        personaState[1](persona);
      }
      var nextId = String(persona.id || '');
      if (nextId) {
        retryAtRef.current = 0;
        // v2.1.0：分析完成（全局时间戳）后强制刷新，避免切回角色页看到旧缓存
        try {
          var gStamp = (typeof globalThis !== 'undefined') ? (globalThis.__cmeAnalyzeStamp || 0) : 0;
          if (gStamp && gStamp > (lastAnalyzeSeenRef.current || 0)) {
            lastAnalyzeSeenRef.current = gStamp;
            loadedForRef.current = '';
          }
        } catch (e) {}
        // v2.1.0：同一角色 30 秒内已加载过则不重复拉取（防 chip 重渲染闪屏）；
        // 超过 30 秒或跨重启（时间戳过期）则重新加载，避免显示旧数据/卡"正在读取"
        var lfInfo = loadedForRef.current || '';
        var lfId = lfInfo.split(':')[0];
        var lfTs = parseInt(lfInfo.split(':')[1] || '0', 10);
        if (lfId === nextId && (Date.now() - lfTs) < 30000) {
          // 仅在残留 loading 为 true 时清除（避免每次渲染无条件 setState 造成死循环）
          if (loadingState[0]) loadingState[1](false);
          return;
        }
        await loadForPersona(nextId);
      } else {
        memoriesState[1]([]);
        retryAtRef.current = Date.now() + 30000;
      }
    } catch (e) {
      var errMsg = e.message || String(e);
      resultState[1]('角色上下文读取失败：' + errMsg);
      retryAtRef.current = Date.now() + 30000;
      // v2.1.0：worker 未就绪/超时类错误，5 秒后自动重试一次，避免一直卡"正在读取"
      if (/worker|未响应|拉起|超时|未就绪/i.test(errMsg)) {
        resultState[1]('引擎启动中，5 秒后自动重试…');
        setTimeout(function() { if (!contextLoadingRef.current || (Date.now() - contextLoadingRef.current) >= 20000) loadContext(); }, 5000);
      }
    } finally {
      contextLoadingRef.current = 0;
    }
  }

  async function loadMemories() {
    loadedForRef.current = personaId + ':' + Date.now();
    // v2.1.0：刷新 = 重新拉全量更新缓存，再按当前选中的分类过滤显示
    await loadForPersona(personaId, '');
    var cat2 = categoryState[0];
    if (cat2) {
      var cache2 = allMemoriesRef.current || [];
      var list2 = cache2.filter(function(m) { return m.category === cat2; });
      if (JSON.stringify(memoriesState[0] || []) !== JSON.stringify(list2)) memoriesState[1](list2);
    }
  }

  async function createMemory() {
    var title = String(titleState[0] || '').trim();
    var content = String(contentState[0] || '').trim();
    if (!title || !content) {
      resultState[1]('标题和内容不能为空');
      return;
    }
    // v2.1.2：点击保存即进入本地变更保护（useState 跨渲染可靠）
    localChangeState[1](Date.now());
    // v2.1.1：优先即时 ref（chips 点击已同步），兜底当前渲染快照；
    // 未选分类直接提示，不再默默存成 info/通用记忆（用户上次踩的坑）
    var category = categoryStateRef.current || categoryState[0] || '';
    if (!category) {
      resultState[1]('请先选择分类（角色信息/关系记忆/偏好/互动规则）');
      return;
    }
    var raw = await ctx.callTool('memory_engine:create_memory', {
      category: category,
      title: title,
      content: content,
      character_id: personaId
    });
    var result = parseResult(raw);
    if (result && result.success) {
      titleState[1]('');
      contentState[1]('');
      resultState[1]('记忆创建成功' + (result.deduped ? '（合并已有记忆）' : ''));
      // v2.1.1：本地立即插入/替换（平台工具缓存可能返回旧列表，不再依赖重新拉取）
      localChangeRef.current = Date.now();
      localChangeState[1](Date.now());
      // v2.1.1：同步刷新 30 秒加载窗口，防止重渲染时 loadOnEnter 重新拉取覆盖本地新增
      loadedForRef.current = personaId + ':' + Date.now();
      var nm = result.memory;
      if (nm && nm.id) {
        var curList = (memoriesState[0] || []).slice();
        var idx = -1;
        for (var i = 0; i < curList.length; i++) { if (curList[i].id === nm.id) { idx = i; break; } }
        if (idx >= 0) curList[idx] = nm; else curList.unshift(nm);
        // v2.1.3：写入模块级权威快照（渲染时强制应用）
        __cmeLocalList = curList;
        __cmeLocalTs = Date.now();
        memoriesState[1](curList);
        if (Array.isArray(allMemoriesRef.current)) {
          var ca = allMemoriesRef.current.slice();
          var ci2 = -1;
          for (var j = 0; j < ca.length; j++) { if (ca[j].id === nm.id) { ci2 = j; break; } }
          if (ci2 >= 0) ca[ci2] = nm; else ca.unshift(nm);
          allMemoriesRef.current = ca;
        }
      } else {
        await loadMemories();
      }
    } else resultState[1]((result && result.message) || '创建失败');
  }

  async function deleteMemory(mid) {
    var logLine = function(s) { try { ctx.callTool('memory_engine:log_ui', { line: s }); } catch (e) {} };
    // v2.2.1：按 id 精确防重入——只拦同一 id 的渲染器双触发（毫秒级），
    // 不再误拦用户间隔 <2 秒点击不同条目的真实操作（旧版全局锁导致"点两次才删"）
    var nowLock = Date.now();
    if (__cmeDeleteLockId === String(mid) && __cmeDeleteLock && (nowLock - __cmeDeleteLock) < 2000) {
      logLine('[del] DUPLICATE IGNORED id=' + mid);
      return;
    }
    __cmeDeleteLock = nowLock;
    __cmeDeleteLockId = String(mid);
    logLine('[del] click id=' + mid + ' list=' + (memoriesState[0] || []).length);
    // v2.1.2：点击即进入本地变更保护（useState 跨渲染可靠）——异步等待/渲染风暴期间
    // 也不允许自动加载或快照覆盖干扰本地列表
    localChangeState[1](Date.now());
    // v2.1.1：按 id 精确删除（title 可重复，按 title 查找会误删/漏删，表现为"要点两次"）
    var m = (memoriesState[0] || []).find(function(x) { return String(x.id) === String(mid); });
    if (!m || !m.id) {
      resultState[1]('未找到该记忆');
      logLine('[del] NOT FOUND');
      return;
    }
    logLine('[del] found id=' + m.id);
    var raw;
    try {
      raw = await ctx.callTool('memory_engine:delete_memory', { id: m.id });
    } catch (e) {
      logLine('[del] CALL EXCEPTION: ' + (e && e.message ? e.message : String(e)));
      resultState[1]('删除异常：' + (e && e.message ? e.message : String(e)));
      return;
    }
    var result = parseResult(raw);
    logLine('[del] call done success=' + !!(result && result.success) + ' msg=' + ((result && result.message) || ''));
    if (result && result.success) {
      // v2.1.1：本地立即移除该条（平台工具缓存可能返回旧列表，不再依赖重新拉取）
      localChangeRef.current = Date.now();
      localChangeState[1](Date.now());
      // v2.1.1：同步刷新 30 秒加载窗口——防止重渲染触发 loadOnEnter 重新拉取覆盖本地删除
      loadedForRef.current = personaId + ':' + Date.now();
      var newList = (memoriesState[0] || []).filter(function(x) { return x.id !== m.id; });
      // v2.1.3：写入模块级权威快照（渲染时强制应用，防旧快照覆盖）
      __cmeLocalList = newList;
      __cmeLocalTs = Date.now();
      // v2.1.4：写入已删墓碑（useState 跨 mount 持久）——mount 后重新加载也能过滤掉
      var opsArr = [];
      try { opsArr = JSON.parse(localOpsState[0] || '[]'); } catch (e) {}
      if (opsArr.indexOf(String(m.id)) < 0) opsArr.push(String(m.id));
      localOpsState[1](JSON.stringify(opsArr));
      localOpsTsState[1](Date.now());
      memoriesState[1](newList);
      if (Array.isArray(allMemoriesRef.current)) {
        allMemoriesRef.current = allMemoriesRef.current.filter(function(x) { return x.id !== m.id; });
      }
      resultState[1]('已删除');
      logLine('[del] local removed, len=' + newList.length);
    } else {
      resultState[1]((result && result.message) || '删除失败');
    }
  }

  async function loadOnEnter() {
    // 失败后退避：30 秒内不自动重试
    if (Date.now() < Number(retryAtRef.current || 0)) return;
    // 节流：同一角色页进入 1.5 秒内不重复自动加载（快速切 tab 不会风暴）
    var now = Date.now();
    if (now - Number(autoLoadAtRef.current || 0) < 1500) return;
    autoLoadAtRef.current = now;
    await loadContext();
  }
  // 渲染时直接触发自动加载：不用 setTimeout，避免依赖事件循环；
  // loadOnEnter 异步不阻塞渲染，loadContext 幂等（防重入 + 节流 + 失败退避）。
  // v2.1.2：本地变更（删除/创建）后 30 秒内跳过自动加载——列表由本地维护，
  // 防止渲染风暴触发 loadContext 重新拉取（平台缓存旧数据）把变更"救回来"
  // v2.1.4：用 useState 时间戳（跨 mount 持久，模块级变量 mount 后重置会失效）
  var localFreshNow = localChangeState[0] && (Date.now() - localChangeState[0]) < 30000;
  if (!localFreshNow) {
    loadOnEnter();
  }
  // v2.1.0：假"正在读取"兜底——数据已就绪但 loading 残留 true 时强制清除并刷新界面。
  // 根因：Operit 对"相同值 setState"不触发重渲染，并发加载路径可能吞掉 loading 清除的渲染信号，
  // 导致数据早已加载完成但界面一直卡在"正在读取…"；此条件只在 loading=true 且数据非空时触发一次，不会死循环。
  if (loadingState[0] && memoriesState[0] && memoriesState[0].length > 0) {
    loadingState[1](false);
  }

  if (!personaId) {
    // v2.1.0：有 persona 缓存但尚未传入（onLoad 异步进行中）——显示识别占位而非报错
    var pc3 = personaCacheRef2.current || {};
    if (pc3.id && (Date.now() - (pc3.ts || 0)) < 60000) {
      return [UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.surfaceContainerHigh, padding: 18 }, [
        UI.Column({ horizontalAlignment: 'center' }, [
          UI.Spacer({ height: 8 }),
          UI.Text({ text: '正在识别角色…', style: 'titleMedium', color: colors.onSurface }),
          UI.Text({ text: '正在读取角色卡，请稍候', style: 'bodySmall', color: colors.onSurfaceVariant }),
          UI.Spacer({ height: 8 }),
        ]),
      ])];
    }
    return [UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.errorContainer, padding: 18 }, [
      UI.Column({ horizontalAlignment: 'center' }, [
        UI.Icon({ name: 'person_off', tint: colors.error, size: 36 }),
        UI.Spacer({ height: 8 }),
        UI.Text({ text: personaType === 'character_group' ? '首版暂不支持角色组记忆' : '当前未识别到角色卡', style: 'titleMedium', color: colors.error, fontWeight: 'bold' }),
        UI.Text({ text: '请在启用角色卡的对话中发送一条消息后再打开此页面。', style: 'bodySmall', color: colors.onSurfaceVariant }),
        UI.Spacer({ height: 8 }),
        UI.Button({ text: '重新识别角色卡', onClick: loadContext }),
      ]),
    ])];
  }

  var items = [
    UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.primaryContainer, padding: 12 }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'person', tint: colors.primary, size: 28 }),
        UI.Spacer({ width: 8 }),
        UI.Column({ weight: 1 }, [
          UI.Text({ text: personaName || '未命名角色', style: 'titleMedium', color: colors.primary, fontWeight: 'bold' }),
          UI.Text({ text: '角色卡 ID：' + personaId, style: 'labelSmall', color: colors.onSurfaceVariant, maxLines: 1 }),
          UI.Text({ text: '原生 Memory Profile · ' + memoriesState[0].length + ' 条', style: 'labelSmall', color: colors.primary }),
        ]),
        UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.primary, padding: 6, onClick: loadMemories }, [
          UI.Icon({ name: 'refresh', tint: colors.onPrimary, size: 18 }),
        ]),
      ]),
    ]),
    UI.Spacer({ height: 8 }),
    UI.Text({ text: '新增角色记忆', style: 'labelMedium', color: colors.onSurface, fontWeight: 'bold' }),
  ];

  var chips = [];
  for (var ci = 0; ci < CATEGORIES.length; ci++) {
    (function(category, idx) {
      var selected = categoryState[0] === category.id;
      var color = catColors[idx % catColors.length];
      // 未选中也用浅色底（surfaceContainerHigh），避免像输入框；选中用分类色实底
      var onColor = idx % catColors.length === 2 ? colors.onError
        : (idx % catColors.length === 3 ? colors.onSecondary
          : (idx % catColors.length === 1 ? colors.onTertiary : colors.onPrimary));
      chips.push(UI.Surface({ shape: { cornerRadius: 8 }, containerColor: selected ? color : colors.surfaceContainerHigh, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: function() {
          var catId = category.id;
          // v2.1.0：点击已选中的分类 = 取消选中（全不选时展示全部四类）
          var next = (categoryState[0] === catId) ? '' : catId;
          // v2.1.1：先同步 ref 再 setState——保存按钮闭包立即读到最新分类
          categoryStateRef.current = next;
          categoryState[1](next);
          // v2.1.0：优先前端过滤（全量缓存已加载时秒切，零工具调用）；缓存空时回退查询
          var cache = allMemoriesRef.current || [];
          var pid = personaState[0] && personaState[0].id;
          if (cache.length > 0) {
            var list = next ? cache.filter(function(m) { return m.category === next; }) : cache;
            var curM1 = memoriesState[0] || [];
            if (JSON.stringify(curM1) !== JSON.stringify(list)) memoriesState[1](list);
            // v2.1.0：切换后更新 loadedForRef——30 秒内 loadOnEnter 不再自动重载，
            // 避免"切换→setState→重渲染→loadOnEnter→又触发完整加载→正在读取卡住"
            if (pid) loadedForRef.current = pid + ':' + Date.now();
          } else if (pid) {
            setTimeout(function() {
              loadForPersona(pid, next, true).catch(function(err) {
                loadingState[1](false);
                resultState[1]('加载失败：' + fmtErr(err && err.message ? err.message : String(err)));
              });
            }, 0);
          }
        } }, [
        UI.Text({ text: category.label, style: 'labelSmall', color: selected ? onColor : colors.onSurfaceVariant, fontWeight: 'bold' }),
      ]));
    })(CATEGORIES[ci], ci);
    // 显式 Spacer 分隔（此渲染器的 Row spacing 参数不可靠，与部署页一致）
    if (ci < CATEGORIES.length - 1) chips.push(UI.Spacer({ width: 30 }));
  }
  items.push(UI.Row({ fillMaxWidth: true, horizontalArrangement: 'center' }, chips));
  items.push(UI.TextField({ value: titleState[0], onValueChange: titleState[1], placeholder: '标题', singleLine: true }));
  items.push(UI.TextField({ value: contentState[0], onValueChange: contentState[1], placeholder: '明确、可复用的长期记忆' }));
  items.push(UI.Button({ text: '保存到当前角色', onClick: createMemory, fillMaxWidth: true }));
  if (resultState[0]) items.push(UI.Text({ text: resultState[0], style: 'labelSmall', color: colors.onSurfaceVariant }));
  items.push(UI.Spacer({ height: 8 }));
  items.push(UI.Text({ text: loadingState[0] ? '正在读取…' : '角色记忆', style: 'labelMedium', color: colors.onSurface, fontWeight: 'bold' }));

  for (var mi = 0; mi < memoriesState[0].length; mi++) {
    (function(memory) {
      var rawTitle = String(memory.title || '').replace(/^\[persona:[^\]]+\]\s*/, '').trim();
      var fallbackText = String(memory.content || memory.description || '').trim();
      var displayTitle = rawTitle || (fallbackText.length > 20 ? fallbackText.substring(0, 20) + '…' : fallbackText) || '未命名记忆';
      items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.surface, padding: 10 }, [
        UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
          UI.Column({ weight: 1 }, [
            UI.Text({ text: displayTitle, style: 'bodySmall', color: colors.onSurface, fontWeight: 'bold' }),
            UI.Text({ text: memory.content || '', style: 'labelSmall', color: colors.onSurfaceVariant, maxLines: 3 }),
          ]),
          UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.errorContainer, padding: 5, onClick: function() { return deleteMemory(memory.id); } }, [
            UI.Icon({ name: 'delete', tint: colors.error, size: 16 }),
          ]),
        ]),
      ]));
      items.push(UI.Spacer({ height: 3 }));
    })(memoriesState[0][mi]);
  }
  return items;
}

exports.render = render;

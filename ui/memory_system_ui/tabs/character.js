"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { parseResult } = shared;
const theme = require("../theme");

const CATEGORIES = [
  { id: 'character', label: '角色信息' },
  { id: 'relationship', label: '关系记忆' },
  { id: 'preference', label: '偏好' },
  { id: 'interaction_rule', label: '互动规则' },
];

function render(ctx, personaFromScreen, memoriesFromScreen) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);
  // 分类 chip 用 primary/tertiary 交替强调
  var catColors = [colors.primary, colors.tertiary, colors.error, colors.secondary];
  var personaState = ctx.useState('character_persona_context', {
    id: String(ctx.getEnv('MEMORY_SYSTEM_ACTIVE_PERSONA_ID') || ''),
    name: String(ctx.getEnv('MEMORY_SYSTEM_ACTIVE_PERSONA_NAME') || ''),
    type: String(ctx.getEnv('MEMORY_SYSTEM_ACTIVE_PERSONA_TYPE') || '')
  });
  // 外部传入的角色上下文优先：screen 根 onLoad 加载后传入，避免依赖子组件副作用
  if (personaFromScreen && (!personaState[0] || !personaState[0].id) && personaFromScreen.id) {
    personaState[1](personaFromScreen);
  }
  var personaId = String((personaState[0] && personaState[0].id) || '');
  var personaName = String((personaState[0] && personaState[0].name) || '');
  var personaType = String((personaState[0] && personaState[0].type) || '');
  var memoriesState = ctx.useState('character_memories', []);
  // 外部传入的角色记忆优先：screen 加载后传入，避免子组件自触发不可靠导致记忆缺失
  if (Array.isArray(memoriesFromScreen) && memoriesFromScreen.length > 0) {
    memoriesState[1](memoriesFromScreen);
  }
  var loadingState = ctx.useState('character_loading', false);
  var loadedForRef = ctx.useRef('character_loaded_for', '');
  var categoryState = ctx.useState('character_category', 'relationship');
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

  async function loadForPersona(targetPersonaId) {
    if (!targetPersonaId) {
      memoriesState[1]([]);
      return;
    }
    loadingState[1](true);
    try {
      var raw = await callToolWithTimeout('memory_engine:list_memories', {
        category: 'character',
        character_id: targetPersonaId,
        limit: 100
      }, 12000);
      var result = parseResult(raw);
      if (result && result.success) {
        memoriesState[1](result.memories || []);
        loadedForRef.current = targetPersonaId;
        retryAtRef.current = 0;
      } else {
        resultState[1]('读取失败：' + ((result && result.message) || '未知错误'));
        retryAtRef.current = Date.now() + 30000;
      }
    } catch (e) {
      resultState[1]('读取失败：' + (e.message || String(e)));
      retryAtRef.current = Date.now() + 30000;
    }
    loadingState[1](false);
  }

  async function loadContext() {
    if (contextLoadingRef.current) return;
    contextLoadingRef.current = true;
    try {
      var raw = await callToolWithTimeout('memory_engine:list_characters', {}, 8000);
      var result = parseResult(raw);
      var chars = result && result.success && result.characters ? result.characters : [];
      // 取第一个角色作为当前角色（Engine 侧 maintain 最近角色）
      var persona = chars.length > 0
        ? { id: String(chars[0].id || ''), name: String(chars[0].name || ''), type: 'character_card' }
        : { id: '', name: '', type: '' };
      personaState[1](persona);
      var nextId = String(persona.id || '');
      if (nextId) {
        // 找到角色后总是重新加载记忆，避免已加载标记导致记忆缺失
        retryAtRef.current = 0;
        await loadForPersona(nextId);
      } else {
        memoriesState[1]([]);
        retryAtRef.current = Date.now() + 30000;
      }
    } catch (e) {
      resultState[1]('角色上下文读取失败：' + (e.message || String(e)));
      retryAtRef.current = Date.now() + 30000;
    } finally {
      contextLoadingRef.current = false;
    }
  }

  async function loadMemories() {
    loadedForRef.current = personaId;
    await loadForPersona(personaId);
  }

  async function createMemory() {
    var title = String(titleState[0] || '').trim();
    var content = String(contentState[0] || '').trim();
    if (!title || !content) {
      resultState[1]('标题和内容不能为空');
      return;
    }
    var category = categoryState[0];
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
      await loadMemories();
    } else resultState[1]((result && result.message) || '创建失败');
  }

  async function deleteMemory(title) {
    // 需要 id 删除；前端只有 title，先查 title 对应的记忆
    var m = memoriesState[0].find(function(x) { return x.title === title; });
    if (!m || !m.id) {
      resultState[1]('未找到该记忆');
      return;
    }
    var raw = await ctx.callTool('memory_engine:delete_memory', { id: m.id });
    var result = parseResult(raw);
    resultState[1](result && result.success ? '已删除' : ((result && result.message) || '删除失败'));
    if (result && result.success) await loadMemories();
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
  loadOnEnter();

  if (!personaId) {
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
      chips.push(UI.FilterChip({
        label: UI.Text({ text: category.label, style: 'labelSmall', color: selected ? colors.primary : colors.onSurfaceVariant }),
        selected: selected,
        onClick: function() { categoryState[1](category.id); }
      }));
    })(CATEGORIES[ci], ci);
  }
  items.push(UI.Row({ fillMaxWidth: true, spacing: 4 }, chips));
  items.push(UI.TextField({ value: titleState[0], onValueChange: titleState[1], placeholder: '标题', singleLine: true }));
  items.push(UI.TextField({ value: contentState[0], onValueChange: contentState[1], placeholder: '明确、可复用的长期记忆' }));
  items.push(UI.Button({ text: '保存到当前角色', onClick: createMemory, fillMaxWidth: true }));
  if (resultState[0]) items.push(UI.Text({ text: resultState[0], style: 'labelSmall', color: colors.onSurfaceVariant }));
  items.push(UI.Spacer({ height: 8 }));
  items.push(UI.Text({ text: loadingState[0] ? '正在读取…' : '角色记忆', style: 'labelMedium', color: colors.onSurface, fontWeight: 'bold' }));

  for (var mi = 0; mi < memoriesState[0].length; mi++) {
    (function(memory) {
      var displayTitle = String(memory.title || '未命名记忆').replace(/^\[persona:[^\]]+\]\s*/, '');
      items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.surface, padding: 10 }, [
        UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
          UI.Column({ weight: 1 }, [
            UI.Text({ text: displayTitle, style: 'bodySmall', color: colors.onSurface, fontWeight: 'bold' }),
            UI.Text({ text: memory.content || '', style: 'labelSmall', color: colors.onSurfaceVariant, maxLines: 3 }),
          ]),
          UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.errorContainer, padding: 5, onClick: function() { deleteMemory(memory.title); } }, [
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

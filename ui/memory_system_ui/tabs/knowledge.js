"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { multiMatch, parseResult } = shared;
const theme = require("../theme");

// ===== Tab 3: 知识 =====
function render(ctx, allData, states, actions, memoryState) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);
  var items = [];
  var allInfo = allData.info || [];
  var allMemories = memoryState || [];
  var memQuery = states.memQuery || '';

  // 筛选信息
  var filteredInfo = allInfo.filter(function(i) {
    if (memQuery && !multiMatch((i.content||'') + ' ' + (i.category||''), memQuery)) return false;
    return true;
  });

  // 筛选记忆
  var filteredMemories = allMemories.filter(function(m) {
    if (memQuery) {
      var searchable = ((m.title || '') + ' ' + (m.content || '')).toLowerCase();
      if (searchable.indexOf(memQuery) < 0) return false;
    }
    return true;
  });

  // 生成删除按钮
  function makeDeleteBtn(category, index, key) {
    var isPending = states.pendingDelete === key;
    return UI.Surface({ shape: { cornerRadius: 4 }, containerColor: isPending ? colors.error : colors.errorContainer, padding: { left: 6, right: 6, top: 2, bottom: 2 }, onClick: function() {
      if (isPending) {
        actions.setPendingDelete('');
        actions.deleteItem(category, index);
      } else {
        actions.setPendingDelete(key);
      }
    } }, [
      UI.Text({ text: isPending ? '确认' : '删除', style: 'labelSmall', color: isPending ? colors.onErrorContainer : colors.error, fontSize: 9, fontWeight: 'bold' }),
    ]);
  }

  // 统计
  items.push(UI.Row({ fillMaxWidth: true, horizontalArrangement: 'spaceEvenly' }, [
    UI.Surface({ shape: { cornerRadius: 10 }, containerColor: colors.errorContainer, padding: { left: 12, right: 12, top: 6, bottom: 6 } }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'info', tint: colors.error, size: 16 }),
        UI.Spacer({ width: 4 }),
        UI.Text({ text: '信息 ' + filteredInfo.length, style: 'labelMedium', color: colors.error, fontWeight: 'bold' }),
      ]),
    ]),
    UI.Surface({ shape: { cornerRadius: 10 }, containerColor: colors.primaryContainer, padding: { left: 12, right: 12, top: 6, bottom: 6 } }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'auto_awesome', tint: colors.primary, size: 16 }),
        UI.Spacer({ width: 4 }),
        UI.Text({ text: '记忆 ' + filteredMemories.length, style: 'labelMedium', color: colors.primary, fontWeight: 'bold' }),
      ]),
    ]),
  ]));
  items.push(UI.Spacer({ height: 8 }));

  // 信息列表
  if (filteredInfo.length > 0) {
    items.push(UI.Text({ text: '信息', style: 'labelMedium', fontWeight: 'bold', color: colors.error }));
    items.push(UI.Spacer({ height: 4 }));
    for (var kii = 0; kii < filteredInfo.length; kii++) {
      (function(inf, iIdx) {
        items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.errorContainer, alpha: 0.5, padding: 10 }, [
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.error, alpha: 0.15, padding: { left: 6, right: 6, top: 2, bottom: 2 } }, [
              UI.Text({ text: inf.category || '其他', style: 'labelSmall', color: colors.error, fontSize: 10 }),
            ]),
            UI.Spacer({ width: 8 }),
            UI.Column({ weight: 1 }, [UI.Text({ text: inf.content || '', style: 'bodySmall', color: colors.onSurface, maxLines: 3 })]),
            makeDeleteBtn('info', allInfo.indexOf(inf), 'info:' + allInfo.indexOf(inf)),
          ]),
        ]));
        items.push(UI.Spacer({ height: 3 }));
      })(filteredInfo[kii], kii);
    }
    items.push(UI.Spacer({ height: 6 }));
  }

  // 记忆列表
  if (filteredMemories.length > 0) {
    items.push(UI.Text({ text: '记忆', style: 'labelMedium', fontWeight: 'bold', color: colors.primary }));
    items.push(UI.Spacer({ height: 4 }));

    for (var mii = 0; mii < filteredMemories.length; mii++) {
      (function(m, idx) {
        var isQA = m.type === 'qa';
        var preview = (m.content || m.title || '').substring(0, 60) + ((m.content || m.title || '').length > 60 ? '...' : '');
        var dateStr = m.timestamp ? new Date(m.timestamp).toLocaleDateString('zh-CN') : '';
        var typeColor = isQA ? colors.primary : colors.error;
        var typeBg = isQA ? colors.primaryContainer : colors.errorContainer;
        items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceVariant, padding: 10 }, [
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Surface({ width: 32, height: 32, shape: { cornerRadius: 16 }, containerColor: typeColor }, [
              UI.Row({ fillMaxWidth: true, height: 32, horizontalArrangement: 'center', verticalAlignment: 'center' }, [
                UI.Icon({ name: isQA ? 'question_answer' : 'bookmark', tint: colors.onPrimary, size: 16 }),
              ]),
            ]),
            UI.Spacer({ width: 8 }),
            UI.Column({ weight: 1 }, [
              UI.Text({ text: preview, style: 'bodySmall', fontWeight: 'bold', color: colors.onSurface, maxLines: 1 }),
              UI.Row({}, [
                UI.Surface({ shape: { cornerRadius: 4 }, containerColor: typeBg, padding: { left: 4, right: 4, top: 1, bottom: 1 } }, [
                  UI.Text({ text: isQA ? '摘要' : '手动', style: 'labelSmall', color: typeColor, fontSize: 9 }),
                ]),
                UI.Spacer({ width: 4 }),
                dateStr ? UI.Text({ text: dateStr, style: 'labelSmall', color: colors.outlineVariant, fontSize: 9 }) : null,
              ].filter(Boolean)),
            ]),
          ]),
        ]));
        items.push(UI.Spacer({ height: 3 }));
      })(filteredMemories[mii], mii);
    }
  }

  if (filteredInfo.length === 0 && filteredMemories.length === 0) {
    items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 32 }, [
      UI.Icon({ name: 'menu_book', tint: colors.outlineVariant, size: 40 }),
      UI.Spacer({ height: 12 }),
      UI.Text({ text: '暂无知识和记忆', style: 'bodyMedium', color: colors.outline }),
    ]));
  }

  return items;
}

exports.render = render;

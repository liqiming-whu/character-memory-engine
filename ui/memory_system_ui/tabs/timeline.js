"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { getTypeColor, getTypeIcon, inDateRange, multiMatch, pad2 } = shared;
const theme = require("../theme");

// ===== Tab 2: 时间线 =====
function render(ctx, allData, states, actions) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);
  var items = [];
  var allEvents = allData.events || [];
  var allFinance = allData.finance || [];
  var allMenstrual = allData.menstrual || [];
  var q = states.query || '';
  var dateStart = states.dateStart || '';
  var dateEnd = states.dateEnd || '';
  var filterType = states.filterType || '';

  // 筛选事件
  var filteredEvents = allEvents.filter(function(e) {
    if (!inDateRange(e.timestamp || e.date, dateStart, dateEnd)) return false;
    if (filterType && e.type !== filterType && filterType !== 'expense' && filterType !== 'income' && filterType !== 'menstrual') return false;
    if (filterType === 'expense' || filterType === 'income' || filterType === 'menstrual') return false;
    if (!multiMatch((e.title||'') + ' ' + (e.description||''), q)) return false;
    return true;
  });

  // 筛选财务
  var filteredFinance = allFinance.filter(function(f) {
    if (!inDateRange(f.timestamp || f.date, dateStart, dateEnd)) return false;
    if (filterType && filterType !== f.type) return false;
    if (!multiMatch((f.description||'') + ' ' + (f.category||''), q)) return false;
    return true;
  });

  // 筛选经期
  var filteredMenstrual = allMenstrual.filter(function(m) {
    if (!multiMatch((m.startDate||'') + ' ' + (m.symptoms||''), q)) return false;
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

  var timelineItems = [];

  // 事件
  for (var tei = 0; tei < filteredEvents.length; tei++) {
    (function(e, idx) {
      timelineItems.push({
        sortDate: e.date || (e.timestamp ? e.timestamp.substring(0,10) : ''),
        render: UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: getTypeColor(e.type), alpha: 0.08, padding: 8 }, [
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Icon({ name: getTypeIcon(e.type), tint: getTypeColor(e.type), size: 16 }),
            UI.Spacer({ width: 6 }),
            UI.Column({ weight: 1 }, [
              UI.Text({ text: e.title || '未命名', style: 'bodySmall', fontWeight: 'bold', color: colors.onSurface }),
              e.description ? UI.Text({ text: e.description, style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 11, maxLines: 2 }) : null,
            ].filter(Boolean)),
            e.date ? UI.Text({ text: e.date, style: 'labelSmall', color: colors.outline, fontSize: 9 }) : null,
            makeDeleteBtn('events', allEvents.indexOf(e), 'events:' + allEvents.indexOf(e)),
          ].filter(Boolean)),
        ])
      });
    })(filteredEvents[tei], tei);
  }

  // 财务
  for (var tfi = 0; tfi < filteredFinance.length; tfi++) {
    (function(f, idx) {
      var isIncome = f.type === 'income';
      var amtColor = isIncome ? colors.primary : colors.error;
      var amt = parseFloat(f.amount) || 0;
      timelineItems.push({
        sortDate: f.date || (f.timestamp ? f.timestamp.substring(0,10) : ''),
        render: UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: amtColor, alpha: 0.08, padding: 8 }, [
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Icon({ name: isIncome ? 'add_circle' : 'remove_circle', tint: amtColor, size: 16 }),
            UI.Spacer({ width: 6 }),
            UI.Column({ weight: 1 }, [
              UI.Text({ text: f.description || f.category || '', style: 'bodySmall', fontWeight: 'bold', color: colors.onSurface, maxLines: 1 }),
              UI.Surface({ shape: { cornerRadius: 4 }, containerColor: isIncome ? colors.primaryContainer : colors.errorContainer, padding: { left: 4, right: 4, top: 1, bottom: 1 }, margin: { top: 2 } }, [
                UI.Text({ text: f.category || (isIncome ? '收入' : '支出'), style: 'labelSmall', color: amtColor, fontSize: 9 }),
              ]),
            ].filter(Boolean)),
            UI.Text({ text: (isIncome ? '+' : '-') + '¥' + amt.toFixed(0), style: 'titleSmall', fontWeight: 'bold', color: amtColor }),
            makeDeleteBtn('finance', allFinance.indexOf(f), 'finance:' + allFinance.indexOf(f)),
          ]),
        ])
      });
    })(filteredFinance[tfi], tfi);
  }

  // 经期
  for (var tmi = 0; tmi < filteredMenstrual.length; tmi++) {
    (function(m, idx) {
      var sp = m.startDate.split('-');
      var ep = m.endDate ? m.endDate.split('-') : null;
      timelineItems.push({
        sortDate: m.startDate,
        render: UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.tertiaryContainer, padding: 8 }, [
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Icon({ name: 'favorite', tint: colors.tertiary, size: 16 }),
            UI.Spacer({ width: 6 }),
            UI.Column({ weight: 1 }, [
              UI.Text({ text: '经期 ' + parseInt(sp[1]) + '/' + parseInt(sp[2]) + (ep ? ' - ' + parseInt(ep[1]) + '/' + parseInt(ep[2]) : ''), style: 'bodySmall', fontWeight: 'bold', color: colors.onSurface }),
              m.symptoms ? UI.Text({ text: m.symptoms, style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) : null,
            ].filter(Boolean)),
            UI.Surface({ shape: { cornerRadius: 4 }, containerColor: ep ? colors.primaryContainer : colors.tertiaryContainer, padding: { left: 4, right: 4, top: 1, bottom: 1 } }, [
              UI.Text({ text: ep ? '已完成' : '进行中', style: 'labelSmall', color: ep ? colors.primary : colors.tertiary, fontSize: 9 }),
            ]),
            makeDeleteBtn('menstrual', allMenstrual.indexOf(m), 'menstrual:' + allMenstrual.indexOf(m)),
          ].filter(Boolean)),
        ])
      });
    })(filteredMenstrual[tmi], tmi);
  }

  // 按时间排序
  timelineItems.sort(function(a, b) { return (b.sortDate || '').localeCompare(a.sortDate || ''); });

  if (timelineItems.length === 0) {
    items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 24 }, [
      UI.Icon({ name: 'timeline', tint: colors.outlineVariant, size: 40 }),
      UI.Spacer({ height: 10 }),
      UI.Text({ text: '暂无时间线记录', style: 'bodyMedium', color: colors.outline }),
    ]));
  } else {
    for (var tli = 0; tli < timelineItems.length; tli++) {
      items.push(timelineItems[tli].render);
      items.push(UI.Spacer({ height: 3 }));
    }
  }

  return items;
}

exports.render = render;

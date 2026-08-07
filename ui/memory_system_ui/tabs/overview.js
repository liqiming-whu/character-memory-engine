"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { getTypeColor, getTypeIcon, pad2 } = shared;
const theme = require("../theme");

// ===== Tab 0: 概览 =====
function render(ctx, allData, actions) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);
  var items = [];
  var allTodos = allData.todos || [];
  var allEvents = allData.events || [];
  var allFinance = allData.finance || [];
  var allMenstrual = allData.menstrual || [];

  // 待办摘要
  var todayPending = allTodos.filter(function(t) { return !t.completed; });
  var ovTodoItems = [UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.errorContainer, padding: 14 }, [
    UI.Row({ verticalAlignment: 'center' }, [
      UI.Icon({ name: 'checklist', tint: colors.error, size: 28 }),
      UI.Spacer({ width: 10 }),
      UI.Column({}, [
        UI.Text({ text: '待办事项', style: 'titleMedium', fontWeight: 'bold', color: colors.error }),
        UI.Text({ text: todayPending.length + ' 项待完成', style: 'bodySmall', color: colors.onSurfaceVariant }),
      ]),
    ]),
    UI.Spacer({ height: 8 }),
  ])];

  for (var oti = 0; oti < Math.min(todayPending.length, 3); oti++) {
    (function(todo, idx) {
      var priColor = todo.priority === 'high' ? colors.error : todo.priority === 'medium' ? colors.tertiary : colors.primary;
      ovTodoItems.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.surface, padding: 8 }, [
        UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
          UI.Icon({ name: 'radio_button_unchecked', tint: colors.error, size: 16 }),
          UI.Spacer({ width: 8 }),
          UI.Text({ text: todo.title || '未命名', style: 'bodySmall', color: colors.onSurface, weight: 1 }),
          UI.Surface({ shape: { cornerRadius: 4 }, containerColor: priColor, alpha: 0.15, padding: { left: 4, right: 4, top: 1, bottom: 1 } }, [
            UI.Text({ text: todo.priority === 'high' ? '高' : todo.priority === 'medium' ? '中' : '低', style: 'labelSmall', color: priColor, fontSize: 9 }),
          ]),
        ]),
      ]));
    })(todayPending[oti], oti);
  }
  if (todayPending.length > 3) {
    ovTodoItems.push(UI.Text({ text: '... 还有 ' + (todayPending.length - 3) + ' 项', style: 'labelSmall', color: colors.outline, fontSize: 10 }));
  }
  if (todayPending.length > 0) {
    ovTodoItems.push(UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.error, alpha: 0.1, padding: { left: 10, right: 10, top: 4, bottom: 4 }, fillMaxWidth: true, onClick: function() { if (actions && actions.onOpenTodos) actions.onOpenTodos(); } }, [
      UI.Row({ fillMaxWidth: true, horizontalArrangement: 'center' }, [
        UI.Text({ text: '查看全部待办', style: 'labelSmall', color: colors.error, fontWeight: 'bold' }),
      ]),
    ]));
  }
  items.push(UI.Column({}, ovTodoItems));
  items.push(UI.Spacer({ height: 8 }));

  // 最近事件
  var recentEvents = allEvents.slice(-5).reverse();
  var ovEvtItems = [UI.Row({ verticalAlignment: 'center' }, [
    UI.Icon({ name: 'event', tint: colors.primary, size: 28 }),
    UI.Spacer({ width: 10 }),
    UI.Column({}, [
      UI.Text({ text: '最近事件', style: 'titleMedium', fontWeight: 'bold', color: colors.primary }),
      UI.Text({ text: allEvents.length + ' 条记录', style: 'bodySmall', color: colors.onSurfaceVariant }),
    ]),
  ])];
  for (var oei = 0; oei < recentEvents.length; oei++) {
    (function(e, idx) {
      var color = getTypeColor(e.type);
      ovEvtItems.push(UI.Spacer({ height: 4 }));
      ovEvtItems.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 6 }, containerColor: colors.surface, padding: 6 }, [
        UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
          UI.Icon({ name: getTypeIcon(e.type), tint: color, size: 14 }),
          UI.Spacer({ width: 6 }),
          UI.Text({ text: e.title || '未命名', style: 'bodySmall', color: colors.onSurface, weight: 1, maxLines: 1 }),
          e.date ? UI.Text({ text: e.date, style: 'labelSmall', color: colors.outline, fontSize: 9 }) : null,
        ].filter(Boolean)),
      ]));
    })(recentEvents[oei], oei);
  }
  if (recentEvents.length === 0) {
    ovEvtItems.push(UI.Spacer({ height: 4 }));
    ovEvtItems.push(UI.Text({ text: '暂无事件', style: 'bodySmall', color: colors.outline }));
  }
  items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 14 }, containerColor: colors.primaryContainer, padding: 16 }, [UI.Column({}, ovEvtItems)]));
  items.push(UI.Spacer({ height: 10 }));

  // 财务概况
  var totalExpense = 0, totalIncome = 0;
  for (var fi2 = 0; fi2 < allFinance.length; fi2++) {
    var amt2 = parseFloat(allFinance[fi2].amount) || 0;
    if (allFinance[fi2].type === 'income') totalIncome += amt2;
    else totalExpense += amt2;
  }
  items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 14 }, containerColor: colors.tertiaryContainer, padding: 16 }, [
    UI.Column({ fillMaxWidth: true }, [
      UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
        UI.Surface({ width: 40, height: 40, shape: { cornerRadius: 12 }, containerColor: colors.tertiaryContainer }, [
          UI.Row({ fillMaxWidth: true, fillMaxHeight: true, horizontalArrangement: 'center', verticalAlignment: 'center' }, [
            UI.Icon({ name: 'account_balance_wallet', tint: colors.tertiary, size: 24 }),
          ]),
        ]),
        UI.Spacer({ width: 12 }),
        UI.Column({ weight: 1 }, [
          UI.Text({ text: '财务概况', style: 'titleMedium', fontWeight: 'bold', color: colors.tertiary }),
          UI.Text({ text: allFinance.length + ' 笔收支记录', style: 'bodySmall', color: colors.onSurfaceVariant }),
        ]),
      ]),
      UI.Spacer({ height: 14 }),
      UI.Row({ fillMaxWidth: true, horizontalArrangement: 'spaceBetween' }, [
        UI.Column({ weight: 1, horizontalAlignment: 'center' }, [
          UI.Text({ text: '¥' + totalExpense.toFixed(0), style: 'titleMedium', fontWeight: 'bold', color: colors.error }),
          UI.Text({ text: '支出', style: 'labelSmall', color: colors.onSurfaceVariant }),
        ]),
        UI.Column({ weight: 1, horizontalAlignment: 'center' }, [
          UI.Text({ text: '¥' + totalIncome.toFixed(0), style: 'titleMedium', fontWeight: 'bold', color: colors.primary }),
          UI.Text({ text: '收入', style: 'labelSmall', color: colors.onSurfaceVariant }),
        ]),
        UI.Column({ weight: 1, horizontalAlignment: 'center' }, [
          UI.Text({ text: '¥' + (totalIncome - totalExpense).toFixed(0), style: 'titleMedium', fontWeight: 'bold', color: (totalIncome - totalExpense) >= 0 ? colors.primary : colors.error }),
          UI.Text({ text: '净额', style: 'labelSmall', color: colors.onSurfaceVariant }),
        ]),
      ]),
    ]),
  ]));
  items.push(UI.Spacer({ height: 10 }));

  // 经期预测
  if (allMenstrual.length > 0) {
    var avgCycle = 28;
    if (allMenstrual.length >= 2) {
      var cycles = [];
      for (var mci = 1; mci < allMenstrual.length; mci++) {
        cycles.push(Math.round((new Date(allMenstrual[mci].startDate) - new Date(allMenstrual[mci-1].startDate)) / 86400000));
      }
      avgCycle = Math.round(cycles.reduce(function(s,c){return s+c;},0) / cycles.length);
    }
    var lastM = allMenstrual[allMenstrual.length - 1];
    var lastStart = new Date(lastM.startDate);
    var nextStart = new Date(lastStart.getTime() + avgCycle * 86400000);
    var daysUntil = Math.round((nextStart - new Date()) / 86400000);
    var phaseText = daysUntil <= 0 ? '可能经期中' : daysUntil <= 7 ? '邻近经期' : '安全期';
    var phaseColor = daysUntil <= 0 ? colors.error : daysUntil <= 7 ? colors.tertiary : colors.primary;
    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.tertiaryContainer, padding: 14 }, [
      UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
        UI.Icon({ name: 'favorite', tint: colors.tertiary, size: 28 }),
        UI.Spacer({ width: 10 }),
        UI.Column({ weight: 1 }, [
          UI.Text({ text: '经期追踪', style: 'titleMedium', fontWeight: 'bold', color: colors.tertiary }),
          UI.Text({ text: '约 ' + daysUntil + ' 天后 (' + (nextStart.getMonth()+1) + '/' + nextStart.getDate() + ')', style: 'bodySmall', color: colors.onSurfaceVariant }),
        ]),
        UI.Surface({ shape: { cornerRadius: 8 }, containerColor: phaseColor, alpha: 0.2, padding: { left: 10, right: 10, top: 4, bottom: 4 } }, [
          UI.Text({ text: phaseText, style: 'labelSmall', fontWeight: 'bold', color: phaseColor }),
        ]),
      ]),
    ]));
  }

  return items;
}

exports.render = render;

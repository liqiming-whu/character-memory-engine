"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { multiMatch, parseResult } = shared;
const theme = require("../theme");

// ===== Tab 1: 待办 =====
function render(ctx, allData, states, actions) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);
  var items = [];
  var allTodos = allData.todos || [];
  var q = states.query || '';
  var filterType = states.filterType || '';

  // 筛选
  var filteredTodos = allTodos.filter(function(t) {
    if (filterType === 'pending' && t.completed) return false;
    if (filterType === 'completed' && !t.completed) return false;
    if (!multiMatch((t.title||'') + ' ' + (t.description||''), q)) return false;
    return true;
  });

  var pendingTodos = filteredTodos.filter(function(t) { return !t.completed; });
  var completedTodos = filteredTodos.filter(function(t) { return t.completed; });

  // 切换待办
  async function toggleTodoItem(idx) {
    try {
      var raw = await ctx.callTool('memory_system:toggle_todo', { todo_index: idx });
      if (parseResult(raw) && parseResult(raw).success) {
        await actions.loadData();
      }
    } catch(e) {}
  }

  // 删除
  async function deleteItem(category, index) {
    try {
      var raw = await ctx.callTool('memory_system:sync_to_env', { action: 'delete', category: category, index: String(index) });
      if (parseResult(raw) && parseResult(raw).success) {
        await actions.loadData();
        actions.setResult('✅ 已删除');
      }
    } catch(e) {
      actions.setResult('❌ ' + (e.message || String(e)));
    }
  }

  // 生成删除按钮
  function makeDeleteBtn(category, index, pendingKey) {
    var isPending = states.pendingDelete === pendingKey;
    return UI.Surface({ shape: { cornerRadius: 4 }, containerColor: isPending ? colors.error : colors.errorContainer, padding: { left: 6, right: 6, top: 2, bottom: 2 }, onClick: function() {
      if (isPending) {
        actions.setPendingDelete('');
        deleteItem(category, index);
      } else {
        actions.setPendingDelete(pendingKey);
      }
    } }, [
      UI.Text({ text: isPending ? '确认' : '删除', style: 'labelSmall', color: isPending ? colors.onErrorContainer : colors.error, fontSize: 9, fontWeight: 'bold' }),
    ]);
  }

  // 统计卡片
  items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.errorContainer, padding: 14 }, [
    UI.Row({ fillMaxWidth: true, horizontalArrangement: 'spaceBetween', verticalAlignment: 'center' }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'checklist', tint: colors.error, size: 28 }),
        UI.Spacer({ width: 10 }),
        UI.Column({}, [
          UI.Text({ text: pendingTodos.length + ' 项待完成', style: 'titleMedium', fontWeight: 'bold', color: colors.error }),
          UI.Text({ text: '共 ' + filteredTodos.length + ' 项', style: 'bodySmall', color: colors.onSurfaceVariant }),
        ]),
      ]),
      UI.Column({ horizontalAlignment: 'center' }, [
        UI.Text({ text: filteredTodos.length > 0 ? Math.round(completedTodos.length / filteredTodos.length * 100) + '%' : '0%', style: 'titleMedium', fontWeight: 'bold', color: colors.primary }),
        UI.Text({ text: '完成率', style: 'labelSmall', color: colors.onSurfaceVariant }),
      ]),
    ]),
  ]));
  items.push(UI.Spacer({ height: 8 }));

  // 待完成列表
  if (pendingTodos.length > 0) {
    var pendingItems = [];
    for (var tpi = 0; tpi < pendingTodos.length; tpi++) {
      (function(todo, tIdx) {
        var priColor = todo.priority === 'high' ? colors.error : todo.priority === 'medium' ? colors.tertiary : colors.primary;
        var priText = todo.priority === 'high' ? '高' : todo.priority === 'medium' ? '中' : '低';
        var realIdx = allTodos.indexOf(todo);
        var key = 'todos:' + realIdx;
        pendingItems.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.surfaceVariant, padding: 8 }, [
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Surface({ width: 22, height: 22, shape: { cornerRadius: 11 }, containerColor: colors.surface, border: { width: 2, color: colors.error }, onClick: function() { toggleTodoItem(realIdx); } }, []),
            UI.Spacer({ width: 8 }),
            UI.Column({ weight: 1 }, [
              UI.Text({ text: todo.title || '未命名', style: 'bodySmall', fontWeight: 'bold', color: colors.onSurface, maxLines: 1 }),
              UI.Row({}, [
                UI.Surface({ shape: { cornerRadius: 4 }, containerColor: priColor, alpha: 0.15, padding: { left: 4, right: 4, top: 1, bottom: 1 } }, [
                  UI.Text({ text: priText, style: 'labelSmall', color: priColor, fontSize: 9 }),
                ]),
                todo.dueDate ? UI.Text({ text: ' 截止 ' + todo.dueDate, style: 'labelSmall', color: colors.outline, fontSize: 9 }) : null,
              ].filter(Boolean)),
            ]),
            makeDeleteBtn('todos', realIdx, key),
          ]),
        ]));
        pendingItems.push(UI.Spacer({ height: 3 }));
      })(pendingTodos[tpi], tpi);
    }
    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceVariant, padding: 10 }, [
      UI.Column({}, [UI.Row({ verticalAlignment: 'center' }, [UI.Icon({ name: 'pending_actions', tint: colors.error, size: 18 }), UI.Spacer({ width: 6 }), UI.Text({ text: '待完成', style: 'titleSmall', fontWeight: 'bold', color: colors.error })]), UI.Spacer({ height: 6 })].concat(pendingItems)),
    ]));
    items.push(UI.Spacer({ height: 8 }));
  }

  // 已完成列表
  if (completedTodos.length > 0) {
    var doneItems = [];
    for (var tdi = 0; tdi < completedTodos.length; tdi++) {
      (function(todo, tIdx) {
        var realIdx = allTodos.indexOf(todo);
        var key = 'todos:' + realIdx;
        doneItems.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.primaryContainer, alpha: 0.5, padding: 8 }, [
          UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Surface({ width: 22, height: 22, shape: { cornerRadius: 11 }, containerColor: colors.primary, onClick: function() { toggleTodoItem(realIdx); } }, [
              UI.Row({ fillMaxWidth: true, height: 22, horizontalArrangement: 'center', verticalAlignment: 'center' }, [UI.Icon({ name: 'check', tint: colors.onPrimary, size: 14 })]),
            ]),
            UI.Spacer({ width: 8 }),
            UI.Text({ text: todo.title || '未命名', style: 'bodySmall', color: colors.outline, maxLines: 1, textDecorationLine: 'lineThrough' }),
            makeDeleteBtn('todos', realIdx, key),
          ]),
        ]));
        doneItems.push(UI.Spacer({ height: 3 }));
      })(completedTodos[tdi], tdi);
    }
    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceVariant, padding: 10 }, [
      UI.Column({}, [UI.Row({ verticalAlignment: 'center' }, [UI.Icon({ name: 'task_alt', tint: colors.primary, size: 18 }), UI.Spacer({ width: 6 }), UI.Text({ text: '已完成', style: 'titleSmall', fontWeight: 'bold', color: colors.primary })]), UI.Spacer({ height: 6 })].concat(doneItems)),
    ]));
  }

  if (filteredTodos.length === 0) {
    items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 24 }, [
      UI.Icon({ name: 'checklist', tint: colors.outlineVariant, size: 40 }),
      UI.Spacer({ height: 10 }),
      UI.Text({ text: '暂无待办事项', style: 'bodyMedium', color: colors.outline }),
    ]));
  }

  return items;
}

exports.render = render;

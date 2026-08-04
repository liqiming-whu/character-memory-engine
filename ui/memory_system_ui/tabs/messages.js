"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { parseResult } = shared;
const theme = require("../theme");

// ===== Token 估算（简单字符数估算，中文约2字符/词）=====
// 默认64k上下文，80%用于消息内容（留空间给prompt和响应）
var TOKEN_LIMIT_PER_ANALYSIS = Math.floor(64 * 1024 * 0.8); // ~51200 tokens

function estimateTokens(text) {
  if (!text) return 0;
  // 简单估算：中文按2字符=1token，英文按4字符=1token
  var chineseChars = (text.match(/[一-龥]/g) || []).length;
  var otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 2) + Math.ceil(otherChars / 4);
}

function formatTokens(tokens) {
  if (tokens < 1000) return tokens + '';
  return (tokens / 1000).toFixed(1) + 'k';
}

// ===== Tab 5: 消息（无限加载模式）=====
function render(ctx, allData, states, actions) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);
  var items = [];

  // 状态
  var chatsState = states.chats || [];
  var selectedChatState = states.selectedChat || null;
  var chatDetailState = states.chatDetail || null;
  var loadingChatsState = states.loadingChats || false;
  var loadingDetailState = states.loadingDetail || false;
  var msgQuery = states.msgQuery || '';
  var selectedMessagesState = states.selectedMessages || []; // 多选的消息索引

  // 无限加载专用状态（首次加载20条，后续每次加载20条）
  var hasMoreState = states.hasMore !== undefined ? states.hasMore : true;
  var offsetState = states.offset || 0;
  var searchQuery = states.msgQuery || '';
  // 后端真实对话总数（来自 list_chats_brief.data.totalCount）
  // 这是"实际拉取数量"——不会因为前端 [concat] 而变，是数据库里真实存在的对话数
  var totalChats = states.totalChats || 0;

  // 搜索过滤（在已有列表上过滤）
  var filteredChats = chatsState;
  if (searchQuery) {
    filteredChats = chatsState.filter(function(c) {
      var title = (c.title || '').toLowerCase();
      return title.indexOf(searchQuery.toLowerCase()) >= 0;
    });
  }

  // ===== 加载初始对话列表 =====
// 协调机制：screen.js 顶层已经主动发起了 list_chats_brief 并把结果写进了 chatsState。
// 这里如果检测到 screen 已经处理过（通过 env 标记），就不再触发二次加载。
// 这避免了"重置 0 + 立即重新拉 20"的重复请求，也防止滚动到底后 offset 错乱。
var msgsLoadedByEnter = false;
try {
msgsLoadedByEnter = ctx.getEnv('MEMORY_SYSTEM_MSGS_ENTER_LOADED') === '1';
} catch(__eEnter) {}
if (chatsState.length === 0 && !loadingChatsState && !msgsLoadedByEnter) {
    actions.setLoadingChats(true);
    actions.setHasMore(true);
    actions.setOffset(0);
    (async function() {
      try {
        var raw = await ctx.callTool('chat_exporter:list_chats_brief', {
          limit: 200,
          sort_order: 'desc'
        });
        var r = parseResult(raw);
        if (r && r.success && r.data && r.data.chats) {
          actions.setChats(r.data.chats);
          actions.setHasMore(r.data.chats.length >= 200);
          actions.setOffset(r.data.chats.length);
          // 把后端真实总数写进状态，供顶部显示
          if (actions.setTotalChats && r.data.totalCount !== undefined) {
            actions.setTotalChats(r.data.totalCount);
          }
          try { ctx.setEnv('MEMORY_SYSTEM_MSGS_ENTER_LOADED', '1'); } catch(__eSet) {}
        } else {
          actions.setHasMore(false);
        }
      } catch(e) {
        actions.setHasMore(false);
      }
      actions.setLoadingChats(false);
    })();
  }

  // ===== 加载更多对话（无限滚动）=====
// 注意：chat_exporter 底层的 Tools.Chat.listChats 不支持 offset 分页，
// 每次调用都返回数据库里前 limit 条同样的对话。
// 因此"加载更多"实际只是再拉一次然后做去重合并，不会真正分页。
// 真正的进度通过 list_chats_brief 返回的 totalCount 显示给用户。
var loadMoreRef = ctx.useRef('loadMore', false);
var loadMoreGuardRef = ctx.useRef('lastLoadedAt', 0);
function handleLoadMore() {
if (loadingChatsState || !hasMoreState || searchQuery) return;
if (loadMoreRef.current) return;
// 防御性 200ms 内的重复触发——避免 screen 刷新和滚动回调同时撞车
var _now = Date.now();
if (_now - (loadMoreGuardRef.current || 0) < 200) return;
loadMoreRef.current = true;
loadMoreGuardRef.current = _now;

actions.setLoadingChats(true);
(async function() {
try {
// 这里不用 limit/offset，因为 listChat 不支持 offset。
// 拉到的是全量前 N 条，再做去重合并。
var raw = await ctx.callTool('chat_exporter:list_chats_brief', {
limit: 200,
sort_order: 'desc'
});
var r = parseResult(raw);
if (r && r.success && r.data && r.data.chats) {
var fetchedChats = r.data.chats || [];
// 同步后端真实总数（如果还没拿到的话）
if (actions.setTotalChats && r.data.totalCount !== undefined) {
actions.setTotalChats(r.data.totalCount);
}
// 去重合并：以 chatId 为键，已存在的不重复加入
var existingIds = {};
chatsState.forEach(function(c) { if (c && c.chatId) existingIds[c.chatId] = true; });
var newUnique = fetchedChats.filter(function(c) { return c && c.chatId && !existingIds[c.chatId]; });
if (newUnique.length > 0) {
actions.setChats([...chatsState, ...newUnique]);
}
// 只要拉到的批次 size 达到 limit，就视为"还有更多"，等用户再点
actions.setOffset(chatsState.length + newUnique.length);
actions.setHasMore(fetchedChats.length >= 200);
} else {
actions.setHasMore(false);
}
} catch(e) {
actions.setHasMore(false);
}
actions.setLoadingChats(false);
loadMoreRef.current = false;
})();
}

  // ===== 加载选中对话的详情（无限加载消息）=====
  if (selectedChatState && !chatDetailState && !loadingDetailState) {
    actions.setLoadingDetail(true);
    (async function() {
      try {
        var raw = await ctx.callTool('chat_exporter:export_single_chat', {
          chat_id: selectedChatState.chatId,
          max_messages: 200,
          include_meta: true,
          format: 'plain'
        });
        var r = parseResult(raw);
        if (r && r.success && r.data) {
          actions.setChatDetail(r.data);
        }
      } catch(e) {}
      actions.setLoadingDetail(false);
    })();
  }

  // ===== 消息Tab内容 =====

  // Token限制说明（顶部固定显示）
  items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.errorContainer, padding: { left: 10, right: 10, top: 6, bottom: 6 } }, [
    UI.Row({ verticalAlignment: 'center' }, [
      UI.Icon({ name: 'info', tint: colors.error, size: 14 }),
      UI.Spacer({ width: 6 }),
      UI.Text({ text: '每批Token限制: ~' + formatTokens(TOKEN_LIMIT_PER_ANALYSIS) + ' (上下文64k×80%) | 超出自动分批', style: 'labelSmall', color: colors.error }),
    ]),
  ]));
  items.push(UI.Spacer({ height: 8 }));

  // 搜索栏
  items.push(UI.Surface({ shape: { cornerRadius: 10 }, containerColor: colors.surfaceVariant, padding: { left: 10, right: 10, top: 4, bottom: 4 }, fillMaxWidth: true }, [
    UI.Row({ verticalAlignment: 'center' }, [
      UI.Icon({ name: 'search', tint: colors.outline, size: 16 }),
      UI.Spacer({ width: 6 }),
      UI.TextField({ value: searchQuery, onValueChange: function(v) {
        actions.setMsgQuery(v);
      }, placeholder: '搜索对话...', weight: 1, singleLine: true }),
      searchQuery ? UI.Icon({ name: 'close', tint: colors.outline, size: 16, onClick: function() { actions.setMsgQuery(''); } }) : null,
    ].filter(Boolean)),
  ]));
  items.push(UI.Spacer({ height: 8 }));

  // 统计卡片
// "实际拉取数量" = 数据库真实对话总数（不受前端分页影响）
// "当前显示"    = 列表里实际渲染的对话数
var totalLabel = totalChats > 0 ? totalChats : chatsState.length;
var displayCount = searchQuery ? filteredChats.length : chatsState.length;
// 显示策略：有 totalChats（来自后端实际总数）显示"已加载 N / 共 M"；
//         没 totalChats（兜底）显示"已加载 N"
var statusText;
if (totalChats > 0) {
  var _more = hasMoreState && chatsState.length < totalChats;
  var _done = chatsState.length >= totalChats;
  var _suffix = _more ? '（下拉加载更多）' : (_done ? '（已全部加载）' : '');
  statusText = '已加载 ' + chatsState.length + ' / 共 ' + totalChats + ' 个对话' + _suffix;
} else {
  statusText = searchQuery
    ? '搜索到 ' + displayCount + ' 个对话'
    : '已加载 ' + displayCount + ' 个对话' + (hasMoreState ? '（下拉加载更多）' : '（已全部加载）');
}
items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.tertiaryContainer, padding: 14 }, [
  UI.Row({ verticalAlignment: 'center' }, [
    UI.Icon({ name: 'chat', tint: colors.tertiary, size: 28 }),
    UI.Spacer({ width: 10 }),
    UI.Column({}, [
      UI.Text({ text: '消息记录', style: 'titleMedium', fontWeight: 'bold', color: colors.tertiary }),
      UI.Text({ text: statusText, style: 'bodySmall', color: colors.onSurfaceVariant }),
    ]),
  ]),
]));
  items.push(UI.Spacer({ height: 8 }));

  // 加载中（初始加载）
  if (loadingChatsState && chatsState.length === 0) {
    items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 32 }, [
      UI.Text({ text: '⏳ 加载中...', style: 'bodyMedium', color: colors.outline }),
    ]));
    return items;
  }

  // ===== 对话详情面板 =====
  if (selectedChatState) {
    var chat = selectedChatState;

    // 定义分析函数
    var analyzeChat = function() {
      var targetChatId = chat.chatId;
      (function() {
        var _asyncAnalyze = function() {
          if (actions.setLoading) actions.setLoading(true);
          ctx.callTool('memory_system:analyze_saved_messages', { chat_id: targetChatId }).then(function(raw) {
            var r = parseResult(raw);
            if (r && r.success) {
              if (actions.showToast) actions.showToast('分析完成！');
            } else {
              if (actions.showToast) actions.showToast('分析失败: ' + (r ? r.message : '未知错误'));
            }
            if (actions.setLoading) actions.setLoading(false);
          }).catch(function(e) {
            if (actions.showToast) actions.showToast('分析出错');
            if (actions.setLoading) actions.setLoading(false);
          });
        };
        _asyncAnalyze();
      })();
    };

    // 返回按钮
    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.tertiary, padding: 10, onClick: function() {
      actions.setSelectedChat(null);
      actions.setChatDetail(null);
      actions.setSelectedMessages([]);
    }}, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'arrow_back', tint: colors.onPrimary, size: 18 }),
        UI.Spacer({ width: 8 }),
        UI.Text({ text: '返回对话列表', style: 'labelMedium', color: colors.onPrimary }),
      ]),
    ]));
    items.push(UI.Spacer({ height: 8 }));

    // 对话头部（带Token统计和分析按钮）
    var chatTokens = 0;
    if (chatDetailState && chatDetailState.messages) {
      for (var ti = 0; ti < chatDetailState.messages.length; ti++) {
        chatTokens += estimateTokens(chatDetailState.messages[ti].content);
      }
    }

    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.tertiaryContainer, padding: 12 }, [
      UI.Column({}, [
        UI.Row({ verticalAlignment: 'center', fillMaxWidth: true }, [
          UI.Column({ weight: 1 }, [
            UI.Text({ text: chat.title || '未命名对话', style: 'titleSmall', fontWeight: 'bold', color: colors.tertiary }),
            UI.Row({}, [
              UI.Text({ text: (chat.messageCount || 0) + ' 条消息', style: 'labelSmall', color: colors.onSurfaceVariant }),
              UI.Spacer({ width: 8 }),
              UI.Surface({ shape: { cornerRadius: 4 }, containerColor: colors.primaryContainer, padding: { left: 6, right: 6, top: 2, bottom: 2 } }, [
                UI.Text({ text: 'Token: ' + formatTokens(chatTokens), style: 'labelSmall', color: colors.primary, fontSize: 10 }),
              ]),
            ]),
            chat.createdAt ? UI.Text({ text: '创建: ' + new Date(chat.createdAt).toLocaleDateString('zh-CN'), style: 'labelSmall', color: colors.outline, fontSize: 10 }) : null,
          ]),
          // 分析按钮
          UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.error, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: analyzeChat }, [
            UI.Row({ verticalAlignment: 'center' }, [
              UI.Icon({ name: 'analytics', tint: colors.onPrimary, size: 16 }),
              UI.Spacer({ width: 4 }),
              UI.Text({ text: '分析', style: 'labelSmall', color: colors.onPrimary, fontWeight: 'bold' }),
            ]),
          ]),
        ]),
      ].filter(Boolean)),
    ]));
    items.push(UI.Spacer({ height: 8 }));

    // 加载详情中
    if (loadingDetailState) {
      items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 24 }, [
        UI.Text({ text: '⏳ 加载消息中...', style: 'bodyMedium', color: colors.outline }),
      ]));
    } else if (chatDetailState && chatDetailState.messages) {
      var messages = chatDetailState.messages || [];

      // 消息统计
      var userCount = 0, aiCount = 0;
      for (var mi = 0; mi < messages.length; mi++) {
        if (messages[mi].sender === 'user' || messages[mi].roleName === 'user') userCount++;
        else aiCount++;
      }

      // 批量操作栏（当有选中消息时显示）
  if (selectedMessagesState.length > 0) {
    var selectedCount = selectedMessagesState.length;
    var batchAnalyzeSelected = function() {
      if (actions.setLoading) actions.setLoading(true);
      // 获取选中的消息内容
      var selectedMsgs = [];
      if (chatDetailState && chatDetailState.messages) {
        for (var si = 0; si < selectedMessagesState.length; si++) {
          var msgIdx = selectedMessagesState[si];
          if (chatDetailState.messages[msgIdx]) {
            selectedMsgs.push(chatDetailState.messages[msgIdx]);
          }
        }
      }
      if (selectedMsgs.length === 0) {
        if (actions.showToast) actions.showToast('没有选中的消息');
        if (actions.setLoading) actions.setLoading(false);
        return;
      }
      ctx.callTool('memory_system:analyze_saved_messages', {
        chat_id: chat.chatId,
        message_indices: JSON.stringify(selectedMessagesState)
      }).then(function(raw) {
        var r = parseResult(raw);
        if (r && r.success) {
          if (actions.showToast) actions.showToast('批量分析完成！');
        } else {
          if (actions.showToast) actions.showToast('分析失败: ' + (r ? r.message : '未知错误'));
        }
        if (actions.setLoading) actions.setLoading(false);
      }).catch(function(e) {
        if (actions.showToast) actions.showToast('分析出错');
        if (actions.setLoading) actions.setLoading(false);
      });
    };

    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.primaryContainer, padding: { left: 10, right: 10, top: 8, bottom: 8 } }, [
      UI.Row({ verticalAlignment: 'center', fillMaxWidth: true }, [
        UI.Text({ text: '已选 ' + selectedCount + ' 条消息', style: 'labelSmall', color: colors.primary, fontWeight: 'bold' }),
        UI.Spacer({ weight: 1 }),
        UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.error, padding: { left: 10, right: 10, top: 4, bottom: 4 }, onClick: function() {
          actions.setSelectedMessages([]);
        }}, [
          UI.Text({ text: '取消选择', style: 'labelSmall', color: colors.onPrimary }),
        ]),
        UI.Spacer({ width: 8 }),
        UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.error, padding: { left: 10, right: 10, top: 4, bottom: 4 }, onClick: batchAnalyzeSelected }, [
          UI.Text({ text: '分析选中', style: 'labelSmall', color: colors.onPrimary, fontWeight: 'bold' }),
        ]),
      ]),
    ]));
    items.push(UI.Spacer({ height: 8 }));
  }

      items.push(UI.Row({ fillMaxWidth: true, spacing: 8 }, [
        UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.primaryContainer, padding: { left: 10, right: 10, top: 4, bottom: 4 } }, [
          UI.Text({ text: '用户: ' + userCount, style: 'labelSmall', color: colors.primary }),
        ]),
        UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.tertiaryContainer, padding: { left: 10, right: 10, top: 4, bottom: 4 } }, [
          UI.Text({ text: 'AI: ' + aiCount, style: 'labelSmall', color: colors.tertiary }),
        ]),
        UI.Spacer({ weight: 1 }),
        // 全选/取消全选
        UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.surfaceVariant, padding: { left: 8, right: 8, top: 4, bottom: 4 }, onClick: function() {
          if (selectedMessagesState.length === messages.length) {
            actions.setSelectedMessages([]);
          } else {
            var allIdx = [];
            for (var ai = 0; ai < messages.length; ai++) allIdx.push(ai);
            actions.setSelectedMessages(allIdx);
          }
        }}, [
          UI.Text({ text: selectedMessagesState.length === messages.length && messages.length > 0 ? '取消全选' : '全选', style: 'labelSmall', color: colors.onSurfaceVariant }),
        ]),
      ]));
      items.push(UI.Spacer({ height: 8 }));

      // 消息列表（带多选和Token统计）
      for (var vi = 0; vi < messages.length; vi++) {
        (function(msg, idx) {
          var isUser = msg.sender === 'user' || msg.roleName === 'user';
          var isSelected = selectedMessagesState.indexOf(idx) >= 0;
          var bgColor = isSelected ? colors.primaryContainer : (isUser ? colors.primaryContainer : colors.surfaceVariant);
          var align = isUser ? 'start' : 'end';
          var senderName = isUser ? '用户' : 'AI';
          var senderColor = isUser ? colors.primary : colors.tertiary;
          var timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : '';
          var msgTokens = estimateTokens(msg.content);

          items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: bgColor, padding: 10, onClick: function() {
            // 切换选中状态
            var newSelected = selectedMessagesState.slice();
            var existIdx = newSelected.indexOf(idx);
            if (existIdx >= 0) {
              newSelected.splice(existIdx, 1);
            } else {
              newSelected.push(idx);
            }
            actions.setSelectedMessages(newSelected);
          }}, [
            UI.Row({ verticalAlignment: 'center', fillMaxWidth: true }, [
              // Checkbox
              UI.Surface({ width: 22, height: 22, shape: { cornerRadius: 4 }, containerColor: isSelected ? colors.primary : colors.surface, borderWidth: isSelected ? 0 : 1, borderColor: colors.outlineVariant, onClick: function() {
                var newSelected = selectedMessagesState.slice();
                var existIdx = newSelected.indexOf(idx);
                if (existIdx >= 0) {
                  newSelected.splice(existIdx, 1);
                } else {
                  newSelected.push(idx);
                }
                actions.setSelectedMessages(newSelected);
              }}, [
                isSelected ? UI.Icon({ name: 'check', tint: colors.onPrimary, size: 14 }) : null,
              ].filter(Boolean)),
              UI.Spacer({ width: 8 }),
              // 消息内容
              UI.Column({ weight: 1, horizontalAlignment: align }, [
                UI.Row({ verticalAlignment: 'center' }, [
                  UI.Text({ text: senderName, style: 'labelSmall', fontWeight: 'bold', color: senderColor }),
                  timeStr ? UI.Text({ text: ' ' + timeStr, style: 'labelSmall', color: colors.outline, fontSize: 9 }) : null,
                ]),
                UI.Spacer({ height: 4 }),
                UI.Text({ text: msg.content || '', style: 'bodySmall', color: colors.onSurface, maxLines: 10 }),
              ].filter(Boolean)),
              UI.Spacer({ width: 8 }),
              // Token + 分析按钮
              UI.Column({ horizontalAlignment: 'end' }, [
                UI.Surface({ shape: { cornerRadius: 4 }, containerColor: colors.surfaceVariant, padding: { left: 6, right: 6, top: 2, bottom: 2 } }, [
                  UI.Text({ text: formatTokens(msgTokens) + ' token', style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 9 }),
                ]),
                UI.Spacer({ height: 4 }),
                UI.Surface({ shape: { cornerRadius: 6 }, containerColor: colors.error, padding: { left: 8, right: 8, top: 3, bottom: 3 }, onClick: function() {
                  var targetChatId = chat.chatId;
                  var targetIdx = idx;
                  if (actions.setLoading) actions.setLoading(true);
                  ctx.callTool('memory_system:analyze_saved_messages', {
                    chat_id: targetChatId,
                    message_index: targetIdx
                  }).then(function(raw) {
                    var r = parseResult(raw);
                    if (r && r.success) {
                      if (actions.showToast) actions.showToast('消息分析完成');
                    } else {
                      if (actions.showToast) actions.showToast('分析失败');
                    }
                    if (actions.setLoading) actions.setLoading(false);
                  }).catch(function(e) {
                    if (actions.showToast) actions.showToast('分析出错');
                    if (actions.setLoading) actions.setLoading(false);
                  });
                }}, [
                  UI.Text({ text: '分析', style: 'labelSmall', color: colors.onPrimary, fontWeight: 'bold', fontSize: 10 }),
                ]),
              ]),
            ]),
          ]));
          items.push(UI.Spacer({ height: 4 }));
        })(messages[vi], vi);
      }
    }

    items.push(UI.Spacer({ height: 8 }));
  }

  // ===== 对话列表（无限滚动）=====
  if (!selectedChatState) {
    // 获取已分析对话列表
    var analyzedChats = states.analyzedChats || [];

    if (filteredChats.length === 0) {
      items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 32 }, [
        UI.Icon({ name: 'chat_bubble_outline', tint: colors.outlineVariant, size: 40 }),
        UI.Spacer({ height: 12 }),
        UI.Text({ text: searchQuery ? '没有找到匹配的对话' : '暂无对话记录', style: 'bodyMedium', color: colors.outline }),
      ]));
    } else {
      for (var ci = 0; ci < filteredChats.length; ci++) {
        (function(chat, idx) {
          var title = chat.title || '未命名对话';
          var timeStr = chat.updatedAt ? new Date(chat.updatedAt).toLocaleDateString('zh-CN') : '';
          var isAnalyzed = analyzedChats.includes(chat.chatId);

          items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: isAnalyzed ? colors.primaryContainer : colors.surfaceVariant, padding: 12, onClick: function() {
            actions.setSelectedChat(chat);
            actions.setChatDetail(null);
            actions.setSelectedMessages([]);
          }}, [
            UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
              UI.Surface({ width: 44, height: 44, shape: { cornerRadius: 22 }, containerColor: isAnalyzed ? colors.primary : colors.tertiary }, [
                UI.Row({ fillMaxWidth: true, height: 44, horizontalArrangement: 'center', verticalAlignment: 'center' }, [
                  UI.Icon({ name: isAnalyzed ? 'check_circle' : 'chat', tint: colors.onPrimary, size: 20 }),
                ]),
              ]),
              UI.Spacer({ width: 12 }),
              UI.Column({ weight: 1 }, [
                UI.Row({ verticalAlignment: 'center' }, [
                  UI.Text({ text: title, style: 'bodySmall', fontWeight: 'bold', color: colors.onSurface, maxLines: 1 }),
                  isAnalyzed ? UI.Spacer({ width: 6 }) : null,
                  isAnalyzed ? UI.Text({ text: '✓ 已分析', style: 'labelSmall', color: colors.primary, fontSize: 9 }) : null,
                ]),
                UI.Row({}, [
                  UI.Text({ text: (chat.messageCount || 0) + ' 条消息', style: 'labelSmall', color: colors.outline, fontSize: 10 }),
                  timeStr ? UI.Text({ text: ' · ' + timeStr, style: 'labelSmall', color: colors.outlineVariant, fontSize: 10 }) : null,
                ]),
              ]),
              UI.Icon({ name: 'chevron_right', tint: colors.outline, size: 18 }),
            ]),
          ]));
          items.push(UI.Spacer({ height: 4 }));

          // 检测是否滚动到底部，触发加载更多
// 注意：必须等 hasMoreState 反映的是"还剩更多"才触发。
// 修复要点：用闭包的 chatsState 长度作为基准，避免 screen 刷新+loadMore 同时发生时重复触发。
if (idx === filteredChats.length - 1 && hasMoreState && !searchQuery && !loadingChatsState) {
(function() {
setTimeout(function() {
handleLoadMore();
}, 100);
})();
}
        })(filteredChats[ci], ci);
      }

      // 加载更多指示器
      if (loadingChatsState && chatsState.length > 0) {
        items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 16 }, [
          UI.Text({ text: '⏳ 加载更多...', style: 'bodySmall', color: colors.outline }),
        ]));
      } else if (!hasMoreState && chatsState.length > 0) {
        items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 16 }, [
          UI.Text({ text: '—— 已加载全部 ' + chatsState.length + ' 个对话 ——', style: 'labelSmall', color: colors.outlineVariant }),
        ]));
      }
    }
  }

  return items;
}

exports.render = render;

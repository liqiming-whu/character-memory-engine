"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { relationMap, multiMatch } = shared;
const theme = require("../theme");

// ===== Tab 4: 联系人 =====
function render(ctx, allData, states) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);
  // 将 relationMap 的硬编码色映射到 Material token（relationMap 是模块级常量，无法访问 colors）
  var relTheme = {
    family:     { color: colors.error,   bg: colors.errorContainer },
    colleague:  { color: colors.primary, bg: colors.primaryContainer },
    friend:     { color: colors.primary, bg: colors.primaryContainer },
    classmate:  { color: colors.tertiary, bg: colors.tertiaryContainer },
    service:    { color: colors.tertiary, bg: colors.tertiaryContainer },
    other:      { color: colors.onSurfaceVariant, bg: colors.surfaceVariant }
  };
  function rInfo(rel) {
    var base = relationMap[rel || 'other'] || relationMap.other;
    var themed = relTheme[rel || 'other'] || relTheme.other;
    return { label: base.label, icon: base.icon, color: themed.color, bg: themed.bg };
  }

  var items = [];
  var allContacts = allData.contacts || [];
  var q = (states.query || '').toLowerCase();
  var groupFilter = states.filterType || '';
  var selIdx = states.selContact || -1;

  // 筛选
  var filtered = allContacts.filter(function(c) {
    if (groupFilter && (c.relation || 'other') !== groupFilter) return false;
    if (q) {
      var t = ((c.name || '') + ' ' + (c.context || '') + ' ' + ((c.contexts || []).map(function(x){return x.text;}).join(' '))).toLowerCase();
      if (t.indexOf(q) < 0) return false;
    }
    return true;
  });

  // 分组
  var contactGroups = {};
  for (var gi = 0; gi < filtered.length; gi++) {
    var rel = filtered[gi].relation || 'other';
    if (!contactGroups[rel]) contactGroups[rel] = [];
    contactGroups[rel].push(filtered[gi]);
  }
  var groupOrder = ['family', 'colleague', 'friend', 'classmate', 'service', 'other'];

  // 统计卡片
  items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.tertiaryContainer, padding: 14 }, [
    UI.Row({ verticalAlignment: 'center' }, [
      UI.Icon({ name: 'people', tint: colors.tertiary, size: 28 }),
      UI.Spacer({ width: 10 }),
      UI.Column({}, [
        UI.Text({ text: '联系人', style: 'titleMedium', fontWeight: 'bold', color: colors.tertiary }),
        UI.Text({ text: '共 ' + filtered.length + ' 人', style: 'bodySmall', color: colors.onSurfaceVariant }),
      ]),
    ]),
    UI.Spacer({ height: 8 }),
    UI.Row({ fillMaxWidth: true, horizontalArrangement: 'spaceEvenly' }, groupOrder.filter(function(g) { return contactGroups[g] && contactGroups[g].length > 0; }).map(function(g) {
      var info = rInfo(g);
      return UI.Column({ horizontalAlignment: 'center' }, [
        UI.Text({ text: String(contactGroups[g].length), style: 'titleSmall', fontWeight: 'bold', color: info.color }),
        UI.Text({ text: info.label, style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }),
      ]);
    })),
  ]));
  items.push(UI.Spacer({ height: 8 }));

  // 选中详情
  if (selIdx >= 0 && selIdx < filtered.length) {
    (function() {
      var sc = filtered[selIdx];
      var rI = rInfo(sc.relation || 'other');
      var attrs = sc.attributes || [];
      var ctxs = sc.contexts || [];
      if (!ctxs.length && sc.context) ctxs = [{ text: sc.context, date: '' }];

      var detailItems = [
        UI.Row({ fillMaxWidth: true, horizontalArrangement: 'spaceBetween', verticalAlignment: 'center' }, [
          UI.Row({ verticalAlignment: 'center' }, [
            UI.Surface({ width: 40, height: 40, shape: { cornerRadius: 20 }, containerColor: rI.color }, [
              UI.Row({ fillMaxWidth: true, height: 40, horizontalArrangement: 'center', verticalAlignment: 'center' }, [
                UI.Text({ text: (sc.name || '?').charAt(0), style: 'titleSmall', fontWeight: 'bold', color: colors.onPrimary }),
              ]),
            ]),
            UI.Spacer({ width: 10 }),
            UI.Column({}, [
              UI.Text({ text: sc.name || '未知', style: 'titleSmall', fontWeight: 'bold', color: colors.onSurface }),
              UI.Row({}, [
                UI.Surface({ shape: { cornerRadius: 4 }, containerColor: rI.bg, padding: { left: 6, right: 6, top: 2, bottom: 2 } }, [
                  UI.Text({ text: rI.label, style: 'labelSmall', color: rI.color, fontSize: 10 }),
                ]),
                UI.Spacer({ width: 6 }),
                UI.Text({ text: '提及 ' + (sc.mentionCount || 1) + ' 次', style: 'labelSmall', color: colors.outline, fontSize: 10 }),
              ]),
            ]),
          ]),
        ]),
      ];

      if (attrs.length > 0) {
        detailItems.push(UI.Spacer({ height: 8 }));
        detailItems.push(UI.Text({ text: '属性', style: 'labelMedium', fontWeight: 'bold', color: colors.tertiary, fontSize: 12 }));
        for (var ai = 0; ai < attrs.length; ai++) {
          detailItems.push(UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
            UI.Surface({ shape: { cornerRadius: 4 }, containerColor: colors.tertiaryContainer, padding: { left: 6, right: 6, top: 2, bottom: 2 } }, [
              UI.Text({ text: attrs[ai].key, style: 'labelSmall', color: colors.tertiary, fontSize: 10 }),
            ]),
            UI.Spacer({ width: 6 }),
            UI.Text({ text: attrs[ai].value, style: 'bodySmall', color: colors.onSurface }),
          ]));
        }
      }

      if (ctxs.length > 0) {
        detailItems.push(UI.Spacer({ height: 8 }));
        detailItems.push(UI.Text({ text: '提及记录 (' + ctxs.length + ')', style: 'labelMedium', fontWeight: 'bold', color: colors.tertiary, fontSize: 12 }));
        var showCtxs = ctxs.slice(-5).reverse();
        for (var xi = 0; xi < showCtxs.length; xi++) {
          detailItems.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 6 }, containerColor: colors.surfaceVariant, padding: 6 }, [
            UI.Text({ text: showCtxs[xi].text || '', style: 'bodySmall', color: colors.onSurfaceVariant, fontSize: 11 }),
            showCtxs[xi].date ? UI.Text({ text: new Date(showCtxs[xi].date).toLocaleDateString('zh-CN'), style: 'labelSmall', color: colors.outline, fontSize: 9 }) : null,
          ].filter(Boolean)));
        }
      }

      items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 12 }, containerColor: colors.tertiaryContainer, border: { width: 1, color: colors.outlineVariant }, padding: 12 }, [
        UI.Column({ spacing: 4 }, detailItems),
      ]));
      items.push(UI.Spacer({ height: 8 }));
    })();
  }

  // 联系人列表
  if (filtered.length === 0) {
    items.push(UI.Column({ horizontalAlignment: 'center', fillMaxWidth: true, padding: 24 }, [
      UI.Icon({ name: 'people_outline', tint: colors.outlineVariant, size: 40 }),
      UI.Spacer({ height: 10 }),
      UI.Text({ text: '暂无联系人', style: 'bodyMedium', color: colors.outline }),
    ]));
  } else {
    for (var ggi = 0; ggi < groupOrder.length; ggi++) {
      (function(groupKey) {
        var group = contactGroups[groupKey];
        if (!group || group.length === 0) return;
        var rI = rInfo(groupKey);

        items.push(UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
          UI.Icon({ name: rI.icon, tint: rI.color, size: 16 }),
          UI.Spacer({ width: 6 }),
          UI.Text({ text: rI.label, style: 'labelMedium', fontWeight: 'bold', color: rI.color }),
          UI.Spacer({ width: 6 }),
          UI.Surface({ shape: { cornerRadius: 8 }, containerColor: rI.bg, padding: { left: 6, right: 6, top: 1, bottom: 1 } }, [
            UI.Text({ text: String(group.length), style: 'labelSmall', color: rI.color, fontSize: 10 }),
          ]),
        ]));
        items.push(UI.Spacer({ height: 4 }));

        for (var gci = 0; gci < group.length; gci++) {
          (function(c, globalIdx) {
            var initial = c.name ? c.name.charAt(0) : '?';
            var isSel = globalIdx === selIdx;
            var attrs = c.attributes || [];
            var ctxs = c.contexts || [];
            if (!ctxs.length && c.context) ctxs = [{ text: c.context, date: '' }];
            var ctxText = ctxs.length > 0 ? ctxs[ctxs.length - 1].text : '';

            items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: isSel ? rI.bg : colors.surfaceVariant, padding: 10 }, [
              UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
                UI.Surface({ width: 34, height: 34, shape: { cornerRadius: 17 }, containerColor: rI.color }, [
                  UI.Row({ fillMaxWidth: true, height: 34, horizontalArrangement: 'center', verticalAlignment: 'center' }, [
                    UI.Text({ text: initial, style: 'labelMedium', fontWeight: 'bold', color: colors.onPrimary }),
                  ]),
                ]),
                UI.Spacer({ width: 10 }),
                UI.Column({ weight: 1 }, [
                  UI.Row({ verticalAlignment: 'center' }, [
                    UI.Text({ text: c.name || '未知', style: 'bodySmall', fontWeight: 'bold', color: colors.onSurface }),
                    UI.Spacer({ width: 6 }),
                    attrs.length > 0 ? UI.Text({ text: attrs.length + '个属性', style: 'labelSmall', color: colors.outline, fontSize: 9 }) : null,
                  ].filter(Boolean)),
                  ctxText ? UI.Text({ text: ctxText, style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 11, maxLines: 1 }) : null,
                ].filter(Boolean)),
                UI.Icon({ name: isSel ? 'expand_less' : 'chevron_right', tint: rI.color, size: 18 }),
              ]),
            ]));
            items.push(UI.Spacer({ height: 3 }));
          })(group[gci], filtered.indexOf(group[gci]));
        }
        items.push(UI.Spacer({ height: 6 }));
      })(groupOrder[ggi]);
    }
  }

  return items;
}

exports.render = render;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

// ===== Material Theme 配色辅助 =====
// 统一从 ctx.MaterialTheme.colorScheme 取色，避免在 UI 中硬编码十六进制。
// 语义映射遵循官方 Material3 token（与 Operit app 主题协调，深浅色自适应）。
//
// 用法：
//   const theme = require('../theme');
//   theme.c(colors) -> 返回 { primary, onPrimary, surface, onSurface, onSurfaceVariant,
//                          surfaceVariant, outline, outlineVariant, error, errorContainer,
//                          primaryContainer, tertiary, tertiaryContainer }
//   theme.isDark(colors) -> 判断是否为深色模式（可选，用于个别需要强制的场景）

// 从 colorScheme 安全取值；token 缺失时回退默认十六进制（仅兜底，正常情况下宿主都会提供）。
function pick(colors, token, fallback) {
  var v = colors && colors[token];
  return (v !== undefined && v !== null) ? v : (fallback || '#000000');
}

function c(colors) {
  return {
    primary: pick(colors, 'primary', '#6750A4'),
    onPrimary: pick(colors, 'onPrimary', '#FFFFFF'),
    primaryContainer: pick(colors, 'primaryContainer', '#EADDFF'),
    onPrimaryContainer: pick(colors, 'onPrimaryContainer', '#21005D'),
    secondary: pick(colors, 'secondary', '#625B71'),
    onSecondary: pick(colors, 'onSecondary', '#FFFFFF'),
    secondaryContainer: pick(colors, 'secondaryContainer', '#E8DEF8'),
    onSecondaryContainer: pick(colors, 'onSecondaryContainer', '#1D192B'),
    tertiary: pick(colors, 'tertiary', '#7D5260'),
    onTertiary: pick(colors, 'onTertiary', '#FFFFFF'),
    tertiaryContainer: pick(colors, 'tertiaryContainer', '#FFD8E4'),
    onTertiaryContainer: pick(colors, 'onTertiaryContainer', '#31111D'),
    error: pick(colors, 'error', '#B3261E'),
    onError: pick(colors, 'onError', '#FFFFFF'),
    errorContainer: pick(colors, 'errorContainer', '#F9DEDC'),
    onErrorContainer: pick(colors, 'onErrorContainer', '#410E0B'),
    surface: pick(colors, 'surface', '#FEF7FF'),
    onSurface: pick(colors, 'onSurface', '#1D1B20'),
    onSurfaceVariant: pick(colors, 'onSurfaceVariant', '#49454F'),
    surfaceVariant: pick(colors, 'surfaceVariant', '#E7E0EC'),
    surfaceContainerLow: pick(colors, 'surfaceContainerLow', '#F7F2FA'),
    surfaceContainer: pick(colors, 'surfaceContainer', '#F3EDF7'),
    surfaceContainerHigh: pick(colors, 'surfaceContainerHigh', '#ECE6F0'),
    outline: pick(colors, 'outline', '#79747E'),
    outlineVariant: pick(colors, 'outlineVariant', '#CAC4D0'),
    inverseOnSurface: pick(colors, 'inverseOnSurface', '#F4EFF4')
  };
}

function isDark(colors) {
  var s = colors && (colors.surface || colors.background || '');
  if (typeof s === 'string') {
    var m = s.match(/^#([0-9a-fA-F]{6})$/);
    if (m) {
      var lum = parseInt(m[1].substring(0, 2), 16) * 0.299 + parseInt(m[1].substring(2, 4), 16) * 0.587 + parseInt(m[1].substring(4, 6), 16) * 0.114;
      return lum < 128;
    }
  }
  return false;
}

exports.c = c;
exports.isDark = isDark;

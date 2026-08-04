"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

// ===== 共用：类型颜色映射 =====
function getTypeColor(t) {
  var map = {
    activity: '#2196F3',
    schedule: '#FF9800',
    observation: '#8D6E63',
    milestone: '#9C27B0',
    mood: '#E91E63',
    expense: '#F44336',
    income: '#4CAF50',
    menstrual: '#E91E63'
  };
  return map[t] || '#78909C';
}

// ===== 共用：类型图标映射 =====
function getTypeIcon(t) {
  var map = {
    activity: 'directions_run',
    schedule: 'schedule',
    observation: 'visibility',
    milestone: 'flag',
    mood: 'mood',
    expense: 'remove_circle',
    income: 'add_circle',
    menstrual: 'favorite'
  };
  return map[t] || 'info';
}

// ===== 共用：关系颜色/图标映射 =====
var relationMap = {
  family: { label: '家人', icon: 'family_restroom', color: '#E91E63', bg: '#FCE4EC' },
  colleague: { label: '同事', icon: 'work', color: '#2196F3', bg: '#E3F2FD' },
  classmate: { label: '同学', icon: 'school', color: '#FF9800', bg: '#FFF3E0' },
  friend: { label: '朋友', icon: 'sentiment_satisfied_alt', color: '#4CAF50', bg: '#E8F5E9' },
  service: { label: '服务', icon: 'support_agent', color: '#00BCD4', bg: '#E0F7FA' },
  other: { label: '其他', icon: 'person', color: '#78909C', bg: '#ECEFF1' }
};

// ===== 共用：多关键词匹配 =====
function multiMatch(text, query) {
  if (!query) return true;
  var keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return true;
  var lower = text.toLowerCase();
  for (var i = 0; i < keywords.length; i++) {
    if (lower.indexOf(keywords[i]) < 0) return false;
  }
  return true;
}

// ===== 共用：日期范围过滤 =====
function inDateRange(timestamp, start, end) {
  if (!start && !end) return true;
  if (!timestamp) return false;
  var d = timestamp.substring(0, 10);
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

// ===== 共用：补零 =====
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// ===== 共用：解析结果 =====
function parseResult(r) {
  if (typeof r === 'string') {
    try { return JSON.parse(r); } catch(e) { return null; }
  }
  return r;
}

exports.getTypeColor = getTypeColor;
exports.getTypeIcon = getTypeIcon;
exports.relationMap = relationMap;
exports.multiMatch = multiMatch;
exports.inDateRange = inDateRange;
exports.pad2 = pad2;
exports.parseResult = parseResult;

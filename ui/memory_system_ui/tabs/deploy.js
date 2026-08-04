"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const shared = require("../shared");
const { parseResult } = shared;
const theme = require("../theme");

// ===== Tab 6: 部署 =====
function render(ctx) {
  var UI = ctx.UI;
  var colors = theme.c(ctx.MaterialTheme && ctx.MaterialTheme.colorScheme);

  var statusState = ctx.useState('deploy_status', null);
  var busyState = ctx.useState('deploy_busy', false);
  var msgState = ctx.useState('deploy_msg', '');
  var logState = ctx.useState('deploy_log', null);
  var logLoadingState = ctx.useState('deploy_log_loading', false);
  var logFilterState = ctx.useState('deploy_log_filter', '');

  async function checkStatus() {
    busyState[1](true);
    msgState[1]('检查部署状态...');
    try {
      var raw = await ctx.callTool('memory_engine:deploy_status', {});
      var r = parseResult(raw);
      if (r && r.success) {
        statusState[1](r.status || {});
        msgState[1]('');
      } else {
        msgState[1]('状态检查失败：' + ((r && r.message) || '未知错误'));
      }
    } catch (e) {
      msgState[1]('状态检查异常：' + (e.message || String(e)));
    }
    busyState[1](false);
  }

  async function loadLogs() {
    logLoadingState[1](true);
    try {
      var raw = await ctx.callTool('memory_engine:get_logs', { limit: 200, level: logFilterState[0] || '' });
      var r = parseResult(raw);
      if (r && r.success) {
        logState[1]({ lines: r.log || [], path: r.path || '' });
      } else {
        logState[1]({ lines: [], path: '', error: ((r && r.message) || '读取日志失败') });
      }
    } catch (e) {
      logState[1]({ lines: [], path: '', error: '读取日志异常：' + (e.message || String(e)) });
    }
    logLoadingState[1](false);
  }

  async function doInstall() {
    busyState[1](true);
    msgState[1]('正在安装依赖...');
    try {
      var raw = await ctx.callTool('memory_engine:deploy_install', {});
      var r = parseResult(raw);
      if (r && r.success) {
        msgState[1]('依赖安装完成');
        await checkStatus();
      } else {
        msgState[1]('安装失败：' + ((r && r.message) || '未知错误'));
      }
    } catch (e) {
      msgState[1]('安装异常：' + (e.message || String(e)));
    }
    busyState[1](false);
  }

  async function doRestart() {
    busyState[1](true);
    msgState[1]('正在重启 Worker...');
    try {
      var raw = await ctx.callTool('memory_engine:deploy_restart', {});
      var r = parseResult(raw);
      if (r && r.success) {
        msgState[1]('Worker 重启完成');
        await checkStatus();
      } else {
        msgState[1]('重启失败：' + ((r && r.message) || '未知错误'));
      }
    } catch (e) {
      msgState[1]('重启异常：' + (e.message || String(e)));
    }
    busyState[1](false);
  }

  var items = [];

  // 标题
  items.push(UI.Text({ text: '部署', style: 'titleMedium', color: colors.onSurface, fontWeight: 'bold' }));
  items.push(UI.Text({ text: '检查 Worker 进程、依赖与模型状态；首次启动请先检查部署。', style: 'bodySmall', color: colors.onSurfaceVariant }));
  items.push(UI.Spacer({ height: 8 }));

  // 操作按钮
  items.push(UI.Row({ fillMaxWidth: true, spacing: 8 }, [
    UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.primary, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: checkStatus }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'refresh', tint: colors.onPrimary, size: 16 }),
        UI.Spacer({ width: 4 }),
        UI.Text({ text: '检查状态', style: 'labelSmall', color: colors.onPrimary, fontWeight: 'bold' }),
      ]),
    ]),
    UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.primaryContainer, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: doInstall }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'download', tint: colors.primary, size: 16 }),
        UI.Spacer({ width: 4 }),
        UI.Text({ text: '安装依赖', style: 'labelSmall', color: colors.primary, fontWeight: 'bold' }),
      ]),
    ]),
    UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.tertiaryContainer, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: doRestart }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'restart_alt', tint: colors.tertiary, size: 16 }),
        UI.Spacer({ width: 4 }),
        UI.Text({ text: '重启 Worker', style: 'labelSmall', color: colors.tertiary, fontWeight: 'bold' }),
      ]),
    ]),
    UI.Surface({ shape: { cornerRadius: 8 }, containerColor: colors.secondaryContainer, padding: { left: 12, right: 12, top: 6, bottom: 6 }, onClick: loadLogs }, [
      UI.Row({ verticalAlignment: 'center' }, [
        UI.Icon({ name: 'receipt_long', tint: colors.secondary, size: 16 }),
        UI.Spacer({ width: 4 }),
        UI.Text({ text: logLoadingState[0] ? '加载中...' : '查看日志', style: 'labelSmall', color: colors.secondary, fontWeight: 'bold' }),
      ]),
    ]),
  ]));
  items.push(UI.Spacer({ height: 8 }));

  // 日志展示
  var lg = logState[0];
  if (lg) {
    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceContainerHigh, padding: 12 }, [
      UI.Column({ spacing: 6 }, [
        UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
          UI.Text({ text: '日志', style: 'labelMedium', fontWeight: 'bold', color: colors.primary }),
          UI.Spacer({ width: 8 }),
          // 级别筛选
          [['', '全部'], ['ERROR', '错误'], ['WARN', '警告']].map(function (f) {
            var active = (logFilterState[0] || '') === f[0];
            return UI.Surface({
              shape: { cornerRadius: 6 },
              containerColor: active ? colors.primary : colors.surfaceContainerHighest,
              padding: { left: 8, right: 8, top: 3, bottom: 3 },
              onClick: function () {
                logFilterState[1](f[0]);
                logState[1](null);
                loadLogs();
              }
            }, [
              UI.Text({ text: f[1], style: 'labelSmall', color: active ? colors.onPrimary : colors.onSurface, fontWeight: active ? 'bold' : 'normal' }),
            ]);
          }),
        ]),
        lg.error
          ? UI.Text({ text: lg.error, style: 'labelSmall', color: colors.error })
          : (lg.lines && lg.lines.length
            ? UI.Text({ text: lg.lines.join('\n'), style: 'bodySmall', color: colors.onSurfaceVariant, fontFamily: 'monospace', fontSize: 10 })
            : UI.Text({ text: '暂无日志', style: 'labelSmall', color: colors.onSurfaceVariant })),
        lg.path ? UI.Text({ text: lg.path, style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) : null,
      ]),
    ]));
  }

  // 状态展示
  var st = statusState[0];
  if (st) {
    function StatusRow(label, ok, detail) {
      return UI.Row({ fillMaxWidth: true, verticalAlignment: 'center' }, [
        UI.Icon({ name: ok ? 'check_circle' : 'cancel', tint: ok ? '#4CAF50' : '#F44336', size: 16 }),
        UI.Spacer({ width: 8 }),
        UI.Column({ weight: 1 }, [
          UI.Text({ text: label, style: 'bodySmall', color: colors.onSurface, fontWeight: 'bold' }),
          detail ? UI.Text({ text: detail, style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) : null,
        ].filter(Boolean)),
      ]);
    }

    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceContainerHigh, padding: 12 }, [
      UI.Column({ spacing: 8 }, [
        UI.Text({ text: 'Worker 状态', style: 'labelMedium', fontWeight: 'bold', color: colors.primary }),
        StatusRow('Worker 运行中', !!st.worker_running, st.worker_running ? ('PID: ' + st.worker_pid) : '未运行'),
        StatusRow('重复进程', st.dup_count > 0, st.dup_count > 0 ? ('发现 ' + st.dup_count + ' 个重复进程') : '无'),
        StatusRow('Python/venv', !!st.venv_ok, st.venv_path),
        StatusRow('onnxruntime', !!st.onnx_ok, st.onnx_ver),
        StatusRow('sqlite-vec', !!st.sqlite_vec_ok, ''),
        StatusRow('tokenizers', !!st.tokenizers_ok, ''),
        StatusRow('BGE 模型', !!st.model_ok, st.model_path),
        StatusRow('向量能力', !!st.vec_available, ''),
        StatusRow('数据库', !!st.db_ok, st.db_path),
        StatusRow('端口 ' + (st.port || '8765'), !!st.worker_running, ''),
      ]),
    ]));
  }

  // 提示信息
  if (msgState[0]) {
    items.push(UI.Spacer({ height: 8 }));
    items.push(UI.Text({ text: msgState[0], style: 'labelSmall', color: colors.onSurfaceVariant }));
  }

  // 首次部署提示
  if (firstRunHint) {
    items.push(UI.Spacer({ height: 8 }));
    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 8 }, containerColor: colors.errorContainer, padding: 10 }, [
      UI.Text({ text: '首次使用：请点击「检查状态」确认 Worker 可用，必要时「安装依赖」或「重启 Worker」。', style: 'labelSmall', color: colors.error }),
    ]));
  }

  return items;
}

var firstRunHint = true;

exports.render = render;

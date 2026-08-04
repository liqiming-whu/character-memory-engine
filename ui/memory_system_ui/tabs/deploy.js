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
  var diagState = ctx.useState('deploy_diag', null);

  async function checkStatus() {
    busyState[1](true);
    msgState[1]('检查部署状态...');
    try {
      // callTool 返回 JSON 字符串；parseResult 负责解析 + 解包 data 字段
      var raw = await ctx.callTool('memory_engine:deploy_status', {});
      try { if (typeof console !== 'undefined' && console.log) console.log('[deploy_status] RAW=' + JSON.stringify(raw)); } catch (e) {}
      var r = parseResult(raw);
      if (r && r.success) {
        var s = r.status || r.data || {};
        statusState[1](s);
        msgState[1]('');
      } else {
        msgState[1]('状态检查失败：' + ((r && (r.message || r.error)) || '未知错误'));
      }
    } catch (e) {
      msgState[1]('状态检查失败：' + (e.message || String(e)));
    }
    busyState[1](false);
  }

  // 插件侧诊断：不经 worker，worker 未运行时也能看进程/启动日志/engine.log
  async function runDiagnosis() {
    diagState[1]({ running: true });
    try {
      var raw = await ctx.callTool('memory_engine:diag_engine', {});
      var r = parseResult(raw);
      if (r && r.success) {
        diagState[1](r.diag || {});
      } else {
        diagState[1]({ error: ((r && r.message) || '诊断失败') });
      }
    } catch (e) {
      diagState[1]({ error: '诊断异常：' + (e.message || String(e)) });
    }
  }

  async function loadLogs() {
    logLoadingState[1](true);
    try {
      var raw = await ctx.callTool('memory_engine:get_logs', { limit: 300, level: logFilterState[0] || '' });
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

  // 操作按钮（两行：第一行 检查状态/安装依赖/重启，第二行 查看日志/诊断）
  function actionBtn(label, icon, bg, fg, onClick) {
    return UI.Surface({ weight: 1, shape: { cornerRadius: 8 }, containerColor: bg, padding: { left: 8, right: 8, top: 8, bottom: 8 }, onClick: onClick }, [
      UI.Column({ horizontalAlignment: 'center', spacing: 3 }, [
        UI.Icon({ name: icon, tint: fg, size: 16 }),
        UI.Text({ text: label, style: 'labelSmall', color: fg, fontWeight: 'bold' }),
      ]),
    ]);
  }
  items.push(UI.Row({ fillMaxWidth: true, spacing: 8 }, [
    actionBtn('检查状态', 'refresh', colors.primary, colors.onPrimary, checkStatus),
    actionBtn('安装依赖', 'download', colors.primaryContainer, colors.primary, doInstall),
    actionBtn('重启 Worker', 'restart_alt', colors.tertiaryContainer, colors.tertiary, doRestart),
  ]));
  items.push(UI.Spacer({ height: 8 }));
  items.push(UI.Row({ fillMaxWidth: true, spacing: 8 }, [
    actionBtn(logLoadingState[0] ? '加载中...' : '查看日志', 'receipt_long', colors.secondaryContainer, colors.secondary, loadLogs),
    actionBtn('诊断', 'bug_report', colors.errorContainer, colors.error, runDiagnosis),
  ]));
  items.push(UI.Spacer({ height: 8 }));

  // 插件侧诊断展示（worker 未运行时也有用）
  var dg = diagState[0];
  if (dg) {
    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceContainerHigh, padding: 12 }, [
      UI.Column({ spacing: 4 }, [
        UI.Text({ text: dg.running ? '诊断中...' : '插件侧诊断（不经 Worker）', style: 'labelMedium', fontWeight: 'bold', color: colors.primary }),
        dg.error
          ? UI.Text({ text: dg.error, style: 'labelSmall', color: colors.error })
          : [
              UI.Text({ text: 'Worker 进程: ' + (dg.worker_up ? '运行中 (' + (dg.process_count || 0) + ' 个)' : '未运行'), style: 'labelSmall', color: dg.worker_up ? '#4CAF50' : colors.error }),
              dg.pids && dg.pids.length ? UI.Text({ text: 'PID: ' + dg.pids.join(', '), style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) : null,
              dg.tmp_log_tail ? UI.SelectionContainer({ fillMaxWidth: true }, [ UI.Text({ text: '启动日志(/tmp/engine_worker.log):\n' + dg.tmp_log_tail, style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) ]) : null,
              dg.engine_log_tail ? UI.SelectionContainer({ fillMaxWidth: true }, [ UI.Text({ text: 'engine.log 尾部:\n' + dg.engine_log_tail, style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) ]) : null,
            ],
      ]),
    ]));
    items.push(UI.Spacer({ height: 8 }));
  }

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
          // 复制日志：写入剪贴板并 toast 反馈
          (lg.lines && lg.lines.length) ? UI.Surface({
            shape: { cornerRadius: 6 },
            containerColor: colors.tertiaryContainer,
            padding: { left: 8, right: 8, top: 3, bottom: 3 },
            onClick: function () {
              var txt = lg.lines.join('\n');
              try {
                if (ctx.setClipboard) ctx.setClipboard(txt);
                if (Tools && Tools.toast) Tools.toast('日志已复制 (' + lg.lines.length + ' 行)');
              } catch (e) {
                try { if (Tools && Tools.toast) Tools.toast('复制失败，请长按日志文本手动复制'); } catch (e2) {}
              }
            }
          }, [
            UI.Text({ text: '复制', style: 'labelSmall', color: colors.tertiary, fontWeight: 'bold' }),
          ]) : null,
        ]),
        lg.error
          ? UI.Text({ text: lg.error, style: 'labelSmall', color: colors.error })
          : (lg.lines && lg.lines.length
            ? UI.SelectionContainer({ fillMaxWidth: true }, [
                UI.Text({ text: lg.lines.join('\n'), style: 'bodySmall', color: colors.onSurfaceVariant, fontFamily: 'monospace', fontSize: 10 }),
              ])
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

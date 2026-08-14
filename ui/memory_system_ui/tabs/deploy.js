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
  var busyLabelState = ctx.useState('deploy_busy_label', '');
  var msgState = ctx.useState('deploy_msg', '');
  var logState = ctx.useState('deploy_log', null);
  var logLoadingState = ctx.useState('deploy_log_loading', false);
  var logFilterState = ctx.useState('deploy_log_filter', '');
  var diagState = ctx.useState('deploy_diag', null);

  // toast 反馈（Operit compose DSL 提供 ctx.showToast；Tools.toast 不存在，勿用）
  function toast(msg) {
    try { if (ctx.showToast) ctx.showToast(msg); } catch (e) {}
  }
  function setBusy(label) {
    busyLabelState[1](label || '');
    busyState[1](!!label);
  }

  async function checkStatus() {
    if (busyState[0]) return; // 防连点：进行中直接忽略
    setBusy('检查中');
    msgState[1]('检查部署状态...');
    try {
      // callTool 返回 JSON 字符串；parseResult 负责解析 + 解包 data 字段
      var raw = await ctx.callTool('memory_engine:deploy_status', {});
      try { if (typeof console !== 'undefined' && console.log) console.log('[deploy_status] RAW=' + JSON.stringify(raw)); } catch (e) {}
      var r = parseResult(raw);
      if (r && r.success && r.installing) {
        // 依赖安装中：明确提示进行中（不是失败），完成后 Worker 自动启动
        statusState[1]({ installing: true, message: '依赖安装中' });
        msgState[1]('依赖安装中（需几分钟），完成后 Worker 自动启动，可稍后再查');
        toast('依赖安装中，请稍候');
        setBusy('');
        return;
      }
      if (r && r.success) {
        var s = r.status || r.data || {};
        statusState[1](s);
        msgState[1]('');
        toast('状态检查完成，全部正常');
      } else {
        msgState[1]('状态检查失败：' + ((r && (r.message || r.error)) || '未知错误'));
        toast('状态检查失败');
      }
    } catch (e) {
      msgState[1]('状态检查失败：' + (e.message || String(e)));
      toast('状态检查失败：' + (e.message || String(e)));
    }
    setBusy('');
  }

  // 插件侧诊断：不经 worker，worker 未运行时也能看进程/启动日志/engine.log
  async function runDiagnosis() {
    if (diagState[0] && diagState[0].running) return; // 防连点
    diagState[1]({ running: true });
    try {
      var raw = await ctx.callTool('memory_engine:diag_engine', {});
      var r = parseResult(raw);
      // 读取前端诊断缓存（screen.js dbgUi 写入 DBG_UI_CACHE）
      var frontCache = '';
      try { frontCache = ctx.getEnv('DBG_UI_CACHE') || ''; } catch (e) {}
      if (r && r.success) {
        var diag = r.diag || {};
        diag.front_cache = frontCache;
        diagState[1](diag);
        toast('诊断完成');
      } else {
        diagState[1]({ error: ((r && r.message) || '诊断失败'), front_cache: frontCache });
        toast('诊断失败：' + ((r && r.message) || '未知错误'));
      }
    } catch (e) {
      var fc = '';
      try { fc = ctx.getEnv('DBG_UI_CACHE') || ''; } catch (e2) {}
      diagState[1]({ error: '诊断异常：' + (e.message || String(e)), front_cache: fc });
      toast('诊断异常：' + (e.message || String(e)));
    }
  }

  async function loadLogs() {
    logLoadingState[1](true);
    try {
      var raw = await ctx.callTool('memory_engine:get_logs', { limit: 300, level: logFilterState[0] || '' });
      var r = parseResult(raw);
      if (r && r.success) {
        var lines = (r.log || []).slice();
        logState[1]({ lines: lines, path: r.path || '' });
        toast('已加载 ' + lines.length + ' 行日志');
      } else {
        logState[1]({ lines: [], path: '', error: ((r && r.message) || '读取日志失败') });
        toast('读取日志失败');
      }
    } catch (e) {
      logState[1]({ lines: [], path: '', error: '读取日志异常：' + (e.message || String(e)) });
      toast('读取日志异常');
    }
    logLoadingState[1](false);
  }

  // 安装中自动轮询：每 5s 查 deploy_status，worker 就绪（tokenizers/vec 全绿）即回显完成；
  // 最多轮询 72 次（6 分钟）后停止，避免无限循环。
  function pollInstallUntilReady(statusState, msgState) {
    var n = 0;
    (function tick() {
      if (n >= 72) return;
      n++;
      ctx.callTool('memory_engine:deploy_status', {}).then(function (raw) {
        var r = parseResult(raw);
        if (r && r.success && r.installing) {
          msgState[1]('依赖安装中（需几分钟）...已等待 ' + (n * 5) + 's');
        } else if (r && r.success) {
          var s = r.status || r.data || {};
          if (s.worker_running && s.vec_available && s.tokenizers_ok) {
            // 全绿：回显完成，停止轮询
            statusState[1](s);
            msgState[1]('依赖安装完成，向量能力已就绪 ✓');
            toast('依赖安装完成');
            return;
          }
          msgState[1]('依赖安装中（需几分钟）...已等待 ' + (n * 5) + 's');
        } else {
          msgState[1]('依赖安装中（需几分钟）...已等待 ' + (n * 5) + 's');
        }
        setTimeout(tick, 5000);
      }).catch(function () {
        msgState[1]('依赖安装中（需几分钟）...已等待 ' + (n * 5) + 's');
        setTimeout(tick, 5000);
      });
    })();
  }

  async function doInstall() {
    if (busyState[0]) return; // 防连点
    setBusy('安装中');
    msgState[1]('正在安装依赖...');
    try {
      var raw = await ctx.callTool('memory_engine:deploy_install', {});
      var r = parseResult(raw);
      if (r && r.success && r.installing) {
        // 离线路径：命令已投递到终端后台执行（fire-and-forget），几秒内不可能装完——
        // 不能显示「完成」也不能立即查状态（会误报失败），提示等待即可
        msgState[1]('依赖安装中（需几分钟），完成后 Worker 自动启动，可稍后查看状态');
        toast('已启动依赖安装，请等待完成');
        // 自动轮询回显：每 5s 查一次 deploy_status，worker 就绪（tokenizers/vec 全绿）即回显完成，
        // 无需用户再手动点「检查状态/再次安装」才看到成功（安装期间半成品状态不会误报为完成）
        pollInstallUntilReady(statusState, msgState);
        setBusy('');
        return;
      }
      if (r && r.success) {
        msgState[1]('依赖安装完成 ✓');
        toast('依赖安装完成');
        await checkStatus();
      } else {
        msgState[1]('安装失败：' + ((r && r.message) || '未知错误'));
        toast('安装失败：' + ((r && r.message) || '未知错误'));
      }
    } catch (e) {
      msgState[1]('安装异常：' + (e.message || String(e)));
      toast('安装异常：' + (e.message || String(e)));
    }
    setBusy('');
  }

  async function doRestart() {
    if (busyState[0]) return; // 防连点
    setBusy('重启中');
    msgState[1]('正在重启 Worker...');
    try {
      var raw = await ctx.callTool('memory_engine:deploy_restart', {});
      var r = parseResult(raw);
      if (r && r.success) {
        msgState[1]('Worker 重启完成 ✓');
        toast('Worker 重启完成');
        await checkStatus();
      } else {
        msgState[1]('重启失败：' + ((r && r.message) || '未知错误'));
        toast('重启失败：' + ((r && r.message) || '未知错误'));
      }
    } catch (e) {
      msgState[1]('重启异常：' + (e.message || String(e)));
      toast('重启异常：' + (e.message || String(e)));
    }
    setBusy('');
  }

  var items = [];

  // 标题
  items.push(UI.Text({ text: '部署', style: 'titleMedium', color: colors.onSurface, fontWeight: 'bold' }));
  items.push(UI.Text({ text: '检查 Worker 进程、依赖与模型状态；首次启动请先检查部署。', style: 'bodySmall', color: colors.onSurfaceVariant }));
  items.push(UI.Spacer({ height: 8 }));

  // 操作按钮（两行：第一行 检查状态/安装依赖/重启，第二行 查看日志/诊断）
  // 自适应内容宽度 + 整行居中；间距用显式 Spacer（compose DSL 的 Row spacing 参数不可靠）
  function actionBtn(label, icon, bg, fg, onClick) {
    return UI.Surface({ shape: { cornerRadius: 8 }, containerColor: bg, padding: { left: 18, right: 18, top: 9, bottom: 9 }, onClick: onClick }, [
      UI.Row({ horizontalArrangement: 'center', verticalAlignment: 'center', spacing: 5 }, [
        UI.Icon({ name: icon, tint: fg, size: 15 }),
        UI.Text({ text: label, style: 'labelMedium', color: fg, fontWeight: 'bold' }),
      ]),
    ]);
  }
  items.push(UI.Row({ fillMaxWidth: true, horizontalArrangement: 'center' }, [
    actionBtn(busyState[0] ? (busyLabelState[0] || '处理中...') : '检查状态', 'refresh', colors.primary, colors.onPrimary, checkStatus),
    UI.Spacer({ width: 22 }),
    actionBtn(busyState[0] ? (busyLabelState[0] || '处理中...') : '安装依赖', 'download', colors.primaryContainer, colors.primary, doInstall),
    UI.Spacer({ width: 22 }),
    actionBtn(busyState[0] ? (busyLabelState[0] || '处理中...') : '重启 Worker', 'restart_alt', colors.tertiaryContainer, colors.tertiary, doRestart),
  ]));
  items.push(UI.Spacer({ height: 10 }));
  items.push(UI.Row({ fillMaxWidth: true, horizontalArrangement: 'center' }, [
    actionBtn(logLoadingState[0] ? '加载中...' : '查看日志', 'receipt_long', colors.secondaryContainer, colors.secondary, loadLogs),
    UI.Spacer({ width: 22 }),
    actionBtn('诊断', 'bug_report', colors.errorContainer, colors.error, runDiagnosis),
  ]));
  items.push(UI.Spacer({ height: 8 }));

  // 诊断长文本统一截断：超长只显示前 maxLen 字符，末尾提示完整长度（完整内容可用「查看日志」）
  function truncateDiag(text, maxLen) {
    var s = String(text || '');
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '\n…（已截断，共 ' + s.length + ' 字符，完整内容请用「查看日志」）';
  }

  // 插件侧诊断展示（worker 未运行时也有用）
  var dg = diagState[0];
  if (dg) {
    items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceContainerHigh, padding: 12 }, [
      UI.Column({ spacing: 4 }, [
        UI.Text({ text: dg.running ? '诊断中...' : '插件侧诊断（不经 Worker）', style: 'labelMedium', fontWeight: 'bold', color: colors.primary }),
      ]),
    ]));
    items.push(UI.Spacer({ height: 8 }));
    // 内容块独立平铺（Column children 不支持嵌套数组，三目返回数组会被忽略）
    if (dg && !dg.running) {
      var dgItems = [];
      if (dg.error) {
        dgItems.push(UI.Text({ text: dg.error, style: 'labelSmall', color: colors.error }));
      } else {
        dgItems.push(UI.Text({ text: 'Worker 进程: ' + (dg.worker_up ? '运行中 (' + (dg.process_count || 0) + ' 个)' : '未运行'), style: 'labelSmall', color: dg.worker_up ? '#4CAF50' : colors.error }));
        if (dg.pids && dg.pids.length) dgItems.push(UI.Text({ text: 'PID: ' + dg.pids.join(', '), style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }));
        if (dg.env && dg.env.py) dgItems.push(UI.SelectionContainer({ fillMaxWidth: true }, [ UI.Text({ text: '环境: ' + truncateDiag(dg.env.py, 300), style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) ]));
        if (dg.tmp_log_tail) dgItems.push(UI.SelectionContainer({ fillMaxWidth: true }, [ UI.Text({ text: '启动日志(/tmp/engine_worker.log):\n' + truncateDiag(dg.tmp_log_tail, 1200), style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) ]));
        if (dg.engine_log_tail) dgItems.push(UI.SelectionContainer({ fillMaxWidth: true }, [ UI.Text({ text: 'engine.log 尾部:\n' + truncateDiag(dg.engine_log_tail, 1200), style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) ]));
        if (dg.front_cache) dgItems.push(UI.SelectionContainer({ fillMaxWidth: true }, [ UI.Text({ text: '前端诊断(DBG_UI_CACHE):\n' + truncateDiag(dg.front_cache, 1200), style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) ]));
        if (dg.messages && dg.messages.length) dgItems.push(UI.Text({ text: '诊断信息: ' + truncateDiag(dg.messages.join('; '), 500), style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }));
        if (!dg.worker_up && !dg.tmp_log_tail && !dg.engine_log_tail && !(dg.messages && dg.messages.length)) dgItems.push(UI.Text({ text: '（无诊断数据）', style: 'labelSmall', color: colors.onSurfaceVariant }));
      }
      if (dgItems.length) {
        items.push(UI.Surface({ fillMaxWidth: true, shape: { cornerRadius: 10 }, containerColor: colors.surfaceContainerHigh, padding: 12 }, [
          UI.Column({ spacing: 4 }, dgItems),
        ]));
        items.push(UI.Spacer({ height: 8 }));
      }
    }
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
              containerColor: active ? colors.primary : colors.surfaceContainerHigh,
              padding: { left: 8, right: 8, top: 3, bottom: 3 },
              onClick: function () {
                logFilterState[1](f[0]);
                logState[1](null);
                return loadLogs();
              }
            }, [
              UI.Text({ text: f[1], style: 'labelSmall', color: active ? colors.onPrimary : colors.onSurface, fontWeight: active ? 'bold' : 'normal' }),
            ]);
          }),
          // 复制日志：compose DSL 无剪贴板 API（ctx.setClipboard 不存在），改为长按选中提示
          (lg.lines && lg.lines.length) ? UI.Surface({
            shape: { cornerRadius: 6 },
            containerColor: colors.tertiaryContainer,
            padding: { left: 8, right: 8, top: 3, bottom: 3 },
            onClick: function () {
              toast('长按下方日志文本可选中复制（' + lg.lines.length + ' 行）');
            }
          }, [
            UI.Text({ text: '复制', style: 'labelSmall', color: colors.tertiary, fontWeight: 'bold' }),
          ]) : null,
        ]),
        lg.error
          ? UI.Text({ text: lg.error, style: 'labelSmall', color: colors.error })
          : (lg.lines && lg.lines.length
            ? UI.SelectionContainer({ fillMaxWidth: true }, [
                UI.Text({ text: lg.lines.slice(-100).join('\n'), style: 'bodySmall', color: colors.onSurfaceVariant, fontFamily: 'monospace', fontSize: 10 }),
              ])
            : UI.Text({ text: '暂无日志', style: 'labelSmall', color: colors.onSurfaceVariant })),
        (lg.lines && lg.lines.length > 100) ? UI.Text({ text: '共 ' + lg.lines.length + ' 行，仅显示最近 100 行', style: 'labelSmall', color: colors.onSurfaceVariant, fontSize: 10 }) : null,
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
        StatusRow('重复进程', !st.dup_count, st.dup_count > 0 ? ('发现 ' + st.dup_count + ' 个重复进程') : '无'),
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
      UI.Text({ text: '首次运行：请点击「安装依赖」初始化运行环境（系统 python3 创建 venv + 安装依赖，需几分钟），完成后点击「检查状态」验证，Worker 会自动拉起。', style: 'labelSmall', color: colors.error }),
    ]));
  }

  return items;
}

var firstRunHint = true;

exports.render = render;

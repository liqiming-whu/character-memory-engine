"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;

var index_ui_js_1 = __importDefault(require("./ui/memory_system_ui/screen.js"));

// ===== Worker 部署与启动 =====
// 复用真机已验证的部署：代码在 /sdcard/Download/character_memory_engine，
// venv 在 /root/.venv，模型在 models/。
var ENGINE_DIR = '/sdcard/Download/character_memory_engine';
var WORKER_PORT = 8765;

async function ensureWorkerRunning() {
    try {
        // 1) 检查 worker HTTP 是否已在运行
        var ok = await pingWorker();
        if (ok) return true;

        // 2) 启动 worker（后台，用 venv python）
        var cmd = 'cd ' + ENGINE_DIR + ' && nohup /root/.venv/bin/python3 worker.py --port ' + WORKER_PORT + ' > /tmp/engine_worker.log 2>&1 &';
        try {
            await Tools.System.terminal.hiddenExec(cmd, { timeoutMs: 15000 });
        } catch (e) {
            // 无 hiddenExec 时降级
            try {
                var sess = await Tools.System.terminal.create('engine_worker');
                await Tools.System.terminal.exec(sess.sessionId, cmd, 15000);
            } catch (e2) {}
        }

        // 3) 等待 worker 就绪
        for (var i = 0; i < 10; i++) {
            await new Promise(function(res) { setTimeout(res, 1000); });
            if (await pingWorker()) return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

async function pingWorker() {
    try {
        var url = 'http://127.0.0.1:' + WORKER_PORT;
        var resp = await Tools.Net.http({
            url: url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'ping_worker', params: {} }),
            connect_timeout: 3000,
            read_timeout: 5000
        });
        var body = '';
        if (typeof resp === 'string') body = resp;
        else if (resp && resp.body) body = resp.body;
        else if (resp && resp.content) body = resp.content;
        return body && body.indexOf('"success"') >= 0;
    } catch (e) {
        return false;
    }
}

function registerToolPkg() {
    // 侧边栏 UI 模块（复用前端）
    ToolPkg.registerToolboxUiModule({
        id: "memory_engine_ui",
        runtime: "compose_dsl",
        screen: index_ui_js_1.default,
        params: {},
        title: { zh: "记忆引擎", en: "Memory Engine" }
    });

    ToolPkg.registerNavigationEntry({
        id: "memory_engine_nav",
        route: "toolpkg:com.operit.character_memory_engine:ui:memory_engine_ui",
        surface: "main_sidebar_plugins",
        title: { zh: "记忆引擎", en: "Memory Engine" },
        icon: "memory",
        order: 51
    });

    // 应用创建时尝试启动 worker
    ToolPkg.registerAppLifecycleHook({
        id: "memory_engine_worker_start",
        event: "application_on_create",
        function: function() {
            ensureWorkerRunning().then(function(ok) {
                try { setEnv('MEMORY_ENGINE_WORKER_READY', ok ? '1' : '0'); } catch (e) {}
            }).catch(function() {});
            return { ok: true };
        }
    });

    return true;
}

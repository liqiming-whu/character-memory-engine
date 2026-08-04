"use strict";
/*
METADATA
{
    "name": "memory_engine",
    "display_name": { "zh": "角色记忆引擎工具", "en": "Character Memory Engine Tools" },
    "description": { "zh": "SQLite 记忆 CRUD、语义去重、语义检索（经 Worker HTTP 桥接）", "en": "SQLite memory CRUD, semantic dedup, semantic search via Worker HTTP" },
    "tools": [
        { "name": "list_memories", "description": { "zh": "列出记忆", "en": "List memories" }, "parameters": [
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID；传则隔离，不传仅通用记忆" },
            { "name": "category", "type": "string", "required": false, "description": "分类过滤" },
            { "name": "query", "type": "string", "required": false, "description": "关键词模糊搜索" },
            { "name": "limit", "type": "integer", "required": false, "description": "最大返回数，默认200" },
            { "name": "offset", "type": "integer", "required": false, "description": "偏移" },
            { "name": "include_deleted", "type": "boolean", "required": false, "description": "包含软删除" }
        ]},
        { "name": "get_memory", "description": { "zh": "获取单条记忆", "en": "Get single memory" }, "parameters": [
            { "name": "id", "type": "integer", "required": true, "description": "记忆ID" }
        ]},
        { "name": "create_memory", "description": { "zh": "新建记忆（含语义去重）", "en": "Create memory (with semantic dedup)" }, "parameters": [
            { "name": "category", "type": "string", "required": true, "description": "分类" },
            { "name": "title", "type": "string", "required": false, "description": "标题" },
            { "name": "content", "type": "string", "required": false, "description": "内容" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "update_memory", "description": { "zh": "更新记忆", "en": "Update memory" }, "parameters": [
            { "name": "id", "type": "integer", "required": true, "description": "记忆ID" }
        ]},
        { "name": "delete_memory", "description": { "zh": "软删除记忆", "en": "Soft delete memory" }, "parameters": [
            { "name": "id", "type": "integer", "required": true, "description": "记忆ID" }
        ]},
        { "name": "search_memories", "description": { "zh": "语义检索记忆", "en": "Semantic search memories" }, "parameters": [
            { "name": "query", "type": "string", "required": true, "description": "检索词" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" },
            { "name": "category", "type": "string", "required": false, "description": "分类过滤" },
            { "name": "limit", "type": "integer", "required": false, "description": "最大返回数，默认20" }
        ]},
        { "name": "load_life_data", "description": { "zh": "加载六类生活数据", "en": "Load six life data categories" }, "parameters": [
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "upsert_life_item", "description": { "zh": "新增/更新六类条目", "en": "Upsert life data item" }, "parameters": [
            { "name": "category", "type": "string", "required": true, "description": "分类" },
            { "name": "item", "type": "object", "required": true, "description": "条目对象" },
            { "name": "index", "type": "integer", "required": false, "description": "更新索引" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "delete_life_item", "description": { "zh": "删除六类条目", "en": "Delete life data item" }, "parameters": [
            { "name": "category", "type": "string", "required": true, "description": "分类" },
            { "name": "index", "type": "integer", "required": true, "description": "索引" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "toggle_todo", "description": { "zh": "切换待办状态", "en": "Toggle todo status" }, "parameters": [
            { "name": "index", "type": "integer", "required": true, "description": "索引" },
            { "name": "character_id", "type": "string", "required": false, "description": "角色卡ID" }
        ]},
        { "name": "list_characters", "description": { "zh": "列出角色", "en": "List characters" }, "parameters": []},
        { "name": "save_character", "description": { "zh": "保存角色", "en": "Save character" }, "parameters": [
            { "name": "id", "type": "string", "required": true, "description": "角色卡ID" },
            { "name": "name", "type": "string", "required": true, "description": "角色名" }
        ]},
        { "name": "get_relationship", "description": { "zh": "获取关系", "en": "Get relationship" }, "parameters": [
            { "name": "character_id", "type": "string", "required": true, "description": "角色卡ID" },
            { "name": "target", "type": "string", "required": true, "description": "关系对象" }
        ]},
        { "name": "import_legacy_backup", "description": { "zh": "从旧版本备份导入数据（ZIP或目录），幂等", "en": "Import data from legacy backup (zip or dir), idempotent" }, "parameters": [
            { "name": "path", "type": "string", "required": true, "description": "备份ZIP路径或目录" },
            { "name": "character_id", "type": "string", "required": false, "description": "导入到指定角色；不传则通用" }
        ]},
        { "name": "save_relationship", "description": { "zh": "保存关系", "en": "Save relationship" }, "parameters": [
            { "name": "character_id", "type": "string", "required": true, "description": "角色卡ID" },
            { "name": "target", "type": "string", "required": true, "description": "关系对象" },
            { "name": "stage", "type": "string", "required": false, "description": "关系阶段" },
            { "name": "notes", "type": "string", "required": false, "description": "备注" }
        ]},
        { "name": "ping_worker", "description": { "zh": "检查 worker 是否可用", "en": "Check worker availability" }, "parameters": []}
    ]
}
*/
const TOOLS = ["list_memories", "get_memory", "create_memory", "update_memory", "delete_memory",
               "search_memories", "load_life_data", "upsert_life_item", "delete_life_item",
               "toggle_todo", "list_characters", "save_character", "get_relationship",
               "save_relationship", "import_legacy_backup", "ping_worker"];

// Worker HTTP 地址（可经 env 覆盖）
function workerUrl() {
    var u = '';
    try { u = getEnv('MEMORY_ENGINE_WORKER_URL') || ''; } catch (e) {}
    return u || 'http://127.0.0.1:8765';
}

// 调 worker：POST JSON { action, params }
async function callEngine(action, params) {
    var url = workerUrl();
    try {
        var response = await Tools.Net.http({
            url: url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: action, params: params || {} }),
            connect_timeout: 5000,
            read_timeout: 60000,
            ignore_ssl: true
        });
        var body = '';
        if (typeof response === 'string') body = response;
        else if (response && response.body) body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
        else if (response && response.content) body = response.content;
        if (!body) return { success: false, message: 'worker 无响应' };
        return JSON.parse(body);
    } catch (e) {
        return { success: false, message: 'worker 调用失败: ' + (e.message || String(e)), action: action };
    }
}

// 动态导出工具（每个 action 一个 exports 函数）
for (var i = 0; i < TOOLS.length; i++) {
    (function(action) {
        exports[action] = async function (params) {
            try {
                var result = await callEngine(action, params || {});
                complete(result);
            } catch (e) {
                complete({ success: false, message: e.message || String(e) });
            }
        };
    })(TOOLS[i]);
}

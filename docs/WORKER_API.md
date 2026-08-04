# Worker CRUD 接口规范（memory_engine: 命名空间）

> 更新时间：2026-08-04
> 状态：P1 设计定稿

## 1. 设计原则

前端消费模式：**前端拿全量六类数组，在客户端 filter/slice**（overview/timeline/todos 均如此）。
因此 worker 接口以「按 character_id + category 返回数组」为主，不做复杂服务端分页；批量操作用分类维度。

所有接口：
- 命名空间 `memory_engine:`（命名空间乙）
- JSON 通信（插件 `ctx.callTool` → 插件桥 → worker 返回 JSON）
- 角色隔离：参数带 `character_id`，worker 端强制过滤
- 通用响应：`{ success, message?, data? }` 或 `{ success, ...业务字段 }`

## 2. 工具清单

### 2.1 记忆 CRUD（memories 表）

**`memory_engine:list_memories`** — 列表
```
params: { character_id?, category?, query?, limit?, offset?, include_deleted? }
返回: { success, memories: [{...row}], total, category, character_id }
```
- `category` 传则按分类过滤；不传返回全部
- `query` 模糊匹配 title/content/description
- `character_id` 传则隔离；不传仅返回 `character_id IS NULL`（通用记忆）
- `limit`/`offset` 分页（默认 limit 200，覆盖前端全量需求）

**`memory_engine:get_memory`** — 单条
```
params: { id }
返回: { success, memory: {...} }
```

**`memory_engine:create_memory`** — 新建（含语义去重）
```
params: { category, title?, content?, description?, character_id?, ...字段 }
返回: { success, memory: {...}, deduped: bool }
```
- 先按 `semantic_hash`（归一化 title+content+category）查重，命中则更新
- 方案 A 可加向量去重（P4）
- 返回 `deduped` 标识是否合并

**`memory_engine:update_memory`** — 更新
```
params: { id, ...字段 }
返回: { success, memory: {...} }
```

**`memory_engine:delete_memory`** — 删除（软删除）
```
params: { id }
返回: { success, id }
```
- 软删除：`is_deleted=1`

**`memory_engine:bulk_update_memories`** — 批量
```
params: { character_id?, category?, ids?: [], patch: {...} }
返回: { success, updated: n }
```
- `ids` 指定批量；不传则按 category 批量

**`memory_engine:bulk_delete_memories`** — 批量软删除
```
params: { character_id?, category?, ids?: [] }
返回: { success, deleted: n }
```

### 2.2 六类生活数据（前端兼容）

前端 `allData` 需要 `{ events:[], contacts:[], info:[], finance:[], todos:[], menstrual:[] }` 数组结构。

**`memory_engine:load_life_data`** — 一次取全部六类
```
params: { character_id? }
返回: { success, extracted: { events:[], todos:[], contacts:[], info:[], finance:[], menstrual:[] }, uiState?, injection? }
```
- 对应旧 `load_saved_data` 的 `extracted` 部分
- 前端字段兼容：行 → 前端期望的 JSON 对象（§2.3）

**`memory_engine:upsert_life_item`** — 单条增/改六类
```
params: { character_id?, category, item: {...}, index? }
返回: { success, item, total }
```
- 对应旧 `sync_to_env`/`upsert_extracted_item`：按 index 更新或追加

**`memory_engine:delete_life_item`** — 删六类条目
```
params: { character_id?, category, index }
返回: { success, remaining }
```
- 对应旧 `delete_extracted_item`

**`memory_engine:toggle_todo`** — 切换待办
```
params: { character_id?, index }
返回: { success, todo, completed }
```

### 2.3 字段兼容映射（SQLite 行 → 前端对象）

| SQLite 列 | 前端字段 | 说明 |
|---|---|---|
| category | (数组归属) | events/contacts/... 决定放哪个数组 |
| title/content/description | title/content/description | 直接 |
| type | type | events/finance 共用 |
| date | date | events/finance |
| time | time | events |
| priority | priority | todos |
| completed | completed | todos (bool) |
| importance | importance | events |
| relation | relation | contacts |
| amount | amount | finance (number) |
| start_date/end_date/symptoms | startDate/endDate/symptoms | menstrual (驼峰) |
| extra_json | attributes/contexts/context/mentionCount 等 | contacts 复杂字段，parse 后并入 |
| timestamp | timestamp | = created_at 的 ISO |
| character_id | (角色归属) | 前端可能不用，引擎侧用 |

### 2.4 其他工具

**`memory_engine:get_character`** / **`list_characters`** — 角色
**`memory_engine:save_character`** — 新增/更新角色
**`memory_engine:get_relationship`** / **`save_relationship`** — 关系
**`memory_engine:search_memories`** — 语义检索（方案 A，P4）
**`memory_engine:backup_engine`** / **`restore_engine`** — 备份（P5）

## 3. 通信协议

- worker 通过 HTTP 监听（参考 dual-life-hub）或文件轮询接收 JSON
- 插件侧封装 `callEngine(action, params)` → 写 request JSON → 等 response JSON
- 协议见 worker 实现（P1）

## 4. 错误处理

- 所有接口捕获异常，返回 `{ success: false, message }`
- SQLite 写操作事务包裹
- 重复写入返回 `deduped: true` 不报错

## 5. 验证

- 本机 Python 运行 worker 模块，逐接口测 CRUD/去重/隔离（Task #14）

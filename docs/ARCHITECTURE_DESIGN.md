# 架构设计（P0）

> 更新时间：2026-08-04
> 状态：设计草案，待评审

## 1. 目标

Character Memory Engine 是运行于 Operit 平台的独立角色记忆引擎：
- **复用旧项目前端界面**（`D:\Character-Memory-System` 的 Compose DSL UI 文件）
- **维护相同字段**（前端渲染依赖的六类生活数据 + 角色记忆字段）
- **放弃 Operit 原生记忆库**，改用 **SQLite worker**
- **提供新的增删查改工具包**，替代 `memory_system:` 命名空间

## 2. 前端兼容策略

### 2.1 前端文件直接复用

旧项目 `ui/memory_system_ui/`（概览/待办/时间线/知识/角色/设置 + 联系人/消息 tab）直接复制到 Engine，**UI 文件不改动**（字段、组件、交互保持一致）。

前端通过 `ctx.callTool('memory_system:xxx')` 调用工具。Engine 只需**提供同名同参工具**（挂在 `memory_system:` 命名空间或新命名空间，见 §5），前端即无需改动。

### 2.2 前端依赖的工具接口（需等价实现）

| 工具 | 前端用途 | 关键返回字段 |
|---|---|---|
| `load_saved_data` | 主数据入口 | `extracted`（六类数组）+ `uiState` + `injection` |
| `load_memories` | 记忆列表 | `memories[]` + `total` + `scope` |
| `create_memory` | 新建记忆 | - |
| `delete_memory` | 删记忆 | - |
| `sync_to_env` | 删/改六类条目 | - |
| `toggle_todo` | 切换待办 | - |
| `save_todos` | 保存待办 | - |
| `trigger_analysis` | 自动分析 | - |
| `analyze_saved_messages` | 手动分析 | - |
| `get_persona_context` | 角色上下文 | - |
| `export_backup`/`inspect_backup`/`restore_backup` | 备份 | - |

### 2.3 字段兼容清单（六类生活数据）

前端渲染依赖的字段（worker 表结构必须兼容这些 JSON 字段）：

| 分类 | 字段 |
|---|---|
| events | `type`(activity/schedule/observation/milestone/mood) `title` `description` `importance`(high/medium/low) `date` `time` `timestamp` |
| todos | `title` `description` `priority`(high/medium/low) `dueDate` `completed` `timestamp` |
| contacts | `name` `relation`(family/colleague/classmate/friend/service/other) `attributes[]` `context` `contexts[]` `mentionCount` `lastMentioned` `timestamp` |
| info | `category` `content` `timestamp` |
| finance | `type`(income/expense) `category` `amount` `description` `date` `timestamp` |
| menstrual | `startDate` `endDate` `symptoms` `timestamp` |

角色记忆（四类）：
| 分类 | 字段 |
|---|---|
| character/relationship/preference/interaction_rule | `title` `content` |

## 3. SQLite 数据模型（三表首版）

### 3.1 `memories` 表 —— 记忆主表（含六类 + 角色记忆）

```sql
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 类型与分类
    category TEXT NOT NULL,          -- events/todos/contacts/info/finance/menstrual/character/relationship/preference/interaction_rule
    -- 统一字段（前端渲染兼容）
    title TEXT,
    content TEXT,
    description TEXT,
    -- 分类专属字段
    type TEXT,                       -- events.type / finance.type
    date TEXT,
    time TEXT,
    priority TEXT,
    due_date TEXT,
    completed INTEGER DEFAULT 0,
    importance TEXT,
    relation TEXT,
    start_date TEXT,
    end_date TEXT,
    symptoms TEXT,
    amount REAL,
    -- 结构化 JSON（联系人 attributes/contexts 等复杂字段）
    extra_json TEXT,                 -- 存 attributes/contexts/context 等，保持前端兼容
    -- 角色隔离
    character_id TEXT,               -- 角色卡 ID；NULL = 通用记忆
    -- 时间与来源
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT,                     -- auto/manual/reconciled
    -- 语义去重与向量
    semantic_hash TEXT,              -- 归一化文本 hash（精确去重）
    embedding BLOB,                  -- 512 维向量（方案 A）或 NULL（方案 B）
    is_deleted INTEGER DEFAULT 0     -- 软删除
);
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_character ON memories(character_id);
CREATE INDEX idx_memories_updated ON memories(updated_at);
```

### 3.2 `characters` 表 —— 角色

```sql
CREATE TABLE characters (
    id TEXT PRIMARY KEY,             -- 角色卡 ID
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

### 3.3 `relationships` 表 —— 关系状态

```sql
CREATE TABLE relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id TEXT NOT NULL,      -- 角色隔离
    target TEXT NOT NULL,            -- 关系对象（用户/其他角色）
    stage TEXT,                      -- 关系阶段
    notes TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_relationships_char ON relationships(character_id);
```

### 3.4 embedding 存储

- **方案 A**：`memories.embedding` 存 512 维向量 BLOB；检索用 `sqlite-vec` 的虚拟表
- **方案 B**（备选，无 onnxruntime/sqlite-vec）：`memories.embedding` 为 NULL，检索仅用关键词 + `semantic_hash` 精确去重 + 文本相似度（Jaccard/公共子串）近似语义去重

## 4. Worker 架构

```
        Operit Plugin (ToolPkg)
               |
        JSON API 通信 (Tools.Files 写/读 request/response JSON，或 terminal exec)
               |
     Character Memory Worker (Python 3.12, /root/character_memory_engine/)
        |
   ┌────┼────┐
 Storage  Embedding(方案A)
 SQLite    onnxruntime+BGE
```

- **语言**：Python 3.12（venv `/root/.venv`，与验证一致）
- **部署**：`terminal.hiddenExec` 部署 `worker.py` 到 `/root/character_memory_engine/`，`python3 -m venv` + pip 装依赖
- **通信**：插件 ↔ worker 通过 JSON payload（文件或 stdin/stdout 或 HTTP，参考 dual-life-hub 的 HTTP + JSON payload 模式）
- **Worker 职责**：SQLite CRUD、语义去重、嵌入生成（方案 A）、检索、角色隔离

## 5. 工具包命名

- 新工具挂 `memory_engine:` 命名空间（避免与旧 `memory_system:` 冲突）
- 前端若需零改动复用，可在 main.js 里做**命名空间别名**：`memory_system:xxx` → `memory_engine:xxx` 转发
- 或直接提供与旧接口同名的 `memory_system:` 工具（前端完全无感）

## 6. 语义去重（方案甲：合并）

写入流程：
1. 归一化文本 → `semantic_hash`（精确查重，命中直接更新）
2. 方案 A：算向量 → sqlite-vec 查 top-K → 余弦 ≥ 0.90 判定重复
3. 重复 → **合并**：更新 `updated_at`、提及次数（contacts `mentionCount`），不新增
4. 不重复 → 插入新行

## 7. 开发阶段（更新自原计划）

- P0 已完成：技术验证（TECH_VALIDATION.md）
- P1 数据模型 + Worker 骨架：三表 SQLite + CRUD 接口 + JSON 通信
- P2 语义去重（方案甲）：semantic_hash 精确去重（必做）+ 方案 A 向量去重（可选）
- P3 前端接入：复用旧 UI + 命名空间别名 + 字段兼容
- P4 语义检索（方案 A）：sqlite-vec 向量召回 + 排序
- P5 迁移：从旧 extracted.json / Operit Memory 导入

## 8. 备选方案 B（无 onnxruntime/sqlite-vec）

若方案 A 在真机部署失败（onnxruntime 装不上等）：
- SQLite 仅用标准库 sqlite3（Python 内置）
- 去重：`semantic_hash` 精确 + 文本相似度近似
- 检索：SQL LIKE 关键词 + 时间 + 重要性排序
- 功能降级但架构不变（表结构兼容，embedding 列留 NULL）

## 9. 关键决策记录

- 复用旧前端，维护相同字段（§2）
- 三表首版：memories / characters / relationships（§3）
- 单库 + `character_id` 列隔离（§3.1）
- 语义去重 = 方案甲（合并，§6）
- 首版 Python（§4）
- 方案 B 作为备选（§8）

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Character Memory Engine Worker
==============================
SQLite 数据层 + CRUD + 语义去重 + 角色隔离。

运行方式（Operit proot Ubuntu 24，Python 3.12 venv）:
    python3 worker.py [--port 8765] [--db /path/to/engine.db]

通信协议：HTTP JSON。POST / 携带 {"action": "...", "params": {...}}，
返回 {"success": true, ...} 或 {"success": false, "message": "..."}。

设计参考：dual-life-hub（worker + SQLite + JSON payload），
但本 worker 专注记忆引擎，接口见 docs/WORKER_API.md。
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import time
import traceback
import unicodedata
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ===== 方案 A：向量能力（可选，sqlite-vec + onnxruntime + BGE）=====
# 模型/扩展缺失时自动降级方案 B（文本相似度）
VEC_AVAILABLE = False
_embedder = None

try:
    import sqlite_vec  # noqa: F401
    VEC_AVAILABLE = True
except Exception:
    VEC_AVAILABLE = False

try:
    from embed import Embedder, cosine_sim
    _embedder = None  # 惰性初始化
except Exception:
    _embedder = None

VERSION = "2.1.7"

# 路径：支持环境变量/参数覆盖。
# 数据目录（engine.db / logs / backups）默认放 /sdcard/Download/Operit/character_memory_engine
# （Operit 规范：数据在 Operit 根目录下，用户无需 root 即可访问）；models 只读，留在脚本目录或 /root。
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get(
    "MEMORY_ENGINE_DATA_DIR",
    "/sdcard/Download/Operit/character_memory_engine",
)
DB_PATH = os.environ.get("MEMORY_ENGINE_DB", os.path.join(DATA_DIR, "engine.db"))
# 当前活动库路径：main() 启动时由 --db 参数覆盖（如 /root/character_memory_engine/engine.db），
# deploy_status 用它报告真实读写路径（默认 DATA_DIR 只是 sdcard 部署副本）
ACTIVE_DB_PATH = DB_PATH
MODEL_DIR = os.environ.get("MEMORY_ENGINE_MODEL_DIR", "")
if not MODEL_DIR or not os.path.exists(MODEL_DIR):
    _local_models = os.path.join(_SCRIPT_DIR, "models")
    if os.path.exists(_local_models):
        MODEL_DIR = _local_models
    else:
        MODEL_DIR = "/root/character_memory_engine/models"

# 向量去重阈值（方案 A）：余弦 ≥ 0.9 判重复
VEC_DEDUP_THRESHOLD = 0.9

# ===== 分类定义 =====
LIFE_CATEGORIES = ["events", "todos", "contacts", "info", "finance", "menstrual"]
ROLE_CATEGORIES = ["character", "relationship", "preference", "interaction_rule"]
ALL_CATEGORIES = LIFE_CATEGORIES + ROLE_CATEGORIES


# ===== 日志 =====
# 写 <数据目录>/logs/engine.log（真机：/sdcard/Download/Operit/character_memory_engine/logs/engine.log）。
# 参考 dual-life-hub：纯 append 不轮转，保证历史完整可查。
_LOG_LOCK = threading.Lock()
LOG_PATH = os.environ.get("MEMORY_ENGINE_LOG", os.path.join(DATA_DIR, "logs", "engine.log"))


def log(level, msg):
    """写日志文件（线程安全、纯追加，保留全部历史），同时写 stderr 保留 /tmp 次要捕获。"""
    line = "%s %-5s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), str(level).upper(), msg)
    try:
        with _LOG_LOCK:
            os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line)
        sys.stderr.write(line)
    except Exception:
        pass  # 日志失败不影响主流程


# ===== 数据库 =====
def get_conn(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    # FAT/exFAT 文件系统不支持 WAL（返回 journal_mode=delete），ext4 用 WAL 提升并发
    try:
        mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        if mode != "wal":
            conn.execute("PRAGMA journal_mode=DELETE")
    except Exception:
        pass
    conn.execute("PRAGMA foreign_keys=ON")
    # 加载 sqlite-vec 扩展（方案 A）
    if VEC_AVAILABLE:
        try:
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
        except Exception:
            pass
    return conn


def get_embedder():
    """惰性初始化 BGE embedder；模型缺失返回 None（降级方案 B）。"""
    global _embedder
    if _embedder is not None:
        return _embedder
    if not VEC_AVAILABLE:
        return None
    try:
        if not os.path.exists(os.path.join(MODEL_DIR, "model_int8.onnx")):
            return None
        _embedder = Embedder(MODEL_DIR)
        return _embedder
    except Exception as e:
        log("WARN", "embedder init failed: %s" % str(e))
        return None


SCHEMA = """
CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id TEXT NOT NULL,
    target TEXT NOT NULL,
    stage TEXT,
    notes TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_char ON relationships(character_id);

CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT,
    content TEXT,
    description TEXT,
    type TEXT,
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
    extra_json TEXT,
    character_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT,
    semantic_hash TEXT,
    embedding BLOB,
    is_deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_mem_character ON memories(character_id);
CREATE INDEX IF NOT EXISTS idx_mem_updated ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_mem_hash ON memories(semantic_hash);

-- 方案 A：向量虚拟表（sqlite-vec），rowid 对应 memories.id，cosine 度量
CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding float[512] distance_metric=cosine);
"""


def init_db(db_path):
    conn = get_conn(db_path)
    # executescript 遇 vec0 不可用会抛异常，先逐表建基础表，vec0 单独容错
    for stmt in [s for s in SCHEMA.split(";") if s.strip() and not s.strip().startswith("CREATE VIRTUAL")]:
        try:
            conn.execute(stmt)
        except Exception:
            conn.rollback()
    conn.commit()
    # vec0 虚拟表：可用则建，不可用静默降级（后续向量能力 VEC_AVAILABLE 为 False）
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding float[512] distance_metric=cosine)")
        conn.execute("SELECT COUNT(*) FROM vec_items")
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    conn.close()


# ===== 文本归一化与精确去重 =====
def normalize_text(text):
    """归一化：NFKC、去空白、去标点、小写。用于精确去重 hash。"""
    s = unicodedata.normalize("NFKC", str(text or ""))
    s = s.lower()
    s = re.sub(r"[\s\.,，。！？、：:；;（）()\[\]{}<>\"'「」『』“”‘’]+", "", s)
    return s


def escape_like(s):
    """转义 LIKE 通配符 % _，使查询按字面匹配。"""
    return (str(s or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_"))


def semantic_hash(category, title, content, character_id):
    """精确去重 hash：归一化 category+title+content+character_id。"""
    text = "|".join([category, normalize_text(title), normalize_text(content), str(character_id or "")])
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


# ===== 文本相似度（方案 B 近似语义去重）=====
def text_similarity(a, b):
    """基于字符 n-gram Jaccard + 公共字符 + 包含关系的混合相似度，返回 0~1。"""
    a = normalize_text(a)
    b = normalize_text(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # 字符 2-gram Jaccard
    def ngrams(s, n):
        return {s[i:i+n] for i in range(len(s) - n + 1)} if len(s) >= n else {s}
    ga = ngrams(a, 2)
    gb = ngrams(b, 2)
    inter = len(ga & gb)
    union = len(ga | gb)
    jaccard = inter / union if union else 0.0
    # 公共字符比例（多集）：中文近义句通常共享大量字符
    from collections import Counter
    ca = Counter(a)
    cb = Counter(b)
    common_chars = sum((ca & cb).values())
    char_ratio = common_chars / max(len(a), len(b), 1)
    # 长度比
    lmin = min(len(a), len(b))
    lmax = max(len(a), len(b))
    len_ratio = lmin / lmax if lmax else 0.0
    # 包含关系（短串是长串子串）
    contain = 0.0
    if len(a) <= len(b):
        if a in b:
            contain = len(a) / len(b)
    else:
        if b in a:
            contain = len(b) / len(a)
    # 加权混合：公共字符为主（对中文近义敏感），Jaccard 补充
    score = 0.5 * char_ratio + 0.3 * jaccard + 0.1 * len_ratio + 0.1 * contain
    if contain > 0.5:
        score = max(score, 0.6 * contain + 0.4 * char_ratio)
    return max(0.0, min(1.0, score))


# ===== 语义去重阈值 =====
# 方案 B（文本相似度）近似去重阈值：中文近似句通常 0.6-0.85，无关句 <0.3
# 0.7 在「近似合并」与「无关分离」间取平衡；可配置
DEDUP_SIM_THRESHOLD = 0.7


def dedup_similar(conn, category, title, content, character_id, threshold=None):
    """近似语义去重：与库内同分类条目比对，返回最相似的已有记忆或 None。

    返回 (existing_row, similarity)。"""
    if threshold is None:
        threshold = DEDUP_SIM_THRESHOLD
    if not title and not content:
        return None, 0.0
    probe = (title or "") + " " + (content or "")
    rows = conn.execute(
        "SELECT * FROM memories WHERE category=? AND is_deleted=0"
        + (" AND character_id=?" if character_id else " AND (character_id IS NULL OR character_id='')"),
        ([category] + [str(character_id)] if character_id else [category]),
    ).fetchall()
    best = None
    best_score = 0.0
    for row in rows:
        existing = (row["title"] or "") + " " + (row["content"] or "")
        score = text_similarity(probe, existing)
        if score > best_score:
            best_score = score
            best = row
    if best and best_score >= threshold:
        return best, best_score
    return None, best_score


def vec_dedup(conn, category, title, content, character_id):
    """方案 A：用 BGE 向量查库内近邻，余弦 >= VEC_DEDUP_THRESHOLD 判重复。

    返回最相似的已有记忆行或 None。"""
    if not VEC_AVAILABLE:
        return None
    embedder = get_embedder()
    if embedder is None:
        return None
    probe = (title or "") + " " + (content or "")
    try:
        vec = embedder.embed(probe, is_query=False)
        vec_str = "[" + ",".join(f"{v:.6f}" for v in vec) + "]"
        # 查 vec0 近邻（注意：vec0 不分角色，需在 memories 里二次过滤）
        rows = conn.execute(
            "SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k=20",
            (vec_str,),
        ).fetchall()
        best_id = None
        best_score = 0.0
        for r in rows:
            dist = float(r["distance"])
            sim = 1.0 - dist  # vec0 cosine metric：distance 即余弦距离
            if sim < best_score:
                continue
            # 过滤分类与角色隔离
            mem = conn.execute(
                "SELECT * FROM memories WHERE id=? AND is_deleted=0",
                (r["rowid"],),
            ).fetchone()
            if not mem:
                continue
            if mem["category"] != category:
                continue
            if character_id:
                if mem["character_id"] != character_id:
                    continue
            else:
                if mem["character_id"]:
                    continue
            best_score = sim
            best_id = r["rowid"]
        if best_id is not None and best_score >= VEC_DEDUP_THRESHOLD:
            return conn.execute("SELECT * FROM memories WHERE id=?", (best_id,)).fetchone()
        return None
    except Exception as e:
        log("WARN", "vec_dedup error: %s" % str(e))
        return None


def search_memories(conn, params):
    """语义检索：query 向量 + 关键词 + 角色过滤，返回排序结果。
    方案 A：向量近邻为主；方案 B（无向量）：仅关键词。
    """
    character_id = params.get("character_id")
    category = params.get("category")
    query = params.get("query") or ""
    limit = int(params.get("limit") or 20)
    exclude_ids = params.get("exclude_ids")
    if not query:
        return {"success": True, "memories": [], "total": 0}

    results = []
    embedder = get_embedder()
    if embedder is not None:
        try:
            vec = embedder.embed(query, is_query=True)
            vec_str = "[" + ",".join(f"{v:.6f}" for v in vec) + "]"
            # 候选池全量取回（当前库规模 <200 条）：先取回全部近邻再做角色/分类过滤，
            # 避免全局技术噪音霸占近邻名额、角色库记忆被挤出
            k = max(limit * 50, 200)
            rows = conn.execute(
                "SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k=?", (vec_str, k),
            ).fetchall()
            for r in rows:
                mem = conn.execute(
                    "SELECT * FROM memories WHERE id=? AND is_deleted=0", (r["rowid"],),
                ).fetchone()
                if not mem:
                    continue
                if character_id:
                    if mem["character_id"] != character_id:
                        continue
                else:
                    if mem["character_id"]:
                        continue
                if category and mem["category"] != category:
                    continue
                sim = 1.0 - float(r["distance"])
                results.append((sim, mem))
            results.sort(key=lambda x: -x[0])
        except Exception as e:
            log("WARN", "search vec error: %s" % str(e))

    # 无向量或结果不足时，关键词兜底
    if not results:
        like = "%" + escape_like(query) + "%"
        sql = "SELECT * FROM memories WHERE is_deleted=0 AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"
        args = [like, like, like]
        if character_id:
            sql += " AND character_id=?"
            args.append(str(character_id))
        else:
            sql += " AND (character_id IS NULL OR character_id='')"
        if category:
            sql += " AND category=?"
            args.append(str(category))
        rows = conn.execute(sql + " ORDER BY updated_at DESC LIMIT ?", args + [limit]).fetchall()
        results = [(1.0, r) for r in rows]
    # P8② snapshot 跨轮去重：排除指定记忆 id（同一会话已注入过的不再重复注入）
    if exclude_ids:
        ex = [str(x) for x in exclude_ids]  # 保持注入顺序：早 -> 晚
        all_candidates = results  # 排除前的完整候选（已按相似度排序）
        ex_set = set(ex)
        results = [(s, r) for s, r in results if str(r["id"]) not in ex_set]
        # 兜底：排除后候选不足 limit 时，从最早注入的记忆开始释放（按相似度补回），
        # 保证注入永不因"角色库记忆全部被排除"而返回空；新记忆优先，旧记忆轮换复用
        if len(results) < limit and len(ex) > 0:
            remaining = {str(r["id"]) for _s, r in results}
            for eid in ex:
                if len(results) >= limit:
                    break
                if eid in remaining:
                    continue
                for s, r in all_candidates:
                    if str(r["id"]) == eid:
                        results.append((s, r))
                        remaining.add(eid)
                        break
            results.sort(key=lambda x: -x[0])  # 补回后按相似度重新排序
    results = results[:limit]
    log("INFO", "search_memories q=%s card=%s ex=%d -> %d/%d" % (
        (query or "")[:30], str(params.get("character_id") or "(空)")[:36],
        len(exclude_ids) if exclude_ids else 0, len(results), params.get("limit") or 0))
    return {"success": True, "memories": [row_to_obj(r) for _s, r in results], "total": len(results)}


# ===== 行 <-> 前端对象映射 =====
# 前端期望的 JSON 字段（驼峰），与旧 memory_system 一致
ROW_TO_FRONT = {
    "type": "type",
    "date": "date",
    "time": "time",
    "priority": "priority",
    "due_date": "dueDate",
    "completed": "completed",
    "importance": "importance",
    "relation": "relation",
    "start_date": "startDate",
    "end_date": "endDate",
    "symptoms": "symptoms",
    "amount": "amount",
}


def row_to_obj(row):
    """SQLite 行 -> 前端 JSON 对象（兼容旧字段）。"""
    d = {
        "id": row["id"],
        "category": row["category"],
        "title": row["title"],
        "content": row["content"],
        "description": row["description"],
        "timestamp": row["created_at"],  # 前端用 timestamp
        "source": row["source"],
        "updatedAt": row["updated_at"],
    }
    # 分类专属字段
    for sql_col, front_key in ROW_TO_FRONT.items():
        v = row[sql_col]
        if v is not None:
            d[front_key] = v
    # completed 布尔化
    if "completed" in d:
        d["completed"] = bool(d["completed"])
    # contacts 复杂字段
    if row["extra_json"]:
        try:
            extra = json.loads(row["extra_json"])
            for k, v in extra.items():
                d[k] = v
        except Exception:
            pass
    # 角色四类只需 title/content
    return d


def obj_to_row(obj):
    """前端 JSON 对象 -> SQLite 列（拆出专属字段，其余进 extra_json）。"""
    row = {}
    for front_key, sql_col in {v: k for k, v in ROW_TO_FRONT.items()}.items():
        if front_key in obj and obj[front_key] is not None:
            row[sql_col] = obj[front_key]
    # completed -> int
    if "completed" in row:
        row["completed"] = 1 if row["completed"] else 0
    # 提取基础字段
    base = ["title", "content", "description"]
    for k in base:
        if k in obj:
            row[k] = obj[k]
    # 额外字段（attributes/contexts/context 等）进 extra_json
    known = set(ROW_TO_FRONT.keys()) | set(ROW_TO_FRONT.values()) | set(base) | {"id", "category", "timestamp", "character_id"}
    extra = {k: v for k, v in obj.items() if k not in known}
    if extra:
        row["extra_json"] = json.dumps(extra, ensure_ascii=False)
    return row


# ===== CRUD =====
def list_memories(conn, params):
    character_id = params.get("character_id")
    category = params.get("category")
    query = params.get("query")
    limit = int(params.get("limit") or 200)
    offset = int(params.get("offset") or 0)
    include_deleted = bool(params.get("include_deleted"))

    sql = "SELECT * FROM memories WHERE 1=1"
    args = []
    if not include_deleted:
        sql += " AND is_deleted=0"
    if character_id:
        sql += " AND character_id=?"
        args.append(str(character_id))
    else:
        sql += " AND (character_id IS NULL OR character_id='')"
    if category:
        sql += " AND category=?"
        args.append(str(category))
    if query:
        like = "%" + escape_like(query) + "%"
        sql += " AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"
        args += [like, like, like]
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    args += [limit, offset]

    rows = conn.execute(sql, args).fetchall()
    total = conn.execute(
        "SELECT COUNT(*) FROM memories WHERE 1=1" +
        (" AND is_deleted=0" if not include_deleted else "") +
        (" AND character_id=?" if character_id else " AND (character_id IS NULL OR character_id='')") +
        (" AND category=?" if category else ""),
        ([str(character_id)] if character_id else []) + ([str(category)] if category else [])
    ).fetchone()[0]
    return {"success": True, "memories": [row_to_obj(r) for r in rows], "total": total, "category": category, "character_id": character_id}


def get_memory(conn, params):
    mid = params.get("id")
    # 软删除仅标记（设计契约）：get 仍返回，由调用方决定是否显示
    row = conn.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
    if not row:
        return {"success": False, "message": "memory not found"}
    return {"success": True, "memory": row_to_obj(row)}


def create_memory(conn, params):
    category = params.get("category") or "info"
    if category not in ALL_CATEGORIES:
        return {"success": False, "message": "invalid category: " + category}
    character_id = params.get("character_id") or None
    title = params.get("title")
    content = params.get("content")

    # 语义去重（方案甲：命中则合并更新）
    h = semantic_hash(category, title, content, character_id)
    now = int(time.time() * 1000)
    existing = conn.execute(
        "SELECT * FROM memories WHERE semantic_hash=? AND is_deleted=0", (h,)
    ).fetchone()
    if not existing:
        # 方案 B 近似语义去重：精确 hash 未命中，再比对文本相似度
        existing, _sim = dedup_similar(conn, category, title, content, character_id)
    if not existing:
        # 方案 A 向量去重：文本相似度未命中，用 BGE 向量查库内近邻
        existing = vec_dedup(conn, category, title, content, character_id)
    if existing:
        # 去重命中 → 全字段合并更新（新值覆盖旧值，旧值不丢新值）
        merged = {}
        for key in ["title", "content", "description", "type", "date", "time", "priority",
                    "due_date", "completed", "importance", "relation", "start_date",
                    "end_date", "symptoms", "amount", "extra_json"]:
            new_val = params.get(key)
            old_val = existing[key]
            if new_val is not None and str(new_val) != "":
                merged[key] = new_val
            else:
                merged[key] = old_val
        conn.execute(
            """UPDATE memories SET updated_at=?, title=?, content=?, description=?,
               type=?, date=?, time=?, priority=?, due_date=?, completed=?, importance=?,
               relation=?, start_date=?, end_date=?, symptoms=?, amount=?, extra_json=?
               WHERE id=?""",
            (now, merged["title"], merged["content"], merged["description"],
             merged["type"], merged["date"], merged["time"], merged["priority"],
             merged["due_date"], merged["completed"], merged["importance"],
             merged["relation"], merged["start_date"], merged["end_date"],
             merged["symptoms"], merged["amount"], merged["extra_json"],
             existing["id"]),
        )
        conn.commit()
        # 方案 A：合并后文本变了，刷新向量索引（先删旧向量再插，vec0 对 OR REPLACE 主键支持不一致）
        embedder = get_embedder()
        if embedder is not None:
            try:
                vec = embedder.embed((merged.get("title") or "") + " " + (merged.get("content") or ""), is_query=False)
                vec_str = "[" + ",".join(f"{v:.6f}" for v in vec) + "]"
                conn.execute("DELETE FROM vec_items WHERE rowid=?", (existing["id"],))
                conn.execute("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)", (existing["id"], vec_str))
                conn.commit()
            except Exception as e:
                log("WARN", "dedup embed refresh failed: %s" % str(e))
        row = conn.execute("SELECT * FROM memories WHERE id=?", (existing["id"],)).fetchone()
        return {"success": True, "memory": row_to_obj(row), "deduped": True}

    # 新建
    row = obj_to_row(params)
    conn.execute(
        """INSERT INTO memories
           (category, title, content, description, type, date, time, priority, due_date,
            completed, importance, relation, start_date, end_date, symptoms, amount,
            extra_json, character_id, created_at, updated_at, source, semantic_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            category, row.get("title"), row.get("content"), row.get("description"),
            row.get("type"), row.get("date"), row.get("time"), row.get("priority"),
            row.get("due_date"), row.get("completed", 0), row.get("importance"),
            row.get("relation"), row.get("start_date"), row.get("end_date"),
            row.get("symptoms"), row.get("amount"), row.get("extra_json"),
            character_id, now, now, params.get("source") or "manual", h,
        ),
    )
    conn.commit()
    mid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    # 方案 A：新建后生成向量并存入 vec_items
    embedder = get_embedder()
    if embedder is not None:
        try:
            vec = embedder.embed((title or "") + " " + (content or ""), is_query=False)
            vec_str = "[" + ",".join(f"{v:.6f}" for v in vec) + "]"
            conn.execute("DELETE FROM vec_items WHERE rowid=?", (mid,))
            conn.execute("INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)", (mid, vec_str))
            conn.commit()
        except Exception as e:
            log("WARN", "embed write failed: %s" % str(e))
    row = conn.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
    return {"success": True, "memory": row_to_obj(row), "deduped": False}


def update_memory(conn, params):
    mid = params.get("id")
    row = conn.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
    if not row:
        return {"success": False, "message": "memory not found"}
    # 合并更新：取现有 + params 覆盖
    merged = row_to_obj(row)
    for k, v in params.items():
        if k in ("id", "category", "timestamp", "character_id"):
            continue
        if v is not None:
            merged[k] = v
    new_row = obj_to_row(merged)
    now = int(time.time() * 1000)
    conn.execute(
        """UPDATE memories SET title=?, content=?, description=?, type=?, date=?, time=?,
           priority=?, due_date=?, completed=?, importance=?, relation=?, start_date=?,
           end_date=?, symptoms=?, amount=?, extra_json=?, updated_at=? WHERE id=? AND is_deleted=0""",
        (
            new_row.get("title"), new_row.get("content"), new_row.get("description"),
            new_row.get("type"), new_row.get("date"), new_row.get("time"),
            new_row.get("priority"), new_row.get("due_date"),
            new_row.get("completed", merged.get("completed", 0)),
            new_row.get("importance"), new_row.get("relation"),
            new_row.get("start_date"), new_row.get("end_date"),
            new_row.get("symptoms"), new_row.get("amount"),
            new_row.get("extra_json"), now, mid,
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
    return {"success": True, "memory": row_to_obj(row)}


def delete_memory(conn, params):
    mid = params.get("id")
    conn.execute("UPDATE memories SET is_deleted=1 WHERE id=?", (mid,))
    # 软删同时移除向量索引，避免残留向量干扰去重/检索
    try:
        conn.execute("DELETE FROM vec_items WHERE rowid=?", (mid,))
    except Exception as e:
        log("WARN", "delete vec failed: %s" % str(e))
    conn.commit()
    return {"success": True, "id": mid}


def bulk_update_memories(conn, params):
    ids = params.get("ids")
    patch = params.get("patch") or {}
    now = int(time.time() * 1000)
    if ids:
        updated = 0
        for mid in ids:
            r = get_memory(conn, {"id": mid})
            if r["success"]:
                merged = r["memory"]
                merged.update(patch)
                update_memory(conn, {"id": mid, **merged})
                updated += 1
        return {"success": True, "updated": updated}
    # 无 ids：按 category 批量（必须至少提供 category 或 character_id 之一，防止误全库操作）
    category = params.get("category")
    character_id = params.get("character_id")
    if not category and not character_id:
        return {"success": False, "message": "bulk_update requires ids, category or character_id"}
    sql = "SELECT id FROM memories WHERE is_deleted=0"
    args = []
    if category:
        sql += " AND category=?"
        args.append(category)
    if character_id:
        sql += " AND character_id=?"
        args.append(str(character_id))
    rows = conn.execute(sql, args).fetchall()
    for r in rows:
        m = get_memory(conn, {"id": r["id"]})["memory"]
        m.update(patch)
        update_memory(conn, {"id": r["id"], **m})
    return {"success": True, "updated": len(rows)}


def bulk_delete_memories(conn, params):
    ids = params.get("ids")
    if ids:
        for mid in ids:
            conn.execute("UPDATE memories SET is_deleted=1 WHERE id=?", (mid,))
        conn.commit()
        return {"success": True, "deleted": len(ids)}
    category = params.get("category")
    character_id = params.get("character_id")
    if not category and not character_id:
        return {"success": False, "message": "bulk_delete requires ids, category or character_id"}
    sql = "UPDATE memories SET is_deleted=1 WHERE is_deleted=0"
    args = []
    if category:
        sql += " AND category=?"
        args.append(category)
    if character_id:
        sql += " AND character_id=?"
        args.append(str(character_id))
    cur = conn.execute(sql, args)
    conn.commit()
    return {"success": True, "deleted": cur.rowcount}


# ===== 六类生活数据（前端兼容）=====
def load_life_data(conn, params):
    character_id = params.get("character_id")
    result = {}
    for cat in LIFE_CATEGORIES:
        r = list_memories(conn, {"character_id": character_id, "category": cat, "limit": 5000})
        result[cat] = r["memories"]
    # 附带注入配置与 UI 状态（旧前端期望 load_life_data 一并返回）
    injection = None
    ui_state = None
    ui_path = os.path.join(DATA_DIR, "last_ui_state.json")
    if os.path.exists(ui_path):
        try:
            with open(ui_path, "r", encoding="utf-8") as f:
                ui_data = json.load(f) or {}
            ui_state = ui_data.get("data") if isinstance(ui_data.get("data"), dict) else {}
            injection = ui_state.get("injection") if isinstance(ui_state, dict) else None
        except Exception:
            pass
    return {"success": True, "extracted": result, "injection": injection, "uiState": {"data": ui_state}}


def upsert_life_item(conn, params):
    """对应旧 sync_to_env / upsert_extracted_item：按 category + index 更新或追加。"""
    category = params.get("category")
    if category not in LIFE_CATEGORIES:
        return {"success": False, "message": "invalid category"}
    character_id = params.get("character_id")
    item = params.get("item") or {}
    index = params.get("index")
    now = int(time.time() * 1000)
    rows = conn.execute(
        "SELECT * FROM memories WHERE category=? AND is_deleted=0"
        + (" AND character_id=?" if character_id else " AND (character_id IS NULL OR character_id='')")
        + " ORDER BY updated_at DESC",
        ([category] + [str(character_id)] if character_id else [category]),
).fetchall()

    if index is not None and 0 <= int(index) < len(rows):
        target = rows[int(index)]
        merged = row_to_obj(target)
        merged.update(item)
        update_memory(conn, {"id": target["id"], **merged})
        return {"success": True, "item": merged, "total": len(rows)}

    # 追加（复用 create_memory 的去重逻辑）
    item["category"] = category
    item["character_id"] = character_id
    r = create_memory(conn, item)
    if not r["success"]:
        return r
    return {"success": True, "item": r["memory"], "total": len(rows) + 1}


def delete_life_item(conn, params):
    category = params.get("category")
    index = params.get("index")
    mid = params.get("id")  # 优先按 id 精确删除（前端已改传 id，根治 index 错位）
    character_id = params.get("character_id")
    if mid is not None:
        cur = conn.execute(
            "UPDATE memories SET is_deleted=1 WHERE id=? AND category=? AND is_deleted=0",
            (mid, category),
        )
        conn.commit()
        if cur.rowcount > 0:
            return {"success": True, "id": mid}
        return {"success": False, "message": "memory not found with id=" + str(mid)}
    rows = conn.execute(
        "SELECT id FROM memories WHERE category=? AND is_deleted=0"
        + (" AND character_id=?" if character_id else " AND (character_id IS NULL OR character_id='')")
        + " ORDER BY updated_at DESC",
        ([category] + [str(character_id)] if character_id else [category]),
    ).fetchall()
    if index is None or int(index) < 0 or int(index) >= len(rows):
        return {"success": False, "message": "index out of range"}
    conn.execute("UPDATE memories SET is_deleted=1 WHERE id=?", (rows[int(index)]["id"],))
    conn.commit()
    return {"success": True, "remaining": len(rows) - 1}


def toggle_todo(conn, params):
    index = params.get("index")
    mid = params.get("id")  # 优先按 id 精确勾选（与删除同源修复）
    character_id = params.get("character_id")
    if mid is not None:
        row = conn.execute("SELECT * FROM memories WHERE id=? AND is_deleted=0", (mid,)).fetchone()
        if not row:
            return {"success": False, "message": "memory not found with id=" + str(mid)}
        new_completed = 0 if row["completed"] else 1
        conn.execute("UPDATE memories SET completed=?, updated_at=? WHERE id=?",
                     (new_completed, int(time.time() * 1000), mid))
        conn.commit()
        row2 = conn.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
        return {"success": True, "todo": row_to_obj(row2), "completed": bool(new_completed)}
    rows = conn.execute(
        "SELECT * FROM memories WHERE category='todos' AND is_deleted=0"
        + (" AND character_id=?" if character_id else " AND (character_id IS NULL OR character_id='')")
        + " ORDER BY updated_at DESC",
        ([str(character_id)] if character_id else []),
    ).fetchall()
    if index is None or int(index) < 0 or int(index) >= len(rows):
        return {"success": False, "message": "index out of range"}
    target = rows[int(index)]
    new_completed = 0 if target["completed"] else 1
    conn.execute("UPDATE memories SET completed=?, updated_at=? WHERE id=?",
                 (new_completed, int(time.time() * 1000), target["id"]))
    conn.commit()
    row = conn.execute("SELECT * FROM memories WHERE id=?", (target["id"],)).fetchone()
    obj = row_to_obj(row)
    return {"success": True, "todo": obj, "completed": bool(new_completed)}


# ===== 角色 =====
def list_characters(conn, params):
    rows = conn.execute("SELECT * FROM characters ORDER BY updated_at DESC").fetchall()
    return {"success": True, "characters": [dict(r) for r in rows]}


def save_character(conn, params):
    cid = params.get("id") or params.get("character_id")
    name = params.get("name")
    if not cid or not name:
        return {"success": False, "message": "id and name required"}
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO characters (id, name, created_at, updated_at) VALUES (?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET name=?, updated_at=?",
        (cid, name, now, now, name, now),
    )
    conn.commit()
    return {"success": True, "character": {"id": cid, "name": name, "updated_at": now}}


def get_relationship(conn, params):
    character_id = params.get("character_id")
    target = params.get("target")
    row = conn.execute(
        "SELECT * FROM relationships WHERE character_id=? AND target=?",
        (character_id, target),
    ).fetchone()
    if not row:
        return {"success": True, "relationship": None}
    return {"success": True, "relationship": dict(row)}


def save_relationship(conn, params):
    character_id = params.get("character_id")
    target = params.get("target")
    stage = params.get("stage")
    notes = params.get("notes")
    now = int(time.time() * 1000)
    if not character_id or not target:
        return {"success": False, "message": "character_id and target required"}
    # 显式 upsert：无唯一约束，不能用 ON CONFLICT，先查再插/改
    existing = conn.execute(
        "SELECT id FROM relationships WHERE character_id=? AND target=?",
        (character_id, target),
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE relationships SET stage=?, notes=?, updated_at=? WHERE id=?",
            (stage, notes, now, existing["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO relationships (character_id, target, stage, notes, updated_at) "
            "VALUES (?,?,?,?,?)",
            (character_id, target, stage, notes, now),
        )
    conn.commit()
    return get_relationship(conn, params)


def ping_worker(conn, params):
    return {"success": True, "pong": True, "version": VERSION, "vec_available": VEC_AVAILABLE, "db": conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]}


def log_event(conn, params):
    """插件 JS 侧日志写入同一 engine.log（source=js）。"""
    level = str(params.get("level") or "INFO").upper()
    msg = params.get("message") or params.get("msg") or ""
    if msg:
        log(level, "[js] %s" % msg)
    return {"success": True}


def get_logs(conn, params):
    """读日志文件尾部 N 行，可选按级别过滤，供前端/调试查看。

    纯追加无轮转，直接从主文件读。limit 默认 300，可从尾部回溯较多历史。
    """
    n = int(params.get("limit") or 300)
    level = str(params.get("level") or "").upper()
    path = params.get("path") or LOG_PATH
    try:
        if not os.path.exists(path):
            return {"success": True, "log": [], "path": path, "tail": 0, "size": 0}
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 1024 * 1024))
            tail = f.read()
        lines = tail.splitlines()
        # 若首行是 seek 边界截断的半行，丢弃它（读到的是不完整行）
        if tail and not tail.startswith(lines[0]):
            lines = lines[1:]
        if level:
            lines = [ln for ln in lines if (" %s " % level) in ln]
        return {"success": True, "log": lines[-n:], "path": path, "tail": len(lines[-n:]), "size": size}
    except Exception as e:
        return {"success": False, "message": "read log failed: " + str(e)}


# ===== 部署状态 / 安装 / 重启 =====
def _find_worker_processes():
    """查找本 worker 进程（含重复）。返回 (count, pids)。

    只匹配真正的 python worker 进程：cmdline 同时含 python 与 worker.py。
    优先用 pgrep；不可用时（proot/Termux 常见无 procps）回退 /proc 遍历。
    """
    import subprocess
    import os
    pids = []
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", r"python.*worker\.py"], stderr=subprocess.DEVNULL
        ).decode().strip()
        pids = [p for p in out.split("\n") if p.strip()]
    except Exception:
        pids = []
    if not pids:
        try:
            for pid in os.listdir("/proc"):
                if not pid.isdigit():
                    continue
                try:
                    with open("/proc/%s/cmdline" % pid, "rb") as f:
                        cmd = f.read().replace(b"\0", b" ").decode(errors="ignore")
                    if "worker.py" in cmd and "python" in cmd:
                        pids.append(pid)
                except Exception:
                    pass
        except Exception:
            pass
    return len(pids), pids


def _check_module(mod_name):
    try:
        __import__(mod_name)
        return True
    except Exception:
        return False


def deploy_status(conn, params):
    """检查部署状态：进程/重复/依赖/模型/venv/db/端口。"""
    import importlib.metadata as md
    status = {}
    # venv
    status["venv_ok"] = sys.prefix != sys.base_prefix
    status["venv_path"] = sys.prefix
    # 进程
    count, pids = _find_worker_processes()
    status["worker_running"] = count > 0
    status["worker_pid"] = pids[0] if pids else None
    status["dup_count"] = count - 1 if count > 0 else 0
    # 依赖
    status["onnx_ok"] = _check_module("onnxruntime")
    try:
        status["onnx_ver"] = md.version("onnxruntime") if status["onnx_ok"] else None
    except Exception:
        status["onnx_ver"] = None
    status["sqlite_vec_ok"] = _check_module("sqlite_vec")
    status["tokenizers_ok"] = _check_module("tokenizers")
    # 模型
    model_path = os.path.join(MODEL_DIR, "model_int8.onnx")
    status["model_ok"] = os.path.exists(model_path)
    status["model_path"] = model_path if status["model_ok"] else None
    # 向量
    emb = get_embedder()
    status["vec_available"] = emb is not None
    # db
    db_path = params.get("db") or ACTIVE_DB_PATH
    status["db_ok"] = os.path.exists(db_path)
    status["db_path"] = db_path
    status["port"] = int(params.get("port") or 8765)
    return {"success": True, "status": status}


def deploy_install(conn, params):
    """安装缺失依赖（onnxruntime / sqlite-vec / tokenizers）。

    - 当前 python 若是 3.12（Termux TUR 或 proot venv），pip 可直接装。
    - onnxruntime 仅完整支持 Python 3.12；Termux 默认 python 太新（3.13/3.14）装不上，
      需先装 TUR 的 python3.12：pkg install python3.12（termux-user-repository 源）。
    """
    import subprocess
    missing = []
    if not _check_module("onnxruntime"):
        missing.append("onnxruntime")
    if not _check_module("sqlite_vec"):
        missing.append("sqlite-vec")
    if not _check_module("tokenizers"):
        missing.append("tokenizers")
    if not missing:
        return {"success": True, "installed": [], "message": "依赖已齐全"}

    py_major_minor = "%d.%d" % sys.version_info[:2]
    setup_hint = ""
    if py_major_minor != "3.12":
        setup_hint = (
            "\n\n当前 Python 是 %s，onnxruntime 仅完整支持 3.12。"
            "若在 Termux，请先安装 python3.12（termux-user-repository 源）：\n"
            "  pkg install python3.12\n"
            "然后用 python3.12 -m pip 重试，或用 proot venv（/root/.venv/bin/python3.12）。" % py_major_minor
        )

    cmd = [sys.executable, "-m", "pip", "install", "--break-system-packages", "--upgrade"] + missing
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            return {"success": False, "message": "安装失败: " + (r.stderr or r.stdout or "")[-500:] + setup_hint}
        # 二次确认实际装成功
        still_missing = [m for m in missing if not _check_module(m.replace("-", "_"))]
        if still_missing:
            return {"success": False, "message": "部分依赖仍未安装: " + ", ".join(still_missing) + setup_hint}
        return {"success": True, "installed": missing, "message": "已安装: " + ", ".join(missing)}
    except Exception as e:
        return {"success": False, "message": "安装失败: " + str(e) + setup_hint}


def sync_db(conn, params):
    """在线热备当前 db 到数据目录（sqlite backup API，含 WAL 已提交数据，原子替换）。

    架构：worker 的 db 在 /root（ext4，WAL 稳定），数据目录的 engine.db 是部署副本。
    每次部署/重启前先调本 action，保证数据目录副本不落后。
    """
    try:
        db_path = _current_db_path(conn)
        dst_path = os.path.join(DATA_DIR, "engine.db")
        tmp_path = dst_path + ".tmp"
        src = sqlite3.connect(db_path)
        try:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
            dst = sqlite3.connect(tmp_path)
            try:
                src.backup(dst)
            finally:
                dst.close()
            os.replace(tmp_path, dst_path)
            return {"success": True, "synced": True, "db": db_path, "size": os.path.getsize(dst_path)}
        finally:
            src.close()
    except Exception as e:
        return {"success": False, "message": "sync_db 失败: " + str(e)}


def _start_db_sync_loop(interval=600):
    """定时把 /root 的 db 热备到数据目录（默认每 10 分钟一次）。"""
    def loop():
        while True:
            time.sleep(interval)
            try:
                c = get_conn(DB_PATH)
                try:
                    sync_db(c, {})
                finally:
                    c.close()
            except Exception:
                pass
    t = threading.Thread(target=loop, daemon=True)
    t.start()


def deploy_restart(conn, params):
    """杀掉旧 worker 进程并重启（仅报告；实际重启由插件侧发起）。"""
    import subprocess
    count, pids = _find_worker_processes()
    killed = []
    if count > 0:
        for pid in pids:
            if str(os.getpid()) == pid:
                continue  # 不杀自己
            try:
                subprocess.run(["kill", pid], timeout=5)
                killed.append(pid)
            except Exception:
                pass
    return {"success": True, "killed": killed, "restart": "插件侧启动"}


def save_ui_state(conn, params):
    """保存 UI 状态（last_ui_state.json），合并写入并保留 injection 配置段。"""
    state = params.get("state_json") or params.get("state")
    if not state:
        return {"success": False, "message": "missing state_json"}
    try:
        parsed = json.loads(state) if isinstance(state, str) else state
    except Exception:
        parsed = state
    try:
        path = os.path.join(DATA_DIR, "last_ui_state.json")
        data = {"version": 1, "data": {}}
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    loaded = json.load(f) or {}
                if isinstance(loaded, dict):
                    data = loaded
            except Exception:
                data = {"version": 1, "data": {}}
        ui_data = data.get("data") if isinstance(data.get("data"), dict) else {}
        # 保留 set_injection_settings 写入的 injection 段，UI 状态不得覆盖
        saved_injection = ui_data.get("injection")
        if isinstance(parsed, dict):
            ui_data.update(parsed)
        else:
            ui_data = parsed
        if saved_injection is not None:
            ui_data["injection"] = saved_injection
        data["data"] = ui_data
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        return {"success": True, "path": path}
    except Exception as e:
        return {"success": False, "message": "save failed: " + str(e)}


def trigger_analysis(conn, params):
    """自动分析探针（兼容旧前端初始化调用）。

    新版自动分析由 main.js onPromptFinalize 冷却机制驱动，此处只需返回
    started=false，前端据此跳过轮询，不再阻塞初始化。
    """
    return {"success": True, "started": False, "newMessageCount": 0, "message": "自动分析由 onPromptFinalize 冷却机制驱动"}


def set_injection_settings(conn, params):
    """保存记忆注入配置到 last_ui_state.json 的 injection 段（旧前端调用）。"""
    injection = {
        "enabled": bool(params.get("enabled", False)),
        "persist": bool(params.get("persist", True)),
        "maxMemories": int(params.get("max_memories") or params.get("maxMemories") or 5),
        "allowRepeatedMemorySearch": bool(params.get("allow_repeated_memory_search", params.get("allowRepeatedMemorySearch", False))),
    }
    if injection["maxMemories"] < 1 or injection["maxMemories"] > 20:
        injection["maxMemories"] = 5
    path = os.path.join(DATA_DIR, "last_ui_state.json")
    try:
        data = {}
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f) or {}
            except Exception:
                data = {}
        if not isinstance(data, dict):
            data = {}
        ui_data = data.get("data") if isinstance(data.get("data"), dict) else {}
        ui_data["injection"] = injection
        data["data"] = ui_data
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        return {"success": True, "injection": injection}
    except Exception as e:
        return {"success": False, "message": "save failed: " + str(e)}


# ===== AI 分析 / 提取 =====
# 注意：prompt 含大量 JSON 花括号，禁止用 .format()（会当占位符抛 KeyError），用 .replace() 注入变量
EXTRACTION_PROMPT_TEMPLATE = """你是一个记忆系统。请理解以下对话整体讲了什么，然后提取有价值的信息。{persona_hint}

核心原则：
- 你是在理解一段对话后做总结，不是逐条扫描消息
- 一段对话可能只产生0-2条有价值的提取，这是正常的
- 过程噪音（反复调试、重复提问、工具调用细节）不要提取
- 无效信息（"继续""好的""开始"等）完全忽略
- 如果与已有数据语义重复，不要重复提取；同一事件措辞不同但语义相同也只保留一条
- 不推断未明确表达的人格、感情或关系等级
{existing_summary}
返回纯JSON（不要markdown代码块，不要任何额外文字）：
{"events":[{"type":"activity|schedule|observation|milestone|mood","title":"标题","description":"描述","importance":"high|medium|low","date":"YYYY-MM-DD","time":"HH:MM"}],"todos":[{"title":"待办事项","description":"描述","priority":"high|medium|low","dueDate":"YYYY-MM-DD或null","completed":false}],"contacts":[{"name":"姓名","relation":"friend|family|colleague|classmate|service|other","attributes":[{"key":"属性名","value":"值"}],"context":"提到这个人的场景"}],"info":[{"category":"类别","content":"内容"}],"finance":[{"type":"expense|income","category":"类别","amount":0,"description":"描述","date":"YYYY-MM-DD"}],"menstrual":[{"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD或null","symptoms":"症状描述"}],"character":[{"title":"标题","content":"角色身份或背景事实"}],"relationship":[{"title":"标题","content":"用户与角色的明确关系事实或共同经历"}],"preference":[{"title":"标题","content":"用户或角色明确表达的偏好"}],"interaction_rule":[{"title":"标题","content":"明确约定的称呼、回复风格或互动边界"}]}

提取规则：
1. events：有记录价值的事件。activity=做了什么事；schedule=有时间安排的事；observation=发现的现象；milestone=阶段性变化；mood=情绪
2. todos：用户明确要做的事，不是已经做完的事
3. contacts：提到的人物及其属性
4. info：值得记住的知识/事实/参数
5. finance：涉及花钱或收钱的记录
6. menstrual：经期记录
7. character/relationship/preference/interaction_rule：仅在存在当前角色卡且事实明确时提取
8. 某类没数据用空数组；同一件事不要拆成多条

对话内容：
{chat_text}"""


def _build_extraction_prompt(persona_hint, existing_summary, chat_text):
    """用 replace 注入变量（模板含 JSON 花括号，不能用 str.format）。"""
    return (EXTRACTION_PROMPT_TEMPLATE
            .replace("{persona_hint}", persona_hint)
            .replace("{existing_summary}", existing_summary)
            .replace("{chat_text}", chat_text))


def _call_llm(endpoint, api_key, model, prompt):
    """调用 OpenAI 兼容接口，返回解析后的 JSON dict 或 None。"""
    import urllib.request
    endpoint = endpoint.rstrip("/")
    if "/chat/completions" not in endpoint:
        endpoint = endpoint + "/chat/completions"
    body = json.dumps({
        "model": model or "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": "你是一个对话分析助手，只返回JSON格式数据，不要返回任何其他内容。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 16384,
    }).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (api_key or ""),
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw)
    content = ""
    if data.get("choices") and data["choices"][0].get("message"):
        content = data["choices"][0]["message"].get("content") or ""
    elif data.get("content"):
        content = data["content"]
    if not content:
        return None
    # 提取 JSON 对象
    import re as _re
    m = _re.search(r"\{[\s\S]*\}", content)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def analyze_chat(conn, params):
    """AI 分析对话并提取结构化记忆，写入 SQLite（语义去重）。"""
    chat_text = params.get("chat_text") or ""
    endpoint = params.get("endpoint") or ""
    api_key = params.get("api_key") or ""
    model = params.get("model") or "gpt-4o-mini"
    character_id = params.get("character_id") or None
    if not chat_text or len(chat_text.strip()) < 10:
        return {"success": False, "message": "对话内容过短"}
    if not endpoint or not api_key:
        return {"success": False, "message": "未配置 API Endpoint 或 Key"}
    # 总量截断：防止长对话把 LLM 上下文撑爆（每段截 500 后累计仍可能过大）
    if len(chat_text) > 12000:
        # 前后各保留 6000：角色互动通常在对话尾部，只留头部会丢失角色卡内容
        chat_text = chat_text[:10000] + "...（中段省略）..." + chat_text[-10000:]

    # 读取已有数据用于去重提示
    existing_summary = ""
    try:
        existing = {}
        for cat in LIFE_CATEGORIES:
            r = list_memories(conn, {"character_id": character_id, "category": cat, "limit": 20})
            existing[cat] = r["memories"]
        parts = []
        if existing.get("todos"):
            parts.append("已有待办: " + "; ".join(t.get("title", "") for t in existing["todos"][-10:]))
        if existing.get("events"):
            parts.append("已有事件: " + "; ".join(e.get("title", "") for e in existing["events"][-10:]))
        if existing.get("info"):
            parts.append("已有信息: " + "; ".join(i.get("content", "") for i in existing["info"][-10:]))
        if existing.get("contacts"):
            parts.append("已有联系人: " + "; ".join(c.get("name", "") for c in existing["contacts"]))
        if parts:
            existing_summary = "\n\n【已有数据——不要重复提取语义相同的内容】\n" + "\n".join(parts) + "\n"
    except Exception:
        existing_summary = ""

    persona_hint = ("\n当前角色卡：" + params.get("persona_name", "") +
                    "。仅提取对该角色长期互动确有价值且由本段对话明确支持的内容。"
                    if character_id else
                    "\n当前没有可确认的角色卡，四个角色分类必须返回空数组。")

    prompt = _build_extraction_prompt(persona_hint, existing_summary, chat_text)

    result = _call_llm(endpoint, api_key, model, prompt)
    if result is None:
        return {"success": False, "message": "AI 提取失败或返回格式错误"}

    # 写入 SQLite（逐条 create_memory，语义去重）
    stats = {"items": 0, "deduped": 0, "errors": 0, "categories": 0}
    for cat in LIFE_CATEGORIES + ["character", "relationship", "preference", "interaction_rule"]:
        items = result.get(cat) or []
        if not items:
            continue
        stats["categories"] += 1
        for item in items:
            p = dict(item)
            p["category"] = cat
            if character_id:
                p["character_id"] = character_id
            if cat in ROLE_CATEGORIES:
                p.setdefault("source", "ai_role")
            else:
                p.setdefault("source", "ai_life")
            r = create_memory(conn, p)
            if r.get("success"):
                stats["items"] += 1
                if r.get("deduped"):
                    stats["deduped"] += 1
            else:
                stats["errors"] += 1

    return {"success": True, "stats": stats}


def import_legacy_backup(conn, params):
    """从旧版本（v1.5.x）备份导入数据。

    支持 ZIP 文件或解压后的目录路径。备份结构（旧 export_backup 产物）：
      manifest.json            { format:'character-memory-backup', files:[{path,size,digest}] }
      data/<cat>.json          六类，{ schemaVersion, updatedAt, rows:[...] }
      active_persona.json      当前角色 { id,name,type }
      settings.json / reconcile_v1_4_0.json / last_ui_state.json（本阶段不导入）

    导入策略：
      - 六类 rows 逐条 create_memory（复用精确 hash + 文本相似度 + 向量三层去重，幂等）
      - active_persona 导入 characters 表
    返回统计。
    """
    path = params.get("path") or ""
    character_id = params.get("character_id")  # 可选：导入到指定角色；不传则通用
    if not path:
        return {"success": False, "message": "missing path"}

    import zipfile
    import tempfile
    import shutil

    extracted_dir = None
    try:
        # 若是 ZIP，解压到临时目录
        if os.path.isdir(path):
            base = path
        elif os.path.exists(path) and zipfile.is_zipfile(path):
            # 按文件头识别 ZIP，不依赖 .zip 后缀（SAF/缓存路径可能无后缀）
            extracted_dir = tempfile.mkdtemp(prefix="engine_import_")
            with zipfile.ZipFile(path) as zf:
                _safe_extract(zf, extracted_dir)
            base = extracted_dir
        else:
            return {"success": False, "message": "path must be dir or zip"}

        stats = {"categories": 0, "items": 0, "deduped": 0, "characters": 0, "errors": 0}

        # 导入六类
        for cat in LIFE_CATEGORIES:
            cat_file = os.path.join(base, "data", cat + ".json")
            if not os.path.exists(cat_file):
                continue
            try:
                with open(cat_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as e:
                stats["errors"] += 1
                continue
            rows = data.get("rows") or []
            stats["categories"] += 1
            for item in rows:
                # 前端字段直接作为 create_memory 参数（worker 做字段映射 + 去重）
                p = dict(item)
                # v1.8.5：旧备份子标题存在 category 字段（如"凭证""用户习惯"），
                # 覆盖大类前先保留为 title，避免导入后信息栏丢失分类标题
                if p.get("category") and p["category"] != cat and not p.get("title"):
                    p["title"] = p["category"]
                p["category"] = cat
                if character_id:
                    p["character_id"] = character_id
                r = create_memory(conn, p)
                if r.get("success"):
                    stats["items"] += 1
                    if r.get("deduped"):
                        stats["deduped"] += 1
                else:
                    stats["errors"] += 1

        # 导入 active_persona 到 characters
        persona_file = os.path.join(base, "active_persona.json")
        if os.path.exists(persona_file):
            try:
                with open(persona_file, "r", encoding="utf-8") as f:
                    persona = json.load(f)
                pid = persona.get("id") or persona.get("character_id")
                pname = persona.get("name") or persona.get("characterName")
                if pid and pname:
                    now = int(time.time() * 1000)
                    conn.execute(
                        "INSERT OR REPLACE INTO characters (id, name, created_at, updated_at) VALUES (?,?,?,?)",
                        (str(pid), str(pname), now, now),
                    )
                    conn.commit()
                    stats["characters"] = 1
            except Exception:
                pass

        conn.commit()
        return {"success": True, "imported": stats, "stats": stats}
    except Exception as e:
        return {"success": False, "message": "import failed: " + str(e)}
    finally:
        if extracted_dir:
            try:
                shutil.rmtree(extracted_dir, ignore_errors=True)
            except Exception:
                pass


def backup_engine(conn, params):
    """导出 SQLite 数据库 + 配置到 ZIP（存到 {ENGINE_DIR}/backups/）。"""
    import zipfile
    import shutil
    try:
        db_path = _current_db_path(conn)
        bkp_dir = os.path.join(DATA_DIR, "backups")
        os.makedirs(bkp_dir, exist_ok=True)

        ts = int(time.time() * 1000)
        zip_name = "engine_" + str(ts) + ".zip"
        zip_path = os.path.join(bkp_dir, zip_name)

        # 导出 db 到临时文件（用 backup API 保证一致性）
        tmp_dir = os.path.join(bkp_dir, ".stage_" + str(ts))
        os.makedirs(tmp_dir, exist_ok=True)
        export_db = os.path.join(tmp_dir, "engine.db")
        dest = sqlite3.connect(export_db)
        conn.backup(dest)
        dest.close()

        # 附带 UI 状态
        ui_state = os.path.join(DATA_DIR, "last_ui_state.json")
        manifest = {
            "format": "character-memory-engine-backup",
            "version": 1,
            "createdAt": ts,
            "reason": str(params.get("reason") or "manual")[:80],
            "files": ["engine.db"]
        }
        with open(os.path.join(tmp_dir, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False)
        if os.path.exists(ui_state):
            shutil.copy(ui_state, os.path.join(tmp_dir, "last_ui_state.json"))

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fn in os.listdir(tmp_dir):
                zf.write(os.path.join(tmp_dir, fn), fn)

        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {"success": True, "path": zip_path, "fileName": zip_name, "createdAt": ts}
    except Exception as e:
        return {"success": False, "message": "backup failed: " + str(e)}


def inspect_engine(conn, params):
    """校验 Engine 备份 ZIP。"""
    import zipfile
    import tempfile
    import shutil
    path = params.get("path") or ""
    if not path:
        return {"success": False, "message": "missing path"}
    tmp = None
    try:
        if not os.path.exists(path):
            return {"success": False, "message": "backup not found"}
        tmp = tempfile.mkdtemp(prefix="engine_inspect_")
        with zipfile.ZipFile(path) as zf:
            _safe_extract(zf, tmp)
        mf = os.path.join(tmp, "manifest.json")
        if not os.path.exists(mf):
            return {"success": False, "valid": False, "message": "missing manifest"}
        with open(mf, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        if manifest.get("format") != "character-memory-engine-backup" or manifest.get("version") != 1:
            return {"success": False, "valid": False, "message": "invalid backup format"}
        db_ok = os.path.exists(os.path.join(tmp, "engine.db"))
        return {"success": True, "valid": db_ok, "version": manifest["version"], "createdAt": manifest.get("createdAt"), "reason": manifest.get("reason"), "fileCount": len(manifest.get("files") or [])}
    except Exception as e:
        return {"success": False, "message": "inspect failed: " + str(e)}
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def restore_engine(conn, params):
    """从 Engine 备份恢复。mode=overwrite 覆盖当前 db，mode=merge 逐条合并写入。

    用 _RESTORE_LOCK 串行化，避免多线程覆盖活动 db 文件。
    """
    import zipfile
    import tempfile
    import shutil
    path = params.get("path") or ""
    mode = params.get("mode") or "merge"
    if mode not in ("merge", "overwrite"):
        mode = "merge"
    if not path:
        return {"success": False, "message": "missing path"}
    tmp = None
    with _RESTORE_LOCK:
        try:
            if not os.path.exists(path):
                return {"success": False, "message": "backup not found"}
            tmp = tempfile.mkdtemp(prefix="engine_restore_")
            with zipfile.ZipFile(path) as zf:
                _safe_extract(zf, tmp)
            mf = os.path.join(tmp, "manifest.json")
            if not os.path.exists(mf):
                return {"success": False, "message": "missing manifest"}
            with open(mf, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            if manifest.get("format") != "character-memory-engine-backup":
                return {"success": False, "message": "invalid backup format"}

            db_path = _current_db_path(conn)
            src_db = os.path.join(tmp, "engine.db")
            if not os.path.exists(src_db):
                return {"success": False, "message": "backup missing engine.db"}

            if mode == "overwrite":
                # 备份前保护当前 db（含 WAL/SHM，保证最近提交也在快照里）
                conn.close()
                protect = db_path + ".pre_restore.bak"
                for suffix in ("", "-wal", "-shm"):
                    try:
                        if os.path.exists(db_path + suffix):
                            shutil.copy(db_path + suffix, protect + suffix)
                    except Exception:
                        pass
                shutil.copy(src_db, db_path)
                return {"success": True, "mode": mode, "restoredAt": int(time.time() * 1000), "protection": protect}
            else:
                # merge：读备份库逐条 create_memory（幂等，语义去重）
                bak_conn = get_conn(src_db)
                try:
                    rows = bak_conn.execute(
                        "SELECT * FROM memories WHERE is_deleted=0 ORDER BY id"
                    ).fetchall()
                    merged = 0
                    for r in rows:
                        obj = row_to_obj(r)
                        obj["category"] = r["category"]
                        obj["character_id"] = r["character_id"] or None
                        obj["source"] = r["source"] or "manual"
                        create_memory(conn, obj)
                        merged += 1
                    return {"success": True, "mode": mode, "restoredAt": int(time.time() * 1000),
                            "fileCount": merged}
                finally:
                    bak_conn.close()
        except Exception as e:
            return {"success": False, "message": "restore failed: " + str(e)}
        finally:
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)



# ===== 路由 =====
ACTIONS = {
    "list_memories": list_memories,
    "get_memory": get_memory,
    "create_memory": create_memory,
    "update_memory": update_memory,
    "delete_memory": delete_memory,
    "bulk_update_memories": bulk_update_memories,
    "bulk_delete_memories": bulk_delete_memories,
    "search_memories": search_memories,
    "load_life_data": load_life_data,
    "upsert_life_item": upsert_life_item,
    "delete_life_item": delete_life_item,
    "toggle_todo": toggle_todo,
    "list_characters": list_characters,
    "save_character": save_character,
    "get_relationship": get_relationship,
    "save_relationship": save_relationship,
    "import_legacy_backup": import_legacy_backup,
    "deploy_status": deploy_status,
    "deploy_install": deploy_install,
    "deploy_restart": deploy_restart,
    "sync_db": sync_db,
    "save_ui_state": save_ui_state,
    "trigger_analysis": trigger_analysis,
    "set_injection_settings": set_injection_settings,
    "analyze_chat": analyze_chat,
    "backup_engine": backup_engine,
    "inspect_engine": inspect_engine,
    "restore_engine": restore_engine,
    "ping_worker": ping_worker,
    "log_event": log_event,
    "get_logs": get_logs,
}


def handle_action(db_path, action, params):
    conn = get_conn(db_path)
    try:
        # 懒建表：确保 memories/characters/relationships 存在，防止 worker 启动时 init_db 未生效
        try:
            conn.execute("SELECT COUNT(*) FROM memories").fetchone()
        except Exception:
            try:
                init_db(db_path)
            except Exception:
                pass
        fn = ACTIONS.get(action)
        if not fn:
            return {"success": False, "message": "unknown action: " + str(action)}
        return fn(conn, params or {})
    except Exception as e:
        tb = " | ".join(line.strip() for line in traceback.format_exc().splitlines() if line.strip())
        log("ERROR", "handle_action failed action=%s: %s" % (action, tb))
        return {"success": False, "message": "error: " + str(e)}
    finally:
        conn.close()


# ===== HTTP 服务 =====
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        t0 = time.time()
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(body.decode("utf-8"))
        except Exception:
            req = {}
        action = req.get("action")
        params = req.get("params") or {}
        result = handle_action(self.server.db_path, action, params)
        ms = int((time.time() - t0) * 1000)
        ok = bool(result and result.get("success"))
        msg = (result or {}).get("message") or ""
        if action == "log_event":
            pass  # 内部已记录，避免重复
        elif action == "ping_worker":
            log("DEBUG", "req action=%s ms=%dms ok=%s" % (action, ms, ok))
        else:
            log("INFO", "req action=%s ms=%dms ok=%s%s"
                % (action, ms, ok, (" msg=" + str(msg)[:120]) if msg else ""))
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, fmt, *args):
        sys.stderr.write("[engine] %s\n" % (fmt % args))


# ===== 备份 / 恢复（Engine 格式：SQLite db + 配置打包 ZIP）=====
_RESTORE_LOCK = threading.Lock()


def _safe_extract(zf, dest):
    """安全解压：校验每个成员路径都在 dest 内，防 zip-slip 穿越。"""
    import posixpath
    for member in zf.infolist():
        target = os.path.realpath(os.path.join(dest, member.filename))
        if not target.startswith(os.path.realpath(dest) + os.sep) and target != os.path.realpath(dest):
            raise ValueError("zip entry escapes target dir: %s" % member.filename)
    zf.extractall(dest)


def _current_db_path(conn):
    """从连接获取当前 db 文件路径。"""
    try:
        row = conn.execute("PRAGMA database_list").fetchone()
        if row and row["file"]:
            return row["file"]
    except Exception:
        pass
    return os.environ.get("MEMORY_ENGINE_DB", os.path.join(DATA_DIR, "engine.db"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", default=DB_PATH)
    # 一次性 CLI 模式（参考 dual-life-hub）：--cli ACTION PAYLOAD_FILE
    parser.add_argument("--cli", nargs=2, metavar=("ACTION", "PAYLOAD_FILE"))
    args = parser.parse_args()
    global ACTIVE_DB_PATH
    ACTIVE_DB_PATH = args.db or DB_PATH

    if args.cli:
        # CLI 一次性调用：读 payload 文件 → handle_action → 输出 MARKER+JSON 行
        action, payload_file = args.cli
        MARKER = "__LIFE_HUB_JSON__"
        try:
            payload = {}
            if os.path.exists(payload_file):
                with open(payload_file, "r", encoding="utf-8") as f:
                    payload = json.load(f) or {}
            result = handle_action(args.db, action, payload)
            line = MARKER + json.dumps(result, ensure_ascii=False)
            print(line, flush=True)
        except Exception as e:
            print(MARKER + json.dumps({"success": False, "message": "cli error: " + str(e)}, ensure_ascii=False), flush=True)
        return

    try:
        Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        tb = " | ".join(line.strip() for line in traceback.format_exc().splitlines() if line.strip())
        msg = "worker db 目录创建失败: %s | %s" % (str(e), tb)
        try:
            log("ERROR", msg)
        except Exception:
            sys.stderr.write(msg + "\n")
        return
    try:
        init_db(args.db)
    except Exception as e:
        # 启动失败必须留痕：写日志 + stderr，否则看不出 worker 为什么起不来
        tb = " | ".join(line.strip() for line in traceback.format_exc().splitlines() if line.strip())
        msg = "worker init_db 失败: %s | %s" % (str(e), tb)
        try:
            log("ERROR", msg)
        except Exception:
            sys.stderr.write(msg + "\n")
        return
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except Exception as e:
        tb = " | ".join(line.strip() for line in traceback.format_exc().splitlines() if line.strip())
        msg = "worker 端口绑定失败（可能已被占用）: %s | %s" % (str(e), tb)
        try:
            log("ERROR", msg)
        except Exception:
            sys.stderr.write(msg + "\n")
        return
    server.db_path = args.db
    _start_db_sync_loop()
    log("INFO", "worker v%s listening on %s, db=%s" % (VERSION, args.port, args.db))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

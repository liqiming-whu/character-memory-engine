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
import time
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

VERSION = "0.1.0"
DB_PATH = "/root/character_memory_engine/engine.db"
MODEL_DIR = "/root/character_memory_engine/models"

# 向量去重阈值（方案 A）：余弦 ≥ 0.9 判重复
VEC_DEDUP_THRESHOLD = 0.9

# ===== 分类定义 =====
LIFE_CATEGORIES = ["events", "todos", "contacts", "info", "finance", "menstrual"]
ROLE_CATEGORIES = ["character", "relationship", "preference", "interaction_rule"]
ALL_CATEGORIES = LIFE_CATEGORIES + ROLE_CATEGORIES


# ===== 数据库 =====
def get_conn(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
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
        sys.stderr.write("[engine] embedder init failed: %s\n" % str(e))
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
    conn.executescript(SCHEMA)
    # 若 vec0 不可用（无 sqlite-vec），跳过虚拟表创建
    try:
        conn.execute("SELECT COUNT(*) FROM vec_items")
    except Exception:
        try:
            conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding float[512] distance_metric=cosine)")
        except Exception:
            pass
    conn.commit()
    conn.close()


# ===== 文本归一化与精确去重 =====
def normalize_text(text):
    """归一化：NFKC、去空白、去标点、小写。用于精确去重 hash。"""
    s = unicodedata.normalize("NFKC", str(text or ""))
    s = s.lower()
    s = re.sub(r"[\s\.,，。！？、：:；;（）()\[\]{}<>\"'「」『』“”‘’]+", "", s)
    return s


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
        sys.stderr.write("[engine] vec_dedup error: %s\n" % str(e))
        return None


def search_memories(conn, params):
    """语义检索：query 向量 + 关键词 + 角色过滤，返回排序结果。

    方案 A：向量近邻为主；方案 B（无向量）：仅关键词。
    """
    character_id = params.get("character_id")
    category = params.get("category")
    query = params.get("query") or ""
    limit = int(params.get("limit") or 20)
    if not query:
        return {"success": True, "memories": [], "total": 0}

    results = []
    embedder = get_embedder()
    if embedder is not None:
        try:
            vec = embedder.embed(query, is_query=True)
            vec_str = "[" + ",".join(f"{v:.6f}" for v in vec) + "]"
            rows = conn.execute(
                "SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k=?", (vec_str, limit * 3),
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
            sys.stderr.write("[engine] search vec error: %s\n" % str(e))

    # 无向量或结果不足时，关键词兜底
    if not results:
        like = "%" + query + "%"
        sql = "SELECT * FROM memories WHERE is_deleted=0 AND (title LIKE ? OR content LIKE ? OR description LIKE ?)"
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

    results = results[:limit]
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
        like = "%" + str(query) + "%"
        sql += " AND (title LIKE ? OR content LIKE ? OR description LIKE ?)"
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
        conn.execute(
            "UPDATE memories SET updated_at=?, title=?, content=?, description=? WHERE id=?",
            (now, title, content, params.get("description"), existing["id"]),
        )
        conn.commit()
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
            conn.execute("INSERT OR REPLACE INTO vec_items(rowid, embedding) VALUES (?, ?)", (mid, vec_str))
            conn.commit()
        except Exception as e:
            sys.stderr.write("[engine] embed write failed: %s\n" % str(e))
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
           end_date=?, symptoms=?, amount=?, extra_json=?, updated_at=? WHERE id=?""",
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
    # 无 ids：按 category 批量
    category = params.get("category")
    character_id = params.get("character_id")
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
    return {"success": True, "extracted": result}


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
        + (" AND character_id=?" if character_id else " AND (character_id IS NULL OR character_id='')"),
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
    character_id = params.get("character_id")
    rows = conn.execute(
        "SELECT id FROM memories WHERE category=? AND is_deleted=0"
        + (" AND character_id=?" if character_id else " AND (character_id IS NULL OR character_id='')"),
        ([category] + [str(character_id)] if character_id else [category]),
    ).fetchall()
    if index is None or int(index) < 0 or int(index) >= len(rows):
        return {"success": False, "message": "index out of range"}
    conn.execute("UPDATE memories SET is_deleted=1 WHERE id=?", (rows[int(index)]["id"],))
    conn.commit()
    return {"success": True, "remaining": len(rows) - 1}


def toggle_todo(conn, params):
    index = params.get("index")
    character_id = params.get("character_id")
    rows = conn.execute(
        "SELECT * FROM memories WHERE category='todos' AND is_deleted=0"
        + (" AND character_id=?" if character_id else " AND (character_id IS NULL OR character_id='')"),
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
    conn.execute(
        "INSERT INTO relationships (character_id, target, stage, notes, updated_at) "
        "VALUES (?,?,?,?,?) "
        "ON CONFLICT DO UPDATE SET stage=COALESCE(?, stage), notes=COALESCE(?, notes), updated_at=?",
        (character_id, target, stage, notes, now, stage, notes, now),
    )
    conn.commit()
    return get_relationship(conn, params)


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
}


def handle_action(db_path, action, params):
    conn = get_conn(db_path)
    try:
        fn = ACTIONS.get(action)
        if not fn:
            return {"success": False, "message": "unknown action: " + str(action)}
        return fn(conn, params or {})
    except Exception as e:
        return {"success": False, "message": "error: " + str(e)}
    finally:
        conn.close()


# ===== HTTP 服务 =====
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(body.decode("utf-8"))
        except Exception:
            req = {}
        action = req.get("action")
        params = req.get("params") or {}
        result = handle_action(self.server.db_path, action, params)
        resp = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, fmt, *args):
        sys.stderr.write("[engine] %s\n" % (fmt % args))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", default=DB_PATH)
    args = parser.parse_args()

    Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    init_db(args.db)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.db_path = args.db
    print(f"[engine] worker v{VERSION} listening on {args.port}, db={args.db}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

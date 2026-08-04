#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A 专项测试：向量去重 + 语义检索。"""
import os
import sys
import tempfile

# 覆盖 worker 的路径为本机测试路径
import worker
worker.MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
worker.DB_PATH = os.path.join(tempfile.mkdtemp(), "engine_a.db")

db = worker.DB_PATH
worker.init_db(db)

passed = 0
failed = 0

def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}")

def h(action, params):
    return worker.handle_action(db, action, params)

# 确认向量可用
emb = worker.get_embedder()
check("embedder 加载", emb is not None)

print("== 方案 A：向量语义去重 ==")
# 语义相同（字面不同）→ 向量去重合并
r = h("create_memory", {"category": "info", "title": "用户习惯", "content": "我喜欢喝奶茶"})
check("创建1", r["success"] and not r["deduped"])
r = h("create_memory", {"category": "info", "title": "用户习惯", "content": "我爱喝奶茶"})
check("向量语义去重合并（奶茶vs爱喝奶茶）", r["success"] and r["deduped"] is True)
r = h("list_memories", {"category": "info"})
check("合并后 1 条", r["total"] == 1)

# 语义无关 → 不合并
r = h("create_memory", {"category": "info", "title": "行程", "content": "启明今天去了健身房"})
check("语义无关不合并", r["success"] and r["deduped"] is False)

print("== 方案 A：语义检索 ==")
# 检索「奶茶」应命中「爱喝奶茶」
r = h("search_memories", {"query": "我喜欢喝奶茶", "limit": 5})
titles = [m["content"] for m in r["memories"]]
check("检索命中奶茶", r["success"] and any("奶茶" in t for t in titles))
check("检索排序奶茶靠前", r["success"] and len(r["memories"]) > 0 and "奶茶" in r["memories"][0]["content"])

# 检索「健身房」应命中健身房，奶茶靠后/不含
r = h("search_memories", {"query": "我今天去健身房锻炼", "limit": 5})
contents = [m["content"] for m in r["memories"]]
check("检索命中健身房", any("健身房" in c for c in contents))

print(f"\n结果: {passed} 通过, {failed} 失败")
sys.exit(1 if failed else 0)

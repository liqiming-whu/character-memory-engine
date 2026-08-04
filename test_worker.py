#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""worker.py 数据层本机验证：CRUD / 语义去重 / 角色隔离 / 字段兼容。"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worker

tmpdir = tempfile.mkdtemp()
db = os.path.join(tmpdir, "test.db")
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


def handle(action, params):
    return worker.handle_action(db, action, params)


print("== 1. 基础 CRUD ==")
r = handle("create_memory", {"category": "info", "title": "用户习惯", "content": "启明从不抽烟"})
check("create info", r["success"] and not r["deduped"])
mid = r["memory"]["id"]

r = handle("get_memory", {"id": mid})
check("get_memory", r["success"] and r["memory"]["content"] == "启明从不抽烟")
check("字段映射 timestamp", r["memory"].get("timestamp") is not None)

r = handle("update_memory", {"id": mid, "content": "启明从不抽烟喝酒"})
check("update", r["success"] and r["memory"]["content"] == "启明从不抽烟喝酒")

r = handle("list_memories", {"category": "info"})
check("list by category", r["success"] and r["total"] == 1)

print("== 2. 语义去重（方案甲：精确 hash 合并）==")
# 完全相同的文本 → 合并
r = handle("create_memory", {"category": "info", "title": "用户习惯", "content": "启明从不抽烟"})
check("重复内容合并 deduped=True", r["success"] and r["deduped"] is True)
r = handle("list_memories", {"category": "info"})
check("合并后不新增（info 仍 1 条）", r["total"] == 1)
# 近似语义（不同文本但近义）→ 文本相似度合并（方案 B 增强）
r = handle("create_memory", {"category": "info", "title": "用户习惯", "content": "启明从不抽烟喝酒"})
check("近似语义文本相似度合并", r["success"] and r["deduped"] is True)
r = handle("list_memories", {"category": "info"})
check("近似合并后不新增（info 仍 1 条）", r["total"] == 1)
# 语义无关 → 不合并
r = handle("create_memory", {"category": "info", "title": "通用", "content": "启明今天去了健身房"})
check("语义无关不合并", r["success"] and r["deduped"] is False)
# 清理无关条，避免污染后续
r = handle("list_memories", {"category": "info"})
for m in r["memories"]:
    if m["content"] == "启明今天去了健身房":
        handle("delete_memory", {"id": m["id"]})

print("== 3. 角色隔离 ==")
handle("save_character", {"id": "char_a", "name": "角色A"})
r = handle("create_memory", {"category": "preference", "title": "偏好", "content": "角色A喜欢安静", "character_id": "char_a"})
check("创建角色记忆", r["success"])
r = handle("create_memory", {"category": "info", "title": "通用", "content": "通用记忆"})
check("创建通用记忆", r["success"])

r = handle("list_memories", {"character_id": "char_a"})
check("角色A只看到自己", r["success"] and all(m["category"] == "preference" for m in r["memories"]))
r = handle("list_memories", {})
check("默认查询不含角色A记忆", r["success"] and all(m.get("category") != "preference" for m in r["memories"]))

print("== 4. 六类生活数据 ==")
handle("create_memory", {"category": "events", "title": "去杭州", "description": "出差", "importance": "high", "date": "2026-08-04"})
handle("create_memory", {"category": "todos", "title": "买奶茶", "priority": "medium", "completed": False})
handle("create_memory", {"category": "contacts", "name": "小明", "relation": "friend", "attributes": [{"key": "生日", "value": "1月1日"}]})
r = handle("load_life_data", {})
check("load_life_data 六类", r["success"] and r["extracted"]["events"] and r["extracted"]["todos"] and r["extracted"]["contacts"])
check("events 字段映射 importance", r["extracted"]["events"][0].get("importance") == "high")
check("contacts extra_json 属性", r["extracted"]["contacts"][0].get("attributes") == [{"key": "生日", "value": "1月1日"}])

print("== 5. 批量与删除 ==")
r = handle("bulk_update_memories", {"category": "todos", "patch": {"priority": "high"}})
check("bulk update", r["success"] and r["updated"] >= 1)
r = handle("delete_memory", {"id": mid})
check("软删除", r["success"])
r = handle("get_memory", {"id": mid})
check("删除后 get 仍返回（软删除仅标记）", r["success"] is True)
r = handle("list_memories", {"category": "info", "include_deleted": True})
check("include_deleted 可见", r["success"] and any(m["id"] == mid for m in r["memories"]))

print("== 6. toggle_todo ==")
r = handle("toggle_todo", {"index": 0, "category": "todos"})
check("toggle todo", r["success"] and r["completed"] is True)

print(f"\n结果: {passed} 通过, {failed} 失败")
sys.exit(1 if failed else 0)

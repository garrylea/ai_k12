import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "db"))

from chinese_material_doc import build_groups, rewrite_hash_for_row
from material_doc_backfill import (
    apply_plan,
    build_plans,
    eligible_for_article,
    rollback_sql,
)


def test_build_groups_by_paper_and_normalized_text():
    rows = [
        {"id": 1, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 2, "paper_id": 667, "source": "八中", "material_text": "## 醉翁亭记\n\n甲"},
        {"id": 3, "paper_id": 667, "source": "八中", "material_text": "## 前言\n\n乙"},
    ]
    groups = build_groups(rows)
    assert len(groups) == 2
    assert sorted(len(v) for v in groups.values()) == [1, 2]


def test_heading_only_group_is_dropped():
    rows = [{"id": 1, "paper_id": 667, "material_text": "## (一)默写。(共4分)"}]
    assert build_groups(rows) == {}


def test_rewrite_hash_for_row_handles_json_options():
    row = {"content": "题干", "options": "[]", "material_text": None,
           "material_url": "materials/chinese/aaa/content.md"}
    assert len(rewrite_hash_for_row(row)) == 64


def test_rewrite_hash_for_row_uses_material_url():
    a = rewrite_hash_for_row({"content": "题干", "options": None, "material_text": None,
                              "material_url": "materials/chinese/aaa/content.md"})
    b = rewrite_hash_for_row({"content": "题干", "options": None, "material_text": None,
                              "material_url": "materials/chinese/bbb/content.md"})
    assert a != b


def test_eligible_for_article_skips_processed_rows():
    rows = [{"id": 1, "material_method": "rule"}, {"id": 2, "material_method": None}]
    assert [r["id"] for r in eligible_for_article(rows)] == [2]


def test_build_plans_is_idempotent_and_clears_heading_only():
    rows = [
        {"id": 1, "paper_id": 667, "source": "八中", "content": "题",
         "options": None, "material_text": "## (一)默写。(共4分)",
         "material_url": None, "material_method": None},
        {"id": 2, "paper_id": 667, "source": "八中", "content": "题",
         "options": None, "material_text": "题中素材",
         "material_url": None, "material_method": "rule"},
        {"id": 3, "paper_id": 667, "source": "八中", "content": "题",
         "options": None, "material_text": "## 醉翁亭记\n\n环滁皆山也。",
         "material_url": None, "material_method": None},
    ]
    plans, review = build_plans(rows, apply=False)
    assert 1 in [p[0] for p in plans]          # 标题行清空
    assert 2 not in [p[0] for p in plans]      # 已处理的 rule 行不再重排
    assert review == []

    # 模拟 apply，再跑一次必须 0 行
    by_id = {r["id"]: r for r in rows}
    for qid, url, mtext, content, method, _h in plans:
        r = by_id[qid]
        r["material_url"] = url if url is not None else r.get("material_url")
        r["material_text"] = mtext
        r["material_method"] = method
        if content is not None:
            r["content"] = content
    plans2, _ = build_plans(rows, apply=False)
    assert plans2 == []


def test_build_plans_keeps_non_article_group_as_material_text():
    """选项块/丢题等「不像文章」的材料不外置：不生成计划，只进 skip 清单。"""
    rows = [{"id": 1, "paper_id": 9, "source": "卷", "content": "题",
             "options": None, "material_text": "A. 甲\nB. 乙\nC. 丙\nD. 丁",
             "material_url": None, "material_method": None, "content_hash": "h"}]
    skipped: list[dict] = []
    plans, review = build_plans(rows, apply=False, skipped_out=skipped)
    assert plans == [] and review == []
    assert skipped[0]["reason"] == "option_block"
    assert skipped[0]["ids"] == [1]


def test_rollback_sql_has_preamble_and_escapes():
    rows = [{"id": 1, "content": "a'b", "material_text": None, "material_url": None,
             "material_method": None, "content_hash": "h"}]
    sql = rollback_sql([[1, "u", None, None, None, "h"]], rows)
    assert sql.startswith("SET NAMES utf8mb4;")
    assert "WHERE id=1;" in sql
    assert "a\\'b" in sql


class _ConflictCur:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params):
        self.calls.append((sql, params))
        if len(self.calls) == 1:
            raise pymysql.err.IntegrityError(1062, "dup")


def test_apply_plan_falls_back_on_hash_conflict():
    cur = _ConflictCur()
    assert apply_plan(cur, [1, "u", "m", "c", "rule", "hash"]) is True
    assert len(cur.calls) == 2
    assert "content_hash" not in cur.calls[1][0]
    assert cur.calls[1][1] == ("u", "m", "c", "rule", 1)

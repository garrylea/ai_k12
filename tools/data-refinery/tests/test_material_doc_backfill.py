import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "db"))

from chinese_material_doc import build_groups, rewrite_hash_for_row
from material_doc_backfill import build_plans, eligible_for_article


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
    ]
    plans, review = build_plans(rows, apply=False)
    assert [p[0] for p in plans] == [1]      # 标题行清空；已处理的 2 不再重排
    assert plans[0][2] is None and plans[0][3] is None
    assert review == []

from chinese_material_doc import build_groups, rewrite_hash_for_row


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

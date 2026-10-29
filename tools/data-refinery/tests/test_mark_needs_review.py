import json

from mark_needs_review import load_pairs


def test_load_pairs_dedupes_and_ignores_bad_rows(tmp_path):
    p = tmp_path / "issues.jsonl"
    rows = [
        {"source": "卷A", "group_order": 1},
        {"source": "卷A", "group_order": 1},
        {"source": "卷A", "group_order": "2"},
        {"source": "", "group_order": 3},
        {"source": "卷B", "group_order": None},
        "not-json",
    ]
    p.write_text("\n".join(r if isinstance(r, str) else json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    pairs = load_pairs(p)
    assert pairs == [("卷A", 1), ("卷A", 2)]

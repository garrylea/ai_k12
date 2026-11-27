"""review_queue：按题目身份聚合人工校对队列，收口只作用于同一 sub_no。"""

import json

import review_queue


def test_group_items_merges_kinds_and_splits_sub_no(tmp_path):
    rows = [
        {"source": "卷A", "group_order": 26, "sub_no": 0, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 0, "kind": "answer_missing", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 1, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 2, "kind": "answer_missing", "status": "pending"},
    ]
    items = review_queue.group_items(rows)
    assert [i.key for i in items] == [
        ("卷A", 26, 0),
        ("卷A", 26, 1),
        ("卷A", 26, 2),
    ]
    assert len(items[0].flags) == 2


def test_recorded_flags_does_not_close_other_sub_no(tmp_path, monkeypatch):
    p = tmp_path / "issues.jsonl"
    rows = [
        {"source": "卷A", "group_order": 26, "sub_no": 1, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 1, "kind": "answer_missing", "status": "pending"},
        {"source": "卷A", "group_order": 26, "sub_no": 2, "kind": "answer_missing", "status": "pending"},
    ]
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    monkeypatch.setattr(review_queue, "ISSUES_FILE", p)
    item = next(i for i in review_queue.group_items(rows) if i.key == ("卷A", 26, 1))
    assert review_queue.recorded_flags(item, "fixes/卷A.jsonl", "t0") == 2
    saved = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()]
    assert [r["status"] for r in saved] == ["recorded", "recorded", "pending"]


def test_recorded_flags_does_not_downgrade_resolved(tmp_path, monkeypatch):
    p = tmp_path / "issues.jsonl"
    rows = [
        {"source": "卷A", "group_order": 19, "sub_no": 0, "kind": "incomplete_content", "status": "pending"},
        {"source": "卷A", "group_order": 19, "sub_no": 0, "kind": "answer_missing", "status": "resolved", "verdict": "no_change"},
    ]
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    monkeypatch.setattr(review_queue, "ISSUES_FILE", p)
    item = review_queue.group_items(rows)[0]
    review_queue.recorded_flags(item, "fixes/卷A.jsonl", "t0")
    saved = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()]
    assert [r["status"] for r in saved] == ["recorded", "resolved"]


def test_targets_always_returns_self_only():
    rows = [
        {"source": "卷A", "group_order": 14, "sub_no": 0, "kind": "missing",
         "status": "pending", "suspect_group_order": 13},
    ]
    item = review_queue.group_items(rows)[0]
    assert [(t.group_order, t.sub_no) for t in item.targets()] == [(14, 0)]


def test_relation_text_uses_explicit_numbers():
    missing = review_queue.ReviewItem(
        source="卷A", rel_path="数学/x/卷A", group_order=26,
        flags=[{"kind": "missing", "status": "pending", "suspect_group_order": 25}],
    )
    merged = review_queue.ReviewItem(
        source="卷A", rel_path="数学/x/卷A", group_order=25,
        flags=[{
            "kind": "merged_content",
            "status": "pending",
            "related_group_order": 26,
            "related_issue_kind": "missing",
        }],
    )
    assert missing.relation_text() == "第 26 题疑似被第 25 题吞并"
    assert merged.relation_text() == "第 25 题可能混入了第 26 题"

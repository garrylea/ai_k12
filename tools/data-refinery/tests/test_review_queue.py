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


def test_targets_puts_suspect_before_self():
    rows = [
        {"source": "卷A", "group_order": 19, "sub_no": 0, "kind": "missing",
         "status": "pending", "suspect_group_order": 18, "suspect_sub_no": 0},
    ]
    item = review_queue.group_items(rows)[0]
    got = [(t.group_order, t.sub_no) for t in item.targets()]
    assert got == [(18, 0), (19, 0)], "先问把下一题吞进来的那道，再问本题"
    assert item.note() == "题目缺失或被吞，请按原卷补录"


def test_targets_ignores_non_integer_suspect():
    """旧实现有 isinstance 守卫；手改过的 issues 里 suspect 可能是字符串，不能崩。"""
    rows = [
        {"source": "卷A", "group_order": 19, "sub_no": 0, "kind": "missing",
         "status": "pending", "suspect_group_order": "18"},
    ]
    item = review_queue.group_items(rows)[0]
    assert [(t.group_order, t.sub_no) for t in item.targets()] == [(19, 0)]

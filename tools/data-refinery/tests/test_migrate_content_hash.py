from db_loader import content_hash
from migrate_content_hash import plan_updates


def _row(qid, content, old, options=None, material=None, url=None):
    return (qid, content, options, old, material, url)


def test_unique_rows_all_updated():
    rows = [_row(1, "甲", "a" * 64), _row(2, "乙", "b" * 64)]
    updates, conflicts = plan_updates(rows)
    assert {u[0] for u in updates} == {1, 2}
    assert conflicts == []


def test_conflict_keeps_row_already_on_new_hash():
    """5167/7629：同一道题挂两张卷。7629 已是目标哈希 → 保留它，5167 保持旧值。"""
    h = content_hash("同一题", None, None, None)
    rows = [_row(1, "同一题", h), _row(2, "同一题", "f" * 64)]
    updates, conflicts = plan_updates(rows)
    assert updates == []
    assert conflicts[0]["winner"] == 1
    assert conflicts[0]["kept_old"] == [2]


def test_conflict_without_existing_row_picks_smallest_id():
    h = content_hash("同一题", None, None, None)
    rows = [_row(5, "同一题", "a" * 64), _row(3, "同一题", "b" * 64)]
    updates, conflicts = plan_updates(rows)
    assert updates == [(3, h, "b" * 64)]
    assert conflicts[0]["winner"] == 3
    assert conflicts[0]["kept_old"] == [5]


def test_rows_already_correct_are_not_updated():
    h = content_hash("甲", None, None, None)
    updates, conflicts = plan_updates([_row(1, "甲", h)])
    assert updates == [] and conflicts == []

"""黄金快照比对逻辑单测。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from split_snapshot import compare, sample_files  # noqa: E402


def test_compare_identical_returns_empty():
    snap = {"a.md": {"count": 2, "items": [{"no": 1, "hash": "x"}, {"no": 2, "hash": "y"}]}}
    assert compare(snap, snap) == []


def test_compare_reports_count_change():
    base = {"a.md": {"count": 2, "items": []}}
    cur = {"a.md": {"count": 3, "items": []}}
    assert compare(cur, base) == ["a.md: 题数 2 -> 3"]


def test_compare_reports_content_change_and_missing_file():
    base = {"a.md": {"count": 1, "items": [{"no": 1, "hash": "x"}]},
            "b.md": {"count": 1, "items": [{"no": 1, "hash": "z"}]}}
    cur = {"a.md": {"count": 1, "items": [{"no": 1, "hash": "y"}]}}
    diffs = compare(cur, base)
    assert diffs[0].startswith("a.md: 第 1 项")
    assert diffs[1] == "b.md: 基线有、当前缺失"


def test_compare_reports_material_change():
    """材料也是基线维度：只改 mat、其余不变，必须报出差异（compare 不忽略任何键）。"""
    base = {"a.md": {"count": 1, "items": [
        {"no": 1, "hash": "x", "mat": "m1", "gid": "一", "score": 3}]}}
    cur = {"a.md": {"count": 1, "items": [
        {"no": 1, "hash": "x", "mat": "m2", "gid": "一", "score": 3}]}}

    diffs = compare(cur, base)

    assert len(diffs) == 1
    assert diffs[0].startswith("a.md: 第 1 项")
    assert "mat" in diffs[0]
    assert "gid" not in diffs[0] and "score" not in diffs[0]


def test_sample_files_only_picks_papers(tmp_path):
    """教科书单页切不出题，不该进基线；只有文件名含「试卷」的 md 会被抽中。"""
    subject = tmp_path / "a"
    subject.mkdir()
    (subject / "试卷-1.md").write_text("# 1. 题干\n", encoding="utf-8")
    (subject / "page_001.md").write_text("课本正文\n", encoding="utf-8")

    picked = sample_files(tmp_path)

    assert [p.name for p in picked] == ["试卷-1.md"]

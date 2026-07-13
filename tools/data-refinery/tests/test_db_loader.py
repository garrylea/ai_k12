"""db_loader 单元测试：纯函数（subject 归一、rel_path 解析、中文数字、lesson_id 解析、sort_order 重排）。"""
import pytest

from db_loader import (
    chinese_to_int,
    normalize_subject,
    parse_book_rel_path,
    parse_lesson_id,
    renumber_sort_order,
)


class TestNormalizeSubject:
    def test_canonical(self):
        assert normalize_subject("math") == "math"
        assert normalize_subject("chemistry") == "chemistry"

    def test_alias(self):
        assert normalize_subject("chem") == "chemistry"

    def test_unknown_passthrough(self):
        assert normalize_subject("physics") == "physics"


class TestParseBookRelPath:
    def test_six_segments(self):
        rel = "数学/初中/人教版/九年级/下册/义务教育教科书·数学九年级下册/page_008.jsonl"
        r = parse_book_rel_path(rel)
        assert r["subject"] == "数学"
        assert r["grade_band"] == "初中"
        assert r["publisher"] == "人教版"
        assert r["grade"] == "九年级"
        assert r["term"] == "下册"
        assert r["book"] == "义务教育教科书·数学九年级下册"

    def test_upper_volume(self):
        rel = "数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册/page_001.jsonl"
        assert parse_book_rel_path(rel)["term"] == "上册"


class TestChineseToInt:
    @pytest.mark.parametrize("s,n", [
        ("一", 1), ("十", 10), ("十六", 16), ("二十", 20),
        ("二十六", 26), ("三十", 30), ("四十", 40), ("二十九", 29),
        ("一百", 100), ("一百零一", 101), ("一百一十", 110),
    ])
    def test_cases(self, s, n):
        assert chinese_to_int(s) == n


class TestParseLessonId:
    def test_chapter_overview(self):
        r = parse_lesson_id("第二十六章 反比例函数")
        assert r["chapter"] == 26
        assert r["title"] == "反比例函数"
        assert r["is_overview"] is True
        assert r["section"] is None

    def test_section_2level(self):
        r = parse_lesson_id("26.1 反比例函数")
        assert r["chapter"] == 26
        assert r["title"] == "反比例函数"
        assert r["is_overview"] is False
        assert r["section"] == (1,)

    def test_section_3level(self):
        r = parse_lesson_id("26.1.2 反比例函数的图象和性质")
        assert r["chapter"] == 26
        assert r["title"] == "反比例函数的图象和性质"
        assert r["is_overview"] is False
        assert r["section"] == (1, 2)

    def test_none_and_empty(self):
        assert parse_lesson_id(None) is None
        assert parse_lesson_id("") is None
        assert parse_lesson_id("练习") is None  # 非编号标题不解析


class TestRenumberSortOrder:
    def test_global_per_lesson(self):
        # 同一 lesson 跨页，sort_order 逐页从 1 开始 -> 全局重排为 1,2,3
        cards = [
            {"lesson_id": "26.1.1 反比例函数", "sort_order": 1, "content": "a"},
            {"lesson_id": "26.1.1 反比例函数", "sort_order": 1, "content": "b"},  # 次页，与上页碰撞
            {"lesson_id": "26.1.1 反比例函数", "sort_order": 2, "content": "c"},
        ]
        out = renumber_sort_order(cards)
        assert [c["sort_order"] for c in out] == [1, 2, 3]

    def test_empty(self):
        assert renumber_sort_order([]) == []

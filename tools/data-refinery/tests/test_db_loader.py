"""db_loader 单元测试：纯函数（subject 归一、rel_path 解析、中文数字、lesson_id 解析、sort_order 重排、content_metadata 构建）。"""
import pytest

from db_loader import (
    build_content_metadata,
    chinese_to_int,
    normalize_subject,
    parse_book_rel_path,
    parse_lesson_id,
    question_text_valid,
    rebuild_practice_content,
    renumber_sort_order,
)


def _make_loader(query_results: dict):
    """构造不连库的 DbLoader（stub _query/_delete；按 SQL 片段匹配返回预设）。"""
    from db_loader import DbLoader
    loader = DbLoader.__new__(DbLoader)
    queries: list = []

    def fake_query(sql, args=None):
        queries.append((sql, args))
        for frag, rows in query_results.items():
            if frag in sql:
                return rows
        return []

    def fake_delete(sql, args=None):
        queries.append((sql, args))
        for frag, rows in query_results.items():
            if frag in sql:
                return rows[0] if rows else 0
        return 0

    loader._query = fake_query
    loader._delete = fake_delete
    return loader, queries


class TestScopedLessonMatching:
    """_match_lesson_scoped / _match_parent_lesson / _lookup_*：按 semester 作用域匹配。"""

    def test_lookup_semester(self):
        loader, queries = _make_loader({"FROM semesters s JOIN textbook_versions": [(42,)]})
        info = {"subject": "数学", "grade_band": "初中", "publisher": "人教版",
                "grade": "九年级", "term": "上册", "book": "书"}
        assert loader._lookup_semester(info) == 42
        sql_args = [a for sql, a in queries if "semesters" in sql][0]
        assert "math_人教版_junior" in sql_args

    def test_lookup_semester_missing_returns_none(self):
        loader, _ = _make_loader({})
        info = {"subject": "数学", "grade_band": "初中", "publisher": "人教版",
                "grade": "九年级", "term": "上册", "book": "书"}
        assert loader._lookup_semester(info) is None

    def test_unit_scope_preferred(self):
        loader, queries = _make_loader({
            "FROM units WHERE semester_id": [(10,)],          # _lookup_unit 命中
            "WHERE unit_id=%s AND name=%s": [(99,)],          # unit 内 exact 命中
        })
        assert loader._match_lesson_scoped("26.1 反比例函数", 5) == 99
        # 不应再退到 semester 范围查询
        assert all("u.semester_id=%s AND l.name=%s" not in sql for sql, _ in queries)

    def test_unit_miss_falls_to_semester_scope(self):
        loader, _ = _make_loader({
            "FROM units WHERE semester_id": [],               # unit 查不到
            "u.semester_id=%s AND l.name=%s": [(88,)],        # semester 范围命中
        })
        assert loader._match_lesson_scoped("26.1 反比例函数", 5) == 88

    def test_semester_none_falls_back_to_global(self):
        loader, queries = _make_loader({
            "SELECT id FROM lessons WHERE name=%s": [(7,)],
        })
        assert loader._match_lesson_scoped("26.1 反比例函数", None) == 7
        assert all("JOIN units" not in sql for sql, _ in queries)

    def test_cross_book_collision_avoided(self):
        # semester 5 内没有该 lesson（即使其他书有同名）→ None 而非误匹配
        loader, _ = _make_loader({
            "FROM units WHERE semester_id": [],
            "u.semester_id=%s AND l.name=%s": [],
        })
        assert loader._match_lesson_scoped("26.1 反比例函数", 5) is None

    def test_unparsable_label_uses_semester_scope(self):
        # 非编号标签解析不出章号 → 直接 semester 范围查询
        loader, queries = _make_loader({
            "u.semester_id=%s AND l.name=%s": [(66,)],
        })
        assert loader._match_lesson_scoped("小结", 5) == 66
        assert all("FROM units" not in sql for sql, _ in queries)

    def test_parent_lesson_scoped_prefix(self):
        # 精确父节 miss → 作用域内前缀 LIKE 匹配
        loader, queries = _make_loader({
            "FROM units WHERE semester_id": [(10,)],
            "WHERE unit_id=%s AND name=%s": [],
            "u.semester_id=%s AND l.name=%s": [],
            "l.name LIKE %s": [(55,)],
        })
        assert loader._match_parent_lesson("21.2.2 公式法", 5) == 55
        like_sqls = [sql for sql, _ in queries if "LIKE" in sql]
        assert like_sqls and all("semester_id" in sql for sql in like_sqls)

    def test_parent_lesson_legacy_global(self):
        loader, _ = _make_loader({
            "SELECT id FROM lessons WHERE name=%s": [(31,)],
        })
        assert loader._match_parent_lesson("21.2.2 公式法") == 31


class TestSemesterCardReplace:
    """按书替换：增量入库幂等（重跑先删该书旧卡再插）。"""

    def test_stats_queries(self):
        loader, queries = _make_loader({
            "FROM cards c JOIN lessons": [(42,)],       # 该书已有 42 张卡
            "FROM practice_results pr JOIN cards": [(0,)],  # 无学生练习记录引用
        })
        # _table_exists 走 information_schema，fake 返回 []（falsy）→ 视为表不存在，练习计数为 0
        assert loader._semester_card_stats(7) == (42, 0)

    def test_stats_with_practice_results(self):
        loader, _ = _make_loader({
            "information_schema": [(1,)],                  # practice_results 表存在
            "FROM cards c JOIN lessons": [(42,)],
            "FROM practice_results pr JOIN cards": [(5,)],
        })
        assert loader._semester_card_stats(7) == (42, 5)

    def test_replace_delete_scoped_to_semester(self):
        loader, queries = _make_loader({
            "DELETE c FROM cards c": [42],  # rowcount
        })
        assert loader._replace_semester_cards(7) == 42
        sql, args = queries[0]
        assert "u.semester_id=%s" in sql
        assert args == (7,)


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


class TestQuestionTextValid:
    def test_substring_match(self):
        card_content = "(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$ ;"
        assert question_text_valid("(1) $5x^{2}-1=4x$", card_content) is True

    def test_substring_no_match(self):
        card_content = "(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$ ;"
        assert question_text_valid("被改写的题面", card_content) is False

    def test_empty_text(self):
        assert question_text_valid("", "(1) $5x^{2}-1=4x$") is False

    def test_none_text(self):
        assert question_text_valid(None, "(1) $5x^{2}-1=4x$") is False

    def test_whitespace_tolerant(self):
        """全半角/空白差异应被 NFKC 归一后匹配。"""
        card_content = "(1) 5x² - 1 = 4x"
        assert question_text_valid("(1) 5x²-1=4x", card_content) is True


class TestBuildContentMetadata:
    def test_merges_and_marks_fallback(self):
        card_content = "(1) $5x^{2}-1=4x$"
        groups = [{"intro": "解方程：", "questions": [{"n": 1, "text": "(1) $5x^{2}-1=4x$"}]}]
        md = build_content_metadata(groups=groups, card_content=card_content, existing=None)
        assert md["groups"][0]["questions"][0]["n"] == 1
        assert md.get("needs_fallback") is False

    def test_fallback_on_invalid_questions(self):
        card_content = "(1) $5x^{2}-1=4x$"
        groups = [{"intro": None, "questions": [{"n": 1, "text": "幻觉题面"}]}]
        md = build_content_metadata(groups=groups, card_content=card_content, existing=None)
        assert md.get("needs_fallback") is True
        assert md.get("groups") in (None, [])

    def test_preserves_existing_metadata(self):
        card_content = "(1) $5x^{2}-1=4x$"
        existing = {"images": [{"url": "foo.png"}], "override_scroll": True}
        groups = [{"intro": "解方程：", "questions": [{"n": 1, "text": "(1) $5x^{2}-1=4x$"}]}]
        md = build_content_metadata(groups=groups, card_content=card_content, existing=existing)
        assert md["images"] == [{"url": "foo.png"}]
        assert md["override_scroll"] is True
        assert md["groups"][0]["questions"][0]["n"] == 1
        assert md["groups"][0]["intro"] == "解方程："

    def test_none_groups_preserves_existing(self):
        """非 practice 卡（groups=None）不应改动 groups/needs_fallback。"""
        existing = {"images": [{"url": "foo.png"}]}
        md = build_content_metadata(groups=None, card_content="x", existing=existing)
        assert md == {"images": [{"url": "foo.png"}]}
        assert "needs_fallback" not in md
        assert "groups" not in md

    def test_partial_valid_questions(self):
        """部分题面有效 -> 仅保留有效的，needs_fallback=False。"""
        card_content = "(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$"
        groups = [{"intro": None, "questions": [
            {"n": 1, "text": "(1) $5x^{2}-1=4x$"},
            {"n": 2, "text": "幻觉题面"},
        ]}]
        md = build_content_metadata(groups=groups, card_content=card_content, existing=None)
        assert len(md["groups"][0]["questions"]) == 1
        assert md["groups"][0]["questions"][0]["n"] == 1
        assert md.get("needs_fallback") is False

    def test_multi_group_valid(self):
        """两组都有效 -> 保留两组。"""
        card_content = "(1) $5x^{2}-1=4x$\n\n(1) 列方程"
        groups = [
            {"intro": "解方程：", "questions": [{"n": 1, "text": "(1) $5x^{2}-1=4x$"}]},
            {"intro": "列方程：", "questions": [{"n": 1, "text": "(1) 列方程"}]},
        ]
        md = build_content_metadata(groups=groups, card_content=card_content, existing=None)
        assert len(md["groups"]) == 2
        assert md.get("needs_fallback") is False

    def test_one_group_invalid(self):
        """一组无效一组有效 -> 仅保留有效组。"""
        card_content = "(1) $5x^{2}-1=4x$"
        groups = [
            {"intro": "解方程：", "questions": [{"n": 1, "text": "(1) $5x^{2}-1=4x$"}]},
            {"intro": "列方程：", "questions": [{"n": 1, "text": "幻觉题面"}]},
        ]
        md = build_content_metadata(groups=groups, card_content=card_content, existing=None)
        assert len(md["groups"]) == 1
        assert md["groups"][0]["intro"] == "解方程："
        assert md.get("needs_fallback") is False


class TestRebuildPracticeContent:
    def test_single_group_with_intro_and_questions(self):
        groups = [{
            "intro": "解下列方程：",
            "questions": [
                {"n": 1, "text": "(1) $5x^{2}-1=4x$"},
                {"n": 2, "text": "(2) $4x^{2}=81$"},
            ],
        }]
        result = rebuild_practice_content(groups)
        expected = "解下列方程：\n\n(1) $5x^{2}-1=4x$\n\n(2) $4x^{2}=81$"
        assert result == expected

    def test_single_group_no_intro(self):
        groups = [{
            "intro": None,
            "questions": [
                {"n": 1, "text": "(1) 计算 $2+3$"},
                {"n": 2, "text": "(2) 计算 $5-1$"},
            ],
        }]
        result = rebuild_practice_content(groups)
        assert result == "(1) 计算 $2+3$\n\n(2) 计算 $5-1$"

    def test_empty_questions(self):
        groups = [{"intro": "题目：", "questions": []}]
        result = rebuild_practice_content(groups)
        assert result == "题目："

    def test_empty_groups(self):
        result = rebuild_practice_content([])
        assert result == ""

    def test_intro_whitespace_only(self):
        groups = [{"intro": "   ", "questions": [{"n": 1, "text": "(1) $x=1$"}]}]
        result = rebuild_practice_content(groups)
        assert result == "(1) $x=1$"

    def test_preserves_latex(self):
        groups = [{"intro": None, "questions": [{"n": 1, "text": "(1) $\\frac{1}{2}x^{2}+3x-5=0$"}]}]
        result = rebuild_practice_content(groups)
        assert "$\\frac{1}{2}x^{2}+3x-5=0$" in result

    def test_multi_group_rebuild(self):
        """两组各有 intro+questions，组间用 \\n\\n 分隔。"""
        groups = [
            {"intro": "1. 解方程：", "questions": [
                {"n": 1, "text": "(1) $x^{2}=4$"},
                {"n": 2, "text": "(2) $y^{2}=9$"},
            ]},
            {"intro": "2. 列方程：", "questions": [
                {"n": 1, "text": "(1) 4个正方形面积之和是25"},
                {"n": 2, "text": "(2) 矩形长比宽多2"},
            ]},
        ]
        result = rebuild_practice_content(groups)
        expected = (
            "1. 解方程：\n\n(1) $x^{2}=4$\n\n(2) $y^{2}=9$"
            "\n\n"
            "2. 列方程：\n\n(1) 4个正方形面积之和是25\n\n(2) 矩形长比宽多2"
        )
        assert result == expected

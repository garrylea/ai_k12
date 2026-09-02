"""db_loader 单元测试：纯函数（subject 归一、rel_path 解析、中文数字、lesson_id 解析、sort_order 重排、content_metadata 构建）。"""
import pytest

from db_loader import (
    build_content_metadata,
    chinese_to_int,
    edition_from_book_name,
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
    # __new__ 跳过 __init__，手动补缓存字典（_find_or_create_* 系列会用到）
    loader._subj_code, loader._tv = {}, {}
    loader._sem, loader._unit, loader._lesson = {}, {}, {}
    return loader, queries


class TestScopedLessonMatching:
    """_match_lesson_scoped / _match_parent_lesson / _lookup_*：按 semester 作用域匹配。"""

    def test_lookup_semester(self):
        loader, queries = _make_loader({
            "FROM subjects WHERE code": [(1,)],                 # subject_id
            "FROM semesters s JOIN textbook_versions": [(42,)],
        })
        info = {"subject": "数学", "grade_band": "初中", "publisher": "人教版",
                "grade": "九年级", "term": "上册", "book": "书"}
        assert loader._lookup_semester(info) == 42
        sql_args = [a for sql, a in queries if "semesters" in sql][0]
        # 4 元组定位：(subject_id, publisher, grade_band, edition, grade, term)
        assert sql_args == (1, "人教版", "junior", "", "grade_9", "first")

    def test_lookup_semester_with_edition(self):
        """带版次标记的书名 -> edition 进 4 元组定位，两版教材互不串semester。"""
        loader, queries = _make_loader({
            "FROM subjects WHERE code": [(1,)],
            "FROM semesters s JOIN textbook_versions": [(43,)],
        })
        info = {"subject": "数学", "grade_band": "初中", "publisher": "人教版",
                "grade": "九年级", "term": "上册",
                "book": "（根据2022年版课程标准修订）义务教育教科书·数学九年级上册"}
        assert loader._lookup_semester(info) == 43
        sql_args = [a for sql, a in queries if "semesters" in sql][0]
        assert sql_args[3] == "根据2022年版课程标准修订"

    def test_lookup_semester_missing_returns_none(self):
        loader, _ = _make_loader({"FROM subjects WHERE code": [(1,)]})
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


class TestEditionFromBookName:
    def test_edition_marker_extracted(self):
        assert edition_from_book_name(
            "（根据2022年版课程标准修订）义务教育教科书·数学九年级上册"
        ) == "根据2022年版课程标准修订"

    def test_no_marker_returns_empty(self):
        assert edition_from_book_name("义务教育教科书·数学九年级上册") == ""

    def test_upper_lower_volume_share_edition(self):
        """同一版次的九上/九下书名不同但前导括号相同 -> 同一版次。"""
        up = edition_from_book_name("（根据2022年版课程标准修订）义务教育教科书·数学九年级上册")
        down = edition_from_book_name("（根据2022年版课程标准修订）义务教育教科书·数学九年级下册")
        assert up == down != ""

    def test_half_width_parens(self):
        assert edition_from_book_name("(2024修订)数学九年级上册") == "2024修订"

    def test_marker_not_at_start_ignored(self):
        """括号不在书名开头（如书名中间的括号注记）不算版次标记。"""
        assert edition_from_book_name("义务教育教科书·数学九年级上册（2024）") == ""

    def test_none_and_empty(self):
        assert edition_from_book_name(None) == ""
        assert edition_from_book_name("") == ""

    def test_leading_whitespace(self):
        assert edition_from_book_name("  （修订版）数学") == "修订版"


class TestFindOrCreateTextbookVersion:
    def test_edition_in_lookup_and_insert(self):
        """带版次：查询走 4 元组、INSERT 带 edition，code/name 拼入版次。"""
        from db_loader import DbLoader
        loader = DbLoader.__new__(DbLoader)
        loader._tv, loader._subj_code = {}, {}
        queries: list = []

        tv_queries = {"n": 0}

        def fake_query(sql, args=None):
            queries.append((sql, args))
            if "FROM subjects WHERE code" in sql:
                return [(1,)]
            if "FROM textbook_versions WHERE subject_id" in sql:
                tv_queries["n"] += 1
                # 首次 find 查无 -> 触发 INSERT；insert 后回查 -> 新 id
                return [] if tv_queries["n"] == 1 else [(1,)]
            return []

        loader._query = fake_query
        loader._exec = lambda sql, args=None: queries.append((sql, args))

        tid = loader._find_or_create_textbook_version(
            "math", "人教版", "junior", "根据2022年版课程标准修订")
        assert tid == 1
        insert_sql, insert_args = [
            (sql, a) for sql, a in queries if "INSERT INTO textbook_versions" in sql][0]
        assert insert_args[1] == "人教版（根据2022年版课程标准修订）"          # name
        assert insert_args[2] == "math_人教版_根据2022年版课程标准修订_junior"   # code
        assert insert_args[5] == "根据2022年版课程标准修订"                     # edition
        # find 查询按 4 元组（subject_id, publisher, grade_band, edition）
        find_sql, find_args = [
            (sql, a) for sql, a in queries if "SELECT id FROM textbook_versions" in sql][0]
        assert find_args == (1, "人教版", "junior", "根据2022年版课程标准修订")
        assert "edition=%s" in find_sql

    def test_no_edition_backward_compatible(self):
        """无版次：name=publisher、code 不拼 edition，与存量 2012 行兼容。"""
        loader, queries = _make_loader({
            "FROM subjects WHERE code": [(1,)],
            "FROM textbook_versions WHERE subject_id": [(275,)],
        })
        assert loader._find_or_create_textbook_version("math", "人教版", "junior") == 275
        assert not any("INSERT INTO textbook_versions" in sql for sql, _ in queries)


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


class TestAnchorCorrection:
    """load_book_cards TOC 模式页码锚定修正（2026-09-02）。

    锚定：卡片 textbook_page（md 页码）-> 偏移（同标签卡片 min md 页 - printed 众数）
    -> TOC 章区间 -> 确定性章归属。规则：A 错章重写、B 同名消歧、C 复习题归一。
    无锚（对不上/无 TOC）退化为既有匹配行为。
    fake_query 按 (SQL 前缀, args) 精确分发，避免 SQL 片段混淆。
    """

    # rel_path 需 7 段（subject/grade_band/publisher/grade/term/book/page.jsonl）
    BOOK_REL = "数学/初中/人教版/九年级/上册/测试书/page_001.jsonl"

    TOC = {
        "book": "测试书",
        "chapters": [
            {"number": 26, "title": "二次函数", "label": "第二十六章 二次函数",
             "sections": [{"number": [26, 1], "title": "二次函数的概念",
                           "label": "26.1 二次函数的概念", "printed_page": 30,
                           "subsections": []}],
             "supplements": []},
            {"number": 27, "title": "反比例函数", "label": "第二十七章 反比例函数",
             "sections": [{"number": [27, 1], "title": "反比例函数的概念",
                           "label": "27.1 反比例函数的概念", "printed_page": 64,
                           "subsections": []}],
             "supplements": []},
        ],
    }

    # unit 10 = 26 章（lessons 102 章综述/103 节/104 小结）；unit 11 = 27 章（105/106/107）
    LESSONS = [
        (102, "第二十六章 二次函数", 10, 0),
        (103, "26.1 二次函数的概念", 10, 1),
        (104, "小结", 10, 2),
        (105, "第二十七章 反比例函数", 11, 0),
        (106, "27.1 反比例函数的概念", 11, 1),
        (107, "小结", 11, 2),
    ]

    def _make(self, scoped_name_rows=None):
        """scoped_name_rows: semester 级按名匹配（退化路径）的返回行，默认 []。"""
        import json as _json
        from db_loader import DbLoader
        loader = DbLoader.__new__(DbLoader)
        inserted = []

        def fake_query(sql, args=None):
            s = sql.strip()
            if s.startswith("SELECT id FROM subjects"):
                return [(1,)]
            if "FROM semesters s JOIN textbook_versions" in s:
                return [(42,)]
            if "FROM cards c JOIN lessons l ON c.lesson_id=l.id" in s:
                return [(0,)]
            if "FROM practice_results" in s:
                return [(0,)]
            if s.startswith("SELECT id, sort_order FROM units"):
                return [(10, 26), (11, 27)]
            if s.startswith("SELECT l.id, l.name, l.unit_id, l.sort_order"):
                return self.LESSONS
            if s.startswith("SELECT id FROM units WHERE semester_id"):
                # args = (sem_id, chapter)
                return [({26: 10, 27: 11}.get(args[1]),)]
            if s.startswith("SELECT id FROM lessons WHERE unit_id"):
                # args = (unit_id, name) —— unit 精确匹配
                uid, name = args
                for lid_db, lname, luid, _ in self.LESSONS:
                    if luid == uid and lname == name:
                        return [(lid_db,)]
                return []
            if "AND l.name=%s" in s:
                return scoped_name_rows or []
            return []

        loader._query = fake_query
        loader._delete = lambda sql, args=None: 0
        loader._exec = lambda sql, args=None: inserted.append(args)
        loader._conn = type("C", (), {"commit": staticmethod(lambda: None)})()
        loader._subj_code, loader._tv = {}, {}
        loader._sem, loader._unit, loader._lesson = {}, {}, {}
        return loader, inserted

    def _run(self, cards, scoped_name_rows=None):
        import json as _json
        import pathlib
        import tempfile
        loader, inserted = self._make(scoped_name_rows)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                         encoding="utf-8") as f:
            _json.dump(self.TOC, f, ensure_ascii=False)
            toc_path = f.name
        try:
            n = loader.load_book_cards(self.BOOK_REL, cards, toc_path=toc_path)
        finally:
            pathlib.Path(toc_path).unlink()
        return n, inserted

    # 对齐卡：26.1 printed 30 -> md 38；27.1 printed 64 -> md 72（偏移 8）
    ALIGN_CARDS = [
        {"lesson_id": "26.1 二次函数的概念", "textbook_page": "P38", "content": "x"},
        {"lesson_id": "27.1 反比例函数的概念", "textbook_page": "P72", "content": "x"},
    ]

    def test_rule_a_wrong_chapter_with_review_heading(self):
        # page_092 场景：复习题 27 卡被 LLM 标成 26 章 -> 重写到 27 章小结（lesson 107）
        cards = self.ALIGN_CARDS + [
            {"lesson_id": "第二十六章 二次函数", "textbook_page": "P92",
             "content": "## 复习题 27\n\n1. 回顾本章内容。", "card_type": "concept"},
        ]
        n, inserted = self._run(cards)
        assert n == 3
        # 第三张卡的 lesson_id 应为 107（27 章小结），而非 26 章综述 102
        assert inserted[2][0] == 107

    def test_rule_a_wrong_chapter_falls_back_to_active_lesson(self):
        # 错章且无复习题标题 -> 时间线活跃节（page 75 落在 27.1 区段，printed 64+8=72 起）
        # -> 27.1 lesson（106）；活跃节解析不到再落章综述
        cards = self.ALIGN_CARDS + [
            {"lesson_id": "26.1 二次函数的概念", "textbook_page": "P75",
             "content": "反比例函数的图象是双曲线。", "card_type": "concept"},
        ]
        n, inserted = self._run(cards)
        assert n == 3
        assert inserted[2][0] == 106

    def test_rule_a_review_continuation_page_attaches_summary(self):
        # page_119 场景：复习题 28 续页（无复习题标题，前章末尾）被标成 26 章综述；
        # 综述卡锚定 27 章头=md 69、时间线活跃节=小结（printed 109+8=117 起）
        # -> 27 章「小结」（107），而非 26 章综述
        toc = {
            "book": "测试书",
            "chapters": [
                {"number": 26, "title": "二次函数", "label": "第二十六章 二次函数",
                 "sections": [{"number": [26, 1], "title": "二次函数的概念",
                               "label": "26.1 二次函数的概念", "printed_page": 30,
                               "subsections": []}],
                 "supplements": [{"type": "supplement", "label": "小结",
                                  "printed_page": 39}]},
                {"number": 27, "title": "反比例函数", "label": "第二十七章 反比例函数",
                 "sections": [{"number": [27, 1], "title": "反比例函数的概念",
                               "label": "27.1 反比例函数的概念", "printed_page": 64,
                               "subsections": []}],
                 "supplements": [{"type": "supplement", "label": "小结",
                                  "printed_page": 109}]},
            ],
        }
        cards = self.ALIGN_CARDS + [
            {"lesson_id": "第二十六章 二次函数", "textbook_page": "P35", "content": "x"},
            {"lesson_id": "第二十七章 反比例函数", "textbook_page": "P69", "content": "x"},
            {"lesson_id": "第二十六章 二次函数", "textbook_page": "P118",
             "content": "10. 如图，有一张纸片……", "card_type": "practice"},
        ]
        import json as _json
        import pathlib
        import tempfile
        loader, inserted = self._make()
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                         encoding="utf-8") as f:
            _json.dump(toc, f, ensure_ascii=False)
            toc_path = f.name
        try:
            n = loader.load_book_cards(self.BOOK_REL, cards, toc_path=toc_path)
        finally:
            pathlib.Path(toc_path).unlink()
        assert n == 5
        assert inserted[-1][0] == 107

    def test_rule_b_same_name_disambiguation(self):
        # 「小结」×2 章：page 91（27 章区间，起点 69）的小结卡挂 27 章小结（107），
        # 而非 _match_lesson_scoped 同名匹配到的第一个（104）
        cards = self.ALIGN_CARDS + [
            {"lesson_id": "小结", "textbook_page": "P91",
             "content": "一、本章知识结构图……", "card_type": "concept"},
        ]
        n, inserted = self._run(cards)
        assert n == 3
        assert inserted[2][0] == 107

    def test_rule_b_page_in_first_chapter_attaches_first_chapter(self):
        # page 40（26 章区间，起点 35）的小结卡挂 26 章小结（104）
        cards = self.ALIGN_CARDS + [
            {"lesson_id": "小结", "textbook_page": "P40",
             "content": "一、本章知识结构图……", "card_type": "concept"},
        ]
        n, inserted = self._run(cards)
        assert inserted[2][0] == 104

    def test_rule_c_review_label_normalized_to_summary(self):
        # 「复习题 27」标签（章号与锚定一致）-> 归一到该章「小结」（107），不新建 lesson
        cards = self.ALIGN_CARDS + [
            {"lesson_id": "复习题 27", "textbook_page": "P93",
             "content": "## 复习题 27\n\n复习巩固 1. ……", "card_type": "practice"},
        ]
        n, inserted = self._run(cards)
        assert n == 3
        assert inserted[2][0] == 107

    def test_correct_label_untouched_by_anchor(self):
        # 正确标签（26 章综述卡在 26 章页）不受锚定影响，走既有匹配
        cards = self.ALIGN_CARDS + [
            {"lesson_id": "第二十六章 二次函数", "textbook_page": "P36",
             "content": "章前图与引言。", "card_type": "reading"},
        ]
        n, inserted = self._run(cards)
        assert n == 3
        assert inserted[2][0] == 102

    def test_no_anchor_degrades_to_existing_matching(self):
        # 卡片标签与 TOC 全对不上 -> 锚定关闭 -> 「小结」仍按既有逻辑同名匹配
        cards = [
            {"lesson_id": "小结", "textbook_page": "P91",
             "content": "一、本章知识结构图……", "card_type": "concept"},
        ]
        n, inserted = self._run(cards, scoped_name_rows=[(104,)])
        assert n == 1
        assert inserted[0][0] == 104

    def test_null_lesson_id_skipped_as_before(self):
        # lesson_id 为 None 的卡（锚定无意见）仍按既有行为跳过
        cards = self.ALIGN_CARDS + [
            {"lesson_id": None, "textbook_page": "P91", "content": "x"},
        ]
        n, inserted = self._run(cards)
        assert n == 2  # 仅对齐卡入库


# ---------- 试卷归组（exam_papers / paper_questions） ----------

def _make_loader_seq(query_sequences: dict):
    """同 _make_loader 思路，但 _query 按 SQL 片段匹配、依序弹出预设结果
    （同一片段多次查询可返回不同结果，如 content_hash 先 miss 后 hit），
    并额外 stub _exec / _conn.commit（load_questions 写路径需要）。"""
    from collections import deque

    from db_loader import DbLoader
    loader = DbLoader.__new__(DbLoader)
    queries: list = []
    seqs = {frag: deque(rows) for frag, rows in query_sequences.items()}

    def fake_query(sql, args=None):
        queries.append((sql, args))
        for frag, dq in seqs.items():
            if frag in sql:
                return dq.popleft() if dq else []
        return []

    def fake_exec(sql, args=None):
        queries.append((sql, args))

    loader._query = fake_query
    loader._exec = fake_exec
    loader._delete = lambda sql, args=None: 0
    loader._subj_code, loader._subj_name, loader._tv = {}, {}, {}
    loader._sem, loader._unit, loader._lesson = {}, {}, {}
    loader._conn = type("C", (), {"commit": staticmethod(lambda: None)})()
    return loader, queries


def _paper_meta(**overrides):
    from paper_meta import PaperMeta
    kwargs = dict(subject="数学", grade="初三", grade_band="junior", semester="second",
                  year=2024, district="海淀", exam_type="模拟二", file_type="试卷",
                  title="2024 海淀 初三 模拟二")
    kwargs.update(overrides)
    return PaperMeta(**kwargs)


class TestFindOrCreatePaper:
    def test_inserts_when_missing(self):
        loader, queries = _make_loader_seq({
            "FROM exam_papers WHERE source_key": [[]],
            "LAST_INSERT_ID": [[(99,)]],
        })
        meta = _paper_meta()
        pid = loader._find_or_create_paper(meta, 1, "数学/初中/second/2024/xx-试卷")
        assert pid == 99
        inserts = [a for sql, a in queries if sql.startswith("INSERT INTO exam_papers")]
        assert len(inserts) == 1
        # 参数含 source_key 与元数据字段
        assert inserts[0][-1] == "数学/初中/second/2024/xx-试卷"
        assert inserts[0][0] == 1  # subject_id
        assert inserts[0][1] == meta.title

    def test_hit_returns_existing_without_insert(self):
        loader, queries = _make_loader_seq({
            "FROM exam_papers WHERE source_key": [[(7,)]],
        })
        pid = loader._find_or_create_paper(_paper_meta(), 1, "k")
        assert pid == 7
        assert all(not sql.startswith("INSERT INTO exam_papers") for sql, _ in queries)

    def test_from_meta_maps_chinese_subject_to_code(self):
        """meta.subject 是中文学科名（路径首段），须经 name->code 映射查 subjects。"""
        loader, queries = _make_loader_seq({
            "FROM subjects WHERE code": [[(1,)]],
            "FROM exam_papers WHERE source_key": [[(7,)]],
        })
        pid = loader.find_or_create_paper_from_meta(_paper_meta(), "k")
        assert pid == 7
        subj_args = [a for sql, a in queries if "FROM subjects WHERE code" in sql]
        assert subj_args == [("math",)]


class TestLoadQuestionsPaperGrouping:
    QS = [
        {"subject_id": "math", "content": "题干一", "type": "choice",
         "group_id": "一", "group_order": 1},
        {"subject_id": "math", "content": "题干二", "type": "choice",
         "group_id": "一", "group_order": 2},
    ]

    def test_new_and_reused_questions_linked_in_line_order(self):
        # 题干一 hash miss -> INSERT questions + LAST_INSERT_ID；题干二 hash hit -> 复用 123
        loader, queries = _make_loader_seq({
            "FROM subjects WHERE code": [[(1,)]],          # 之后走 _subj_code 缓存
            "FROM questions WHERE content_hash": [[], [(123,)]],
            "LAST_INSERT_ID": [[(501,)]],
        })
        n = loader.load_questions(self.QS, paper=(_paper_meta(), 9))
        assert n == 1  # 返回值语义：新插入题数
        # 新题只 INSERT questions 一次；命中题不动 questions 行
        q_inserts = [sql for sql, _ in queries if sql.startswith("INSERT INTO questions ")]
        assert len(q_inserts) == 1
        # 两题都写 paper_questions，question_no 按 JSONL 行序 1..n
        pq = [a for sql, a in queries if "INSERT IGNORE INTO paper_questions" in sql]
        assert pq == [
            (9, 501, 1, "一", 1),   # 新题：qid 来自 LAST_INSERT_ID
            (9, 123, 2, "一", 2),   # 复用题：qid 来自 content_hash 命中
        ]
        # 结束时刷新 question_count（含复用题，共 2）
        upd = [a for sql, a in queries if "UPDATE exam_papers SET question_count" in sql]
        assert upd == [(2, 9)]

    def test_paper_none_no_paper_sql(self):
        """paper=None（无试卷上下文）：行为与旧版完全一致，零 paper SQL。"""
        loader, queries = _make_loader_seq({
            "FROM subjects WHERE code": [[(1,)]],
            "FROM questions WHERE content_hash": [[]],
            "LAST_INSERT_ID": [[(501,)]],
        })
        n = loader.load_questions(self.QS[:1])
        assert n == 1
        assert all("exam_papers" not in sql and "paper_questions" not in sql
                   for sql, _ in queries)

from pathlib import Path
from unittest.mock import MagicMock, patch

from toc_parse_cli import (
    _find_toc_pages,
    _is_textbook_dir,
    _expand_grade_term,
    _build_textbook_list,
    _is_toc_like_page,
)


class TestIsTextbookDir:
    def test_textbook_identified(self):
        # 数学/初中/人教版/九年级/上册 → publisher at index 2
        assert _is_textbook_dir(("数学", "初中", "人教版", "九年级", "上册")) is True

    def test_exam_rejected_second(self):
        # 数学/初中/second/2024/海淀-试卷 → "second" at index 2
        assert _is_textbook_dir(("数学", "初中", "second", "2024", "海淀-试卷")) is False

    def test_exam_rejected_year_digit(self):
        # 某路径第 3 段是纯数字年份
        assert _is_textbook_dir(("数学", "初中", "2024", "海淀", "试卷")) is False

    def test_short_path_rejected(self):
        assert _is_textbook_dir(("数学",)) is False


class TestExpandGradeTerm:
    def test_shorthand_九上(self):
        assert _expand_grade_term("九上") == ("九年级", "上册")

    def test_shorthand_9上(self):
        assert _expand_grade_term("9上") == ("九年级", "上册")

    def test_shorthand_七下(self):
        assert _expand_grade_term("七下") == ("七年级", "下册")

    def test_full_format(self):
        assert _expand_grade_term("九年级上册") == ("九年级", "上册")

    def test_slash_format(self):
        assert _expand_grade_term("九年级/上册") == ("九年级", "上册")

    def test_comma_format(self):
        assert _expand_grade_term("九,上") == ("九年级", "上册")

    def test_grade_only(self):
        assert _expand_grade_term("九年级") == ("九年级", None)

    def test_term_only(self):
        assert _expand_grade_term("上册") == (None, "上册")

    def test_unknown_returns_raw(self):
        grade, term = _expand_grade_term("xyz")
        assert grade == "xyz"
        assert term is None


class TestFindTocPages:
    def test_finds_toc_page_with_directory_text(self, tmp_path):
        book_dir = tmp_path / "book"
        book_dir.mkdir()
        (book_dir / "page_001.md").write_text("# 封面", encoding="utf-8")
        (book_dir / "page_002.md").write_text("## 目录\n26.1 反比例函数 2", encoding="utf-8")
        (book_dir / "page_003.md").write_text("# 第二十六章", encoding="utf-8")
        pages = _find_toc_pages(book_dir)
        assert len(pages) == 1
        assert "page_002" in pages[0].name

    def test_no_toc_returns_empty(self, tmp_path):
        book_dir = tmp_path / "book"
        book_dir.mkdir()
        (book_dir / "page_001.md").write_text("# 封面", encoding="utf-8")
        (book_dir / "page_002.md").write_text("# 第二十六章", encoding="utf-8")
        assert _find_toc_pages(book_dir, max_pages=10) == []

    def test_multi_page_toc(self, tmp_path):
        """跨页目录：page_005 有'目录'锚点，page_006 是续页，page_007 是正文。"""
        book_dir = tmp_path / "book"
        book_dir.mkdir()
        (book_dir / "page_004.md").write_text("# 前言", encoding="utf-8")
        # page_005: TOC 锚点页
        (book_dir / "page_005.md").write_text(
            "26.1 反比例函数 2\n"
            "## 目录\n"
            "26.2 实际问题与反比例函数 12\n"
            "小结 20\n",
            encoding="utf-8",
        )
        # page_006: TOC 续页（无"目录"但内容是编号+页码）
        (book_dir / "page_006.md").write_text(
            "## 第二十八章 锐角三角函数\n"
            "28.1 锐角三角函数 61\n"
            "28.2 解直角三角形及其应用 72\n"
            "小结 83\n",
            encoding="utf-8",
        )
        # page_007: 正文（不是目录）
        (book_dir / "page_007.md").write_text(
            "# 第二十六章 反比例函数\n\n"
            "在本章中，我们将学习反比例函数的概念和性质。"
            "反比例函数是初中数学的重要内容之一。\n",
            encoding="utf-8",
        )
        pages = _find_toc_pages(book_dir)
        assert len(pages) == 2
        assert "page_005" in pages[0].name
        assert "page_006" in pages[1].name

    def test_toc_continuation_stops_at_body(self, tmp_path):
        """续页碰到正文（长段落）即停止。"""
        book_dir = tmp_path / "book"
        book_dir.mkdir()
        (book_dir / "page_005.md").write_text("## 目录\n26.1 反比例函数 2\n", encoding="utf-8")
        # page_006 是正文：含"## 思考"教学模块标题
        (book_dir / "page_006.md").write_text(
            "## 思考\n\n请同学们思考以下问题：反比例函数的图象有什么特点？\n", encoding="utf-8"
        )
        pages = _find_toc_pages(book_dir)
        assert len(pages) == 1
        assert "page_005" in pages[0].name


class TestIsTocLikePage:
    def test_toc_page_identified(self, tmp_path):
        p = tmp_path / "toc.md"
        p.write_text("26.1 反比例函数 2\n28.1 锐角三角函数 61\n小结 83\n", encoding="utf-8")
        assert _is_toc_like_page(p) is True

    def test_body_page_rejected(self, tmp_path):
        p = tmp_path / "body.md"
        p.write_text(
            "# 第二十六章 反比例函数\n\n"
            "反比例函数是形如 y=k/x (k≠0) 的函数。"
            "本章将学习反比例函数的定义、图象和性质。\n",
            encoding="utf-8",
        )
        assert _is_toc_like_page(p) is False

    def test_practice_page_rejected(self, tmp_path):
        p = tmp_path / "practice.md"
        p.write_text("## 练习\n\n1. 画出下列函数的图象：\n(1) y=1/x\n(2) y=2/x\n", encoding="utf-8")
        assert _is_toc_like_page(p) is False

    def test_empty_page_rejected(self, tmp_path):
        p = tmp_path / "empty.md"
        p.write_text("", encoding="utf-8")
        assert _is_toc_like_page(p) is False


class TestBuildTextbookList:
    def test_filters_out_exam_dirs(self, tmp_path):
        """试卷目录应被排除。"""
        md_dir = tmp_path / "md"
        # 教材：6 级深度 {subject}/{grade_band}/{publisher}/{grade}/{term}/{book}
        textbook = md_dir / "数学" / "初中" / "人教版" / "九年级" / "上册" / "义务教育教科书"
        exam = md_dir / "数学" / "初中" / "second" / "2024" / "海淀-试卷" / "海淀-试卷"
        textbook.mkdir(parents=True)
        exam.mkdir(parents=True)
        (textbook / "page_005.md").write_text("## 目录", encoding="utf-8")
        (exam / "page_001.md").write_text("试卷内容", encoding="utf-8")

        from argparse import Namespace
        args = Namespace(source="smartedu", subject=None, publisher=None,
                         grade=None, term=None, book=None)
        result = _build_textbook_list(md_dir, args)
        rels = [str(r.relative_to(md_dir)) for r in result]
        assert "数学/初中/人教版/九年级/上册/义务教育教科书" in rels
        assert "数学/初中/second/2024/海淀-试卷/海淀-试卷" not in rels

    def test_subject_filter(self, tmp_path):
        md_dir = tmp_path / "md"
        (md_dir / "数学/初中/人教版/九年级/上册/数学书").mkdir(parents=True)
        (md_dir / "语文/初中/人教版/九年级/上册/语文书").mkdir(parents=True)

        from argparse import Namespace
        args = Namespace(source="smartedu", subject="数学", publisher=None,
                         grade=None, term=None, book=None)
        result = _build_textbook_list(md_dir, args)
        rels = [str(r.relative_to(md_dir)) for r in result]
        assert len(rels) == 1
        assert "数学" in rels[0]

    def test_grade_term_filter_shorthand(self, tmp_path):
        md_dir = tmp_path / "md"
        (md_dir / "数学/初中/人教版/九年级/上册/数学书").mkdir(parents=True)
        (md_dir / "数学/初中/人教版/九年级/下册/数学书").mkdir(parents=True)

        from argparse import Namespace
        args = Namespace(source="smartedu", subject=None, publisher=None,
                         grade="九上", term=None, book=None)
        result = _build_textbook_list(md_dir, args)
        rels = [str(r.relative_to(md_dir)) for r in result]
        assert len(rels) == 1
        assert "上册" in rels[0]

    def test_skips_hidden_dirs(self, tmp_path):
        """隐藏目录（.DS_Store 等）应被跳过。"""
        md_dir = tmp_path / "md"
        (md_dir / "数学/初中/人教版/九年级/上册/数学书").mkdir(parents=True)
        # 创建一个以 . 开头的假目录
        (md_dir / "数学/初中/人教版/九年级/.DS_Store/DummyBook").mkdir(parents=True)

        from argparse import Namespace
        args = Namespace(source="smartedu", subject=None, publisher=None,
                         grade=None, term=None, book=None)
        result = _build_textbook_list(md_dir, args)
        rels = [str(r.relative_to(md_dir)) for r in result]
        assert len(rels) == 1
        assert "数学书" in rels[0]


class TestTocParseCliMain:
    def test_dry_run_prints_toc_pages(self, tmp_path, capsys):
        # 6 级教材目录：{subject}/{grade_band}/{publisher}/{grade}/{term}/{book}
        book_dir = tmp_path / "md" / "数学" / "初中" / "人教版" / "九年级" / "下册" / "数学书"
        book_dir.mkdir(parents=True)
        (book_dir / "page_005.md").write_text("## 目录\n26.1 反比例函数 2", encoding="utf-8")
        with patch("toc_parse_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=tmp_path / "out")
            from toc_parse_cli import main
            main(["--input-dir", str(tmp_path / "md"), "--dry-run"])
        out = capsys.readouterr().out
        assert "[dry-run]" in out
        assert "toc page" in out

    def test_dry_run_excludes_exams(self, tmp_path, capsys):
        md_dir = tmp_path / "md"
        (md_dir / "数学/初中/人教版/九年级/上册/数学书").mkdir(parents=True)
        (md_dir / "数学/初中/second/2024/海淀-试卷/海淀-试卷").mkdir(parents=True)
        with patch("toc_parse_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=tmp_path / "out")
            from toc_parse_cli import main
            main(["--input-dir", str(md_dir), "--dry-run"])
        out = capsys.readouterr().out
        assert "人教版" in out
        assert "海淀" not in out

    def test_grade_shorthand_filter(self, tmp_path, capsys):
        md_dir = tmp_path / "md"
        (md_dir / "数学/初中/人教版/九年级/上册/数学书").mkdir(parents=True)
        (md_dir / "数学/初中/人教版/九年级/下册/数学书").mkdir(parents=True)
        with patch("toc_parse_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=tmp_path / "out")
            from toc_parse_cli import main
            main(["--input-dir", str(md_dir), "--grade", "九上", "--dry-run"])
        out = capsys.readouterr().out
        assert "上册" in out
        assert "下册" not in out

    def test_book_filter(self, tmp_path, capsys):
        book1 = tmp_path / "md" / "数学" / "初中" / "人教版" / "九年级" / "上册" / "数学书"
        book2 = tmp_path / "md" / "数学" / "初中" / "人教版" / "九年级" / "下册" / "数学书"
        book1.mkdir(parents=True)
        book2.mkdir(parents=True)
        (book1 / "page_005.md").write_text("## 目录\n内容", encoding="utf-8")
        (book2 / "page_005.md").write_text("## 目录\n内容", encoding="utf-8")
        with patch("toc_parse_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=tmp_path / "out")
            from toc_parse_cli import main
            main(["--input-dir", str(tmp_path / "md"), "--book", "下册", "--dry-run"])
        out = capsys.readouterr().out
        assert "下册" in out
        assert "上册" not in out

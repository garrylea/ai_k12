from pathlib import Path
from unittest.mock import MagicMock, patch

from toc_parse_cli import (
    _find_toc_pages,
    _is_textbook_dir,
    _expand_grade_term,
    _build_textbook_list,
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

    def test_multiple_toc_pages(self, tmp_path):
        book_dir = tmp_path / "book"
        book_dir.mkdir()
        (book_dir / "page_005.md").write_text("## 目录\n26.1 反比例函数 2", encoding="utf-8")
        (book_dir / "page_006.md").write_text("## 目录\n27.1 图形的相似 24", encoding="utf-8")
        assert len(_find_toc_pages(book_dir)) == 2


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

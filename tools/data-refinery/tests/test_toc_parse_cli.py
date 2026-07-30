from pathlib import Path
from unittest.mock import MagicMock, patch
from toc_parse_cli import _find_toc_pages


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


class TestTocParseCliMain:
    def test_dry_run_prints_toc_pages(self, tmp_path, capsys):
        book_dir = tmp_path / "md" / "数学" / "初中" / "人教版" / "九年级" / "下册"
        book_dir.mkdir(parents=True)
        (book_dir / "page_005.md").write_text("## 目录\n26.1 反比例函数 2", encoding="utf-8")
        with patch("toc_parse_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=tmp_path / "out")
            from toc_parse_cli import main
            main(["--input-dir", str(tmp_path / "md"), "--dry-run"])
        out = capsys.readouterr().out
        assert "[dry-run]" in out
        assert "toc page" in out

    def test_book_filter(self, tmp_path, capsys):
        book1 = tmp_path / "md" / "数学" / "人教版" / "九年级" / "上册" / "书A"
        book2 = tmp_path / "md" / "数学" / "人教版" / "九年级" / "下册" / "书B"
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

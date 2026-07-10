from pathlib import Path

from markdown_scanner import MarkdownScanner


class TestMarkdownScanner:
    def test_finds_exam_markdown(self, tmp_path):
        sub = tmp_path / "数学/初中/second/2024/试卷"
        sub.mkdir(parents=True)
        (sub / "试卷.md").write_text("md", encoding="utf-8")
        scanner = MarkdownScanner(tmp_path)
        sources = list(scanner.scan())
        assert len(sources) == 1
        assert sources[0].kind == "questions"

    def test_finds_textbook_markdown(self, tmp_path):
        sub = tmp_path / "数学/初中/人教版/九年级/上册/书"
        sub.mkdir(parents=True)
        (sub / "书.md").write_text("md", encoding="utf-8")
        scanner = MarkdownScanner(tmp_path)
        sources = list(scanner.scan())
        assert len(sources) == 1
        assert sources[0].kind == "cards"

    def test_ignores_hidden_files(self, tmp_path):
        sub = tmp_path / "书"
        sub.mkdir()
        (sub / ".DS_Store").write_text("x")
        scanner = MarkdownScanner(tmp_path)
        assert len(list(scanner.scan())) == 0

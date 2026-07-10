from pathlib import Path
from unittest.mock import MagicMock, patch

from extract_cli import _load_prompt, _match_source
from markdown_scanner import MarkdownSource


class TestLoadPrompt:
    def test_loads_exam_questions_prompt(self):
        text = _load_prompt("exam_questions")
        assert "试卷 Markdown" in text

    def test_loads_textbook_cards_prompt(self):
        text = _load_prompt("textbook_cards")
        assert "教材 Markdown" in text


class TestMatchSource:
    def test_all_passes(self):
        s = MarkdownSource(md_path=Path("x.md"), rel_path=Path("数学/试卷"), kind="questions")
        assert _match_source(s, "all") is True

    def test_zgkao_matches_questions(self):
        s = MarkdownSource(md_path=Path("x.md"), rel_path=Path("数学/试卷"), kind="questions")
        assert _match_source(s, "zgkao") is True

    def test_zgkao_rejects_cards(self):
        s = MarkdownSource(md_path=Path("x.md"), rel_path=Path("数学/书"), kind="cards")
        assert _match_source(s, "zgkao") is False

    def test_smartedu_matches_cards(self):
        s = MarkdownSource(md_path=Path("x.md"), rel_path=Path("数学/书"), kind="cards")
        assert _match_source(s, "smartedu") is True

    def test_smartedu_rejects_questions(self):
        s = MarkdownSource(md_path=Path("x.md"), rel_path=Path("数学/试卷"), kind="questions")
        assert _match_source(s, "smartedu") is False


class TestExtractCliMain:
    def test_dry_run_prints_sources(self, tmp_path, capsys):
        sub = tmp_path / "数学/试卷"
        sub.mkdir(parents=True)
        (sub / "试卷.md").write_text("md", encoding="utf-8")

        with patch("extract_cli.RefineryConfig") as mock_config, \
             patch("extract_cli.MarkdownScanner") as mock_scanner:
            mock_config.from_env.return_value = MagicMock(
                input_dir=tmp_path,
                output_dir=tmp_path / "out",
                llm_api_key="fake",
                llm_model="gpt-4o",
                llm_base_url=None,
                llm_timeout=120,
            )
            mock_scanner.return_value.scan.return_value = [
                MarkdownSource(md_path=sub / "试卷.md", rel_path=Path("数学/试卷"), kind="questions"),
            ]

            from extract_cli import main
            main(["--input-dir", str(tmp_path), "--dry-run"])

        captured = capsys.readouterr()
        assert "[dry-run]" in captured.out
        assert "数学/试卷" in captured.out

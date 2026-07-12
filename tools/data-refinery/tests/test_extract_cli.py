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
        assert "lesson_id" in text  # 卡片需标注所属“课”（章内小节）


class TestMatchSource:
    def test_all_passes(self):
        s = MarkdownSource(md_path=Path("数学-模拟二-试卷.md"), rel_path=Path("数学/试卷"), kind="questions")
        assert _match_source(s, "all") is True

    def test_zgkao_matches_questions(self):
        s = MarkdownSource(md_path=Path("数学-模拟二-试卷.md"), rel_path=Path("数学/试卷"), kind="questions")
        assert _match_source(s, "zgkao") is True

    def test_zgkao_matches_answer(self):
        s = MarkdownSource(md_path=Path("数学-模拟二-答案.md"), rel_path=Path("数学/答案"), kind="questions")
        assert _match_source(s, "zgkao") is True

    def test_zgkao_rejects_cards(self):
        s = MarkdownSource(md_path=Path("page_016.md"), rel_path=Path("数学/书"), kind="cards")
        assert _match_source(s, "zgkao") is False

    def test_smartedu_matches_cards(self):
        s = MarkdownSource(md_path=Path("page_016.md"), rel_path=Path("数学/书"), kind="cards")
        assert _match_source(s, "smartedu") is True

    def test_smartedu_rejects_questions(self):
        s = MarkdownSource(md_path=Path("数学-模拟二-试卷.md"), rel_path=Path("数学/试卷"), kind="questions")
        assert _match_source(s, "smartedu") is False

    def test_zgkao_uses_filename_not_directory(self):
        # 回归：试卷文件名含“试卷”，但其所在目录名不含，仍应判为 zgkao。
        # 修复前用目录名判断，扁平目录下会误判为 smartedu。
        s = MarkdownSource(md_path=Path("数学-模拟二-试卷.md"), rel_path=Path("flat/dir"), kind="questions")
        assert _match_source(s, "zgkao") is True
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


class TestExtractCliFileFilter:
    def test_file_filter_matches_only_specified(self, tmp_path, capsys):
        sub1 = tmp_path / "数学" / "2024"
        sub2 = tmp_path / "数学" / "2025"
        sub1.mkdir(parents=True)
        sub2.mkdir(parents=True)

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
                MarkdownSource(md_path=sub1 / "西城-试卷.md", rel_path=Path("数学/2024"), kind="questions"),
                MarkdownSource(md_path=sub2 / "海淀-试卷.md", rel_path=Path("数学/2025"), kind="questions"),
            ]

            from extract_cli import main
            main(["--input-dir", str(tmp_path), "--file", "2024/西城", "--dry-run"])

        out = capsys.readouterr().out
        assert "西城" in out
        assert "海淀" not in out


class TestExtractCliMultiPage:
    def test_multi_page_textbook_writes_one_jsonl_per_page(self, tmp_path):
        # 教材为扁平结构：书/page_001.md、page_002.md 共享同一目录（rel_path）。
        # 修复前：两页共享 checkpoint key（目录级），第二页被 skip，输出互相覆盖。
        # 修复后：每页有独立 checkpoint key 与输出文件。
        from extract import ExtractionResult
        from extract_cli import main
        from models import TextbookCard

        md_root = tmp_path / "md"
        book_dir = md_root / "数学" / "书"
        book_dir.mkdir(parents=True)
        (book_dir / "page_001.md").write_text("page1", encoding="utf-8")
        (book_dir / "page_002.md").write_text("page2", encoding="utf-8")

        out_dir = tmp_path / "out"
        card = TextbookCard(sort_order=1, card_type="concept", content="c")
        fake_result = ExtractionResult(items=[card], prompt_tokens=1, completion_tokens=1)

        with patch("extract_cli.RefineryConfig") as mock_config, \
             patch("extract_cli.LLMClient"), \
             patch("extract_cli.Extractor") as mock_extractor:
            mock_config.from_env.return_value = MagicMock(
                input_dir=md_root,
                output_dir=out_dir,
                llm_api_key="fake",
                llm_model="m",
                llm_base_url=None,
                llm_timeout=1,
            )
            mock_extractor.return_value.run.return_value = fake_result
            main(["--input-dir", str(md_root), "--output-dir", str(out_dir)])

        extracted_dir = out_dir / "extracted"
        f1 = extracted_dir / "数学" / "书" / "page_001.jsonl"
        f2 = extracted_dir / "数学" / "书" / "page_002.jsonl"
        assert f1.exists(), f"{f1} should exist"
        assert f2.exists(), f"{f2} should exist (second page must not be skipped)"
        assert f1.read_text(encoding="utf-8").strip() != ""
        assert f2.read_text(encoding="utf-8").strip() != ""

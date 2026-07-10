from pathlib import Path
from unittest.mock import MagicMock, patch

from convert_cli import _match_source, main
from scanner import Material


class TestMatchSource:
    def test_all_passes_everything(self):
        m = Material(kind="pdf", source_dir=Path("."), rel_path=Path("数学/初中/试卷"), input_paths=[])
        assert _match_source(m, "all") is True

    def test_zgkao_matches_exam_paper(self):
        m = Material(kind="pdf", source_dir=Path("."), rel_path=Path("数学/初中/试卷"), input_paths=[])
        assert _match_source(m, "zgkao") is True

    def test_zgkao_matches_answer(self):
        m = Material(kind="pdf", source_dir=Path("."), rel_path=Path("数学/初中/答案"), input_paths=[])
        assert _match_source(m, "zgkao") is True

    def test_zgkao_rejects_textbook(self):
        m = Material(kind="images", source_dir=Path("."), rel_path=Path("数学/初中/书"), input_paths=[])
        assert _match_source(m, "zgkao") is False

    def test_smartedu_matches_images(self):
        m = Material(kind="images", source_dir=Path("."), rel_path=Path("数学/初中/书"), input_paths=[])
        assert _match_source(m, "smartedu") is True

    def test_smartedu_rejects_exam(self):
        m = Material(kind="pdf", source_dir=Path("."), rel_path=Path("数学/初中/试卷"), input_paths=[])
        assert _match_source(m, "smartedu") is False


class TestConvertCliMain:
    def test_dry_run_prints_materials(self, tmp_path, capsys):
        (tmp_path / "试卷.pdf").write_text("pdf")

        with patch("convert_cli.RefineryConfig") as mock_config, \
             patch("convert_cli.MaterialScanner") as mock_scanner:
            mock_config.from_env.return_value = MagicMock(
                input_dir=tmp_path,
                output_dir=tmp_path / "out",
            )
            mock_scanner.return_value.scan.return_value = [
                Material(kind="pdf", source_dir=tmp_path, rel_path=Path("试卷"), input_paths=[tmp_path / "试卷.pdf"]),
            ]

            main(["--input-dir", str(tmp_path), "--dry-run"])

        captured = capsys.readouterr()
        assert "[dry-run]" in captured.out
        assert "试卷" in captured.out

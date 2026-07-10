from pathlib import Path
from unittest.mock import MagicMock

from convert import Converter, MineruRunner
from scanner import Material


class TestMineruRunner:
    def test_builds_extract_command(self, tmp_path):
        runner = MineruRunner(bin_path="mineru", timeout=60)
        input_paths = [tmp_path / "a.pdf"]
        output_dir = tmp_path / "out"

        calls = []

        def fake_run(cmd, **kwargs):
            calls.append((cmd, kwargs))

        runner._run = fake_run
        runner.run(input_paths, output_dir)

        assert calls[0][0] == ["mineru", "extract", str(tmp_path / "a.pdf"), "-o", str(output_dir), "-f", "md"]


class TestConverter:
    def test_convert_pdf_calls_mineru(self, tmp_path):
        pdf = tmp_path / "试卷.pdf"
        pdf.write_text("pdf")
        material = Material(kind="pdf", source_dir=tmp_path, rel_path=Path("数学/初中/试卷"), input_paths=[pdf])

        output_dir = tmp_path / "out"
        runner = MagicMock()
        runner.run.return_value = None

        converter = Converter(runner=runner, output_dir=output_dir)
        result = converter.convert(material)

        runner.run.assert_called_once_with([pdf], output_dir / "数学/初中/试卷")
        assert result.exists()

    def test_skip_already_converted(self, tmp_path):
        pdf = tmp_path / "试卷.pdf"
        pdf.write_text("pdf")
        material = Material(kind="pdf", source_dir=tmp_path, rel_path=Path("数学/初中/试卷"), input_paths=[pdf])

        output_dir = tmp_path / "out"
        target = output_dir / "数学/初中/试卷"
        target.mkdir(parents=True)
        (target / "试卷.md").write_text("md")

        runner = MagicMock()
        converter = Converter(runner=runner, output_dir=output_dir)
        result = converter.convert(material)

        runner.run.assert_not_called()
        assert result == target

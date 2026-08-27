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

        assert calls[0][0] == ["mineru", "extract", str(tmp_path / "a.pdf"), "-o", str(output_dir)]

    def test_run_skips_already_converted(self, tmp_path):
        # resume 逻辑在 MineruRunner.run 内（旧设计在 Converter，重构后移入）：
        # 已有对应 .md 的页不重复转换；全部完成时不再调用 _run
        runner = MineruRunner(bin_path="mineru", timeout=60)
        input_paths = [tmp_path / "a.pdf", tmp_path / "b.pdf"]
        output_dir = tmp_path / "out"
        output_dir.mkdir()
        (output_dir / "a.md").write_text("md", encoding="utf-8")

        calls = []
        runner._run = lambda cmd: calls.append(cmd)
        runner.run(input_paths, output_dir)

        assert len(calls) == 1
        assert "b.pdf" in " ".join(calls[0])
        assert "a.pdf" not in " ".join(calls[0])

    def test_run_noop_when_all_converted(self, tmp_path):
        runner = MineruRunner(bin_path="mineru", timeout=60)
        input_paths = [tmp_path / "a.pdf"]
        output_dir = tmp_path / "out"
        output_dir.mkdir()
        (output_dir / "a.md").write_text("md", encoding="utf-8")

        calls = []
        runner._run = lambda cmd: calls.append(cmd)
        runner.run(input_paths, output_dir)

        assert calls == []



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
        # resume 判定已移入 MineruRunner.run（旧断言 runner.run 不被调用是旧设计）；
        # Converter 的契约改为无条件委托，已转换页的跳过由 runner 内部处理
        #（见 TestMineruRunner::test_run_skips_already_converted）。
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

        runner.run.assert_called_once_with([pdf], target)
        assert result == target

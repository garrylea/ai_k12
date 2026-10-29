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


class TestTokenExpiry:
    """MinerU 过期 token 只回 401/A0202，本地提前给出可读原因。"""

    @staticmethod
    def _jwt(exp):
        import base64, json
        head = base64.urlsafe_b64encode(b'{"alg":"none"}').decode().rstrip("=")
        body = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
        return f"{head}.{body}.sig"

    def test_expired_token_reports_when_and_how_to_fix(self):
        from convert import token_problem_message

        msg = token_problem_message(self._jwt(1_700_000_000))
        assert msg and "过期" in msg
        assert "mineru.net/apiManage/token" in msg
        assert "MINERU_TOKEN" in msg

    def test_valid_token_passes(self):
        import time

        from convert import token_problem_message

        assert token_problem_message(self._jwt(int(time.time()) + 3600)) is None

    def test_provider_prefixed_key_tells_to_strip_prefix(self):
        from convert import token_problem_message

        msg = token_problem_message("mineru-api/sk-abcdef")
        assert msg and "provider 前缀" in msg
        assert "mineru-api/sk-xxx" in msg

    def test_sk_key_is_accepted(self):
        from convert import token_problem_message

        assert token_problem_message("sk-abcdef") is None

    def test_unknown_format_rejected(self):
        from convert import token_problem_message

        assert token_problem_message("not-a-token") and "格式不对" in token_problem_message("not-a-token")

    def test_no_token_passes_local_check(self):
        from convert import token_problem_message

        assert token_problem_message(None) is None
        assert token_problem_message("") is None


class TestRunnerLogging:
    """PDF 是「一份文档」，日志不该说成 pages 1-1/1，也不该每份睡 15s。"""

    def test_pdf_logs_document_not_pages(self, tmp_path, capsys, monkeypatch):
        import convert as convert_mod

        monkeypatch.setattr(convert_mod.time, "sleep", lambda s: None)
        runner = MineruRunner()
        monkeypatch.setattr(runner, "_run", lambda cmd: None)

        pdf = tmp_path / "a.pdf"
        pdf.write_bytes(b"x")
        runner.run([pdf], tmp_path / "out")

        out = capsys.readouterr().out
        assert "[doc] a.pdf done" in out
        assert "pages 1-1/1" not in out

    def test_images_keep_page_log(self, tmp_path, capsys, monkeypatch):
        import convert as convert_mod

        monkeypatch.setattr(convert_mod.time, "sleep", lambda s: None)
        runner = MineruRunner()
        monkeypatch.setattr(runner, "_run", lambda cmd: None)

        img = tmp_path / "page_001.jpg"
        img.write_bytes(b"x")
        runner.run([img], tmp_path / "out")

        out = capsys.readouterr().out
        assert "[batch] pages 1-1/1 done" in out

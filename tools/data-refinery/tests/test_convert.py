from pathlib import Path
from unittest.mock import MagicMock

import fitz

from convert import Converter, MineruRunner, _needs_rasterize
from scanner import Material


def _make_pdf(path, *, pages=3, text_chars=60, small=0, big=0):
    """合成一份 PDF：每页 text_chars 字 + small 张小图(bbox 70x12) + big 张大图。"""
    doc = fitz.open()
    for _ in range(pages):
        pg = doc.new_page(width=595, height=842)
        if text_chars:
            pg.insert_text((50, 60), "a" * text_chars, fontsize=9)
        for j in range(small):
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 12))
            pix.clear_with()
            x = 40 + (j % 8) * 60
            y = 200 + (j // 8) * 25
            pg.insert_image(fitz.Rect(x, y, x + 70, y + 12), pixmap=pix)
        for j in range(big):
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 200, 100))
            pix.clear_with()
            y = 400 + j * 120
            pg.insert_image(fitz.Rect(50, y, 250, y + 100), pixmap=pix)
    doc.save(path)
    doc.close()
    return path


class TestNeedsRasterize:
    """混合型 PDF（文字正常+公式是小图）的判据：命中要准、三类常见 PDF 不误伤。"""

    def test_mixed_pdf_hits(self, tmp_path):
        pdf = _make_pdf(tmp_path / "mixed.pdf", small=20)
        assert _needs_rasterize(pdf) is True

    def test_two_page_pdf_needs_only_one_hit_page(self, tmp_path):
        # 2 页卷只需 1 页命中（实测那个 2 页物理答案卷就是 1/2 页命中）
        doc = fitz.open()
        p0 = doc.new_page(width=595, height=842)
        p0.insert_text((50, 60), "a" * 60, fontsize=9)
        for j in range(20):
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 12))
            pix.clear_with()
            x = 40 + (j % 8) * 60
            y = 200 + (j // 8) * 25
            p0.insert_image(fitz.Rect(x, y, x + 70, y + 12), pixmap=pix)
        p1 = doc.new_page(width=595, height=842)  # 空白页
        doc.save(tmp_path / "two.pdf"); doc.close()
        assert _needs_rasterize(tmp_path / "two.pdf") is True

    def test_sparse_small_images_not_hit(self, tmp_path):
        # 边界卷：小图零星（13/0/0），不能误伤
        pdf = tmp_path / "sparse.pdf"
        doc = fitz.open()
        pg = doc.new_page(width=595, height=842)
        pg.insert_text((50, 60), "a" * 60, fontsize=9)
        for j in range(13):
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 12))
            pix.clear_with()
            x = 40 + (j % 8) * 60
            y = 200 + (j // 8) * 25
            pg.insert_image(fitz.Rect(x, y, x + 70, y + 12), pixmap=pix)
        for _ in range(2):
            doc.new_page(width=595, height=842)
        doc.save(pdf); doc.close()
        assert _needs_rasterize(pdf) is False

    def test_low_small_ratio_not_hit(self, tmp_path):
        # 20 小图 + 40 大图 → 占比 0.33，不命中（正常卷带一堆配图）
        pdf = _make_pdf(tmp_path / "lowratio.pdf", small=20, big=40)
        assert _needs_rasterize(pdf) is False

    def test_pure_scanned_not_hit(self, tmp_path):
        # 无文字层 + 大量图：MinerU 的 OCR 本就能处理，不栅格化
        pdf = _make_pdf(tmp_path / "scan.pdf", text_chars=0, small=20)
        assert _needs_rasterize(pdf) is False

    def test_text_only_not_hit(self, tmp_path):
        pdf = _make_pdf(tmp_path / "text.pdf", text_chars=200, small=0)
        assert _needs_rasterize(pdf) is False

    def test_corrupt_pdf_returns_false(self, tmp_path):
        bad = tmp_path / "bad.pdf"
        bad.write_bytes(b"not a pdf at all")
        assert _needs_rasterize(bad) is False


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

        assert calls[0][0] == [
            "mineru", "extract", str(tmp_path / "a.pdf"), "-o", str(output_dir),
            "-f", "md,json",
        ]

    def test_builds_extract_command_for_docx(self, tmp_path):
        """Word 文件名原样进 MinerU extract，不做扩展名过滤。"""
        runner = MineruRunner(bin_path="mineru", timeout=60)
        docx = tmp_path / "试卷.docx"
        output_dir = tmp_path / "out"

        calls = []
        runner._run = lambda cmd: calls.append(cmd)
        runner.run([docx], output_dir)

        assert calls[0] == [
            "mineru", "extract", str(docx), "-o", str(output_dir), "-f", "md,json",
        ]

    def test_is_document_accepts_office_suffixes(self):
        for suffix in (".pdf", ".doc", ".docx", ".ppt", ".pptx", ".DOCX"):
            assert MineruRunner._is_document([Path(f"a{suffix}")]) is True
        assert MineruRunner._is_document([Path("page_001.jpg")]) is False

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

    def test_convert_rasterizes_mixed_pdf_and_cleans_temp(self, tmp_path, capsys):
        # 命中混合型 PDF：runner 应收到栅格化后的 PDF（与原文件同名不同路径），
        # 且临时目录在返回后被清理。
        pdf = _make_pdf(tmp_path / "试卷.pdf", small=20)
        material = Material(kind="pdf", source_dir=tmp_path, rel_path=Path("数学/初中/试卷"), input_paths=[pdf])

        seen = {}
        runner = MagicMock()
        runner.run.side_effect = lambda paths, target: seen.setdefault("paths", list(paths))

        converter = Converter(runner=runner, output_dir=tmp_path / "out")
        converter.convert(material)

        passed = seen["paths"][0]
        assert passed != pdf                       # 用的不是原文件
        assert passed.name == pdf.name             # 但同名（保住 stem resume）
        assert passed.suffix == ".pdf"
        assert not passed.exists()                 # 临时目录已被清理
        assert "[rasterize]" in capsys.readouterr().out
        # 源文件未被改动
        assert pdf.exists()

    def test_convert_falls_back_on_rasterize_failure(self, tmp_path, capsys, monkeypatch):
        # 栅格化抛异常时用原 PDF 继续，不让整份转换挂掉。
        import convert as convert_mod
        pdf = _make_pdf(tmp_path / "试卷.pdf", small=20)
        material = Material(kind="pdf", source_dir=tmp_path, rel_path=Path("数学/初中/试卷"), input_paths=[pdf])

        monkeypatch.setattr(convert_mod, "_rasterize", lambda s, d: (_ for _ in ()).throw(RuntimeError("boom")))
        runner = MagicMock()
        converter = Converter(runner=runner, output_dir=tmp_path / "out")
        converter.convert(material)

        runner.run.assert_called_once_with([pdf], tmp_path / "out" / "数学/初中/试卷")
        assert "[WARN]" in capsys.readouterr().out


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

    def test_docx_logs_document_not_pages(self, tmp_path, capsys, monkeypatch):
        import convert as convert_mod

        monkeypatch.setattr(convert_mod.time, "sleep", lambda s: None)
        runner = MineruRunner()
        monkeypatch.setattr(runner, "_run", lambda cmd: None)

        docx = tmp_path / "a.docx"
        docx.write_bytes(b"x")
        runner.run([docx], tmp_path / "out")

        out = capsys.readouterr().out
        assert "[doc] a.docx done" in out
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

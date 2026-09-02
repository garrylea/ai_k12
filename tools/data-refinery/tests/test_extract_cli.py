from pathlib import Path
from unittest.mock import MagicMock, patch

from extract_cli import _load_prompt, _match_source
from markdown_scanner import MarkdownSource


class _FakeLabeler:
    """按调用顺序返回预设结果（PageLabelResult）或抛预设异常。"""

    def __init__(self, outcomes):
        self._outcomes = outcomes
        self.calls = 0
        self.model_name = "fake-model"
        self.last_raw_content = None

    def label(self, cards_text, page_number, prev_lesson_id=None, toc_labels=None):
        out = self._outcomes[min(self.calls, len(self._outcomes) - 1)]
        self.calls += 1
        if isinstance(out, Exception):
            raise out
        return out


def _page(invalid=None):
    from card_labeler import LabelResult, PageLabelResult
    return PageLabelResult(
        page_type="content",
        labels=[LabelResult(page_type="content", card_type="concept",
                            lesson_id=None, title=None, textbook_page="P1")],
        invalid_card_types=invalid or [])


class TestLabelEscalation:
    """_label_with_escalation：主模型 → 主模型重试 → 兜底模型，失败详情落盘。"""

    def _run(self, tmp_path, primary_outcomes, fallback_outcomes="__unset__"):
        from extract_cli import _label_with_escalation
        primary = _FakeLabeler(primary_outcomes)
        fallback = (None if fallback_outcomes == "__unset__"
                    else _FakeLabeler(fallback_outcomes))
        log = tmp_path / "labeling_errors.jsonl"
        result, status = _label_with_escalation(
            primary, fallback, ["卡1"], page_number="P1",
            prev_lesson_id=None, toc_labels=None,
            file_key="数学/书/page_001.md", err_log_path=log)
        return primary, fallback, result, status, log

    @staticmethod
    def _records(log):
        import json
        return [json.loads(l) for l in log.read_text(encoding="utf-8").splitlines()]

    def test_primary_ok_no_retry_no_log(self, tmp_path):
        primary, _, result, status, log = self._run(tmp_path, [_page()])
        assert status == "ok"
        assert primary.calls == 1
        assert not log.exists()  # 无失败不落盘

    def test_primary_retry_ok(self, tmp_path):
        primary, _, result, status, log = self._run(
            tmp_path, [_page(invalid=[(0, "content")]), _page()])
        assert status == "retry_ok"
        assert primary.calls == 2
        recs = self._records(log)
        assert len(recs) == 1
        assert recs[0]["attempt"] == "primary"
        assert recs[0]["invalid_card_types"] == [{"index": 0, "value": "content"}]
        assert recs[0]["model"] == "fake-model"

    def test_fallback_ok(self, tmp_path):
        primary, fallback, result, status, log = self._run(
            tmp_path,
            [_page(invalid=[(0, "content")]), _page(invalid=[(1, "bad")])],
            [_page()])
        assert status == "fallback_ok"
        assert primary.calls == 2
        assert fallback.calls == 1
        assert [r["attempt"] for r in self._records(log)] == ["primary", "primary-retry"]

    def test_exhausted_with_fallback(self, tmp_path):
        primary, fallback, result, status, log = self._run(
            tmp_path,
            [_page(invalid=[(0, "content")]), _page(invalid=[(0, "content")])],
            [_page(invalid=[(0, "content")])])
        assert status == "exhausted"
        assert result is not None
        assert result.labels[0].card_type == "concept"  # 归一化结果可沿用
        assert [r["attempt"] for r in self._records(log)] == \
            ["primary", "primary-retry", "fallback"]

    def test_exhausted_without_fallback(self, tmp_path):
        primary, fallback, result, status, log = self._run(
            tmp_path,
            [_page(invalid=[(0, "content")]), _page(invalid=[(0, "content")])])
        assert fallback is None
        assert status == "exhausted"
        assert primary.calls == 2  # 无兜底模型：只到主模型重试
        assert [r["attempt"] for r in self._records(log)] == ["primary", "primary-retry"]

    def test_all_exceptions_return_error(self, tmp_path):
        primary, fallback, result, status, log = self._run(
            tmp_path, [RuntimeError("boom")], [RuntimeError("boom2")])
        assert status == "error"
        assert result is None  # 调用方据此走默认标注兜底
        recs = self._records(log)
        # 主模型异常也会先重试一次，再升级到兜底模型
        assert [r["attempt"] for r in recs] == ["primary", "primary-retry", "fallback"]
        assert recs[0]["error"] == "boom"
        assert recs[2]["error"] == "boom2"
        assert recs[0]["invalid_card_types"] == []

    def test_exception_then_retry_ok(self, tmp_path):
        """首次网络异常、重试成功：也走分级（异常不直接短路到默认标注）。"""
        primary, _, result, status, log = self._run(
            tmp_path, [RuntimeError("net down"), _page()])
        assert status == "retry_ok"
        assert primary.calls == 2
        recs = self._records(log)
        assert recs[0]["error"] == "net down"


class TestAskContinueOnExhausted:
    """分级重试穷尽后的处置：交互暂停（continue/stop）/ 非交互计失败（fail）。"""

    def _ask(self, tmp_path, input_fn, monkeypatch, tty=True):
        from extract_cli import _ask_continue_on_exhausted
        fake_stdin = type("S", (), {"isatty": lambda self: tty})()
        monkeypatch.setattr("sys.stdin", fake_stdin)
        return _ask_continue_on_exhausted(
            "数学/书/page_001.md", [(0, "content")],
            tmp_path / "labeling_errors.jsonl", input_fn=input_fn)

    def test_continue_on_enter_or_c(self, tmp_path, monkeypatch, capsys):
        assert self._ask(tmp_path, lambda p: "", monkeypatch) == "continue"
        assert self._ask(tmp_path, lambda p: "c", monkeypatch) == "continue"
        out = capsys.readouterr().out
        assert "card_type 超出允许范围" in out
        assert "卡#1='content'" in out

    def test_stop_on_s(self, tmp_path, monkeypatch):
        assert self._ask(tmp_path, lambda p: "s", monkeypatch) == "stop"

    def test_invalid_input_reasked(self, tmp_path, monkeypatch):
        answers = iter(["x", "s"])
        assert self._ask(tmp_path, lambda p: next(answers), monkeypatch) == "stop"

    def test_non_tty_fails_page(self, tmp_path, monkeypatch):
        assert self._ask(tmp_path, lambda p: "c", monkeypatch, tty=False) == "fail"


class TestLoadPrompt:
    def test_loads_exam_questions_prompt(self):
        text = _load_prompt("exam_questions")
        assert "试卷 Markdown" in text

    def test_loads_textbook_cards_prompt(self):
        text = _load_prompt("textbook_cards")
        assert "K12 教育内容结构化专家" in text
        assert "lesson_id" in text  # 卡片需标注所属"课"（章内小节）

    def test_loads_toc_parse_prompt(self):
        text = _load_prompt("toc_parse")
        assert "目录解析" in text
        assert "chapter" in text
        assert "printed_page" in text


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


class TestNormalizeFullwidthParens:
    """normalize_fullwidth_parens：全角括号统一为半角，其余全角标点不动。

    背景：OCR 原文同一页混用 （1）/(1)，题号括号展示不一致。
    只做 1:1 字符替换，长度不变 → image_scan 的 position_in_text 仍有效。
    """

    def test_question_number_fullwidth_to_halfwidth(self):
        from extract_cli import normalize_fullwidth_parens
        assert normalize_fullwidth_parens("（1）一个圆的面积是 $2\\pi$ ，求半径 $r$") == \
            "(1)一个圆的面积是 $2\\pi$ ，求半径 $r$"

    def test_mixed_parens_same_page(self):
        from extract_cli import normalize_fullwidth_parens
        assert normalize_fullwidth_parens("（（1））") == "((1))"

    def test_other_fullwidth_punct_untouched(self):
        # 。，；必须保留：。无 NFKC 映射会影响 content_hash；
        # 。！？；是 card_splitter 的句末切分点，归一会破坏长段落切分
        from extract_cli import normalize_fullwidth_parens
        assert normalize_fullwidth_parens("直田积（矩形面积）八百六十四步，问阔。") == \
            "直田积(矩形面积)八百六十四步，问阔。"

    def test_length_preserved(self):
        # 1:1 替换不改长度（图片 position_in_text 依赖偏移量）
        from extract_cli import normalize_fullwidth_parens
        s = "（1）（2）（3）x（y）"
        assert len(normalize_fullwidth_parens(s)) == len(s)

    def test_no_parens_unchanged(self):
        from extract_cli import normalize_fullwidth_parens
        s = "25.1 一元二次方程的概念：$x^{2} + x - 12 = 0$"
        assert normalize_fullwidth_parens(s) == s


class TestLevenshtein:
    def test_identical(self):
        from extract_cli import _levenshtein
        assert _levenshtein("26.1 反比例函数", "26.1 反比例函数") == 0

    def test_one_typo(self):
        from extract_cli import _levenshtein
        assert _levenshtein("26.1 反比利函数", "26.1 反比例函数") == 1

    def test_missing_space(self):
        from extract_cli import _levenshtein
        assert _levenshtein("26.1反比例函数", "26.1 反比例函数") == 1

    def test_empty(self):
        from extract_cli import _levenshtein
        assert _levenshtein("", "abc") == 3
        assert _levenshtein("abc", "") == 3


class TestFlattenTocLabels:
    def test_extracts_all_labels(self):
        from extract_cli import _flatten_toc_labels
        toc = {
            "book": "test",
            "chapters": [{
                "number": 26, "title": "反比例函数", "label": "第二十六章 反比例函数",
                "sections": [{
                    "number": [26, 1], "title": "反比例函数", "label": "26.1 反比例函数",
                    "subsections": [{
                        "number": [26, 1, 1], "title": "反比例函数",
                        "label": "26.1.1 反比例函数"
                    }]
                }],
                "supplements": [{"type": "supplement", "label": "小结"}]
            }]
        }
        labels = _flatten_toc_labels(toc)
        assert "第二十六章 反比例函数" in labels
        assert "26.1 反比例函数" in labels
        assert "26.1.1 反比例函数" in labels
        assert "小结" in labels
        assert len(labels) == 4


class TestValidateAndCorrect:
    def test_exact_match(self):
        from extract_cli import validate_and_correct
        from pathlib import Path
        toc = {
            "book": "test",
            "chapters": [{
                "number": 26, "title": "反比例函数", "label": "第二十六章 反比例函数",
                "sections": [{
                    "number": [26, 1], "title": "反比例函数", "label": "26.1 反比例函数",
                    "subsections": [],
                }],
                "supplements": [],
            }],
        }
        cards = {"a.jsonl": [{"lesson_id": "26.1 反比例函数"}]}
        report = validate_and_correct(cards, toc, Path("/tmp"))
        assert report["matched"] == 1
        assert len(report["corrected"]) == 0
        assert "missing" in report["summary"]

    def test_auto_correct_typo(self):
        from extract_cli import validate_and_correct
        from pathlib import Path
        toc = {
            "book": "test",
            "chapters": [{
                "number": 26, "title": "反比例函数", "label": "第二十六章 反比例函数",
                "sections": [{
                    "number": [26, 1], "title": "反比例函数", "label": "26.1 反比例函数",
                    "subsections": [],
                }],
                "supplements": [],
            }],
        }
        cards = {"a.jsonl": [{"lesson_id": "26.1 反比利函数"}]}
        report = validate_and_correct(cards, toc, Path("/tmp"))
        assert report["matched"] == 0
        assert len(report["corrected"]) == 1
        assert report["corrected"][0]["original"] == "26.1 反比利函数"
        assert report["corrected"][0]["corrected"] == "26.1 反比例函数"

    def test_unmatched_far_apart(self):
        from extract_cli import validate_and_correct
        from pathlib import Path
        toc = {
            "book": "test",
            "chapters": [{
                "number": 26, "title": "反比例函数", "label": "第二十六章 反比例函数",
                "sections": [],
                "supplements": [],
            }],
        }
        cards = {"a.jsonl": [{"lesson_id": "完全不同的标题"}]}
        report = validate_and_correct(cards, toc, Path("/tmp"))
        assert report["matched"] == 0
        assert len(report["corrected"]) == 0
        assert len(report["unmatched"]) == 1


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
                llm_max_retries=0,
                llm_thinking=False,
                llm_enable_cache=False,
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
                llm_max_retries=0,
                llm_thinking=False,
                llm_enable_cache=False,
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
        # 注：md 内容须 >30 字符，否则被 is_front_matter 预过滤拦截（走不到 LLM 标注）。
        from card_labeler import LabelResult, PageLabelResult
        from extract_cli import main

        md_root = tmp_path / "md"
        book_dir = md_root / "数学" / "书"
        book_dir.mkdir(parents=True)
        body = "这是一段足够长的测试内容，超过三十个字符以避免被前置内容预过滤器拦截，用于验证多页输出。"
        (book_dir / "page_001.md").write_text(body, encoding="utf-8")
        (book_dir / "page_002.md").write_text(body, encoding="utf-8")

        out_dir = tmp_path / "out"
        page_result = PageLabelResult(
            page_type="content",
            labels=[LabelResult(page_type="content", card_type="concept",
                                lesson_id=None, title=None, textbook_page="P1")],
        )

        with patch("extract_cli.RefineryConfig") as mock_config, \
             patch("extract_cli.create_llm_client"), \
             patch("extract_cli.CardLabeler") as mock_labeler_cls:
            mock_config.from_env.return_value = MagicMock(
                input_dir=md_root,
                output_dir=out_dir,
                llm_api_key="fake",
                llm_model="m",
                llm_base_url=None,
                llm_timeout=1,
            )
            mock_labeler_cls.return_value.label.side_effect = [page_result, page_result]
            main(["--input-dir", str(md_root), "--output-dir", str(out_dir)])

        extracted_dir = out_dir / "extracted"
        f1 = extracted_dir / "数学" / "书" / "page_001.jsonl"
        f2 = extracted_dir / "数学" / "书" / "page_002.jsonl"
        assert f1.exists(), f"{f1} should exist"
        assert f2.exists(), f"{f2} should exist (second page must not be skipped)"
        assert f1.read_text(encoding="utf-8").strip() != ""
        assert f2.read_text(encoding="utf-8").strip() != ""


class TestTocDir:
    """--toc-dir：TOC 缓存加载（排除 sidecar）、labeler 注入、逐书后置校验。"""

    BODY = "这是一段足够长的测试内容，超过三十个字符以避免被前置内容预过滤器拦截，用于验证目录注入逻辑。"

    @staticmethod
    def _toc():
        return {
            "book": "test",
            "chapters": [{
                "number": 26, "title": "反比例函数", "label": "第二十六章 反比例函数",
                "sections": [{
                    "number": [26, 1], "title": "反比例函数", "label": "26.1 反比例函数",
                    "subsections": [],
                }],
                "supplements": [],
            }],
        }

    @staticmethod
    def _write_toc(toc_dir, book_key="数学/书", toc=None):
        import json
        p = toc_dir / f"{book_key}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(toc or TestTocDir._toc(), ensure_ascii=False), encoding="utf-8")

    def test_load_toc_cache_excludes_sidecars(self, tmp_path):
        from extract_cli import _load_toc_cache
        toc_dir = tmp_path / "toc"
        self._write_toc(toc_dir)
        # toc_merge 的 sidecar 不应进入缓存
        (toc_dir / "数学" / "书.merged.json").write_text("{}", encoding="utf-8")
        (toc_dir / "数学" / "书.merge_report.json").write_text("{}", encoding="utf-8")
        cache = _load_toc_cache(toc_dir)
        assert "数学/书" in cache
        assert len(cache) == 1

    def test_load_toc_cache_missing_dir(self, tmp_path):
        from extract_cli import _load_toc_cache
        assert _load_toc_cache(tmp_path / "nope") == {}

    def _run_with_toc_dir(self, md_root, out_dir, toc_dir, page_results):
        with patch("extract_cli.RefineryConfig") as mock_config, \
             patch("extract_cli.create_llm_client"), \
             patch("extract_cli.CardLabeler") as mock_labeler_cls:
            mock_config.from_env.return_value = MagicMock(
                input_dir=md_root, output_dir=out_dir,
                llm_api_key="fake", llm_model="m", llm_base_url=None, llm_timeout=1,
            )
            mock_labeler_cls.return_value.label.side_effect = page_results
            from extract_cli import main
            main(["--input-dir", str(md_root), "--output-dir", str(out_dir),
                  "--toc-dir", str(toc_dir)])

    def test_labeler_receives_toc_labels(self, tmp_path):
        from card_labeler import LabelResult, PageLabelResult
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        (book / "page_001.md").write_text(self.BODY, encoding="utf-8")
        out_dir = tmp_path / "out"
        toc_dir = out_dir / "toc"
        self._write_toc(toc_dir)

        page_result = PageLabelResult(page_type="content", labels=[LabelResult(
            page_type="content", card_type="concept",
            lesson_id="26.1 反比例函数", title=None, textbook_page="P1")])
        with patch("extract_cli.RefineryConfig") as mock_config, \
             patch("extract_cli.create_llm_client"), \
             patch("extract_cli.CardLabeler") as mock_labeler_cls:
            mock_config.from_env.return_value = MagicMock(
                input_dir=md_root, output_dir=out_dir,
                llm_api_key="fake", llm_model="m", llm_base_url=None, llm_timeout=1,
            )
            mock_labeler_cls.return_value.label.return_value = page_result
            from extract_cli import main
            main(["--input-dir", str(md_root), "--output-dir", str(out_dir),
                  "--toc-dir", str(toc_dir)])
        kwargs = mock_labeler_cls.return_value.label.call_args.kwargs
        assert kwargs.get("toc_labels") == ["第二十六章 反比例函数", "26.1 反比例函数"]

    def test_correction_and_publish_checkpoint_clear(self, tmp_path, capsys):
        import json
        from card_labeler import LabelResult, PageLabelResult
        from checkpoint import RefineryCheckpoint
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        (book / "page_001.md").write_text(self.BODY, encoding="utf-8")
        out_dir = tmp_path / "out"
        toc_dir = out_dir / "toc"
        self._write_toc(toc_dir)

        # 模拟上轮已 publish：本轮修正改写 jsonl 后应清除该标记
        ckpt = RefineryCheckpoint(out_dir / ".checkpoint.json")
        ckpt.load()
        ckpt.mark_published("数学/书/page_001.md")

        page_result = PageLabelResult(page_type="content", labels=[LabelResult(
            page_type="content", card_type="concept",
            lesson_id="26.1 反比利函数",  # typo，应被模糊修正
            title=None, textbook_page="P1")])
        self._run_with_toc_dir(md_root, out_dir, toc_dir, [page_result])

        jsonl = out_dir / "extracted" / "数学" / "书" / "page_001.jsonl"
        items = [json.loads(l) for l in jsonl.read_text(encoding="utf-8").splitlines() if l.strip()]
        assert items[0]["lesson_id"] == "26.1 反比例函数"

        ckpt2 = RefineryCheckpoint(out_dir / ".checkpoint.json")
        ckpt2.load()
        assert not ckpt2.is_published("数学/书/page_001.md")
        out = capsys.readouterr().out
        assert "[toc-dir]" in out
        # 不写 diff_report（由 toc_merge 的 merge_report 取代）
        assert not (out_dir / "extracted" / "diff_report.json").exists()

    def test_book_without_toc_untouched(self, tmp_path):
        import json
        from card_labeler import LabelResult, PageLabelResult
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        (book / "page_001.md").write_text(self.BODY, encoding="utf-8")
        out_dir = tmp_path / "out"
        toc_dir = out_dir / "toc"
        toc_dir.mkdir(parents=True)  # 空：没有该书的 toc

        page_result = PageLabelResult(page_type="content", labels=[LabelResult(
            page_type="content", card_type="concept",
            lesson_id="自由发挥的标签", title=None, textbook_page="P1")])
        self._run_with_toc_dir(md_root, out_dir, toc_dir, [page_result])

        jsonl = out_dir / "extracted" / "数学" / "书" / "page_001.jsonl"
        items = [json.loads(l) for l in jsonl.read_text(encoding="utf-8").splitlines() if l.strip()]
        # 无 TOC 的书不做校验/修正
        assert items[0]["lesson_id"] == "自由发挥的标签"


class TestChromeStripping:
    """主流程页眉剥离（2026-09-01）：OCR 运行页眉/水印页脚既不误杀正文页，
    也不混进卡片内容。chrome 按书目录频率统计（>=3 页）自动发现。"""

    BODY = "这是一段足够长的测试内容，超过三十个字符以避免被前置内容预过滤器拦截，用于验证剥离逻辑。"
    FOOTER = "仅供个人学习使用，未经授权不得另做他用"

    def _run(self, md_root, out_dir, page_results):
        with patch("extract_cli.RefineryConfig") as mock_config, \
             patch("extract_cli.create_llm_client"), \
             patch("extract_cli.CardLabeler") as mock_labeler_cls:
            mock_config.from_env.return_value = MagicMock(
                input_dir=md_root, output_dir=out_dir,
                llm_api_key="fake", llm_model="m", llm_base_url=None, llm_timeout=1,
            )
            mock_labeler_cls.return_value.label.side_effect = page_results
            from extract_cli import main
            main(["--input-dir", str(md_root), "--output-dir", str(out_dir)])

    def _read_jsonl(self, out_dir, rel):
        import json
        p = out_dir / "extracted" / rel
        return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]

    def _label(self):
        from card_labeler import LabelResult
        return LabelResult(page_type="content", card_type="concept",
                           lesson_id="26.1 反比例函数", title=None, textbook_page="P1")

    def test_header_page_extracted_without_header(self, tmp_path):
        # 回归（page_028）：3 页同页眉「人民教育出版社」→ 剥离后正常抽取，
        # 页眉不进卡片内容（此前被 is_front_matter「出版社」子串误杀）
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        for i in (1, 2, 3):
            (book / f"page_{i:03d}.md").write_text(
                f"# 人民教育出版社\n\n{self.BODY}", encoding="utf-8")
        out_dir = tmp_path / "out"
        from card_labeler import PageLabelResult
        page_result = PageLabelResult(page_type="content", labels=[self._label()])
        self._run(md_root, out_dir, [page_result, page_result, page_result])
        items = self._read_jsonl(out_dir, "数学/书/page_001.jsonl")
        assert len(items) == 1  # 3 页都应抽取，无 front matter 误杀
        assert "人民教育出版社" not in items[0]["content"]
        assert self.BODY[:10] in items[0]["content"]
        assert (out_dir / "extracted" / "数学" / "书" / "page_003.jsonl").exists()

    def test_watermark_footer_page_extracted(self, tmp_path):
        # 回归（page_123 等）：页尾水印「仅供个人学习…」→ 剥离后正常抽取
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        for i in (1, 2, 3):
            (book / f"page_{i:03d}.md").write_text(
                f"{self.BODY}\n\n{self.FOOTER}", encoding="utf-8")
        out_dir = tmp_path / "out"
        from card_labeler import PageLabelResult
        page_result = PageLabelResult(page_type="content", labels=[self._label()])
        self._run(md_root, out_dir, [page_result, page_result, page_result])
        items = self._read_jsonl(out_dir, "数学/书/page_001.jsonl")
        assert len(items) == 1
        assert "仅供个人学习" not in items[0]["content"]

    def test_chrome_computed_from_full_book_dir(self, tmp_path, capsys):
        # --pages 只选 1 页时，chrome 仍按书目录全部页统计（频率不失真）：
        # 书共 3 页同页眉，仅抽 page_002 也应剥掉页眉
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        for i in (1, 2, 3):
            (book / f"page_{i:03d}.md").write_text(
                f"## 人民教育出版社\n\n{self.BODY}", encoding="utf-8")
        out_dir = tmp_path / "out"
        from card_labeler import PageLabelResult
        with patch("extract_cli.RefineryConfig") as mock_config, \
             patch("extract_cli.create_llm_client"), \
             patch("extract_cli.CardLabeler") as mock_labeler_cls:
            mock_config.from_env.return_value = MagicMock(
                input_dir=md_root, output_dir=out_dir,
                llm_api_key="fake", llm_model="m", llm_base_url=None, llm_timeout=1,
            )
            mock_labeler_cls.return_value.label.return_value = PageLabelResult(
                page_type="content", labels=[self._label()])
            from extract_cli import main
            main(["--input-dir", str(md_root), "--output-dir", str(out_dir),
                  "--pages", "2", "--force"])
        items = self._read_jsonl(out_dir, "数学/书/page_002.jsonl")
        assert len(items) == 1
        assert "人民教育出版社" not in items[0]["content"]


class TestExtractCliLessonId:
    """lesson_id 跨页继承 + 前置内容跳过（LLM 给标识，CLI 维护 per-book 状态）。

    新架构：image_scan -> card_splitter -> CardLabeler（LLM 标注）。
    测试 mock CardLabeler.label 返回 PageLabelResult；scan/split 真跑（内容 >30 字符
    避免被 is_front_matter 预过滤，多卡片页用 ## 标题让 splitter 拆出多张卡）。
    """

    # 一段 >30 字符的正文（避免前置内容预过滤）
    BODY = "这是一段足够长的测试内容，超过三十个字符以避免被前置内容预过滤器拦截，用于验证继承逻辑。"

    def _run(self, md_root, out_dir, page_results):
        """page_results: 按页顺序的 PageLabelResult 列表，对应 scanner 排序后的 card 页。"""
        with patch("extract_cli.RefineryConfig") as mock_config, \
             patch("extract_cli.create_llm_client"), \
             patch("extract_cli.CardLabeler") as mock_labeler_cls:
            mock_config.from_env.return_value = MagicMock(
                input_dir=md_root,
                output_dir=out_dir,
                llm_api_key="fake",
                llm_model="m",
                llm_base_url=None,
                llm_timeout=1,
            )
            mock_labeler_cls.return_value.label.side_effect = page_results
            from extract_cli import main
            main(["--input-dir", str(md_root), "--output-dir", str(out_dir)])

    @staticmethod
    def _label(lesson_id, card_type="concept"):
        from card_labeler import LabelResult
        return LabelResult(page_type="content", card_type=card_type,
                           lesson_id=lesson_id, title=None, textbook_page="P1")

    @staticmethod
    def _page(labels):
        from card_labeler import PageLabelResult
        return PageLabelResult(page_type="content", labels=labels)

    def _read_jsonl(self, out_dir, rel):
        import json
        p = out_dir / "extracted" / rel
        return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]

    def test_cross_page_inheritance(self, tmp_path):
        # page_001 给 lesson_id="26.1..."；page_002 续页给 null，应继承 page_001 的值
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        (book / "page_001.md").write_text(self.BODY, encoding="utf-8")
        (book / "page_002.md").write_text(self.BODY, encoding="utf-8")
        out_dir = tmp_path / "out"
        page_results = [
            self._page([self._label("26.1 反比例函数")]),
            self._page([self._label(None)]),
        ]
        self._run(md_root, out_dir, page_results)
        items2 = self._read_jsonl(out_dir, "数学/书/page_002.jsonl")
        assert items2[0]["lesson_id"] == "26.1 反比例函数"

    def test_one_page_multiple_sections(self, tmp_path):
        # 同一页跨两节：[26.1, null, 26.2] -> null 继承前一个 26.1
        # 三个 ## 标题段让 splitter 拆出三张卡，labels 与卡片一一对应
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        (book / "page_001.md").write_text(
            f"## 26.1 反比例函数\n\n{self.BODY}\n\n## 26.1 续\n\n{self.BODY}\n\n## 26.2 实际问题\n\n{self.BODY}",
            encoding="utf-8")
        out_dir = tmp_path / "out"
        page_results = [self._page([
            self._label("26.1 反比例函数"),
            self._label(None),
            self._label("26.2 实际问题与反比例函数"),
        ])]
        self._run(md_root, out_dir, page_results)
        items = self._read_jsonl(out_dir, "数学/书/page_001.jsonl")
        assert len(items) == 3, "三个标题段应拆出三张卡"
        assert [it["lesson_id"] for it in items] == [
            "26.1 反比例函数", "26.1 反比例函数", "26.2 实际问题与反比例函数",
        ]

    def test_front_matter_skipped(self, tmp_path, capsys):
        # 整页是前置内容（封面/目录等）-> 预过滤直接跳过 -> 不写 jsonl、记 checkpoint、日志提示
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        (book / "page_001.md").write_text("cover", encoding="utf-8")
        out_dir = tmp_path / "out"
        # 预过滤在 LLM 之前，CardLabeler.label 不应被调用（仍需 patch 防真实 LLM 连接）
        self._run(md_root, out_dir, page_results=[None])
        assert not (out_dir / "extracted" / "数学" / "书" / "page_001.jsonl").exists()
        assert "front matter" in capsys.readouterr().out.lower()
        from checkpoint import RefineryCheckpoint
        ckpt = RefineryCheckpoint(out_dir / ".checkpoint.json")
        ckpt.load()
        assert ckpt.is_extracted("数学/书/page_001.md")

    def test_resume_rebuilds_state_from_existing_jsonl(self, tmp_path):
        # page_001 已抽（checkpoint + jsonl 末条 lesson_id="26.1..."）；page_002 续页 null 应继承。
        # 回归：skip 分支曾丢失「从已抽页 jsonl 回填 per-book 状态」导致续页继承断档（重构丢失，2026-08-26 恢复）。
        from checkpoint import RefineryCheckpoint
        import json
        md_root = tmp_path / "md"
        book = md_root / "数学" / "书"
        book.mkdir(parents=True)
        (book / "page_001.md").write_text(self.BODY, encoding="utf-8")
        (book / "page_002.md").write_text(self.BODY, encoding="utf-8")
        out_dir = tmp_path / "out"
        ckpt = RefineryCheckpoint(out_dir / ".checkpoint.json")
        ckpt.load()
        ckpt.mark_extracted("数学/书/page_001.md")
        f1 = out_dir / "extracted" / "数学" / "书" / "page_001.jsonl"
        f1.parent.mkdir(parents=True, exist_ok=True)
        f1.write_text(
            json.dumps({"sort_order": 1, "card_type": "concept", "content": "c",
                        "lesson_id": "26.1 反比例函数"}, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        # 仅 page_002 会被 label（page_001 走 skip 分支）
        page_results = [self._page([self._label(None)])]
        self._run(md_root, out_dir, page_results)
        items2 = self._read_jsonl(out_dir, "数学/书/page_002.jsonl")
        assert items2[0]["lesson_id"] == "26.1 反比例函数"

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

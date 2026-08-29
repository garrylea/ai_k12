"""db_loader_cli 测试：dry-run 扫描 + kind 检测。"""
from pathlib import Path
from unittest.mock import patch


class TestDbLoaderCliDryRun:
    def test_dry_run_lists_files_with_kind(self, tmp_path, capsys):
        published = tmp_path / "published"
        book = published / "数学" / "初中" / "人教版" / "九年级" / "下册" / "书名"
        book.mkdir(parents=True)
        (book / "page_001.jsonl").write_text('{"lesson_id":"26.1 反比例函数","sort_order":1,"card_type":"concept","content":"c"}', encoding="utf-8")
        exam = published / "数学" / "初中" / "second" / "2024" / "数学-试卷"
        exam.mkdir(parents=True)
        (exam / "数学-试卷.jsonl").write_text('{"subject_id":"math","type":"choice","difficulty":1,"content":"q","answer":"A"}', encoding="utf-8")

        with patch("db_loader_cli.RefineryConfig") as mock_cfg:
            mock_cfg.from_env.return_value = tmp_path / "ignored"  # dry-run 不连库
            from db_loader_cli import main
            main(["--input-dir", str(published), "--dry-run"])

        out = capsys.readouterr().out
        assert "page_001.jsonl (cards)" in out
        assert "数学-试卷.jsonl (questions)" in out
        assert "共 2 个文件" in out

    def test_dry_run_source_filter(self, tmp_path, capsys):
        published = tmp_path / "published"
        book = published / "数学" / "初中" / "人教版" / "九年级" / "下册" / "书名"
        book.mkdir(parents=True)
        (book / "page_001.jsonl").write_text("{}", encoding="utf-8")
        exam = published / "数学" / "初中" / "second" / "2024" / "数学-试卷"
        exam.mkdir(parents=True)
        (exam / "数学-试卷.jsonl").write_text("{}", encoding="utf-8")

        with patch("db_loader_cli.RefineryConfig"):
            from db_loader_cli import main
            main(["--input-dir", str(published), "--source", "smartedu", "--dry-run"])

        out = capsys.readouterr().out
        assert "page_001.jsonl" in out
        assert "数学-试卷" not in out


def _mock_loader():
    """构造 mock DbLoader：业务数据预检返回空（无阻挡）。"""
    from unittest.mock import MagicMock
    m = MagicMock()
    m.business_data_summary.return_value = {}
    m.purge_business_data.return_value = {}
    m.load_book_cards.return_value = 1
    m.load_questions.return_value = 1
    return m


class TestFullReloadGuard:
    """full-reload 守卫：业务数据 FK 会挡住 DELETE，需显式 --purge-business-data。"""

    def _published(self, tmp_path):
        published = tmp_path / "published"
        exam = published / "数学" / "初中" / "second" / "2024" / "数学-试卷"
        exam.mkdir(parents=True)
        (exam / "数学-试卷.jsonl").write_text(
            '{"subject_id":"math","type":"choice","difficulty":1,"content":"q","answer":"A"}',
            encoding="utf-8")
        return published

    def _run(self, tmp_path, extra_args, loader):
        from db_loader_cli import main
        with patch("db_loader_cli.RefineryConfig") as mock_cfg, \
             patch("db_loader_cli.DbLoader", return_value=loader):
            mock_cfg.from_env.return_value.output_dir = tmp_path
            main(["--input-dir", str(self._published(tmp_path))] + extra_args)

    def test_blocking_data_without_purge_flag_errors_and_skips_reset(self, tmp_path, capsys):
        """有业务数据 + 未传 --purge-business-data：报错退出，不 reset 不入库。"""
        loader = _mock_loader()
        loader.business_data_summary.return_value = {"main_error_books": 5, "progress": 2}
        self._run(tmp_path, ["--source", "all"], loader)

        out = capsys.readouterr().out
        assert "[ERROR]" in out and "main_error_books: 5 行" in out and "progress: 2 行" in out
        assert "--purge-business-data" in out and "--load-cards" in out
        loader.purge_business_data.assert_not_called()
        loader.reset_cards.assert_not_called()
        loader.reset_questions.assert_not_called()
        loader.load_questions.assert_not_called()

    def test_purge_flag_purges_then_resets(self, tmp_path, capsys):
        """有业务数据 + --purge-business-data：先清空业务表再 reset 再入库。"""
        loader = _mock_loader()
        loader.business_data_summary.return_value = {"main_error_books": 5}
        loader.purge_business_data.return_value = {"main_error_books": 5}
        self._run(tmp_path, ["--source", "all", "--purge-business-data"], loader)

        out = capsys.readouterr().out
        assert "[purge] DELETE main_error_books: 5 行" in out
        loader.purge_business_data.assert_called_once_with(True, True)
        loader.reset_cards.assert_called_once()
        loader.reset_questions.assert_called_once()
        loader.load_questions.assert_called_once()

    def test_no_blocking_data_resets_without_purge(self, tmp_path, capsys):
        """无业务数据：直接 reset，不调 purge。"""
        loader = _mock_loader()
        self._run(tmp_path, ["--source", "all"], loader)

        loader.purge_business_data.assert_not_called()
        loader.reset_cards.assert_called_once()
        loader.reset_questions.assert_called_once()

    def test_load_cards_mode_skips_guard(self, tmp_path):
        """--load-cards 增量模式：不 reset，不预检业务数据。"""
        loader = _mock_loader()
        self._run(tmp_path, ["--source", "all", "--load-cards"], loader)

        loader.business_data_summary.assert_not_called()
        loader.reset_cards.assert_not_called()
        loader.reset_questions.assert_not_called()
        loader.load_questions.assert_called_once()

    def test_source_zgkao_only_resets_questions(self, tmp_path):
        """--source zgkao：只 reset questions（cards/骨架不动）。"""
        loader = _mock_loader()
        loader.business_data_summary.return_value = {}
        self._run(tmp_path, ["--source", "zgkao"], loader)

        # business_data_summary(reset_cards=False, reset_questions=True)
        loader.business_data_summary.assert_called_once_with(False, True)
        loader.reset_cards.assert_not_called()
        loader.reset_questions.assert_called_once()

    def test_load_cards_guard_runtime_error_skips_book(self, tmp_path, capsys):
        """load_book_cards 抛业务数据守卫错误（如该书有学生 progress）：
        报错跳过该书，不中断其他书，最终 Loaded 提示跳过数。"""
        published = tmp_path / "published"
        b1 = published / "数学/初中/人教版/九年级/上册/书A"
        b2 = published / "数学/初中/人教版/九年级/上册/书B"
        b1.mkdir(parents=True)
        b2.mkdir(parents=True)
        (b1 / "page_001.jsonl").write_text(
            '{"lesson_id":"26.1 X","sort_order":1,"card_type":"concept","content":"c"}',
            encoding="utf-8")
        (b2 / "page_001.jsonl").write_text(
            '{"lesson_id":"27.1 Y","sort_order":1,"card_type":"concept","content":"c"}',
            encoding="utf-8")

        loader = _mock_loader()
        loader.load_book_cards.side_effect = [
            RuntimeError("书A: 该书已有 5 条学生练习记录引用旧卡片"),  # 书A 守卫报错
            10,                                                                 # 书B 正常
        ]
        with patch("db_loader_cli.RefineryConfig") as mock_cfg, \
             patch("db_loader_cli.DbLoader", return_value=loader):
            mock_cfg.from_env.return_value.output_dir = tmp_path
            from db_loader_cli import main
            main(["--input-dir", str(published), "--load-cards"])

        out = capsys.readouterr().out
        assert "[ERROR] 书A" in out
        assert "书B -> 10 cards" in out
        assert "1 本书因业务数据守卫被跳过" in out


class TestTocDir:
    """--toc-dir：按书匹配 merged TOC，先建骨架再挂卡。"""

    BOOK_KEY = "数学/初中/人教版/九年级/上册/数学九上"

    def _published(self, tmp_path):
        published = tmp_path / "published"
        book = published / self.BOOK_KEY
        book.mkdir(parents=True)
        (book / "page_001.jsonl").write_text(
            '{"lesson_id":"26.1 反比例函数","sort_order":1,"card_type":"concept","content":"c"}',
            encoding="utf-8")
        return published

    def _toc_dir(self, tmp_path, merged=True, initial=True):
        toc_dir = tmp_path / "toc"
        p = toc_dir / f"{self.BOOK_KEY}"
        p.parent.mkdir(parents=True, exist_ok=True)
        toc = {"book": "数学九上", "chapters": []}
        if initial:
            p.with_suffix(".json").write_text('{"book": "数学九上"}', encoding="utf-8")
        if merged:
            import json
            p.with_suffix(".merged.json").write_text(
                json.dumps(toc, ensure_ascii=False), encoding="utf-8")
        return toc_dir

    def _run(self, tmp_path, published, extra_args, loader):
        from db_loader_cli import main
        with patch("db_loader_cli.RefineryConfig") as mock_cfg, \
             patch("db_loader_cli.DbLoader", return_value=loader):
            mock_cfg.from_env.return_value.output_dir = tmp_path
            main(["--input-dir", str(published)] + extra_args)

    def test_load_cards_builds_skeleton_from_merged_first(self, tmp_path, capsys):
        published = self._published(tmp_path)
        toc_dir = self._toc_dir(tmp_path)
        merged_path = toc_dir / f"{self.BOOK_KEY}.merged.json"
        loader = _mock_loader()
        loader.load_toc_structure.return_value = {"chapters": 2, "lessons": 10}

        self._run(tmp_path, published, ["--load-cards", "--toc-dir", str(toc_dir)], loader)

        loader.load_toc_structure.assert_called_once_with(str(merged_path))
        call = loader.load_book_cards.call_args
        assert call.kwargs["toc_path"] == str(merged_path)
        out = capsys.readouterr().out
        assert "skeleton 2 chapters, 10 lessons" in out

    def test_load_cards_fallback_to_initial_toc(self, tmp_path):
        published = self._published(tmp_path)
        toc_dir = self._toc_dir(tmp_path, merged=False)  # 只有初始 toc.json
        initial_path = toc_dir / f"{self.BOOK_KEY}.json"
        loader = _mock_loader()
        loader.load_toc_structure.return_value = {"chapters": 1, "lessons": 5}

        self._run(tmp_path, published, ["--load-cards", "--toc-dir", str(toc_dir)], loader)

        loader.load_toc_structure.assert_called_once_with(str(initial_path))
        assert loader.load_book_cards.call_args.kwargs["toc_path"] == str(initial_path)

    def test_load_cards_no_toc_match_dynamic(self, tmp_path, capsys):
        published = self._published(tmp_path)
        toc_dir = tmp_path / "toc"  # 空目录：该书没有 toc
        toc_dir.mkdir()
        loader = _mock_loader()

        self._run(tmp_path, published, ["--load-cards", "--toc-dir", str(toc_dir)], loader)

        loader.load_toc_structure.assert_not_called()
        assert loader.load_book_cards.call_args.kwargs["toc_path"] is None
        assert "动态建结构" in capsys.readouterr().out

    def test_load_cards_toc_dir_overrides_toc_path(self, tmp_path):
        published = self._published(tmp_path)
        toc_dir = self._toc_dir(tmp_path)
        merged_path = toc_dir / f"{self.BOOK_KEY}.merged.json"
        loader = _mock_loader()
        loader.load_toc_structure.return_value = {"chapters": 2, "lessons": 10}

        self._run(tmp_path, published,
                  ["--load-cards", "--toc-dir", str(toc_dir),
                   "--toc-path", "/should/be/ignored.json"], loader)
        assert loader.load_book_cards.call_args.kwargs["toc_path"] == str(merged_path)

    def test_full_reload_with_toc_dir_rebuilds_skeleton(self, tmp_path):
        published = self._published(tmp_path)
        toc_dir = self._toc_dir(tmp_path)
        merged_path = toc_dir / f"{self.BOOK_KEY}.merged.json"
        loader = _mock_loader()
        loader.load_toc_structure.return_value = {"chapters": 2, "lessons": 10}

        self._run(tmp_path, published,
                  ["--toc-dir", str(toc_dir), "--purge-business-data"], loader)

        # full-reload：reset 后用 merged TOC 重建骨架（修复旧 footgun：reset 后空骨架全 skip）
        loader.reset_cards.assert_called_once()
        loader.load_toc_structure.assert_called_once_with(str(merged_path))
        assert loader.load_book_cards.call_args.kwargs["toc_path"] == str(merged_path)

    def test_load_toc_dir_mode(self, tmp_path, capsys):
        toc_dir = self._toc_dir(tmp_path)
        merged_path = toc_dir / f"{self.BOOK_KEY}.merged.json"
        loader = _mock_loader()
        loader.load_toc_structure.return_value = {"chapters": 2, "lessons": 10}

        with patch("db_loader_cli.RefineryConfig") as mock_cfg, \
             patch("db_loader_cli.DbLoader", return_value=loader):
            mock_cfg.from_env.return_value.output_dir = tmp_path
            from db_loader_cli import main
            main(["--load-toc", "--toc-dir", str(toc_dir)])

        loader.load_toc_structure.assert_called_once_with(str(merged_path))
        out = capsys.readouterr().out
        assert "TOC loaded: 2 chapters, 10 lessons" in out

    def test_load_toc_requires_path_or_dir(self, tmp_path, capsys):
        with patch("db_loader_cli.RefineryConfig"):
            from db_loader_cli import main
            main(["--load-toc"])
        assert "requires --toc-path or --toc-dir" in capsys.readouterr().out


class TestCollectTocFiles:
    def test_collect_prefers_merged_skips_report(self, tmp_path):
        from db_loader_cli import _collect_toc_files
        d = tmp_path / "toc" / "数学"
        d.mkdir(parents=True)
        (d / "书.json").write_text("{}", encoding="utf-8")
        (d / "书.merged.json").write_text("{}", encoding="utf-8")
        (d / "书.merge_report.json").write_text("{}", encoding="utf-8")
        (d / "另书.json").write_text("{}", encoding="utf-8")
        files = _collect_toc_files(tmp_path / "toc")
        names = sorted(p.name for p in files)
        assert names == ["书.merged.json", "另书.json"]

    def test_resolve_book_toc_prefers_merged(self, tmp_path):
        from db_loader_cli import _resolve_book_toc
        d = tmp_path / "toc" / "数学"
        d.mkdir(parents=True)
        (d / "书.json").write_text("{}", encoding="utf-8")
        (d / "书.merged.json").write_text("{}", encoding="utf-8")
        resolved = _resolve_book_toc(tmp_path / "toc", "数学/书")
        assert resolved.name == "书.merged.json"

    def test_resolve_book_toc_missing(self, tmp_path):
        from db_loader_cli import _resolve_book_toc
        assert _resolve_book_toc(tmp_path / "toc", "数学/书") is None

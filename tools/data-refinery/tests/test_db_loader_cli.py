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

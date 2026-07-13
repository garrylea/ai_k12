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

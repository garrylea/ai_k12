"""checkpoint.py 的 TDD 测试。

断点续传：记录已下载 URL，重启后可跳过。
存储在 data/.checkpoint.json。
"""

import json
from pathlib import Path

import pytest

from checkpoint import Checkpoint


@pytest.fixture
def checkpoint(tmp_path):
    cp = Checkpoint(tmp_path / ".checkpoint.json")
    cp.load()
    return cp


class TestIsDownloaded:
    def test_unknown_url_returns_false(self, checkpoint):
        assert checkpoint.is_downloaded("https://example.com/a.pdf") is False

    def test_marked_url_returns_true(self, checkpoint):
        url = "https://example.com/a.pdf"
        checkpoint.mark_downloaded(url)
        assert checkpoint.is_downloaded(url) is True

    def test_different_url_still_false_after_mark(self, checkpoint):
        checkpoint.mark_downloaded("https://example.com/a.pdf")
        assert checkpoint.is_downloaded("https://example.com/b.pdf") is False


class TestPersistence:
    def test_mark_downloaded_writes_file(self, checkpoint, tmp_path):
        checkpoint.mark_downloaded("https://example.com/a.pdf")
        assert (tmp_path / ".checkpoint.json").is_file()

    def test_new_instance_loads_marked_urls(self, tmp_path):
        cp1 = Checkpoint(tmp_path / ".checkpoint.json")
        cp1.load()
        cp1.mark_downloaded("https://example.com/a.pdf")

        cp2 = Checkpoint(tmp_path / ".checkpoint.json")
        cp2.load()
        assert cp2.is_downloaded("https://example.com/a.pdf") is True

    def test_multiple_urls_persisted(self, tmp_path):
        cp1 = Checkpoint(tmp_path / ".checkpoint.json")
        cp1.load()
        cp1.mark_downloaded("https://example.com/a.pdf")
        cp1.mark_downloaded("https://example.com/b.pdf")
        cp1.mark_downloaded("https://example.com/c.pdf")

        cp2 = Checkpoint(tmp_path / ".checkpoint.json")
        cp2.load()
        assert cp2.is_downloaded("https://example.com/a.pdf")
        assert cp2.is_downloaded("https://example.com/b.pdf")
        assert cp2.is_downloaded("https://example.com/c.pdf")


class TestEdgeCases:
    def test_missing_file_starts_empty(self, tmp_path):
        cp = Checkpoint(tmp_path / ".checkpoint.json")
        cp.load()
        assert cp.is_downloaded("https://example.com/a.pdf") is False

    def test_corrupted_file_starts_empty(self, tmp_path):
        path = tmp_path / ".checkpoint.json"
        path.write_text("{invalid json", encoding="utf-8")
        cp = Checkpoint(path)
        cp.load()
        assert cp.is_downloaded("https://example.com/a.pdf") is False

    def test_mark_same_url_twice_is_idempotent(self, tmp_path):
        path = tmp_path / ".checkpoint.json"
        cp = Checkpoint(path)
        cp.load()
        cp.mark_downloaded("https://example.com/a.pdf")
        cp.mark_downloaded("https://example.com/a.pdf")

        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["downloaded_urls"].count("https://example.com/a.pdf") == 1

    def test_clear_removes_all_urls(self, tmp_path):
        path = tmp_path / ".checkpoint.json"
        cp = Checkpoint(path)
        cp.load()
        cp.mark_downloaded("https://example.com/a.pdf")
        cp.clear()
        assert cp.is_downloaded("https://example.com/a.pdf") is False
        assert not path.exists()

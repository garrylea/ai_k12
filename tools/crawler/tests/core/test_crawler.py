"""通用 Crawler 编排测试。"""

import pytest

from adapters.base import Item, DownloadResult, DownloadContext, CrawlResult
from core.crawler import Crawler


class FakeAdapter:
    name = "fake"
    entry_url = "https://example.com/page"

    def __init__(self):
        self.items = [
            Item(id="a", title="A", tags={}, raw={}),
            Item(id="b", title="B", tags={}, raw={}),
        ]
        self.downloaded = []

    def list_items(self, filters: dict):
        for item in self.items:
            if filters.get("only") is None or item.id in filters["only"]:
                yield item

    def download_item(self, item, ctx):
        self.downloaded.append(item.id)
        return DownloadResult(files_downloaded=1)

    def robots_urls(self):
        return ["https://example.com/robots.txt"]

    def supported_filters(self):
        return set()

    def required_args(self):
        return set()

    def accepts(self, item):
        return True


class FakeFetcher:
    def fetch_text(self, url: str) -> str:
        return "User-agent: *\nAllow: /\n"

    def fetch_bytes(self, url: str) -> bytes:
        return b""


class TestCrawlerRun:
    def test_downloads_all_items(self):
        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=FakeFetcher())
        result = crawler.run(filters={})
        assert result.files_downloaded == 2
        assert adapter.downloaded == ["a", "b"]

    def test_respects_robots_disallow(self):
        class DisallowFetcher(FakeFetcher):
            def fetch_text(self, url: str) -> str:
                return "User-agent: *\nDisallow: /\n"

        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=DisallowFetcher())
        result = crawler.run(filters={})
        assert result.files_downloaded == 0
        assert result.robots_blocked is True

    def test_skips_checkpoint_items(self):
        class FakeCheckpoint:
            def is_downloaded(self, item_id):
                return item_id == "a"
            def mark_downloaded(self, item_id, path=None):
                pass
            def files_for_item(self, item_id):
                return ["数学/初中/first/2026/a.pdf"]

        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=FakeFetcher(), checkpoint=FakeCheckpoint())
        result = crawler.run(filters={})
        assert result.files_downloaded == 1
        assert adapter.downloaded == ["b"]
        assert result.items_skipped == 1

    def test_force_ignores_checkpoint(self):
        class FakeCheckpoint:
            def is_downloaded(self, item_id):
                return True
            def mark_downloaded(self, item_id, path=None):
                pass
            def files_for_item(self, item_id):
                return []

        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=FakeFetcher(), checkpoint=FakeCheckpoint(), force=True)
        result = crawler.run(filters={})
        assert result.files_downloaded == 2


class _PathCheckpoint:
    """is_downloaded 全真；files_for_item 可配置。"""

    def __init__(self, locations):
        self._locations = locations
        self.marked_files = []

    def is_downloaded(self, url):
        return True

    def files_for_item(self, url):
        return list(self._locations)

    def path_for_file(self, url):
        return None

    def mark_downloaded(self, url, path=None):
        self.marked_files.append((url, path))


class TestSkipLogging:
    def test_prints_file_paths_for_skipped_item(self, capsys):
        adapter = FakeAdapter()
        crawler = Crawler(
            adapter=adapter, fetcher=FakeFetcher(),
            checkpoint=_PathCheckpoint(["数学/初中/first/2026/a.pdf"]),
        )
        result = crawler.run(filters={})

        out = capsys.readouterr().out
        assert "已下载过：" in out and "a.pdf" in out
        assert "（跳过）" in out
        assert adapter.downloaded == []  # 有映射就真跳过，不再抓详情页
        assert result.items_skipped == 2

    def test_backfills_mapping_when_checkpoint_has_no_paths(self, capsys):
        """旧 checkpoint 只有 URL：走一次 adapter 补文件位置，而不是静默跳过。"""
        adapter = FakeAdapter()
        crawler = Crawler(
            adapter=adapter, fetcher=FakeFetcher(), checkpoint=_PathCheckpoint([]),
        )
        crawler.run(filters={})

        out = capsys.readouterr().out
        assert out.count("补记文件位置：") == 2
        assert adapter.downloaded == ["a", "b"]


class TestCounterUnits:
    """Total 数条目、新下载/已存在数文件，两套单位必须分桶报，重复行单列。"""

    def test_duplicate_row_counted_once(self):
        """站点把同一详情页登记两行时，第二行只记一条「重复」，不能再算下载/跳过。"""
        adapter = FakeAdapter()
        adapter.items.append(Item(id="a", title="A", tags={}, raw={}))
        crawler = Crawler(adapter=adapter, fetcher=FakeFetcher())

        result = crawler.run(filters={})

        assert result.items_total == 3
        assert result.items_duplicate == 1
        assert result.files_downloaded == 2
        assert adapter.downloaded == ["a", "b"]

    def test_item_level_counts_from_adapter_are_aggregated(self):
        class MixedAdapter(FakeAdapter):
            def download_item(self, item, ctx):
                self.downloaded.append(item.id)
                return DownloadResult(
                    files_downloaded=1, files_skipped=2,
                    items_without_file=1, items_duplicate=1,
                )

        crawler = Crawler(adapter=MixedAdapter(), fetcher=FakeFetcher())
        result = crawler.run(filters={})

        assert result.files_downloaded == 2
        assert result.files_skipped == 4
        assert result.items_without_file == 2
        assert result.items_duplicate == 2

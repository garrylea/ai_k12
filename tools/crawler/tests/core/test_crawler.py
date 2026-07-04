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
        assert result.items_downloaded == 2
        assert adapter.downloaded == ["a", "b"]

    def test_respects_robots_disallow(self):
        class DisallowFetcher(FakeFetcher):
            def fetch_text(self, url: str) -> str:
                return "User-agent: *\nDisallow: /\n"

        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=DisallowFetcher())
        result = crawler.run(filters={})
        assert result.items_downloaded == 0
        assert result.robots_blocked is True

    def test_skips_checkpoint_items(self):
        class FakeCheckpoint:
            def is_downloaded(self, item_id):
                return item_id == "a"
            def mark_downloaded(self, item_id):
                pass

        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=FakeFetcher(), checkpoint=FakeCheckpoint())
        result = crawler.run(filters={})
        assert result.items_downloaded == 1
        assert adapter.downloaded == ["b"]
        assert result.items_skipped == 1

    def test_force_ignores_checkpoint(self):
        class FakeCheckpoint:
            def is_downloaded(self, item_id):
                return True
            def mark_downloaded(self, item_id):
                pass

        adapter = FakeAdapter()
        crawler = Crawler(adapter=adapter, fetcher=FakeFetcher(), checkpoint=FakeCheckpoint(), force=True)
        result = crawler.run(filters={})
        assert result.items_downloaded == 2

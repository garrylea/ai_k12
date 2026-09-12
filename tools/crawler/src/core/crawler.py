"""通用爬虫编排：按 SiteAdapter 驱动 fetcher/store/checkpoint/validator。"""

from adapters.base import CrawlResult, DownloadContext, DownloadResult
from adapters.smartedu import CircuitBreakerError
from core.robots import RobotsChecker


class Crawler:
    def __init__(
        self,
        adapter,
        fetcher,
        store=None,
        checkpoint=None,
        validator=None,
        force: bool = False,
        dry_run: bool = False,
    ):
        self._adapter = adapter
        self._fetcher = fetcher
        self._store = store
        self._checkpoint = checkpoint
        self._validator = validator
        self._force = force
        self._dry_run = dry_run

    def run(self, filters: dict) -> CrawlResult:
        result = CrawlResult()

        for robots_url in self._adapter.robots_urls():
            robots_content = self._fetcher.fetch_text(robots_url)
            checker = RobotsChecker(robots_content)
            if not checker.is_allowed(self._adapter.entry_url):
                result.robots_blocked = True
                return result

        ctx = DownloadContext(
            fetcher=self._fetcher,
            store=self._store,
            checkpoint=self._checkpoint,
            validator=self._validator,
            force=self._force,
            dry_run=self._dry_run,
        )

        for item in self._adapter.list_items(filters):
            result.items_total += 1
            if self._checkpoint and self._checkpoint.is_downloaded(item.id) and not self._force:
                result.items_skipped += 1
                continue

            try:
                download_result = self._adapter.download_item(item, ctx)
            except CircuitBreakerError:
                result.items_failed += 1
                continue

            result.items_downloaded += download_result.files_downloaded
            result.items_skipped += download_result.files_skipped
            result.items_failed += download_result.files_failed
            result.items_unresolved += download_result.files_unresolved

        return result

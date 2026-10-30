"""通用爬虫编排：按 SiteAdapter 驱动 fetcher/store/checkpoint/validator。"""

from pathlib import Path

from adapters.base import CrawlResult, DownloadContext, DownloadResult
from adapters.smartedu import CircuitBreakerError
from core.robots import RobotsChecker


def _absolute(base_dir, rel_path: str) -> str:
    return str((Path(base_dir) / rel_path).resolve())


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
                print(f"已停止：robots.txt 不允许抓取 {self._adapter.entry_url}")
                return result

        ctx = DownloadContext(
            fetcher=self._fetcher,
            store=self._store,
            checkpoint=self._checkpoint,
            validator=self._validator,
            force=self._force,
            dry_run=self._dry_run,
        )

        base_dir = getattr(self._store, "base_dir", Path("."))
        seen_ids: set[str] = set()

        for item in self._adapter.list_items(filters):
            result.items_total += 1
            # 先过滤再谈跳过：被 --subject/--grade 排除的条目既不算「已下载」也不算失败
            if not self._adapter.accepts(item):
                result.items_filtered += 1
                continue

            # 站点会把同一个详情页登记成多行（只是区/校标签不同）。第二行起单独记「重复」，
            # 不能算下载也不能算跳过 —— 否则汇总行看起来像在重复计数（2026-10-30 的 3 行）。
            if item.id in seen_ids:
                result.items_duplicate += 1
                continue
            seen_ids.add(item.id)

            if self._checkpoint and self._checkpoint.is_downloaded(item.id) and not self._force:
                locations = self._checkpoint.files_for_item(item.id)
                if locations:
                    for rel in locations:
                        print(f"已下载过：{_absolute(base_dir, rel)}（跳过）")
                    result.items_skipped += 1
                    continue
                # 旧 checkpoint 只有 URL、没有「详情页 → 文件」映射：继续走一次 adapter，
                # 逐个文件打印「已存在：<绝对路径>」并把映射补进 checkpoint（不重下 PDF）。
                print(f"补记文件位置：{item.id}（旧记录没有文件路径，仅抓详情页）")

            try:
                download_result = self._adapter.download_item(item, ctx)
            except CircuitBreakerError:
                # 熔断时整个站点都在失败，逐项记一次失败即可；归到文件桶是因为它至少含 1 个文件
                result.files_failed += 1
                continue

            result.files_downloaded += download_result.files_downloaded
            result.files_skipped += download_result.files_skipped
            result.files_failed += download_result.files_failed
            result.files_unresolved += download_result.files_unresolved
            result.items_duplicate += download_result.items_duplicate
            result.items_without_file += download_result.items_without_file

        return result

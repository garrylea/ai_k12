"""smartedu.cn 教材适配器。"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from adapters.base import DownloadContext, DownloadResult, Item, SiteAdapter


_DIMENSION_MAP = {
    "zxxxd": "level",
    "zxxxk": "subject",
    "zxxbb": "publisher",
    "zxxnj": "grade",
    "zxxcc": "semester",
}


class CircuitBreakerError(Exception):
    pass


@dataclass
class SmartEduTagCache:
    data: dict

    def name(self, dimension: str, tag_id: str) -> str:
        for item in self.data.get(dimension, []):
            if item.get("tag_id") == tag_id:
                return item.get("tag_name", "")
        return ""

    def tag_id(self, dimension: str, name: str) -> str | None:
        for item in self.data.get(dimension, []):
            if item.get("tag_name") == name:
                return item.get("tag_id")
        return None

    def normalize_subject(self, tag_id: str) -> str:
        return self.name("zxxxk", tag_id)

    def standardize(self, tag_dict: dict) -> dict:
        result = {}
        for dim, key in _DIMENSION_MAP.items():
            value = tag_dict.get(dim)
            if value:
                result[key] = self.name(dim, value)
        return result


class SmartEduAdapter(SiteAdapter):
    name = "smartedu"

    TAG_URL = "https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/tags/tch_material_tag.json"
    VERSION_URL = "https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/resources/tch_material/version/data_version.json"

    def __init__(self, fetcher, base_dir: str = "data", latest_only: bool = True):
        self._fetcher = fetcher
        self._base_dir = base_dir
        self._latest_only = latest_only

    @property
    def entry_url(self) -> str:
        return "https://basic.smartedu.cn/tchMaterial"

    def robots_urls(self) -> list[str]:
        return []

    def supported_filters(self) -> set[str]:
        return {"subject", "level", "grade", "semester", "publisher"}

    def required_args(self) -> set[str]:
        return set()

    def list_items(self, filters: dict) -> Iterator[Item]:
        tag_text = self._fetcher.fetch_text(self.TAG_URL)
        tag_data = json.loads(tag_text)
        version_text = self._fetcher.fetch_text(self.VERSION_URL)
        version_data = json.loads(version_text)

        part_urls = [u.strip() for u in version_data.get("urls", "").split(",") if u.strip()]
        parts = []
        for url in part_urls:
            part_text = self._fetcher.fetch_text(url)
            parts.append(json.loads(part_text))

        for item in self._parse_catalog(tag_data, parts):
            if self._matches(item, filters):
                yield item

    def download_item(self, item: Item, ctx: DownloadContext) -> DownloadResult:
        if not ctx.force and ctx.checkpoint and ctx.checkpoint.is_downloaded(item.id):
            return DownloadResult(files_skipped=1)
        return self._download_book(
            ctx.fetcher,
            ctx.store,
            ctx.checkpoint,
            item,
            validator=ctx.validator,
            force=ctx.force,
            dry_run=ctx.dry_run,
        )

    def _parse_catalog(self, tag_data: dict, parts: list[list[dict]]) -> Iterator[Item]:
        cache = SmartEduTagCache(tag_data)
        all_items = []
        for part in parts:
            for raw in part:
                tags = self._extract_tags(raw, cache)
                all_items.append(Item(
                    id=raw["id"],
                    title=raw["title"],
                    tags=tags,
                    raw=raw,
                ))
        if self._latest_only:
            all_items = self._dedup_latest(all_items)
        for item in all_items:
            yield item

    @staticmethod
    def _extract_tags(raw: dict, cache: SmartEduTagCache) -> dict:
        """Extract dimension tags from tag_list (supports both object and string formats)."""
        tag_list = raw.get("tag_list", [])
        if not tag_list:
            return {}
        # Object format: [{tag_id, tag_name, tag_dimension_id}, ...]
        if isinstance(tag_list[0], dict):
            result = {}
            for entry in tag_list:
                dim = entry.get("tag_dimension_id", "")
                if dim in _DIMENSION_MAP:
                    result[_DIMENSION_MAP[dim]] = entry.get("tag_name", "")
            return result
        # Legacy flat format: [tag_id_string, ...]
        tag_dict = {}
        for dim in _DIMENSION_MAP:
            for tid in tag_list:
                if cache.name(dim, tid):
                    tag_dict[dim] = tid
                    break
        return cache.standardize(tag_dict)

    def _dedup_latest(self, items: list[Item]) -> list[Item]:
        groups: dict[tuple, list[Item]] = {}
        for item in items:
            key = (item.title, item.tags.get("publisher"), item.tags.get("subject"))
            groups.setdefault(key, []).append(item)
        result = []
        for group in groups.values():
            group_sorted = sorted(group, key=lambda x: x.raw.get("update_time", ""), reverse=True)
            result.append(group_sorted[0])
        return result

    def _matches(self, item: Item, filters: dict) -> bool:
        supported = self.supported_filters()
        for raw_key, allowed in filters.items():
            key = raw_key.rstrip("s")
            if key not in supported:
                continue
            if item.tags.get(key) not in allowed:
                return False
        return True

    def _download_page(self, fetcher, store, dir_relpath: Path, page: int, url: str, validator=None):
        from core.validator import ImageValidator
        if validator is None:
            validator = ImageValidator()

        content = fetcher.fetch_bytes(url)
        path = store.save_page(dir_relpath, page, content, url)
        result = validator.validate(str(path))
        if result.is_valid:
            return path

        path.unlink(missing_ok=True)
        content = fetcher.fetch_bytes(url)
        path = store.save_page(dir_relpath, page, content, url)
        result = validator.validate(str(path))
        if result.is_valid:
            return path

        path.unlink(missing_ok=True)
        return None

    def _download_book(self, fetcher, store, checkpoint, item: Item, validator=None, force: bool = False, dry_run: bool = False):
        from core.validator import ImageValidator
        if validator is None:
            validator = ImageValidator()

        preview = item.raw.get("custom_properties", {}).get("preview", {})
        slide_urls = self._build_page_urls(preview, item.id, fetcher)
        if not slide_urls:
            return DownloadResult(files_failed=1)

        total_pages = len(slide_urls)
        if dry_run:
            return DownloadResult(files_downloaded=total_pages)

        dir_relpath = self._storage_dir(item)
        classification = dict(item.tags)
        classification["title"] = item.title
        source = {"asset_id": item.id, "content_id": item.raw.get("content_id", "")}
        store.init_book_meta(dir_relpath, classification, source, total_pages)

        result = DownloadResult()
        failed_pages = []
        consecutive_failures = 0

        for page, url in enumerate(slide_urls, 1):
            if checkpoint and checkpoint.is_downloaded(url) and not force:
                result.files_skipped += 1
                consecutive_failures = 0
                continue

            path = self._download_page(fetcher, store, dir_relpath, page, url, validator=validator)
            if path is None:
                result.files_failed += 1
                failed_pages.append(page)
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    store.finalize_book(dir_relpath, failed_pages)
                    raise CircuitBreakerError(f"3 consecutive failures at page {page}")
            else:
                result.files_downloaded += 1
                consecutive_failures = 0
                if checkpoint:
                    checkpoint.mark_downloaded(url)

        store.finalize_book(dir_relpath, failed_pages)
        if checkpoint and not failed_pages:
            checkpoint.mark_downloaded(item.id)
        return result

    def _build_page_urls(self, preview: dict, asset_id: str | None = None, fetcher=None) -> list[str]:
        """Build ordered page URL list.

        Uses preview Slide keys as starting point, then binary-searches via HEAD
        to find the actual total page count (preview often only shows ~49 slides
        while the full book is 160+ pages).
        """
        if not preview:
            return []
        slide_keys = [k for k in preview if k.startswith("Slide")]
        if not slide_keys:
            return []
        slide_keys.sort(key=lambda k: int(k[5:]))
        slide_urls = [preview[k] for k in slide_keys]
        first_url = slide_urls[0]

        # Determine max page via binary search on HEAD requests
        base_url = first_url.rsplit("/", 1)[0]
        min_page = len(slide_urls)
        max_page = self._detect_max_page(base_url, min_page, fetcher)

        return [f"{base_url}/{p}.jpg" for p in range(1, max_page + 1)]

    @staticmethod
    def _detect_max_page(base_url: str, min_page: int, fetcher) -> int:
        """Binary search via HEAD to find the last existing page."""
        if fetcher is None:
            return min_page
        low, high = min_page, 500
        while low < high:
            mid = (low + high + 1) // 2
            url = f"{base_url}/{mid}.jpg"
            status, _ = fetcher.fetch_head(url)
            if status == 200:
                low = mid
            else:
                high = mid - 1
        return low

    def _storage_dir(self, item: Item) -> Path:
        parts = [item.tags.get(k, "其他") for k in ["subject", "level", "publisher", "grade", "semester"]]
        parts.append(item.title)
        return Path(*parts)

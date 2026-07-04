"""站点适配器抽象接口。"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional


@dataclass
class Item:
    id: str
    title: str
    tags: dict
    raw: dict


@dataclass
class DownloadResult:
    files_downloaded: int = 0
    files_skipped: int = 0
    files_failed: int = 0

    def __iadd__(self, other):
        self.files_downloaded += other.files_downloaded
        self.files_skipped += other.files_skipped
        self.files_failed += other.files_failed
        return self


@dataclass
class DownloadContext:
    fetcher: object
    store: object
    checkpoint: object
    validator: object
    force: bool = False
    dry_run: bool = False
    crawl_delay: float = 0.0


@dataclass
class CrawlResult:
    items_total: int = 0
    items_downloaded: int = 0
    items_skipped: int = 0
    items_failed: int = 0
    robots_blocked: bool = False


class SiteAdapter(ABC):
    name: str

    @property
    @abstractmethod
    def entry_url(self) -> str:
        ...

    @abstractmethod
    def list_items(self, filters: dict) -> Iterator[Item]:
        ...

    @abstractmethod
    def download_item(self, item: Item, ctx: DownloadContext) -> DownloadResult:
        ...

    @abstractmethod
    def robots_urls(self) -> list[str]:
        ...

    @abstractmethod
    def supported_filters(self) -> set[str]:
        ...

    @abstractmethod
    def required_args(self) -> set[str]:
        ...

    def storage_dir(self, item: Item) -> Path:
        raise NotImplementedError

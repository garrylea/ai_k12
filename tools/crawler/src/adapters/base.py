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
    files_unresolved: int = 0
    # 以下两个是按**条目**计：一个详情页换不来文件、或在同一次运行里被重复遍历
    items_duplicate: int = 0
    items_without_file: int = 0
    # 本详情页涉及的文件位置（相对输出目录），含本次新下载与已存在跳过的，
    # 供 checkpoint 记录「详情页 → 文件」映射，整项跳过时能直接打印路径
    file_locations: list[str] = field(default_factory=list)

    def __iadd__(self, other):
        self.files_downloaded += other.files_downloaded
        self.files_skipped += other.files_skipped
        self.files_failed += other.files_failed
        self.files_unresolved += other.files_unresolved
        self.items_duplicate += other.items_duplicate
        self.items_without_file += other.items_without_file
        self.file_locations.extend(other.file_locations)
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
    """两套单位，**不可相加**：`items_*` 数索引页的行，`files_*` 数落盘的文件。

    一个条目可能产出 0 个文件（正文没附件）、1 个或 2 个文件（试卷 + 答案），
    也可能整项跳过连详情页都不抓 —— 所以 Total 永远不等于下载数加跳过数。
    """

    # 条目
    items_total: int = 0
    items_filtered: int = 0
    items_skipped: int = 0        # 整项已在 checkpoint，未打开详情页
    items_duplicate: int = 0      # 同一 id 在一次运行里出现多次（站点重复登记）
    items_without_file: int = 0   # 详情页里没有任何可下载文件
    # 文件
    files_downloaded: int = 0
    files_skipped: int = 0
    files_failed: int = 0
    files_unresolved: int = 0
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

    def accepts(self, item: Item) -> bool:
        """该条目是否被 --year/--subject 等过滤条件命中。

        默认全收。zgkao 用它在「checkpoint 已标记但缺文件位置」时判断
        要不要为了补日志/补映射再走一次详情页——过滤掉的条目不值得发请求。
        """
        return True

    def storage_dir(self, item: Item) -> Path:
        raise NotImplementedError

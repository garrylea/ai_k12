"""smartedu 适配器 TDD 测试。"""

import pytest
from unittest.mock import MagicMock
from datetime import datetime, timezone
from pathlib import Path

from adapters.base import DownloadContext, Item
from adapters.smartedu import SmartEduAdapter, SmartEduTagCache, CircuitBreakerError
from core.storage import ImageStore
from core.validator import ImageValidator
from core.checkpoint import Checkpoint


TAG_JSON = {
    "zxxxd": [{"tag_id": "zxxxd1", "tag_name": "小学"}, {"tag_id": "zxxxd2", "tag_name": "初中"}],
    "zxxxk": [{"tag_id": "zxxxk1", "tag_name": "数学"}],
    "zxxbb": [{"tag_id": "zxxbb1", "tag_name": "人教版"}],
    "zxxnj": [{"tag_id": "zxxnj9", "tag_name": "九年级"}],
    "zxxcc": [{"tag_id": "zxxcc1", "tag_name": "上册"}],
}

PART_100 = [
    {
        "id": "71a82bac-0c70-4d53-9e8f-22be536415f0",
        "title": "义务教育教科书·数学九年级上册",
        "tag_list": ["zxxxd2", "zxxxk1", "zxxbb1", "zxxnj9", "zxxcc1"],
        "update_time": "2024-01-15",
        "custom_properties": {
            "preview": {
                "Slide1": "https://r3-ndr.ykt.cbern.com.cn/edu_product/esp/assets/71a82bac.t/zh-CN/1710000000000/transcode/image/1.jpg",
                "Slide2": "https://r2-ndr.ykt.cbern.com.cn/edu_product/esp/assets/71a82bac.t/zh-CN/1710000000000/transcode/image/2.jpg",
                "Slide3": "https://r1-ndr.ykt.cbern.com.cn/edu_product/esp/assets/71a82bac.t/zh-CN/1710000000000/transcode/image/3.jpg",
            }
        },
    },
]


class TestSmartEduTagCache:
    def test_loads_tag_mapping(self):
        cache = SmartEduTagCache(TAG_JSON)
        assert cache.name("zxxxd", "zxxxd2") == "初中"

    def test_returns_tag_id_for_name(self):
        cache = SmartEduTagCache(TAG_JSON)
        assert cache.tag_id("zxxxd", "初中") == "zxxxd2"

    def test_normalizes_subject(self):
        cache = SmartEduTagCache(TAG_JSON)
        assert cache.normalize_subject("zxxxk1") == "数学"

    def test_standardizes_tags(self):
        cache = SmartEduTagCache(TAG_JSON)
        assert cache.standardize({"zxxxd": "zxxxd2", "zxxxk": "zxxxk1"}) == {
            "level": "初中", "subject": "数学"
        }


class TestSmartEduCatalog:
    def test_lists_items_from_parts(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        items = list(adapter._parse_catalog(TAG_JSON, [PART_100]))
        assert len(items) == 1
        assert items[0].title == "义务教育教科书·数学九年级上册"

    def test_item_has_standardized_tags(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        items = list(adapter._parse_catalog(TAG_JSON, [PART_100]))
        assert items[0].tags["subject"] == "数学"
        assert items[0].tags["level"] == "初中"
        assert items[0].tags["publisher"] == "人教版"

    def test_dedup_keeps_latest(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        older = dict(PART_100[0])
        older["id"] = "old-version"
        older["update_time"] = "2023-06-01"
        items = list(adapter._parse_catalog(TAG_JSON, [PART_100 + [older]]))
        assert len(items) == 1
        assert items[0].id == "71a82bac-0c70-4d53-9e8f-22be536415f0"


class TestSmartEduFilters:
    def test_filter_by_subject(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        items = [
            Item(id="1", title="数学", tags={"subject": "数学"}, raw={}),
            Item(id="2", title="语文", tags={"subject": "语文"}, raw={}),
        ]
        result = [i for i in items if adapter._matches(i, {"subject": {"数学"}})]
        assert len(result) == 1
        assert result[0].id == "1"

    def test_filter_by_publisher(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        item = Item(id="1", title="数学", tags={"publisher": "人教版"}, raw={})
        assert adapter._matches(item, {"publisher": {"人教版"}}) is True
        assert adapter._matches(item, {"publisher": {"北师大版"}}) is False

    def test_empty_filter_passes(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        item = Item(id="1", title="数学", tags={"subject": "数学"}, raw={})
        assert adapter._matches(item, {}) is True

    def test_plural_key_stripped(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        item = Item(id="1", title="数学", tags={"subject": "数学"}, raw={})
        assert adapter._matches(item, {"subjects": {"数学"}}) is True


class TestSmartEduBuildPageUrls:
    def test_builds_ordered_urls_from_preview(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        preview = {
            "Slide3": "https://example.com/3.jpg",
            "Slide1": "https://example.com/1.jpg",
            "Slide2": "https://example.com/2.jpg",
        }
        urls = adapter._build_page_urls(preview)
        assert urls == ["https://example.com/1.jpg", "https://example.com/2.jpg", "https://example.com/3.jpg"]

    def test_empty_preview_returns_empty(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        assert adapter._build_page_urls({}) == []

    def test_no_slide_keys_returns_empty(self):
        adapter = SmartEduAdapter(fetcher=MagicMock())
        assert adapter._build_page_urls({"other": "value"}) == []


class TestSmartEduPageDownload:
    def test_downloads_valid_page(self, tmp_path):
        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc), site_adapter="smartedu")
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class BytesFetcher:
            def fetch_bytes(self, url: str) -> bytes:
                return b"\xff\xd8\xffvalid"

        path = adapter._download_page(BytesFetcher(), store, Path("书"), 1, "https://example.com/1.jpg")
        assert path.is_file()
        assert path.name == "page_001.jpg"

    def test_retries_on_invalid_image(self, tmp_path):
        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc), site_adapter="smartedu")
        adapter = SmartEduAdapter(fetcher=MagicMock())

        attempts = []

        class BadThenGoodFetcher:
            def fetch_bytes(self, url: str) -> bytes:
                attempts.append(url)
                if len(attempts) == 1:
                    return b"not an image"
                return b"\xff\xd8\xffvalid"

        path = adapter._download_page(
            BadThenGoodFetcher(), store, Path("书"), 1, "https://example.com/1.jpg",
            validator=ImageValidator(),
        )
        assert path.is_file()
        assert len(attempts) == 2

    def test_skips_after_retry_fails(self, tmp_path):
        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc), site_adapter="smartedu")
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class AlwaysBadFetcher:
            def fetch_bytes(self, url: str) -> bytes:
                return b"not an image"

        path = adapter._download_page(
            AlwaysBadFetcher(), store, Path("书"), 1, "https://example.com/1.jpg",
            validator=ImageValidator(),
        )
        assert path is None


class NoHeadFetcher:
    """fetch_head 一律 404：让 _detect_max_page 的二分探测直接收敛到 preview 页数（min_page）。

    _download_book -> _build_page_urls 会先 HEAD 二分探测真实总页数，测试 fake fetcher
    需实现 fetch_head 才能走到下载逻辑；404 即"探测无更多页"，页数=preview Slide 数。
    """

    def fetch_head(self, url: str):
        return (404, {})


class TestSmartEduCircuitBreaker:
    def _preview(self, n):
        return {f"Slide{i}": f"https://example.com/{i}.jpg" for i in range(1, n + 1)}

    def test_circuit_breaker_after_three_consecutive_failures(self, tmp_path):
        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc), site_adapter="smartedu")
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class FailingFetcher(NoHeadFetcher):
            def fetch_bytes(self, url: str) -> bytes:
                return b"bad"

        with pytest.raises(CircuitBreakerError):
            adapter._download_book(
                FailingFetcher(), store, None,
                Item(id="book1", title="书", tags={}, raw={"custom_properties": {"preview": self._preview(5)}}),
                validator=ImageValidator(),
            )

    def test_resets_consecutive_failures_on_success(self, tmp_path):
        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc), site_adapter="smartedu")
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class MixedFetcher(NoHeadFetcher):
            def fetch_bytes(self, url: str) -> bytes:
                if url.endswith("/1.jpg") or url.endswith("/3.jpg"):
                    return b"bad"
                return b"\xff\xd8\xffok"

        result = adapter._download_book(
            MixedFetcher(), store, None,
            Item(id="book1", title="书", tags={}, raw={"custom_properties": {"preview": self._preview(4)}}),
            validator=ImageValidator(),
        )
        assert result.files_failed == 2
        assert result.files_downloaded == 2


class TestSmartEduDownloadItem:
    def test_download_item_success(self, tmp_path):
        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc), site_adapter="smartedu")
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")
        checkpoint.load()
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class OkFetcher(NoHeadFetcher):
            def fetch_bytes(self, url: str) -> bytes:
                return b"\xff\xd8\xffok"

        ctx = DownloadContext(fetcher=OkFetcher(), store=store, checkpoint=checkpoint, validator=ImageValidator())
        preview = {f"Slide{i}": f"https://example.com/{i}.jpg" for i in range(1, 4)}
        item = Item(id="book1", title="书", tags={"subject": "数学", "level": "初中"}, raw={"custom_properties": {"preview": preview}})
        result = adapter.download_item(item, ctx)
        assert result.files_downloaded == 3
        meta = store.read_meta(Path("数学/初中/其他/其他/其他/书"))
        assert meta["status"] == "complete"

    def test_download_item_skips_complete_book(self, tmp_path):
        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc), site_adapter="smartedu")
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")
        checkpoint.load()
        checkpoint.mark_downloaded("book1")
        adapter = SmartEduAdapter(fetcher=MagicMock())

        class NoCallFetcher:
            def fetch_head(self, url: str):
                raise AssertionError("should not be called")

            def fetch_bytes(self, url: str) -> bytes:
                raise AssertionError("should not be called")

        ctx = DownloadContext(fetcher=NoCallFetcher(), store=store, checkpoint=checkpoint, validator=None)
        item = Item(id="book1", title="书", tags={}, raw={})
        result = adapter.download_item(item, ctx)
        assert result.files_skipped == 1


class TestSmartEduEndToEnd:
    def test_full_flow_mocked(self, tmp_path):
        store = ImageStore(base_dir=str(tmp_path), entry_url="https://basic.smartedu.cn", crawl_time=datetime.now(timezone.utc), site_adapter="smartedu")
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")
        checkpoint.load()

        adapter = SmartEduAdapter(fetcher=MagicMock(), latest_only=True)

        class EndToEndFetcher(NoHeadFetcher):
            def fetch_bytes(self, url: str) -> bytes:
                return b"\xff\xd8\xffpage"

        ctx = DownloadContext(fetcher=EndToEndFetcher(), store=store, checkpoint=checkpoint, validator=ImageValidator())
        items = list(adapter._parse_catalog(TAG_JSON, [PART_100]))
        assert len(items) == 1

        result = adapter.download_item(items[0], ctx)
        assert result.files_downloaded == 3
        meta = store.read_meta(Path("数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册"))
        assert meta["status"] == "complete"
        assert len(meta["files"]) == 3

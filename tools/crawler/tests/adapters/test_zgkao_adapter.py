"""ZgkaoAdapter 适配器接口测试。"""

import io
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from pypdf import PdfWriter

from adapters.zgkao import ZgkaoAdapter
from adapters.base import DownloadContext, DownloadResult, Item
from core.storage import PdfStore
from core.checkpoint import Checkpoint
from core.validator import PdfValidator


INDEX_HTML = """
<html><body>
<table>
  <tr><td colspan="4"><strong>2026西城初三二模试卷&答案</strong></td></tr>
  <tr><td>科目</td><td>2026年</td><td>2025年</td><td>2024年</td></tr>
  <tr>
    <td>数学</td>
    <td><a href="https://www.zgkao.com/shitiku/90304.html">试卷 | 答案</a></td>
    <td>收集中</td>
    <td>收集中</td>
  </tr>
</table>
</body></html>
"""

DETAIL_HTML = """
<html><body>
<script id="__NUXT_DATA__" type="application/json">
["Reactive", "2026北京西城初三二模数学 有答案.pdf", "https://cdn.zgkao.com/zixunzhan/test.pdf"]
</script>
</body></html>
"""


def make_pdf_bytes() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


class MockFetcher:
    def __init__(self):
        self._routes = {
            "https://www.zgkao.com/robots.txt": ("text", "User-agent: *\nAllow: /\n"),
            "https://www.zgkao.com/shitiku/89047.html": ("text", INDEX_HTML),
            "https://www.zgkao.com/shitiku/90304.html": ("text", DETAIL_HTML),
            "https://cdn.zgkao.com/zixunzhan/test.pdf": ("bytes", make_pdf_bytes()),
        }

    def fetch_text(self, url: str) -> str:
        kind, content = self._routes.get(url, ("text", ""))
        return content

    def fetch_bytes(self, url: str) -> bytes:
        kind, content = self._routes.get(url, ("bytes", b""))
        return content


class TestZgkaoAdapterInterface:
    def test_name(self):
        adapter = ZgkaoAdapter(MockFetcher(), "https://www.zgkao.com/shitiku/89047.html", {})
        assert adapter.name == "zgkao"

    def test_robots_urls(self):
        adapter = ZgkaoAdapter(MockFetcher(), "https://www.zgkao.com/shitiku/89047.html", {})
        assert adapter.robots_urls() == ["https://www.zgkao.com/robots.txt"]

    def test_list_items_yields_items(self):
        adapter = ZgkaoAdapter(MockFetcher(), "https://www.zgkao.com/shitiku/89047.html", {})
        items = list(adapter.list_items({}))
        assert len(items) == 1
        assert items[0].tags["subject"] == "数学"
        assert items[0].tags["district"] == "西城"
        assert items[0].tags["year"] == "2026"

    def test_download_item_saves_pdf(self, tmp_path):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        crawl_time = datetime(2026, 7, 4, 10, 0, 0, tzinfo=timezone.utc)
        store = PdfStore(
            base_dir=str(tmp_path),
            entry_url="https://www.zgkao.com/shitiku/89047.html",
            crawl_time=crawl_time,
        )
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")
        checkpoint.load()

        items = list(adapter.list_items({}))
        ctx = DownloadContext(
            fetcher=fetcher,
            store=store,
            checkpoint=checkpoint,
            validator=PdfValidator(),
        )
        result = adapter.download_item(items[0], ctx)
        assert result.files_downloaded == 1

    def test_dry_run_does_not_pollute_checkpoint(self, tmp_path):
        """回归：dry-run 只计数不落盘，也不能把 detail URL 写进 checkpoint--
        否则后续真实爬取会因 is_downloaded(item.id) 整批跳过（PDF 实际未下载）。"""
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        crawl_time = datetime(2026, 7, 4, 10, 0, 0, tzinfo=timezone.utc)
        store = PdfStore(
            base_dir=str(tmp_path),
            entry_url="https://www.zgkao.com/shitiku/89047.html",
            crawl_time=crawl_time,
        )
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")
        checkpoint.load()

        items = list(adapter.list_items({}))
        ctx = DownloadContext(
            fetcher=fetcher,
            store=store,
            checkpoint=checkpoint,
            validator=PdfValidator(),
            dry_run=True,
        )
        result = adapter.download_item(items[0], ctx)
        assert result.files_downloaded == 1  # dry-run 计数照常
        assert not checkpoint.is_downloaded(items[0].id)  # 但不标 checkpoint
        assert not checkpoint.is_downloaded("https://cdn.zgkao.com/zixunzhan/test.pdf")

        # 真实爬取（关掉 dry-run，新 adapter 实例模拟下一次运行）应能正常下载，
        # 不被 dry-run 留下的 checkpoint 状态挡住
        adapter_real = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        ctx_real = DownloadContext(
            fetcher=fetcher,
            store=store,
            checkpoint=checkpoint,
            validator=PdfValidator(),
        )
        result_real = adapter_real.download_item(items[0], ctx_real)
        assert result_real.files_downloaded == 1

    def test_filter_excludes_non_matching(self):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {"years": {"2025"}})
        items = list(adapter.list_items({}))
        ctx = DownloadContext(fetcher=fetcher, store=MagicMock(), checkpoint=None, validator=None)
        result = adapter.download_item(items[0], ctx)
        assert result.files_downloaded == 0

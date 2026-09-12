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

SECONDARY_A_INDEX_HTML = """
<html><body>
<table>
  <tr><td colspan="2"><strong>2023海淀初三二模试卷&答案</strong></td></tr>
  <tr><td>科目</td><td>2023年</td></tr>
  <tr>
    <td>数学</td>
    <td><a href="https://www.zgkao.com/zk/202304/60347.html">试卷 | 答案</a></td>
  </tr>
</table>
</body></html>
"""

SECONDARY_B_INDEX_HTML = """
<html><body>
<table>
  <tr><td colspan="3"><strong>2023海淀初三二模试卷&答案汇总</strong></td></tr>
  <tr><td>区</td><td>科目</td><td>2023年</td></tr>
  <tr>
    <td>海淀区</td>
    <td>数学</td>
    <td><a href="https://www.zgkao.com/zk/202305/61551.html">试卷</a></td>
  </tr>
</table>
</body></html>
"""

DOWNLOAD_PAGE_HTML = """
<html><body>
<a class="download" href="https://cdn.zgkao.com/zixunzhan/202401/abc.pdf">立即下载：2023海淀初三二模数学试卷</a>
<a class="download" href="https://cdn.zgkao.com/zixunzhan/202401/def.pdf">立即下载：2023海淀初三二模数学试卷答案</a>
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


class StubResolver:
    """记录调用参数的学期解析桩，替代真实询问。"""

    def __init__(self, semester):
        self._semester = semester
        self.last_kwargs = {}
        self.unresolved = []

    def resolve(self, **kwargs):
        self.last_kwargs = kwargs
        if self._semester is None:
            self.unresolved.append(kwargs.get("label", ""))
        return self._semester


def _make_ctx(tmp_path, fetcher, dry_run=False):
    store = PdfStore(
        base_dir=str(tmp_path),
        entry_url="https://www.zgkao.com/shitiku/89047.html",
        crawl_time=datetime(2026, 7, 4, 10, 0, 0, tzinfo=timezone.utc),
    )
    return DownloadContext(
        fetcher=fetcher, store=store, checkpoint=None, validator=PdfValidator(), dry_run=dry_run,
    )


class TestZgkaoGradeFilter:
    def test_supported_filters_includes_grades(self):
        adapter = ZgkaoAdapter(MockFetcher(), "https://www.zgkao.com/shitiku/89047.html", {})
        assert "grades" in adapter.supported_filters()

    def test_excludes_non_matching_grade(self):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {"grades": {"初二"}})
        items = list(adapter.list_items({}))
        ctx = DownloadContext(fetcher=fetcher, store=MagicMock(), checkpoint=None, validator=None)
        assert adapter.download_item(items[0], ctx).files_downloaded == 0

    def test_passes_matching_grade(self, tmp_path):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {"grades": {"初三"}})
        items = list(adapter.list_items({}))
        assert adapter.download_item(items[0], _make_ctx(tmp_path, fetcher)).files_downloaded == 1


class TestZgkaoSemesterWiring:
    def test_passes_exam_type_and_filename_to_resolver(self, tmp_path):
        fetcher = MockFetcher()
        stub = StubResolver("second")
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=stub)
        items = list(adapter.list_items({}))
        adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        assert stub.last_kwargs["exam_type"] == "二模"
        assert stub.last_kwargs["filename"] == "2026北京西城初三二模数学 有答案.pdf"
        assert stub.last_kwargs["key"] == "https://www.zgkao.com/shitiku/90304.html"
        assert stub.last_kwargs["group"] == ("初三", "二模", "2026")
        assert stub.last_kwargs["label"] == "初三-二模-2026"

    def test_uses_resolved_semester_for_directory(self, tmp_path):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(
            fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=StubResolver("first"),
        )
        items = list(adapter.list_items({}))
        adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        assert (tmp_path / "数学" / "初中" / "first" / "2026").is_dir()

    def test_skips_file_when_semester_unresolved(self, tmp_path):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(
            fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=StubResolver(None),
        )
        items = list(adapter.list_items({}))
        result = adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        assert result.files_downloaded == 0
        assert not (tmp_path / "数学").exists()

    def test_dry_run_does_not_ask_resolver(self, tmp_path):
        fetcher = MockFetcher()
        stub = StubResolver(None)
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=stub)
        items = list(adapter.list_items({}))
        result = adapter.download_item(items[0], _make_ctx(tmp_path, fetcher, dry_run=True))
        assert result.files_downloaded == 1
        assert stub.last_kwargs == {}


class TestZgkaoSecondaryIndex:
    """迁移自 tests/adapters/test_zgkao.py 的二级索引递归用例。"""

    def _fetcher(self):
        fetcher = MockFetcher()
        fetcher._routes.update({
            "https://www.zgkao.com/shitiku/89047.html": ("text", SECONDARY_A_INDEX_HTML),
            "https://www.zgkao.com/zk/202304/60347.html": ("text", SECONDARY_B_INDEX_HTML),
            "https://www.zgkao.com/zk/202305/61551.html": ("text", DOWNLOAD_PAGE_HTML),
            "https://cdn.zgkao.com/zixunzhan/202401/abc.pdf": ("bytes", make_pdf_bytes()),
            "https://cdn.zgkao.com/zixunzhan/202401/def.pdf": ("bytes", make_pdf_bytes()),
        })
        return fetcher

    def test_recurses_into_secondary_index_page(self, tmp_path):
        fetcher = self._fetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        items = list(adapter.list_items({}))
        result = adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        assert result.files_downloaded == 2

    def test_downloads_both_paper_and_answer(self, tmp_path):
        fetcher = self._fetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        items = list(adapter.list_items({}))
        adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))
        pdf_dir = tmp_path / "数学" / "初中" / "second" / "2023"
        names = {p.name for p in pdf_dir.glob("*.pdf")}
        assert "数学-初三(下)-202307-海淀-模拟二-试卷.pdf" in names
        assert "数学-初三(下)-202307-海淀-模拟二-答案.pdf" in names

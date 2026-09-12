"""ZgkaoAdapter 适配器接口测试。"""

import io
import json
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

# 详情页有两个 PDF，其中一个文件名显式写「无答案」——is_split 仍须成立（一个 paper 一个 answer）
NO_ANSWER_INDEX_HTML = """
<html><body>
<table>
  <tr><td colspan="3"><strong>2024-2025学年北京各区初三（上）期中试卷&答案汇总</strong></td></tr>
  <tr><td>区</td><td>科目</td><td>2024年</td></tr>
  <tr>
    <td>北京四中</td>
    <td>数学</td>
    <td><a href="https://www.zgkao.com/shitiku/76387.html">试卷</a></td>
  </tr>
</table>
</body></html>
"""

NO_ANSWER_DETAIL_HTML = """
<html><body>
<script id="__NUXT_DATA__" type="application/json">
["Reactive",
 "2024北京四中初三（上）期中数学   无答案.pdf",
 "https://cdn.zgkao.com/zixunzhan/202411/76387.pdf",
 "2024北京四中初三（上）期中数学答案.pdf",
 "https://cdn.zgkao.com/zixunzhan/202411/76387-answer.pdf"]
</script>
</body></html>
"""

# 复现「表头区县对整表相同」的撞车场景：两行同区县/年级/考试/年份，但详情页不同
COLLISION_INDEX_HTML = """
<html><body>
<table>
  <tr><td colspan="3"><strong>2024-2025学年北京各区初三（上）期中试卷&答案汇总</strong></td></tr>
  <tr><td>区</td><td>科目</td><td>2024年</td></tr>
  <tr><td>北京各区</td><td>数学</td>
    <td><a href="https://www.zgkao.com/shitiku/76320.html">试卷</a></td></tr>
  <tr><td>北京各区</td><td>数学</td>
    <td><a href="https://www.zgkao.com/shitiku/76319.html">试卷</a></td></tr>
</table>
</body></html>
"""

COLLISION_DETAIL_HTML = {
    "https://www.zgkao.com/shitiku/76320.html": """
<html><body>
<script id="__NUXT_DATA__" type="application/json">
["Reactive", "2024北京各区初三（上）期中数学试卷.pdf",
 "https://cdn.zgkao.com/zixunzhan/202401/76320.pdf"]
</script>
</body></html>
""",
    "https://www.zgkao.com/shitiku/76319.html": """
<html><body>
<script id="__NUXT_DATA__" type="application/json">
["Reactive", "2024北京各区初三（上）期中数学试卷.pdf",
 "https://cdn.zgkao.com/zixunzhan/202401/76319.pdf"]
</script>
</body></html>
""",
}


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


def build_secondary_fetcher() -> MockFetcher:
    """两级索引页 + 一个含「试卷/答案」两个 PDF 链接的下载页。"""
    fetcher = MockFetcher()
    fetcher._routes.update({
        "https://www.zgkao.com/shitiku/89047.html": ("text", SECONDARY_A_INDEX_HTML),
        "https://www.zgkao.com/zk/202304/60347.html": ("text", SECONDARY_B_INDEX_HTML),
        "https://www.zgkao.com/zk/202305/61551.html": ("text", DOWNLOAD_PAGE_HTML),
        "https://cdn.zgkao.com/zixunzhan/202401/abc.pdf": ("bytes", make_pdf_bytes()),
        "https://cdn.zgkao.com/zixunzhan/202401/def.pdf": ("bytes", make_pdf_bytes()),
    })
    return fetcher


def build_collision_fetcher() -> MockFetcher:
    """同表头区县（`北京各`）的两个详情页 —— 若 store 不防覆盖，只会剩 1 个文件。"""
    fetcher = MockFetcher()
    fetcher._routes.update({
        "https://www.zgkao.com/shitiku/89047.html": ("text", COLLISION_INDEX_HTML),
        **{url: ("text", html) for url, html in COLLISION_DETAIL_HTML.items()},
        "https://cdn.zgkao.com/zixunzhan/202401/76320.pdf": ("bytes", make_pdf_bytes()),
        "https://cdn.zgkao.com/zixunzhan/202401/76319.pdf": ("bytes", make_pdf_bytes()),
    })
    return fetcher


def build_no_answer_split_fetcher() -> MockFetcher:
    """一个详情页含两个 PDF：`…无答案.pdf` 与 `…答案.pdf`（前者必须落成 paper）。"""
    fetcher = MockFetcher()
    fetcher._routes.update({
        "https://www.zgkao.com/shitiku/89047.html": ("text", NO_ANSWER_INDEX_HTML),
        "https://www.zgkao.com/shitiku/76387.html": ("text", NO_ANSWER_DETAIL_HTML),
        "https://cdn.zgkao.com/zixunzhan/202411/76387.pdf": ("bytes", make_pdf_bytes()),
        "https://cdn.zgkao.com/zixunzhan/202411/76387-answer.pdf": ("bytes", make_pdf_bytes()),
    })
    return fetcher


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
        return build_secondary_fetcher()

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


class TestZgkaoSplitWithNoAnswerMarker:
    """双链接里一个文件名写「无答案」时，is_split 仍须成立并落成一 paper 一 answer。"""

    def test_no_answer_link_lands_as_paper(self, tmp_path):
        fetcher = build_no_answer_split_fetcher()
        adapter = ZgkaoAdapter(
            fetcher, "https://www.zgkao.com/shitiku/89047.html", {},
            semester_resolver=StubResolver("first"),
        )
        items = list(adapter.list_items({}))

        result = adapter.download_item(items[0], _make_ctx(tmp_path, fetcher))

        assert result.files_downloaded == 2
        pdf_dir = tmp_path / "数学" / "初中" / "first" / "2024"
        assert len(list(pdf_dir.glob("*.pdf"))) == 2
        meta = json.loads((pdf_dir / "meta.json").read_text(encoding="utf-8"))
        assert sorted(f["type"] for f in meta["files"]) == ["answer", "paper"]


class FilenameKeyedResolver:
    """按文件名返回学期的桩：构造「同一 item 内一个 link 可判、另一个判不出」。"""

    def __init__(self, semesters: dict):
        self._semesters = semesters
        self.unresolved = []

    def resolve(self, **kwargs):
        semester = self._semesters.get(kwargs.get("filename"))
        if semester is None:
            self.unresolved.append(kwargs.get("label", ""))
        return semester


class TestZgkaoCheckpointMarking:
    """I-1/I-4：checkpoint 的 PDF URL 标记与 item 级「全链接落地」门禁。

    恢复自已删除 test_zgkao.py 的 test_marks_both_pdfs_in_checkpoint 覆盖：
    此前 _make_ctx 一律传 checkpoint=None，标记行为从未断言。
    """

    DETAIL_URL = "https://www.zgkao.com/zk/202305/61551.html"
    PAPER_URL = "https://cdn.zgkao.com/zixunzhan/202401/abc.pdf"
    ANSWER_URL = "https://cdn.zgkao.com/zixunzhan/202401/def.pdf"

    def _ctx(self, tmp_path, fetcher):
        store = PdfStore(
            base_dir=str(tmp_path),
            entry_url="https://www.zgkao.com/shitiku/89047.html",
            crawl_time=datetime(2026, 7, 4, 10, 0, 0, tzinfo=timezone.utc),
        )
        checkpoint = Checkpoint(tmp_path / ".checkpoint.json")
        checkpoint.load()
        return DownloadContext(
            fetcher=fetcher, store=store, checkpoint=checkpoint, validator=PdfValidator(),
        ), checkpoint

    def test_partial_unresolved_does_not_mark_item(self, tmp_path):
        """一个 link 判不出学期时，item 不能被标已下载，否则该 PDF 再也补不上。"""
        fetcher = build_secondary_fetcher()
        resolver = FilenameKeyedResolver({
            "2023海淀初三二模数学试卷.pdf": "second",
            "2023海淀初三二模数学试卷答案.pdf": None,
        })
        adapter = ZgkaoAdapter(
            fetcher, "https://www.zgkao.com/shitiku/89047.html", {}, semester_resolver=resolver,
        )
        items = list(adapter.list_items({}))
        ctx, checkpoint = self._ctx(tmp_path, fetcher)

        result = adapter.download_item(items[0], ctx)

        assert result.files_downloaded == 1
        assert result.files_unresolved == 1
        assert checkpoint.is_downloaded(self.PAPER_URL)
        assert not checkpoint.is_downloaded(self.ANSWER_URL)
        assert not checkpoint.is_downloaded(self.DETAIL_URL)

    def test_all_resolved_marks_item(self, tmp_path):
        fetcher = build_secondary_fetcher()
        adapter = ZgkaoAdapter(
            fetcher, "https://www.zgkao.com/shitiku/89047.html", {},
            semester_resolver=StubResolver("second"),
        )
        items = list(adapter.list_items({}))
        ctx, checkpoint = self._ctx(tmp_path, fetcher)

        result = adapter.download_item(items[0], ctx)

        assert result.files_downloaded == 2
        assert result.files_unresolved == 0
        assert checkpoint.is_downloaded(self.PAPER_URL)
        assert checkpoint.is_downloaded(self.ANSWER_URL)
        assert checkpoint.is_downloaded(self.DETAIL_URL)


class RecordingStore:
    """只记录 save 调用参数的假 store。"""

    def __init__(self):
        self.calls: list[dict] = []

    def save(self, **kwargs) -> Path:
        self.calls.append(kwargs)
        return Path(kwargs["filename"])


class TestZgkaoOriginPropagation:
    """文件名撞车兜底：适配器要把详情页 URL 作为 origin 传给 store。"""

    DETAIL_URL = "https://www.zgkao.com/shitiku/90304.html"
    PDF_URL = "https://cdn.zgkao.com/zixunzhan/test.pdf"

    def test_passes_detail_url_as_origin(self):
        fetcher = MockFetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        store = RecordingStore()
        ctx = DownloadContext(fetcher=fetcher, store=store, checkpoint=None, validator=None)

        items = list(adapter.list_items({}))
        adapter.download_item(items[0], ctx)

        assert len(store.calls) == 1
        assert store.calls[0]["origin"] == self.DETAIL_URL
        assert store.calls[0]["source_url"] == self.PDF_URL

    def test_same_name_different_detail_pages_land_as_two_files(self, tmp_path, capsys):
        fetcher = build_collision_fetcher()
        adapter = ZgkaoAdapter(fetcher, "https://www.zgkao.com/shitiku/89047.html", {})
        items = list(adapter.list_items({}))
        assert len(items) == 2

        ctx = _make_ctx(tmp_path, fetcher)
        result = DownloadResult()
        for item in items:
            result += adapter.download_item(item, ctx)

        assert result.files_downloaded == 2
        pdf_dir = tmp_path / "数学" / "初中" / "first" / "2024"
        assert sorted(p.name for p in pdf_dir.glob("*.pdf")) == [
            "数学-初三(上)-202407-北京各-（上）期中-试卷-76319.pdf",
            "数学-初三(上)-202407-北京各-（上）期中-试卷.pdf",
        ]
        meta = json.loads((pdf_dir / "meta.json").read_text(encoding="utf-8"))
        assert len(meta["files"]) == 2
        assert "警告：文件名冲突" in capsys.readouterr().out

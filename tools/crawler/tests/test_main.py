"""main.py 的 TDD 测试。

集成各模块：robots 检查 → 抓取索引页 → 解析 → 抓详情页 → 下载 PDF → 校验 → 存储 → 断点。
使用 MockFetcher 避免真实网络请求。
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from main import Crawler, parse_args
from checkpoint import Checkpoint
from validator import PdfValidator
from storage import Storage
from pypdf import PdfWriter


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

# 二级索引页场景：一级索引页 2023 条目 → 二级索引页 → 下载页 → 2 个 PDF
INDEX_HTML_WITH_SECONDARY = """
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

SECONDARY_INDEX_HTML = """
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
    import io
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


class MockFetcher:
    def __init__(self):
        self.calls: list[str] = []
        self._routes = {
            "https://www.zgkao.com/robots.txt": ("text", "User-agent: *\nAllow: /\nDisallow: /api/\n"),
            "https://www.zgkao.com/shitiku/89047.html": ("text", INDEX_HTML),
            "https://www.zgkao.com/shitiku/90304.html": ("text", DETAIL_HTML),
            "https://cdn.zgkao.com/zixunzhan/test.pdf": ("bytes", make_pdf_bytes()),
        }

    def fetch_text(self, url: str) -> str:
        self.calls.append(url)
        kind, content = self._routes.get(url, ("text", ""))
        if kind != "text":
            raise RuntimeError(f"expected bytes for {url}")
        return content

    def fetch_bytes(self, url: str) -> bytes:
        self.calls.append(url)
        kind, content = self._routes.get(url, ("bytes", b""))
        if kind != "bytes":
            raise RuntimeError(f"expected text for {url}")
        return content

    def download_with_resume(self, url: str, dest_path: Path) -> int:
        content = self.fetch_bytes(url)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(content)
        return len(content)


class SecondaryMockFetcher(MockFetcher):
    def __init__(self):
        super().__init__()
        self._routes.update({
            "https://www.zgkao.com/shitiku/89047.html": ("text", INDEX_HTML_WITH_SECONDARY),
            "https://www.zgkao.com/zk/202304/60347.html": ("text", SECONDARY_INDEX_HTML),
            "https://www.zgkao.com/zk/202305/61551.html": ("text", DOWNLOAD_PAGE_HTML),
            "https://cdn.zgkao.com/zixunzhan/202401/abc.pdf": ("bytes", make_pdf_bytes()),
            "https://cdn.zgkao.com/zixunzhan/202401/def.pdf": ("bytes", make_pdf_bytes()),
        })


@pytest.fixture
def crawl_time():
    return datetime(2026, 7, 4, 10, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def storage(tmp_path, crawl_time):
    return Storage(
        base_dir=str(tmp_path / "data"),
        entry_url="https://www.zgkao.com/shitiku/89047.html",
        crawl_time=crawl_time,
    )


@pytest.fixture
def checkpoint(tmp_path):
    cp = Checkpoint(tmp_path / "data" / ".checkpoint.json")
    cp.load()
    return cp


@pytest.fixture
def crawler(tmp_path, storage, checkpoint):
    return Crawler(
        fetcher=MockFetcher(),
        storage=storage,
        checkpoint=checkpoint,
        validator=PdfValidator(),
        base_dir=str(tmp_path / "data"),
    )


@pytest.fixture
def secondary_crawler(tmp_path, crawl_time, checkpoint):
    storage = Storage(
        base_dir=str(tmp_path / "data"),
        entry_url="https://www.zgkao.com/shitiku/89047.html",
        crawl_time=crawl_time,
    )
    return Crawler(
        fetcher=SecondaryMockFetcher(),
        storage=storage,
        checkpoint=checkpoint,
        validator=PdfValidator(),
        base_dir=str(tmp_path / "data"),
    )


class TestCrawlerNormalRun:
    def test_downloads_and_saves_pdf(self, crawler, tmp_path):
        crawler.run("https://www.zgkao.com/shitiku/89047.html")
        pdf_path = tmp_path / "data" / "数学" / "初中" / "second" / "2026" / "数学-初三(下)-202607-西城-模拟二-试卷.pdf"
        assert pdf_path.is_file()

    def test_creates_meta_json(self, crawler, tmp_path):
        crawler.run("https://www.zgkao.com/shitiku/89047.html")
        meta_path = tmp_path / "data" / "数学" / "初中" / "second" / "2026" / "meta.json"
        assert meta_path.is_file()
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        assert len(meta["files"]) == 1

    def test_marks_url_in_checkpoint(self, crawler, checkpoint):
        crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert checkpoint.is_downloaded("https://cdn.zgkao.com/zixunzhan/test.pdf")


class TestDryRun:
    def test_does_not_save_files(self, crawler, tmp_path):
        crawler.dry_run = True
        crawler.run("https://www.zgkao.com/shitiku/89047.html")
        pdf_path = tmp_path / "data" / "数学" / "初中" / "second" / "2026" / "数学-初三(下)-202607-西城-模拟二-试卷.pdf"
        assert not pdf_path.exists()

    def test_does_not_mark_checkpoint(self, crawler, checkpoint):
        crawler.dry_run = True
        crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert not checkpoint.is_downloaded("https://cdn.zgkao.com/zixunzhan/test.pdf")


class TestCheckpointSkip:
    def test_skips_already_downloaded(self, crawler, checkpoint, tmp_path):
        checkpoint.mark_downloaded("https://cdn.zgkao.com/zixunzhan/test.pdf")
        crawler.run("https://www.zgkao.com/shitiku/89047.html")
        pdf_path = tmp_path / "data" / "数学" / "初中" / "second" / "2026" / "数学-初三(下)-202607-西城-模拟二-试卷.pdf"
        assert not pdf_path.exists()

    def test_force_redownloads(self, crawler, checkpoint, tmp_path):
        checkpoint.mark_downloaded("https://cdn.zgkao.com/zixunzhan/test.pdf")
        crawler.force = True
        crawler.run("https://www.zgkao.com/shitiku/89047.html")
        pdf_path = tmp_path / "data" / "数学" / "初中" / "second" / "2026" / "数学-初三(下)-202607-西城-模拟二-试卷.pdf"
        assert pdf_path.is_file()


class TestRobotsCheck:
    def test_allows_crawl_when_robots_permits(self, crawler):
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded >= 1

    def test_skips_when_robots_disallows(self, crawler, tmp_path):
        crawler._fetcher._routes["https://www.zgkao.com/robots.txt"] = (
            "text", "User-agent: *\nDisallow: /\n"
        )
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 0
        pdf_path = tmp_path / "data" / "数学"
        assert not pdf_path.exists()


class TestSecondaryIndexRecursion:
    def test_recurses_into_secondary_index_page(self, secondary_crawler):
        result = secondary_crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 2

    def test_downloads_both_paper_and_answer(self, secondary_crawler, tmp_path):
        secondary_crawler.run("https://www.zgkao.com/shitiku/89047.html")
        pdf_dir = tmp_path / "data" / "数学" / "初中" / "second" / "2023"
        pdfs = {p.name for p in pdf_dir.glob("*.pdf")}
        assert "数学-初三(下)-202307-海淀-模拟二-试卷.pdf" in pdfs
        assert "数学-初三(下)-202307-海淀-模拟二-答案.pdf" in pdfs

    def test_uses_subitem_metadata(self, secondary_crawler, tmp_path):
        secondary_crawler.run("https://www.zgkao.com/shitiku/89047.html")
        pdf_dir = tmp_path / "data" / "数学" / "初中" / "second" / "2023"
        assert pdf_dir.is_dir()

    def test_marks_both_pdfs_in_checkpoint(self, secondary_crawler, checkpoint):
        secondary_crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert checkpoint.is_downloaded("https://cdn.zgkao.com/zixunzhan/202401/abc.pdf")
        assert checkpoint.is_downloaded("https://cdn.zgkao.com/zixunzhan/202401/def.pdf")


class TestParseArgs:
    def test_url_required(self):
        with pytest.raises(SystemExit):
            parse_args([])

    def test_url_parsed(self):
        args = parse_args(["--url", "https://example.com"])
        assert args.url == "https://example.com"

    def test_output_default(self):
        args = parse_args(["--url", "https://example.com"])
        assert args.output == "./data"

    def test_dry_run_flag(self):
        args = parse_args(["--url", "https://example.com", "--dry-run"])
        assert args.dry_run is True

    def test_force_flag(self):
        args = parse_args(["--url", "https://example.com", "--force"])
        assert args.force is True

    def test_year_filter(self):
        args = parse_args(["--url", "https://example.com", "--year", "2024,2026"])
        assert args.year == "2024,2026"

    def test_subject_filter(self):
        args = parse_args(["--url", "https://example.com", "--subject", "数学"])
        assert args.subject == "数学"

    def test_district_filter(self):
        args = parse_args(["--url", "https://example.com", "--district", "海淀,西城"])
        assert args.district == "海淀,西城"

    def test_combined_filters(self):
        args = parse_args([
            "--url", "https://example.com",
            "--year", "2024",
            "--subject", "数学",
            "--district", "海淀"
        ])
        assert args.year == "2024"
        assert args.subject == "数学"
        assert args.district == "海淀"


class TestCrawlerFilter:
    def test_filters_by_year(self, crawler, tmp_path):
        crawler.filters = {"years": {"2025"}}
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 0
        assert result.papers_skipped == 0

    def test_passes_matching_year(self, crawler, tmp_path):
        crawler.filters = {"years": {"2026"}}
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 1

    def test_filters_by_subject(self, crawler, tmp_path):
        crawler.filters = {"subjects": {"语文"}}
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 0

    def test_passes_matching_subject(self, crawler, tmp_path):
        crawler.filters = {"subjects": {"数学"}}
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 1

    def test_filters_by_district(self, crawler, tmp_path):
        crawler.filters = {"districts": {"海淀"}}
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 0

    def test_passes_matching_district(self, crawler, tmp_path):
        crawler.filters = {"districts": {"西城"}}
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 1

    def test_combined_filters_all_match(self, crawler, tmp_path):
        crawler.filters = {
            "years": {"2026"},
            "subjects": {"数学"},
            "districts": {"西城"},
        }
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 1

    def test_combined_filters_one_mismatch(self, crawler, tmp_path):
        crawler.filters = {
            "years": {"2026"},
            "subjects": {"数学"},
            "districts": {"海淀"},
        }
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 0

    def test_no_filter_downloads_all(self, crawler, tmp_path):
        crawler.filters = {}
        result = crawler.run("https://www.zgkao.com/shitiku/89047.html")
        assert result.papers_downloaded == 1

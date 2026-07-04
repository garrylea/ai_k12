"""CLI 入口与爬虫编排。

集成 robots/fetcher/parser/classifier/storage/checkpoint/validator。
"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from checkpoint import Checkpoint
from classifier import Classification
from fetcher import Fetcher
from parser import IndexParser, DetailParser
from robots import RobotsChecker
from storage import Storage
from validator import PdfValidator


@dataclass
class CrawlResult:
    papers_downloaded: int = 0
    papers_skipped: int = 0
    papers_failed: int = 0


_EXAM_TYPE_SEMESTER = {
    "一模": "second",
    "二模": "second",
    "三模": "second",
    "期末": "second",
    "期中": "first",
    "月考": "first",
}


class Crawler:
    def __init__(self, fetcher, storage, checkpoint, validator, base_dir):
        self._fetcher = fetcher
        self._storage = storage
        self._checkpoint = checkpoint
        self._validator = validator
        self._base_dir = base_dir
        self.dry_run = False
        self.force = False
        self.filters: dict = {}
        self._visited_detail_urls: set[str] = set()

    def run(self, entry_url: str) -> CrawlResult:
        result = CrawlResult()

        robots_url = self._robots_url(entry_url)
        robots_content = self._fetcher.fetch_text(robots_url)
        checker = RobotsChecker(robots_content)
        if not checker.is_allowed(entry_url):
            return result

        index_html = self._fetcher.fetch_text(entry_url)
        items = IndexParser.parse(index_html)

        for item in items:
            self._process_item(item, result)

        return result

    def _process_item(self, item, result: CrawlResult) -> None:
        if item.detail_url in self._visited_detail_urls:
            return
        self._visited_detail_urls.add(item.detail_url)

        if not self._passes_filter(item):
            return

        detail_html = self._fetcher.fetch_text(item.detail_url)
        pdf_links = DetailParser.parse(detail_html)

        if pdf_links:
            self._download_pdfs(item, pdf_links, result)
            return

        sub_items = IndexParser.parse(detail_html)
        for sub_item in sub_items:
            self._process_item(sub_item, result)

    def _download_pdfs(self, item, pdf_links, result: CrawlResult) -> None:
        is_split = (
            len(pdf_links) == 2
            and any(l.has_answer for l in pdf_links)
            and any(not l.has_answer for l in pdf_links)
        )
        for link in pdf_links:
            if not self.force and self._checkpoint.is_downloaded(link.url):
                result.papers_skipped += 1
                continue

            if self.dry_run:
                result.papers_downloaded += 1
                continue

            content = self._fetcher.fetch_bytes(link.url)
            classification = self._build_classification(item, link, is_split=is_split)
            saved_path = self._storage.save_pdf(classification, content, link.url)

            validation = self._validator.validate(str(saved_path))
            if not validation.is_valid:
                Path(saved_path).unlink(missing_ok=True)
                result.papers_failed += 1
                continue

            self._checkpoint.mark_downloaded(link.url)
            result.papers_downloaded += 1

    @staticmethod
    def _build_classification(item, link, is_split: bool = False) -> Classification:
        semester = _EXAM_TYPE_SEMESTER.get(item.exam_type, "second")
        if is_split:
            file_type = "答案" if link.has_answer else "试卷"
        else:
            file_type = "试卷"
        return Classification(
            subject=item.subject,
            semester=semester,
            grade=item.grade,
            year=item.year,
            year_code=item.year + "07",
            district=item.district,
            exam_type=item.exam_type,
            file_type=file_type,
        )

    def _passes_filter(self, item) -> bool:
        if "years" in self.filters and item.year not in self.filters["years"]:
            return False
        if "subjects" in self.filters and item.subject not in self.filters["subjects"]:
            return False
        if "districts" in self.filters and item.district not in self.filters["districts"]:
            return False
        return True

    @staticmethod
    def _robots_url(entry_url: str) -> str:
        parts = urlsplit(entry_url)
        return f"{parts.scheme}://{parts.netloc}/robots.txt"


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="K12 试卷爬虫")
    parser.add_argument("--url", required=True, help="入口页 URL")
    parser.add_argument("--output", default="./data", help="输出目录")
    parser.add_argument("--subject", help="学科过滤（逗号分隔多个）")
    parser.add_argument("--year", help="年份过滤（逗号分隔多个）")
    parser.add_argument("--district", help="区县过滤（逗号分隔多个）")
    parser.add_argument("--force", action="store_true", help="强制重新下载")
    parser.add_argument("--dry-run", action="store_true", help="只检查不下载")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    crawl_time = datetime.now(timezone.utc)

    fetcher = Fetcher()
    storage = Storage(
        base_dir=args.output,
        entry_url=args.url,
        crawl_time=crawl_time,
    )
    checkpoint = Checkpoint(Path(args.output) / ".checkpoint.json")
    checkpoint.load()
    validator = PdfValidator()

    crawler = Crawler(
        fetcher=fetcher,
        storage=storage,
        checkpoint=checkpoint,
        validator=validator,
        base_dir=args.output,
    )
    crawler.dry_run = args.dry_run
    crawler.force = args.force

    if args.year:
        crawler.filters["years"] = set(args.year.split(","))
    if args.subject:
        crawler.filters["subjects"] = set(args.subject.split(","))
    if args.district:
        crawler.filters["districts"] = set(args.district.split(","))

    result = crawler.run(args.url)
    print(f"Downloaded: {result.papers_downloaded}, Skipped: {result.papers_skipped}, Failed: {result.papers_failed}")


if __name__ == "__main__":
    main()

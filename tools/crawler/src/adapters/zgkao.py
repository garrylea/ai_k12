"""zgkao.com 试卷站点适配器。"""

from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

from adapters.base import DownloadContext, DownloadResult, Item, SiteAdapter
from classifier import Classification, Classifier
from parser import DetailParser, IndexParser


_EXAM_TYPE_SEMESTER = {
    "一模": "second",
    "二模": "second",
    "三模": "second",
    "期末": "second",
    "期中": "first",
    "月考": "first",
}

_FILE_TYPE_MAP = {"试卷": "paper", "答案": "answer"}


class ZgkaoAdapter(SiteAdapter):
    name = "zgkao"

    def __init__(self, fetcher, entry_url: str, filters: dict):
        self._fetcher = fetcher
        self._entry_url = entry_url
        self._filters = filters
        self._visited: set[str] = set()

    @property
    def entry_url(self) -> str:
        return self._entry_url

    def robots_urls(self) -> list[str]:
        parts = urlsplit(self._entry_url)
        return [f"{parts.scheme}://{parts.netloc}/robots.txt"]

    def supported_filters(self) -> set[str]:
        return {"years", "subjects", "districts"}

    def required_args(self) -> set[str]:
        return {"url"}

    def list_items(self, filters: dict) -> Iterator[Item]:
        html = self._fetcher.fetch_text(self._entry_url)
        for paper in IndexParser.parse(html):
            yield Item(
                id=paper.detail_url,
                title=f"{paper.subject}-{paper.grade}-{paper.exam_type}-{paper.year}",
                tags={"subject": paper.subject, "district": paper.district, "year": paper.year},
                raw={"paper": paper},
            )

    def download_item(self, item: Item, ctx: DownloadContext) -> DownloadResult:
        result = DownloadResult()
        paper = item.raw["paper"]

        if item.id in self._visited:
            return result
        self._visited.add(item.id)

        if not self._passes_filter(paper):
            return result

        detail_html = ctx.fetcher.fetch_text(item.id)
        pdf_links = DetailParser.parse(detail_html)

        if pdf_links:
            is_split = (
                len(pdf_links) == 2
                and any(l.has_answer for l in pdf_links)
                and any(not l.has_answer for l in pdf_links)
            )
            for link in pdf_links:
                self._download_pdf(ctx, paper, link, is_split, result)
            if ctx.checkpoint and result.files_failed == 0 and result.files_downloaded > 0:
                ctx.checkpoint.mark_downloaded(item.id)
            return result

        sub_items = IndexParser.parse(detail_html)
        for sub in sub_items:
            sub_result = self.download_item(
                Item(
                    id=sub.detail_url,
                    title=sub.subject,
                    tags={},
                    raw={"paper": sub},
                ),
                ctx,
            )
            result += sub_result
        return result

    def _download_pdf(self, ctx, paper, link, is_split: bool, result: DownloadResult) -> None:
        if not ctx.force and ctx.checkpoint and ctx.checkpoint.is_downloaded(link.url):
            result.files_skipped += 1
            return

        if ctx.dry_run:
            result.files_downloaded += 1
            return

        content = ctx.fetcher.fetch_bytes(link.url)
        classification = self._build_classification(paper, link, is_split)
        dir_relpath = Classifier.storage_dir(classification, base_dir="")
        filename = Classifier.filename(classification)

        path = ctx.store.save(
            dir_relpath=dir_relpath,
            filename=filename,
            content=content,
            source_url=link.url,
            file_type=_FILE_TYPE_MAP.get(classification.file_type, "paper"),
            classification={
                "subject": classification.subject,
                "level": classification.level,
                "semester": classification.semester,
                "year": classification.year,
            },
        )

        if ctx.validator:
            validation = ctx.validator.validate(str(path))
            if not validation.is_valid:
                path.unlink(missing_ok=True)
                result.files_failed += 1
                return

        if ctx.checkpoint:
            ctx.checkpoint.mark_downloaded(link.url)
        result.files_downloaded += 1

    @staticmethod
    def _build_classification(item, link, is_split: bool) -> Classification:
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
        if "years" in self._filters and item.year not in self._filters["years"]:
            return False
        if "subjects" in self._filters and item.subject not in self._filters["subjects"]:
            return False
        if "districts" in self._filters and item.district not in self._filters["districts"]:
            return False
        return True

"""zgkao.com 试卷站点适配器。"""

import re
from typing import Iterator, Optional
from urllib.parse import unquote, urlsplit

from adapters.base import DownloadContext, DownloadResult, Item, SiteAdapter
from classifier import Classification, Classifier, SemesterResolver
from parser import DetailParser, IndexParser, UNKNOWN_LOCATION


_FILE_TYPE_MAP = {"试卷": "paper", "答案": "answer"}

_GRADE_IN_NAME = re.compile(r"(初一|初二|初三|高一|高二|高三)")

# 地点在年级之前：`2025北京人大附中朝阳学校初三（上）期中数学.pdf`
_LOCATION_IN_NAME = re.compile(
    r"([^\s\d（(]{2,20}?)(?:初一|初二|初三|高一|高二|高三|[七八九]年级|[七八九][上下])"
)


def location_from_text(text: str) -> str:
    """从 PDF 文件名 / 页面标题里猜区县或学校。

    返回区县（`海淀`）或学校（`北京四中`）；猜不出返回空串。`北京各区` 这类
    汇总占位词由 `_clean_region` 归空，`北京海淀` 也由它收成 `海淀`。
    """
    if not text:
        return ""
    match = _LOCATION_IN_NAME.search(unquote(text))
    if not match:
        return ""
    value = IndexParser._clean_region(match.group(1))
    # `2025北京北京中学…`：城市前缀撞上以「北京」开头的校名，去掉一个
    if value.startswith("北京北京"):
        return value[2:]
    return value


def grade_from_text(text: str) -> str:
    match = _GRADE_IN_NAME.search(unquote(text or ""))
    return match.group(1) if match else ""


class ZgkaoAdapter(SiteAdapter):
    name = "zgkao"

    def __init__(self, fetcher, entry_url: str, filters: dict, semester_resolver: Optional[SemesterResolver] = None):
        self._fetcher = fetcher
        self._entry_url = entry_url
        self._filters = filters
        self._semester_resolver = semester_resolver or SemesterResolver()
        self._visited: set[str] = set()

    @property
    def entry_url(self) -> str:
        return self._entry_url

    def robots_urls(self) -> list[str]:
        parts = urlsplit(self._entry_url)
        return [f"{parts.scheme}://{parts.netloc}/robots.txt"]

    def supported_filters(self) -> set[str]:
        return {"years", "subjects", "districts", "grades"}

    def required_args(self) -> set[str]:
        return {"url"}

    def list_items(self, filters: dict) -> Iterator[Item]:
        html = self._fetcher.fetch_text(self._entry_url)
        for paper in IndexParser.parse(html):
            yield Item(
                id=paper.detail_url,
                title=f"{paper.subject}-{paper.grade}-{paper.exam_type}-{paper.year}",
                tags={
                    "subject": paper.subject,
                    "district": paper.district,
                    "school": paper.school,
                    "year": paper.year,
                },
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
            page_title = DetailParser.page_title(detail_html)
            for link in pdf_links:
                self._download_pdf(ctx, paper, link, is_split, result, page_title)
            # dry-run 不落盘也不标 PDF URL，同样不能标 detail URL——否则后续真实爬取会把
            # 整个 item 判成已下载而跳过（PDF URL 未标记，参见 _download_pdf 的 dry-run 分支）
            # files_unresolved > 0 表示 item 内有 link 因学期未决被跳过，此时也不能标 item：
            # 否则 core/crawler.py 后续整项跳过，那个 PDF 再也补不上（--force 之外）
            if (
                ctx.checkpoint
                and not ctx.dry_run
                and result.files_failed == 0
                and result.files_unresolved == 0
                and result.files_downloaded > 0
            ):
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

    def _download_pdf(self, ctx, paper, link, is_split: bool, result: DownloadResult, page_title: str = "") -> None:
        if not ctx.force and ctx.checkpoint and ctx.checkpoint.is_downloaded(link.url):
            result.files_skipped += 1
            return

        if ctx.dry_run:
            result.files_downloaded += 1
            return

        semester = self._semester_resolver.resolve(
            exam_type=paper.exam_type,
            filename=link.filename,
            key=paper.detail_url,
            group=(paper.grade, paper.exam_type, paper.year),
            label=f"{paper.grade}-{paper.exam_type}-{paper.year}",
        )
        if semester is None:
            print(f"警告：无法判断学期，已跳过 {paper.grade}-{paper.exam_type}-{paper.year}（{link.filename}）")
            result.files_unresolved += 1
            return

        content = ctx.fetcher.fetch_bytes(link.url)
        district, school = self._resolve_location(paper, link, page_title)
        classification = self._build_classification(paper, link, is_split, semester, district, school)
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
            origin=paper.detail_url,
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
    def _build_classification(item, link, is_split: bool, semester: str,
                              district: str, school: str) -> Classification:
        if is_split:
            file_type = "答案" if link.has_answer else "试卷"
        else:
            file_type = "试卷"
        return Classification(
            subject=item.subject,
            semester=semester,
            # 文件名里的年级是逐份试卷的证据，汇总表的年级是整表标签。
            # 两者冲突时以文件名优先（真实案例：初三汇总表里混进了初二卷）。
            grade=grade_from_text(link.filename) or item.grade,
            year=item.year,
            year_code=item.year + "07",
            district=district,
            exam_type=item.exam_type,
            file_type=file_type,
            school=school,
        )

    @staticmethod
    def _resolve_location(paper, link, page_title: str) -> tuple[str, str]:
        """确定文件名里的地点：表内「区域/学校」→ PDF 原名 → 详情页标题 → 待确认。

        表内的区域/学校是站点自己维护的结构化字段，最可信；拿不到才去猜文件名和标题。
        三级都猜不出时写「待确认」并告警 —— 不静默跳过（不丢文件），也不写「北京各」
        这种看起来像地名的碎片。
        """
        if paper.district or paper.school:
            return paper.district, paper.school

        guess = location_from_text(link.filename) or location_from_text(page_title)
        if guess:
            return guess, ""

        print(f"警告：无法确定区县/学校，暂记「{UNKNOWN_LOCATION}」：{link.filename}（{paper.detail_url}）")
        return UNKNOWN_LOCATION, ""

    def _passes_filter(self, item) -> bool:
        if "years" in self._filters and item.year not in self._filters["years"]:
            return False
        if "subjects" in self._filters and item.subject not in self._filters["subjects"]:
            return False
        if "districts" in self._filters:
            wanted = self._filters["districts"]
            # --district 海淀 也要命中「海淀·一零一中学」这种带学校的条目
            if not ({item.district, item.school} & set(wanted)):
                return False
        if "grades" in self._filters and item.grade not in self._filters["grades"]:
            return False
        return True

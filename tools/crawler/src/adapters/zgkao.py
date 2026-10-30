"""zgkao.com 试卷站点适配器。"""

import re
from pathlib import Path
from typing import Iterator, Optional
from urllib.parse import unquote, urlsplit

from adapters.base import DownloadContext, DownloadResult, Item, SiteAdapter
from classifier import Classification, Classifier, SemesterResolver
from parser import DetailParser, IndexParser, UNKNOWN_LOCATION


_FILE_TYPE_MAP = {"试卷": "paper", "答案": "answer"}


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{int(size)} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def _absolute(store, rel_path: str) -> str:
    base = Path(getattr(store, "base_dir", Path(".")))
    return str((base / rel_path).resolve())


def _saved_location(store, saved_path) -> tuple[Path, str]:
    """把 store 返回的路径还原成（绝对路径, 相对输出目录的路径）。

    撞名改名时实际文件名与分类名不同，必须以 store 真正写下的 path 为准。
    """
    base = Path(getattr(store, "base_dir", Path("."))).resolve()
    actual = Path(saved_path).resolve()
    try:
        return actual, str(actual.relative_to(base))
    except ValueError:
        return actual, str(actual)

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
            result.items_duplicate += 1
            return result
        self._visited.add(item.id)

        if not self._passes_filter(paper):
            return result

        try:
            detail_html = ctx.fetcher.fetch_text(item.id)
        except Exception as exc:  # 网络/解析异常都要变成可读日志，不能静默中断这一项
            print(f"抓取失败：{item.id} — {exc}")
            result.files_failed += 1
            return result

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
                and result.file_locations
            ):
                known = ctx.checkpoint.files_for_item(item.id)
                ctx.checkpoint.mark_item(
                    item.id, list(dict.fromkeys([*known, *result.file_locations])),
                )
            return result

        sub_items = IndexParser.parse(detail_html)
        if not sub_items:
            print(f"跳过：详情页没有可下载文件（{item.id}）")
            # 这一行换不来任何文件，只进 Total；单独一桶记账，免得汇总行的下载/跳过对不上账
            result.items_without_file += 1
            return result
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

        district, school = self._resolve_location(paper, link, page_title)
        classification = self._build_classification(paper, link, is_split, semester, district, school)
        dir_relpath = Classifier.storage_dir(classification, base_dir="")
        filename = Classifier.filename(classification)
        expected_rel = str(dir_relpath / filename)

        if not ctx.force and ctx.checkpoint and ctx.checkpoint.is_downloaded(link.url):
            existing = (
                ctx.checkpoint.path_for_file(link.url)
                or self._path_from_meta(ctx, dir_relpath, link.url)
                or expected_rel
            )
            print(f"已存在：{_absolute(ctx.store, existing)}（跳过，--force 可重下）")
            if ctx.checkpoint:
                # 旧 checkpoint 只有 URL，这里顺手补上「PDF URL → 文件路径」映射
                ctx.checkpoint.mark_downloaded(link.url, existing)
            result.file_locations.append(existing)
            result.files_skipped += 1
            return

        try:
            content = ctx.fetcher.fetch_bytes(link.url)
        except Exception as exc:
            print(f"下载失败：{link.url} — {exc}")
            result.files_failed += 1
            return

        try:
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
        except OSError as exc:
            print(f"保存失败：{_absolute(ctx.store, expected_rel)} — {exc}")
            result.files_failed += 1
            return

        actual_path, actual_rel = _saved_location(ctx.store, path)

        if ctx.validator:
            try:
                validation = ctx.validator.validate(str(path))
            except Exception as exc:
                path.unlink(missing_ok=True)
                print(f"校验失败：{actual_path} — {exc}")
                result.files_failed += 1
                return
            if not validation.is_valid:
                path.unlink(missing_ok=True)
                print(f"校验失败：{actual_path}（不是有效 PDF，已删除）")
                result.files_failed += 1
                return

        if ctx.checkpoint:
            ctx.checkpoint.mark_downloaded(link.url, actual_rel)
        print(f"已下载：{actual_path}（{_human_size(len(content))}）")
        result.file_locations.append(actual_rel)
        result.files_downloaded += 1

    @staticmethod
    def _path_from_meta(ctx, dir_relpath, source_url: str) -> Optional[str]:
        """从同目录 meta.json 反查该来源之前落成的文件名（旧 checkpoint 回填用）。"""
        try:
            meta = ctx.store.read_meta(dir_relpath)
        except Exception:
            return None
        for record in (meta or {}).get("files", []):
            if record.get("source_url") == source_url and record.get("filename"):
                return str(dir_relpath / record["filename"])
        return None

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

    def accepts(self, item: Item) -> bool:
        return self._passes_filter(item.raw["paper"])

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

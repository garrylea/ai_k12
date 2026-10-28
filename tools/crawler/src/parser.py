"""页面解析模块。

IndexParser：从索引页表格提取试卷条目。
DetailParser：从详情页 __NUXT_DATA__ 提取 PDF 下载链接。
"""

import json
import re
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit

from bs4 import BeautifulSoup


_GRADE_PATTERN = re.compile(r"(\d{4})(.+?)(初一|初二|初三|高一|高二|高三)(.+?)试卷")

# 表头里这些不是区县：「北京各区」汇总表只是说“全北京各区的卷子都在这里”。
# 早期版本把它们当区县写进文件名，于是出现了 `…-北京各-…`（`北京各区` 去掉尾「区」剩下的碎片）。
_GENERIC_DISTRICTS = frozenset({
    "北京各", "北京各区", "各区", "全市", "北京", "全国", "未知", "待确认",
})

# 北京区县（「区」已在清洗时去掉）。表头有 `海淀区…` 与 `北京海淀区…` 两种写法，
# 统一收成 `海淀`，否则精确匹配的 `--district 海淀` 会漏掉带城市前缀的那批。
BEIJING_DISTRICTS = frozenset({
    "东城", "西城", "朝阳", "海淀", "丰台", "石景山", "门头沟", "房山",
    "通州", "顺义", "昌平", "大兴", "怀柔", "平谷", "密云", "延庆", "燕山",
})

# 表格里表示“这一格没有内容”的占位符（`&mdash;` 由 BeautifulSoup 解码成 —）
_EMPTY_MARKERS = frozenset({"", "—", "——", "-", "--", "/", "无", "暂无", "&mdash;"})

UNKNOWN_LOCATION = "待确认"


@dataclass
class PaperItem:
    subject: str
    district: str
    grade: str
    exam_type: str
    year: str
    detail_url: str
    school: str = ""


@dataclass
class PdfLink:
    filename: str
    url: str
    has_answer: bool


class IndexParser:
    @staticmethod
    def parse(html: str) -> list[PaperItem]:
        soup = BeautifulSoup(html, "html.parser")
        items: list[PaperItem] = []
        for table in soup.find_all("table"):
            items.extend(IndexParser._parse_table(table))
        return items

    @staticmethod
    def _parse_table(table) -> list[PaperItem]:
        grid = IndexParser._expand_table(table)
        if not grid:
            return []

        header: dict | None = None
        column_header_seen = False
        subject_col = region_col = school_col = None
        year_cols: dict[int, str] = {}
        items: list[PaperItem] = []

        for cells in grid:
            texts = [text for text, _ in cells]

            # 标题行（colspan 铺满整行，展开后每格文字相同）
            if header is None:
                title = IndexParser._spanning_text(cells)
                info = IndexParser._parse_header(title)
                if info:
                    header = info
                continue

            if IndexParser._spanning_text(cells):
                continue

            if not column_header_seen:
                if not any(t == "科目" or t.startswith("科目") for t in texts):
                    continue
                for i, t in enumerate(texts):
                    if t == "科目" or t.startswith("科目"):
                        subject_col = i
                    elif t in {"区域", "区", "区县"}:
                        region_col = i
                    elif t == "学校":
                        school_col = i
                    else:
                        year = IndexParser._extract_year(t)
                        if year:
                            year_cols[i] = year
                column_header_seen = subject_col is not None
                continue

            if subject_col is None or subject_col >= len(cells):
                continue
            subject = texts[subject_col]
            # 合并单元格造成的空科目行没有可归属的试卷，直接跳过
            if not subject or subject == "科目":
                continue

            region = IndexParser._cell_value(cells, region_col, IndexParser._clean_region)
            school = IndexParser._cell_value(cells, school_col, IndexParser._clean_school)
            if not region:
                region = header["district"]

            for col, year in year_cols.items():
                if col >= len(cells):
                    continue
                link = cells[col][1].find("a") if cells[col][1] is not None else None
                if not link or not link.get("href"):
                    continue
                items.append(PaperItem(
                    subject=subject,
                    district=region,
                    grade=header["grade"],
                    exam_type=header["exam_type"],
                    year=year,
                    detail_url=link["href"],
                    school=school,
                ))
        return items

    @staticmethod
    def _expand_table(table) -> list[list[tuple[str, object]]]:
        """把 rowspan/colspan 展开成规整网格，返回 [[(文字, 单元格元素), ...], ...]。

        汇总表用 rowspan 合并「区域」「学校」，后续行只写「科目 + 各年份链接」。
        不展开的话列号会整体左移，区县/学校这两列就永远读不到（`北京各` 的根因）。
        """
        grid: list[list[tuple[str, object]]] = []
        carry: dict[int, tuple[int, str, object]] = {}

        for row in table.find_all("tr"):
            cells = row.find_all(["td", "th"])
            expanded: list[tuple[str, object]] = []
            col = 0
            idx = 0

            while idx < len(cells) or col in carry:
                if col in carry:
                    remaining, text, node = carry[col]
                    expanded.append((text, node))
                    if remaining <= 1:
                        del carry[col]
                    else:
                        carry[col] = (remaining - 1, text, node)
                    col += 1
                    continue

                if idx >= len(cells):
                    break

                node = cells[idx]
                idx += 1
                text = re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()
                rowspan = IndexParser._span_attr(node, "rowspan")
                colspan = IndexParser._span_attr(node, "colspan")
                for _ in range(colspan):
                    expanded.append((text, node))
                    if rowspan > 1:
                        carry[col] = (rowspan - 1, text, node)
                    col += 1

            if expanded:
                grid.append(expanded)
        return grid

    @staticmethod
    def _span_attr(node, name: str) -> int:
        try:
            return max(1, int(node.get(name, 1)))
        except (TypeError, ValueError):
            return 1

    @staticmethod
    def _spanning_text(cells: list[tuple[str, object]]) -> str:
        """整行只有一个不同的文字 → 这是 colspan 铺满的标题/说明行，不是数据行。"""
        texts = {text for text, _ in cells}
        return texts.pop() if len(texts) == 1 else ""

    @staticmethod
    def _cell_value(cells, index, cleaner) -> str:
        if index is None or index >= len(cells):
            return ""
        return cleaner(cells[index][0])

    @staticmethod
    def _parse_header(text: str) -> dict | None:
        match = _GRADE_PATTERN.search(text)
        if not match:
            return None
        return {
            "district": IndexParser._extract_district(text, match),
            "grade": match.group(3),
            "exam_type": match.group(4),
        }

    @staticmethod
    def _extract_district(text: str, match) -> str:
        """从表头取区县。

        表头有两种形态：
        - 区县在前：`海淀区2024-2025学年初三（上）期末...` → 学年之后为空，回退到年份前缀
        - 学年在前：`2025-2026学年海淀区初二期末...` → 区县在「学年」之后
        最后统一去掉末尾「区」，让 `海淀区` 与 `海淀` 两种站点写法落到同一个值
        （`--district` 与文件名都是精确匹配，不统一会漏匹配）。
        """
        mid = match.group(2).strip()
        if "学年" not in mid:
            return IndexParser._clean_region(mid)
        district = re.split(r"学年度?", mid, 1)[1].strip()
        if not district:
            district = text[: match.start(1)].strip()
        district = re.sub(r"^[（(][^）)]*[）)]", "", district).strip()
        return IndexParser._clean_region(district)

    @staticmethod
    def _clean_region(text: str) -> str:
        """规范化区县：去掉年份/「年」/城市前缀与末尾「区」，汇总表占位词归空。

        `2024年大兴区初三一模` 曾解析出 `年大兴`、`北京各区` 解析出 `北京各`、
        `北京海淀区` 产出 `北京海淀`，三者都会直接写进文件名，这里统一清掉。
        拿不到真区县时返回空串（由调用方回退），绝不返回「北京各」这种看似地名的碎片。
        """
        if not text:
            return ""
        value = re.sub(r"\s+", "", text)
        value = re.sub(r"^\d{4}(?:-\d{4})?学年?", "", value)
        value = re.sub(r"^\d{4}年?", "", value)
        value = re.sub(r"^年", "", value)
        if value.endswith("区"):
            value = value[:-1]
        # `北京海淀` → `海淀`；但 `北京四中` 里的「北京」是校名的一部分，不能动
        if value.startswith("北京") and value[2:] in BEIJING_DISTRICTS:
            value = value[2:]
        if value in _GENERIC_DISTRICTS:
            return ""
        return value

    @staticmethod
    def _clean_school(text: str) -> str:
        if not text:
            return ""
        value = re.sub(r"\s+", "", text)
        if value in _EMPTY_MARKERS:
            return ""
        return value

    @staticmethod
    def _extract_year(text: str) -> str | None:
        match = re.match(r"(\d{4})年?", text)
        return match.group(1) if match else None


class DetailParser:
    @staticmethod
    def page_title(html: str) -> str:
        """详情页标题（`<h1>` 优先，退回 `<title>`）。

        汇总表拿不到区县/学校时用作最后一级回退：站点标题通常写成
        「2025北京人大附中朝阳学校初三（上）期中数学试卷在哪下载」。
        """
        soup = BeautifulSoup(html, "html.parser")
        for tag in ("h1", "title"):
            node = soup.find(tag)
            if node and node.get_text(strip=True):
                return node.get_text(" ", strip=True)
        return ""

    @staticmethod
    def parse(html: str) -> list[PdfLink]:
        soup = BeautifulSoup(html, "html.parser")
        links = DetailParser._extract_from_nuxt(soup)
        if not links:
            links = DetailParser._extract_from_download_anchors(soup)
        return links

    @staticmethod
    def _extract_from_nuxt(soup) -> list[PdfLink]:
        script = soup.find("script", id="__NUXT_DATA__")
        if not script:
            return []
        try:
            data = json.loads(script.string or "")
        except (json.JSONDecodeError, ValueError):
            return []

        all_strings = DetailParser._collect_strings(data)
        filenames = [s for s in all_strings if s.endswith(".pdf") and not s.startswith("http")]
        urls = [s for s in all_strings if s.startswith("http") and ".pdf" in s.lower()]

        links: list[PdfLink] = []
        seen = set()
        for i, url in enumerate(urls):
            if url in seen:
                continue
            seen.add(url)
            if i < len(filenames):
                filename = filenames[i]
            else:
                filename = unquote(urlsplit(url).path).rsplit("/", 1)[-1]
            links.append(PdfLink(
                filename=filename,
                url=url,
                has_answer=DetailParser._has_answer(filename),
            ))
        return links

    @staticmethod
    def _extract_from_download_anchors(soup) -> list[PdfLink]:
        links: list[PdfLink] = []
        seen = set()
        for anchor in soup.find_all("a", class_="download"):
            href = anchor.get("href")
            if not href or ".pdf" not in href.lower():
                continue
            if href in seen:
                continue
            seen.add(href)

            anchor_text = anchor.get_text(strip=True)
            filename = DetailParser._filename_from_anchor_text(anchor_text)
            if not filename:
                filename = unquote(urlsplit(href).path).rsplit("/", 1)[-1]
                filename = re.sub(r"^\d{13}", "", filename)

            links.append(PdfLink(
                filename=filename,
                url=href,
                has_answer=DetailParser._has_answer(filename + anchor_text),
            ))
        return links

    @staticmethod
    def _filename_from_anchor_text(text: str) -> str | None:
        if not text:
            return None
        for sep in ("：", ":", " "):
            if sep in text:
                _, _, rest = text.partition(sep)
                rest = rest.strip()
                if rest and DetailParser._looks_like_paper_name(rest):
                    return DetailParser._ensure_pdf_extension(rest)
        if DetailParser._looks_like_paper_name(text):
            return DetailParser._ensure_pdf_extension(text)
        return None

    @staticmethod
    def _looks_like_paper_name(text: str) -> bool:
        return bool(text) and not text.startswith("http") and len(text) >= 2

    @staticmethod
    def _ensure_pdf_extension(name: str) -> str:
        return name if name.lower().endswith(".pdf") else name + ".pdf"

    @staticmethod
    def _has_answer(filename: str) -> bool:
        """文件名是否指向答案（而非试卷）。

        负向标记必须先判：`无答案`/`无解析` 里含正向子串「答案」/「解析」，
        若先走正向匹配会被子串误判成「有答案」。
        """
        negative_markers = ("无答案", "无解析", "无参考答案", "不含答案")
        if any(m in filename for m in negative_markers):
            return False
        markers = ("有答案", "答案", "教师版", "解析", "答案解析")
        return any(m in filename for m in markers)

    @staticmethod
    def _collect_strings(obj) -> list[str]:
        results: list[str] = []
        if isinstance(obj, str):
            results.append(obj)
        elif isinstance(obj, list):
            for item in obj:
                results.extend(DetailParser._collect_strings(item))
        elif isinstance(obj, dict):
            for value in obj.values():
                results.extend(DetailParser._collect_strings(value))
        return results

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


@dataclass
class PaperItem:
    subject: str
    district: str
    grade: str
    exam_type: str
    year: str
    detail_url: str


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
        rows = table.find_all("tr")
        if not rows:
            return []

        district_info = None
        years: list[str] = []
        subject_col_idx = 0
        header_cell_count = 0
        items: list[PaperItem] = []

        for row in rows:
            cells = row.find_all(["td", "th"])
            if not cells:
                continue

            header_cell = row.find("td", attrs={"colspan": True})
            if header_cell and district_info is None:
                info = IndexParser._parse_header(header_cell.get_text(strip=True))
                if info:
                    district_info = info
                continue

            if district_info and not years:
                row_text = [c.get_text(strip=True) for c in cells]
                for i, t in enumerate(row_text):
                    if t == "科目":
                        subject_col_idx = i
                        break
                potential_years = [IndexParser._extract_year(t) for t in row_text]
                if any(potential_years):
                    years = [y or "" for y in potential_years]
                    header_cell_count = len(cells)
                    continue

            if district_info and years:
                row_offset = header_cell_count - len(cells)
                if row_offset < 0:
                    row_offset = 0
                current_subject_idx = subject_col_idx - row_offset
                if current_subject_idx < 0 or current_subject_idx >= len(cells):
                    continue
                subject_cell = cells[current_subject_idx].get_text(strip=True)
                if not subject_cell or subject_cell == "科目":
                    continue
                for i, cell in enumerate(cells):
                    if i == current_subject_idx:
                        continue
                    year_idx = i + row_offset
                    if year_idx >= len(years):
                        break
                    year = years[year_idx]
                    if not year:
                        continue
                    link = cell.find("a")
                    if not link or not link.get("href"):
                        continue
                    items.append(PaperItem(
                        subject=subject_cell,
                        district=district_info["district"],
                        grade=district_info["grade"],
                        exam_type=district_info["exam_type"],
                        year=year,
                        detail_url=link["href"],
                    ))
        return items

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
            return IndexParser._strip_trailing_qu(mid)
        district = re.split(r"学年度?", mid, 1)[1].strip()
        if not district:
            district = text[: match.start(1)].strip()
        district = re.sub(r"^[（(][^）)]*[）)]", "", district).strip()
        return IndexParser._strip_trailing_qu(district)

    @staticmethod
    def _strip_trailing_qu(district: str) -> str:
        return district[:-1] if district.endswith("区") else district

    @staticmethod
    def _extract_year(text: str) -> str | None:
        match = re.match(r"(\d{4})年?", text)
        return match.group(1) if match else None


class DetailParser:
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

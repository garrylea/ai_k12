"""TOC 页码锚定：卡片 md 页码 -> 所属章（db_loader 挂卡时的确定性章归属判定）。

背景（2026-09-02）：LLM 标签会出现错章（复习题 27 标成 26 章）、各章「小结」
「数学活动」同名歧义、「复习题 N」非 TOC 标签三类问题。本模块提供页码锚定：
每张卡的章归属由「textbook_page（md 页码）-> TOC 章区间」独立确定，
不依赖 LLM 标签质量，也不依赖前后页的抽取状态（重处理任意页不影响结构）。

章边界（md 空间）两级推导：
1. 首选综述卡锚定：每章「第N章 …」标签卡片的最小 md 页 = 章头页
   （md 空间直接锚定，无偏移误差；LLM 偶发错章综述标签出现在后部，取 min 天然免疫）。
2. 兜底：该章首节 printed_page + offset - 章头余量。偏移 = 同标签卡片最小 md 页
   - printed_page 的众数（容忍个别节首卡偏晚的 ±1 噪声）。

另维护节时间线（全部 TOC 锚点按 printed + offset 折算 md 排序），供错章卡
按页定位「活跃节」标签（db_loader 规则 A 兜底用）。

自包含实现（不 import db_loader，避免循环依赖）。
"""

import re
from collections import Counter

# 章头余量（仅兜底路径用）：章首节 printed_page 前最多 3 页仍归该章
_CHAPTER_HEAD_MARGIN = 3

_CHAPTER_RE = re.compile(r"^第([一二三四五六七八九十百零两]+)章\b")
_SECTION_RE = re.compile(r"^(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?\s*(.*)$")
_REVIEW_RE = re.compile(r"^复习题\s*(\d{1,3})\s*$")
# content 中的复习题标题行（## 复习题 27 / 复习题27）
_REVIEW_HEADING_RE = re.compile(r"^\s*#{0,3}\s*复习题\s*(\d{1,3})\s*$", re.MULTILINE)

_CN_DIGITS = {"零": 0, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _chinese_to_int(s: str) -> int | None:
    """中文数字 -> int（覆盖 一~一百 级别的章号，够教材用）。"""
    if not s:
        return None
    if s.isdigit():
        return int(s)
    total, num = 0, 0
    for ch in s:
        if ch in _CN_DIGITS:
            if num:
                return None  # 非法连续数字（中文数字不连写）
            num = _CN_DIGITS[ch]
        elif ch == "十":
            total += (num or 1) * 10
            num = 0
        elif ch == "百":
            total += (num or 1) * 100
            num = 0
        elif ch == "零":
            continue
        else:
            return None
    return total + num


def parse_chapter_from_label(label: str | None) -> int | None:
    """从 lesson_id 标签解析章号：第N章 / N.M[.K] / 复习题N；其余返回 None。"""
    if not label:
        return None
    m = _CHAPTER_RE.match(label.strip())
    if m:
        return _chinese_to_int(m.group(1))
    m = _SECTION_RE.match(label.strip())
    if m:
        return int(m.group(1))
    m = _REVIEW_RE.match(label.strip())
    if m:
        return int(m.group(1))
    return None


def is_review_label(label: str | None) -> bool:
    """标签是否为「复习题 N」形态（db_loader 规则 C 归一用）。"""
    return bool(label) and bool(_REVIEW_RE.match(label.strip()))


def parse_chapter_from_content(content: str | None) -> int | None:
    """从卡片 content 的标题行解析「复习题 N」（整行标题，防正文误命中）。"""
    if not content:
        return None
    m = _REVIEW_HEADING_RE.search(content)
    return int(m.group(1)) if m else None


def md_page_of(textbook_page) -> int | None:
    """'P92' -> 92；非法输入返回 None。"""
    if not textbook_page:
        return None
    m = re.match(r"^P(\d+)$", str(textbook_page).strip())
    return int(m.group(1)) if m else None


def _flatten_toc_anchors(toc: dict) -> dict[str, int]:
    """展平 TOC：label -> printed_page（sections + subsections + supplements）。"""
    out: dict[str, int] = {}
    for ch in toc.get("chapters", []):
        for sec in ch.get("sections", []):
            pp = sec.get("printed_page")
            if pp is not None and sec.get("label"):
                out[sec["label"]] = pp
            for sub in sec.get("subsections", []):
                pp = sub.get("printed_page")
                if pp is not None and sub.get("label"):
                    out[sub["label"]] = pp
        for sup in ch.get("supplements", []):
            pp = sup.get("printed_page")
            if pp is not None and sup.get("label"):
                out[sup["label"]] = pp
    return out


class LessonAnchor:
    """TOC 页码锚定。build() 返回 None 表示锚定不可用（调用方退化为现状）。"""

    def __init__(self, offset: int, chapter_starts_md: dict[int, int],
                 timeline: list[tuple[int, str]]):
        self.offset = offset
        self._chapter_starts = chapter_starts_md  # chapter -> md 起点
        # 时间线：[(start_md, label)] 按 start_md 升序（含章头锚点）
        self._timeline = sorted(timeline)

    @classmethod
    def build(cls, toc: dict, cards: list[dict]) -> "LessonAnchor | None":
        anchors = _flatten_toc_anchors(toc)
        if not anchors:
            return None
        toc_chapters = [ch for ch in toc.get("chapters", [])
                        if ch.get("number") is not None]
        # 每标签取最小 md 页 -> 偏移样本众数
        min_md_by_label: dict[str, int] = {}
        for c in cards:
            lid = c.get("lesson_id")
            if lid not in anchors:
                continue
            page = md_page_of(c.get("textbook_page"))
            if page is None:
                continue
            if lid not in min_md_by_label or page < min_md_by_label[lid]:
                min_md_by_label[lid] = page
        # 综述卡锚定：每章「第N章」标签卡的最小 md 页（章头页）
        toc_chapter_nos = {ch["number"] for ch in toc_chapters}
        overview_min_md: dict[int, int] = {}
        for c in cards:
            lid = c.get("lesson_id")
            if not lid:
                continue
            m = _CHAPTER_RE.match(lid.strip())
            if not m:
                continue
            ch_no = _chinese_to_int(m.group(1))
            if ch_no is None or ch_no not in toc_chapter_nos:
                continue
            page = md_page_of(c.get("textbook_page"))
            if page is None:
                continue
            if ch_no not in overview_min_md or page < overview_min_md[ch_no]:
                overview_min_md[ch_no] = page
        if not min_md_by_label and not overview_min_md:
            return None
        offset = 0
        if min_md_by_label:
            samples = Counter(min_md - anchors[lid]
                              for lid, min_md in min_md_by_label.items())
            offset = samples.most_common(1)[0][0]
        # 章起点：综述卡优先（章头页本身），缺则首节 printed + offset - 余量
        starts: dict[int, int] = {}
        timeline: list[tuple[int, str]] = []
        for ch in toc_chapters:
            no = ch["number"]
            pages = [pp for sec in ch.get("sections", [])
                     if (pp := sec.get("printed_page")) is not None]
            pages += [pp for sup in ch.get("supplements", [])
                      if (pp := sup.get("printed_page")) is not None]
            if no in overview_min_md:
                starts[no] = overview_min_md[no]
            elif pages:
                starts[no] = max(1, min(pages) + offset - _CHAPTER_HEAD_MARGIN)
            if ch.get("label"):
                timeline.append((starts[no], ch["label"]))
            for sec in ch.get("sections", []):
                pp = sec.get("printed_page")
                if pp is not None and sec.get("label"):
                    timeline.append((pp + offset, sec["label"]))
                for sub in sec.get("subsections", []):
                    pp = sub.get("printed_page")
                    if pp is not None and sub.get("label"):
                        timeline.append((pp + offset, sub["label"]))
            for sup in ch.get("supplements", []):
                pp = sup.get("printed_page")
                if pp is not None and sup.get("label"):
                    timeline.append((pp + offset, sup["label"]))
        if not starts:
            return None
        return cls(offset, starts, timeline)

    def chapter_of(self, md_page: int) -> int | None:
        """md 页所属章；前置页/越界返回 None（最后一章尾部页仍归该章）。"""
        best = None
        for no, start in self._chapter_starts.items():
            if start <= md_page and (best is None or start > self._chapter_starts[best]):
                best = no
        return best

    def active_label_at(self, md_page: int) -> str | None:
        """页码处的活跃节标签（时间线上最后一个 start_md <= page 的锚点）。

        供错章卡兜底定位：返回的 label 是 TOC 锚点标签（节 label 或补充名如
        「小结」），调用方按 (页所在章, label 名) 在 DB lesson 里解析。
        """
        best = None
        for start_md, label in self._timeline:
            if start_md <= md_page:
                best = label
            else:
                break
        return best

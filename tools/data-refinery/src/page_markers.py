"""试卷/答案页脚页码标记清洗（确定性，不调 LLM）。

MinerU 对一份 PDF 输出**一个 md**，md 里没有页边界；这里清洗的是「整份 md 中
形如页码标记的行」，不是按页结构识别的「每页页眉/页脚」。真正的按页识别依赖
MinerU JSON 的 ``page_idx`` / ``bbox``（另案）。

口径见 ``docs/superpowers/specs/2026-11-17-data-refinery-page-marker-cleanup-design.md``。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# 页码数字：半角 + 全角（OCR 常见）
_PAGE_NUM = r"[0-9０-９]{1,3}"

# 强锚点：第 N 页 + 共 M 页 / 第 N 页/M 页
PAGE_MARKER_RE = re.compile(
    rf"第\s*{_PAGE_NUM}\s*页\s*"
    rf"(?:[（(]\s*共\s*{_PAGE_NUM}\s*页\s*[）)]"
    rf"|[／/]\s*共?\s*{_PAGE_NUM}\s*页"
    rf"|[，,]?\s*共\s*{_PAGE_NUM}\s*页)"
)

# 弱锚点：整行只剩页码碎片（昌平一中「共6页」实测）
BARE_PAGE_RE = re.compile(rf"^第\s*{_PAGE_NUM}\s*页\s*$")
BARE_TOTAL_RE = re.compile(rf"^共\s*{_PAGE_NUM}\s*页\s*$")

_HEADING_PREFIX_RE = re.compile(r"^#{1,6}\s*")
_SENTENCE_END_RE = re.compile(r"[。！？；]")
_SCORE_PAREN_RE = re.compile(
    r"[（(]\s*(?:共)?\s*[0-9０-９]+(?:\.[0-9０-９]+)?\s*分"
)
_HEADING_NUM_RE = re.compile(
    r"^(?:\d{1,2}[.．、]|[（(][一二三四五六七八九十]+[）)])"
)
_DATE_ONLY_RE = re.compile(r"^20\d{2}(?:[.．-]\d{1,2}|年\d{1,2}月)?$")

# 运行页眉：只认已确认的形态，未识别形态不整行删
_RUNNING_HEAD_RE = re.compile(
    r"^(?:"
    r"(?:[一二三四五六七八九]年级\s*[（(]?\s*"
    r"(?:语文|数学|英语|物理|化学|道法|政治|历史|地理|生物)?\s*[）)]?)"
    r"|(?:[^。！？；]{0,50}?(?:试卷|试题)[^。！？；]{0,30}?"
    r"(?:答案及评分(?:参考|标准)|参考答案|评分参考))"
    r"|(?:[^。！？；]{0,30}?(?:答案及评分(?:参考|标准)|参考答案|评分参考))"
    r")(?:\s*20\d{2}(?:[.．-]\d{1,2}|年\d{1,2}月)?)?$"
)

# 只有「试卷/试题」、没有「答案及评分」的页眉（如「北京市西城区九年级模拟测试试卷」）
# 排除「本试卷」「该试卷」以及「请参考试卷」「见试卷」「阅读试卷」这类正文指令
_PAPER_HEAD_RE = re.compile(
    r"^(?!本|该)[^。！？；请见阅读参看]{0,40}(?:试卷|试题)$"
)

# 只有学科/年级的页眉（如「语文」「九年级数学」「数学 试卷」）
_SUBJECT_GRADE_RE = re.compile(
    r"^(?:[一二三四五六七八九]年级\s*)?"
    r"(?:语文|数学|英语|物理|化学|道法|政治|历史|地理|生物)\s*"
    r"(?:试卷|试题)?$"
)

# 行内运行页眉：紧贴页码标记左侧，只认已确认形态
_INLINE_HEAD_RE = re.compile(
    r"(?:"
    r"(?:[一二三四五六七八九]年级\s*[（(]\s*"
    r"(?:语文|数学|英语|物理|化学|道法|政治|历史|地理|生物)\s*[）)])"
    r"|(?:[^。！？；）)]{0,30}?(?:试卷|试题)[^。！？；）)]{0,30}?"
    r"(?:答案及评分(?:参考|标准)|参考答案|评分参考))"
    r"|(?:[^。！？；）)]{0,20}?(?:答案及评分(?:参考|标准)|参考答案|评分参考))"
    r")(?:\s*20\d{2}(?:[.．-]\d{1,2}|年\d{1,2}月)?)?\s*$"
)

# 行尾续行合并时，下一行若是这些结构行则不合并
_STRUCTURAL_NEXT_RE = re.compile(
    r"^(?:"
    r"\s*#{1,6}\s*"
    r"|\s*!\["
    r"|\s*<"
    r"|\s*[-*+]\s+"
    r"|\s*\d{1,3}\s*$"
    r"|\s*\d{1,2}[.．、]"
    r"|\s*[（(][一二三四五六七八九十]+[）)]"
    r"|\s*[一二三四五六七八九十]+、"
    r"|\s*第[一二三四五六七八九十\d]+部分"
    r"|\s*(?:答案|思路|解析|题型|答案示例(?:\s*\d+)?)\s*[:：]"
    r"|\s*-{3,}\s*$"
    r"|\s*第\s*\d+\s*页"
    r"|\s*```"
    r"|\s*~~~"
    r"|\s*\$\$"
    r"|\s*>"
    r"|\s*\|"
    r")"
)

_WS = " \t　\r"


@dataclass(frozen=True)
class PageMarkerHit:
    """一次页码标记命中。

    ``removed=False`` 表示命中在表格/标签/围栏内，按口径不删，留给人工复核。
    """

    line_no: int
    raw: str
    whole_line: bool
    removed: bool = True


def is_page_marker_line(line: str) -> bool:
    """答案区结构过滤用：该行是否是页码标记（不负责删除）。

    表格行不算：即使单元格里出现页码，也不能把整行 table 当结构行跳过。
    """
    s = line.strip(_WS)
    if not s or s.startswith(("```", "~~~")):
        return False
    if "<table" in s.lower() or "</table>" in s.lower():
        return False
    return bool(
        BARE_PAGE_RE.match(s)
        or BARE_TOTAL_RE.match(s)
        or PAGE_MARKER_RE.search(s)
    )


def strip_page_markers(text: str) -> tuple[str, list[PageMarkerHit]]:
    """删除试卷/答案里的页码标记。

    - 强锚点：``第N页 + 共M页/斜杠``；弱锚点：整行 ``第N页`` / ``共N页``；
    - 整行删除 / 行内删除两种模式；
    - 围栏、HTML 标签、表格内跳过（``removed=False``）；
    - 行内删除且标记在行尾时，按需合并下一行，避免一句话被拆成两段；
    - 幂等；返回清洗后文本与命中列表。
    """
    lines = text.split("\n")
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in lines]
    out: list[str] = []
    hits: list[PageMarkerHit] = []
    in_fence = False
    in_table = False
    i = 0

    while i < len(lines):
        line = lines[i]
        fence_line = line.lstrip().startswith(("```", "~~~"))

        if in_fence:
            if PAGE_MARKER_RE.search(line):
                hits.append(PageMarkerHit(i + 1, line, False, removed=False))
            out.append(line)
            if fence_line:
                in_fence = False
            i += 1
            continue

        if fence_line:
            out.append(line)
            in_fence = True
            i += 1
            continue

        stripped = line.strip(_WS)

        # 弱锚点：整行页码碎片
        if BARE_PAGE_RE.match(stripped) or BARE_TOTAL_RE.match(stripped):
            if _is_protected(line, 0, in_table):
                hits.append(PageMarkerHit(i + 1, line, False, removed=False))
                out.append(line)
            else:
                hits.append(PageMarkerHit(i + 1, line, True, removed=True))
            in_table = _next_table_state(line, in_table)
            i += 1
            continue

        if not PAGE_MARKER_RE.search(line):
            out.append(line)
            in_table = _next_table_state(line, in_table)
            i += 1
            continue

        # 整行纯页眉/页脚：只在所有标记都不被保护时尝试，避免把表格单元格一起删掉
        markers = list(PAGE_MARKER_RE.finditer(line))
        if markers and not any(
            _is_protected(line, m.start(), in_table) for m in markers
        ):
            residual = _residual(line)
            if _is_whole_head(residual):
                hits.append(PageMarkerHit(i + 1, line, True, removed=True))
                in_table = _next_table_state(line, in_table)
                i += 1
                continue

        cleaned, removed, manual, at_end = _strip_inline(line, in_table)
        if removed:
            cleaned = cleaned.rstrip(_WS)
        for frag in removed:
            hits.append(PageMarkerHit(i + 1, frag, False, removed=True))
        for frag in manual:
            hits.append(PageMarkerHit(i + 1, frag, False, removed=False))

        if at_end and cleaned.strip(_WS) and not _SENTENCE_END_RE.search(cleaned):
            j = i + 1
            # 页脚后常跟一个空行（MinerU 分段），续行要跨过空行再判断
            while j < len(lines) and not lines[j].strip(_WS):
                j += 1
            if j < len(lines) and _can_join(lines[j]):
                cleaned = cleaned.rstrip(_WS) + lines[j].lstrip(_WS)
                i = j  # 合并后跳过被吞掉的下一行

        out.append(cleaned)
        in_table = _next_table_state(line, in_table)
        i += 1

    return "\n".join(out), hits


def _residual(line: str) -> str:
    """删掉页码标记后的剩余内容（去掉 Markdown 标题前缀）。"""
    residual = PAGE_MARKER_RE.sub("", line).strip(_WS)
    residual = _HEADING_PREFIX_RE.sub("", residual).strip(_WS)
    return residual


def _is_whole_head(residual: str) -> bool:
    """剩余内容是否是一个纯页眉/页脚（可以整行删）。"""
    if len(residual) > 50:
        return False
    if _SENTENCE_END_RE.search(residual):
        return False
    if _HEADING_NUM_RE.match(residual):
        return False
    if _SCORE_PAREN_RE.search(residual):
        return False
    if not residual:
        return True
    if _RUNNING_HEAD_RE.match(residual):
        return True
    if _PAPER_HEAD_RE.match(residual):
        return True
    if _SUBJECT_GRADE_RE.match(residual):
        return True
    if _DATE_ONLY_RE.match(residual):
        return True
    return False


def _is_protected(line: str, pos: int, in_table: bool) -> bool:
    """标记位置是否在表格/HTML 标签/图片语法内部。"""
    before = line[:pos]
    lower = before.lower()
    last_open = lower.rfind("<table")
    last_close = lower.rfind("</table")
    if last_open > last_close:
        return True
    if in_table and last_close == -1:
        return True

    if line.rfind("<", 0, pos) > line.rfind(">", 0, pos):
        return True

    img = line.rfind("![", 0, pos)
    if img != -1:
        close = line.find(")", img)
        if close == -1 or pos < close:
            return True

    return False


def _next_table_state(line: str, in_table: bool) -> bool:
    """根据本行 ``<table>`` / ``</table>`` 更新跨行表格状态。"""
    lower = line.lower()
    opens = lower.count("<table")
    closes = lower.count("</table")
    if opens > closes:
        return True
    if closes > opens:
        return False
    return in_table


def _strip_inline(
    line: str, in_table: bool
) -> tuple[str, list[str], list[str], bool]:
    """删除一行内所有未被保护的页码标记。

    Returns:
        (cleaned_line, removed_fragments, manual_fragments, at_line_end)
    """
    removed: list[str] = []
    manual: list[str] = []
    at_end = False
    pos = 0
    is_heading = line.lstrip().startswith("#")
    original = line

    while True:
        m = PAGE_MARKER_RE.search(line, pos)
        if m is None:
            break

        if _is_protected(line, m.start(), in_table):
            manual.append(original)
            pos = m.end()
            continue

        marker_at_end = not line[m.end():].strip(_WS)
        start = m.start()
        prefix = line[:start]
        # 标题行（## 27．评分参考 …）只删页码，不把标题词当运行页眉删掉
        head = None if is_heading else _INLINE_HEAD_RE.search(prefix)
        if head is not None:
            start = head.start()
            while start < m.start() and line[start] in "，,、：:；;）)（( \t　":
                start += 1

        removed.append(line[start:m.end()])
        line = line[:start] + line[m.end():]
        at_end = at_end or marker_at_end
        pos = start

    return line, removed, manual, at_end


def _can_join(next_line: str) -> bool:
    """行尾页码删除后，下一行是否可以作为同一句的续行合并。"""
    s = next_line.strip(_WS)
    if not s:
        return False
    if BARE_PAGE_RE.match(s) or BARE_TOTAL_RE.match(s) or PAGE_MARKER_RE.search(s):
        return False
    if _STRUCTURAL_NEXT_RE.match(s):
        return False
    return True

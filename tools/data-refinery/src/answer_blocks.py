"""答案区块模型与版式解析。

本模块不依赖 question_splitter 或学科策略，负责把答案区拆成表格、裸选择、
统一编号块和未知块。HTML 表格解析从 question_splitter 迁入这里，旧导入名由
question_splitter 继续兼容导出。
"""

import html
import re
from dataclasses import dataclass

from page_markers import is_page_marker_line


@dataclass(frozen=True)
class AnswerQuestion:
    no: int
    group_id: str | None


@dataclass(frozen=True)
class AnswerLine:
    line_no: int
    text: str


@dataclass(frozen=True)
class AnswerBlock:
    kind: str
    lines: tuple[AnswerLine, ...]
    group_id: str | None


@dataclass(frozen=True)
class AnswerFragment:
    question_no: int
    text: str
    block_kind: str
    line_start: int
    line_end: int
    approach: str = ""
    explanation: str = ""


@dataclass(frozen=True)
class AnswerIssue:
    code: str
    severity: str
    message: str
    question_no: int | None
    line_start: int | None
    line_end: int | None
    excerpt: str


@dataclass
class AnswerParseResult:
    fragments: list[AnswerFragment]
    blocks: list[AnswerBlock]
    issues: list[AnswerIssue]


_GROUP_HEADER_RE = re.compile(
    r"^#{0,6}\s*([一二三四五六七八九十]+)、\s*(.*)$"
)
_INLINE_NUMBER_RE = re.compile(r"(?<!\d)\d{1,2}\s*[.．]")
_COMPACT_CHOICE_TAIL_RE = re.compile(
    r"(?<![A-Za-z])(?P<answers>[A-Da-d]{2,}(?:[ \t]+[A-Da-d]{1,4})*)[ \t]*$"
)
_SECTION_HEADER_RE = re.compile(
    r"^#{0,6}\s*[（(]\s*[一二三四五六七八九十]+\s*[）)]"
)
_ANSWER_HEADING_PREFIX_RE = re.compile(r"^#{0,6}\s*")


def is_answer_structure_line(line: str) -> bool:
    """答案区里不属于答案正文的页码/小节标题。"""
    return is_page_marker_line(line) or bool(_SECTION_HEADER_RE.match(line))


def _split_group_header_with_tail(line: str) -> tuple[str | None, str]:
    match = _GROUP_HEADER_RE.match(line)
    if match is None:
        return None, line.strip()
    body = match.group(2).strip()
    inline = _INLINE_NUMBER_RE.search(body)
    if inline:
        tail = body[inline.start():].strip()
    else:
        compact = _COMPACT_CHOICE_TAIL_RE.search(body)
        tail = compact.group("answers").strip() if compact else ""
    return match.group(1), tail


def _strip_answer_heading(line: str) -> tuple[bool, str]:
    stripped = _ANSWER_HEADING_PREFIX_RE.sub("", line).strip()
    for marker in ("参考答案", "评分参考", "答案及评分"):
        position = stripped.find(marker)
        if position < 0:
            continue
        tail = stripped[position + len(marker):].strip()
        tail = re.sub(r"^及评分(?:标准)?\s*", "", tail).strip()
        return True, tail
    return False, line


def prepare_answer_lines(
    lines: list[str], first_line_no: int
) -> list[AnswerLine]:
    """清洗答案结构行，保留原行号、大题标题和正文空行。"""
    out: list[AnswerLine] = []
    for offset, raw in enumerate(lines):
        text = raw.rstrip()
        is_heading, tail = _strip_answer_heading(text)
        if is_heading and not tail:
            continue
        if is_heading:
            text = tail
        if is_answer_structure_line(text):
            continue
        out.append(AnswerLine(line_no=first_line_no + offset, text=text))
    return out


def _line_start_question_no(text: str, numbers) -> int | None:
    """该行以哪个题号开头（没有则 None）。允许 OCR 把题号拆成 `1 3 .`。

    块边界只看行首：答案正文行里的 `7.5cm`、`15cm` 不是新题号，
    若用 ``re.search`` 全行匹配，会把一行答案拆成多个块、后半截整段丢
    （2026-11-27 北京各 85487 第 12 题）。行首裸题号（`9 $x\neq5$ ...`，
    顺义 2025 期末）也认，但后面紧跟数字或「分」的不算——那是空格拆开的
    公式数字（`2 2 x`）或分值说明（`1 分`）。
    """
    stripped = text.lstrip()
    for number in numbers:
        digits = r"\s*".join(str(number))
        if re.match(rf"{digits}\s*[.．]", stripped):
            return number
        # 裸题号必须连写（`9 $x$`），不能是「2 2」这种空格拆开的公式数字；
        # 后面紧跟数字或「分」的也不算（`1 分` 是分值）。
        bare = re.match(rf"{number}\s+(\S)", stripped)
        if bare and not bare.group(1).isdigit() and bare.group(1) != "分":
            return number
    return None


def _line_starts_question(text: str, numbers) -> bool:
    return _line_start_question_no(text, numbers) is not None


def split_answer_blocks(
    lines: list[AnswerLine],
    questions: list[AnswerQuestion],
) -> list[AnswerBlock]:
    """把答案区切成互不重叠的版式块。"""
    expected = {question.no for question in questions}
    working_lines = list(lines)
    blocks: list[AnswerBlock] = []
    group_id: str | None = None
    last_no = 0          # 已切出的最后一个题号：答案按题号递增，小数字不另起块
    index = 0

    def _next_question_no(text: str) -> int | None:
        num = _line_start_question_no(text, expected)
        if num is None:
            return None
        # `11.4 - 3 = 8.4` 行首是 `11.` 但紧跟数字，可能是小数/算式；只有
        # 题号比已切出的更大时才另起块。`1. 答案：B`（点后是空格）这类明确
        # 分隔符不受限，仍允许重开一套答案块（第二套会被当重复忽略）。
        ambiguous = re.match(r"^\d{1,2}[.．]\d", text.lstrip())
        if ambiguous and num <= last_no:
            return None
        return num

    while index < len(working_lines):
        line = working_lines[index]
        text = line.text.strip()
        if not text:
            index += 1
            continue

        header_group, tail = _split_group_header_with_tail(text)
        if header_group is not None:
            group_id = header_group
            if not tail:
                index += 1
                continue
            line = AnswerLine(line_no=line.line_no, text=tail)
            working_lines[index] = line
            text = tail

        if text.startswith("<table"):
            end = index
            while end < len(working_lines) and "</table>" not in working_lines[end].text:
                end += 1
            if end < len(working_lines):
                end += 1
            blocks.append(AnswerBlock(
                "table", tuple(working_lines[index:end]), group_id
            ))
            index = end
            continue

        if re.fullmatch(r"[A-Da-d](?:\s*[A-Da-d])+", text):
            blocks.append(AnswerBlock("compact_choice", (line,), group_id))
            index += 1
            continue

        number = _next_question_no(text)
        if number is not None:
            last_no = number
            end = index + 1
            while end < len(working_lines):
                next_text = working_lines[end].text.strip()
                if _split_group_header_with_tail(next_text)[0] is not None:
                    break
                if next_text.startswith("<table") or re.fullmatch(
                    r"[A-Da-d](?:\s*[A-Da-d])+", next_text
                ):
                    break
                # 只认题号比当前块更大的行。答案正文里的 `11.4 - 3 = 8.4`
                # 行首是 `11.`，若也当新题会把第 25 题的答案从中间截断
                # （2026-11-27 北京各 85434 第 25 题）。
                if _next_question_no(next_text) is not None:
                    break
                end += 1
            blocks.append(AnswerBlock(
                "numbered", tuple(working_lines[index:end]), group_id
            ))
            index = end
            continue

        end = index + 1
        while end < len(working_lines):
            next_text = working_lines[end].text.strip()
            if _split_group_header_with_tail(next_text)[0] is not None:
                break
            if next_text.startswith("<table") or re.fullmatch(
                r"[A-Da-d](?:\s*[A-Da-d])+", next_text
            ):
                break
            if _next_question_no(next_text) is not None:
                break
            end += 1
        blocks.append(AnswerBlock(
            "unknown", tuple(working_lines[index:end]), group_id
        ))
        index = end

    return blocks


_MATH_OPERATORS = set("=+-×÷")
_STRONG_PREFIXES = set("；。.$")
_ANSWER_MARK_RE = re.compile(
    r'^\s*(?:答案(?:示例|要点)?\s*\d*\s*[:：]\s*|(?:解|证明|原式|原不等式组)[：:]\s*)'
)
_TRAILING_SCORE_RE = re.compile(r'[（(]\s*(?:共)?\s*\d+(?:\.\d+)?\s*分\s*[）)]\s*$')
_SCORE_BOUNDARY_RE = re.compile(
    r"(?P<score>\d{1,2}\s*分)\s*(?=(?:解|证明|答案)[：:]\s*[（(]\s*1\s*[）)])"
)


def _strip_answer_prefix(text: str) -> str:
    text = _ANSWER_MARK_RE.sub("", text.strip(), count=1)
    while True:
        stripped = _TRAILING_SCORE_RE.sub("", text).rstrip()
        if stripped == text:
            return text
        text = stripped


def _line_start_offsets(text: str) -> set[int]:
    starts = {0}
    starts.update(i + 1 for i, char in enumerate(text) if char == "\n")
    return starts


def _is_inside_math(text: str, pos: int) -> bool:
    """pos 是否落在 `$...$` / `$$...$$` 公式内（按出现顺序成对切换）。

    区分两种「看起来像题号」的裸数字：
    - `9 $x \\neq 5$ 10 ...`：9/10 在公式外，仍是题号（顺义 2025 期末）；
    - `$15cm$`、`$$... + 2 4 0 x ...$$`：数字在公式内，不是题号。
    """
    inside = False
    index = 0
    while index < pos:
        if text[index] != "$":
            index += 1
            continue
        if text.startswith("$$", index):
            inside = not inside
            index += 2
            continue
        inside = not inside
        index += 1
    return inside


def _is_compact_previous(previous_answer: str | None) -> bool:
    """上一段答案是否短且无中文——用来确认「连续内联答案」里的下一个题号。"""
    return bool(
        previous_answer
        and len(previous_answer) <= 40
        and not re.search(r"[\u3400-\u9fff。；;]", previous_answer)
    )


def _marker_allowed(
    text: str,
    match: re.Match[str],
    line_starts: set[int],
    previous_answer: str | None = None,
) -> bool:
    before = text[:match.start()].rstrip()
    previous = before[-1:] if before else ""
    raw_previous = text[match.start() - 1:match.start()] if match.start() else ""
    at_line_start = match.start() in line_starts or not before
    has_dot = match.group("dot") is not None
    dot_end = match.end("dot") if has_dot else match.end()
    followed_by_digit = has_dot and text[dot_end:dot_end + 1].isdigit()

    if raw_previous and (
        (raw_previous.isalnum() and raw_previous != "分")
        or raw_previous in _MATH_OPERATORS
    ):
        return False
    if has_dot and followed_by_digit and not at_line_start:
        return (
            previous in _STRONG_PREFIXES
            or previous == "分"
            or _is_compact_previous(previous_answer)
        )
    if not has_dot:
        # 不带点的题号必须是连写数字；「2 4」这种数字拆开的形式只在带点
        # （`1 3 .`）时成立，否则和公式里的空格数字分不开。
        if re.search(r"\s", match.group("number")):
            return False
        after = text[match.end():]
        next_char = after.lstrip()[:1]
        # 「1 分」是分值说明、`2 2 x` 是空格拆开的公式数字，都不是题号。
        if next_char.isdigit() or next_char == "分":
            return False
        if at_line_start:
            return True
        # 行中间的裸题号只有落在公式外才可能成立；公式里的
        # `\therefore x^{2} - 4 x = 4`（4）、`+ 2 4 0 x`（24）、`$15cm$`（15）
        # 一律不是题号（2026-11-27 北京各 85487）。
        if _is_inside_math(text, match.start()):
            return False
        # 公式外的裸题号也得能确认是「新答案的起点」，否则教学答案里的
        # `(2) 28;`、`（2 分）` 会被当成第 28/2 题，把上一题拦腰截断。
        followed_by_math = after.lstrip().startswith("$")
        return (
            followed_by_math
            or previous in _STRONG_PREFIXES
            or previous == "分"
        )
    return (
        at_line_start
        or raw_previous.isspace()
        or previous in _STRONG_PREFIXES
        or previous == "分"
        or previous in ")]）】"
    )


def _find_marker(
    text: str,
    start: int,
    expected_no: int,
    line_starts: set[int],
    previous_marker_end: int | None = None,
) -> re.Match[str] | None:
    digits = r"\s*".join(str(expected_no))
    pattern = re.compile(
        # `(?!\d)` 不能省：否则「…+ 240x …」里的 24 会被当成第 24 题的题号，
        # 把第 23 题答案从数字中间切开（2026-11-27 北京各 85487 实测）。
        rf"(?<!\d)(?P<number>{digits})(?!\d)\s*(?P<dot>[.．])?"
        rf"(?:\s*(?=\S)|(?=\n|$))"
    )
    for match in pattern.finditer(text, start):
        previous_answer = (
            text[previous_marker_end:match.start()].strip()
            if previous_marker_end is not None
            else None
        )
        if _marker_allowed(text, match, line_starts, previous_answer):
            return match
    return None


def parse_numbered_block(
    block: AnswerBlock,
    expected_numbers: list[int],
) -> tuple[list[AnswerFragment], list[AnswerIssue]]:
    """按期望题号切分统一编号块，答案正文保留原始换行。"""
    text = "\n".join(line.text for line in block.lines)
    starts = _line_start_offsets(text)
    markers: list[tuple[int, re.Match[str]]] = []
    cursor = 0
    previous_marker_end: int | None = None
    for number in expected_numbers:
        marker = _find_marker(
            text, cursor, number, starts, previous_marker_end,
        )
        if marker is None:
            continue
        markers.append((number, marker))
        cursor = marker.end()
        previous_marker_end = marker.end()

    fragments: list[AnswerFragment] = []
    issues: list[AnswerIssue] = []
    for index, (number, marker) in enumerate(markers):
        has_next = index + 1 < len(markers)
        end = markers[index + 1][1].start() if has_next else len(text)
        if has_next and end > 0 and text[end - 1] == "$":
            end -= 1
        answer = text[marker.end():end].strip()
        current_formula = marker.start() > 0 and text[marker.start() - 1] == "$"
        if current_formula and answer.endswith("$"):
            answer = answer[:-1].rstrip()
        answer = _strip_answer_prefix(answer)
        line_start = block.lines[0].line_no
        line_end = block.lines[-1].line_no
        answer_parts = [(number, answer)]
        next_expected = next(
            (candidate for candidate in expected_numbers if candidate > number),
            None,
        )
        if (
            has_next and markers[index + 1][0] == number + 2
        ) or (
            not has_next and next_expected == number + 1
        ):
            boundary = _SCORE_BOUNDARY_RE.search(answer)
            if boundary is not None:
                head = answer[:boundary.end()].strip()
                tail = _strip_answer_prefix(answer[boundary.end():])
                answer_parts = [(number, head), (number + 1, tail)]
        for answer_no, answer_text in answer_parts:
            if not answer_text:
                issues.append(AnswerIssue(
                    code="answer_empty",
                    severity="error",
                    message=f"第 {answer_no} 题答案为空",
                    question_no=answer_no,
                    line_start=line_start,
                    line_end=line_end,
                    excerpt="",
                ))
                continue
            fragments.append(AnswerFragment(
                question_no=answer_no,
                text=answer_text,
                block_kind="numbered",
                line_start=line_start,
                line_end=line_end,
            ))
    return fragments, issues


def parse_compact_choice(
    block: AnswerBlock,
    expected_numbers: list[int],
) -> tuple[list[AnswerFragment], list[AnswerIssue]]:
    """按题号顺序展开裸字母答案串，数量不等时整串不写。"""
    text = " ".join(line.text for line in block.lines).strip()
    letters = re.findall(r"[A-Da-d]", text)
    line_start = block.lines[0].line_no
    line_end = block.lines[-1].line_no
    if len(letters) < 2 or len(letters) != len(expected_numbers):
        issue = AnswerIssue(
            code="compact_choice_count_mismatch",
            severity="error",
            message=(
                f"裸答案 {len(letters)} 项，期望题号 {len(expected_numbers)} 项，"
                "整串不展开"
            ),
            question_no=None,
            line_start=line_start,
            line_end=line_end,
            excerpt=text[:200],
        )
        return [], [issue]
    return [
        AnswerFragment(
            question_no=number,
            text=letter.upper(),
            block_kind="compact_choice",
            line_start=line_start,
            line_end=line_end,
        )
        for number, letter in zip(expected_numbers, letters)
    ], []


_CELL_DIGITS_RE = re.compile(r"^\d{1,2}$")
_CELL_CHOICE_RE = re.compile(r"^[A-D]{1,4}$")
_CELL_SPACED_CHOICE_RE = re.compile(r"^[A-D](?:\s+[A-D]){0,3}$")
_ANSWER_LABEL_RE = re.compile(r"答案|选项|解答|answer|key", re.IGNORECASE)


def _compact_choice_cells(cells: list[str]) -> list[str]:
    """把空格分隔的多选答案格（'A B C'）压成连续字母（'ABC'）。"""
    return [re.sub(r"\s+", "", c) if _CELL_SPACED_CHOICE_RE.match(c) else c
            for c in cells]


@dataclass(frozen=True)
class _TableCell:
    text: str
    colspan: int = 1


def _table_cell_rows(line: str) -> list[list[_TableCell]]:
    """HTML 表格 → 行×单元格（保留题号/答案格的 colspan）。"""
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", line, re.DOTALL)
    result: list[list[_TableCell]] = []
    for row in rows:
        cells: list[_TableCell] = []
        for attrs, body in re.findall(
            r"<td([^>]*)>(.*?)</td>", row, re.DOTALL
        ):
            span_match = re.search(
                r"\bcolspan\s*=\s*[\"']?(\d+)", attrs, re.IGNORECASE
            )
            colspan = int(span_match.group(1)) if span_match else 1
            cells.append(_TableCell(
                text=html.unescape(re.sub(r"<[^>]+>", "", body)).strip(),
                colspan=max(1, colspan),
            ))
        result.append(cells)
    return result


def _table_rows(line: str) -> list[list[str]]:
    """HTML 表格 → 行×格文本（剥标签、去首尾空白；rowspan/colspan 只留空文本）。"""
    return [
        [cell.text for cell in row]
        for row in _table_cell_rows(line)
    ]


def _strip_leading_label(cells: list[str], ok) -> list[str]:
    """丢掉行首「不是内容」的那一格。"""
    body = list(cells)
    if body and body[0] and not ok(body[0]):
        body = body[1:]
    return body


def _number_cells(cells: list[str]) -> list[str]:
    """取出题号行的数字格；不是题号行返回 []。"""
    body = _strip_leading_label(cells, lambda c: bool(_CELL_DIGITS_RE.match(c)))
    while body and not body[-1]:
        body.pop()
    if len(body) >= 2 and all(_CELL_DIGITS_RE.match(c) for c in body):
        return body
    return []


def _choice_body(cells: list[str]) -> list[str]:
    body = _strip_leading_label(_compact_choice_cells(cells),
                                lambda c: bool(_CELL_CHOICE_RE.match(c)))
    while body and not body[-1]:
        body.pop()
    return body


def _looks_like_choice_row(cells: list[str]) -> bool:
    """像答案行（全是 A–D 组合），但未必和题号行对齐。"""
    body = _choice_body(cells)
    return len(body) >= 2 and any(body) and all(
        not c or _CELL_CHOICE_RE.match(c) for c in body)


def _choice_cells(cells: list[str], expected: int) -> list[str]:
    """取出答案行的选项格；不是答案行、或列数对不上返回 []。"""
    body = _choice_body(cells)
    if len(body) == expected + 1 and body[0] == "":
        body = body[1:]
    if len(body) == expected and any(body) and all(
            not c or _CELL_CHOICE_RE.match(c) for c in body):
        return body
    return []


def _is_answer_label(cell: str) -> bool:
    """答案表行首标签（答案/选项/正确答案/answer/key…）。"""
    text = re.sub(r"[\s:：]+", "", cell or "")
    return bool(text and _ANSWER_LABEL_RE.search(text))


def _freeform_cells(cells: list[str], expected: int) -> list[str]:
    """提取带「答案」标签的自由文本答案格。"""
    body = list(cells)
    while body and not body[-1]:
        body.pop()
    if len(body) == expected + 1:
        if not _is_answer_label(body[0]):
            return []
        body = body[1:]
    else:
        return []
    if len(body) != expected or not any(c.strip() for c in body):
        return []
    return body


def _span_aligned_answers(
    number_row: list[_TableCell],
    answer_row: list[_TableCell],
) -> dict[int, str]:
    """按题号行的 colspan 把答案格合并回每一题。"""
    header = list(number_row)
    if header and not _CELL_DIGITS_RE.match(header[0].text):
        header = header[1:]
    if len(header) < 2 or not all(
        _CELL_DIGITS_RE.match(cell.text) for cell in header
    ):
        return {}

    answer_cells = list(answer_row)
    labeled = bool(answer_cells and _is_answer_label(answer_cells[0].text))
    if labeled:
        answer_cells = answer_cells[1:]

    slots: list[str] = []
    for cell in answer_cells:
        slots.append(cell.text)
        slots.extend("" for _ in range(cell.colspan - 1))

    header_width = sum(cell.colspan for cell in header)
    if len(slots) != header_width:
        return {}
    if not labeled and not all(
        not text or _CELL_CHOICE_RE.match(_compact_choice_cells([text])[0])
        for text in slots
    ):
        return {}

    result: dict[int, str] = {}
    offset = 0
    for cell in header:
        values = slots[offset:offset + cell.colspan]
        offset += cell.colspan
        merged = "；".join(value for value in values if value)
        if merged:
            result[int(cell.text)] = merged
    return result


def _parse_horizontal(
    rows: list[list[str]],
    cell_rows: list[list[_TableCell]] | None = None,
) -> dict[int, str]:
    """横向表：数字行 + 下一行答案行，一张表里可以有多组。"""
    result: dict[int, str] = {}
    for i in range(len(rows) - 1):
        nums = _number_cells(rows[i])
        if not nums:
            continue
        answers = _choice_cells(rows[i + 1], len(nums))
        if not answers:
            answers = _freeform_cells(rows[i + 1], len(nums))
        if not answers and cell_rows is not None:
            aligned = _span_aligned_answers(cell_rows[i], cell_rows[i + 1])
            if aligned:
                result.update(aligned)
                continue
        if not answers:
            if _looks_like_choice_row(rows[i + 1]):
                print(f"[WARN] 答案表列数不齐（题号 {nums[:3]}…，答案 "
                      f"{len(_choice_body(rows[i + 1]))} 格），该组不写", flush=True)
            continue
        for n, a in zip(nums, answers):
            if a:
                result[int(n)] = a
    return result


def _parse_vertical(rows: list[list[str]]) -> dict[int, str]:
    """纵向表：一行一对「题号 | 答案」，表头行自动跳过。"""
    result: dict[int, str] = {}
    pairs = 0
    has_answer_header = any(
        _is_answer_label(cell)
        for row in rows
        for cell in row
    )
    for row in rows:
        body = [c for c in _compact_choice_cells(row) if c]
        if len(body) != 2 or not _CELL_DIGITS_RE.match(body[0]):
            continue
        if not (_CELL_CHOICE_RE.match(body[1]) or has_answer_header):
            continue
        pairs += 1
        result[int(body[0])] = body[1]
    return result if pairs >= 2 else {}


_NUMBERED_ANSWER_CELL_RE = re.compile(
    r"^\s*(\d{1,2})\s*[.．]\s*(.+?)\s*$"
)


def _parse_cell_numbered(
    rows: list[list[_TableCell]]
) -> dict[int, str]:
    """解析每格都写成「题号. 答案」的答案网格。"""
    result: dict[int, str] = {}
    for row in rows:
        for cell in row:
            text = cell.text.strip()
            if not text:
                continue
            match = _NUMBERED_ANSWER_CELL_RE.match(text)
            if match is None:
                return {}
            result[int(match.group(1))] = match.group(2).strip()

    numbers = list(result)
    if len(numbers) < 2:
        return {}
    if numbers != list(range(numbers[0], numbers[-1] + 1)):
        return {}
    return result


def answer_table_numbers(line: str) -> set[int]:
    """这张表里声明了有答案的题号集合。"""
    return {int(n) for row in _table_rows(line) for n in _number_cells(row)}


def parse_answer_table(line: str) -> dict[int, str]:
    """解析 HTML 答案表（题号→答案），按版式分派而非按位置猜。"""
    cell_rows = _table_cell_rows(line)
    rows = [[cell.text for cell in row] for row in cell_rows]
    if len(rows) < 2:
        return {}
    return (
        _parse_horizontal(rows, cell_rows)
        or _parse_vertical(rows)
        or _parse_cell_numbered(cell_rows)
    )

"""答案区块模型与版式解析。

本模块不依赖 question_splitter 或学科策略，负责把答案区拆成表格、裸选择、
统一编号块和未知块。HTML 表格解析从 question_splitter 迁入这里，旧导入名由
question_splitter 继续兼容导出。
"""

import html
import re
from dataclasses import dataclass


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

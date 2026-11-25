# 答案解析块级重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把试卷答案区从行级全局状态机改成按版式块解析，恢复 9–16 题缺失答案，并让所有缺失都有可定位验证证据。

**Architecture:** 题干状态机只负责定位答案区，答案区交给 `answer_region.py`；`answer_blocks.py` 负责表格、裸选择、统一编号块和未知块。generic 链使用新块解析器，语文通过 legacy adapter 保持原行为，英语继续叠加自己的区间答案规则。

**Tech Stack:** Python 3.10+、pytest、dataclasses、re、标准库 pathlib

## Global Constraints

- 第一阶段只把数学、物理、化学、道法、英语的 generic 链迁入块解析；语文独立答案策略不重写。
- `question_splitter.py` 最终不得保留 `current_answer_n` / `last_answer_n` 答案游标。
- `answer_blocks.py` 不 import `question_splitter.py`，不依赖学科策略。
- 不引入 LLM、不猜答案、不改数据库 schema、不自动覆盖已有答案。
- 无答案边界时安静返回；有答案区但零命中时抛出 `answer_region_no_assignments`。
- 多个独立答案块对同一题遵循“第一套非空答案优先”，后续块不得覆盖。
- 空行保留在答案正文中；块扫描可以忽略空行，但最终答案不得丢空行。
- 所有测试命令在 `tools/data-refinery/` 下运行。
- 每个任务完成后提交一次，提交前运行本任务测试和已有相关测试。
- 完成后同步 `docs/constraints/数据管线.md` 与 `docs/ai-core-changelog.md`。

---

### Task 1: 块数据模型与表格解析迁移

**Files:**
 - Create: `tools/data-refinery/src/answer_blocks.py`
 - Create: `tools/data-refinery/tests/test_answer_blocks.py`
 - Modify: `tools/data-refinery/src/question_splitter.py:810-1105`
 - Modify: `tools/data-refinery/tests/test_answer_table.py:1-12`

**Interfaces:**
 - Produces: `AnswerQuestion(no: int, group_id: str | None)`
 - Produces: `AnswerLine(line_no: int, text: str)`
 - Produces: `AnswerBlock(kind: str, lines: tuple[AnswerLine, ...], group_id: str | None)`
 - Produces: `AnswerFragment(question_no: int, text: str, block_kind: str, line_start: int, line_end: int)`
 - Produces: `AnswerIssue(code: str, severity: str, message: str, question_no: int | None, line_start: int | None, line_end: int | None, excerpt: str)`
 - Produces: `AnswerParseResult(fragments: list[AnswerFragment], blocks: list[AnswerBlock], issues: list[AnswerIssue])`
 - Produces: `parse_answer_table(line: str) -> dict[int, str]`
 - Produces: `answer_table_numbers(line: str) -> set[int]`
 - Preserves: `from question_splitter import parse_answer_table, answer_table_numbers` 可继续使用

 - [ ] **Step 1: 写失败测试**

```python
# tools/data-refinery/tests/test_answer_blocks.py
from answer_blocks import (
    AnswerBlock,
    AnswerIssue,
    AnswerLine,
    AnswerQuestion,
    parse_answer_table,
)


def test_block_models_keep_source_line_and_group():
    line = AnswerLine(line_no=220, text="9. (-1,-2)")
    block = AnswerBlock(kind="numbered", lines=(line,), group_id="二")
    question = AnswerQuestion(no=9, group_id="二")
    issue = AnswerIssue(
        code="answer_missing",
        severity="error",
        message="Q9 缺答案",
        question_no=9,
        line_start=220,
        line_end=220,
        excerpt="9. (-1,-2)",
    )

    assert block.lines[0].line_no == 220
    assert question.group_id == "二"
    assert issue.question_no == 9


def test_question_splitter_reexports_migrated_table_parser():
    from question_splitter import parse_answer_table as compatibility_parser

    table = (
        "<table>"
        "<tr><td>题号</td><td>9</td><td>10</td></tr>"
        "<tr><td>答案</td><td>(-1,-2)</td><td>4</td></tr>"
        "</table>"
    )
    assert compatibility_parser(table) == {9: "(-1,-2)", 10: "4"}
    assert parse_answer_table(table) == {9: "(-1,-2)", 10: "4"}
```

 - [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py -q`

Expected: FAIL，`ModuleNotFoundError: No module named 'answer_blocks'`

 - [ ] **Step 3: 创建数据模型**

在 `answer_blocks.py` 顶部加入：

```python
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
```

 - [ ] **Step 4: 原样迁移表格解析**

把 `question_splitter.py` 中以下符号原样迁移到 `answer_blocks.py`：

```text
_CELL_DIGITS_RE
_CELL_CHOICE_RE
_CELL_SPACED_CHOICE_RE
_ANSWER_LABEL_RE
_compact_choice_cells
_TableCell
_table_cell_rows
_table_rows
_strip_leading_label
_number_cells
_choice_body
_looks_like_choice_row
_choice_cells
_is_answer_label
_freeform_cells
_span_aligned_answers
_parse_horizontal
_parse_vertical
_NUMBERED_ANSWER_CELL_RE
_parse_cell_numbered
answer_table_numbers
parse_answer_table
```

在 `question_splitter.py` 中用兼容导入替换旧定义：

```python
from answer_blocks import (
    answer_table_numbers,
    parse_answer_table,
)
```

`is_answer_structure_line` 此时继续定义在 `question_splitter.py`，Task 2
再迁移并加入兼容导入。

 - [ ] **Step 5: 跑表格专项测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py tests/test_answer_table.py tests/subject_strategies/test_natural_sciences.py -q`

Expected: 全部 PASS。

 - [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/answer_blocks.py tools/data-refinery/src/question_splitter.py \
  tools/data-refinery/tests/test_answer_blocks.py
git commit -m "refactor(refinery): 建立答案解析块模型并迁移表格解析"
```

---

### Task 2: 答案区预处理与块扫描

**Files:**
 - Modify: `tools/data-refinery/src/answer_blocks.py`
 - Modify: `tools/data-refinery/src/question_splitter.py:92-105`
 - Modify: `tools/data-refinery/tests/test_answer_blocks.py`

**Interfaces:**
 - Consumes: `AnswerLine`, `AnswerBlock`, `AnswerQuestion`
 - Produces: `is_answer_structure_line(line: str) -> bool`
 - Produces: `prepare_answer_lines(lines: list[str], first_line_no: int) -> list[AnswerLine]`
 - Produces: `split_answer_blocks(lines: list[AnswerLine], questions: list[AnswerQuestion]) -> list[AnswerBlock]`

 - [ ] **Step 1: 写失败测试**

```python
from answer_blocks import (
    AnswerLine,
    AnswerQuestion,
    prepare_answer_lines,
    split_answer_blocks,
)


def test_prepare_strips_group_header_but_keeps_same_line_answers():
    lines = [
        "# 参考答案",
        "二、填空题(本题共 16分，每小题 2分)9. (-1,-2) 10. 4 11. <",
        "",
        "12.2(1+x)^2=5.8",
    ]
    prepared = prepare_answer_lines(lines, first_line_no=214)

    assert [(line.line_no, line.text) for line in prepared] == [
        (215, "二、填空题(本题共 16分，每小题 2分)9. (-1,-2) 10. 4 11. <"),
        (216, ""),
        (217, "12.2(1+x)^2=5.8"),
    ]
    blocks = split_answer_blocks(
        prepared,
        [
            AnswerQuestion(no=number, group_id="二")
            for number in range(9, 14)
        ],
    )
    assert blocks[0].group_id == "二"
    assert blocks[0].lines[0].text.startswith("9. (-1,-2)")


def test_prepare_keeps_answer_text_after_reference_heading():
    prepared = prepare_answer_lines(
        ["# 参考答案 9. A 10. B"],
        first_line_no=1,
    )
    assert [(line.line_no, line.text) for line in prepared] == [
        (1, "9. A 10. B"),
    ]


def test_split_blocks_keeps_blank_lines_inside_numbered_block():
    lines = [
        AnswerLine(1, "17. 解：第一行"),
        AnswerLine(2, ""),
        AnswerLine(3, "$$"),
        AnswerLine(4, "x=1"),
        AnswerLine(5, "$$"),
        AnswerLine(6, "18. 证明：结论"),
    ]
    blocks = split_answer_blocks(
        lines,
        [AnswerQuestion(no=17, group_id="三"), AnswerQuestion(no=18, group_id="三")],
    )

    assert blocks[0].kind == "numbered"
    assert [line.text for line in blocks[0].lines] == [
        "17. 解：第一行", "", "$$", "x=1", "$$",
    ]
    assert blocks[1].lines[0].text == "18. 证明：结论"
```

 - [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py -q`

Expected: FAIL，`prepare_answer_lines` / `split_answer_blocks` 未定义。

 - [ ] **Step 3: 实现结构清洗**

在 `answer_blocks.py` 中加入：

```python
import re

from page_markers import is_page_marker_line


_GROUP_HEADER_RE = re.compile(
    r"^#{0,6}\s*([一二三四五六七八九十]+)、\s*(.*)$"
)
_INLINE_NUMBER_RE = re.compile(r"(?<!\d)\d{1,2}\s*[.．]")
_SECTION_HEADER_RE = re.compile(
    r"^#{0,6}\s*[（(]\s*[一二三四五六七八九十]+\s*[）)]"
)
_ANSWER_HEADING_PREFIX_RE = re.compile(r"^#{0,6}\s*")


def is_answer_structure_line(line: str) -> bool:
    return is_page_marker_line(line) or bool(_SECTION_HEADER_RE.match(line))


def _split_group_header_with_tail(line: str) -> tuple[str | None, str]:
    match = _GROUP_HEADER_RE.match(line)
    if match is None:
        return None, line.strip()
    body = match.group(2).strip()
    inline = _INLINE_NUMBER_RE.search(body)
    tail = body[inline.start():].strip() if inline else ""
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
```

`prepare_answer_lines` 保留大题标题行，`split_answer_blocks` 再同时提取
group_id 和同行答案尾部，避免在预处理阶段丢失作用域信息。

 - [ ] **Step 4: 实现首版块扫描**

```python
def split_answer_blocks(
    lines: list[AnswerLine],
    questions: list[AnswerQuestion],
) -> list[AnswerBlock]:
    expected = {question.no for question in questions}
    working_lines = list(lines)
    blocks: list[AnswerBlock] = []
    group_id: str | None = None
    index = 0

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

        if any(re.search(rf"(?<!\d){number}\s*[.．]", text) for number in expected):
            end = index + 1
            while end < len(working_lines):
                next_text = working_lines[end].text.strip()
                if _split_group_header_with_tail(next_text)[0] is not None:
                    break
                if next_text.startswith("<table") or re.fullmatch(
                    r"[A-Da-d](?:\s*[A-Da-d])+", next_text
                ):
                    break
                if any(
                    re.search(rf"(?<!\d){number}\s*[.．]", next_text)
                    for number in expected
                ):
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
            if any(re.search(rf"(?<!\d){number}\s*[.．]", next_text) for number in expected):
                break
            end += 1
        blocks.append(AnswerBlock(
            "unknown", tuple(working_lines[index:end]), group_id
        ))
        index = end

    return blocks
```

同一步把 `is_answer_structure_line` 从 `question_splitter.py` 删除并改为兼容导入。

 - [ ] **Step 5: 跑测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py tests/test_page_markers.py tests/test_page_marker_integration.py -q`

Expected: 全部 PASS。

 - [ ] **Step 6: Commit**

```bash
git add tools/data-refinery/src/answer_blocks.py tools/data-refinery/src/question_splitter.py \
  tools/data-refinery/tests/test_answer_blocks.py
git commit -m "feat(refinery): 增加答案区预处理与块扫描"
```

---

### Task 3: 统一编号块与裸选择块解析

**Files:**
 - Modify: `tools/data-refinery/src/answer_blocks.py`
 - Modify: `tools/data-refinery/tests/test_answer_blocks.py`

**Interfaces:**
 - Consumes: `AnswerBlock`, `AnswerFragment`, `AnswerIssue`, `AnswerQuestion`
 - Produces: `parse_compact_choice(block: AnswerBlock, expected_numbers: list[int]) -> tuple[list[AnswerFragment], list[AnswerIssue]]`
 - Produces: `parse_numbered_block(block: AnswerBlock, expected_numbers: list[int]) -> tuple[list[AnswerFragment], list[AnswerIssue]]`

 - [ ] **Step 1: 写密云编号与拒绝小数测试**

```python
from answer_blocks import (
    AnswerBlock,
    AnswerLine,
    parse_compact_choice,
    parse_numbered_block,
)


def _block(kind: str, *texts: str, group_id: str | None = "二") -> AnswerBlock:
    return AnswerBlock(
        kind=kind,
        lines=tuple(AnswerLine(i + 1, text) for i, text in enumerate(texts)),
        group_id=group_id,
    )


def test_miyun_header_tail_and_numeric_answers_are_split():
    block = _block(
        "numbered",
        "9. (-1,-2) 10.x1=4，x2=-4 11. <",
        "12.2（本题答案不唯一） $1 3 . 2(1+x)^2=5.8$ "
        "14. $\\sqrt{3}$ 15. $20^\\circ$",
    )
    fragments, issues = parse_numbered_block(block, list(range(9, 16)))
    got = {fragment.question_no: fragment.text for fragment in fragments}

    assert got[9] == "(-1,-2)"
    assert got[10] == "x1=4，x2=-4"
    assert got[11] == "<"
    assert got[12] == "2（本题答案不唯一）"
    assert got[13] == "2(1+x)^2=5.8"
    assert got[14] == "$\\sqrt{3}$"
    assert got[15] == "$20^\\circ$"
    assert not [issue for issue in issues if issue.code == "answer_missing"]


def test_decimal_in_previous_answer_is_not_next_question():
    block = _block(
        "numbered",
        "11. 距离约为 12.2 米。",
        "12. 20",
    )
    fragments, _issues = parse_numbered_block(block, [11, 12])
    assert [(fragment.question_no, fragment.text) for fragment in fragments] == [
        (11, "距离约为 12.2 米。"),
        (12, "20"),
    ]


def test_single_letter_is_not_compact_choice_key():
    block = _block("compact_choice", "A", group_id="一")
    fragments, issues = parse_compact_choice(block, [1, 2, 3])
    assert fragments == []
    assert issues[0].code == "compact_choice_count_mismatch"
```

 - [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py -q`

Expected: FAIL，两个 parse 函数不存在。

 - [ ] **Step 3: 实现数字归一与强边界扫描**

在 `answer_blocks.py` 中加入以下基础函数：

```python
_NUMBER_TOKEN_RE = re.compile(r"(?<!\d)(\d(?:\s*\d)?)\s*([.．])?\s*(?=\S)")
_MATH_OPERATORS = set("=+-×÷")
_STRONG_PREFIXES = set("；。$")


def _number_value(raw: str) -> int:
    return int(re.sub(r"\s+", "", raw))


def _line_start_offsets(text: str) -> set[int]:
    starts = {0}
    starts.update(i + 1 for i, char in enumerate(text) if char == "\n")
    return starts


def _marker_allowed(
    text: str,
    match: re.Match[str],
    expected_no: int,
    line_starts: set[int],
) -> bool:
    before = text[:match.start()].rstrip()
    previous = before[-1:] if before else ""
    at_line_start = match.start() in line_starts or not before
    has_dot = match.group(2) is not None
    followed_by_digit = bool(re.match(r"\d", text[match.end():]))

    if previous and (previous.isalnum() or previous in _MATH_OPERATORS):
        return False
    if has_dot and followed_by_digit and not at_line_start:
        return previous in _STRONG_PREFIXES or previous == "分"
    return at_line_start or previous.isspace() or previous in _STRONG_PREFIXES
```

 - [ ] **Step 4: 实现 `parse_numbered_block`**

按期望题号逐个查找，保留块内空行：

```python
def _find_marker(
    text: str,
    start: int,
    expected_no: int,
    line_starts: set[int],
) -> re.Match[str] | None:
    for match in _NUMBER_TOKEN_RE.finditer(text, start):
        if _number_value(match.group(1)) != expected_no:
            continue
        if _marker_allowed(text, match, expected_no, line_starts):
            return match
    return None


def parse_numbered_block(
    block: AnswerBlock,
    expected_numbers: list[int],
) -> tuple[list[AnswerFragment], list[AnswerIssue]]:
    text = "\n".join(line.text for line in block.lines)
    starts = _line_start_offsets(text)
    markers: list[tuple[int, re.Match[str]]] = []
    cursor = 0
    for number in expected_numbers:
        marker = _find_marker(text, cursor, number, starts)
        if marker is None:
            continue
        markers.append((number, marker))
        cursor = marker.end()

    fragments: list[AnswerFragment] = []
    issues: list[AnswerIssue] = []
    for index, (number, marker) in enumerate(markers):
        end = markers[index + 1][1].start() if index + 1 < len(markers) else len(text)
        answer = text[marker.end():end].strip()
        if not answer:
            issues.append(AnswerIssue(
                code="answer_empty",
                severity="error",
                message=f"第 {number} 题答案为空",
                question_no=number,
                line_start=block.lines[0].line_no,
                line_end=block.lines[-1].line_no,
                excerpt="",
            ))
            continue
        fragments.append(AnswerFragment(
            question_no=number,
            text=answer,
            block_kind="numbered",
            line_start=block.lines[0].line_no,
            line_end=block.lines[-1].line_no,
        ))
    return fragments, issues
```

 - [ ] **Step 5: 实现 `parse_compact_choice`**

```python
def parse_compact_choice(
    block: AnswerBlock,
    expected_numbers: list[int],
) -> tuple[list[AnswerFragment], list[AnswerIssue]]:
    text = " ".join(line.text for line in block.lines).strip()
    letters = re.findall(r"[A-Da-d]", text)
    if len(letters) < 2 or len(letters) != len(expected_numbers):
        issue = AnswerIssue(
            code="compact_choice_count_mismatch",
            severity="error",
            message=(
                f"裸答案 {len(letters)} 项，期望题号 {len(expected_numbers)} 项，"
                "整串不展开"
            ),
            question_no=None,
            line_start=block.lines[0].line_no,
            line_end=block.lines[-1].line_no,
            excerpt=text[:200],
        )
        return [], [issue]
    return [
        AnswerFragment(
            question_no=number,
            text=letter.upper(),
            block_kind="compact_choice",
            line_start=block.lines[0].line_no,
            line_end=block.lines[-1].line_no,
        )
        for number, letter in zip(expected_numbers, letters)
    ], []
```

 - [ ] **Step 6: 跑本任务测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py -q`

Expected: 全部 PASS。

 - [ ] **Step 7: Commit**

```bash
git add tools/data-refinery/src/answer_blocks.py tools/data-refinery/tests/test_answer_blocks.py
git commit -m "feat(refinery): 实现统一编号块和裸选择答案解析"
```

---

### Task 4: 答案区编排、合并与覆盖校验

**Files:**
 - Create: `tools/data-refinery/src/answer_region.py`
 - Modify: `tools/data-refinery/tests/test_answer_blocks.py`

**Interfaces:**
 - Consumes: `AnswerLine`, `AnswerQuestion`, `AnswerFragment`, `AnswerIssue`, `AnswerParseResult`
 - Consumes: `prepare_answer_lines`, `split_answer_blocks`, `parse_numbered_block`, `parse_compact_choice`
 - Produces: `parse_answer_region(lines: list[AnswerLine], questions: list[AnswerQuestion], *, first_line_no: int) -> AnswerParseResult`

 - [ ] **Step 1: 写覆盖、首套优先与零命中测试**

```python
from answer_blocks import AnswerLine, AnswerQuestion
from answer_region import parse_answer_region


def test_region_reports_missing_without_writing_neighbor():
    lines = [
        AnswerLine(10, "9. (-1,-2) 10. 4"),
    ]
    result = parse_answer_region(
        lines,
        [AnswerQuestion(no=n, group_id="二") for n in range(9, 14)],
        first_line_no=10,
    )
    got = {fragment.question_no: fragment.text for fragment in result.fragments}

    assert got == {9: "(-1,-2)", 10: "4"}
    missing = {
        issue.question_no
        for issue in result.issues
        if issue.code == "answer_missing"
    }
    assert missing == {11, 12, 13}


def test_second_independent_answer_block_does_not_replace_first():
    lines = [
        AnswerLine(
            1,
            "<table>"
            "<tr><td>1</td><td>2</td><td>3</td></tr>"
            "<tr><td>B</td><td>C</td><td>A</td></tr>"
            "</table>",
        ),
        AnswerLine(2, ""),
        AnswerLine(3, "1. 答案：B"),
        AnswerLine(4, "解析：第一题说明"),
    ]
    result = parse_answer_region(
        lines,
        [AnswerQuestion(no=n, group_id="一") for n in (1, 2, 3)],
        first_line_no=1,
    )
    merged: dict[int, str] = {}
    for fragment in result.fragments:
        merged.setdefault(fragment.question_no, fragment.text)

    assert merged == {1: "B", 2: "C", 3: "A"}
    assert any(issue.code == "answer_duplicate_ignored" for issue in result.issues)


def test_region_with_no_assignments_has_sentinel_issue():
    result = parse_answer_region(
        [AnswerLine(1, "无法识别的一段文本")],
        [AnswerQuestion(no=9, group_id="二")],
        first_line_no=1,
    )
    assert any(
        issue.code == "answer_region_no_assignments"
        for issue in result.issues
    )
```

 - [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py -q`

Expected: FAIL，`No module named 'answer_region'`

 - [ ] **Step 3: 实现 block dispatcher**

```python
# tools/data-refinery/src/answer_region.py
from answer_blocks import (
    AnswerBlock,
    AnswerFragment,
    AnswerIssue,
    AnswerLine,
    AnswerParseResult,
    AnswerQuestion,
    answer_table_numbers,
    parse_compact_choice,
    parse_numbered_block,
    parse_answer_table,
    prepare_answer_lines,
    split_answer_blocks,
)


def _group_numbers(
    block: AnswerBlock,
    questions: list[AnswerQuestion],
) -> list[int]:
    numbers = [question.no for question in questions]
    if block.group_id is None:
        return numbers
    grouped = [
        question.no
        for question in questions
        if question.group_id == block.group_id
    ]
    return grouped or numbers
```

 - [ ] **Step 4: 实现块分派**

```python
def _parse_block(
    block: AnswerBlock,
    questions: list[AnswerQuestion],
) -> tuple[list[AnswerFragment], list[AnswerIssue]]:
    expected = _group_numbers(block, questions)
    if block.kind == "compact_choice":
        if block.group_id is None:
            return [], [AnswerIssue(
                code="group_scope_unresolved",
                severity="error",
                message="裸选择答案找不到所属大题",
                question_no=None,
                line_start=block.lines[0].line_no,
                line_end=block.lines[-1].line_no,
                excerpt=block.lines[0].text[:200],
            )]
        return parse_compact_choice(block, expected)

    if block.kind == "numbered":
        return parse_numbered_block(block, expected)

    if block.kind == "table":
        text = "\n".join(line.text for line in block.lines)
        answers = parse_answer_table(text)
        line_start = block.lines[0].line_no
        line_end = block.lines[-1].line_no
        fragments = [
            AnswerFragment(
                question_no=number,
                text=answer,
                block_kind="table",
                line_start=line_start,
                line_end=line_end,
            )
            for number, answer in answers.items()
        ]
        declared = answer_table_numbers(text)
        missing = sorted(declared - set(answers))
        issues = [
            AnswerIssue(
                code="table_incomplete",
                severity="error",
                message=f"答案表声明第 {number} 题但未解析出答案",
                question_no=number,
                line_start=line_start,
                line_end=line_end,
                excerpt=text[:200],
            )
            for number in missing
        ]
        if fragments:
            return fragments, issues
        return [], [AnswerIssue(
            code="table_incomplete",
            severity="error",
            message="答案表没有解析出可写入答案",
            question_no=None,
            line_start=line_start,
            line_end=line_end,
            excerpt=text[:200],
        )]

    return [], [AnswerIssue(
        code="answer_block_unparsed",
        severity="error",
        message="未知答案块，未做猜测",
        question_no=None,
        line_start=block.lines[0].line_no,
        line_end=block.lines[-1].line_no,
        excerpt="\n".join(line.text for line in block.lines)[:200],
    )]
```

 - [ ] **Step 5: 实现第一套优先与逐题覆盖**

```python
def _warning_if_duplicate(
    fragment: AnswerFragment,
    assigned: dict[int, str],
) -> AnswerIssue | None:
    if fragment.question_no not in assigned:
        return None
    return AnswerIssue(
        code="answer_duplicate_ignored",
        severity="warning",
        message=f"第 {fragment.question_no} 题已有首套答案，后续独立答案块已忽略",
        question_no=fragment.question_no,
        line_start=fragment.line_start,
        line_end=fragment.line_end,
        excerpt=fragment.text[:200],
    )


def parse_answer_region(
    lines: list[AnswerLine],
    questions: list[AnswerQuestion],
    *,
    first_line_no: int,
) -> AnswerParseResult:
    prepared = prepare_answer_lines(
        [line.text for line in lines],
        first_line_no=first_line_no,
    )
    blocks = split_answer_blocks(prepared, questions)
    assigned: dict[int, str] = {}
    fragments: list[AnswerFragment] = []
    issues: list[AnswerIssue] = []

    for block in blocks:
        block_fragments, block_issues = _parse_block(block, questions)
        issues.extend(block_issues)
        for fragment in block_fragments:
            duplicate = _warning_if_duplicate(fragment, assigned)
            if duplicate is not None:
                issues.append(duplicate)
                continue
            assigned[fragment.question_no] = fragment.text
            fragments.append(fragment)

    expected = {question.no for question in questions}
    for number in sorted(expected - set(assigned)):
        issues.append(AnswerIssue(
            code="answer_missing",
            severity="error",
            message=f"第 {number} 题没有解析出答案",
            question_no=number,
            line_start=first_line_no,
            line_end=first_line_no + max(0, len(lines) - 1),
            excerpt="",
        ))

    if expected and not assigned:
        issues.append(AnswerIssue(
            code="answer_region_no_assignments",
            severity="error",
            message="答案区存在但未解析出任何答案",
            question_no=None,
            line_start=first_line_no,
            line_end=first_line_no + max(0, len(lines) - 1),
            excerpt="\n".join(line.text for line in lines)[:200],
        ))

    return AnswerParseResult(fragments=fragments, blocks=blocks, issues=issues)
```

 - [ ] **Step 6: 跑测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py -q`

Expected: 全部 PASS。

 - [ ] **Step 7: Commit**

```bash
git add tools/data-refinery/src/answer_region.py tools/data-refinery/tests/test_answer_blocks.py
git commit -m "feat(refinery): 编排答案块并增加覆盖校验"
```

---

### Task 5: 学科答案钩子与语文 legacy 适配

**Files:**
 - Create: `tools/data-refinery/src/legacy_answer_parser.py`
 - Modify: `tools/data-refinery/src/subject_strategies/types.py:70-115`
 - Modify: `tools/data-refinery/src/subject_strategies/generic.py:31-120`
 - Modify: `tools/data-refinery/src/subject_strategies/chinese.py:127-175`
 - Test: `tools/data-refinery/tests/test_answer_blocks.py`
 - Test: `tools/data-refinery/tests/test_question_splitter.py:1960-2130`

**Interfaces:**
 - Consumes: `AnswerLine`, `AnswerQuestion`, `AnswerParseResult`
 - Produces: `QuestionStrategy.parse_answers(answer_lines, questions, *, first_line_no) -> AnswerParseResult`
 - Produces: `GenericStrategy.parse_answers(answer_lines: list[AnswerLine], questions: list[AnswerQuestion], *, first_line_no: int) -> AnswerParseResult`
 - Produces: `ChineseStrategy.parse_answers(answer_lines: list[AnswerLine], questions: list[AnswerQuestion], *, first_line_no: int) -> AnswerParseResult`
 - Produces: `legacy_parse_answer_lines(answer_lines: list[AnswerLine], questions: list[AnswerQuestion], *, first_line_no: int) -> AnswerParseResult`

 - [ ] **Step 1: 写策略钩子测试**

```python
from answer_blocks import AnswerLine, AnswerQuestion
from subject_strategies import get_strategy

CHINESE_ANSWER_PAPER = """# 参考答案

1. 答案：B

2. 答案：C
"""


def test_chinese_parse_answers_adapter_keeps_existing_result():
    strategy = get_strategy("chinese")
    result = strategy.parse_answers(
        [AnswerLine(i + 1, line) for i, line in enumerate(CHINESE_ANSWER_PAPER.splitlines())],
        [
            AnswerQuestion(no=1, group_id=None),
            AnswerQuestion(no=2, group_id=None),
        ],
        first_line_no=1,
    )
    by_no = {fragment.question_no: fragment.text for fragment in result.fragments}
    assert by_no[1] == "B"
    assert by_no[2] == "C"


def test_generic_strategy_exposes_block_answer_parser():
    strategy = get_strategy("math")
    assert callable(strategy.parse_answers)
```

 - [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py::test_generic_strategy_exposes_block_answer_parser -q`

Expected: FAIL，`GenericStrategy` 没有 `parse_answers`。

 - [ ] **Step 3: 增加 Protocol 方法**

在 `subject_strategies/types.py` 中加入：

```python
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from answer_blocks import AnswerLine, AnswerParseResult, AnswerQuestion


class QuestionStrategy(Protocol):
    def parse_answers(
        self,
        answer_lines: list[AnswerLine],
        questions: list[AnswerQuestion],
        *,
        first_line_no: int,
    ) -> AnswerParseResult:
        """把答案区行解析成 AnswerParseResult；各科决定是否使用块解析。"""
```

`TYPE_CHECKING` 避免运行时循环依赖，但签名必须使用真实类型。

 - [ ] **Step 4: 给 generic 链挂块解析**

在 `generic.py` 中增加 mixin，并让 `GenericStrategy` 与
`NaturalScienceStrategy` 都继承它：

```python
from answer_blocks import AnswerLine, AnswerParseResult, AnswerQuestion


class BlockAnswerMixin:
    def parse_answers(
        self,
        answer_lines: list[AnswerLine],
        questions: list[AnswerQuestion],
        *,
        first_line_no: int,
    ) -> AnswerParseResult:
        from answer_region import parse_answer_region

        return parse_answer_region(
            answer_lines, questions, first_line_no=first_line_no,
        )
```

类声明改为 `class GenericStrategy(BlockAnswerMixin):` 和
`class NaturalScienceStrategy(BlockAnswerMixin):`。方法使用 late import，
避免 `subject_strategies -> answer_region -> subject_strategies` 的顶层循环依赖。

 - [ ] **Step 5: 迁移旧答案为语文 legacy adapter**

把当前 `question_splitter.split_page()` 中的答案区辅助逻辑迁移到
`legacy_answer_parser.py`：

```text
_strip_answer_prefix
_ANSWER_MARK_RE
_TRAILING_SCORE_RE
_INLINE_ANSWER_MARKER_RE
_INLINE_MATH_SPAN_RE
_mask_inline_math
split_inline_stems
split_inline_fill_blank_answers
split_compact_answer_key
_split_glued_answers
_split_score_prefixed_answer
旧答案循环
```

入口实现：

```python
from answer_blocks import (
    AnswerFragment,
    AnswerLine,
    AnswerParseResult,
    AnswerQuestion,
)


def legacy_parse_answer_lines(
    answer_lines: list[AnswerLine],
    questions: list[AnswerQuestion],
    *,
    first_line_no: int,
) -> AnswerParseResult:
    fragment_map = _run_legacy_state_machine(answer_lines, questions)
    fragments = [
        AnswerFragment(
            question_no=number,
            text=answer,
            block_kind="legacy",
            line_start=first_line_no,
            line_end=first_line_no + max(0, len(answer_lines) - 1),
        )
        for number, answer in sorted(fragment_map.items())
        if answer.strip()
    ]
    return AnswerParseResult(fragments=fragments, blocks=[], issues=[])
```

`_run_legacy_state_machine` 必须从当前代码原样迁移，不得用近似的正则重写。
迁移时把依赖 `questions` 的题号集合改为参数。

在 `chinese.py` 顶部加入 `from answer_blocks import AnswerLine, AnswerParseResult, AnswerQuestion`，
并给 `ChineseStrategy` 加入：

```python
    def parse_answers(
        self,
        answer_lines: list[AnswerLine],
        questions: list[AnswerQuestion],
        *,
        first_line_no: int,
    ) -> AnswerParseResult:
        from legacy_answer_parser import legacy_parse_answer_lines

        return legacy_parse_answer_lines(
            answer_lines,
            questions,
            first_line_no=first_line_no,
        )
```

 - [ ] **Step 6: 跑语文与策略测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_blocks.py tests/test_question_splitter.py tests/subject_strategies/test_chinese.py tests/subject_strategies/test_chinese_answers.py -q`

Expected: 全部 PASS，语文既有答案断言不变。

 - [ ] **Step 7: Commit**

```bash
git add tools/data-refinery/src/legacy_answer_parser.py \
  tools/data-refinery/src/subject_strategies/types.py \
  tools/data-refinery/src/subject_strategies/generic.py \
  tools/data-refinery/src/subject_strategies/chinese.py \
  tools/data-refinery/tests/test_answer_blocks.py
git commit -m "feat(refinery): 增加答案解析策略钩子与语文兼容适配"
```

---

### Task 6: 接入 `split_page_result` 并移除答案游标

**Files:**
 - Modify: `tools/data-refinery/src/question_splitter.py:1202-1803`
 - Modify: `tools/data-refinery/tests/test_question_splitter.py`

**Interfaces:**
 - Consumes: `strategy.parse_answers(...)`
 - Produces: `_split_questions_and_collect_answers(text, md_path, strategy, *, forced_stem_lines, suspects_out) -> tuple[list[RawQuestion], list[AnswerLine], int]`
 - Produces: `SplitPageResult(questions: list[RawQuestion], answer_result: AnswerParseResult | None)`
 - Produces: `split_page_result(...) -> SplitPageResult`
 - Preserves: `split_page(...) -> list[RawQuestion]`

 - [ ] **Step 1: 写密云端到端失败测试**

```python
MIYUN_BLOCK_PAPER = """9. 第 9 题

10. 第 10 题

11. 第 11 题

12. 第 12 题

13. 第 13 题

14. 第 14 题

15. 第 15 题

16. 第 16 题

# 参考答案

二、填空题(本题共 16分，每小题 2分)9. (-1,-2) 10.x1=4，x2=-4 11. <

12.2（本题答案不唯一） $1 3 . 2(1+x)^2=5.8$ 14. $\\sqrt{3}$
15. $20^\\circ$ 16. ① 2 ②1 ${ \\leqslant } m { \\leqslant } 4$
"""


def test_split_page_result_recovers_miyun_9_to_13():
    from question_splitter import split_page_result
    from subject_strategies import get_strategy

    result = split_page_result(
        MIYUN_BLOCK_PAPER,
        Path("x.md"),
        strategy=get_strategy("math"),
    )
    by_no = {question.group_order: question.answer for question in result.questions}

    assert by_no[9] == "(-1,-2)"
    assert by_no[10] == "x1=4，x2=-4"
    assert by_no[11] == "<"
    assert by_no[12] == "2（本题答案不唯一）"
    assert by_no[13] == "2(1+x)^2=5.8"
    assert result.answer_result is not None


def test_split_page_wrapper_keeps_list_contract():
    from question_splitter import split_page
    from subject_strategies import get_strategy

    questions = split_page(
        MIYUN_BLOCK_PAPER,
        Path("x.md"),
        strategy=get_strategy("math"),
    )
    assert isinstance(questions, list)
    assert questions[8].group_order == 9
```

 - [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_question_splitter.py::test_split_page_result_recovers_miyun_9_to_13 -q`

Expected: FAIL，`split_page_result` 不存在。

 - [ ] **Step 3: 增加 `SplitPageResult` 和包装函数**

先把现有 `split_page()` 的题干主体原样改名为
`_split_questions_and_collect_answers()`。进入循环前初始化
`answer_lines: list[AnswerLine] = []` 与 `answer_start = 1`；遇到答案边界时按
Step 4 收集剩余行并 `break`；函数末尾返回
`(questions, answer_lines, answer_start)`。

```python
from dataclasses import dataclass

from answer_blocks import AnswerLine, AnswerParseResult, AnswerQuestion


@dataclass
class SplitPageResult:
    questions: list[RawQuestion]
    answer_result: AnswerParseResult | None


def split_page(...):
    return split_page_result(...).questions


def split_page_result(
    text: str,
    md_path: Path,
    strategy=None,
    *,
    forced_stem_lines: set[int] | None = None,
    suspects_out: list | None = None,
) -> SplitPageResult:
    questions, answer_lines, answer_start = _split_questions_and_collect_answers(
        text,
        md_path,
        strategy,
        forced_stem_lines=forced_stem_lines,
        suspects_out=suspects_out,
    )
    answer_result = None
    if answer_lines:
        parser = getattr(strategy, "parse_answers", None)
        if parser is None:
            from answer_region import parse_answer_region

            answer_result = parse_answer_region(
                answer_lines=answer_lines,
                questions=[
                    AnswerQuestion(no=q.group_order, group_id=q.group_id)
                    for q in questions
                ],
                first_line_no=answer_start,
            )
        else:
            answer_result = parser(
                answer_lines,
                [
                    AnswerQuestion(no=q.group_order, group_id=q.group_id)
                    for q in questions
                ],
                first_line_no=answer_start,
            )
        by_no: dict[int, list[str]] = {}
        for fragment in answer_result.fragments:
            by_no.setdefault(fragment.question_no, []).append(fragment.text)
        for question in questions:
            question.answer = "\n".join(by_no.get(question.group_order, []))
    return SplitPageResult(questions=questions, answer_result=answer_result)
```

 - [ ] **Step 4: 在答案边界停止题干循环**

把现有：

```python
        if not in_answer_section and is_answer_keyword(line):
            if current is not None:
                questions.append(current)
                current = None
            in_answer_section = True
            continue
```

改成记录答案区并 `break`：

```python
        if is_answer_keyword(line):
            if current is not None:
                questions.append(current)
                current = None
            answer_lines = [
                AnswerLine(
                    line_no=line_index + 1,
                    text=answer_text,
                )
                for line_index, answer_text in enumerate(lines[i:], start=i)
            ]
            answer_start = i + 1
            break
```

循环结束后必须先执行答案解析和写回，再按现有顺序执行：

```text
attach_pre_material
attach_post_material
expand_subquestions
```

 - [ ] **Step 5: 删除旧答案状态机**

从 `split_page_result` 的题干循环中删除：

```text
current_answer_lines
current_answer_n
last_answer_n
_flush_answer
_answer_filled
if in_answer_section: 的逐行答案分支
```

答案区相关正则和辅助函数迁至 `answer_blocks.py` 或
`legacy_answer_parser.py`，`question_splitter.py` 只保留兼容导入。

 - [ ] **Step 6: 跑切题与答案测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_question_splitter.py tests/test_answer_table.py tests/test_answer_blocks.py -q`

Expected: 全部 PASS，包含密云端到端和现有第二套答案测试。

 - [ ] **Step 7: 验证游标已删除**

Run: `cd tools/data-refinery && rg -n "current_answer_n|last_answer_n" src/question_splitter.py`

Expected: 0 行输出。

 - [ ] **Step 8: Commit**

```bash
git add tools/data-refinery/src/question_splitter.py tools/data-refinery/tests/test_question_splitter.py
git commit -m "refactor(refinery): 答案解析改走块级两阶段入口"
```

---

### Task 7: generic issue、英语适配、CLI 与回填

**Files:**
 - Modify: `tools/data-refinery/src/subject_strategies/types.py:8-18`
 - Modify: `tools/data-refinery/src/subject_strategies/generic.py:16-29`
 - Modify: `tools/data-refinery/src/subject_strategies/english.py:250-300`
 - Modify: `tools/data-refinery/src/answer_extract_cli.py:77-170`
 - Modify: `tools/data-refinery/src/answer_backfill.py:95-165`
 - Modify: `tools/data-refinery/tests/test_answer_extract_cli.py`
 - Modify: `tools/data-refinery/tests/subject_strategies/test_english.py`
 - Modify: `tools/data-refinery/tests/subject_strategies/test_natural_sciences.py`

**Interfaces:**
 - Consumes: `SplitPageResult.answer_result`
 - Produces: `ExtractedAnswer.issue_details: list[dict]`
 - Produces: sentinel `AnswerIssue(code="answer_region_no_assignments")`
 - Produces: shared `write_answer_issues(...)`

 - [ ] **Step 1: 写 issue 传播与零命中测试**

```python
from pathlib import Path

from answer_extract_cli import has_no_answer_assignments
from subject_strategies import get_strategy


def test_generic_answer_result_carries_missing_issue_details():
    text = """9. 第 9 题

10. 第 10 题

# 参考答案

9. (-1,-2)
"""
    answers = get_strategy("math").extract_answers(
        text,
        Path("数学/初中/first/2025/test.md"),
    )
    q10 = next(item for item in answers if item.no == 10)
    assert any(
        issue["code"] == "answer_missing"
        for issue in q10.issue_details
    )


def test_zero_assignment_sentinel_is_detectable():
    from subject_strategies.types import ExtractedAnswer

    answers = [
        ExtractedAnswer(
            no=0,
            issues=["答案区存在但未解析出任何答案"],
            issue_details=[{
                "code": "answer_region_no_assignments",
                "severity": "error",
            }],
        )
    ]
    assert has_no_answer_assignments(answers)


def test_english_strategy_uses_block_answer_parser():
    assert callable(get_strategy("english").parse_answers)
```

 - [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_extract_cli.py -q`

Expected: FAIL，`issue_details` 或 `has_no_answer_assignments` 不存在。

 - [ ] **Step 3: 扩展 `ExtractedAnswer`**

```python
@dataclass
class ExtractedAnswer:
    no: int
    answer: str = ""
    approach: str = ""
    explanation: str = ""
    issues: list[str] = field(default_factory=list)
    issue_details: list[dict] = field(default_factory=list)
```

 - [ ] **Step 4: generic 链透传 issue 和 sentinel**

英语策略继承同一块解析能力，修改 `english.py` 的导入和类声明：

```python
from subject_strategies.generic import BlockAnswerMixin, extract_generic_answers


class EnglishStrategy(BlockAnswerMixin):
```

```python
def extract_generic_answers(text: str, md_path: Path, strategy=None):
    from question_splitter import split_page_result

    result = split_page_result(text, md_path, strategy=strategy)
    parse_result = result.answer_result
    answers = [
        ExtractedAnswer(
            no=question.group_order,
            answer=(question.answer or "").strip(),
            issues=[
                issue.message
                for issue in (parse_result.issues if parse_result else [])
                if issue.question_no == question.group_order
            ],
            issue_details=[
                {
                    "code": issue.code,
                    "severity": issue.severity,
                    "message": issue.message,
                    "question_no": issue.question_no,
                    "line_start": issue.line_start,
                    "line_end": issue.line_end,
                    "excerpt": issue.excerpt,
                }
                for issue in (parse_result.issues if parse_result else [])
                if issue.question_no == question.group_order
            ],
        )
        for question in result.questions
    ]
    if parse_result is not None and not any(answer.answer for answer in answers):
        sentinel = next(
            (
                issue
                for issue in parse_result.issues
                if issue.code == "answer_region_no_assignments"
            ),
            None,
        )
    else:
        sentinel = None
    if sentinel is not None:
        answers.append(ExtractedAnswer(
            no=0,
            issues=[sentinel.message],
            issue_details=[{
                "code": sentinel.code,
                "severity": sentinel.severity,
                "message": sentinel.message,
                "question_no": sentinel.question_no,
                "line_start": sentinel.line_start,
                "line_end": sentinel.line_end,
                "excerpt": sentinel.excerpt,
            }],
        ))
    return answers
```

 - [ ] **Step 5: CLI 持久化结构化 issue**

在 `answer_extract_cli.py` 中加入：

```python
def has_no_answer_assignments(answers) -> bool:
    return any(
        detail.get("code") == "answer_region_no_assignments"
        for answer in answers
        for detail in answer.issue_details
    )
```

把 `write_issues` 改为：

```python
def write_issues(path: Path, source: str, answers) -> int:
    rows: list[dict] = []
    for answer in answers:
        if answer.issue_details:
            for detail in answer.issue_details:
                row = {
                    "source": source,
                    "question_no": answer.no,
                    **detail,
                }
                rows.append(row)
            continue
        for reason in answer.issues:
            rows.append({
                "source": source,
                "question_no": answer.no,
                "reason": reason,
            })
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)
```

`main()` 在 `with_answer` 为空且 `has_no_answer_assignments(answers)` 时：

```python
print("[ERROR] 答案区存在但未解析出任何答案，未写答案文档")
return 2
```

 - [ ] **Step 6: answer_backfill 复用 issue 和失败口径**

```python
from answer_extract_cli import has_no_answer_assignments, write_issues
```

在策略提取后、判断 `no_answer` 前加入：

```python
write_issues(
    cfg.output_dir / "answer_issues.jsonl",
    str(rel_md),
    answers,
)
if has_no_answer_assignments(answers):
    print(f"[answers] 失败（答案区零命中）：{rel}")
    stats["failed"] += 1
    continue
```

 - [ ] **Step 7: 跑英语、generic 和 CLI 测试**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_extract_cli.py tests/subject_strategies/test_natural_sciences.py tests/subject_strategies/test_english.py -q`

Expected: 全部 PASS。

 - [ ] **Step 8: Commit**

```bash
git add tools/data-refinery/src/subject_strategies/types.py \
  tools/data-refinery/src/subject_strategies/generic.py \
  tools/data-refinery/src/subject_strategies/english.py \
  tools/data-refinery/src/answer_extract_cli.py \
  tools/data-refinery/src/answer_backfill.py \
  tools/data-refinery/tests/test_answer_extract_cli.py \
  tools/data-refinery/tests/subject_strategies/test_natural_sciences.py \
  tools/data-refinery/tests/subject_strategies/test_english.py
git commit -m "feat(refinery): 透传答案解析 issue 并保护零命中流程"
```

---

### Task 8: 语料回归、全量验证与文档同步

**Files:**
 - Modify: `docs/constraints/数据管线.md`
 - Modify: `docs/ai-core-changelog.md`
 - Test: `tools/data-refinery/tests/test_answer_block_corpus.py`

**Interfaces:**
 - Consumes: all completed block parsing interfaces
 - Produces: regression coverage for Miyun, Shunyi, Changping, Mentougou, Shijingshan
 - Produces: documentation of the new single answer parsing path

 - [ ] **Step 1: 写真实版式语料回归**

```python
# tools/data-refinery/tests/test_answer_block_corpus.py
from pathlib import Path

from subject_strategies import get_strategy


def _answers(text: str, subject: str = "math") -> dict[int, str]:
    results = get_strategy(subject).extract_answers(
        text,
        Path(f"{subject}/初中/first/2025/试卷.md"),
    )
    return {item.no: item.answer for item in results if item.no > 0}


def test_miyun_numeric_fill_blank_answers_are_complete():
    text = (
        "9. 第 9 题\n10. 第 10 题\n11. 第 11 题\n12. 第 12 题\n"
        "13. 第 13 题\n14. 第 14 题\n15. 第 15 题\n16. 第 16 题\n\n"
        "# 参考答案\n\n"
        "二、填空题(...)9. (-1,-2) 10.x1=4，x2=-4 11. <\n\n" \
        "12.2（本题答案不唯一） $1 3 . 2(1+x)^2=5.8$ 14. $\\sqrt{3}$ " \
        "15. $20^\\circ$ 16. ① 2 ②1 ${ \\leqslant } m { \\leqslant } 4$"
    )
    got = _answers(text)
    assert got[9] == "(-1,-2)"
    assert got[10] == "x1=4，x2=-4"
    assert got[11] == "<"
    assert got[12] == "2（本题答案不唯一）"
    assert got[13] == "2(1+x)^2=5.8"


def test_second_answer_block_keeps_first_compact_answers():
    text = (
        "1. 第 1 题\n2. 第 2 题\n3. 第 3 题\n\n"
        "# 参考答案\n\n"
        "## 一、选择题\n\n"
        "1. B 2. C 3. A\n\n"
        "1. 答案：B\n解析：说明一\n\n"
        "3. 答案：A\n解析：说明三\n"
    )
    got = _answers(text)
    assert got[1] == "B"
    assert got[2] == "C"
    assert got[3] == "A"
```

 - [ ] **Step 2: 跑语料回归**

Run: `cd tools/data-refinery && python3 -m pytest tests/test_answer_block_corpus.py -q`

Expected: 全部 PASS。

 - [ ] **Step 3: 跑全量 Python 测试**

Run: `cd tools/data-refinery && python3 -m pytest -q`

Expected: 全部通过；若数量与基线不同，只能是新增测试导致。

 - [ ] **Step 4: 检查答案游标已完全移出切题内核**

Run: `cd tools/data-refinery && rg -n "current_answer_n|last_answer_n" src/question_splitter.py`

Expected: 0 行输出。

 - [ ] **Step 5: 检查真实密云卷**

Run:

```bash
cd tools/data-refinery && python3 src/answer_extract_cli.py \
  --file "数学-初三(上)-202507-密云-期末-试卷" --dry-run
```

Expected: 9–13 均有答案，不再从 8 跳到 14。

 - [ ] **Step 6: 更新数据管线约束**

在 `docs/constraints/数据管线.md` 的答案解析章节加入：

```markdown
**答案区必须按块解析（2026-11-25）**：`question_splitter` 只负责定位答案区，
表格、裸选择、统一编号块和未知块由 `answer_blocks.py` / `answer_region.py`
处理。禁止恢复 `current_answer_n` / `last_answer_n` 逐行游标。多个独立答案块对
同一题遵循“第一套非空答案优先”；不能确定边界时整块不猜并写 issue。
```

 - [ ] **Step 7: 更新 changelog**

在 `docs/ai-core-changelog.md` 顶部增加本次实施记录，必须包含：

```markdown
- 根因：9–16 题答案常以标题同行、网格、公式内题号等形式出现，旧行级状态机
  无法稳定区分答案数字和下一题题号。
- 改动：答案区改为表格 / 裸选择 / 统一编号 / 未知块解析，并按题干题号做覆盖校验。
- 验证：密云 2025 数学 Q9–13 恢复；`git diff --check`、全量 pytest、真实卷 dry-run。
```

 - [ ] **Step 8: 最终检查与 Commit**

Run: `git diff --check`

Run: `cd tools/data-refinery && python3 -m pytest -q`

Expected: 无 diff 错误，全部测试通过。

```bash
git add docs/constraints/数据管线.md docs/ai-core-changelog.md \
  tools/data-refinery/tests/test_answer_block_corpus.py
git commit -m "test(refinery): 固化答案解析块级语料回归并同步文档"
```

---

## Execution Notes

- Task 1 的表格迁移必须逐字保留现有表格解析行为；不要顺手重构。
- Task 2 的扫描器只负责分块，不在这一任务实现所有题号规则。
- Task 3 是误判风险最高的一步；先让密云、自然数答案、小数的正反例通过。
- Task 4 的“第一套优先”必须在块级执行，不能放在行内解析器里。
- Task 5 的语文 adapter 必须迁移旧状态机，不得用新规则近似替代。
- Task 6 完成后，`split_page` 只保留题干职责；任何答案游标命中都是失败。
- Task 7 的 sentinel 只用于“答案区存在但零命中”，不能把所有空答案误当失败。
- Task 8 不跑数据库覆盖；只验证生成结果。实际入库按单卷 dry-run 后执行。

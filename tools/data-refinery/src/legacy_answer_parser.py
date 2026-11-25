"""语文第一阶段兼容适配：保留重构前的行级答案状态机。"""

import re

from answer_blocks import (
    AnswerFragment,
    AnswerIssue,
    AnswerLine,
    AnswerParseResult,
    AnswerQuestion,
    is_answer_structure_line,
    parse_answer_table,
)
from question_splitter import (
    _BARE_ANSWER_STEM_RE,
    _strip_main_stem_prefix,
    is_answer_keyword,
    is_main_stem,
)


_ANSWER_MARK_RE = re.compile(
    r'^\s*(?:答案(?:示例|要点)?\s*\d*\s*[:：]\s*|(?:解|证明|原式|原不等式组)[：:]\s*)'
)
_TRAILING_SCORE_RE = re.compile(r'[（(]\s*(?:共)?\s*\d+(?:\.\d+)?\s*分\s*[）)]\s*$')
_INLINE_STEM_RE = re.compile(r'(?<!\d)(\d{1,2})[.．]\D')
_INLINE_ANSWER_MARKER_RE = re.compile(
    r"(?<!\d)(?P<number>\d{1,2})(?:(?P<dot>[.．])\s*|\s+)(?=\S)"
)
_INLINE_MATH_SPAN_RE = re.compile(r"\$\$.*?\$\$|\$[^$\n]*\$")
_COMPACT_ANSWER_KEY_RE = re.compile(r"^\s*([A-Da-d]+(?:\s+[A-Da-d])+)\s*$")
_GLUED_ANSWER_RE = re.compile(
    r"(?<!\d)(?P<number>\d{1,2})\s*[.．]\s*"
    r"(?:(?:答案|解|证明)[：:]\s*"
    r"|(?=[（(]\s*\d{1,2}\s*[）)]\s*(?:答案|解|证明)))"
)
_SCORE_SPLIT_ANSWER_RE = re.compile(
    r"(?P<score>\d{1,2}\s*分)\s*"
    r"(?=(?:解|证明|答案)[：:]\s*[（(]\s*1\s*[）)])"
)


def _strip_answer_prefix(text: str) -> str:
    text = _ANSWER_MARK_RE.sub('', text.strip(), count=1)
    while True:
        stripped = _TRAILING_SCORE_RE.sub('', text).rstrip()
        if stripped == text:
            return text
        text = stripped


def split_inline_stems(line: str) -> list[tuple[int, str]]:
    if '\\begin{' in line or '\\end{' in line:
        return []
    if '![](' in line:
        return []
    if re.search(r'解[：:]|证明[：:]|∵|∴|\\therefore|\\because', line):
        return []
    matches = list(_INLINE_STEM_RE.finditer(line))
    if not matches:
        return []
    results: list[tuple[int, str]] = []
    for i, match in enumerate(matches):
        start = match.end() - 1
        end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
        results.append((int(match.group(1)), line[start:end].strip()))
    return results


def _mask_inline_math(line: str) -> str:
    return _INLINE_MATH_SPAN_RE.sub(lambda match: " " * len(match.group(0)), line)


def split_inline_fill_blank_answers(
    line: str, expected_start: int
) -> list[tuple[int, str]]:
    masked = _mask_inline_math(line)
    markers: list[tuple[int, int, int]] = []
    cursor = 0
    expected = expected_start
    while True:
        match = _INLINE_ANSWER_MARKER_RE.search(line, cursor)
        if match is None:
            break
        number = int(match.group("number"))
        if number != expected:
            cursor = match.start() + 1
            continue
        if not masked[match.start():match.end("number")].strip():
            cursor = match.end()
            continue
        if match.group("dot") is None and match.start() > 0 \
                and masked[match.start() - 1] not in " \t；;。":
            cursor = match.start() + 1
            continue
        markers.append((number, match.start(), match.end()))
        cursor = match.end()
        expected += 1
    if len(markers) < 2:
        return []
    results: list[tuple[int, str]] = []
    for i, (number, _, content_start) in enumerate(markers):
        next_start = markers[i + 1][1] if i + 1 < len(markers) else len(line)
        results.append((number, line[content_start:next_start].strip()))
    return results


def split_compact_answer_key(line: str) -> list[str]:
    match = _COMPACT_ANSWER_KEY_RE.match(line)
    if match is None:
        return []
    return re.findall(r"[A-Da-d]", match.group(1))


def _split_glued_answers(
    line: str, current_number: int
) -> tuple[str, list[tuple[int, str]]] | None:
    masked = _mask_inline_math(line)
    markers: list[re.Match[str]] = []
    expected = current_number + 1
    for match in _GLUED_ANSWER_RE.finditer(masked):
        if int(match.group("number")) != expected:
            continue
        markers.append(match)
        expected += 1
    if not markers:
        return None
    head = line[:markers[0].start()].rstrip()
    parts: list[tuple[int, str]] = []
    for i, match in enumerate(markers):
        end = markers[i + 1].start() if i + 1 < len(markers) else len(line)
        parts.append((int(match.group("number")), line[match.end():end].strip()))
    return head, parts


def _split_score_prefixed_answer(
    line: str,
    current_number: int,
    question_numbers: set[int],
) -> tuple[str, str] | None:
    if current_number + 1 not in question_numbers:
        return None
    match = _SCORE_SPLIT_ANSWER_RE.search(line)
    if match is None:
        return None
    head = line[:match.end()].rstrip()
    tail = line[match.end():].strip()
    if not tail:
        return None
    return head, tail


def _run_legacy_state_machine(
    lines: list[str],
    question_numbers: set[int],
) -> dict[int, str]:
    answers: dict[int, str] = {}
    current_lines: list[str] = []
    current_no: int | None = None
    last_no = 0

    def filled(number: int) -> bool:
        return bool(answers.get(number, "").strip())

    def flush() -> None:
        nonlocal current_lines, current_no, last_no
        if current_no is None or not current_lines:
            current_lines = []
            current_no = None
            return
        answer = _strip_answer_prefix("\n".join(current_lines))
        if answers.get(current_no):
            answers[current_no] += "\n" + answer
        else:
            answers[current_no] = answer
        last_no = max(last_no, current_no)
        current_lines = []
        current_no = None

    for line in lines:
        if is_answer_keyword(line) and not re.match(r"^\s*#{0,6}\s*\d", line):
            continue
        if is_answer_structure_line(line):
            continue
        inline = split_inline_stems(line)
        fill_blank = split_inline_fill_blank_answers(line, last_no + 1)
        if len(fill_blank) > len(inline):
            inline = fill_blank
        ok, number = is_main_stem(line)
        if not ok:
            bare = _BARE_ANSWER_STEM_RE.match(line)
            if bare and int(bare.group(1)) > last_no:
                ok, number = True, int(bare.group(1))

        compact = split_compact_answer_key(line)
        if compact:
            flush()
            for letter in compact:
                target = last_no + 1
                if not filled(target):
                    current_no = target
                    current_lines = [letter]
                    flush()
            current_no = None
            continue

        if "<table>" in line or "<table " in line:
            table_answers = parse_answer_table(line)
            if table_answers:
                flush()
                for table_no, answer in table_answers.items():
                    current_no = table_no
                    current_lines = [answer]
                    flush()
                current_no = None
            elif current_no is not None:
                current_lines.append(line)
            continue

        if inline:
            fresh = [
                (stem_no, text)
                for stem_no, text in inline
                if stem_no > last_no
                or (_ANSWER_MARK_RE.match(text.strip()) and not filled(stem_no))
            ]
            if not fresh:
                if any(
                    _ANSWER_MARK_RE.match(text.strip()) and filled(stem_no)
                    for stem_no, text in inline
                ):
                    flush()
                elif current_no is not None:
                    current_lines.append(line)
                continue
            flush()
            if len(fresh) == 1:
                current_no = fresh[0][0]
                current_lines = [fresh[0][1]]
                last_no = max(last_no, current_no)
            else:
                for stem_no, text in fresh:
                    current_no = stem_no
                    current_lines = [text]
                    flush()
                current_no = None
            continue

        if ok and number is not None:
            rest = _strip_main_stem_prefix(line)
            if number <= last_no:
                if _ANSWER_MARK_RE.match(rest.strip()):
                    flush()
                    if not filled(number):
                        current_no = number
                        current_lines = [rest]
                elif current_no is not None:
                    current_lines.append(line)
                continue
            flush()
            current_no = number
            current_lines = [rest] if rest else []
            last_no = max(last_no, number)
            glued = _split_glued_answers(rest, number)
            if glued is not None:
                head, parts = glued
                current_lines = [head] if head else []
                for answer_no, answer_text in parts:
                    flush()
                    current_no = answer_no
                    current_lines = [answer_text] if answer_text else []
                    last_no = max(last_no, answer_no)
            else:
                score_split = _split_score_prefixed_answer(
                    rest, number, question_numbers
                )
                if score_split is not None:
                    head, tail = score_split
                    current_lines = [head] if head else []
                    flush()
                    current_no = number + 1
                    current_lines = [tail]
                    last_no = max(last_no, current_no)
            continue

        if current_no is None:
            continue
        glued = _split_glued_answers(line, current_no)
        if glued is not None:
            head, parts = glued
            if head:
                current_lines.append(head)
            for answer_no, answer_text in parts:
                flush()
                current_no = answer_no
                current_lines = [answer_text] if answer_text else []
                last_no = max(last_no, answer_no)
            continue
        score_split = _split_score_prefixed_answer(
            line, current_no, question_numbers
        )
        if score_split is None:
            current_lines.append(line)
            continue
        head, tail = score_split
        next_no = current_no + 1
        if head:
            current_lines.append(head)
        flush()
        current_no = next_no
        current_lines = [tail]
        last_no = max(last_no, current_no)

    flush()
    return {number: text for number, text in answers.items() if text.strip()}


def legacy_parse_answer_lines(
    answer_lines: list[AnswerLine],
    questions: list[AnswerQuestion],
    *,
    first_line_no: int,
) -> AnswerParseResult:
    fragment_map = _run_legacy_state_machine(
        [line.text for line in answer_lines],
        {question.no for question in questions},
    )
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
    issues = [
        AnswerIssue(
            code="answer_missing",
            severity="error",
            message=f"第 {number} 题没有解析出答案",
            question_no=number,
            line_start=first_line_no,
            line_end=first_line_no + max(0, len(answer_lines) - 1),
            excerpt="",
        )
        for number in sorted({question.no for question in questions} - set(fragment_map))
    ]
    return AnswerParseResult(fragments=fragments, blocks=[], issues=issues)

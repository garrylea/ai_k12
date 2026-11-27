"""答案区编排：块解析、首套答案优先与完整覆盖校验。"""

import re
from dataclasses import replace

from answer_blocks import (
    AnswerBlock,
    AnswerFragment,
    AnswerIssue,
    AnswerLine,
    AnswerParseResult,
    AnswerQuestion,
    answer_table_numbers,
    parse_answer_table,
    parse_compact_choice,
    parse_numbered_block,
    prepare_answer_lines,
    split_answer_blocks,
)
from answer_sections import split_answer_sections


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


def _block_span(block: AnswerBlock) -> tuple[int, int, str]:
    return (
        block.lines[0].line_no,
        block.lines[-1].line_no,
        "\n".join(line.text for line in block.lines),
    )


def _parse_block(
    block: AnswerBlock,
    questions: list[AnswerQuestion],
    assigned_numbers: set[int],
) -> tuple[list[AnswerFragment], list[AnswerIssue]]:
    expected = [
        number
        for number in _group_numbers(block, questions)
        if number not in assigned_numbers
    ]
    line_start, line_end, text = _block_span(block)

    if block.kind == "compact_choice":
        return parse_compact_choice(block, expected)

    if block.kind == "numbered":
        fragments, issues = parse_numbered_block(block, expected)
        for number in sorted(assigned_numbers):
            if re.search(rf"(?m)^\s*{number}\s*[.．]", text):
                issues.append(AnswerIssue(
                    code="answer_duplicate_ignored",
                    severity="warning",
                    message=f"第 {number} 题已有首套答案，后续独立答案块已忽略",
                    question_no=number,
                    line_start=line_start,
                    line_end=line_end,
                    excerpt=text[:200],
                ))
        return fragments, issues

    if block.kind == "table":
        answers = parse_answer_table(text)
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
        line_start=line_start,
        line_end=line_end,
        excerpt=text[:200],
    )]


def _duplicate_issue(
    fragment: AnswerFragment,
) -> AnswerIssue:
    return AnswerIssue(
        code="answer_duplicate_ignored",
        severity="warning",
        message=f"第 {fragment.question_no} 题已有首套答案，后续独立答案块已忽略",
        question_no=fragment.question_no,
        line_start=fragment.line_start,
        line_end=fragment.line_end,
        excerpt=fragment.text[:200],
    )


def _split_fragment(
    fragment: AnswerFragment,
) -> tuple[AnswerFragment | None, list[AnswerIssue]]:
    sections = split_answer_sections(fragment.text)
    if sections.issues:
        return None, [AnswerIssue(
            code="answer_sections_ambiguous",
            severity="error",
            message=(
                f"第 {fragment.question_no} 题题解分段无法安全拆分："
                f"{', '.join(sections.issues)}"
            ),
            question_no=fragment.question_no,
            line_start=fragment.line_start,
            line_end=fragment.line_end,
            excerpt=fragment.text[:200],
        )]
    return replace(
        fragment,
        text=sections.answer,
        approach=sections.approach,
        explanation=sections.explanation,
    ), []


def parse_answer_region(
    lines: list[AnswerLine],
    questions: list[AnswerQuestion],
    *,
    first_line_no: int,
) -> AnswerParseResult:
    """把答案区解析为每题首套答案，并为所有期望题号做覆盖校验。"""
    prepared = prepare_answer_lines(
        [line.text for line in lines],
        first_line_no=first_line_no,
    )
    blocks = split_answer_blocks(prepared, questions)
    assigned: dict[int, str] = {}
    fragments: list[AnswerFragment] = []
    issues: list[AnswerIssue] = []

    for block in blocks:
        block_fragments, block_issues = _parse_block(
            block, questions, set(assigned)
        )
        issues.extend(block_issues)
        for fragment in block_fragments:
            normalized, split_issues = _split_fragment(fragment)
            issues.extend(split_issues)
            if normalized is None:
                continue
            fragment = normalized
            if fragment.question_no in assigned:
                issues.append(_duplicate_issue(fragment))
                continue
            assigned[fragment.question_no] = fragment.text
            fragments.append(fragment)

    expected = {question.no for question in questions}
    last_line = first_line_no + max(0, len(lines) - 1)
    for number in sorted(expected - set(assigned)):
        issues.append(AnswerIssue(
            code="answer_missing",
            severity="error",
            message=f"第 {number} 题没有解析出答案",
            question_no=number,
            line_start=first_line_no,
            line_end=last_line,
            excerpt="",
        ))

    if expected and not assigned:
        issues.append(AnswerIssue(
            code="answer_region_no_assignments",
            severity="error",
            message="答案区存在但未解析出任何答案",
            question_no=None,
            line_start=first_line_no,
            line_end=last_line,
            excerpt="\n".join(line.text for line in lines)[:200],
        ))

    return AnswerParseResult(fragments=fragments, blocks=blocks, issues=issues)

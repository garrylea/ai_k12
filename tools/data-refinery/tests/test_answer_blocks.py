from answer_blocks import (
    AnswerBlock,
    AnswerIssue,
    AnswerLine,
    AnswerQuestion,
    parse_compact_choice,
    parse_numbered_block,
    parse_answer_table,
    prepare_answer_lines,
    split_answer_blocks,
)
from answer_region import parse_answer_region
from subject_strategies import get_strategy


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


def test_prepare_keeps_group_header_and_same_line_answers():
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


CHINESE_ANSWER_PAPER = """# 参考答案

1. 答案：B

2. 答案：C
"""


def test_chinese_parse_answers_adapter_keeps_existing_result():
    strategy = get_strategy("chinese")
    result = strategy.parse_answers(
        [
            AnswerLine(i + 1, line)
            for i, line in enumerate(CHINESE_ANSWER_PAPER.splitlines())
        ],
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

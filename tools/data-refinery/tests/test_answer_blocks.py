from answer_blocks import (
    AnswerBlock,
    AnswerIssue,
    AnswerLine,
    AnswerQuestion,
    parse_answer_table,
    prepare_answer_lines,
    split_answer_blocks,
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

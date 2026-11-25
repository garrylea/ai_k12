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

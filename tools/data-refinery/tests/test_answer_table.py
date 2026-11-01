"""答案表格解析：按版式分派（双标签 / 单标签 / 无表头 / 纵向），不按位置猜。

事故背景（2026-11-01）：北师大实验 2024 物理卷的答案表是「数字行 + 答案行」无表头
布局，旧实现无条件跳过每行第 0 格（那是「题号/答案」标签位），于是第 1 题答案 C
被整格丢掉，且只读前两行 → 11–15 题也没答案。入库后第 1 题是错的 D（更早一次
人工/旧文档写入），人对着原卷才发现。
"""

from question_splitter import parse_answer_table


def test_headerless_two_row_table_keeps_first_question():
    """无表头：第一格就是题号 1，一格都不能丢。"""
    line = (
        "<table>"
        "<tr><td>1</td><td>2</td><td>3</td><td>4</td></tr>"
        "<tr><td>C</td><td>D</td><td>A</td><td>A</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {1: "C", 2: "D", 3: "A", 4: "A"}


def test_headerless_multi_pair_table_reads_all_pairs():
    """一张表里有多组「数字行 + 答案行」时，不能只读前两行。

    真实表（北师大实验 2024 物理）第三行末尾还带 rowspan/colspan 合并格。
    """
    line = (
        "<table>"
        "<tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td><td>9</td><td>10</td></tr>"
        "<tr><td>C</td><td>D</td><td>A</td><td>A</td><td>A</td><td>C</td><td>B</td><td>C</td><td>A</td><td>C</td></tr>"
        '<tr><td>11</td><td>12</td><td>13</td><td>14</td><td>15</td><td rowspan="2" colspan="5"></td></tr>'
        "<tr><td>B</td><td>D</td><td>C</td><td>A</td><td>C</td></tr>"
        "</table>"
    )
    got = parse_answer_table(line)
    assert got[1] == "C"
    assert got[15] == "C"
    assert got[11] == "B" and got[12] == "D" and got[13] == "C" and got[14] == "A"


def test_double_label_table_skips_both_label_cells():
    """双标签：题号行/答案行各有一个标签格，两行都要丢第 0 格。"""
    line = (
        "<table>"
        "<tr><td>题号</td><td>1</td><td>2</td><td>3</td></tr>"
        "<tr><td>答案</td><td>A</td><td>B</td><td>D</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {1: "A", 2: "B", 3: "D"}


def test_single_label_table_does_not_drop_answer_cell():
    """单标签：只有数字行带「题号」标签，答案行没有标签格 → 不能跟着丢一格。"""
    line = (
        "<table>"
        "<tr><td>题号</td><td>1</td><td>2</td><td>3</td></tr>"
        "<tr><td>A</td><td>B</td><td>D</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {1: "A", 2: "B", 3: "D"}


def test_any_label_word_is_stripped_not_just_tihao():
    """标签词不固定：数学卷实测用「选项」而不是「答案」，一样要认。"""
    line = (
        "<table>"
        "<tr><td>题号</td><td>1</td><td>2</td><td>3</td></tr>"
        "<tr><td>选项</td><td>D</td><td>C</td><td>B</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {1: "D", 2: "C", 3: "B"}


def test_vertical_table_is_read_row_by_row():
    """纵向逐行：题号|答案 一行一对，表头行跳过。"""
    line = (
        "<table>"
        "<tr><td>题号</td><td>答案</td></tr>"
        "<tr><td>1</td><td>A</td></tr>"
        "<tr><td>2</td><td>BC</td></tr>"
        "<tr><td>3</td><td>D</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {1: "A", 2: "BC", 3: "D"}


def test_math_data_table_is_not_an_answer_key():
    """答案段里的数学数据表（x/…/0/1/2/3 + 数值行）不是答案表，必须整表跳过。

    旧实现会把 0/1/2/3 当题号、把表里的数值当答案写进第 1–3 题。
    """
    line = (
        "<table>"
        "<tr><td>x</td><td>...</td><td>0</td><td>1</td><td>2</td><td>3</td></tr>"
        "<tr><td>y</td><td>...</td><td>0</td><td>1</td><td>4</td><td>9</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {}


def test_count_mismatch_writes_nothing_for_that_pair():
    """数字行 4 个题号、答案行只 3 个 → 这一对不写（宁空不猜），不产生错位。"""
    line = (
        "<table>"
        "<tr><td>1</td><td>2</td><td>3</td><td>4</td></tr>"
        "<tr><td>C</td><td>D</td><td>A</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {}

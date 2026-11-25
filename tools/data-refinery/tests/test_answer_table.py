"""答案表格解析：按版式分派（选择题 / 填空题 / 横向 / 纵向），不按位置猜。

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


def test_spaced_multiselect_answers_in_horizontal_table_are_compacted():
    """西城 2026 期末物理卷：多选答案格用空格分隔（B D / A B C）。

    旧正则 ^[A-D]{1,4}$ 不接受空格 → 整组 16–20 被静默跳过（单选单字母正常，
    故只有多选题全丢）。必须压成连续字母再校验、入库。
    """
    line = (
        "<table>"
        "<tr><td>题号</td><td>16</td><td>17</td><td>18</td><td>19</td><td>20</td></tr>"
        "<tr><td>答案</td><td>B D</td><td>A D</td><td>A B C</td><td>C D</td><td>A B D</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {
        16: "BD", 17: "AD", 18: "ABC", 19: "CD", 20: "ABD",
    }


def test_spaced_multiselect_answers_in_vertical_table_are_compacted():
    """纵向表同样要认空格分隔的多选答案。"""
    line = (
        "<table>"
        "<tr><td>题号</td><td>答案</td></tr>"
        "<tr><td>16</td><td>B D</td></tr>"
        "<tr><td>17</td><td>A B C</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {16: "BD", 17: "ABC"}


def test_labeled_horizontal_fill_blank_table_keeps_formula_answers():
    """昌平 2026 数学：填空题答案行是公式/数值/比较符，不能只认 A-D。

    原实现把整张 9-16 题答案表判成非答案表，导致答案文档从第 8 题直接跳到
    第 17 题。HTML 实体 ``&lt;`` 也必须在入库前还原成 ``<``。
    """
    line = (
        "<table>"
        "<tr><td>题号</td><td>9</td><td>10</td><td>11</td><td>12</td>"
        "<td>13</td><td>14</td><td>15</td><td>16</td></tr>"
        "<tr><td>答案</td><td> $\\frac{1}{9}$ </td>"
        "<td> $y=x^{2}+1$ (答案不唯一)</td><td>&lt;</td>"
        "<td> $4\\sqrt{2}$ </td><td> $150\\sqrt{3}$ </td>"
        "<td>8</td><td>35</td><td>123</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {
        9: "$\\frac{1}{9}$",
        10: "$y=x^{2}+1$ (答案不唯一)",
        11: "<",
        12: "$4\\sqrt{2}$",
        13: "$150\\sqrt{3}$",
        14: "8",
        15: "35",
        16: "123",
    }


def test_repeated_labeled_fill_blank_groups_are_both_read():
    """同一张填空答案表有多组「题号行 + 答案行」时，两组都要提取。"""
    line = (
        "<table>"
        "<tr><td>题号</td><td>9</td><td>10</td><td>11</td><td>12</td></tr>"
        "<tr><td>答案</td><td>(4,-1)</td><td> $y=x^{2}$ </td><td>直线x=-3</td>"
        "<td> $x_{1}=2,x_{2}=-8$ </td></tr>"
        "<tr><td>题号</td><td>13</td><td>14</td><td>15</td><td>16</td></tr>"
        "<tr><td>答案</td><td> $k\\leq 1$ 且 $k\\neq 0$ </td><td>8</td>"
        "<td> $2\\sqrt{2}$ </td><td>21,4</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {
        9: "(4,-1)",
        10: "$y=x^{2}$",
        11: "直线x=-3",
        12: "$x_{1}=2,x_{2}=-8$",
        13: "$k\\leq 1$ 且 $k\\neq 0$",
        14: "8",
        15: "$2\\sqrt{2}$",
        16: "21,4",
    }


def test_colspan_header_merges_all_answer_cells_for_that_question():
    """门头沟 2025 数学：第 16 题题号横跨两列，两个答案格都必须归第 16 题。

    旧解析只按格数对齐，把 8 个题号和 9 个答案判成列数不齐，整张
    9–16 题答案表被静默跳过。
    """
    line = (
        "<table>"
        "<tr><td>题号</td><td>9</td><td>10</td><td>11</td><td>12</td>"
        "<td>13</td><td>14</td><td>15</td><td colspan=\"2\">16</td></tr>"
        "<tr><td>答案</td><td>(-2,3)</td><td>六</td><td>略</td>"
        "<td> $\\frac{1}{2}$ </td><td> $130^{\\circ}$ </td><td>3</td>"
        "<td>1,4</td><td>略</td><td>A,B,E</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {
        9: "(-2,3)",
        10: "六",
        11: "略",
        12: "$\\frac{1}{2}$",
        13: "$130^{\\circ}$",
        14: "3",
        15: "1,4",
        16: "略；A,B,E",
    }


def test_grid_cells_with_embedded_question_numbers_are_answers():
    """石景山 2025 数学：每个答案格自带「题号. 答案」，没有题号行。

    旧解析只支持「题号行 + 答案行」和纵向「题号|答案」两种结构，这张
    9–16 题表因此整张被当成非答案表，答案文档从 8 直接跳到 17。
    """
    line = (
        "<table>"
        "<tr><td>9. 4:9</td><td>10.  $\\frac{1}{2}$ </td>"
        "<td>11. 1</td><td>12. 500</td></tr>"
        "<tr><td>13. 答案不唯一,如: $y = -x^{2}$ </td>"
        "<td>14.  $\\frac{1}{4}$ </td><td>15. 8</td>"
        "<td>16. (1) $\\frac{1}{4}$ ; (2) $\\frac{5}{12}$ .</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {
        9: "4:9",
        10: "$\\frac{1}{2}$",
        11: "1",
        12: "500",
        13: "答案不唯一,如: $y = -x^{2}$",
        14: "$\\frac{1}{4}$",
        15: "8",
        16: "(1) $\\frac{1}{4}$ ; (2) $\\frac{5}{12}$ .",
    }


def test_unlabeled_non_choice_data_table_is_still_not_an_answer_key():
    """无「答案」标签的数值表不能因为新增自由文本支持而误判。"""
    line = (
        "<table>"
        "<tr><td>1</td><td>2</td><td>3</td></tr>"
        "<tr><td>10</td><td>20</td><td>30</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {}


def test_blank_corner_numeric_data_table_is_not_an_answer_key():
    """空角格不能成为自由文本答案表的放行条件，否则统计表仍会被误判。"""
    line = (
        "<table>"
        "<tr><td></td><td>1</td><td>2</td></tr>"
        "<tr><td></td><td>10</td><td>20</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {}


def test_blank_answer_label_does_not_unlock_freeform_values():
    """有「题号」行但答案行首格为空时，无法证明是答案表，不能猜。"""
    line = (
        "<table>"
        "<tr><td>题号</td><td>1</td><td>2</td></tr>"
        "<tr><td></td><td>10</td><td>20</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {}


def test_vertical_fill_blank_table_keeps_formula_answers():
    """纵向「题号|答案」表也要支持非 A-D 答案。"""
    line = (
        "<table>"
        "<tr><td>题号</td><td>答案</td></tr>"
        "<tr><td>9</td><td>$\\frac{1}{9}$</td></tr>"
        "<tr><td>10</td><td>8</td></tr>"
        "</table>"
    )
    assert parse_answer_table(line) == {9: "$\\frac{1}{9}$", 10: "8"}

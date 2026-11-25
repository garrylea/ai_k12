"""数学/物理/化学：显式登记，行为与 generic 一致（图选项走 A–D 同一套规则）。"""

from pathlib import Path

import pytest

from subject_strategies import get_strategy
from subject_strategies.types import NO_MATERIAL


@pytest.mark.parametrize("code", ["math", "physics", "chemistry"])
def test_registered_with_own_code(code):
    s = get_strategy(code)
    assert s.code == code
    assert s.material_policy() == NO_MATERIAL


@pytest.mark.parametrize("code", ["math", "physics", "chemistry"])
def test_split_options_abcd(code):
    content = "下列说法正确的是\nA. 甲\nB. 乙\nC. 丙\nD. 丁"
    stem, opts = get_strategy(code).split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]
    assert "下列说法正确的是" in stem


def test_physics_sub_question_is_not_a_stem():
    """物理实验题 '21.（1）…' 里的小问号不算主题号。"""
    assert get_strategy("physics").is_stem("21.（1）如图甲所示")[0] is True
    assert get_strategy("physics").is_stem("（1）如图甲所示")[0] is False


def test_math_extracts_all_fill_blank_answers_from_html_table():
    """数学填空题答案表要完整进入答案提取结果，不能从第 8 题跳到第 17 题。"""
    text = """9. 第 9 题
10. 第 10 题
11. 第 11 题
12. 第 12 题
13. 第 13 题
14. 第 14 题
15. 第 15 题
16. 第 16 题

## 数学试卷参考答案及评分标准

<table><tr><td>题号</td><td>9</td><td>10</td><td>11</td><td>12</td><td>13</td><td>14</td><td>15</td><td>16</td></tr><tr><td>答案</td><td> $\\frac{1}{9}$ </td><td> $y=x^{2}+1$ (答案不唯一)</td><td>&lt;</td><td> $4\\sqrt{2}$ </td><td> $150\\sqrt{3}$ </td><td>8</td><td>35</td><td>123</td></tr></table>
"""
    answers = get_strategy("math").extract_answers(
        text,
        Path("数学/初中/first/2026/数学-初三(上)-202607-昌平-期末-试卷.md"),
    )
    by_no = {item.no: item.answer for item in answers}

    assert [by_no[no] for no in range(9, 17)] == [
        "$\\frac{1}{9}$",
        "$y=x^{2}+1$ (答案不唯一)",
        "<",
        "$4\\sqrt{2}$",
        "$150\\sqrt{3}$",
        "8",
        "35",
        "123",
    ]

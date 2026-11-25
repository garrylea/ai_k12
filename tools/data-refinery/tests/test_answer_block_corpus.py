"""块级答案解析的真实版式回归。"""

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
        "二、填空题(...)9. (-1,-2) 10.x1=4，x2=-4 11. <\n\n"
        "12.2（本题答案不唯一） $1 3 . 2(1+x)^2=5.8$ 14. $\\sqrt{3}$ "
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

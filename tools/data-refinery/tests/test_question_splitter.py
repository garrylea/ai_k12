from pathlib import Path

from question_splitter import (
    is_date_trap, is_group_header, is_main_stem,
    is_sub_stem, is_answer_keyword, split_inline_stems,
)
from question_splitter import split_page, RawQuestion
from question_splitter import _strip_main_stem_prefix


def test_is_date_trap_matches_year_dot_month():
    assert is_date_trap("2026.5")
    assert is_date_trap("  2026.7")


def test_is_date_trap_rejects_question_number():
    assert not is_date_trap("9. 若代数式")
    assert not is_date_trap("9.5 之类的纯数字小数在题号行首也不会出现，但保险")


def test_is_main_stem_with_space():
    ok, n = is_main_stem("9. 若代数式 ...")
    assert ok and n == 9


def test_is_main_stem_without_space():
    ok, n = is_main_stem("9.若代数式 ...")
    assert ok and n == 9


def test_is_main_stem_with_formula_after_dot():
    ok, n = is_main_stem(r"9. $\frac{1}{x-3}$ 有意义")
    assert ok and n == 9


def test_is_main_stem_rejects_4digit_year():
    ok, _ = is_main_stem("2026.5")
    assert not ok  # 4 位数不在 1-2 位范围


def test_is_main_stem_rejects_decimal():
    ok, _ = is_main_stem("9.5")
    assert not ok  # . 后是数字，不是 \D


def test_is_sub_stem_half_and_full_width():
    assert is_sub_stem("(1) 求证")
    assert is_sub_stem("（2）解：")
    assert not is_sub_stem("9. 若代数式")


def test_is_group_header():
    ok, gid = is_group_header("三、解答题（共68分，第17-19题每题5分）")
    assert ok and gid == "三"
    ok, _ = is_group_header("9. 若代数式")
    assert not ok


def test_is_answer_keyword():
    assert is_answer_keyword("参考答案")
    assert is_answer_keyword("数学答案及评分参考")
    assert is_answer_keyword("二、答案")
    assert not is_answer_keyword("9. 若代数式")


def test_split_inline_stems_one_line_multiple():
    line = r"9. $x \neq 3$ 10. $3a(x-1)^2$ 11. $x = \frac{2}{3}$"
    result = split_inline_stems(line)
    assert len(result) == 3
    assert result[0][0] == 9
    assert r"x \neq 3" in result[0][1]
    assert result[1][0] == 10
    assert r"3a(x-1)^2" in result[1][1]
    assert result[2][0] == 11
    assert r"\frac{2}{3}" in result[2][1]


def test_split_inline_stems_no_match():
    assert split_inline_stems("无题号的纯文字") == []


def test_split_page_single_question():
    text = "9. 若代数式 $\\frac{1}{x-3}$ 有意义, 则实数 $x$ 的取值范围是 ____."
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert result[0].group_order == 9
    assert result[0].content.startswith("若代数式")  # 主题号"9."剥离
    assert "9." not in result[0].content[:5]


def test_split_page_two_questions():
    text = (
        "9. 若代数式 $\\frac{1}{x-3}$ 有意义, 则实数 $x$ 的取值范围是 ____.\n"
        "10. 分解因式: $3ax^{2} - 6ax + 3a = $ ____."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 2
    assert result[0].group_order == 9
    assert result[1].group_order == 10
    assert result[0].content.startswith("若代数式")
    assert result[1].content.startswith("分解因式")


def test_split_page_sub_questions_merged_into_parent():
    """小问号 (1)(2) 合并到上一个主题号 content。"""
    text = (
        "16. 某商店共有 $a$ 种不同型号的口罩...\n"
        "(1) 若 m=69, n=71，则 a 的值为 ____\n"
        "(2) 若丙购买的口罩包含三种颜色, 则丙用于购买白色和蓝色的口罩最多一共花费 ____ 元."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1  # 小问没切分，合并到第 16 题
    assert result[0].group_order == 16
    assert "(1) 若 m=69" in result[0].content
    assert "(2) 若丙购买" in result[0].content


def test_split_page_group_header_assigns_group_id():
    """大题分组标题行关闭当前题，记 group_id，标题行丢弃。"""
    text = (
        "8. 最后一道选择题 ...\n"
        "二、填空题（本题共 8 小题）\n"
        "9. 若代数式 ... 有意义 ..."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 2
    assert result[0].group_order == 8
    assert result[0].group_id is None  # 第一题前面没分组标题
    assert result[1].group_order == 9
    assert result[1].group_id == "二"  # 第二题归属"二"组
    assert "填空题" not in result[0].content  # 标题行没混进第 8 题
    assert "填空题" not in result[1].content  # 也没混进第 9 题


def test_split_page_date_trap_filtered():
    """日期行 2026.5 不当作题号。"""
    text = (
        "2026.5\n"
        "9. 若代数式 ..."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert result[0].group_order == 9


def test_split_page_empty_text():
    assert split_page("", Path("test.md")) == []


def test_split_page_preserves_image_refs():
    """图片引用 ![](path) 原样保留在 content。"""
    text = "3. 如图 ![图形](images/abc.jpg) 所示, 直线 $AB$ 与 $CD$ 相交于点 $O$."
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert "![图形](images/abc.jpg)" in result[0].content


def test_strip_main_stem_prefix_with_space():
    assert _strip_main_stem_prefix("9. 若代数式") == "若代数式"


def test_strip_main_stem_prefix_without_space():
    assert _strip_main_stem_prefix("9.若代数式") == "若代数式"


def test_strip_main_stem_prefix_with_formula():
    assert _strip_main_stem_prefix(r"9. $\frac{1}{x-3}$") == r"$\frac{1}{x-3}$"


def test_answer_alignment_compact_format():
    """紧凑格式：选择题/填空题答案一行多题号。"""
    text = (
        "9. 若代数式 $\\frac{1}{x-3}$ 有意义, 则实数 $x$ 的取值范围是 ____.\n"
        "10. 分解因式: $3ax^{2} - 6ax + 3a = $ ____.\n"
        "参考答案\n"
        "9. $x \\neq 3$ 10. $3a(x - 1)^2$"
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 2
    assert result[0].answer == r"$x \neq 3$"
    assert result[1].answer == r"$3a(x - 1)^2$"


def test_answer_alignment_expanded_format():
    """展开格式：解答题答案一题一段，含'解：'前缀，剥离前缀只留内容。"""
    text = (
        "17. 计算: $(\\frac{1}{3})^{-1} + 4\\sin 45^{\\circ} - \\sqrt{18} - (\\pi - 2026)^{0}$.\n"
        "参考答案\n"
        "17. 解: $3 + 4 \\times \\frac{\\sqrt{2}}{2} - 3\\sqrt{2} - 1 = 2$."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert result[0].answer == r"$3 + 4 \times \frac{\sqrt{2}}{2} - 3\sqrt{2} - 1 = 2$."
    assert "解:" not in result[0].answer  # "解："前缀剥离


def test_answer_alignment_multiline_answer():
    """答案跨多行，按下一题号起点切，自然包含多行。"""
    text = (
        "18. 解不等式组: $\\left\\{ ... \\right.$\n"
        "参考答案\n"
        "18. 解: 原不等式组为 $\\left\\{ ... \\right.$\n"
        "由不等式①得 $x > -3$\n"
        "由不等式②得 $x \\leq 2$\n"
        "所以原不等式组的解集为 $-3 < x \\leq 2$."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert "原不等式组为" in result[0].answer
    assert "解集为" in result[0].answer


def test_answer_alignment_sub_questions_merged():
    """一题多小问的答案（20题 (1)(2)(3)）合并到该题 answer。"""
    text = (
        "20. 如图, 在 Rt△ABC 中...\n"
        "(1) 求证: 四边形 AEBD 是平行四边形\n"
        "(2) 若 BE=2, 求 AB 的长\n"
        "参考答案\n"
        "20. (1) 证明: ∵ AE⊥AC, ...\n"
        "(2) 解: ∵ 在 Rt△ABC 中, ..."
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert "证明: ∵ AE⊥AC" in result[0].answer
    assert "解: ∵ 在 Rt△ABC" in result[0].answer


def test_answer_alignment_missing_answer_stays_empty():
    """答案区没出现的题，answer 留空。"""
    text = (
        "9. 第一题\n"
        "10. 第二题\n"
        "参考答案\n"
        "9. 第一题答案"
        # 10 题没给答案
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 2
    assert result[0].answer == "第一题答案"
    assert result[1].answer == ""


def test_answer_keyword_only_section_header():
    """'参考答案' 关键字行本身丢弃，不进任何题 content。"""
    text = (
        "9. 题干\n"
        "参考答案\n"
        "9. 答案"
    )
    result = split_page(text, Path("test.md"))
    assert len(result) == 1
    assert "参考答案" not in result[0].content
    assert "参考答案" not in result[0].answer

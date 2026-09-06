from question_splitter import (
    is_date_trap, is_group_header, is_main_stem,
    is_sub_stem, is_answer_keyword, split_inline_stems,
)


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

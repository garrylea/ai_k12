from pathlib import Path

from question_splitter import (
    is_date_trap, is_group_header, is_main_stem,
    is_sub_stem, is_answer_keyword, split_inline_stems,
)
from question_splitter import split_page, RawQuestion
from question_splitter import _strip_main_stem_prefix
from subject_strategies import get_strategy


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


def test_is_main_stem_accepts_space_before_year():
    # 西城北京四中 2024 期中题12：「12. 2024 年 4 月 25 日，搭载着神舟十八号…」
    # 空格后是 4 位年份，不能被「空格+数字」的子题号护栏挡掉，否则整题被上一题吞掉
    ok, n = is_main_stem("12. 2024 年 4 月 25 日，搭载着神舟十八号载人飞船的长征二号 F 遥十八运载火箭")
    assert ok and n == 12


def test_is_main_stem_rejects_split_sub_number():
    # 昌平一中 2024：'1.1 材料' 被 OCR 拆成 '1. 1 材料'，不能当成主题号
    ok, _ = is_main_stem("1. 1 材料")
    assert not ok


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
    assert is_answer_keyword("# 丰台区2025年...数学试卷参考答案")
    assert not is_answer_keyword("二、答案")  # 单独"答案"不匹配（"试题答案"会误匹配）
    assert not is_answer_keyword("3. 试题答案一律填涂或书写在答题卡上")  # 考生须知里的"答案"
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


# === 分数解析 ===

from question_splitter import parse_group_scores


def test_parse_group_scores_unified():
    """'每题2分' → 组内统一分。"""
    kind, val = parse_group_scores("## 一、选择题（共16分，每题2分）")
    assert kind == "unified"
    assert val == 2


def test_parse_group_scores_unified_halfwidth():
    """半角括号/逗号也能解析。"""
    kind, val = parse_group_scores("## 一、选择题(共16分,每题2分)")
    assert kind == "unified"
    assert val == 2


def test_parse_group_scores_map_range():
    """'第17-19题每题5分' → 范围展开为逐题 map。"""
    kind, val = parse_group_scores("三、解答题（共68分，第17-19题每题5分，第24题6分）")
    assert kind == "map"
    assert val[17] == 5 and val[18] == 5 and val[19] == 5
    assert val[24] == 6


def test_parse_group_scores_map_adjacent_range():
    """'第20-21题每题6分，第22-23题每题5分' → 相邻题同分用范围。"""
    kind, val = parse_group_scores(
        "三、解答题（共68分，第17-19题每题5分，第20-21题每题6分，第22-23题每题5分，"
        "第24题6分，第25题5分，第26题6分，第27-28题每题7分）"
    )
    assert kind == "map"
    assert val[20] == 6 and val[21] == 6  # 20-21 每题 6 分
    assert val[22] == 5 and val[23] == 5  # 22-23 每题 5 分
    assert val[27] == 7 and val[28] == 7
    assert sum(val.values()) == 68  # 解答题小计 68


def test_parse_group_scores_none():
    """'解答题(共78分)' 无逐题分 → none。"""
    kind, val = parse_group_scores("## 三、解答题（共78分）")
    assert kind == "none"
    assert val is None


def test_split_page_fills_score():
    """切题时每题 score 从分组标题填入。"""
    text = (
        "## 一、选择题（共16分，每题2分）\n"
        "1. 题干一 (A) (B)\n"
        "2. 题干二\n"
        "## 二、填空题（共16分，每题2分）\n"
        "9. 填空一\n"
        "## 三、解答题（共68分，第17-19题每题5分，第24题6分）\n"
        "17. 解答一\n"
        "24. 解答八\n"
        "参考答案\n"
        "1. A 2. B\n"
        "9. 答案\n"
        "17. 解：过程\n"
        "24. 解：过程"
    )
    result = split_page(text, Path("test.md"))
    by_order = {q.group_order: q for q in result}
    assert by_order[1].score == 2
    assert by_order[2].score == 2
    assert by_order[9].score == 2
    assert by_order[17].score == 5
    assert by_order[24].score == 6


# ---------- split_options ----------

from question_splitter import split_options


def test_split_options_inline_no_trailing():
    """纯行内选项（题干+ABCD 同一行）：无尾部内容，题干/选项原样拆开。"""
    content = "下列结论中正确的是 (A) $c > a$ (B) $b + c > 0$ (C) 1 (D) 2"
    stem, opts = split_options(content)
    assert stem == "下列结论中正确的是"
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]
    assert opts[0]["text"] == "$c > a$"
    assert opts[3]["text"] == "2"


def test_split_options_trailing_image_goes_to_stem():
    """行内选项 + 尾部题干配图（西城模拟二 题3 真实格式）：
    D 选项文本止于 (D) 所在行行尾，之后的尾部内容（图片等）归题干。"""
    content = (
        "如图, 直线 $AB$ 与直线 $CD$ 相交于点 $O$ , 则 $\\angle AOE$ 的大小为 "
        "(A) $25^{\\circ}$ (B) $35^{\\circ}$ (C) $45^{\\circ}$ (D) $55^{\\circ}$\n"
        "![](images/9630d93f.jpg)"
    )
    stem, opts = split_options(content)
    assert opts[3]["text"] == "$55^{\\circ}$"  # D 不吞尾部图片
    assert "![](images/9630d93f.jpg)" in stem  # 图片归题干
    assert "$\\angle AOE$" in stem


def test_split_options_trailing_multiline_to_stem():
    """尾部内容多行（图片+文字）整体归题干，D 只取所在行剩余部分。"""
    content = (
        "主视图是 (A) 甲 (B) 乙 (C) 丙 (D) 丁\n"
        "![](images/a.jpg)\n"
        "备注文字"
    )
    stem, opts = split_options(content)
    assert opts[3]["text"] == "丁"
    assert "![](images/a.jpg)" in stem
    assert "备注文字" in stem


def test_split_options_vertical_option_images_stay():
    """竖排选项（标记跨行，各选项自配图在标记行之间）：图留在各自选项内，
    D 取到 content 末尾（自配图不被截走归题干）。"""
    content = (
        "主视图是\n"
        "(A)\n![](images/opt_a.jpg)\n"
        "(B)\n![](images/opt_b.jpg)\n"
        "(C)\n![](images/opt_c.jpg)\n"
        "(D)\n![](images/opt_d.jpg)"
    )
    stem, opts = split_options(content)
    assert opts[0]["text"] == "![](images/opt_a.jpg)"
    assert opts[1]["text"] == "![](images/opt_b.jpg)"
    assert opts[2]["text"] == "![](images/opt_c.jpg)"
    assert opts[3]["text"] == "![](images/opt_d.jpg)"
    assert stem == "主视图是"


def test_split_options_not_choice_returns_none():
    """非选择题（无 ABCD 连续标记）：原样返回 (content, None)。"""
    content = "解不等式组并写出解集"
    stem, opts = split_options(content)
    assert stem == content
    assert opts is None


# ---------- split_options：裸字母格式（A. / A 无括号） ----------


def test_split_options_bare_inline():
    """行内裸字母 '题干 A. x B. y C. z D. w'（东城卷格式）：拆开且无尾部。"""
    content = "估计 $1 + \\sqrt{5}$ 的值在 A. 1 和 2 之间 B. 2 和 3 之间 C. 3 和 4 之间 D. 4 和 5 之间"
    stem, opts = split_options(content)
    assert stem == "估计 $1 + \\sqrt{5}$ 的值在"
    assert opts[0]["text"] == "1 和 2 之间"
    assert opts[3]["text"] == "4 和 5 之间"


def test_split_options_bare_inline_trailing_image_to_stem():
    """行内裸字母 + 尾部题干配图 + '[图]' 占位符（东城2025 题2 真实格式）：
    图归题干，D 行尾的 '[图]' 占位符剥掉。"""
    content = (
        "如图, 直线 $AB, CD$ 交于点 $O$ , 则 $\\angle 2$ 的度数为 "
        "A. $55^\\circ$ B. $45^\\circ$ C. $35^\\circ$ D. $30^\\circ$ [图]\n"
        "![](images/94086eed.jpg)"
    )
    stem, opts = split_options(content)
    assert opts[3]["text"] == "$30^\\circ$"  # '[图]' 剥掉
    assert "![](images/94086eed.jpg)" in stem  # 图归题干


def test_split_options_bare_vertical_image_above_label():
    """竖排裸字母、图片在标记上方（东城2026 题1 真实格式：
    '图\\nA\\n图\\nB\\n图\\nC\\n图\\nD'，D 后无内容）：字母标在图下方，
    每个选项取它上方紧邻的图，stem 不吞 A 的图。"""
    content = (
        "下列几何图形中, 既是中心对称图形也是轴对称图形的是\n"
        "![](images/opt_a.jpg)\nA\n"
        "![](images/opt_b.jpg)\nB\n"
        "![](images/opt_c.jpg)\nC\n"
        "![](images/opt_d.jpg)\nD"
    )
    stem, opts = split_options(content)
    assert stem == "下列几何图形中, 既是中心对称图形也是轴对称图形的是"
    assert opts[0]["text"] == "![](images/opt_a.jpg)"
    assert opts[1]["text"] == "![](images/opt_b.jpg)"
    assert opts[2]["text"] == "![](images/opt_c.jpg)"
    assert opts[3]["text"] == "![](images/opt_d.jpg)"


def test_split_options_paren_vertical_image_above_label():
    """括号竖排、图片在标记上方 + 题干自配图（西城2026 题1 真实格式：
    '题干\\n题干图\\nA图\\n(A)\\nB图\\n(B)\\nC图\\n(C)\\nD图\\n(D)'）：
    各选项取上方紧邻图，题干图留在 stem。"""
    content = (
        "如右图是喜庆集会时所击的鼓的立体图形, 则这个图形的主视图是\n"
        "![](images/stem_drum.jpg)\n"
        "![](images/opt_a.jpg)\n(A)\n"
        "![](images/opt_b.jpg)\n(B)\n"
        "![](images/opt_c.jpg)\n(C)\n"
        "![](images/opt_d.jpg)\n(D)"
    )
    stem, opts = split_options(content)
    assert "![](images/stem_drum.jpg)" in stem
    assert "主视图是" in stem
    assert opts[0]["text"] == "![](images/opt_a.jpg)"
    assert opts[1]["text"] == "![](images/opt_b.jpg)"
    assert opts[2]["text"] == "![](images/opt_c.jpg)"
    assert opts[3]["text"] == "![](images/opt_d.jpg)"


def test_split_options_bare_vertical_label_above_image():
    """竖排裸字母带点、标记在上图在下（2024西城 题2 真实格式：
    'A.\\n图\\nB.\\n图\\nC.\\n图\\nD.\\n图'，D 后有图）：标记后跟自配图。"""
    content = (
        "下列4个图形中，是中心对称图形的是( )\n"
        "A.\n![](images/a.jpg)\n"
        "B.\n![](images/b.jpg)\n"
        "C.\n![](images/c.jpg)\n"
        "D.\n![](images/d.jpg)"
    )
    stem, opts = split_options(content)
    assert "是中心对称图形的是" in stem
    assert opts[0]["text"] == "![](images/a.jpg)"
    assert opts[1]["text"] == "![](images/b.jpg)"
    assert opts[2]["text"] == "![](images/c.jpg)"
    assert opts[3]["text"] == "![](images/d.jpg)"


def test_split_options_bare_multiline_marks():
    """裸字母跨行分布（'A. x B. y\\nC. z D. w'，东城2025 题4 格式）：
    标记跨行 → D 取到末尾。"""
    content = (
        "一元二次方程 $2x^{2} - 3x + 1 = 0$ 的根的情况是\n"
        "A. 有两个相等的实数根 B. 有两个不相等的实数根\n"
        "C. 只有一个实数根 D. 没有实数根"
    )
    stem, opts = split_options(content)
    assert stem.endswith("的根的情况是")
    assert opts[0]["text"] == "有两个相等的实数根"
    assert opts[1]["text"] == "有两个不相等的实数根"
    assert opts[2]["text"] == "只有一个实数根"
    assert opts[3]["text"] == "没有实数根"


def test_split_options_crossline_marks_trailing_image_to_stem():
    """跨行括号标记（'(A)(B)' 一行、'(C)(D)' 下一行）+ D 行后题干配图
    （海淀2026 模拟二 题1 真实格式）：A/B/C 都无图 → 尾部图归题干，不进 D。

    原默认分支 'D 取到末尾' 会把这俩题干配图错送给 D。方案 B：A/B/C 同构
    无图时，D 只吃本行剩余，尾部内容并入题干（镜像行内布局）。"""
    content = (
        "右图是某几何体的三视图，该几何体是\n"
        "(A) 圆柱 (B) 圆锥\n"
        "(C) 三棱柱 (D) 长方体\n"
        "\n"
        "![](images/stem1.jpg)\n"
        "\n"
        "![](images/stem2.jpg)"
    )
    stem, opts = split_options(content)
    assert opts[0]["text"] == "圆柱"
    assert opts[1]["text"] == "圆锥"
    assert opts[2]["text"] == "三棱柱"
    assert opts[3]["text"] == "长方体"  # D 不吞尾部图
    assert "![](images/stem1.jpg)" in stem  # 图归题干
    assert "![](images/stem2.jpg)" in stem
    assert "右图是某几何体的三视图" in stem


def test_split_options_crossline_marks_with_option_images_stay():
    """跨行标记 + A/B/C 各含自配图 + D 自配图：D 自配图保留不送给题干
    （方案 B 回归保护：A/B/C 含图时不动 D 的尾部，沿用默认 'D 取到末尾'）。"""
    content = (
        "主视图是\n"
        "(A) 甲\n![](images/opt_a.jpg)\n"
        "(B) 乙\n![](images/opt_b.jpg)\n"
        "(C) 丙\n![](images/opt_c.jpg)\n"
        "(D) 丁\n![](images/opt_d.jpg)"
    )
    stem, opts = split_options(content)
    assert opts[0]["text"] == "甲\n![](images/opt_a.jpg)"
    assert opts[1]["text"] == "乙\n![](images/opt_b.jpg)"
    assert opts[2]["text"] == "丙\n![](images/opt_c.jpg)"
    assert opts[3]["text"] == "丁\n![](images/opt_d.jpg)"  # D 自配图保留
    assert stem == "主视图是"


def test_split_options_enumeration_abcd_not_split():
    """题干里的枚举 'A、B、C、D 四点'（顿号后无空格）不当作选项。"""
    content = "如图, A、B、C、D 四点在圆上, 求证: 四边形 $ABCD$ 是正方形."
    stem, opts = split_options(content)
    assert stem == content
    assert opts is None


def test_split_options_content_above_with_caption():
    """内容在标记上方 + 说明文字（物理昌平 题2 真实格式：
    '图\\n说明文字\\nA\\n图\\n说明\\nB\\n...\\n图\\n说明\\nD'）：图+说明整体归
    各自标记，stem 只留题干文本。"""
    content = (
        "如图所示的光现象中, 由于光的反射形成的是\n"
        "![](images/a.jpg)\n桥在水中形成的倒影\nA\n"
        "![](images/b.jpg)\n日晷上呈现针的影子\nB\n"
        "![](images/c.jpg)\n透过放大镜看到放大的图案\nC\n"
        "![](images/d.jpg)\n人透过水球所成的像\nD"
    )
    stem, opts = split_options(content)
    assert stem == "如图所示的光现象中, 由于光的反射形成的是"
    assert opts[0]["text"] == "![](images/a.jpg)\n桥在水中形成的倒影"
    assert opts[1]["text"] == "![](images/b.jpg)\n日晷上呈现针的影子"
    assert opts[2]["text"] == "![](images/c.jpg)\n透过放大镜看到放大的图案"
    assert opts[3]["text"] == "![](images/d.jpg)\n人透过水球所成的像"


def test_split_page_part_header_closes_question():
    """'## 第二部分 非选择题' 部分标题：关闭当前题、标题行不混入题 content，
    后续题归下一个大题分组。"""
    text = (
        "8. 以下四个结论：\n"
        "(A) ①④ (B) ②③ (C) ①②④ (D) ①②③④\n"
        "## 第二部分 非选择题\n"
        "## 二、填空题（共16分，每题2分）\n"
        "9. 若代数式有意义"
    )
    result = split_page(text, Path("test.md"))
    by_order = {q.group_order: q for q in result}
    assert len(result) == 2
    # 题8 content 不带 '## 第二部分 非选择题' 污染
    assert "第二部分" not in by_order[8].content
    assert "## 第二部分" not in by_order[8].content
    # 题9 归属大题分组"二"（部分标题不占用分组）
    assert by_order[9].group_id == "二"


def test_is_main_stem_year_after_dot():
    """题号 + 年份格式 '6.2025年3月14日...'：. 后是 4 位年份+中文，当题号。"""
    ok, n = is_main_stem("6.2025年3月14日是第六个国际数学日")
    assert ok and n == 6


def test_is_main_stem_colon_format():
    """题号冒号格式 '21: 在平面直角坐标系...'：当题号。"""
    ok, n = is_main_stem("21: 在平面直角坐标系 $xOy$ 中")
    assert ok and n == 21


def test_strip_main_stem_prefix_colon_and_year():
    """剥离 '21:' 与 '6.2025年' 前缀。"""
    assert _strip_main_stem_prefix("21: 在平面直角坐标系") == "在平面直角坐标系"
    assert _strip_main_stem_prefix("6.2025年3月14日") == "2025年3月14日"


def test_split_page_ambiguous_stem_state_machine():
    """状态机：选择题区行首 '6.2025年3月14日...'（疑似小数）后跟 '7.' 题号
    → 6.xxx 是题号，拆出题6。"""
    text = (
        "## 第一部分 选择题\n"
        "## 一、选择题（共16分，每题2分）\n"
        "5. 第五题 (A) 1 (B) 2 (C) 3 (D) 4\n"
        "6.2025年3月14日是第六个国际数学日。某学校策划了三个挑战活动, 如果两人每人随机选择参加其中一个活动, 则她们恰好选到同一个活动的概率是\n"
        "7. 第七题 (A) 甲 (B) 乙 (C) 丙 (D) 丁"
    )
    result = split_page(text, Path("test.md"))
    by_order = {q.group_order: q for q in result}
    assert 6 in by_order
    assert by_order[6].content.startswith("2025年3月14日")
    assert "概率是" in by_order[6].content
    assert by_order[6].group_id == "一"


def test_split_page_colon_stem():
    """题号冒号格式 '21: 在平面直角坐标系...'：拆出题21（非选择题区）。"""
    text = (
        "## 第二部分 非选择题\n"
        "## 三、解答题（共68分）\n"
        "20. 第二十题\n"
        "21: 在平面直角坐标系 $xOy$ 中, 一次函数\n"
        "(1) 求 $k; b$ 的值;\n"
        "22. 第二十二题"
    )
    result = split_page(text, Path("test.md"))
    by_order = {q.group_order: q for q in result}
    assert 21 in by_order
    assert by_order[21].content.startswith("在平面直角坐标系")
    assert "(1) 求" in by_order[21].content
    assert "20. 第二十题" not in by_order[21].content


def test_is_main_stem_fullwidth_dot():
    """语文参考答案全角句点 '1．C（2 分）'：当题号（U+FF0E）。"""
    ok, n = is_main_stem("1．C（2 分）")
    assert ok and n == 1
    ok, n = is_main_stem("8．益慕圣贤之道（1分。有错该空不得分）")
    assert ok and n == 8


def test_strip_main_stem_prefix_fullwidth_dot():
    assert _strip_main_stem_prefix("8．益慕圣贤之道") == "益慕圣贤之道"


def test_split_page_fullwidth_dot_answers():
    """语文卷答案段全角题号：答案按题号对齐，不漂移、不丢。"""
    text = (
        "1. 第一题题干\n"
        "2. 第二题题干\n"
        "# 参考答案\n"
        "## 一、基础·运用（共 4 分）\n"
        "1．C（2 分）\n"
        "2．示例：集知识性、创新性、趣味性于一体的科技盛会。（共 2分）"
    )
    result = split_page(text, Path("test.md"))
    by_order = {q.group_order: q for q in result}
    assert by_order[1].answer == "C（2 分）"
    assert by_order[2].answer.startswith("示例：集知识性")
    assert "一、基础" not in by_order[2].answer


def test_split_page_mixed_half_and_fullwidth_dots():
    """同页答案半角/全角题号混排：都能识别。"""
    text = (
        "1. 第一题\n"
        "2. 第二题\n"
        "3. 第三题\n"
        "# 参考答案\n"
        "1．A（2 分）\n"
        "2. B（2 分）\n"
        "3．C"
    )
    result = split_page(text, Path("test.md"))
    by_order = {q.group_order: q for q in result}
    assert by_order[1].answer == "A（2 分）"
    assert by_order[2].answer == "B（2 分）"
    assert by_order[3].answer == "C"


def test_inline_group_header_split_from_stem():
    """OCR 把下一节标题粘在题干末尾：题干去掉标题，后续题归新分组。"""
    text = (
        "## 三、名著阅读（5 分）\n"
        "16. 名著题题干（100 字左右）四、现代文阅读（共 23分）\n"
        "材料一 某段材料\n"
        "17. 第一题\n"
        "18. 第二题\n"
    )
    result = split_page(text, Path("test.md"))
    by_order = {q.group_order: q for q in result}
    assert "现代文阅读" not in by_order[16].content
    assert "100 字左右" in by_order[16].content
    assert by_order[16].group_id == "三"
    assert by_order[17].group_id == "四"
    assert by_order[18].group_id == "四"


def test_inline_group_header_on_continuation_line():
    text = (
        "## 三、名著阅读（5 分）\n"
        "16. 名著题题干\n"
        "续行文字三、语言文字运用（共 10分）\n"
        "17. 下一题\n"
    )
    result = split_page(text, Path("test.md"))
    by_order = {q.group_order: q for q in result}
    assert "语言文字运用" not in by_order[16].content
    assert "续行文字" in by_order[16].content
    assert by_order[17].group_id == "三"


def test_attach_material_section_scoped():
    """attach_material：材料按（一）（二）分块，只归本节题；不跨节污染。"""
    text = (
        "## 四、现代文阅读（共 10 分）\n"
        "（一）（共 5 分）\n"
        "材料一 甲材料 ![](images/a.jpg)\n"
        "17. 第一题\n"
        "18. 第二题\n"
        "（二）（共 5 分）\n"
        "材料二 乙材料\n"
        "19. 第三题\n"
    )
    result = split_page(text, Path("test.md"), strategy=get_strategy("chinese"))
    by_order = {q.group_order: q for q in result}
    assert "甲材料" in by_order[17].material_text
    assert "images/a.jpg" in by_order[17].material_text
    assert "甲材料" in by_order[18].material_text
    assert "乙材料" in by_order[19].material_text
    assert "甲材料" not in by_order[19].material_text
    # 材料不重复进题干
    assert "甲材料" not in by_order[17].content


def test_attach_material_off_by_default():
    text = "## 一、选择题\n材料一 甲材料\n1. 第一题\n"
    result = split_page(text, Path("test.md"))
    assert result[0].material_text is None


def test_material_heads_accumulate_before_first_stem():
    """材料一/二/三 连续出现时并入同一批（不能各自开新集）。"""
    text = (
        "## 四、现代文阅读（共 9 分）\n"
        "材料一 甲\n"
        "材料二 乙\n"
        "材料三 丙\n"
        "17. 第一题\n"
        "18. 第二题\n"
    )
    result = split_page(text, Path("test.md"), strategy=get_strategy("chinese"))
    by_order = {q.group_order: q for q in result}
    for no in (17, 18):
        assert "甲" in by_order[no].material_text
        assert "乙" in by_order[no].material_text
        assert "丙" in by_order[no].material_text


def test_inline_group_header_closes_current_question():
    """行内标题之后是下一节材料：材料不能被吞进上一题题干。"""
    text = (
        "## 三、名著阅读（5 分）\n"
        "16. 名著题题干四、现代文阅读（共 8 分）\n"
        "## 材料一\n"
        "正文段落\n"
        "17. 第一题\n"
    )
    result = split_page(text, Path("test.md"), strategy=get_strategy("chinese"))
    by_order = {q.group_order: q for q in result}
    assert by_order[16].content == "名著题题干"
    assert "正文段落" not in by_order[16].content
    assert "正文段落" in by_order[17].material_text


def test_split_options_bare_inline_glued_after_punctuation():
    """语文卷无空格裸字母选项：'…的一项是(2分)A.甲 B.乙 C.丙 D.丁'。"""
    content = "下列成语使用不恰当的一项是(2分)A.呼之欲出 B.恰到好处 C.条分缕析 D.耳目一新"
    stem, opts = split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]
    assert opts[0]["text"] == "呼之欲出"
    assert stem.endswith("(2分)")


def test_split_options_bare_inline_after_chinese_punctuation():
    """选项紧跟句号/逗号也不能漏拆（题17/24 同类格式）。"""
    content = "下列说法不符合文意的一项是。A.甲项。B.乙项。C.丙项。D.丁项。"
    stem, opts = split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C", "D"]


def test_split_options_chinese_three_cn_labels():
    """语文 3 选项 + 甲乙丙：必须拆出 3 项，label 归一 A/B/C，原标签保留。"""
    content = (
        "阅读全文，下列说法不恰当的一项是（2分）\n"
        "【甲】第②段举北斗卫星团队中青年人的例子，证明了青年人要珍惜时间。\n"
        "【乙】第④段“宝剑锋从磨砺出”论证人生道路上总会遇到荆棘坎坷。\n"
        "【丙】第⑤段引用习近平总书记的话，意在证明奋斗无止境。"
    )
    stem, opts = get_strategy("chinese").split_options(content)
    assert [o["label"] for o in opts] == ["A", "B", "C"]
    assert [o["original_label"] for o in opts] == ["甲", "乙", "丙"]
    assert "北斗卫星" in opts[0]["text"]
    assert "奋斗无止境" in opts[2]["text"]


def test_split_options_chinese_three_latin_labels():
    """语文 3 选项 + A/B/C：不能再要求必须 4 项。"""
    content = "你认为发言有误的学生是(2分)A.小兴 B.小红 C.小明"
    _, opts = get_strategy("chinese").split_options(content)
    assert [o["text"] for o in opts] == ["小兴", "小红", "小明"]


def test_split_options_math_still_requires_four():
    """数学默认规则不变：只有 3 个 A/B/C 时不拆（避免误判非选择题）。"""
    content = "你认为正确的是(2分)A.甲 B.乙 C.丙"
    assert split_options(content)[1] is None
    assert get_strategy("chinese").split_options(content)[1] is not None


def test_material_title_between_questions_moves_block():
    """两题之间的「文段标题 + 长段落」应归下一题材料，不能并进上一题正文。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "一、基础运用（共 10 分）\n"
        "绿绸叠翠\n\n"
        "登鼓楼南望，青翠如绸，绿意绵延，勾勒出丰盈通达的中轴绿廊。驻足于小巷人家，"
        "极具老北京情调的葫芦、丝瓜爬满藤架，处处绿意盎然。\n\n"
        "4.文段中的画线句存在问题，请你修改。(2分）\n\n"
        "流光溢彩\n\n"
        "夜幕降临，北京城的大街小巷都沉浸在五彩斑斓的灯海中。这夜京城从黑到亮再到靓，"
        "历经了上百年，【甲】建国十周年之际路灯遍及北京大街小巷。【乙】林立的摩天大楼霓虹闪烁。\n\n"
        "5.小组成员对【甲】【乙】两处使用的标点疑问，你认为正确的一项是（2分）"
        "A.【甲】；【乙】； B.【甲】；【乙】，C.【甲】。【乙】； D.【甲】。【乙】，\n"
    )
    questions = split_page(text, _Path("x.md"), strategy=get_strategy("chinese"))
    q4 = next(q for q in questions if q.group_order == 4)
    q5 = next(q for q in questions if q.group_order == 5)
    assert "夜幕降临" not in q4.content
    assert q5.material_text and "夜幕降临" in q5.material_text
    assert "【甲】" in q5.material_text and "【乙】" in q5.material_text


def test_part_header_starts_new_material_scope():
    """「第一部分 北京城市发展史上的水源问题」是材料分区，不是题型分区：
    其后正文必须归下一题材料，不能沿用上一部分的「前言」。
    东直门 2024 题3/5/6 因沿用前言，被模型判「材料不完整」。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "一、基础·运用（共13分）\n\n"
        "前言 江河与文明\n\n"
        "如果说水是生命之源，江河就是承载生命流动的血脉，人类文明起源于江河。\n\n"
        "1. 请用正楷字书写这十二个字。（1分）\n\n"
        "2. 对文段中画波浪线词语判断正确的一项是（2分）\n"
        "A. 起源 B. 滔滔 C. 奔踊 D. 广袤\n\n"
        "第一部分 北京城市发展史上的水源问题\n\n"
        "北京城早期城市功能有限，对地表水源的需求不多。10世纪初叶以后，北京逐步发展"
        "成为一个全国性的政治中心，城市功能渐趋复杂化。\n\n"
        "北京的水源存蓄，经历了【甲】【乙】【丙】的过程。\n\n"
        "3. 为文中【甲】【乙】【丙】三处选择词语最恰当的一项是（2分）\n"
        "A.修库 疏道 造河 B.造河 疏道 修库\n\n"
        "第三部分 北京河流的新变化\n\n"
        "亮马河曾是一条平平无奇的河流，这确是行之有效的，游客络绎不绝，令人心旷神怡。\n\n"
        "4. 下列成语使用不恰当的一项是（2分）\n"
        "A. 行之有效 B. 持之以恒\n"
    )
    questions = split_page(text, _Path("x.md"), strategy=get_strategy("chinese"))

    q2 = next(q for q in questions if q.group_order == 2)
    q3 = next(q for q in questions if q.group_order == 3)
    q4 = next(q for q in questions if q.group_order == 4)

    assert "前言" in q2.material_text and "【甲】" not in q2.material_text
    assert "第一部分" in q3.material_text and "【甲】" in q3.material_text
    assert "第三部分" in q4.material_text and "行之有效" in q4.material_text


def test_incomplete_option_label_run_is_not_split():
    """OCR 丢了 B 的点号（A. ① B ② C. ③ D. ④）时不能拿 C/D 当选项：
    否则 C/D 被重编号成 A/B，A/B 的内容并进题干，学生看到错位选项。"""
    from question_splitter import split_options

    content = "其中未使用修辞方法的一句是(2分)\nA. ① B ② C. ③ D. ④"
    stem, opts = get_strategy("chinese").split_options(content)
    assert opts is None
    assert stem == content          # 原文完整保留，交标注判缺陷


def test_complete_four_labels_still_split():
    from question_splitter import split_options

    _, opts = get_strategy("chinese").split_options("题干\nA. ① B. ② C. ③ D. ④")
    assert [o["text"] for o in opts] == ["①", "②", "③", "④"]


def test_chinese_cn_labels_as_blank_placeholders_not_options():
    """【甲】【乙】【丙】三处填空（题干无选择提示）不能拆成 A/B/C 选项：
    拆了会把三段正文当选项，题干只剩「任务三」。"""
    from question_splitter import split_options

    content = (
        "任务三：品悟情感内涵\n"
        "我的分析：（共 3 分）\n"
        "【甲】文张岱记「崇祯五年」雪夜独往湖心亭看雪，表现他遗世独立的高洁情怀。\n"
        "【乙】文高濂雪后独登镇海楼赏积雪炊烟，表达他赏景的愉悦满足。\n"
        "【丙】诗中「孤舟」「独钓」写出柳宗元内心的孤寂。"
    )
    assert get_strategy("chinese").split_options(content)[1] is None


def test_chinese_cn_labels_with_choice_hint_are_options():
    from question_splitter import split_options

    content = (
        "阅读全文，下列说法不恰当的一项是（2分）\n"
        "【甲】第②段举北斗卫星团队的例子，证明青年人要珍惜时间。\n"
        "【乙】第④段论证人生道路上总会遇到荆棘坎坷。\n"
        "【丙】第⑤段引用名言证明奋斗无止境。"
    )
    _, opts = get_strategy("chinese").split_options(content)
    assert len(opts) == 3
    assert [o["original_label"] for o in opts] == ["甲", "乙", "丙"]


def test_glued_next_stem_is_split_out():
    """MinerU 把选项行和下一题合成一行（'…楼房。16.根据材料三…'）时，
    题16 不能消失、也不能留在题15 的选项 D 里。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "一、基础·运用（共13分）\n\n"
        "15.根据以上三则材料，下列情况不成立的是（2分）\n"
        "A.甲 B.乙 C.丙 D.70年代中期，建筑工人在北京旧城内新建的建筑大多为 6层以下楼房。"
        "16.根据材料三的图文信息，在文中横线处补写恰当的内容。（2分）答：\n\n"
        "17.为以上三则材料分别选择最恰当的小标题。（3分）\n"
    )
    questions = split_page(text, _Path("x.md"))

    assert [q.group_order for q in questions] == [15, 16, 17]
    q15 = next(q for q in questions if q.group_order == 15)
    q16 = next(q for q in questions if q.group_order == 16)
    assert "16.根据材料三" not in q15.content
    assert "根据材料三的图文信息" in q16.content


def test_exam_notice_numbers_are_not_split():
    """卷首考试说明（'150分钟。2.在试卷…'）不能被当成题号。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "本试卷满分100分。考试时间150分钟。2.在试卷和答题卡上准确填写学校名称。"
        "3.试题答案一律填涂或书写在答题纸上。\n\n"
        "一、基础·运用（共13分）\n\n"
        "1.下列词语中加点字读音正确的是（2分）\nA.甲 B.乙 C.丙 D.丁\n"
    )
    questions = split_page(text, _Path("x.md"))
    assert [q.group_order for q in questions] == [1]


def test_stem_with_sub_number_without_dot():
    """'8（1）转朱阁…'：题号后直接跟小问号，OCR 丢了点。不能把题8 整题丢掉。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "7. 文段中的画线句存在问题，请你修改。（2分）\n\n"
        "8（1）转朱阁，____，照无眠。（苏轼《水调歌头》）（1分）\n"
        "(2) ____，愁云惨淡万里凝。（岑参《白雪歌送武判官归京》）（1分）\n\n"
        "9. 下列加点字意思相同的一项是（2分）\nA.甲 B.乙 C.丙 D.丁\n"
    )
    questions = split_page(text, _Path("x.md"))
    assert [q.group_order for q in questions] == [7, 8, 9]
    q8 = next(q for q in questions if q.group_order == 8)
    assert q8.content.startswith("（1）转朱阁")


def test_stem_as_markdown_heading():
    """MinerU 会把题号行识别成 '## 2. 甲组同学推荐…'，不能被当成小标题吞掉。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "1. 在封面上用正楷字书写主题。（1分）\n\n"
        "## 2. 甲组同学推荐「天下第一山」——泰山\n\n"
        "泰山，风景壮丽。\n\n"
        "## 3. 乙组同学推荐「山城」——重庆\n\n"
        "重庆，地处华夏西南。\n\n"
        "4. 下列说法正确的一项是（2分）\nA.甲 B.乙 C.丙 D.丁\n"
    )
    questions = split_page(text, _Path("x.md"), strategy=get_strategy("chinese"))
    assert [q.group_order for q in questions] == [1, 2, 3, 4]
    q2 = next(q for q in questions if q.group_order == 2)
    assert "甲组同学推荐" in q2.content


def test_ocr_tens_digit_error_is_corrected():
    """OCR 把 23 认成 33（22 之后出现 33，再往后是 24）→ 按 23 处理，
    否则题23 消失、还多出一个 33。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "22. 文章回忆了小时候的一次拍照经历，作者为什么还要写？（2分）\n\n"
        "33. 结合文章内容，说说你对第②段加点词「概念」的理解。（3分）\n\n"
        "24. 作者是否自相矛盾？请简要分析。（4分）\n"
    )
    questions = split_page(text, _Path("x.md"))
    assert [q.group_order for q in questions] == [22, 23, 24]


def test_essay_requirements_are_not_new_questions():
    """作文题后的「要求：1. 文体不限 2. 字数…」不是新题：
    题号回退（24 → 1）一律当上一题续行，否则拆出 4 道没有题干的空题。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "24. 请以「疾风知劲草」为题目写一篇文章。\n\n"
        "要求:\n\n"
        "1. 文体不限(诗歌除外)。\n\n"
        "2. 字数在 600-800 之间。\n\n"
        "3. 文中不要出现真实的人名和校名。\n"
    )
    questions = split_page(text, _Path("x.md"))

    assert [q.group_order for q in questions] == [24]
    assert "字数在 600-800" in questions[0].content


def test_answer_section_without_overall_heading():
    """没有「参考答案」总标题、逐题写「6.答案：…」的卷子也要进答案区，
    否则整段答案会被当题目切出来（和平街一中 2024：38 题、题9 只剩「C（2分）」）。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "9. 下列加点字意思相同的一项是（2分）\nA.甲 B.乙 C.丙 D.丁\n\n"
        "10. 下列翻译正确的一项是（2分）\nA.甲 B.乙 C.丙 D.丁\n\n"
        "6..答案：②直挂云帆济沧海\n\n"
        "9．C （2分）\n\n"
        "10．D （2 分）\n"
    )
    questions = split_page(text, _Path("x.md"))

    assert [q.group_order for q in questions] == [9, 10]
    q9 = next(q for q in questions if q.group_order == 9)
    assert q9.answer.strip().startswith("C")
    assert "D （2 分）" not in q9.content


def test_exam_notice_numbers_do_not_create_duplicates():
    """卷首考试说明「1. 本试卷共12页…」不能占题号：否则真题1 重复，
    入库按 (paper_id, question_no) 互相覆盖（延庆 2025 重复 1-4）。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "1. 本试卷共12页，共五道大题，24个小题，满分100分。考试时间150分钟。\n\n"
        "2. 在试卷和答题纸上准确填写班级、姓名、学号。\n\n"
        "3. 答案一律填写在答题纸、机读卡上，在试卷上作答无效。\n\n"
        "1. 你画出了四处文字，下列说法正确的一项是（2分）\nA.甲 B.乙 C.丙 D.丁\n\n"
        "2. 在文中【甲】【乙】两处填入标点，正确的一项是（2分）\nA.甲 B.乙 C.丙 D.丁\n"
    )
    questions = split_page(text, _Path("x.md"))

    assert [q.group_order for q in questions] == [1, 2]
    assert "你画出了四处文字" in questions[0].content


def test_duplicate_stem_is_skipped_not_renumbered():
    """重复题号跳过，不能顺延：顺延会连锁撞上后面的真实题号，一路膨胀。"""
    from pathlib import Path as _Path

    from question_splitter import split_page

    text = (
        "1. 真题一（2分）\nA.甲 B.乙\n\n"
        "2. 真题二（2分）\nA.甲 B.乙\n\n"
        "2. 重复的题号（2分）\nA.甲 B.乙\n\n"
        "3. 真题三（2分）\nA.甲 B.乙\n"
    )
    questions = split_page(text, _Path("x.md"))

    assert [q.group_order for q in questions] == [1, 2, 3]

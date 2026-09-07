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

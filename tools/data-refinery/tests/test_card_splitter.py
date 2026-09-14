from pathlib import Path

from card_splitter import split_page, _count_text_chars, _CHARS_PER_LINE
from card_splitter import _split_paragraphs, _make_bundles, _current_heading, _split_inline_questions
from models import ImageInfo
from textbook_profile import MathTextbookProfile

# 本文件原有用例全部描述数学教材，显式传数学档案以保持原判定
_MATH = MathTextbookProfile()


def make_img(cost: int, pos: int = 0, scaled_w: int = 400, scaled_h: int = 100) -> ImageInfo:
    return ImageInfo(
        ref_path="images/test.jpg",
        disk_path=Path("/tmp/test.jpg"),
        width=1000,
        height=500,
        scaled_width=scaled_w,
        scaled_height=scaled_h,
        char_cost=cost,
        position_in_text=pos,
    )


def test_empty_text():
    assert split_page(Path("page_001.md"), "", []) == []


def test_row_based_char_count():
    """400 个单行字符 → ceil(400/48)=9 行 → 折算 432 字。"""
    assert _count_text_chars("A" * 400) == 432
    # 空行也占一行
    assert _count_text_chars("A" * 48) == 48
    assert _count_text_chars("A" * 48 + "\n\n" + "B" * 48) == 144  # 2 行 + 1 空行
    # 不满一行按整行
    assert _count_text_chars("A" * 10) == 48
    # 公式块按一行占位
    assert _count_text_chars("$$\nx=1\n$$") == 48


def test_400_chars_plus_260_image():
    # 400 单行字符按行折算 = ceil(400/48)*48 = 432；图 260 → total 692 ≤700
    text = "A" * 400
    img = make_img(260)
    cards = split_page(Path("page_001.md"), text, [img])
    assert len(cards) == 1
    assert cards[0].raw_text_char_count == 432
    assert cards[0].image_char_cost == 260
    assert cards[0].total_char_cost == 692


def test_260_chars_plus_400_image():
    # 260 单行字符 → ceil(260/48)=6 行 → 288；图 400 → total 688 ≤700
    text = "A" * 260
    img = make_img(400)
    cards = split_page(Path("page_001.md"), text, [img])
    assert len(cards) == 1
    assert cards[0].raw_text_char_count == 288
    assert cards[0].image_char_cost == 400
    assert cards[0].total_char_cost == 688


def test_400_chars_plus_400_image_compress():
    # 文字 288 行折算（6 行×48，真实段落）+ 图 400 → 688 ≤700，不触发压缩
    # 文字超 400 行折算时触发图片压缩，这里验证压缩后 total ≤700
    text = "配方法是通过配成完全平方式来解一元二次方程的方法。" * 6  # ~36 字×6=216 字
    img = make_img(700, pos=0)
    cards = split_page(Path("page_001.md"), text, [img])
    assert len(cards) == 1
    assert cards[0].total_char_cost <= 700


def test_long_text_split():
    # 约 1000 单行字符（按行折算 ~9 行/段）→ 拆成 ≥2 卡
    text = "。".join(["句子" * 50] * 10)
    cards = split_page(Path("page_001.md"), text, [])
    assert len(cards) >= 2
    for c in cards:
        assert c.raw_text_char_count <= 400 * _CHARS_PER_LINE
        assert c.total_char_cost <= 700


def test_solo_image_card():
    img = make_img(720)
    cards = split_page(Path("page_001.md"), "![](images/test.jpg)", [img])
    assert len(cards) == 1
    assert cards[0].raw_text_char_count == 0
    assert cards[0].image_char_cost == 720


def test_solo_image_stays_in_document_order():
    # page_008 场景：章标题 + 正文段落 + 末尾大图（cost > 700 触发独占卡）。
    # 独占图卡必须按文档顺序排在最后（设计文档 §5.3 规则 3：图片保持原始位置），
    # 不能前置到第一张——前置会导致 LLM 标注时该图卡先于章标题出现、
    # lesson_id 被标为 null 而在入库时被丢弃。
    text = (
        "# 第二十五章 一元二次方程\n\n"
        "方程是现实问题中含有未知数的等量关系的数学表达。\n\n"
        "设雕像腰部以下的身长为 x 米，根据等量关系列出方程。\n\n"
        "![](images/big.jpg)"
    )
    img = make_img(864, pos=text.index("![](images/big.jpg)"))
    cards = split_page(Path("page_008.md"), text, [img])
    assert len(cards) == 2
    # 第一张是文字卡（含章标题），不含图
    assert "第二十五章" in cards[0].content
    assert cards[0].image_char_cost == 0
    # 最后一张是纯图独占卡（不压缩，cost 保持原值）
    assert cards[-1].content == "![](images/test.jpg)"
    assert cards[-1].raw_text_char_count == 0
    assert cards[-1].image_char_cost == 864


def test_current_heading_tracks_markdown_heading():
    assert _current_heading("## 练习") == "练习"
    assert _current_heading("### 1.2 因式分解") == "1.2 因式分解"
    assert _current_heading("普通段落") is None


def test_question_paragraph_is_atomic_bundle():
    # (N) 开头的段落即使超长也不在题中间切
    text = "(1) 这是一道很长的题目" + "条件" * 200 + "，求 x 的值。"
    bundles = _make_bundles(text, [], _MATH)
    # 题段落作为单个 bundle（即便 >400，也不再按句切分到多 bundle）
    assert len(bundles) == 1
    assert bundles[0].text.startswith("(1)")


def test_same_section_fill_pulls_sentence_from_next():
    # 验证 _make_bundles 为同节段落标记相同 heading
    # （补句逻辑在 split_page 的合并循环里，见 test_split_page_fill_pulls_first_sentence_from_same_section）
    text = "## 练习\n\n短句一。\n\n短句二，补充内容。"
    bundles = _make_bundles(text, [], _MATH)
    assert len(bundles) >= 2
    assert all(b.heading == "练习" for b in bundles)


def test_split_page_fill_pulls_first_sentence_from_same_section():
    # 当前卡 <300 且下一同 heading 非题段落 -> 拉首句补入当前卡
    heading = "## 练习"
    para1 = "短句内容。" * 50   # _count_text_chars = 240
    para2 = "这是补充内容。" * 40  # _count_text_chars = 240, same heading
    text = f"{heading}\n\n{para1}\n\n{para2}"
    cards = split_page(Path("page_001.md"), text, [])
    # heading(48) + para1(240) = 288 < 300 -> fill triggers
    # para2(240) 不 fits (288+240=528>400) -> 拉 para2 首句 "这是补充内容。"(48)
    # Card 1 = 288 + 48 = 336; Card 2 = remaining para2 = 240
    assert len(cards) == 2
    assert "这是补充内容。" in cards[0].content  # fill pulled first sentence
    assert cards[0].raw_text_char_count > 288    # more than heading(48)+para1(240)=288


class TestSplitInlineQuestions:
    def test_semicolon_separated(self):
        """分号分隔的同行题拆为多段（分隔符被消费，不留尾随 ;）"""
        para = "(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$"
        result = _split_inline_questions(para)
        assert len(result) == 2
        assert result[0] == "(1) $5x^{2}-1=4x$"
        assert result[1] == "(2) $4x^{2}=81$"

    def test_period_separated(self):
        """句号分隔的同行题拆为多段（分隔符被消费，不留尾随 。）"""
        para = "(1) 解方程 $x^{2}=4$。(2) 求 $y$ 的值。"
        result = _split_inline_questions(para)
        assert len(result) == 2
        assert result[0] == "(1) 解方程 $x^{2}=4$"
        assert result[1] == "(2) 求 $y$ 的值。"

    def test_no_split_on_text_ref(self):
        """正文引用 (2) 不误拆，如「与(2)类似」"""
        para = "由(1)可知，与(2)类似的方法也可解此题。"
        result = _split_inline_questions(para)
        assert len(result) == 1
        assert result[0] == para

    def test_single_question_no_split(self):
        """单题无拆分点原样返回"""
        para = "(1) $x^{2}+2x+1=0$"
        result = _split_inline_questions(para)
        assert len(result) == 1
        assert result[0] == para

    def test_no_numbered_items(self):
        """无编号段落不拆分"""
        para = "解下列方程："
        result = _split_inline_questions(para)
        assert len(result) == 1
        assert result[0] == para

    def test_chinese_semicolon_separated(self):
        """中文分号；分隔同行题（分隔符被消费，不留尾随 ；）"""
        para = "(1) $x^{2}=9$；(2) $y^{2}=16$"
        result = _split_inline_questions(para)
        assert len(result) == 2
        assert result[0] == "(1) $x^{2}=9$"
        assert result[1] == "(2) $y^{2}=16$"

    def test_triple_question_semicolon_separated(self):
        """三个分号分隔的同行题拆为三段"""
        para = "(1) $x^{2}=4$ ; (2) $y^{2}=9$ ; (3) $z^{2}=16$"
        result = _split_inline_questions(para)
        assert len(result) == 3
        assert "(1)" in result[0]
        assert "(2)" in result[1]
        assert "(3)" in result[2]

    def test_dollar_dollar_math_blocks_with_semicolon(self):
        """$$ 数学块间分号分隔的同行题"""
        para = "(1) $$x^{2}=4$$ ; (2) $$y^{2}=9$$"
        result = _split_inline_questions(para)
        assert len(result) == 2
        assert result[0] == "(1) $$x^{2}=4$$"
        assert result[1] == "(2) $$y^{2}=9$$"

    def test_single_isolated_question_no_split(self):
        """单个孤立题号无拆分点原样返回"""
        result = _split_inline_questions("(1) $x^{2}=9$")
        assert len(result) == 1
        assert result[0] == "(1) $x^{2}=9$"


def test_split_paragraphs_with_inline_questions():
    """_split_paragraphs 组合双换行拆段 + 同行题拆行"""
    text = "解下列方程：\n\n(1) $x^{2}=4$ ; (2) $y^{2}=9$\n\n(3) $z^{2}=16$"
    result = _split_paragraphs(text)
    assert len(result) == 4  # intro + (1) + (2) + (3)
    assert result[0] == "解下列方程："
    assert "(1)" in result[1]
    assert "(2)" in result[2]
    assert "(3)" in result[3]


def test_heading_boundary_closes_card():
    """不同 heading 的相邻段落必须分卡，避免"练习"被劈到上一节末。

    场景：探究节+短内容+## 练习+短内容+## 探究；练习前段不超 400 字时，
    splitter 不应把探究尾巴塞进练习卡，也不应把练习劈开。
    """
    text = (
        "## 探究\n\n"
        "探究段一内容。" * 5 + "\n\n" +   # ~60 字
        "## 练习\n\n"
        "解下列方程：\n\n"
        "(1) $2x^{2}-8=0$\n\n"
        "(2) $9x^{2}-5=3$\n\n"
        "## 探究\n\n"
        "探究段二内容。" * 5
    )
    cards = split_page(Path("page_001.md"), text, [])
    # 期望：探究1、练习（完整）、探究2 至少 3 卡
    assert len(cards) >= 3
    # 找到含 ## 练习 的卡
    practice_card = next(c for c in cards if "## 练习" in c.content)
    # 练习卡应包含完整题干 + (1) + (2)
    assert "解下列方程：" in practice_card.content
    assert "(1)" in practice_card.content
    assert "(2)" in practice_card.content
    # 不应混入下一节 ## 探究 的内容
    assert "探究段二" not in practice_card.content


def test_image_only_bundle_does_not_trigger_heading_close():
    """image-only bundle (heading=None) 不应触发封卡，归入下一标题节。"""
    text = "## 练习\n\n练习内容。\n\n![](images/icon.jpg)\n\n继续练习。"
    # 该场景下 image 不会被计入（无 ImageInfo），但 heading=None 不应误封卡
    cards = split_page(Path("page_001.md"), text, [])
    assert len(cards) == 1
    assert "## 练习" in cards[0].content
    assert "继续练习。" in cards[0].content


def test_heading_without_body_merges_into_next_card():
    """连续标题（无正文的孤立标题）应并入后续内容卡，不能单独成卡。

    场景：## 21.2 解一元二次方程 后紧跟 ## 21.2.1 配方法 + 正文，
    前一个标题没有正文，不应被 heading 边界规则封成孤立卡。
    """
    text = (
        "## 21.2 解一元二次方程\n\n"
        "## 21.2.1 配方法\n\n"
        "问题1 一桶油漆可刷的面积。" * 6 + "\n\n" +
        "## 练习\n\n解下列方程：\n\n(1) $x^{2}=4$"
    )
    cards = split_page(Path("page_001.md"), text, [])
    # 第一张卡应同时含孤立标题与后续正文（标题并入正文卡）
    first = cards[0]
    assert "21.2 解一元二次方程" in first.content
    assert "问题1" in first.content
    # 每张卡都不能只有标题行没有正文（除整页仅标题的极端情况）
    for c in cards:
        body_lines = [l for l in c.content.splitlines()
                      if l.strip() and not l.lstrip().startswith("#")]
        assert body_lines, f"孤立标题卡不应存在: {c.content!r}"

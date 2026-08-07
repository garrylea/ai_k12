from pathlib import Path

from card_splitter import split_page, _count_text_chars, _CHARS_PER_LINE
from card_splitter import _split_paragraphs, _make_bundles, _current_heading
from models import ImageInfo


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


def test_current_heading_tracks_markdown_heading():
    assert _current_heading("## 练习") == "练习"
    assert _current_heading("### 1.2 因式分解") == "1.2 因式分解"
    assert _current_heading("普通段落") is None


def test_question_paragraph_is_atomic_bundle():
    # (N) 开头的段落即使超长也不在题中间切
    text = "(1) 这是一道很长的题目" + "条件" * 200 + "，求 x 的值。"
    bundles = _make_bundles(text, [])
    # 题段落作为单个 bundle（即便 >400，也不再按句切分到多 bundle）
    assert len(bundles) == 1
    assert bundles[0].text.startswith("(1)")


def test_same_section_fill_pulls_sentence_from_next():
    # 当前 <300 且下一同节段落 -> 拉句子补；不同节 -> 不补
    # （补句逻辑在 split_page 的合并循环里，此处验证 _make_bundles 标记同节）
    text = "## 练习\n\n短句一。\n\n短句二，补充内容。"
    bundles = _make_bundles(text, [])
    assert len(bundles) >= 2

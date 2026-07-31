from pathlib import Path

from card_splitter import split_page
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


def test_400_chars_plus_260_image():
    text = "A" * 400
    img = make_img(260)
    cards = split_page(Path("page_001.md"), text, [img])
    assert len(cards) == 1
    assert cards[0].raw_text_char_count == 400
    assert cards[0].image_char_cost == 260
    assert cards[0].total_char_cost == 660


def test_260_chars_plus_400_image():
    text = "A" * 260
    img = make_img(400)
    cards = split_page(Path("page_001.md"), text, [img])
    assert len(cards) == 1
    assert cards[0].raw_text_char_count == 260
    assert cards[0].image_char_cost == 400
    assert cards[0].total_char_cost == 660


def test_400_chars_plus_400_image_compress():
    text = "A" * 400
    img = make_img(400)
    cards = split_page(Path("page_001.md"), text, [img])
    assert len(cards) == 1
    assert cards[0].raw_text_char_count == 400
    # 图片被压缩到 ≤300 字成本（按整行：6 行 × 48 = 288）
    assert cards[0].image_char_cost <= 300
    assert cards[0].total_char_cost <= 700


def test_long_text_split():
    text = "。".join(["句子" * 50] * 10)  # 约 1000 字
    cards = split_page(Path("page_001.md"), text, [])
    assert len(cards) >= 2
    for c in cards:
        assert c.raw_text_char_count <= 400
        assert c.total_char_cost <= 700


def test_solo_image_card():
    img = make_img(720)
    cards = split_page(Path("page_001.md"), "![](images/test.jpg)", [img])
    assert len(cards) == 1
    assert cards[0].raw_text_char_count == 0
    assert cards[0].image_char_cost == 720

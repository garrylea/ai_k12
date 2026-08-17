from pathlib import Path
from unittest.mock import MagicMock, patch

from image_scan import _char_cost, _scale_for_width, scan_page
from models import ImageInfo


def test_char_cost():
    assert _char_cost(40) == 96   # ceil(40/26)=2 → 2*48=96
    assert _char_cost(26) == 48   # ceil(26/26)=1 → 1*48=48
    assert _char_cost(27) == 96   # ceil(27/26)=2 → 2*48=96
    assert _char_cost(384) == 720  # ceil(384/26)=15 → 15*48=720


def test_scale_for_width():
    assert _scale_for_width(500, 200) == (500, 200)
    assert _scale_for_width(1000, 500) == (768, 384)


def _fake_image(width: int, height: int):
    mock_img = MagicMock()
    mock_img.size = (width, height)
    return mock_img


@patch("image_scan.Image.open")
def test_scan_page(mock_open):
    mock_open.return_value.__enter__ = MagicMock(return_value=_fake_image(1000, 500))
    mock_open.return_value.__exit__ = MagicMock(return_value=False)

    md_path = Path("/tmp/page_001.md")
    md_path.write_text("![alt](images/test.jpg)", encoding="utf-8")

    # 创建假图片文件
    img_path = Path("/tmp/images/test.jpg")
    img_path.parent.mkdir(parents=True, exist_ok=True)
    img_path.write_bytes(b"fake")

    images, cleaned = scan_page(md_path)
    assert len(images) == 1
    assert images[0].width == 1000
    assert images[0].height == 500
    assert images[0].scaled_width == 768
    assert images[0].scaled_height == 384
    assert images[0].char_cost == 720
    assert "images/test.jpg" in cleaned  # 大图引用保留


@patch("image_scan.Image.open")
def test_scan_page_drops_small_icon(mock_open):
    """小图标（scaled_height ≤ 78px）不入 ImageInfo，且对应 ![]() 行从文本移除。"""
    mock_open.return_value.__enter__ = MagicMock(return_value=_fake_image(67, 65))
    mock_open.return_value.__exit__ = MagicMock(return_value=False)

    md_path = Path("/tmp/page_002.md")
    md_path.write_text("正文第一句。\n\n![](images/icon.jpg)\n\n正文第二句。",
                       encoding="utf-8")
    img_path = Path("/tmp/images/icon.jpg")
    img_path.parent.mkdir(parents=True, exist_ok=True)
    img_path.write_bytes(b"fake")

    images, cleaned = scan_page(md_path)
    assert len(images) == 0
    assert "![](images/icon.jpg)" not in cleaned
    assert "正文第一句。" in cleaned
    assert "正文第二句。" in cleaned


@patch("image_scan.Image.open")
def test_scan_page_keeps_figure_above_threshold(mock_open):
    """80px+ 的图是正文插图，保留。"""
    mock_open.return_value.__enter__ = MagicMock(return_value=_fake_image(200, 120))
    mock_open.return_value.__exit__ = MagicMock(return_value=False)

    md_path = Path("/tmp/page_003.md")
    md_path.write_text("![](images/fig.jpg)", encoding="utf-8")
    img_path = Path("/tmp/images/fig.jpg")
    img_path.parent.mkdir(parents=True, exist_ok=True)
    img_path.write_bytes(b"fake")

    images, cleaned = scan_page(md_path)
    assert len(images) == 1
    assert images[0].scaled_height == 120
    assert "images/fig.jpg" in cleaned

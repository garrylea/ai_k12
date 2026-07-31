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


@patch("image_scan.Image.open")
def test_scan_page(mock_open):
    mock_img = MagicMock()
    mock_img.size = (1000, 500)
    mock_open.return_value.__enter__ = MagicMock(return_value=mock_img)
    mock_open.return_value.__exit__ = MagicMock(return_value=False)

    md_path = Path("/tmp/page_001.md")
    md_path.write_text("![alt](images/test.jpg)", encoding="utf-8")

    # 创建假图片文件
    img_path = Path("/tmp/images/test.jpg")
    img_path.parent.mkdir(parents=True, exist_ok=True)
    img_path.write_bytes(b"fake")

    results = scan_page(md_path)
    assert len(results) == 1
    assert results[0].width == 1000
    assert results[0].height == 500
    assert results[0].scaled_width == 768
    assert results[0].scaled_height == 384
    assert results[0].char_cost == 720

"""图片扫描器：扫描 Markdown 文件中的图片引用，通过 PIL 读取实际宽高并计算折算字数。

调用时机：MinerU 转完 Markdown 之后、card_splitter 拆分卡片之前。
"""

import re
from pathlib import Path

from PIL import Image

from models import ImageInfo

# 匹配 ![alt](path)
_IMAGE_REF_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")

# 统一渲染基准常量（对齐参考页实测）
_LINE_HEIGHT = 26        # 参考页 body 行高
_CHARS_PER_LINE = 48     # 768px prose / 16px 字宽
_IMG_MAX_WIDTH = 768     # prose 宽度


def _char_cost(height_px: int) -> int:
    """计算图片折算字数。

    公式：ceil(height / 26) × 48
    """
    rows = int(-(-height_px // _LINE_HEIGHT))  # ceil 除法
    return rows * _CHARS_PER_LINE


def _scale_for_width(raw_width: int, raw_height: int) -> tuple[int, int]:
    """宽度适配：超宽图等比缩放至 prose 宽度。

    返回 (缩放后宽度, 缩放后高度)。
    """
    if raw_width > _IMG_MAX_WIDTH:
        scale = _IMG_MAX_WIDTH / raw_width
        return _IMG_MAX_WIDTH, int(raw_height * scale + 0.5)
    return raw_width, raw_height


def _resolve_disk_path(ref_path: str, md_dir: Path) -> Path | None:
    """把 Markdown 图片引用解析到磁盘文件路径。"""
    candidates = [
        md_dir / ref_path,
        md_dir / "images" / Path(ref_path).name,
        md_dir / Path(ref_path).name,
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def scan_page(md_path: Path) -> list[ImageInfo]:
    """扫描单页 MD 文件中所有图片引用，获取宽高和折算字数。

    Args:
        md_path: page_NNN.md 的路径

    Returns:
        按文本出现顺序排列的 ImageInfo 列表
    """
    md_dir = md_path.parent
    text = md_path.read_text(encoding="utf-8")

    results: list[ImageInfo] = []
    for m in _IMAGE_REF_RE.finditer(text):
        ref_path = m.group(2)
        disk_path = _resolve_disk_path(ref_path, md_dir)
        if disk_path is None:
            continue

        try:
            with Image.open(disk_path) as img:
                raw_w, raw_h = img.size
        except Exception:
            continue

        scaled_w, scaled_h = _scale_for_width(raw_w, raw_h)
        cost = _char_cost(scaled_h)

        results.append(ImageInfo(
            ref_path=ref_path,
            disk_path=disk_path,
            width=raw_w,
            height=raw_h,
            scaled_width=scaled_w,
            scaled_height=scaled_h,
            char_cost=cost,
            position_in_text=m.start(),
        ))

    return results

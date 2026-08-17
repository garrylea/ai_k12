"""图片扫描器：扫描 Markdown 文件中的图片引用，通过 PIL 读取实际宽高并计算折算字数。

调用时机：MinerU 转完 Markdown 之后、card_splitter 拆分卡片之前。
小图标（scaled_height ≤ _ICON_MAX_SCALED_HEIGHT）判定为装饰性图标，直接舍弃：
不入 ImageInfo、不计折算字数，并把对应 ``![]()`` 行从返回文本移除（不再物化、不再渲染）。
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

# 小图标舍弃阈值：渲染高度 ≤ 3 行文字（78px）视为装饰性图标
_ICON_MAX_SCALED_HEIGHT = 78


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


def _is_icon(ref_path: str, disk_path: Path | None) -> bool:
    """判断图片是否为小图标（scaled_height ≤ _ICON_MAX_SCALED_HEIGHT）。"""
    if disk_path is None:
        return False
    try:
        with Image.open(disk_path) as img:
            raw_w, raw_h = img.size
    except Exception:
        return False
    _, scaled_h = _scale_for_width(raw_w, raw_h)
    return scaled_h <= _ICON_MAX_SCALED_HEIGHT


def scan_page(md_path: Path) -> tuple[list[ImageInfo], str]:
    """扫描单页 MD 文件中所有图片引用，获取宽高和折算字数。

    Args:
        md_path: page_NNN.md 的路径

    Returns:
        (按文本出现顺序排列的 ImageInfo 列表, 清洗后文本)
        清洗后文本中，被判为小图标的 ``![]()`` 行已被整行移除；
        ImageInfo.position_in_text 基于清洗后文本计算。
    """
    md_dir = md_path.parent
    text = md_path.read_text(encoding="utf-8")

    # 第一遍：找出小图标，整行移除（真舍弃，不计 cost、不参与拆分）
    dropped_refs: set[str] = set()
    for m in _IMAGE_REF_RE.finditer(text):
        ref_path = m.group(2)
        if _is_icon(ref_path, _resolve_disk_path(ref_path, md_dir)):
            dropped_refs.add(ref_path)
    if dropped_refs:
        text = "\n".join(
            line for line in text.split("\n")
            if not any(f"![]({ref})" in line for ref in dropped_refs)
        ).strip()

    # 第二遍：在清洗后文本上收集图片（position 对齐清洗后文本）
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

    return results, text

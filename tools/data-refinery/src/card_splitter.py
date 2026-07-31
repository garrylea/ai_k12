"""卡片拆分器：将教材 Markdown 拆分为 ≤400 字文字 + ≤700 字总计（含图片折算）的卡片。

核心规则：
- 图片块级居中 → cost 按高度占多少整行算
- 文字按自然段落切分，以段落+图为 bundle 贪心合并
- content 原文不动，一字不改

字数上限推导：
- 参考页 prose 宽 768px，正文 16px → 每行 48 汉字
- body 行高 26px → 行盒 26px
- iPad 768 高屏可用正文区 ≈ 499px → 约 19 行
- 48 × 19 = 912 字物理上限
- 留余量（标题/标签/公式/列表宽行距）→ 文字 400 + 图片 ≤ 300 = 总计 700
"""

import re
from dataclasses import dataclass
from pathlib import Path

from models import CardFragment, ImageInfo

_TEXT_LIMIT = 400          # 单卡文字上限
_TOTAL_LIMIT = 700         # 单卡总上限（文字+图片折算）
_LINE_HEIGHT = 26          # 参考页 body 行高
_CHARS_PER_LINE = 48       # 768px prose / 16px 字宽
_IMG_MAX_WIDTH = 768       # prose 宽度


def _count_text_chars(text: str) -> int:
    """统计 text 中的有效字数（汉字 + 英文单词 + 数字，不含 Markdown 标记和 LaTeX 源码）。"""
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    cleaned = re.sub(r"[#*>\-|`~\[\]]+", "", cleaned)
    cleaned = re.sub(r"\$\$[^$]+\$\$", "", cleaned)
    cleaned = re.sub(r"\$[^$]+\$", "", cleaned)
    han = len(re.findall(r"[一-鿿]", cleaned))
    eng = len(re.findall(r"[a-zA-Z]+", cleaned))
    digits = len(re.findall(r"[0-9]+", cleaned))
    return han + eng + digits


def _extract_page_number(md_path: Path) -> str:
    """从 page_NNN.md 提取页码，如 page_008.md → 'P8'。"""
    m = re.search(r"page_(\d+)", md_path.name)
    if m:
        return f"P{int(m.group(1))}"
    return ""


def _split_paragraphs(text: str) -> list[str]:
    """按双换行拆分段落，过滤纯空行。"""
    parts = re.split(r"\n\n+", text)
    return [p.strip() for p in parts if p.strip()]


def _images_in_range(images: list[ImageInfo], start: int, end: int) -> list[ImageInfo]:
    """找到 position_in_text 在 [start, end) 范围内的图片。"""
    return [img for img in images if start <= img.position_in_text < end]


@dataclass
class _Bundle:
    """一个不可拆分的最小单元：一段文字 + 属于它的图片。"""
    text: str
    images: list[ImageInfo]
    text_chars: int
    image_cost: int


def _make_bundles(text: str, images: list[ImageInfo]) -> list[_Bundle]:
    """把 Markdown 拆分为 bundle 列表。若段落文字 >400，按句末标点切开。"""
    paragraphs = _split_paragraphs(text)
    bundles: list[_Bundle] = []

    pos = 0
    for para in paragraphs:
        para_start = text.index(para, pos) if para in text[pos:] else pos
        para_end = para_start + len(para)
        pos = para_end

        para_images = _images_in_range(images, para_start, para_end)
        para_text_chars = _count_text_chars(para)

        if para_text_chars > _TEXT_LIMIT:
            # 按句末标点切开
            sub_texts = _split_long_text(para)
            for sub in sub_texts:
                sub_start = text.index(sub, para_start) if sub in text[para_start:para_end] else para_start
                sub_end = sub_start + len(sub)
                sub_images = _images_in_range(images, sub_start, sub_end)
                sub_chars = _count_text_chars(sub)
                sub_cost = sum(img.char_cost for img in sub_images)
                bundles.append(_Bundle(text=sub, images=sub_images, text_chars=sub_chars, image_cost=sub_cost))
        else:
            img_cost = sum(img.char_cost for img in para_images)
            bundles.append(_Bundle(text=para, images=para_images, text_chars=para_text_chars, image_cost=img_cost))

    return bundles


def _split_long_text(text: str) -> list[str]:
    """对超长段落按句末标点切割，确保每段文字 ≤ 400 字。"""
    sentences = re.split(r"(?<=[。！？])", text)
    result: list[str] = []
    current = ""
    current_chars = 0

    for sent in sentences:
        sent_chars = _count_text_chars(sent)
        if current_chars + sent_chars <= _TEXT_LIMIT:
            current += sent
            current_chars += sent_chars
        else:
            if current:
                result.append(current)
            current = sent
            current_chars = sent_chars

    if current:
        result.append(current)

    return result if result else [text]


def _compress_image(img: ImageInfo, target_cost: int) -> ImageInfo:
    """等比压缩图片使其折算字数 ≤ target_cost。

    返回新的 ImageInfo（scaled_* 和 char_cost 已更新）。
    """
    if img.char_cost <= target_cost:
        return img

    target_rows = max(1, target_cost // _CHARS_PER_LINE)
    target_height = target_rows * _LINE_HEIGHT
    scale = target_height / img.scaled_height
    new_scaled_w = int(img.scaled_width * scale + 0.5)
    new_scaled_h = target_height
    new_cost = target_rows * _CHARS_PER_LINE

    return ImageInfo(
        ref_path=img.ref_path,
        disk_path=img.disk_path,
        width=img.width,
        height=img.height,
        scaled_width=new_scaled_w,
        scaled_height=new_scaled_h,
        char_cost=new_cost,
        position_in_text=img.position_in_text,
    )


def split_page(md_path: Path, text: str, images: list[ImageInfo]) -> list[CardFragment]:
    """将一页 Markdown 拆分为多张卡片。

    Args:
        md_path: page_NNN.md 路径
        text: 页面的完整 Markdown 文本
        images: image_scan 产出的图片元信息列表

    Returns:
        拆分后的 CardFragment 列表
    """
    if not text.strip():
        return []

    page_label = _extract_page_number(md_path)
    bundles = _make_bundles(text, images)

    # 先处理大图独占卡（单图 cost > 700）
    solo_fragments: list[CardFragment] = []
    remaining_bundles: list[_Bundle] = []
    consumed_positions: set[int] = set()

    for bundle in bundles:
        if len(bundle.images) == 1 and bundle.text_chars < 50 and bundle.image_cost > _TOTAL_LIMIT:
            img = bundle.images[0]
            consumed_positions.add(img.position_in_text)
            solo_fragments.append(CardFragment(
                sort_order=0,
                content=f"![]({img.ref_path})",
                images=[img],
                raw_text_char_count=0,
                image_char_cost=img.char_cost,
                total_char_cost=img.char_cost,
                textbook_page=page_label,
            ))
        else:
            remaining_bundles.append(bundle)

    # 贪心合并 bundle 为卡片
    fragments: list[CardFragment] = []
    current_texts: list[str] = []
    current_images: list[ImageInfo] = []
    current_text_chars = 0
    current_total = 0

    def _close_card():
        nonlocal current_texts, current_images, current_text_chars, current_total
        if not current_texts:
            return
        content_text = "\n\n".join(current_texts)
        frag_images = [img for img in current_images if img.position_in_text not in consumed_positions]
        fragments.append(CardFragment(
            sort_order=0,
            content=content_text,
            images=frag_images,
            raw_text_char_count=current_text_chars,
            image_char_cost=sum(img.char_cost for img in frag_images),
            total_char_cost=current_text_chars + sum(img.char_cost for img in frag_images),
            textbook_page=page_label,
        ))
        current_texts = []
        current_images = []
        current_text_chars = 0
        current_total = 0

    for bundle in remaining_bundles:
        # 尝试直接放入当前卡
        if current_text_chars + bundle.text_chars <= _TEXT_LIMIT and current_total + bundle.text_chars + bundle.image_cost <= _TOTAL_LIMIT:
            current_texts.append(bundle.text)
            current_images.extend(bundle.images)
            current_text_chars += bundle.text_chars
            current_total += bundle.text_chars + bundle.image_cost
            continue

        # 放不下：先把当前卡封存
        _close_card()

        # 现在把 bundle 放进新卡
        if bundle.text_chars <= _TEXT_LIMIT and bundle.text_chars + bundle.image_cost <= _TOTAL_LIMIT:
            current_texts = [bundle.text]
            current_images = list(bundle.images)
            current_text_chars = bundle.text_chars
            current_total = bundle.text_chars + bundle.image_cost
        elif bundle.text_chars <= _TEXT_LIMIT:
            # 文字够但图超了：压缩图
            image_room = _TOTAL_LIMIT - bundle.text_chars
            compressed_images = [_compress_image(img, image_room) for img in bundle.images]
            new_image_cost = sum(img.char_cost for img in compressed_images)
            current_texts = [bundle.text]
            current_images = compressed_images
            current_text_chars = bundle.text_chars
            current_total = bundle.text_chars + new_image_cost
        else:
            # 文字本身 >400（理论上 _make_bundles 已处理，兜底）
            sub_texts = _split_long_text(bundle.text)
            for sub in sub_texts:
                sub_chars = _count_text_chars(sub)
                if current_text_chars + sub_chars <= _TEXT_LIMIT and current_total + sub_chars <= _TOTAL_LIMIT:
                    current_texts.append(sub)
                    current_text_chars += sub_chars
                    current_total += sub_chars
                else:
                    _close_card()
                    current_texts = [sub]
                    current_text_chars = sub_chars
                    current_total = sub_chars

    _close_card()

    # 合并 solo fragments 和 merged fragments，统一编号
    all_fragments = solo_fragments + fragments
    for i, frag in enumerate(all_fragments, 1):
        frag.sort_order = i

    return all_fragments

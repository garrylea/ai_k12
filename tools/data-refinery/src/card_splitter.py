"""卡片拆分器：将教材 Markdown 拆分为 ≤400 字（含图片折算）的卡片。

核心规则：
- 图片两步走：宽度适配（已在 image_scan 中完成）→ 高度三态判断
- 文字按自然段落切分，贪心合并
- content 原文不动，一字不改
"""

import re
from pathlib import Path

from models import CardFragment, ImageInfo

_CARD_LIMIT = 400          # 单卡字数上限
_IMG_SOLO_THRESHOLD = 300  # 图片占卡 75%，触发独占卡


def _count_text_chars(text: str) -> int:
    """统计 text 中的有效字数（汉字 + 英文单词 + 数字，不含 Markdown 标记和 LaTeX 源码）。"""
    # 去掉图片引用
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    # 去掉 Markdown 标记（标题 #、加粗 **、列表 -、引用 >、表格 | 等）
    cleaned = re.sub(r"[#*>\-|`~\[\]]+", "", cleaned)
    # 去掉 LaTeX 块
    cleaned = re.sub(r"\$\$[^$]+\$\$", "", cleaned)
    cleaned = re.sub(r"\$[^$]+\$", "", cleaned)
    # 统计汉字
    han = len(re.findall(r"[一-鿿]", cleaned))
    # 统计英文单词
    eng = len(re.findall(r"[a-zA-Z]+", cleaned))
    # 统计数字
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


def split_page(md_path: Path, text: str, images: list[ImageInfo]) -> list[CardFragment]:
    """将一页 Markdown 拆分为多张卡片。

    Args:
        md_path: page_NNN.md 路径（用于提取页码）
        text: 页面的完整 Markdown 文本
        images: image_scan 产出的图片元信息列表

    Returns:
        拆分后的 CardFragment 列表
    """
    if not text.strip():
        return []

    page_label = _extract_page_number(md_path)
    paragraphs = _split_paragraphs(text)

    # 先处理大图（情况 A：折算字数 ≥ 300 → 独占卡）
    solo_fragments: list[CardFragment] = []
    remaining_paras: list[str] = []
    consumed_img_positions: set[int] = set()

    pos = 0  # 追踪当前字符偏移
    for para in paragraphs:
        para_start = text.index(para, pos) if para in text[pos:] else pos
        para_end = para_start + len(para)
        pos = para_end

        para_images = _images_in_range(images, para_start, para_end)
        para_text_chars = _count_text_chars(para)
        para_img_cost = sum(img.char_cost for img in para_images)

        # 检查是否触发情况 A
        if para_img_cost >= _IMG_SOLO_THRESHOLD and len(para_images) == 1 and para_text_chars < 50:
            img = para_images[0]
            consumed_img_positions.add(img.position_in_text)
            solo_fragments.append(CardFragment(
                sort_order=0,  # 统一编号稍后
                content=f"![]({img.ref_path})",
                images=[img],
                raw_text_char_count=0,
                image_char_cost=img.char_cost,
                total_char_cost=img.char_cost,
                textbook_page=page_label,
            ))
            continue

        remaining_paras.append(para)

    # 如果页面全是情况 A 的图，直接返回
    if not remaining_paras and solo_fragments:
        for i, frag in enumerate(solo_fragments):
            frag.sort_order = i + 1
        return solo_fragments

    # 处理情况 B（折算字数 < 300 但总字数超 400 → 二次缩小）
    effective_paras: list[tuple[str, int]] = []  # (para_text, total_cost)
    pos = 0
    for para in remaining_paras:
        para_start = text.index(para, pos) if para in text[pos:] else pos
        para_end = para_start + len(para)
        pos = para_end
        para_images = _images_in_range(images, para_start, para_end)
        para_text_chars = _count_text_chars(para)
        para_img_cost = sum(img.char_cost for img in para_images)

        if para_text_chars + para_img_cost > _CARD_LIMIT and para_img_cost < _IMG_SOLO_THRESHOLD:
            # 情况 B：二次缩小图片
            max_img_chars = max(0, _CARD_LIMIT - para_text_chars)
            reduction_ratio = max_img_chars / para_img_cost if para_img_cost > 0 else 1.0
            effective_cost = para_text_chars + max_img_chars
            effective_paras.append((para, effective_cost))
        else:
            effective_paras.append((para, para_text_chars + para_img_cost))

    # 贪心合并段落为卡片
    fragments: list[tuple[list[str], int]] = []  # [(para_texts, total_cost), ...]
    current_paras: list[str] = []
    current_cost = 0

    for para_text, para_cost in effective_paras:
        if current_cost + para_cost <= _CARD_LIMIT:
            current_paras.append(para_text)
            current_cost += para_cost
        else:
            if current_paras:
                fragments.append((current_paras, current_cost))
            current_paras = [para_text]
            current_cost = para_cost

    if current_paras:
        fragments.append((current_paras, current_cost))

    # 处理超长单段（>400 字，按句末标点切割）
    final_fragments: list[tuple[str, int]] = []
    for paras, cost in fragments:
        if len(paras) == 1 and cost > _CARD_LIMIT:
            sub_texts = _split_long_text(paras[0])
            for sub in sub_texts:
                final_fragments.append((sub, _count_text_chars(sub) +
                    sum(img.char_cost for img in _images_in_range(
                        images, text.index(sub) if sub in text else 0,
                        (text.index(sub) + len(sub)) if sub in text else 0))))
        else:
            final_fragments.append(("\n\n".join(paras), cost))

    # 重新编号 solo fragments
    for idx, frag in enumerate(solo_fragments):
        frag.sort_order = idx + 1

    # 构建 CardFragment 输出
    result: list[CardFragment] = list(solo_fragments)
    sort_start = len(solo_fragments) + 1

    for i, (content_text, _) in enumerate(final_fragments):
        # 找到该片段内的图片
        try:
            start_pos = text.index(content_text)
        except ValueError:
            start_pos = 0
        end_pos = start_pos + len(content_text)
        frag_images = [img for img in images
                       if start_pos <= img.position_in_text < end_pos
                       and img.position_in_text not in consumed_img_positions]
        frag_text_cost = _count_text_chars(content_text)
        frag_img_cost = sum(img.char_cost for img in frag_images)

        result.append(CardFragment(
            sort_order=sort_start + i,
            content=content_text,
            images=frag_images,
            raw_text_char_count=frag_text_cost,
            image_char_cost=frag_img_cost,
            total_char_cost=frag_text_cost + frag_img_cost,
            textbook_page=page_label,
        ))

    return result


def _split_long_text(text: str) -> list[str]:
    """对超长段落按句末标点切割，确保每段 ≤ 400 字。"""
    sentences = re.split(r"(?<=[。！？])", text)
    result: list[str] = []
    current = ""
    current_chars = 0

    for sent in sentences:
        sent_chars = _count_text_chars(sent)
        if current_chars + sent_chars <= _CARD_LIMIT:
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

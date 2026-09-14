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
from textbook_profile import TextbookProfile, profile_for_md_path

_TEXT_LIMIT = 400          # 单卡文字上限
_TOTAL_LIMIT = 700         # 单卡总上限（文字+图片折算）
_LINE_HEIGHT = 26          # 参考页 body 行高
_CHARS_PER_LINE = 48       # 768px prose / 16px 字宽
_IMG_MAX_WIDTH = 768       # prose 宽度


def _count_text_chars(text: str) -> int:
    """按渲染行折算有效字数（不是字符数）。

    对齐参考页渲染（prose 768px / 16px 字宽 → 每行 48 字，行高 26px）：
    - 每行按 _CHARS_PER_LINE（48）计，不足一行按整行计
    - 空行也占一行渲染高度，按一行计
    - Markdown 标记与图片引用不计；LaTeX 源码剔除，但公式块（$$..$$）按独立行占位计
    """
    # 去掉图片引用（图片单独按 height 折算 image_char_cost）
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    # 公式块 $$...$$ 在参考页中是独立行，按 1 行占位
    cleaned = re.sub(r"\$\$[^$]+\$\$", "X", cleaned)
    # 行内公式 $...$ 剔除源码，按 1 个字符占位
    cleaned = re.sub(r"\$[^$]+\$", "x", cleaned)
    # 去掉 Markdown 标记符（标题 #、列表、引用等）
    cleaned = re.sub(r"[#*>\-|`~\[\]]+", "", cleaned)

    rows = 0
    for line in cleaned.splitlines():
        line = line.strip()
        if not line:
            rows += 1  # 空行占一行渲染高度
            continue
        chars = len(re.findall(r"[一-鿿]", line)) + len(re.findall(r"[a-zA-Z0-9]", line))
        rows += max(1, -(-chars // _CHARS_PER_LINE))  # 不足一行按整行
    return rows * _CHARS_PER_LINE


def _extract_page_number(md_path: Path) -> str:
    """从 page_NNN.md 提取页码，如 page_008.md → 'P8'。"""
    m = re.search(r"page_(\d+)", md_path.name)
    if m:
        return f"P{int(m.group(1))}"
    return ""


# 同行题拆行正则：(N) 前必须是句末标点或分号，排除正文续接如"与(2)类似"
_INLINE_Q_SPLIT_RE = re.compile(r'[；;]\s*(?=\([1-9]\d?\))|[。！？]\s*(?=\([1-9]\d?\))')


def _split_inline_questions(paragraph: str) -> list[str]:
    """将同一段内的同行题按 (N) 边界拆成独立段。

    正则覆盖 ; 和 。！？后的 (N)，防「与(2)类似」等正文括号误拆。
    无拆分点时返回原段落（单元素列表）。
    """
    parts = _INLINE_Q_SPLIT_RE.split(paragraph)
    return [p.strip() for p in parts if p.strip()]


def _split_paragraphs(text: str) -> list[str]:
    """按双换行拆分段落，再对每段做同行题拆行，过滤纯空行。"""
    parts = re.split(r"\n\n+", text)
    flat: list[str] = []
    for p in [p.strip() for p in parts if p.strip()]:
        inline_parts = _split_inline_questions(p)
        flat.extend(inline_parts)
    return flat


def _is_page_number_header(text: str, profile: TextbookProfile) -> bool:
    """判断是否为页眉/页脚残留（形态因学科而异，规则见 textbook_profile）。

    数学如 '3 第二十一章 一元二次方程'，语文如 '60 | 阅读 | 第三单元'。
    """
    return profile.is_page_furniture(text)


def _images_in_range(images: list[ImageInfo], start: int, end: int) -> list[ImageInfo]:
    """找到 position_in_text 在 [start, end) 范围内的图片。"""
    return [img for img in images if start <= img.position_in_text < end]


_HEADING_RE = re.compile(r'^#{1,6}\s+(.+)$')


def _current_heading(text: str) -> str | None:
    """返回 markdown 标题文本（如 '## 练习' -> '练习'），非标题返回 None。"""
    m = _HEADING_RE.match(text.strip())
    return m.group(1).strip() if m else None


def _is_pure_heading(text: str) -> bool:
    """整段是否仅为 markdown 标题行（无正文），用于判断孤立标题卡。"""
    return _HEADING_RE.match(text.strip()) is not None


def _is_question_starter(text: str) -> bool:
    """是否以 (N) 题号开头（半/全角括号兼容）。"""
    return bool(re.match(r'^[\(（]\s*[1-9]\d?\s*[\)）]', text.strip()))


def _split_first_sentence(text: str) -> tuple[str, str]:
    """按首个句末标点切 [首句, 剩余]；无标点则 [text, '']。

    注意：含分号「；」（_split_long_text 不含），因为补句只需拉一个子句，
    在分号处切可避免拉入过多内容。
    """
    m = re.search(r'[。！？；]', text)
    if not m:
        return text, ''
    return text[:m.end()], text[m.end():]


@dataclass
class _Bundle:
    """一个不可拆分的最小单元：一段文字 + 属于它的图片。"""
    text: str
    images: list[ImageInfo]
    text_chars: int
    image_cost: int
    heading: str | None = None


def _make_bundles(text: str, images: list[ImageInfo],
                  profile: TextbookProfile) -> list[_Bundle]:
    """把 Markdown 拆分为 bundle 列表。若段落文字 >400，按句末标点切开。

    例外：(N) 开头的题段落保持原子（不按句切），即便 >400。
    每个 bundle 标记其所属的最近 markdown 标题 heading，供后续同节补句判断。
    """
    paragraphs = _split_paragraphs(text)
    bundles: list[_Bundle] = []
    current_heading: str | None = None

    pos = 0
    for para in paragraphs:
        if _is_page_number_header(para, profile):
            continue

        # 更新当前标题（遇到新标题时跟踪）
        heading = _current_heading(para)
        if heading is not None:
            current_heading = heading

        para_start = text.index(para, pos) if para in text[pos:] else pos
        para_end = para_start + len(para)
        pos = para_end

        para_images = _images_in_range(images, para_start, para_end)
        para_text_chars = _count_text_chars(para)

        if para_text_chars > _TEXT_LIMIT and not _is_question_starter(para):
            # 按句末标点切开
            sub_texts = _split_long_text(para)
            for sub in sub_texts:
                sub_start = text.index(sub, para_start) if sub in text[para_start:para_end] else para_start
                sub_end = sub_start + len(sub)
                sub_images = _images_in_range(images, sub_start, sub_end)
                sub_chars = _count_text_chars(sub)
                sub_cost = sum(img.char_cost for img in sub_images)
                bundles.append(_Bundle(text=sub, images=sub_images, text_chars=sub_chars, image_cost=sub_cost, heading=current_heading))
        else:
            img_cost = sum(img.char_cost for img in para_images)
            bundles.append(_Bundle(text=para, images=para_images, text_chars=para_text_chars, image_cost=img_cost, heading=current_heading))

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
    bundles = _make_bundles(text, images, profile_for_md_path(md_path))

    # 贪心合并 bundle 为卡片
    fragments: list[CardFragment] = []
    current_texts: list[str] = []
    current_images: list[ImageInfo] = []
    current_text_chars = 0
    current_total = 0
    current_has_body = False  # 当前卡是否已有正文（非纯标题行）

    def _close_card():
        nonlocal current_texts, current_images, current_text_chars, current_total, current_has_body
        if not current_texts:
            return
        content_text = "\n\n".join(current_texts)
        fragments.append(CardFragment(
            sort_order=0,
            content=content_text,
            images=list(current_images),
            raw_text_char_count=current_text_chars,
            image_char_cost=sum(img.char_cost for img in current_images),
            total_char_cost=current_text_chars + sum(img.char_cost for img in current_images),
            textbook_page=page_label,
        ))
        current_texts = []
        current_images = []
        current_text_chars = 0
        current_total = 0
        current_has_body = False

    last_heading: str | None = None

    i = 0
    while i < len(bundles):
        bundle = bundles[i]

        # 大图独占卡（单图 cost > 700）：原地输出，保持文档顺序
        # （设计文档 §5.3 规则 3：图片保持在其原始位置）
        if len(bundle.images) == 1 and bundle.text_chars < 50 and bundle.image_cost > _TOTAL_LIMIT:
            _close_card()
            img = bundle.images[0]
            fragments.append(CardFragment(
                sort_order=0,
                content=f"![]({img.ref_path})",
                images=[img],
                raw_text_char_count=0,
                image_char_cost=img.char_cost,
                total_char_cost=img.char_cost,
                textbook_page=page_label,
            ))
            i += 1
            continue

        # 跨 heading 边界封卡（当前卡已有正文时）：
        # 孤立标题（无正文）不封卡，与后续内容合并，避免产生只有标题的空卡
        if (current_texts and bundle.heading is not None
                and last_heading is not None
                and bundle.heading != last_heading
                and current_has_body):
            _close_card()

        # 尝试直接放入当前卡
        if current_text_chars + bundle.text_chars <= _TEXT_LIMIT and current_total + bundle.text_chars + bundle.image_cost <= _TOTAL_LIMIT:
            current_texts.append(bundle.text)
            current_images.extend(bundle.images)
            current_text_chars += bundle.text_chars
            current_total += bundle.text_chars + bundle.image_cost
            if not _is_pure_heading(bundle.text):
                current_has_body = True
            last_heading = bundle.heading
            i += 1
            continue

        # 放不下：检查同节补句条件
        # 当前卡 <300 字且下一 bundle 同标题节且非题段落 -> 拉首句补入当前卡
        if (0 < current_text_chars < _TEXT_LIMIT * 0.75
                and last_heading is not None
                and bundle.heading == last_heading
                and not _is_question_starter(bundle.text)):
            first_sent, rest = _split_first_sentence(bundle.text)
            if rest:
                first_sent_chars = _count_text_chars(first_sent)
                if current_text_chars + first_sent_chars <= _TEXT_LIMIT and current_total + first_sent_chars <= _TOTAL_LIMIT:
                    # 拉首句入当前卡
                    current_texts.append(first_sent)
                    current_text_chars += first_sent_chars
                    current_total += first_sent_chars
                    current_has_body = True
                    # 剩余部分作为新 bundle 替换当前位置，不递增 i
                    rest_chars = _count_text_chars(rest)
                    bundles[i] = _Bundle(
                        text=rest, images=bundle.images,
                        text_chars=rest_chars, image_cost=bundle.image_cost,
                        heading=bundle.heading,
                    )
                    _close_card()
                    continue

        # 放不下：先把当前卡封存
        _close_card()

        # 现在把 bundle 放进新卡
        if bundle.text_chars <= _TEXT_LIMIT and bundle.text_chars + bundle.image_cost <= _TOTAL_LIMIT:
            current_texts = [bundle.text]
            current_images = list(bundle.images)
            current_text_chars = bundle.text_chars
            current_total = bundle.text_chars + bundle.image_cost
            current_has_body = not _is_pure_heading(bundle.text)
        elif bundle.text_chars <= _TEXT_LIMIT:
            # 文字够但图超了：压缩图
            image_room = _TOTAL_LIMIT - bundle.text_chars
            compressed_images = [_compress_image(img, image_room) for img in bundle.images]
            new_image_cost = sum(img.char_cost for img in compressed_images)
            current_texts = [bundle.text]
            current_images = compressed_images
            current_text_chars = bundle.text_chars
            current_total = bundle.text_chars + new_image_cost
            current_has_body = not _is_pure_heading(bundle.text)
        else:
            # 文字本身 >400（理论上 _make_bundles 已处理，兜底）
            sub_texts = _split_long_text(bundle.text)
            sub_start = 0
            for sub in sub_texts:
                sub_chars = _count_text_chars(sub)
                # 子段图片：按子段文本在 bundle.text 中的位置归属
                sub_pos = bundle.text.find(sub, sub_start)
                sub_end = sub_pos + len(sub)
                sub_imgs = [img for img in bundle.images
                            if sub_pos <= img.position_in_text < sub_end]
                sub_img_cost = sum(img.char_cost for img in sub_imgs)
                if current_text_chars + sub_chars <= _TEXT_LIMIT and current_total + sub_chars + sub_img_cost <= _TOTAL_LIMIT:
                    current_texts.append(sub)
                    current_images.extend(sub_imgs)
                    current_text_chars += sub_chars
                    current_total += sub_chars + sub_img_cost
                    current_has_body = True
                else:
                    _close_card()
                    current_texts = [sub]
                    # 文字放得下但图超了：压缩图
                    if sub_chars <= _TEXT_LIMIT:
                        image_room = _TOTAL_LIMIT - sub_chars
                        current_images = [_compress_image(img, image_room) for img in sub_imgs]
                        new_img_cost = sum(img.char_cost for img in current_images)
                        current_text_chars = sub_chars
                        current_total = sub_chars + new_img_cost
                    else:
                        current_images = list(sub_imgs)
                        current_text_chars = sub_chars
                        current_total = sub_chars + sub_img_cost
                    current_has_body = True
                sub_start = sub_end

        last_heading = bundle.heading
        i += 1

    _close_card()

    # 统一编号（solo 图卡已在主循环内按文档顺序原地输出）
    for i, frag in enumerate(fragments, 1):
        frag.sort_order = i

    return fragments

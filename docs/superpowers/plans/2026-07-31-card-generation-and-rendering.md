# Card 内容生成与渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对齐 `http://localhost:3000/student/learn` 参考页，修正 data-refinery 管线的前置页过滤、卡片容量（400/700 字）、图片算法，并重构前端 `CourseDetailPage.tsx`。

**Architecture:** 管线侧采用"确定性规则预过滤 + LLM 标注 + 保守 fallback"三层防御，避免 gemma4 26B 误判 front_matter；分卡采用 image-aware greedy，以段落+图为 bundle 合并。前端侧新增 learn 页专用 design token，按参考页像素级还原布局/字号/配色。

**Tech Stack:** Python 3.11 + pytest（data-refinery）；React 19 + TypeScript 5 + Tailwind CSS 3 + Vite（apps/web）

---

## File Structure

### data-refinery（管线）

| 文件 | 职责 |
|---|---|
| `tools/data-refinery/src/models.py` | `ImageInfo` 增加 `scaled_width`/`scaled_height` |
| `tools/data-refinery/src/image_scan.py` | 更新常量 `LINE_HEIGHT=26`、`CHARS_PER_LINE=48`、`IMG_MAX_WIDTH=768`；cost 公式改为高度整行法 |
| `tools/data-refinery/src/card_splitter.py` | 重写：TEXT_LIMIT=400、TOTAL_LIMIT=700、bundle 拆分、image-aware greedy 合并、图压缩 |
| `tools/data-refinery/src/extract_cli.py` | 新增 `pre_filter_page()`；LLM 失败 fallback 改为 `front_matter` |
| `tools/data-refinery/tests/test_image_scan.py` | 新增：验证 cost 公式与 scaled 尺寸 |
| `tools/data-refinery/tests/test_card_splitter.py` | 新增：验证分卡边界（400+260、260+400、400+400、超长段切分） |

### apps/web（前端）

| 文件 | 职责 |
|---|---|
| `apps/web/src/styles/global.css` | 新增 learn 页 CSS token |
| `apps/web/style.md` | 在 §2 末尾新增 "学习沉浸页专用 Token" 小节 |
| `apps/web/src/pages/student/CourseDetailPage.tsx` | 重构：288px 左侧阶段栏、896px 白卡、768px prose、H1/H2/正文层级、护眼模式移至右上角、答疑悬浮圆形按钮、垂直居中 |

---

## Task 1: 更新 `models.py` — ImageInfo 增加 scaled 尺寸字段

**Files:**
- Modify: `tools/data-refinery/src/models.py`

- [ ] **Step 1: 修改 `ImageInfo` dataclass**

```python
@dataclass
class ImageInfo:
    """一张图片的元信息（image_scan 产出）"""
    ref_path: str         # MD 中的引用路径
    disk_path: Path       # 磁盘实际路径
    width: int            # 原始宽度 px
    height: int           # 原始高度 px
    scaled_width: int     # 缩放后宽度 px（≤IMG_MAX_WIDTH）
    scaled_height: int    # 缩放后高度 px
    char_cost: int        # 折算字数
    position_in_text: int  # 在 text_content 中的字符偏移
```

- [ ] **Step 2: Commit**

```bash
git add tools/data-refinery/src/models.py
git commit -m "feat(data-refinery): add scaled_width/scaled_height to ImageInfo"
```

---

## Task 2: 重写 `image_scan.py` — 新常量与新 cost 公式

**Files:**
- Modify: `tools/data-refinery/src/image_scan.py`

- [ ] **Step 1: 替换整个文件**

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add tools/data-refinery/src/image_scan.py
git commit -m "feat(data-refinery): update image_scan constants and cost formula"
```

---

## Task 3: 重写 `card_splitter.py` — 400/700 容量 + image-aware greedy

**Files:**
- Modify: `tools/data-refinery/src/card_splitter.py`

- [ ] **Step 1: 替换整个文件**

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add tools/data-refinery/src/card_splitter.py
git commit -m "feat(data-refinery): rewrite card_splitter with 400/700 limits and image-aware greedy"
```

---

## Task 4: 更新 `extract_cli.py` — front_matter 预过滤 + 保守 fallback

**Files:**
- Modify: `tools/data-refinery/src/extract_cli.py`

- [ ] **Step 1: 在 `extract_cli.py` 顶部导入区之后新增 `pre_filter_page` 函数**

```python
import re

def is_front_matter(text: str, page_num: int) -> bool:
    """确定性预过滤：识别目录页、版权页、空页等前置内容。

    在 LLM 标注之前调用，避免 gemma4 26B 误判。
    """
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    # 1. 版权页
    if any(k in text for k in ["出版社", "仅供个人学习", "未经授权", "版权所有"]):
        return True

    # 2. 目录页：大量 "标题 数字" 行
    toc_line_count = sum(
        1 for l in lines
        if re.search(r'[一二三四五六七八九十\d].+\s+\d{1,3}$', l)
    )
    if len(lines) > 0 and toc_line_count / len(lines) >= 0.5:
        return True

    # 3. 空页或前置空白页（前 10 页内极短内容）
    if len(text.strip()) < 30 and page_num <= 10:
        return True

    return False
```

- [ ] **Step 2: 在 `main()` 的循环体中，在 `image_scan` 之前插入预过滤**

找到这段代码（约 line 250 附近）：

```python
        try:
            # ① image_scan：获取图片尺寸 + 折算字数
            images = scan_page(source.md_path)
```

替换为：

```python
        try:
            # ① 前置页预过滤（确定性规则，避免 LLM 误判）
            text = source.md_path.read_text(encoding="utf-8")
            page_num = int(cards[0].textbook_page.replace("P", "")) if cards else 0
            if is_front_matter(text, page_num):
                checkpoint.mark_extracted(file_key)
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> 0 items (front matter)", flush=True)
                extracted += 1
                continue

            # ② image_scan：获取图片尺寸 + 折算字数
            images = scan_page(source.md_path)

            # ③ card_splitter：拆分卡片
            cards = split_page(source.md_path, text, images)
```

同时需要把 `text = source.md_path.read_text(...)` 从原来 `card_splitter` 调用处提前到这里。原来的代码是：

```python
            # ② card_splitter：拆分卡片
            text = source.md_path.read_text(encoding="utf-8")
            cards = split_page(source.md_path, text, images)
```

现在已经提前读 text 了，所以把原来那行 `text = ...` 删掉，只保留 `cards = split_page(...)`。

- [ ] **Step 3: 修正 LLM 失败 fallback**

找到 fallback 代码（约 line 288-296）：

```python
                result = PageLabelResult(
                    page_type="content",
                    labels=[LabelResult(
                        page_type="content", card_type="concept",
                        lesson_id=prev, title=None,
                        textbook_page=f"P{page_num}",
                    ) for _ in cards],
                )
```

改为：

```python
                result = PageLabelResult(
                    page_type="front_matter",
                    labels=[LabelResult(
                        page_type="front_matter", card_type="concept",
                        lesson_id=prev, title=None,
                        textbook_page=f"P{page_num}",
                    ) for _ in cards],
                )
```

- [ ] **Step 4: Commit**

```bash
git add tools/data-refinery/src/extract_cli.py
git commit -m "feat(data-refinery): add front_matter pre-filter and conservative LLM fallback"
```

---

## Task 5: 写管线测试并跑回归

**Files:**
- Create: `tools/data-refinery/tests/test_image_scan.py`
- Create: `tools/data-refinery/tests/test_card_splitter.py`

- [ ] **Step 1: 写 `test_image_scan.py`**

```python
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
```

- [ ] **Step 2: 写 `test_card_splitter.py`**

```python
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
    # 图片被压缩到 300 字成本
    assert cards[0].image_char_cost == 300
    assert cards[0].total_char_cost == 700


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
```

- [ ] **Step 3: 跑测试**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/tools/data-refinery
python -m pytest tests/test_image_scan.py tests/test_card_splitter.py -v
```

Expected: 全部 PASS

- [ ] **Step 4: 跑实际回归（九年级下册 page_005-010）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/tools/data-refinery
python -m src.extract_cli \
  --book "九年级/下册" \
  --pages "5-10" \
  --reconvert
```

检查 `output/extracted/.../page_005.jsonl`、`page_006.jsonl`、`page_007.jsonl` 应不存在或为空；`page_009.jsonl`、`page_010.jsonl` 应正常有内容。

- [ ] **Step 5: Commit**

```bash
git add tools/data-refinery/tests/test_image_scan.py tools/data-refinery/tests/test_card_splitter.py
git commit -m "test(data-refinery): add image_scan and card_splitter tests"
```

---

## Task 6: 更新 `global.css` — 新增 learn 页 token

**Files:**
- Modify: `apps/web/src/styles/global.css`

- [ ] **Step 1: 在 `:root` 区块末尾（`--motion-ease` 之后）新增 learn 页 token**

```css
  /* ===== Learn Page Tokens (P2.2 CourseDetail) =====
     Values measured from reference page http://localhost:3000/student/learn
     at 1920×825 viewport. */
  --learn-sidebar-width: 18rem;        /* 288px @root16 */
  --learn-sidebar-width-ipad: 14rem;   /* 224px for iPad */
  --learn-card-max-w: 56rem;           /* 896px */
  --learn-prose-w: 48rem;              /* 768px */
  --learn-card-bg: #FDFCF8;
  --learn-text-primary: #3C4A35;
  --learn-heading-1: #333333;
  --learn-heading-2: #B0C4DE;

  --fs-learn-h1: 1.25rem;              /* 20px */
  --fs-learn-h2: 1.125rem;             /* 18px */
  --fs-learn-body: 1rem;               /* 16px */
  --lh-learn-body: 1.625;              /* 26px */
```

- [ ] **Step 2: 在 `.textbook-prose` 区块之后新增 learn 页 prose 样式**

```css
/* ===== Learn Page Prose (reference page styles) ===== */
.learn-prose {
  color: var(--learn-text-primary);
  font-size: var(--fs-learn-body);
  line-height: var(--lh-learn-body);
}
.learn-prose h2 {
  color: var(--learn-heading-2);
  font-size: var(--fs-learn-h2);
  font-weight: 900;
  line-height: 1.75rem;  /* 28px */
  margin-bottom: 1.5rem;
}
.learn-prose h3 {
  font-size: var(--fs-learn-body);
  font-weight: 700;
  line-height: var(--lh-learn-body);
}
.learn-prose p {
  margin: 0;
}
.learn-prose p + p {
  margin-top: 1rem;
}
.learn-prose strong {
  font-weight: 700;
}
.learn-prose ul,
.learn-prose ol {
  padding-left: 1.5em;
  list-style-position: outside;
}
.learn-prose ul { list-style-type: disc; }
.learn-prose ol { list-style-type: decimal; }
.learn-prose li {
  line-height: 2;  /* 32px for list items */
}
.learn-prose .katex { font-size: 1.05em; }
.learn-prose img {
  display: block;
  margin: 1rem auto;
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-card);
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles/global.css
git commit -m "feat(web): add learn page design tokens and prose styles"
```

---

## Task 7: 更新 `style.md` — 同步记录 learn 页 token

**Files:**
- Modify: `apps/web/style.md`

- [ ] **Step 1: 在 §2.4 "三层视觉体系" 表格之后新增小节**

```markdown
### 2.5 学习沉浸页专用 Token（P2.2 CourseDetail）

以下 Token 专用于课程详情页（教材卡片阅读），值来源于参考页 `http://localhost:3000/student/learn` 实测（1920×825 视口）。

```
布局
  Learn-Sidebar-Width    18rem (288px)   左侧阶段栏
  Learn-Card-Max-W       56rem (896px)   白卡最大宽度
  Learn-Prose-W          48rem (768px)   正文栏宽度

颜色
  Learn-Card-Bg          #FDFCF8         白卡背景
  Learn-Text-Primary     #3C4A35         正文/列表
  Learn-Heading-1        #333333         小节标题
  Learn-Heading-2        #B0C4DE         卡片内标题

字号
  fs-learn-h1            1.25rem (20px)  小节标题
  fs-learn-h2            1.125rem (18px) 卡片内标题
  fs-learn-body          1rem (16px)     正文
  lh-learn-body          1.625           正文行高
```
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/style.md
git commit -m "docs(style): document learn page tokens"
```

---

## Task 8: 重构 `CourseDetailPage.tsx` — 对齐参考页

**Files:**
- Modify: `apps/web/src/pages/student/CourseDetailPage.tsx`

- [ ] **Step 1: 替换整个文件**

```tsx
import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { useThemeStore } from '@/store/themeStore';
import { fetchLessonCards, type LessonCard, type LessonCardsData } from '@/services/api';

const ASSET_BASE = (import.meta.env.VITE_ASSET_BASE_URL as string) || '/assets/';
const resolveAsset = (p: string) =>
  /^https?:\/\//.test(p) ? p : `${ASSET_BASE}${p.replace(/^\/+/, '')}`;

// --- Icons ---
const ArrowLeftIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);
const ChatIcon = () => (
  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const SunIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const MoonIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const CARD_TYPE_LABEL: Record<LessonCard['cardType'], string> = {
  concept: '概念',
  example: '例题',
  practice: '练习',
  explore: '探究',
  summary: '小结',
  reading: '阅读',
};

function LoadingSkeleton() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-[var(--bg-subtle)] rounded-lg mx-auto" />
        <div className="h-[24rem] w-[46rem] max-w-[90vw] bg-[var(--bg-subtle)] rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[var(--bg-base)]">
      <p className="text-[var(--text-secondary)] text-lg">{message}</p>
      <button onClick={onRetry} className="px-6 py-2.5 bg-[var(--brand-500)] text-white rounded-[var(--radius-button)] font-medium">
        重试
      </button>
    </div>
  );
}

export default function CourseDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { mode, setMode, autoToggleNightMode } = useThemeStore();

  const lessonId =
    (location.state as { lessonId?: number } | null)?.lessonId ??
    Number(searchParams.get('lessonId')) ??
    0;
  const breadcrumb = (location.state as { breadcrumb?: string } | null)?.breadcrumb ?? '';

  const [data, setData] = useState<LessonCardsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (!lessonId) throw new Error('缺少课程信息，请从星图选择小节进入');
      const result = await fetchLessonCards(lessonId);
      if (result.cards.length === 0) throw new Error('本节暂无卡片内容');
      setData(result);
      setPage(0);
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [lessonId]);

  const total = data?.cards.length ?? 0;
  const card = useMemo(() => data?.cards[page] ?? null, [data, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setPage(p => Math.max(0, p - 1));
      if (e.key === 'ArrowRight') setPage(p => Math.min(total - 1, p + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total]);

  if (loading) return <LoadingSkeleton />;
  if (error) return <ErrorState message={error} onRetry={fetchData} />;
  if (!data || !card) return <ErrorState message="暂无课程数据" onRetry={fetchData} />;

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="h-screen flex bg-[var(--bg-base)] text-[var(--text-primary)] overflow-hidden">
        {/* 左侧阶段栏 */}
        <aside
          className="hidden md:flex flex-col shrink-0 bg-[var(--bg-page)] border-r border-[var(--bg-subtle)]"
          style={{ width: 'var(--learn-sidebar-width)' }}
        >
          <div className="p-5">
            <button
              onClick={() => navigate('/student/level-map')}
              className="flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors mb-4"
            >
              <ArrowLeftIcon />
              <span>返回关卡星地图</span>
            </button>
            <h2 className="text-sm text-[var(--text-tertiary)] mb-1">今日任务</h2>
            <h1 className="text-lg font-bold text-[var(--text-primary)]">数学 · 初二上</h1>
          </div>

          <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
            {/* 阶段列表 — 由后端接口返回，此处静态占位 */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-subtle)]/50">
              <div className="w-2 h-2 rounded-full bg-[var(--text-tertiary)] mt-1.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)]">错题清零（前一课）</p>
                <p className="text-xs text-[var(--text-tertiary)]">有 2 道错题未清</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-[var(--brand-500)] mt-1.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">12.2 一元二次方程的解法</p>
                <p className="text-xs text-[var(--text-tertiary)]">核心知识</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg opacity-50">
              <div className="w-2 h-2 rounded-full bg-[var(--text-tertiary)] mt-1.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)]">课堂练习</p>
                <p className="text-xs text-[var(--text-tertiary)]">思路提示</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg opacity-50">
              <div className="w-2 h-2 rounded-full bg-[var(--text-tertiary)] mt-1.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)]">第十二章 单元检测</p>
                <p className="text-xs text-[var(--text-tertiary)]">闭卷测试</p>
              </div>
            </div>
          </nav>

          <div className="p-4 border-t border-[var(--bg-subtle)]">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[var(--bg-subtle)] flex items-center justify-center text-sm font-bold text-[var(--text-secondary)]">
                小
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">小明</p>
                <p className="text-xs text-[var(--text-tertiary)]">专注学习中…</p>
              </div>
            </div>
          </div>
        </aside>

        {/* 主内容区 */}
        <main className="flex-1 min-w-0 flex flex-col">
          {/* Header */}
          <header className="flex items-center justify-between gap-4 px-6 py-4 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-sm text-[var(--text-secondary)] truncate">
                {breadcrumb ? `${breadcrumb} · ` : ''}{data.lessonName}
              </span>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <span className="text-sm font-medium text-[var(--text-tertiary)] tabular-nums">
                {page + 1} / {total}
              </span>
              <button
                onClick={() => setMode(mode === 'student-day' ? 'student-night' : 'student-day')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-pill)] text-xs text-[var(--text-secondary)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-card)] transition-colors"
                title="切换护眼模式"
              >
                {mode === 'student-day' ? <SunIcon /> : <MoonIcon />}
                <span>护眼</span>
              </button>
            </div>
          </header>

          {/* Card area */}
          <div className="flex-1 min-h-0 flex flex-col items-center px-4 md:px-8 py-2">
            <AnimatePresence mode="wait">
              <motion.div
                key={card.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.2 }}
                className="relative flex-1 min-h-0 w-full flex flex-col"
                style={{ maxWidth: 'var(--learn-card-max-w)' }}
              >
                {/* 小节标题（H1） */}
                <div className="shrink-0 mb-3">
                  <h1
                    className="font-bold"
                    style={{
                      fontSize: 'var(--fs-learn-h1)',
                      lineHeight: '1.75rem',
                      color: 'var(--learn-heading-1)',
                    }}
                  >
                    {data.lessonName} 知识自学与概念理解
                  </h1>
                </div>

                {/* 白卡 */}
                <div
                  className="flex-1 min-h-0 flex flex-col rounded-xl overflow-hidden"
                  style={{ backgroundColor: 'var(--learn-card-bg)' }}
                >
                  {/* 卡片内容 — 垂直居中 */}
                  <div className="flex-1 min-h-0 flex flex-col justify-center px-8 md:px-12 py-6 overflow-y-auto">
                    <div className="mx-auto" style={{ width: '100%', maxWidth: 'var(--learn-prose-w)' }}>
                      {/* 卡片类型标签 */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded bg-[var(--brand-100)] text-[var(--brand-600)]">
                          {CARD_TYPE_LABEL[card.cardType] ?? card.cardType}
                        </span>
                        {card.textbookPage && (
                          <span className="text-xs text-[var(--text-tertiary)]">{card.textbookPage}</span>
                        )}
                      </div>

                      {/* 卡片内容标题（H2） */}
                      {card.title && (
                        <h2
                          className="font-black leading-snug mb-4"
                          style={{
                            fontSize: 'var(--fs-learn-h2)',
                            color: 'var(--learn-heading-2)',
                          }}
                        >
                          {card.title}
                        </h2>
                      )}

                      {/* Markdown body */}
                      <div className="learn-prose">
                        <ReactMarkdown
                          remarkPlugins={[remarkMath, remarkGfm]}
                          rehypePlugins={[rehypeKatex]}
                          components={{
                            img: ({ src, alt }) => (
                              <img
                                src={src ? resolveAsset(src) : ''}
                                alt={alt ?? ''}
                                className="block mx-auto my-4 max-w-full h-auto rounded-lg"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                              />
                            ),
                          }}
                        >
                          {card.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>

                  {/* 悬浮答疑按钮 */}
                  <button
                    onClick={() => navigate('/student/ai-discuss', { state: { cardId: card.id, lessonId } })}
                    className="absolute right-6 bottom-20 w-14 h-14 rounded-full bg-[var(--brand-500)] text-white shadow-lg flex items-center justify-center hover:bg-[var(--brand-600)] transition-colors z-10"
                    title="思辨答疑"
                  >
                    <ChatIcon />
                  </button>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* 底部操作栏 */}
          <footer className="shrink-0 flex items-center justify-between gap-4 px-6 md:px-8 py-4">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page <= 0}
              className="px-5 py-2.5 rounded-[var(--radius-button)] text-[var(--text-secondary)] font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--bg-subtle)] transition-colors"
            >
              上一页
            </button>

            {page < total - 1 ? (
              <button
                onClick={() => setPage(p => Math.min(total - 1, p + 1))}
                className="px-5 py-2.5 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-white font-medium hover:bg-[var(--brand-600)] transition-colors"
              >
                下一页
              </button>
            ) : (
              <button
                onClick={() => navigate('/student/homework', { state: { lessonId } })}
                className="px-5 py-2.5 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-white font-medium hover:bg-[var(--brand-600)] transition-colors"
              >
                开始作业
              </button>
            )}
          </footer>
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/student/CourseDetailPage.tsx
git commit -m "feat(web):重构 CourseDetailPage 对齐参考页布局"
```

---

## Self-Review Checklist

### 1. Spec coverage

| Spec 章节 | 对应 Task |
|---|---|
| §5.2 front_matter 预过滤规则 | Task 4 |
| §5.2 LLM fallback 修正 | Task 4 |
| §2.2 learn 页 token | Task 6 |
| §2.3 布局（288px 边栏/896px 白卡/768px prose） | Task 8 |
| §2.3 护眼模式移至右上角 | Task 8 |
| §2.3 答疑悬浮圆形按钮 | Task 8 |
| §3.2 常量（LINE_HEIGHT=26, CHARS_PER_LINE=48） | Task 2 |
| §3.3 图片 cost 公式 | Task 2 |
| §3.4 分卡算法（bundle + greedy + 图压缩） | Task 3 |
| §3.5 验证示例（400+260、260+400、400+400） | Task 5 |
| §4 前端图片渲染（块级居中） | Task 8 |

✅ 无 gap。

### 2. Placeholder scan

- ✅ 无 TBD、TODO、"implement later"、"fill in details"
- ✅ 无 "Add appropriate error handling" 等模糊描述
- ✅ 每个代码步骤都有完整代码
- ✅ 命令包含预期输出

### 3. Type consistency

- ✅ `ImageInfo` 字段名在 Task 1、Task 2、Task 3 中一致（`scaled_width`、`scaled_height`）
- ✅ `CardFragment` 字段名与现有 `models.py` 一致
- ✅ `LessonCard` / `LessonCardsData` 类型引用保持与现有 API 一致

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-31-card-generation-and-rendering.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach do you prefer?**

"""扫描件语文卷「加点 / 下划线」dry-run 检测清单。

背景（2026-11-07）：`pdf_emphasis` 只读 PDF 的文字层与矢量图形，扫描件（每页一张
整页图片、文字层只剩水印）检不出任何真实标记。本脚本走图像路线：

1. 渲染页面 → PaddleOCR（`return_word_box=True`）拿逐字框；
2. 逐字检查字框底部的小圆点（加点）与细横线（下划线/画线句）；
3. 用 OCR 行文本在切题结果里做最长公共子串匹配，尽量标出题号。

**只检测、只输出清单，不改库、不改 output/md 或 output/published。**

用法（在 tools/data-refinery/ 下）：

    python3 src/scanned_emphasis.py --file 海淀 --limit 1
    python3 src/scanned_emphasis.py --subject 语文 --limit 5
    python3 src/scanned_emphasis.py --pdf ../../crawler/data/.../试卷.pdf

PaddleOCR 不是管线依赖（requirements.txt 没有），缺失时脚本会明确提示；
本机已装 3.6.0 可用。默认用 mobile 模型（150 DPI 实测约 17s/页，10 页约 2.5 分钟）；
首次运行会下载/加载 PP-OCRv5 mobile 模型，想更准可加 `--server-ocr`（本机单页数分钟）。

已知误报（dry-run 清单里会带 `confidence`，人工复核时按低置信过滤）：
- 表格边框会被当成下划线（如统计表表头）；
- 页脚「第N页（共N页）」、卷首「注意事项」表格已按行过滤；
- 单字/双字下划线多为装饰线/边框，标 `confidence=low`。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from config import RefineryConfig
from scanner import MaterialScanner
from scope_filter import match_keyword
from subject_codes import subject_code_for_parts

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_PUNCT = set("，。；：、！？（）【】《》“”‘’...,.;:!?()[]<>\"'")
_WATERMARK = "易水小寒转发"
# 卷首说明/页眉页脚：短行命中即跳过，避免把「注意事项」的表格边框当下划线
_NOISE_LINE_RE = re.compile(
    r"注意事项|考生须知|考试说明|本试卷|第\s*\d+\s*页|共\s*\d+\s*页|"
    r"语文试卷|九年级语文|姓名|准考证|班级|学校")


@dataclass
class CharBox:
    ch: str
    x0: float
    y0: float
    x1: float
    y1: float
    line_id: int
    index: int
    line_text: str

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def w(self) -> float:
        return max(0.1, self.x1 - self.x0)

    @property
    def h(self) -> float:
        return max(0.1, self.y1 - self.y0)


@dataclass
class Hit:
    page: int
    kind: str            # dots | underline
    chars: str
    line: str
    boxes: list[tuple[float, float, float, float]] = field(default_factory=list)
    question_no: int | None = None
    match_len: int = 0
    ambiguous: bool = False
    start: int = 0
    end: int = 0


def _load_ocr(server: bool = False):
    """延迟加载 PaddleOCR；缺失时给出可执行的提示。

    默认用 mobile 模型：server 模型在这台机器上单页要几分钟，mobile 约 17s/页
    （150 DPI 整页）。accuracy 用 server 模型的 `--server-ocr`。
    """
    try:
        from paddleocr import PaddleOCR
    except Exception as e:  # pragma: no cover - 本机已装，仅保护其它环境
        raise SystemExit(
            "扫描件检测需要 PaddleOCR（本机已装 3.6.0，但不在 requirements.txt）：\n"
            "  pip install paddleocr\n"
            f"原始错误：{type(e).__name__}: {e}"
        )
    import os
    # 首次下载检查会挂 20s；模型已缓存时直接跳过
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    kwargs = dict(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        return_word_box=True,
        lang="ch",
        text_det_limit_side_len=960,
    )
    if not server:
        kwargs.update(
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_recognition_model_name="PP-OCRv5_mobile_rec",
        )
    return PaddleOCR(**kwargs)


def _ocr_chars(ocr, image_bgr: np.ndarray) -> list[CharBox]:
    """PaddleOCR 逐字框 → CharBox 列表（已剔除水印行）。"""
    res = ocr.predict(image_bgr)[0]
    texts = res.get("rec_texts") or []
    words = res.get("text_word") or []
    regions = res.get("text_word_region") or []
    out: list[CharBox] = []
    for line_id, (line_text, ws, rs) in enumerate(zip(texts, words, regions)):
        if not line_text or _WATERMARK in line_text:
            continue
        # 页脚「第10页（共10页）」等：不管长度都跳过，避免页脚横线/数字被当成标记
        if re.search(r"第\s*\d+\s*页|共\s*\d+\s*页", line_text):
            continue
        if len(line_text.strip()) <= 16 and _NOISE_LINE_RE.search(line_text):
            continue
        for idx, (ch, quad) in enumerate(zip(ws, rs)):
            if not ch or ch.isspace():
                continue
            xs = [float(p[0]) for p in quad]
            ys = [float(p[1]) for p in quad]
            out.append(CharBox(
                ch=ch,
                x0=min(xs), y0=min(ys), x1=max(xs), y1=max(ys),
                line_id=line_id, index=idx, line_text=line_text,
            ))
    return out


def _components(gray: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """返回连通域列表 (x,y,w,h,area)。一次算完，逐字复用以避免 O(字×连通域)。"""
    bw = (gray < 160).astype(np.uint8)
    _, _, stats, _ = cv2.connectedComponentsWithStats(bw, 8)
    return [(int(x), int(y), int(w), int(h), int(area))
            for x, y, w, h, area in stats[1:]]


def _dot_shape_ok(w: int, h: int, area: int, box: CharBox) -> bool:
    """单个连通域是否像「字下小黑点」（尺寸/圆度/占比相对字高自适应）。"""
    return (
        2 <= w <= max(6, box.h * 0.35)
        and 2 <= h <= max(6, box.h * 0.35)
        and 4 <= area <= max(40, box.w * box.h * 0.06)
        and 0.55 <= w / max(1, h) <= 1.8
        and area / max(1, w * h) >= 0.45   # 实心圆点；细笔画/横线不到
        and w <= box.w * 0.55              # 下划线/长横
    )


def _dot_candidates(comps: list[tuple[int, int, int, int, int]],
                    box: CharBox) -> list[tuple[int, int, int, int, int]]:
    """字符框底部窄带内、可能属于「加点」的小连通域。"""
    pad_y = box.h * 0.35
    out: list[tuple[int, int, int, int, int]] = []
    for x, y, w, h, area in comps:
        cx, cy = x + w / 2, y + h / 2
        # 只看字框下半部到字框下方 35% 高度
        if cy < box.y0 + box.h * 0.80 or cy > box.y1 + pad_y:
            continue
        # 必须在字框中心附近（着重点是字下居中一个小点）
        if abs(cx - box.cx) > box.w * 0.30:
            continue
        if not _dot_shape_ok(w, h, area, box):
            continue
        out.append((x, y, w, h, area))
    return out


def _dot_cluster_count(comps: list[tuple[int, int, int, int, int]],
                       box: CharBox,
                       cand: tuple[int, int, int, int, int]) -> int:
    """同一高度带上、同一字宽内的「小点」个数。

    「熙」的灬、「想」的心都是并列多个小点，不能当成一个着重号；
    真正的着重号是字下孤零零一个点。
    """
    y0 = cand[1] - box.h * 0.08
    y1 = cand[1] + cand[3] + box.h * 0.08
    count = 0
    for x, y, w, h, area in comps:
        if y + h < y0 or y > y1:
            continue
        if x + w < box.x0 or x > box.x1:
            continue
        if _dot_shape_ok(w, h, area, box):
            count += 1
    return count


def _is_below_glyph(comps: list[tuple[int, int, int, int, int]], box: CharBox,
                    cand: tuple[int, int, int, int, int]) -> bool:
    """候选点是否在字符主体墨迹下方（排除「想」字心里的小点等笔画）。

    取字框内除候选点以外的所有墨迹，要求候选点的上沿不低于其它墨迹的下沿。
    """
    cx0, cy0 = box.x0 - box.w * 0.1, box.y0 - box.h * 0.1
    cx1, cy1 = box.x1 + box.w * 0.1, box.y1 + box.h * 0.35
    other_bottom = -1.0
    for x, y, w, h, _ in comps:
        if (x, y, w, h) == cand:
            continue
        if x + w < cx0 or x > cx1 or y + h < cy0 or y > cy1:
            continue
        # 只统计候选点上方的墨迹（下方墨迹是别的行/标点，不参与）
        if y < cand[1]:
            other_bottom = max(other_bottom, y + h)
    return cand[1] >= other_bottom - 1


def detect_dots(gray: np.ndarray, chars: list[CharBox]) -> list[Hit]:
    """逐字检测加点，按行内连续字符合并成一段。"""
    comps = _components(gray)
    marked: list[tuple[CharBox, tuple[int, int, int, int, int]]] = []
    for box in chars:
        if not _CJK_RE.fullmatch(box.ch) or box.ch in _PUNCT:
            continue
        cands = [c for c in _dot_candidates(comps, box) if _is_below_glyph(comps, box, c)]
        if len(cands) == 1 and _dot_cluster_count(comps, box, cands[0]) == 1:
            marked.append((box, cands[0]))
    return _group_hits(marked, "dots")


def _underline_for(box: CharBox, gray: np.ndarray) -> bool:
    """字符框底部是否有贯穿字宽 70% 的细横线（下划线/画线）。

    从字框下沿**之外**开始找：字框含行高，框内底部是汉字自己的笔画，
    直接算会把每个字的底横都当成下划线（实心方框测试即复现）。
    """
    y0 = max(0, int(box.y1 + 1))
    y1 = min(gray.shape[0], int(box.y1 + box.h * 0.30))
    x0 = max(0, int(box.x0 + box.w * 0.08))
    x1 = min(gray.shape[1], int(box.x1 - box.w * 0.08))
    if x1 <= x0 or y1 <= y0:
        return False
    band = gray[y0:y1, x0:x1] < 160
    need = (x1 - x0) * 0.70
    return bool((band.sum(axis=1) >= need).any())


def _row_runs(mask: np.ndarray, max_gap: int = 2) -> list[tuple[int, int]]:
    """一行二值像素里的连续暗段（允许 max_gap 像素的小空隙）。"""
    runs: list[tuple[int, int]] = []
    start = None
    last = -10
    for i, on in enumerate(mask):
        if not on:
            continue
        if start is None:
            start = i
        elif i - last > max_gap + 1:
            runs.append((start, last + 1))
            start = i
        last = i
    if start is not None:
        runs.append((start, last + 1))
    return runs


def detect_underlines(gray: np.ndarray, chars: list[CharBox]) -> list[Hit]:
    """按「整行横向暗段」检测下划线，而不是逐字判断。

    逐字判断分不清「字自己的底横」和「下划线」；下划线的特征是**同一行连续
    覆盖多个字**。OCR 字框通常含行高，下划线落在字框底部内侧（Q6 实测：
    字框 y1=240，线在 235–237），所以扫描带要包含字框最后 30%。
    """
    from collections import defaultdict

    lines: dict[int, list[CharBox]] = defaultdict(list)
    for c in chars:
        if _CJK_RE.fullmatch(c.ch) and c.ch not in _PUNCT:
            lines[c.line_id].append(c)

    marked: list[tuple[CharBox, tuple[int, int, int, int, int]]] = []
    seen: set[tuple[int, int]] = set()
    for line in lines.values():
        if len(line) < 3:
            continue
        line.sort(key=lambda c: c.x0)
        x0 = min(c.x0 for c in line)
        x1 = max(c.x1 for c in line)
        y1 = max(c.y1 for c in line)
        h = max(6.0, sum(c.h for c in line) / len(line))
        # 只看字框最底部 15%：下划线是贴着字底的细线；再往上是字身笔画。
        # 行内空隙只允许 2px（真正的下划线是连续的；字与字之间的空隙更大），
        # 再靠「覆盖≥3 个字」排除单字底横。
        for y in range(max(0, int(y1 - h * 0.15)),
                       min(gray.shape[0], int(y1 + h * 0.28))):
            row = gray[y, int(x0):int(x1)] < 160
            for run_start, run_end in _row_runs(row):
                if run_end - run_start < 10:
                    continue
                covered = []
                run_abs_start, run_abs_end = x0 + run_start, x0 + run_end
                for c in line:
                    overlap = max(0.0, min(c.x1, run_abs_end)
                                  - max(c.x0, run_abs_start))
                    if overlap >= c.w * 0.5:
                        covered.append(c)
                if len(covered) < 3:
                    continue
                for c in covered:
                    key = (c.line_id, c.index)
                    if key not in seen:
                        seen.add(key)
                        marked.append((c, (0, 0, 0, 0, 0)))
                break   # 该行找到一条下划线就够，避免同一条线重复标记
    return _group_hits(marked, "underline")


def _group_hits(marked, kind: str) -> list[Hit]:
    """同一行相邻字符合成一段（中间允许隔一个标点）。"""
    # 行级下划线是按「行扫描」收集的，跨行/跨 run 时顺序会乱；按字符下标重排，
    # 否则 hit.chars 变成「香有韵…农耕有乐」这种乱序，decorate_text 找不到。
    marked = sorted(marked, key=lambda item: (item[0].line_id, item[0].index))
    # 下划线允许跨一个标点（保留逗号才能按原文匹配）；加点只合并相邻字。
    max_gap = 2 if kind == "underline" else 1
    groups: list[list[tuple[CharBox, tuple[int, int, int, int, int]]]] = []
    for item in marked:
        box = item[0]
        if not groups:
            groups.append([item])
            continue
        prev = groups[-1][-1][0]
        if box.line_id == prev.line_id and box.index <= prev.index + max_gap:
            groups[-1].append(item)
        else:
            groups.append([item])
    out: list[Hit] = []
    for group in groups:
        line = group[0][0].line_text
        start = group[0][0].index
        end = group[-1][0].index + 1
        expected = "".join(b.ch for b, _ in group)
        sub = line[start:end] if 0 <= start < end <= len(line) else ""
        # 下划线要保留中间标点（逗号）；但 index 与 line_text 对不齐时（合成测试、
        # OCR 丢字）退回标出的字本身，避免把相邻字当成标记字。
        if sub and all(ch in sub for ch in expected):
            chars = sub
        else:
            chars = expected
            start = line.find(chars)
            if start < 0:
                start = 0
            end = start + len(chars)
        out.append(Hit(
            page=0,
            kind=kind,
            chars=chars,
            line=line,
            boxes=[(b.x0, b.y0, b.x1, b.y1) for b, _ in group],
            start=start,
            end=end,
        ))
    return out


def _merge_boxes(boxes: list[tuple[int, int, int, int]], gap: int = 8
                 ) -> list[tuple[int, int, int, int]]:
    """合并重叠/相邻的裁剪框，减少同一页的 OCR 次数。"""
    merged = [list(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        for i in range(len(merged)):
            for j in range(i + 1, len(merged)):
                a, b = merged[i], merged[j]
                if (a[2] + gap < b[0] or b[2] + gap < a[0]
                        or a[3] + gap < b[1] or b[3] + gap < a[1]):
                    continue
                merged[i] = [min(a[0], b[0]), min(a[1], b[1]),
                             max(a[2], b[2]), max(a[3], b[3])]
                merged.pop(j)
                changed = True
                break
            if changed:
                break
    return [tuple(b) for b in merged]


def detect_material_marks(pdf: Path,
                          regions: dict[int, list[tuple[float, float, float, float]]],
                          ocr=None, dpi: int = 150, margin: int = 10) -> list:
    """只在给定材料块（page_idx + 0–1000 bbox）内检测加点/下划线。

    返回 `pdf_emphasis.Decoration` 列表，供 `decorate_text` 注入 material_text。
    这是扫描件分支的正式入口：**不渲染/OCR 整页**，只裁材料块。
    """
    import fitz

    from pdf_emphasis import Decoration

    if not regions:
        return []
    ocr = ocr or _load_ocr()
    doc = fitz.open(pdf)
    out: list = []
    try:
        for page_idx, bboxes in regions.items():
            if not bboxes:
                continue
            page = doc[page_idx]
            pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
            arr = np.frombuffer(pix.samples, dtype=np.uint8)
            gray = np.ascontiguousarray(
                arr.reshape(pix.height, pix.stride)[:, :pix.width])
            boxes: list[tuple[int, int, int, int]] = []
            for b in bboxes:
                x0 = max(0, int(b[0] / 1000 * pix.width) - margin)
                y0 = max(0, int(b[1] / 1000 * pix.height) - margin)
                x1 = min(pix.width, int(b[2] / 1000 * pix.width) + margin)
                y1 = min(pix.height, int(b[3] / 1000 * pix.height) + margin)
                if x1 > x0 and y1 > y0:
                    boxes.append((x0, y0, x1, y1))
            for x0, y0, x1, y1 in _merge_boxes(boxes, gap=margin * 2):
                crop = gray[y0:y1, x0:x1]
                if crop.size == 0:
                    continue
                chars = _ocr_chars(ocr, cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR))
                hits = detect_dots(crop, chars) + detect_underlines(crop, chars)
                for h in hits:
                    # 材料块内也可能有表格边框：1–2 字下划线按低置信丢掉
                    if h.kind == "underline" and len(h.chars) < 3:
                        continue
                    out.append(Decoration(
                        page=page_idx + 1,
                        kind=h.kind,
                        text=h.chars,
                        line=h.line,
                        start=h.start,
                        end=h.end,
                    ))
    finally:
        doc.close()
    return out


def _norm(text: str) -> str:
    return "".join(ch for ch in (text or "")
                   if ch not in _PUNCT and not ch.isspace())


def _attribute(hit: Hit, questions: list[tuple[int, str]]) -> None:
    """用最长公共子串把一次检出归到某道题。

    共享材料（如题2/题3 都挂「发言稿一」）会让两题拿到相同长度，这时归**较小
    题号**（材料块的起始题）并标 ambiguous，不当作失败。行文本太短（「回想。」）
    时退回按检出字符本身匹配。
    """
    import difflib

    line = _norm(hit.line)
    best: list[tuple[int, int]] = []
    if len(line) >= 4:
        for no, text in questions:
            norm = _norm(text)
            m = difflib.SequenceMatcher(None, line, norm).find_longest_match(
                0, len(line), 0, len(norm))
            if m.size >= 6:
                best.append((m.size, no))
    if not best and len(_norm(hit.chars)) >= 2:
        chars = _norm(hit.chars)
        for no, text in questions:
            if chars in _norm(text):
                best.append((len(chars), no))
    if not best:
        return
    best.sort(key=lambda x: (-x[0], x[1]))   # 同长度取小题号
    hit.match_len, hit.question_no = best[0]
    hit.ambiguous = len(best) > 1 and best[0][0] == best[1][0]


def _scan_pdf(pdf: Path, md_path: Path | None, args, ocr) -> list[Hit]:
    import fitz

    doc = fitz.open(pdf)
    questions: list[tuple[int, str]] = []
    if md_path and md_path.exists():
        try:
            from question_extract import normalize_fullwidth_parens
            from question_splitter import split_page
            from subject_strategies import get_strategy

            text = normalize_fullwidth_parens(md_path.read_text(encoding="utf-8"))
            for q in split_page(text, md_path, strategy=get_strategy("chinese")):
                questions.append((q.group_order, f"{q.material_text or ''}\n{q.content}"))
        except Exception as e:
            print(f"  [warn] 切题失败，题号留空：{type(e).__name__}: {e}", flush=True)

    hits: list[Hit] = []
    try:
        for page_idx in range(doc.page_count):
            if args.pages and not _page_selected(page_idx + 1, args.pages):
                continue
            page = doc[page_idx]
            pix = page.get_pixmap(dpi=args.dpi, colorspace=fitz.csGRAY)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.stride)[:, :pix.width]
            gray = np.ascontiguousarray(arr)
            image_bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            chars = _ocr_chars(ocr, image_bgr)
            if not chars:
                continue
            page_hits: list[Hit] = []
            if not args.no_dots:
                page_hits.extend(detect_dots(gray, chars))
            if not args.no_underlines:
                page_hits.extend(detect_underlines(gray, chars))
            for h in page_hits:
                h.page = page_idx + 1
                _attribute(h, questions)
            hits.extend(page_hits)
            print(f"  p{page_idx + 1}: OCR {len(chars)} 字，检出 {len(page_hits)} 处", flush=True)
    finally:
        doc.close()
    return hits


def _page_selected(page: int, spec: str) -> bool:
    for part in spec.split(","):
        if "-" in part:
            a, b = part.split("-", 1)
            if int(a) <= page <= int(b):
                return True
        elif int(part) == page:
            return True
    return False


def _is_scanned(pdf: Path, sample_pages: int = 3) -> bool:
    import fitz

    try:
        doc = fitz.open(pdf)
    except Exception:
        return False
    try:
        pages = list(doc)[:sample_pages]
        if not pages:
            return False
        scanned = 0
        for p in pages:
            text = p.get_text("text").strip()
            # 只认「几乎无文字层 + 有整页图」；水印行不算文字层
            if len(text) <= 30 and p.get_images(full=True):
                scanned += 1
        return scanned >= max(1, len(pages) - 1)
    finally:
        doc.close()


def _discover(args) -> list[tuple[Path, Path | None]]:
    """返回 [(pdf, md_path)]，按 --file / --subject / --limit 收窄。"""
    cfg = RefineryConfig.from_env()
    input_dir = Path(cfg.input_dir).resolve()
    out_md = Path(cfg.output_dir).resolve() / "md"
    if args.pdf:
        pdf = Path(args.pdf).resolve()
        rel = pdf.relative_to(input_dir) if pdf.is_relative_to(input_dir) else None
        md = out_md / rel.parent / rel.stem / f"{rel.stem}.md" if rel else None
        return [(pdf, md)]

    picked: list[tuple[Path, Path | None]] = []
    for m in MaterialScanner(input_dir).scan():
        if m.kind != "pdf" or len(m.input_paths) != 1:
            continue
        pdf = m.input_paths[0]
        if pdf.suffix.lower() != ".pdf" or "答案" in pdf.name:
            continue
        rel = m.rel_path
        if args.subject:
            code = subject_code_for_parts(rel.parts, default="")
            if code != "chinese":
                continue
        if args.file and not match_keyword(args.file, str(rel)):
            continue
        if not _is_scanned(pdf):
            continue
        md = out_md / rel.parent / rel.name / f"{rel.name}.md"
        picked.append((pdf, md))
    if args.limit:
        picked = picked[:args.limit]
    return picked


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="扫描件语文卷加点/下划线 dry-run 检测")
    ap.add_argument("--subject", default="语文", help="学科（默认语文；空字符串=不限）")
    ap.add_argument("--file", help="素材路径关键词（同 import_cli 的 --file）")
    ap.add_argument("--pdf", help="直接指定单个 PDF（调试）")
    ap.add_argument("--limit", type=int, default=0, help="最多处理 N 份（0=全部）")
    ap.add_argument("--pages", help="只处理指定页，如 1-3,5")
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--server-ocr", action="store_true",
                    help="用 server 模型（更准但本机单页约数分钟；默认 mobile）")
    ap.add_argument("--no-dots", action="store_true")
    ap.add_argument("--no-underlines", action="store_true")
    ap.add_argument("--out", default=None, help="JSONL 输出路径")
    args = ap.parse_args(argv)

    targets = _discover(args)
    if not targets:
        print("没有命中扫描件 PDF。检查 --subject/--file，或该卷有文字层、不需要本脚本。")
        return 2

    out_path = Path(args.out) if args.out else (
        RefineryConfig.from_env().output_dir / "scanned_emphasis_dryrun.jsonl")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ocr = _load_ocr(server=args.server_ocr)
    total = 0
    with out_path.open("w", encoding="utf-8") as out:
        for pdf, md in targets:
            print(f"[扫] {pdf.name}", flush=True)
            hits = _scan_pdf(pdf, md, args, ocr)
            for h in hits:
                # 下划线只有 1–2 个字时大多是表格边框/装饰线；单字加点仍可能是真的
                confidence = "high" if (h.kind == "dots" or len(h.chars) >= 3) else "low"
                rec = {
                    "pdf": str(pdf),
                    "paper": pdf.stem,
                    "page": h.page,
                    "kind": h.kind,
                    "chars": h.chars,
                    "line": h.line,
                    "question_no": h.question_no,
                    "ambiguous": h.ambiguous,
                    "match_len": h.match_len,
                    "confidence": confidence,
                    "boxes": [[round(v, 1) for v in b] for b in h.boxes],
                }
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                q = f"题{h.question_no}" if h.question_no else "题号未匹配"
                flag = "高" if confidence == "high" else "低"
                print(f"    [{flag}] p{h.page} {q} "
                      f"{'加点' if h.kind == 'dots' else '下划线'}: "
                      f"{h.chars}  | {h.line[:48]}", flush=True)
            total += len(hits)
    print(f"\n共 {len(targets)} 份扫描卷 / {total} 处检出")
    print(f"复核清单：{out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

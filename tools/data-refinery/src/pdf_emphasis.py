"""语文试卷 PDF 的「着重号 / 下划线」标注提取与文本注入。

背景（2026-10-28）：MinerU 输出 Markdown，Markdown 没有下划线语义，着重号也只能
偶尔被识别成 ``<sub>．．</sub>``。语文卷大量题目靠「文段中加点词语」「画横线句」
指代答案位置，标记丢失后题目无法作答。

本模块不依赖 OCR/LLM，直接读 PDF 的矢量与像素：

- **下划线**：PDF 里通常是一条高度 < 1.6pt 的填充矩形；按矩形与字符框的垂直/
  水平重叠映射到字符区间。
- **着重号**：把页面渲染成灰度图，检查每个汉字下方 3pt 内的小墨点（连通域），
  排除已被下划线覆盖的字符。电子版 PDF 的着重点/无着重点差异非常干净
  （实测被点字下方 51 个暗像素，未点 0）。

输出标记使用前端已支持的 HTML（``markdownRehypePlugins`` 含 rehype-raw）：

- 下划线：``<u>嘉年华</u>``
- 着重号：``<span class="cn-emphasis-dot">高涨</span>``

只处理语文试卷；不改变题目结构、答案与解析。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class Decoration:
    """一处在 PDF 中被标注的字符区间。"""

    page: int  # 1-based
    kind: str  # 'underline' | 'dots'
    text: str
    line: str  # 该字符所在行的文本（已去掉空白，用于上下文匹配）
    start: int  # 在 line 中的起始偏移
    end: int  # 在 line 中的结束偏移（不含）

    @property
    def context(self) -> str:
        return self.line


# ── 字符/行模型 ────────────────────────────────────────────────


@dataclass
class _Char:
    ch: str
    bbox: tuple[float, float, float, float]  # x0, y0, x1, y1
    line_id: int
    index: int  # 在本行内的字符下标


@dataclass
class _Line:
    text: str
    chars: list[_Char]
    y0: float
    y1: float

    def span_text(self, start: int, end: int) -> str:
        return "".join(c.ch for c in self.chars[start:end])


def _is_cjk(ch: str) -> bool:
    return (
        "\u3400" <= ch <= "\u4dbf"
        or "\u4e00" <= ch <= "\u9fff"
        or "\uf900" <= ch <= "\ufaff"
    )


def _build_lines(page) -> list[_Line]:
    """按 PDF 的 line 结构建行模型（保留字符级 bbox）。"""
    lines: list[_Line] = []
    raw = page.get_text("rawdict")
    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            chars: list[_Char] = []
            for span in line.get("spans", []):
                for c in span.get("chars", []):
                    ch = c.get("c", "")
                    if not ch or ch.isspace():
                        continue
                    chars.append(_Char(ch=ch, bbox=tuple(c["bbox"]), line_id=len(lines), index=len(chars)))
            if not chars:
                continue
            y0 = min(c.bbox[1] for c in chars)
            y1 = max(c.bbox[3] for c in chars)
            lines.append(_Line(text="".join(c.ch for c in chars), chars=chars, y0=y0, y1=y1))
    return lines


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _group_contiguous(chars: list[_Char]) -> list[list[_Char]]:
    """把同一行内相邻（或只隔标点）的标注字符合成一段。"""
    groups: list[list[_Char]] = []
    for c in chars:
        if not groups:
            groups.append([c])
            continue
        prev = groups[-1][-1]
        if c.line_id == prev.line_id and c.index == prev.index + 1:
            groups[-1].append(c)
        else:
            groups.append([c])
    return groups


# ── 下划线检测 ────────────────────────────────────────────────


def _detect_underlines(page, lines: list[_Line]) -> tuple[list[Decoration], set[tuple[int, int]]]:
    out: list[Decoration] = []
    covered_set: set[tuple[int, int]] = set()
    page_w = float(page.rect.width)
    page_h = float(page.rect.height)
    for drawing in page.get_drawings():
        r = drawing["rect"]
        w, h = r.width, r.height
        # 细横线：下划线 / 表格内边线。表格外框通常接近整页宽，直接排除。
        if not (0.2 <= h <= 1.6 and 4.0 <= w <= page_w * 0.65):
            continue
        if r.y0 < page_h * 0.02 or r.y1 > page_h * 0.98:
            continue
        covered: list[_Char] = []
        for line in lines:
            for c in line.chars:
                x0, y0, x1, y1 = c.bbox
                cw = max(0.1, x1 - x0)
                # 矩形紧贴字符底部（不要求整字覆盖，按 50% 宽度判归属）
                if y1 - 0.5 <= r.y0 <= y1 + 2.5 and _overlap(x0, x1, r.x0, r.x1) >= cw * 0.5:
                    covered.append(c)
        for group in _group_contiguous(covered):
            line = lines[group[0].line_id]
            start = group[0].index
            end = group[-1].index + 1
            for c in group:
                covered_set.add((c.line_id, c.index))
            out.append(Decoration(
                page=page.number + 1,
                kind="underline",
                text=line.span_text(start, end),
                line=line.text,
                start=start,
                end=end,
            ))
    return out, covered_set


# ── 着重号检测 ────────────────────────────────────────────────


def _dark_components(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """纯 numpy 的 8 连通域（返回 x,y,w,h,area），避免依赖 cv2。"""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    comps: list[tuple[int, int, int, int, int]] = []
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or seen[y, x]:
                continue
            stack = [(x, y)]
            seen[y, x] = True
            min_x = max_x = x
            min_y = max_y = y
            area = 0
            while stack:
                cx, cy = stack.pop()
                area += 1
                min_x, max_x = min(min_x, cx), max(max_x, cx)
                min_y, max_y = min(min_y, cy), max(max_y, cy)
                for ny in (cy - 1, cy, cy + 1):
                    for nx in (cx - 1, cx, cx + 1):
                        if 0 <= nx < w and 0 <= ny < h and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((nx, ny))
            comps.append((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1, area))
    return comps


def _table_boxes(page) -> list[tuple[float, float, float, float]]:
    """表格区域：表格线容易在下方像素带里伪装成着重号，整块排除。"""
    try:
        return [tuple(t.bbox) for t in page.find_tables().tables]
    except Exception:
        return []


def _inside_any(x: float, y: float, boxes: list[tuple[float, float, float, float]]) -> bool:
    return any(bx0 <= x <= bx1 and by0 <= y <= by1 for bx0, by0, bx1, by1 in boxes)


def _detect_dots(page, lines: list[_Line], underlined: set[tuple[int, int]], zoom: int = 4) -> list[Decoration]:
    import fitz

    tables = _table_boxes(page)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
    arr = np.frombuffer(pix.samples, dtype=np.uint8)
    arr = arr.reshape(pix.height, pix.stride)[:, : pix.width]

    marked: list[_Char] = []
    for line in lines:
        for c in line.chars:
            if not _is_cjk(c.ch):
                continue
            if (c.line_id, c.index) in underlined:
                continue
            x0, y0, x1, y1 = c.bbox
            if _inside_any((x0 + x1) / 2, (y0 + y1) / 2, tables):
                continue
            cw, ch = max(0.1, x1 - x0), max(0.1, y1 - y0)
            # 只看字符底部下方 0.3~3.2pt 的窄带（着重点所在位置）
            bx0 = int((x0 + cw * 0.08) * zoom)
            bx1 = int((x1 - cw * 0.08) * zoom)
            by0 = int((y1 + 0.2) * zoom)
            by1 = int((y1 + 3.2) * zoom)
            bx0, bx1 = max(0, bx0), min(pix.width, bx1)
            by0, by1 = max(0, by0), min(pix.height, by1)
            if bx1 - bx0 < 2 or by1 - by0 < 2:
                continue
            band = arr[by0:by1, bx0:bx1]
            mask = band < 160
            total = int(mask.sum())
            if total < 3:
                continue
            # 连续横线（下划线没被矢量识别出来时的兜底）：排除
            if total > (bx1 - bx0) * (by1 - by0) * 0.25:
                continue
            comps = _dark_components(mask)
            dot_like = [
                c2 for c2 in comps
                if c2[4] >= 2
                and c2[2] <= cw * zoom * 0.45
                and c2[3] <= ch * zoom * 0.45
            ]
            if not dot_like:
                continue
            # 不允许出现贯穿整个字宽的横向连笔（那是下划线/批注线）
            if any(c2[2] > cw * zoom * 0.7 for c2 in comps):
                continue
            marked.append(c)

    out: list[Decoration] = []
    for group in _group_contiguous(marked):
        line = lines[group[0].line_id]
        start = group[0].index
        end = group[-1].index + 1
        out.append(Decoration(
            page=page.number + 1,
            kind="dots",
            text=line.span_text(start, end),
            line=line.text,
            start=start,
            end=end,
        ))
    return out


# ── 对外：整份 PDF ────────────────────────────────────────────


def detect_decorations(pdf_path: str | Path) -> list[Decoration]:
    """检测整份 PDF 的下划线与着重号（按页、按行顺序）。"""
    import fitz  # 延迟导入：只有真正跑检测时才依赖 PyMuPDF

    path = Path(pdf_path)
    doc = fitz.open(path)
    try:
        decorations: list[Decoration] = []
        for page in doc:
            lines = _build_lines(page)
            if not lines:
                continue
            underlines, underlined = _detect_underlines(page, lines)
            dots = _detect_dots(page, lines, underlined)
            decorations.extend(underlines)
            decorations.extend(dots)
        return decorations
    finally:
        doc.close()


# ── 把标记注入文本 ────────────────────────────────────────────

OPTION_LINE_RE = re.compile(r"^[A-DＡ-Ｄ][.．、]")


def is_option_line(line: str) -> bool:
    """PDF 行是否是选择题选项行（A. / B． 开头）。"""
    return bool(OPTION_LINE_RE.match(line.strip()))


DOT_CLASS = "cn-emphasis-dot"
DOT_OPEN = f'<span class="{DOT_CLASS}">'
DOT_CLOSE = "</span>"
UNDERLINE_OPEN = "<u>"
UNDERLINE_CLOSE = "</u>"


def dot_mark(text: str) -> str:
    """逐字包着重号：CSS 用 ::after 画可精确控制大小/颜色的字下点。

    整词包一个 span 只能靠 text-emphasis，点的粗细/颜色无法细调（用户反馈太轻）。
    """
    return "".join(f"{DOT_OPEN}{ch}{DOT_CLOSE}" for ch in text)

_SUB_DOTS_RE = re.compile(r"([\u3400-\u9fff\uf900-\ufaff]{1,4})<sub>([．.\u00b7・]+)</sub>")
_GROUP_DOT_RE = re.compile(r'<span class="cn-emphasis-dot">([^<]+)</span>')


def normalize_dot_spans(text: str | None) -> str:
    """把旧版「整词一个 span」的着重号拆成逐字 span（CSS 细调需要逐字定位）。"""
    if not text or DOT_CLASS not in text:
        return text or ""
    return _GROUP_DOT_RE.sub(lambda m: dot_mark(m.group(1)), text)


def normalize_subscript_dots(text: str | None) -> str:
    """把 MinerU 偶发识别出的 ``高涨<sub>．．</sub>`` 归一化成标准着重号标记。

    点号数量 = 被点字数（``高涨`` + 两个点 → 两个都点）；取分组末尾 N 个字。
    """
    if not text or "<sub>" not in text:
        return text or ""

    def repl(m: re.Match) -> str:
        group, dots = m.group(1), m.group(2)
        n = max(1, min(len(dots), len(group)))
        target = group[-n:]
        prefix = group[: len(group) - n]
        return f"{prefix}{dot_mark(target)}"

    return _SUB_DOTS_RE.sub(repl, text)


def _collapse(text: str) -> tuple[str, list[int]]:
    """去掉所有空白，返回折叠串 + 每个折叠字符在原文中的下标。"""
    chars: list[str] = []
    index: list[int] = []
    for i, ch in enumerate(text):
        if ch.isspace():
            continue
        chars.append(ch)
        index.append(i)
    return "".join(chars), index


def _already_marked(text: str, start: int, kind: str) -> bool:
    """该区间是否已经处于对应标记内（幂等/避免重复包裹）。"""
    open_tag, close_tag = (UNDERLINE_OPEN, UNDERLINE_CLOSE) if kind == "underline" else (DOT_OPEN, DOT_CLOSE)
    return text.rfind(open_tag, 0, start) > text.rfind(close_tag, 0, start)


def _apply_one(text: str, dec: Decoration, radii: tuple[int, ...], cjk_context_only: bool = False) -> tuple[str | None, str]:
    """在一段文本里为单个 decoration 找唯一落点并包裹。返回 (新文本, 状态)。"""
    collapsed, index = _collapse(text)
    if not dec.text:
        return None, "empty"
    if dec.text not in collapsed:
        return None, "not_found"
    for r in radii:
        if cjk_context_only:
            left = "".join(ch for ch in dec.line[: dec.start] if _is_cjk(ch))[-r:] if r else ""
            right = "".join(ch for ch in dec.line[dec.end:] if _is_cjk(ch))[:r] if r else ""
            ctx = left + dec.text + right
            offset = len(left)
        else:
            cstart = max(0, dec.start - r)
            cend = min(len(dec.line), dec.end + r)
            ctx = dec.line[cstart:cend]
            offset = dec.start - cstart
        if not ctx:
            continue
        positions = [m.start() for m in re.finditer(re.escape(ctx), collapsed)]
        if len(positions) != 1:
            continue
        pos = positions[0] + offset
        s = index[pos]
        # 用折叠偏移反推结束位置（dec.text 在折叠串中的长度）
        end_pos = pos + len(dec.text)
        if end_pos > len(index):
            continue
        e = index[end_pos - 1] + 1
        if collapsed[pos:end_pos] != dec.text:
            return None, "mismatch"
        if _already_marked(text, s, dec.kind):
            return None, "already_marked"
        if dec.kind == "underline":
            marked = f"{UNDERLINE_OPEN}{text[s:e]}{UNDERLINE_CLOSE}"
        else:
            marked = dot_mark(text[s:e])
        return text[:s] + marked + text[e:], "applied"
    return None, "ambiguous"


def decorate_text(
    text: str | None,
    decorations: list[Decoration],
    *,
    radii: tuple[int, ...] = (8, 6, 4, 3, 2),
    cjk_context_only: bool = False,
) -> tuple[str, list[tuple[Decoration, str]]]:
    """把 decorations 注入一段文本；返回 (新文本, [(decoration, 状态)])。

    先做一次 ``<sub>．．</sub>`` 归一化，再按「上下文逐步缩短」找唯一匹配：
    同一行里同一个字出现多次时，长上下文能消歧；短上下文只用于选项等短字段。
    """
    current = normalize_dot_spans(normalize_subscript_dots(text))
    log: list[tuple[Decoration, str]] = []
    for dec in decorations:
        if not dec.text or dec.text not in current:
            log.append((dec, "not_found"))
            continue
        open_tag, close_tag = (UNDERLINE_OPEN, UNDERLINE_CLOSE) if dec.kind == "underline" else (DOT_OPEN, DOT_CLOSE)
        if f"{open_tag}{dec.text}{close_tag}" in current:
            log.append((dec, "already_marked"))
            continue
        new_text, status = _apply_one(current, dec, radii, cjk_context_only)
        log.append((dec, status))
        if new_text is not None and status == "applied":
            current = new_text
    return current, log

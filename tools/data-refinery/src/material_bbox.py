"""把切题后的 material_text 对齐到 MinerU 的块级 bbox。

MinerU `extract -f md,json` 的 JSON 是块数组，每块带 `page_idx`（0 基）与
`bbox`（0–1000 归一化，x/y 都按页宽/页高缩放）。这里只做两件事：

1. 读 sidecar（`<md>.json`）；
2. 用 `material_text` 找它覆盖了哪些块，返回 `page_idx + bbox`。

语文加点/画线只对「材料块」做识别（2026-11-07 用户裁决）：整页/整份 PDF 全扫
太浪费，而且会把题干里的「不正确」「不符合」当成标记。找不到 JSON 时调用方
应显式告警并跳过，不要退回整页扫描。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path


@dataclass(frozen=True)
class Block:
    page: int                         # 0 基 page_idx
    bbox: tuple[float, float, float, float]  # 0–1000 归一化
    text: str
    type: str


@dataclass(frozen=True)
class Region:
    page: int
    bbox: tuple[float, float, float, float]
    text: str = ""


def norm_text(text: str | None) -> str:
    """只保留 CJK/字母/数字，去掉空白与标点（题号/全半角差异不参与匹配）。"""
    return "".join(ch for ch in (text or "") if ch.isalnum())


def load_blocks(md_path: Path) -> list[Block] | None:
    """读 MinerU JSON sidecar；缺少/损坏返回 None（调用方负责告警）。"""
    json_path = Path(md_path).with_suffix(".json")
    if not json_path.exists():
        return None
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, list):
        return None
    blocks: list[Block] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        bbox = item.get("bbox")
        page = item.get("page_idx")
        if not (isinstance(bbox, list) and len(bbox) == 4 and isinstance(page, int)):
            continue
        blocks.append(Block(
            page=page,
            bbox=tuple(float(v) for v in bbox),
            text=str(item.get("text") or ""),
            type=str(item.get("type") or ""),
        ))
    return blocks


def match_material(material_text: str, blocks: list[Block]) -> list[Region]:
    """返回 material_text 覆盖的文本块（按页/坐标排序）。

    判据：
    - 块文本是 material 的子串 → 命中（最常见：MinerU 段落 = 材料段落）；
    - 否则最长公共子串 ≥24 且覆盖块文本 70% 以上 → 命中（OCR 小差异）；
    - 题干块通常只有引用片段，覆盖率不够，不会命中。
    """
    material = norm_text(material_text)
    if len(material) < 4:
        return []
    out: list[Region] = []
    for b in blocks:
        if b.type != "text":
            continue
        block = norm_text(b.text)
        if len(block) < 6:
            continue
        if block in material:
            out.append(Region(page=b.page, bbox=b.bbox, text=b.text))
            continue
        m = SequenceMatcher(None, block, material).find_longest_match(
            0, len(block), 0, len(material))
        if m.size >= 24 and m.size >= len(block) * 0.6:
            out.append(Region(page=b.page, bbox=b.bbox, text=b.text))
    out.sort(key=lambda r: (r.page, r.bbox[1], r.bbox[0]))
    return out


def to_points(bbox: tuple[float, float, float, float],
              page_width: float, page_height: float
              ) -> tuple[float, float, float, float]:
    """0–1000 归一化 bbox → PDF 点坐标。"""
    x0, y0, x1, y1 = bbox
    return (x0 / 1000 * page_width, y0 / 1000 * page_height,
            x1 / 1000 * page_width, y1 / 1000 * page_height)

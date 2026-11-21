"""语文共享文章：归一化、分组、canonical 选择、doc_key。

文章 = 题号之前、本节共享的阅读对象。它只存一份 markdown，`questions.material_url`
指向它；`material_text` 只放题号之内的补充材料。
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Callable

from image_rewrite import image_hashes_for, rewrite_material_doc

_SUB_DOT_RE = re.compile(r"<sub\b[^>]*>.*?</sub>", re.I | re.S)
_EMPHASIS_TAG_RE = re.compile(r"</?(?:u|span)\b[^>]*>", re.I)
_IMAGE_REF_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
# 卷面小节指令：含「阅读…完成…题」，带题号/分值，不属于文章
_SECTION_INSTRUCTION_RE = re.compile(
    r"^#{1,6}\s*.*(?:阅读下面|阅读下文|阅读下面材料|阅读).{0,24}完成.{0,12}题"
)
_PAGE_MARKER_RE = re.compile(
    r"^(?:第\s*\d+\s*页.*|.*BEIJING\s*ZHONGKAO.*)$", re.I
)


def strip_emphasis(text: str) -> str:
    """去标注：<u>/<span> 只去标签；<sub> 是加点符号（．．），连内容一起去。"""
    s = _SUB_DOT_RE.sub("", text or "")
    return _EMPHASIS_TAG_RE.sub("", s)


def normalize_for_group(text: str) -> str:
    """分组/命名的归一化文本：去标注标签、去图片引用、去所有空白。"""
    s = strip_emphasis(text or "")
    s = _IMAGE_REF_RE.sub("", s)
    return re.sub(r"\s+", "", s)


def strip_section_instruction(text: str) -> str:
    """删掉首行的卷面小节指令（只删第一段的第一行）。"""
    lines = (text or "").splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and _SECTION_INSTRUCTION_RE.match(lines[0].strip()):
        lines.pop(0)
    while lines and not lines[0].strip():
        lines.pop(0)
    return "\n".join(lines).strip()


def is_heading_only(text: str) -> bool:
    """去标题/图片/页码后没有正文 → 纯小节标题（如「## (一)默写。(共4分)」）。"""
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            continue
        if _IMAGE_REF_RE.fullmatch(line):
            continue
        if _PAGE_MARKER_RE.match(line):
            continue
        return False
    return True


def annotation_score(text: str) -> int:
    """真实标注（<u> + 加点 span）优先；<sub> 是退化的点号，扣分。"""
    spans = len(re.findall(r"<span\s+class=\"cn-emphasis-dot\"", text or ""))
    unders = len(re.findall(r"<u\b", text or ""))
    subs = len(re.findall(r"<sub\b", text or ""))
    return (spans + unders) * 2 - subs


def choose_canonical(variants: list[str]) -> str:
    """标注最全的版本；持平取最长。"""
    if not variants:
        raise ValueError("variants is empty")
    return max(variants, key=lambda t: (annotation_score(t), len(t)))


def doc_key(body: str, image_hashes: list[str]) -> str:
    """文章身份：归一化正文 + 图片内容哈希。只改标注不换 key。"""
    payload = normalize_for_group(strip_section_instruction(body))
    payload += "\n" + "\n".join(sorted(image_hashes))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def write_material_doc(
    body: str,
    *,
    resolver: Callable[[str], Path | None],
    store,
    assets_dir: Path,
    subject_code: str = "chinese",
) -> tuple[str, str]:
    """写 `materials/{subject}/{doc_key}/content.md`，返回 (doc_key, material_url)。"""
    from page_markers import strip_page_markers

    clean, _ = strip_page_markers(strip_section_instruction(body))
    hashes = image_hashes_for(clean, resolver)
    key = doc_key(clean, hashes)
    prefix = f"materials/{subject_code}/{key}"
    new_body, _ = rewrite_material_doc(clean, resolver, store, prefix)
    out = Path(assets_dir) / prefix / "content.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(new_body.strip() + "\n", encoding="utf-8")
    return key, f"{prefix}/content.md"


def build_groups(rows: list[dict]) -> dict[str, list[dict]]:
    """按 (paper_id 或 source) + 归一化 material_text 分组。纯标题组不返回。"""
    groups: dict[str, list[dict]] = {}
    for row in rows:
        text = row.get("material_text") or ""
        if not text.strip() or is_heading_only(text):
            continue
        key = f"{row.get('paper_id') or row.get('source')}\x1f{normalize_for_group(text)}"
        groups.setdefault(key, []).append(row)
    return groups


def rewrite_hash_for_row(row: dict) -> str:
    """回填后用新的 material_url 重算 content_hash（与 db_loader 同口径）。"""
    import json

    from db_loader import content_hash

    opts = row.get("options")
    if isinstance(opts, str):
        opts = json.loads(opts) if opts.strip() else None
    return content_hash(
        row.get("content"), opts,
        row.get("material_text"), row.get("material_url"),
    )

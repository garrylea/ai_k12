"""图片路径改写：把 extract 产出里的原始 mineru 图片引用改写为 §9 规范相对路径，
并物化图片到 AssetStore；同时填充 cards.content_metadata.images[] 与
questions.options[].image_url。

调用时机：在 DB INSERT 拿到 id 之后调用（asset_prefix 含 id），见 publish 计划 §5.2 方案 1。
参见 ``docs/K12智学系统-数据库设计文档.md`` §9.2（命名规范）。
"""

import re
from pathlib import Path
from typing import Callable

from PIL import Image

from asset_store import AssetStore
from models import ExamQuestion, TextbookCard

# 匹配 ![alt](path)
IMAGE_REF_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")


def _ext_of(ref_path: str) -> str:
    suffix = Path(ref_path).suffix
    return suffix if suffix else ".png"


def _resolve_src(ref_path: str, md_images_dir: Path) -> Path | None:
    """把 markdown 里的图片相对路径解析到磁盘文件；找不到返回 None。"""
    candidates = [
        md_images_dir / ref_path,
        md_images_dir / "images" / Path(ref_path).name,
        md_images_dir / Path(ref_path).name,
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def _parse_page(textbook_page: str | None) -> str:
    """从 textbook_page（如 'P12'、'12'、'P12-13'）提取页码，2 位补零；缺失返回 '01'。"""
    if not textbook_page:
        return "01"
    m = re.search(r"(\d+)", textbook_page)
    if not m:
        return "01"
    return f"{int(m.group(1)):02d}"


def _rewrite_text(
    text: str | None,
    md_images_dir: Path,
    asset_store: AssetStore,
    asset_prefix: str,
    name_fn: Callable[[int, str], str],
) -> tuple[str, list[str], list[dict]]:
    """改写 text 中所有图片引用。

    name_fn(index, ext) -> 规范文件名（不含目录）。
    返回 (新 text, 物化的资源相对路径列表, 图片元数据列表[{url, alt, position}])。
    """
    materialized: list[str] = []
    metas: list[dict] = []
    index = 0

    def replace(m: re.Match) -> str:
        nonlocal index
        alt, ref = m.group(1), m.group(2)
        src = _resolve_src(ref, md_images_dir)
        if src is None:
            return m.group(0)  # 源文件缺失，保留原引用
        index += 1
        name = name_fn(index, _ext_of(ref))
        rel = f"{asset_prefix}/{name}"
        asset_store.put(rel, src)
        materialized.append(rel)
        meta = {"url": rel, "alt": alt, "position": "inline"}
        try:
            with Image.open(src) as img:
                w, h = img.size
            meta["width"] = w
            meta["height"] = h
        except Exception:
            pass  # 无法读取尺寸则忽略
        metas.append(meta)
        return f"![{alt}]({rel})"

    new_text = IMAGE_REF_RE.sub(replace, text or "")
    return new_text, materialized, metas


def rewrite_question(
    q: ExamQuestion,
    md_images_dir: Path,
    asset_store: AssetStore,
    asset_prefix: str,
) -> tuple[ExamQuestion, list[str]]:
    """改写题干(stem_NN)/解析(explain_NN)/材料(fig_NN)/选项(opt_{label})。"""
    materialized: list[str] = []

    new_content, m, _ = _rewrite_text(
        q.content, md_images_dir, asset_store, asset_prefix,
        lambda i, ext: f"stem_{i:02d}{ext}",
    )
    q.content, materialized = new_content, materialized + m

    if q.explanation:
        new_exp, m, _ = _rewrite_text(
            q.explanation, md_images_dir, asset_store, asset_prefix,
            lambda i, ext: f"explain_{i:02d}{ext}",
        )
        q.explanation, materialized = new_exp, materialized + m

    if q.material_text:
        new_mt, m, _ = _rewrite_text(
            q.material_text, md_images_dir, asset_store, asset_prefix,
            lambda i, ext: f"fig_{i:02d}{ext}",
        )
        q.material_text, materialized = new_mt, materialized + m

    if q.options:
        for opt in q.options:
            label = (opt.get("label") or "").strip().lower()
            text = opt.get("text") or ""

            def name_fn(i: int, ext: str, label: str = label) -> str:
                base = f"opt_{label}" if label else f"opt_{i:02d}"
                return f"{base}{ext}" if i == 1 else f"{base}_{i:02d}{ext}"

            new_text, m, _ = _rewrite_text(text, md_images_dir, asset_store, asset_prefix, name_fn)
            if new_text != text:
                opt["text"] = new_text
                if len(m) == 1:
                    opt["image_url"] = m[0]
                materialized += m

    return q, materialized


def rewrite_card(
    c: TextbookCard,
    md_images_dir: Path,
    asset_store: AssetStore,
    asset_prefix: str,
) -> tuple[TextbookCard, list[str]]:
    """改写卡片正文图片(page_{页码}_fig_NN)，填充 content_metadata.images[]。"""
    page = _parse_page(c.textbook_page)

    new_content, materialized, metas = _rewrite_text(
        c.content, md_images_dir, asset_store, asset_prefix,
        lambda i, ext: f"page_{page}_fig_{i:02d}{ext}",
    )
    c.content = new_content
    if metas:
        metadata = c.content_metadata or {}
        metadata["images"] = metas
        c.content_metadata = metadata

    return c, materialized


def rewrite_item(
    item: ExamQuestion | TextbookCard,
    kind: str,
    md_images_dir: Path,
    asset_store: AssetStore,
    asset_prefix: str,
) -> tuple[ExamQuestion | TextbookCard, list[str]]:
    """按 kind 分派到 question / card 改写。"""
    if kind == "questions":
        return rewrite_question(item, md_images_dir, asset_store, asset_prefix)  # type: ignore[arg-type]
    return rewrite_card(item, md_images_dir, asset_store, asset_prefix)  # type: ignore[arg-type]

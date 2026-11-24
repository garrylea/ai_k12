"""语文共享文章：归一化、分组、canonical 选择、doc_key。

文章 = 题号之前、本节共享的阅读对象。它只存一份 markdown，`questions.material_url`
指向它；`material_text` 只放题号之内的补充材料。
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Callable

from image_rewrite import image_hashes_for, rewrite_material_doc

_SUB_DOT_RE = re.compile(r"<sub\b[^>]*>.*?</sub>", re.I | re.S)
_EMPHASIS_TAG_RE = re.compile(r"</?(?:u|span)\b[^>]*>", re.I)
_IMAGE_REF_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
# 卷面小节指令：含「阅读…完成…题」，带题号/分值，不属于文章
_SECTION_INSTRUCTION_RE = re.compile(
    r"^#{0,6}\s*(?:"
    r".*(?:阅读下面|阅读下文|阅读下面材料|阅读).{0,24}完成.{0,12}题"
    # 「（三）文言文阅读(共7分)」「（一）（共 5 分）」这类小节标题：
    # 以（X）开头且带分值，是卷面结构，不是文章标题（2026-11-21 补）
    r"|[（(][一二三四五六七八九十]+[）)][^\n]*分"
    r")"
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
    """去标题/图片/页码后没有正文 → 纯小节标题（如「## (一)默写。(共4分)」）。

    裸小节标题（无 `##`，如库里存的「(一)默写。(共4分)」）也算标题：旧实现只跳过
    `#` 开头的行，导致 publish 清理救不了它，标题一直留着当材料（东城模拟一 Q6）。
    """
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            continue
        if _SECTION_INSTRUCTION_RE.match(line):
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


# ── 外置前的「文章纯度」检查（2026-11-21）────────────────────────────────
#
# 全量回填 dry-run 实测 19 组 / 35 行 material_text 根本不是文章：丢掉的原题、
# 题目选项、答题脚手架、标签碎片、跨小节串起来的两篇文章。一旦外置成
# material_url，apply_fixes / fix_page_markers_cli / emphasis_cli 都会跳过该行
# （Task 12 的护栏），错误材料就再也修不到 —— 所以宁可留在 material_text。

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_OPTION_LINE_RE = re.compile(r"(?m)^\s*[A-DＡ-Ｄ]\s*[.．、]\s*\S")
_PUNCT_STEM_RE = re.compile(r"(?m)^\s*\d{1,3}\s*、\s*\S")
_ANSWER_SCAFFOLD_RE = re.compile(r"(?m)^\s*(?:示例\s*[:：]|我选|答\s*[:：]|修改\s*[:：])")
_SECTION_HEADING_RE = re.compile(
    r"(?m)^#{0,6}\s*[（(]?[一二三四五六七八九十]+[）)]?[^\n]{0,50}"
    r"(?:阅读|阅读下面|阅读下文)[^\n]{0,50}完成[^\n]{0,20}题"
)


def _cjk_len(text: str) -> int:
    return len(_CJK_RE.findall(text or ""))


def _has_option_block(text: str) -> bool:
    """是否含连续 A→B→C→D 选项行（语文材料里出现选项 = 不是文章）。"""
    run = 0
    for m in _OPTION_LINE_RE.finditer(text or ""):
        label = m.group(0).strip()[0]
        want = "ABCD"[run] if run < 4 else None
        if want and label == want:
            run += 1
            if run == 4:
                return True
        else:
            run = 1 if label == "A" else 0
    return False


def _has_cross_section(text: str) -> bool:
    """材料中间又出现「（X）阅读…完成…题」→ 上一节和下一节的文章串了。"""
    for m in _SECTION_HEADING_RE.finditer(text or ""):
        # 小节标题前已有上一节正文才算；只有一个大题标题（约 8 字）不算。
        if _cjk_len((text or "")[: m.start()]) >= 20:
            return True
    return False


def material_group_reason(text: str) -> str | None:
    """该组材料是否「不像一篇文章」；返回原因码，None = 可以外置。

    原因码（对应 2026-11-21 回填 dry-run 的真实反例）：

    - ``punct_stem``   行首顿号题号（如「7、拔剑四顾…」）→ 这是丢掉的原题；
    - ``option_block`` 连续 A–D 选项行 → 这是题目选项，不是文章；
    - ``scaffold``     行首「示例：/我选/答：/修改：」→ 答题脚手架混进材料；
    - ``cross_section``材料中间又起一节「（X）阅读…完成…题」→ 两篇文章串了；
    - ``no_article``   无标题、正文不足 40 汉字且没有完整段落 → 标签/图注碎片。

    命中时调用方应保留 ``material_text`` 原样、不写文档，并把该组记入
    ``material_group_skipped.jsonl`` 供人工核对。
    """
    body = text or ""
    if _PUNCT_STEM_RE.search(body):
        return "punct_stem"
    if _has_option_block(body):
        return "option_block"
    if _ANSWER_SCAFFOLD_RE.search(body):
        return "scaffold"
    if _has_cross_section(body):
        return "cross_section"
    paragraphs = [p for p in re.split(r"\n\s*\n|\n", body) if p.strip()]
    has_title = bool(re.search(r"(?m)^\s*#{1,6}\s", body))
    if not has_title and _cjk_len(body) < 40 and not any(_cjk_len(p) >= 40 for p in paragraphs):
        return "no_article"
    return None


def append_skipped_report(path: Path, records: list[dict]) -> None:
    """把「不外置」的组追加到清单；只追加不截断（publish 与回填共用）。"""
    if not records:
        return
    stamp = datetime.now().isoformat(timespec="seconds")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps({"run_at": stamp, **rec}, ensure_ascii=False) + "\n")


def paper_scope_for(rel_path: str | Path, source: str) -> str:
    """试卷稳定身份：``rel_path/source``（与 exam_papers.source_key 同源、无扩展名）。

    用作 doc_key 的卷维度，保证「同一段内容在不同试卷 = 不同文件」。
    """
    return (Path(rel_path) / str(source)).as_posix()


def _drop_first_heading(text: str) -> str:
    """去掉首行的 Markdown 标题（`## 标题`），正文与「带标题的文档」才能对齐。"""
    lines = (text or "").strip().splitlines()
    if lines and lines[0].lstrip().startswith("#"):
        return "\n".join(lines[1:])
    return text or ""


def _norm_for_compare(text: str) -> str:
    return normalize_for_group(text or "").replace("#", "")


def same_article(text: str | None, doc_body: str | None, *,
                 threshold: float = 0.85) -> bool:
    """判断两段文字是否为「同一篇文章」（忽略标注/空白/图片/标题，容忍个别错字）。

    依次比「原文」与「去首行标题」两种形态：文档常带 `## 标题`、题内素材常不带；
    纯子串判不出「只改了错字」，再用相似度兜底（Q5 事故）。
    """
    for a_src in (text or "", _drop_first_heading(text or "")):
        a = _norm_for_compare(a_src)
        if not a:
            continue
        for b_src in (doc_body or "", _drop_first_heading(doc_body or "")):
            b = _norm_for_compare(b_src)
            if not b:
                continue
            if a in b or b in a:
                return True
            if difflib.SequenceMatcher(None, a, b).ratio() >= threshold:
                return True
    return False


def doc_key(body: str, image_hashes: list[str], *,
            paper_scope: str | None = None) -> str:
    """文章身份：归一化正文 + 图片内容哈希（+ 可选卷维度）。只改标注不换 key。

    ``paper_scope`` 为空时与旧行为完全一致（存量/回填不受影响）；
    传入时同一段内容在不同试卷会得到不同 key。
    """
    payload = normalize_for_group(strip_section_instruction(body))
    payload += "\n" + "\n".join(sorted(image_hashes))
    if paper_scope:
        payload = f"{paper_scope}\n{payload}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def write_material_doc(
    body: str,
    *,
    resolver: Callable[[str], Path | None],
    store,
    assets_dir: Path,
    subject_code: str = "chinese",
    paper_scope: str | None = None,
    dry_run: bool = False,
) -> tuple[str, str]:
    """写 `materials/{subject}/{doc_key}/content.md`，返回 (doc_key, material_url)。

    dry_run=True 只算 key/url，不落文件（回填的 dry-run 不能写盘）。
    ``paper_scope`` 透传给 ``doc_key``：有值则卷内隔离，缺省保持旧行为。
    """
    from page_markers import strip_page_markers

    # 先洗页码，再删小节指令：页码可能在小节指令之前，反了就删不掉指令。
    cleaned, _ = strip_page_markers(body)
    clean = strip_section_instruction(cleaned)
    hashes = image_hashes_for(clean, resolver)
    key = doc_key(clean, hashes, paper_scope=paper_scope)
    prefix = f"materials/{subject_code}/{key}"
    if not dry_run:
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


from subject_strategies.chinese_inline_material import (  # noqa: E402
    needs_llm,
    split_inline_material,
)


def _resolver_for(md_images_dir: Path):
    from image_rewrite import _resolve_src

    return lambda ref: _resolve_src(ref, md_images_dir)


def _load_material_overrides(output_dir: Path) -> dict[str, dict]:
    """读人工校对写的共享文章修正记录，按 old_key 索引。"""
    path = Path(output_dir) / "material_doc_overrides.jsonl"
    if not path.exists():
        return {}
    out: dict[str, dict] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            if rec.get("old_key") and rec.get("body"):
                out[rec["old_key"]] = rec
    except (OSError, json.JSONDecodeError):
        return out
    return out


def externalize_chinese_materials(
    items,
    *,
    md_images_dir: Path,
    assets_dir: Path,
    store,
    subject_code: str = "chinese",
    paper_scope: str | None = None,
) -> None:
    """publish 阶段：文章 → md + material_url；题中素材 → material_text。

    不像文章的组（见 ``material_group_reason``）不外置，原 material_text 保留，
    并追加到 ``output/material_group_skipped.jsonl``。
    """
    groups: dict[str, list] = {}
    for item in items:
        text = item.material_text or ""
        if not text.strip() or is_heading_only(text):
            continue
        groups.setdefault(normalize_for_group(text), []).append(item)

    resolver = _resolver_for(Path(md_images_dir))
    skipped_items: set[int] = set()
    skipped: list[dict] = []
    # 人工校对修过共享文章时写下的 override：publish 必须用它，否则下次重发
    # 又会把 content.md 改回 extracted 里的旧正文（2026-11-21 用户反馈）。
    # 匹配按 doc_key（old_key），不按 source —— 跨卷兄弟题共用同一篇文章。
    overrides = _load_material_overrides(Path(assets_dir).parent)

    for members in groups.values():
        canonical = choose_canonical([m.material_text or "" for m in members])
        old_key, _ = write_material_doc(
            canonical, resolver=resolver, store=store,
            assets_dir=Path(assets_dir), subject_code=subject_code,
            paper_scope=paper_scope, dry_run=True,
        )
        override = overrides.get(old_key)
        if override is None and paper_scope:
            # 兼容卷内 key 之前的旧 override（按纯内容 key 记录）。
            legacy_key, _ = write_material_doc(
                canonical, resolver=resolver, store=store,
                assets_dir=Path(assets_dir), subject_code=subject_code, dry_run=True,
            )
            override = overrides.get(legacy_key)
        body = override.get("body") if override else canonical
        reason = material_group_reason(body)
        if reason:
            # 不像文章：保留 material_text 原样，不写文档、不设 URL。
            skipped_items.update(id(m) for m in members)
            skipped.append({
                "source": members[0].source,
                "group_orders": [m.group_order for m in members],
                "reason": reason,
                "excerpt": canonical[:200],
            })
            continue
        key, url = write_material_doc(
            body, resolver=resolver, store=store,
            assets_dir=Path(assets_dir), subject_code=subject_code,
            paper_scope=paper_scope,
        )
        for m in members:
            m.material_url = url
            m.material_text = None
    append_skipped_report(Path(assets_dir).parent / "material_group_skipped.jsonl", skipped)

    # 纯标题的分组：文章不存在，material_text 清掉
    for item in items:
        if item.material_text and is_heading_only(item.material_text):
            item.material_text = None

    # 题中素材（必须在文章分组之后，否则会覆盖 material_text）
    review: list[dict] = []
    for item in items:
        if id(item) in skipped_items:
            # 被判定「不像文章」的行里，material_text 就是这段可疑文本；
            # 再切题中素材会把它覆盖掉、又没留 URL（数据丢失）。
            continue
        material, rest = split_inline_material(item.content)
        if material:
            item.content = rest
            item.material_text = material
        elif needs_llm(item.content):
            review.append({"group_order": item.group_order, "content": item.content})
    if review:
        review_path = Path(assets_dir).parent / "material_inline_review.jsonl"
        with review_path.open("a", encoding="utf-8") as f:
            for rec in review:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def externalize_english_materials(
    items,
    *,
    md_images_dir: Path,
    assets_dir: Path,
    store,
    subject_code: str = "english",
    paper_scope: str | None = None,
) -> None:
    """publish 阶段（仅英语）：组二/三/四的共享文章 → md + material_url。

    复用语文的 doc_key / 写文档 / 图片物化；英语特有的只有「哪些组算文章」。
    组五的作文材料留在 material_text（显示在题干下方），不外置。
    """
    groups: dict[str, list] = {}
    for item in items:
        if (item.group_id or "").strip() not in ("二", "三", "四"):
            continue
        text = item.material_text or ""
        if not text.strip() or is_heading_only(text):
            continue
        groups.setdefault(normalize_for_group(text), []).append(item)

    resolver = _resolver_for(Path(md_images_dir))
    for members in groups.values():
        canonical = choose_canonical([m.material_text or "" for m in members])
        _, url = write_material_doc(
            canonical, resolver=resolver, store=store,
            assets_dir=Path(assets_dir), subject_code=subject_code,
            paper_scope=paper_scope,
        )
        for m in members:
            m.material_url = url
            m.material_text = None

    # 只剩标题的材料：文章不存在，清掉（组一/五的普通文本不受影响）
    for item in items:
        if item.material_text and is_heading_only(item.material_text):
            item.material_text = None

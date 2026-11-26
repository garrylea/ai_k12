"""人工校对的现状读取：extracted/published、共享文章、材料路由与 Snapshot。

从 ``manual_fix.py`` 整段搬出（2026-11-26 人工校对重构 Task 2），函数体保持原行为；
唯一有意改动是 ``_current_question`` 同时匹配 ``group_order`` 与 ``sub_no``
（同题号的多小问不能再串位）。``manual_fix`` 用具名 import 把这些名字导回去，
旧流程不受影响。
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

from review_editor import ROOT
from review_queue import _read_jsonl
from subject_codes import subject_code_for_path


_STEM_PREFIX_RE = re.compile(r"^\s*\d{1,2}\s*[.．、:：]\s*")


def split_questions(text: str, strategy) -> list[tuple[int | None, str]]:
    """把一段粘贴按题号拆成多道题；没有题号就整段当一道。

    返回 [(题号 or None, 去掉题号前缀的正文)]。

    注意：配图在题号行上方时，工具**不判断它归谁**——题号上方的图可能是上一题的，
    按位置猜归属会把 18题图 并进 19 题（2026-11-23 用户裁决）。这里只按题号切；
    单题编辑时由 `_one_question_body` 把前置文字仍留在同一题里，绝不丢内容。
    """
    parts: list[tuple[int | None, list[str]]] = []
    cur_no: int | None = None
    cur: list[str] = []
    for line in text.splitlines():
        ok, no = strategy.is_stem(line)
        if ok:
            if cur:
                parts.append((cur_no, cur))
            cur_no, cur = no, [_STEM_PREFIX_RE.sub("", line, count=1)]
        else:
            cur.append(line)
    if cur:
        parts.append((cur_no, cur))
    out = [(no, "\n".join(lines).strip()) for no, lines in parts if "\n".join(lines).strip()]
    return out or [(None, text.strip())]


def _one_question_body(parts: list[tuple[int | None, str]]) -> list[tuple[int | None, str]] | None:
    """整段粘贴里至多只有一个题号时，不要拆出「无题号」的伪题。

    截图 OCR 常把配图/前置说明排在题号行前面。按题号切会切出 `(None, 前置段)` +
    `(19, 正文)` 两条；若两条都落到第 19 题，后一条会覆盖前一条、图就丢了。
    题号至多一个时把整段原样当成这一题（不做归属猜测，也不丢任何行）。

    返回 None 表示不该合并（有 2 个及以上不同题号，按原逻辑逐题拆）。
    """
    numbers = {no for no, _ in parts if no is not None}
    if len(numbers) > 1:
        return None
    if len(parts) <= 1:
        return parts
    no = next(iter(numbers), None)
    body = "\n\n".join(text for _, text in parts if text.strip())
    return [(no, body)]


def split_material_and_options(strategy, body: str) -> tuple[str | None, str, list[dict] | None]:
    """人工录入的一段正文 → (题中材料, 题干, 选项)。

    **语文/英语没有 `split_material`**（它们走跨题 material_policy），
    必须 getattr 判空，否则手工补题在语文卷上直接 AttributeError
    （2026-11-21 海淀模拟二题6 实测：'ChineseStrategy' object has no attribute
    'split_material'）。与 `question_extract._split_inline_material` 同一口径。
    """
    splitter = getattr(strategy, "split_material", None)
    material, rest = splitter(body) if callable(splitter) else (None, body)
    opts_source = rest if material else body
    stem, options = strategy.split_options(opts_source)
    return material, stem, options


def _subject_of(issue: dict) -> str:
    rel = Path(issue["rel_path"])
    return subject_code_for_path(rel, default="") or "generic"


def _current_question(issue: dict) -> dict | None:
    """从 extracted JSONL 取这道题的当前版本（有图/选项才能做保留原图）。

    同时匹配 ``group_order`` 和 ``sub_no``：同一题号下多小问各是独立记录，
    只按题号取会把 (26) 的第 1 问当成第 2 问（2026-11-26）。
    """
    rel = issue.get("rel_path")
    source = issue.get("source")
    if not rel or not source:
        return None
    path = ROOT / "output" / "extracted" / rel / f"{source}.jsonl"
    if not path.exists():
        return None
    go = int(issue.get("group_order") or 0)
    sub = int(issue.get("sub_no") or 0)
    for row in _read_jsonl(path):
        if (int(row.get("group_order") or -1) == go
                and int(row.get("sub_no") or 0) == sub):
            return row
    return None


def _copyable_question_text(issue: dict) -> str:
    """当前题的完整题干 + 选项，供整段拷贝（补题时只想改选项，题干要能原样拷下来）。

    优先取 extracted 里的最新版本（_current_question）；取不到再退回 issue 的 excerpt。
    选项按 label 逐行列全，图片引用原样保留；**不走终端宽度截断**。
    """
    row = _current_question(issue) or {}
    content = (row.get("content") or "").strip()
    options = row.get("options") or []
    if not content:
        return (issue.get("excerpt") or "").strip()
    lines = [content]
    for opt in options:
        label = (opt.get("label") or "").strip()
        text = (opt.get("text") or "").strip()
        if label:
            lines.append(f"{label}. {text}".rstrip())
    # 材料也要让用户看到：文章题的题内素材现在存在 _post_material_text，
    # 漏掉它用户就是「盲修材料」（2026-11-21 用户反馈）。
    article = (row.get("material_text") or "").strip()
    inline = (row.get("_post_material_text") or "").strip()
    if article and inline:
        lines += ["", "[共享文章]", article, "", "[题内素材]", inline]
    elif article:
        lines += ["", "[共享文章]", article]
    elif inline:
        lines += ["", "[题内素材]", inline]
    return "\n".join(lines)


def _published_material_urls(issue: dict) -> list[tuple[int, str]]:
    """同卷已入库题目的 material_url，按题号列出，供补题时人工指认归属。

    只读 published JSONL（入库产物），不连 DB：题号丢了也能靠同卷兄弟题的 URL
    定位到同一篇文章，且不依赖小节标题（小节标题同样会在转换中丢失）。
    URL 去重，保留最小题号那一处作为代表。
    """
    rel, source = issue.get("rel_path"), issue.get("source")
    if not rel or not source:
        return []
    path = ROOT / "output" / "published" / rel / f"{source}.jsonl"
    if not path.exists():
        return []
    by_url: dict[str, int] = {}
    for row in _read_jsonl(path):
        url = row.get("material_url")
        no = row.get("group_order")
        if not url or not isinstance(no, int):
            continue
        if url not in by_url or no < by_url[url]:
            by_url[url] = no
    return sorted((no, url) for url, no in by_url.items())


def _looks_like_article_text(text: str) -> bool:
    """粗判一段文字像不像「整篇文章」（而不是题内小素材）。"""
    from chinese_material_doc import material_group_reason

    t = (text or "").strip()
    if not t:
        return False
    if material_group_reason(t) is not None:
        return False
    if re.search(r"(?m)^\s*#{1,6}\s", t):
        cjk = len(re.findall(r"[\u4e00-\u9fff]", t))
        return cjk >= 40        # 只有标题、正文很短的是「材料一」这类素材，不是文章
    return len(re.findall(r"[\u4e00-\u9fff]", t)) >= 100


def _read_article_body(url: str | None) -> str | None:
    if not url:
        return None
    p = ROOT / "output" / "assets" / url
    try:
        return p.read_text(encoding="utf-8").strip() if p.exists() else None
    except OSError:
        return None


def _article_slots(issue: dict) -> tuple[str | None, str | None]:
    """本题所在文章 (url, 正文)。

    URL 不一定挂在当前题号上：同一篇文章在 published 里去重后只保留**最小题号**
    作为代表（20/22/23 共用 8873 时代表是 20），只按 ``group_order == 本题`` 找
    会得到 None，于是文章被误判成题内素材。这里按正文内容把 URL 认回来。
    """
    from chinese_material_doc import same_article

    row = _current_question(issue) or {}
    text = (row.get("material_text") or "").strip()
    urls = _published_material_urls(issue)
    go = issue.get("group_order")
    exact = next((u for no, u in urls if no == go), None)
    if exact:
        return exact, _read_article_body(exact)
    for _no, url in urls:
        body = _read_article_body(url)
        if body and text and same_article(text, body):
            return url, body
    return None, None


def _question_article(issue: dict) -> str | None:
    """本题所在文章的正文；没有/读不到返回 None。"""
    return _article_slots(issue)[1]


def _article_similarity(a: str | None, b: str | None) -> float:
    """两段文字的相似度（归一化后，忽略标注/空白/图片）。"""
    import difflib

    from chinese_material_doc import normalize_for_group

    x, y = normalize_for_group(a or ""), normalize_for_group(b or "")
    if not x or not y:
        return 0.0
    return difflib.SequenceMatcher(None, x, y).ratio()


def _material_slots(issue: dict) -> dict:
    """把一道题的现有材料拆成「文章槽 / 题内素材槽」，供人工按内容修订。

    用户不需要知道材料存在 md 还是 material_text —— 这里只是让「改哪段」明确。
    **文章与素材按内容区分，不按字段/URL 区分**：URL 丢了、文章被误塞进
    material_text/_post_material_text 时，这里要能按原文认回文章槽，否则同一篇
    文章会被反复当成题内素材写回（2026-11-22 Q21 事故）。
    """
    from chinese_material_doc import same_article

    row = _current_question(issue) or {}
    url, article = _article_slots(issue)
    text = (row.get("material_text") or "").strip()
    inline = (row.get("_post_material_text") or "").strip()
    # 与文章同段的内容一律归文章槽；素材槽只留真正的补充材料。
    if inline and article and same_article(inline, article):
        inline = ""
    if text and article and same_article(text, article):
        text = ""
    if not url:
        if text and _looks_like_article_text(text):
            article = text          # 未外置的整篇 → 仍然走文章槽
            text = ""
        if text:
            # 文本型题目（未外置的短素材）：material_text 就是唯一材料槽
            inline = inline or text
    return {"article_url": url, "article": article, "inline": inline or None}


def _paper_question_rows(issue: dict) -> list[tuple[int, int, str]]:
    """同卷所有题的 (题号, 小问号, 题干)，供「这篇共享材料还给哪些题用」选择。"""
    rel, source = issue.get("rel_path"), issue.get("source")
    if not rel or not source:
        return []
    path = ROOT / "output" / "extracted" / rel / f"{source}.jsonl"
    if not path.exists():
        return []
    out: list[tuple[int, int, str]] = []
    for row in _read_jsonl(path):
        no = row.get("group_order")
        if isinstance(no, int):
            out.append((no, int(row.get("sub_no") or 0),
                        (row.get("content") or "").replace("\n", " ")))
    return sorted(out)


_IMG_REF_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_IMG_PLACEHOLDER_RE = re.compile(r"\[图\s*([1-9]\d*)\]")


def _image_refs(*texts: str) -> list[str]:
    """按出现顺序收集图片引用（去重）。"""
    out: list[str] = []
    for text in texts:
        for m in _IMG_REF_RE.finditer(text or ""):
            ref = m.group(1)
            if ref not in out:
                out.append(ref)
    return out


def _append_missing_images(text: str, refs: list[str]) -> str:
    """把没被新文本引用的原图补到末尾（只改文字、保留原图）。"""
    missing = [r for r in refs if r not in text]
    if not missing:
        return text
    return text.rstrip() + "\n\n" + "\n".join(f"![]({r})" for r in missing)


def _apply_image_placeholders(text: str, refs: list[str]) -> str:
    """把正文里的 `[图1]`/`[图2]` 换成图片引用；没用到的追加到末尾。"""
    used = [False] * len(refs)

    def repl(m: re.Match) -> str:
        idx = int(m.group(1)) - 1
        if 0 <= idx < len(refs):
            used[idx] = True
            return f"![]({refs[idx]})"
        return m.group(0)

    text = _IMG_PLACEHOLDER_RE.sub(repl, text)
    rest = [r for i, r in enumerate(refs) if not used[i] and r not in text]
    if rest:
        text = text.rstrip() + "\n\n" + "\n".join(f"![]({r})" for r in rest)
    return text


def _repair_original(issue: dict) -> str | None:
    """取自动修复前的完整原文。

    issue 的 excerpt 被 recognition_scan._excerpt 截到 600 字，不能直接拿来恢复；
    完整原文只在 labeling_issues.jsonl 的 original_content 里。
    """
    path = ROOT / "output" / "labeling_issues.jsonl"
    if not path.exists():
        return None
    source, go = issue.get("source"), issue.get("group_order")
    for rec in _read_jsonl(path):
        if rec.get("source") != source or rec.get("group_order") != go:
            continue
        regen = (rec.get("regenerated") or {}).get("content") or ""
        original = (rec.get("original_content") or "").strip()
        if original and regen and len(regen) < len(original) * 0.7:
            return original
    return None


@dataclass
class Snapshot:
    content: str = ""
    options: list[dict] = field(default_factory=list)
    answer: str = ""
    article_url: str | None = None
    article: str | None = None
    inline: str | None = None
    images: list[str] = field(default_factory=list)
    repair_original: str | None = None


def snapshot(issue: dict, *, load_repair: bool = False) -> Snapshot:
    row = _current_question(issue) or {}
    slots = _material_slots(issue)
    opts = row.get("options") or []
    images = _image_refs(
        row.get("content") or "",
        row.get("material_text") or "",
        row.get("_post_material_text") or "",
        *(str((o or {}).get("text") or "") for o in opts),
    )
    return Snapshot(
        content=(row.get("content") or "").strip(),
        options=opts,
        answer=(row.get("answer") or "").strip(),
        article_url=slots["article_url"],
        article=slots["article"],
        inline=slots["inline"],
        images=images,
        repair_original=_repair_original(issue) if load_repair else None,
    )


def editable_body(snap: Snapshot) -> str:
    """把 Snapshot 拼成可编辑的 Markdown（题干 + 选项 + 非外置文章 + 题内素材）。

    外置共享文章不拼进来：那是另一份文档，改题干时会把它整篇当正文写回去。
    """
    lines = [(snap.content or "").strip()]
    for opt in snap.options or []:
        label = str((opt or {}).get("label") or "").strip()
        text = str((opt or {}).get("text") or "").strip()
        if label:
            lines.append(f"{label}. {text}".rstrip())
    if not (snap.article_url or "").strip():
        article = (snap.article or "").strip()
        if article:
            lines += ["", article]
    inline = (snap.inline or "").strip()
    if inline:
        lines += ["", inline]
    return "\n".join(lines).strip()

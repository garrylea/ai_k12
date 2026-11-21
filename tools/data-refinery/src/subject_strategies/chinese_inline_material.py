"""语文题中素材切分：题号之内、这道题自己带的补充材料。

与 `material_split`（物理/化学题内材料）的区别：语文的题中材料通常由
「联系/阅读/结合…下面材料」引导，且常带 `注：①…` 注释块；没有 (1)(2) 小问。

只做确定性规则，不调 LLM。规则切不动的题由 publish/回填写 review 清单，
交给 `chinese_inline_material_cli.py` 用 LLM 判切点后回写。
"""

from __future__ import annotations

import re

LEAD_RE = re.compile(
    r"(?:联系|结合|阅读|参考|请阅读|请结合)[^\n。]{0,30}?"
    r"(?:下面|上述|以上|以下)[^\n。]{0,10}?"
    r"(?:材料|语段|文字|短文|诗句|文章)"
)
NOTE_RE = re.compile(r"(?m)^\s*注\s*[:：]")
# 只认「①词条：释义」形态，避免把题干里的「“ ①”」「“ ② ”」占位符当成注条目。
NOTE_ITEM_RE = re.compile(r"[①-⑳][^①-⑳\s]{0,12}[：:]")
LINK_MARK_RE = re.compile(r"【链接材料】|材料\s*[:：]")
QUESTION_LEAD_RE = re.compile(r"^(?:结合|根据|请|谈谈|说说|分析|概括|说明|简要)")
MIN_CONTENT_LEN = 80
MIN_MATERIAL_LEN = 60


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _cut_after_note(content: str) -> int | None:
    """注块切点：最后一个 ①–⑳ 条目之后的第一个「」。"""
    m = NOTE_RE.search(content)
    if not m:
        return None
    tail = content[m.end():]
    items = list(NOTE_ITEM_RE.finditer(tail))
    if not items:
        return None
    end = tail.find("。", items[-1].end())
    if end < 0:
        return None
    return m.end() + end + 1


def _split_by_note(content: str) -> tuple[str, str] | None:
    cut = _cut_after_note(content)
    if cut is None:
        return None
    material = content[:cut].rstrip()
    rest = content[cut:].lstrip("\n ")
    # 注独占一行（只影响展示；自校验按空白归一）
    material = NOTE_RE.sub(lambda m: "\n" + m.group(0).lstrip(), material, count=1)
    if len(_norm(material)) < MIN_MATERIAL_LEN or not rest.strip():
        return None
    return material.strip(), rest


def _split_by_link_marker(content: str) -> tuple[str, str] | None:
    """【链接材料】/材料:：取到最后一个以设问开头的段落之前。

    裸 `材料：` 只有在同时命中引导语（联系/阅读/结合…下面材料）时才切；
    否则任何提到「材料：」的题干都会被误切成材料。`【链接材料】` 可独立命中。
    """
    if not LINK_MARK_RE.search(content):
        return None
    if "【链接材料】" not in content and not LEAD_RE.search(content):
        return None
    paras = content.split("\n\n")
    if len(paras) < 2:
        return None
    last = paras[-1].strip()
    if not last or not QUESTION_LEAD_RE.match(last):
        return None
    cut = content.rfind(last)
    material = content[:cut].rstrip()
    rest = content[cut:]
    if len(_norm(material)) < MIN_MATERIAL_LEN:
        return None
    return material, rest


def split_inline_material(content: str) -> tuple[str | None, str]:
    """返回 (material_text, rest)；不切返回 (None, content)。"""
    if not content or len(content) < MIN_CONTENT_LEN:
        return None, content

    by_note = _split_by_note(content)
    if by_note:
        material, rest = by_note
        if _norm(material) + _norm(rest) == _norm(content):
            return material, rest
        return None, content

    by_link = _split_by_link_marker(content)
    if by_link:
        material, rest = by_link
        if _norm(material) + _norm(rest) == _norm(content):
            return material, rest
    return None, content


def needs_llm(content: str) -> bool:
    """规则没切、但看起来像题中材料题 → 值得进 LLM 复核清单。"""
    return bool(content and len(content) >= 200 and LEAD_RE.search(content))

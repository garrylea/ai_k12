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
# 注条目只认「圈号」，不认「圈号+冒号」：真实稿件里既有
# 「①罪废：因获罪被罢官」，也有「③[弄儿]逗小孩。」（方括号、无冒号）。
# 取最后一个圈号 → 其后第一个句号，才能落到注块末尾；逐条匹配会停在中间。
_CIRCLED_RE = re.compile(r"[①-⑳]")
_CIRCLED_ORDER = {ch: i for i, ch in enumerate("①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳")}
# 切点之后仍像注条目的续写 → 说明这个句号不是注块结束，宁可不切。
_NOTE_CONTINUATION_RE = re.compile(
    r'^\s*(?:[①-⑳]|[“"].{0,20}?[”"]\s*[，,]?\s*(?:也指|指|即|意思是)|'
    r"这句是说|意思是|形容|比喻)"
)
LINK_MARK_RE = re.compile(r"【链接材料】|材料\s*[:：]")
QUESTION_LEAD_RE = re.compile(r"^(?:结合|根据|请|谈谈|说说|分析|概括|说明|简要)")
MIN_CONTENT_LEN = 80
MIN_MATERIAL_LEN = 60


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _cut_after_note(content: str) -> int | None:
    """注块切点：最后一个圈号条目之后的第一个「。」；后面不像题目就不切。

    2026-11-21 改：旧实现只把「①词：释义」当条目，遇到 `③[弄儿]逗小孩。`
    这种方括号体例（无冒号）会漏，最后一条被当成 ②，切点落在 ② 释义中间的
    句号上，半截注释变题干（海淀 5677 实测）。改为「最后一个圈号 + 其后第一个
    句号」，再检查切点后的文字是否仍在续写注释（`这句是说`、`“孤”，也指…`）；
    是则返回 None，整段不切 —— 宁可让题干带材料，也不产出错位题干。
    """
    m = NOTE_RE.search(content)
    if not m:
        return None
    tail = content[m.end():]
    # 只取「首尾相接的递增圈号序列」：注块用 ①→⑥，其后题干里的「①」占位
    # 会重新从 ① 开始，不能算进注条目（14 题「唯有“ ①”…在于 ③」实测）。
    marks = []
    expected = None
    for mm in _CIRCLED_RE.finditer(tail):
        idx = _CIRCLED_ORDER.get(mm.group(0))
        if idx is None:
            continue
        if expected is None or idx == expected:
            marks.append(mm)
            expected = idx + 1
        else:
            break
    if not marks:
        return None
    end = tail.find("。", marks[-1].end())
    if end < 0:
        # 最后一条没有句号：到本段末尾；rest 为空时调用方会放弃切分
        nl = tail.find("\n", marks[-1].end())
        return m.end() + (nl if nl >= 0 else len(tail))
    cut = m.end() + end + 1
    if _NOTE_CONTINUATION_RE.match(content[cut:]):
        return None
    return cut


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

"""语文题中素材切分：题号之内、这道题自己带的补充材料。

与 `material_split`（物理/化学题内材料）的区别：语文的题中材料通常由
「联系/阅读/结合…下面材料」引导，且常带 `注：①…` 注释块；没有 (1)(2) 小问。

只做确定性规则，不调 LLM。规则切不动的题由 publish/回填写 review 清单，
交给 `chinese_inline_material_cli.py` 用 LLM 判切点后回写。
"""

from __future__ import annotations

import re

LEAD_RE = re.compile(
    r"(?:联系|结合|阅读|参考|请阅读|请结合|根据|依据)[^\n。]{0,30}?"
    r"(?:下面|上述|以上|以下)[^\n。]{0,10}?"
    r"(?:材料|语段|文字|短文|诗句|文章|文段)"
)
# 注块行首标记：`注：` / `注释：` / `[注释]` / `【注释】` / `[注]` / `【注】`。
# 2026-11-21 补：此前只认 `注：`，西城模拟二 Q15 的 `[注释]`、陈经纶的
# `【注释】`、海淀期中的 `[注]` 全部漏切，材料连注释一起并进题干。
NOTE_RE = re.compile(
    r"(?m)^[ \t]*(?:"
    r"[\[【]\s*注\s*释?\s*[\]】]"
    r"|注\s*释?\s*[:：]"
    r")"
)
# 注条目只认「圈号」，不认「圈号+冒号」：真实稿件里既有
# 「①罪废：因获罪被罢官」，也有「③[弄儿]逗小孩。」（方括号、无冒号）。
# 取最后一个圈号 → 其后第一个句号，才能落到注块末尾；逐条匹配会停在中间。
_CIRCLED_RE = re.compile(r"[①-⑳]")
_CIRCLED_ORDER = {ch: i for i, ch in enumerate("①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳")}
# 切点之后仍像注条目的续写 → 说明这个句号不是注块结束，宁可不切。
_NOTE_CONTINUATION_RE = re.compile(
    r'^\s*(?:[①-⑳]|[“"].{0,20}?[”"]\s*[，,]?\s*(?:也指|指|即|意思是|意思为)|'
    r"这句是说|意思是|意思为|意即|形容|比喻)"
)
# 「答:」这类答题脚手架不能当语段（否则材料=题干、content 只剩「答:」）。
_REST_SCAFFOLD_RE = re.compile(r"^(?:答|答案|示例|我选|解|分析)\s*[:：]?\s*$")
LINK_MARK_RE = re.compile(r"【链接材料】|材料\s*[:：]")
QUESTION_LEAD_RE = re.compile(r"^(?:结合|根据|请|谈谈|说说|分析|概括|说明|简要)")
MIN_CONTENT_LEN = 80
MIN_MATERIAL_LEN = 60


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _cut_after_note(content: str) -> int | None:
    """注块切点：优先落在「注释块真正结束」的位置，绝不贪进后面的语段。

    2026-11-21 重写（原实现有三类错位，均真实稿件实测）：
    - 末条注没有句号时（陈经纶「④数：多次」后直接换行），旧代码一路找到语段里
      的第一个「。」，把半句语段切进材料 → 改为「换行早于句号就取换行」；
    - 单条无圈号注（海淀期中 `[注] 阻风：……`）没有 ①②③，旧代码把语段里的
      ①②③④ 当成注条目 → 改为无圈号时只切到注记行末；
    - 语段正好以「“X”指…」开头时，句号后的续写守卫会误判成注的续写（35中
      「“内核稳定”指…」）→ 句号后是换行就是干净块边界，不做续写守卫。

    仍只取「首尾相接的递增圈号序列」：注块用 ①→⑥，其后语段的「①」占位会重新
    从 ① 开始，不能算进注条目。判不准时返回 None —— 宁可让题干带材料，也不
    产出错位题干。
    """
    m = NOTE_RE.search(content)
    if not m:
        return None
    tail = content[m.end():]
    # 注块圈号必须紧跟在注释标记后（≤15 字）；否则是语段里的 ①②③ 占位符。
    circled = list(_CIRCLED_RE.finditer(tail))
    if not circled or circled[0].start() > 15:
        # 单条注 / 无圈号注：切到注记这一行/这一句结束（取换行与句号的更早者）。
        nl = tail.find("\n")
        period = tail.find("。")
        ends = [e for e in (nl, period) if e >= 0]
        if not ends:
            return None
        first = min(ends)
        cut = m.end() + first + (1 if first == period else 0)
        # 守卫：无圈号时只认短注（一行释义），避免把整段正文当注块。
        if len(_norm(content[m.end():cut])) > 60:
            return None
        return cut

    marks = []
    expected = None
    for mm in circled:
        idx = _CIRCLED_ORDER.get(mm.group(0))
        if idx is None:
            continue
        if expected is None or idx == expected:
            marks.append(mm)
            expected = idx + 1
        else:
            break

    after = marks[-1].end()
    period = tail.find("。", after)
    nl = tail.find("\n", after)
    # 换行早于（或没有）句号 → 注块在这一行结束，不贪到语段里的句号。
    if nl >= 0 and (period < 0 or nl < period):
        return m.end() + nl
    if period < 0:
        return None  # 既无句号也无换行：保守不切
    cut = m.end() + period + 1
    # 只有「句号后同一行还接着写」才可能是注的续写；句号后换行 = 干净块边界。
    if not content[cut:].startswith("\n") and _NOTE_CONTINUATION_RE.match(content[cut:]):
        return None
    return cut


# 首段单独是「做题要求」：引导语 + 分值，其后才是「材料 + 注释 + 填充语段」。
# 2026-11-21 用户裁决：做题要求才是题干(content)，其余全部进 material_text。
# 西城模拟二 Q15 / 八中《醉翁亭记》Q14 / 西城 2026 模拟二是同一形态。
_LEAD_PARA_RE = re.compile(
    r"^(?:根据|联系|结合|阅读|参考|依据)[^\n]{0,40}?"
    r"(?:下面|上述|以上|以下)[^\n]{0,10}?"
    r"(?:材料|语段|文字|短文|文章|文段)[^\n]*?[（(]\s*\d+\s*分\s*[）)]\s*$"
)


def _split_lead_as_stem(content: str) -> tuple[str, str] | None:
    """首段做题要求 → (其余全文作 material_text, 首段作 content)。

    优先于注释块规则：旧规则把「引导语 + 材料 + 注释」整段给 material_text，
    把填充语段当题干，页面上就变成「语段在上、要求在下」。这里反过来：
    首段做题要求作题干，材料 + 注释 + 填充语段一起进 material_text，
    配合前端「material_text 在题干下方」的固定规则，顺序与原卷一致。
    """
    first, *tail = content.split("\n")
    if not _LEAD_PARA_RE.match(first.strip()):
        return None
    material = "\n".join(tail).strip()
    if len(_norm(material)) < MIN_MATERIAL_LEN:
        return None
    return material, first.strip()


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
    # 语段只剩「答:」这类答题脚手架 → 这不是真正的后继设问，不切（理工附中Q16）。
    if _REST_SCAFFOLD_RE.match(rest.strip()):
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


# ── 题干在前、材料在后（无注释块）──────────────────────────────────────
# 语文选择题/诗歌题常见：第一段是题干（引用「文段/这段/诗歌/两首诗…」并设问），
# 其后段落才是要读的材料，选项已单独拆出。此前只处理「材料在前、题干在后」，
# 这类整段并进题干（西城模拟二 Q8、首师大 Q13 实测）。
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_STEM_REF_RE = re.compile(
    r"这段|这一段|这段话|这段文字|文段|上文|下面|下列|选文|诗歌|两首诗|这首诗|"
    r"这篇文章|文章|语段|诗|词"
)
_STEM_CUE_RE = re.compile(
    r"的一项是|最恰当|最合适|理解正确|不正确|哪一项|下列说法|分析|概括|赏析|"
    r"谈谈|说说|异同|说明|解释|感受"
)
_STEM_OPTION_LINE_RE = re.compile(r"(?m)^\s*[A-DＡ-Ｄ]\s*[.．、]\s*\S")
# 「A 词前小序…」这种点号被 OCR 丢掉的选项行：字母 + 空格 + 正文（≥3 个不同字母）。
_OPT_LINE_START_RE = re.compile(r"(?m)^\s*([A-DＡ-Ｄ])[.．、]?\s+\S")
_FULLWIDTH_LATIN = {"Ａ": "A", "Ｂ": "B", "Ｃ": "C", "Ｄ": "D"}
_STEM_BLANK_RE = re.compile(r"_{2,}|\\_|＿{2,}|<u>|【\s*】")
_STEM_LEAD_RE = re.compile(r"^(?:请|结合|根据|分析|概括|简述|说说|谈谈|下列|以[^\n]{0,12}为题)")


def _cjk_len(text: str) -> int:
    return len(_CJK_RE.findall(text or ""))


def _looks_like_option_block(text: str) -> bool:
    """≥3 个不同字母打头的行（A/B/C/D，空格分隔也算）→ 这是选项块，不是材料。"""
    letters = {_FULLWIDTH_LATIN.get(m.group(1), m.group(1))
               for m in _OPT_LINE_START_RE.finditer(text or "")}
    return len(letters) >= 3


def _split_stem_then_material(content: str) -> tuple[str, str] | None:
    """题干在前、材料在后且无后续语段：返回 (题干, 材料)；判不准返回 None。

    只在信号很强时切，宁可漏切交复核：
    - 首段同时有「材料指代」（这段/文段/诗歌/两首诗…）与「设问词」；
    - 其余段落像正文（汉字≥60、无选项行、无填空线、不以设问引导开头）。
    """
    paras = [p.strip() for p in content.split("\n") if p.strip()]
    if len(paras) < 2:
        return None
    stem, passage = paras[0], "\n".join(paras[1:])
    if not _STEM_REF_RE.search(stem) or not _STEM_CUE_RE.search(stem):
        return None
    if _cjk_len(passage) < 60:
        return None
    if _STEM_OPTION_LINE_RE.search(passage) or _looks_like_option_block(passage):
        return None
    if _STEM_BLANK_RE.search(passage):
        return None
    if _STEM_LEAD_RE.match(passage):
        return None
    return stem, passage


def split_inline_material(content: str) -> tuple[str | None, str]:
    """返回 (material_text, rest)；不切返回 (None, content)。

    顺序：做题要求首段（题干）→ 注释块 → 链接材料标记 → 题干在前材料在后。
    第一种切点 material=其余全文、rest=首段（拼回顺序 rest+material，单独校验）；
    第二/三种切点在「材料之后」，末者材料在「题干之后」，后两者 material/rest 需对调。
    """
    if not content or len(content) < MIN_CONTENT_LEN:
        return None, content

    # 做题要求首段：material=其余全文、rest=首段，拼回去是 rest + material，
    # 与下面几种切点的 material + rest 相反，故单独按该顺序自校验。
    lead = _split_lead_as_stem(content)
    if lead:
        material, rest = lead
        if _norm(rest) + _norm(material) == _norm(content):
            return material, rest

    for splitter in (_split_by_note, _split_by_link_marker):
        result = splitter(content)
        if result:
            material, rest = result
            if _norm(material) + _norm(rest) == _norm(content):
                return material, rest

    stem_first = _split_stem_then_material(content)
    if stem_first:
        stem, passage = stem_first
        if _norm(stem) + _norm(passage) == _norm(content):
            return passage, stem
    return None, content


def needs_llm(content: str) -> bool:
    """规则没切、但看起来像题中材料题 → 值得进 LLM 复核清单。"""
    return bool(content and len(content) >= 200 and LEAD_RE.search(content))

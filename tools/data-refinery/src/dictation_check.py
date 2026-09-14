"""语文默写管线：正文自检（纯函数，不碰网络与数据库）。

分两档，语义不同：
- errors        → 致命，该篇 verified 置 0，**不进 JSONL**，进「待人工处理」报告
- needs_review  → 不致命，仅提高人工复核优先级（**不落库**，只出现在产物与清单里）

为什么要有 needs_review：教材页是扫描图，MinerU OCR 对生僻字可能认错，而文言文里
生僻字不少。本管线**无法自动消除**这类错误——此处只做「把可疑篇目挑出来让人先看」。
已实现的代理信号是「正文含 CJK 基本区（U+4E00–U+9FFF）之外的汉字」——那是最经典的
OCR 出错面。

**已知局限（不可静默忽略）**：这条检查只覆盖基本区**之外**的汉字，所以基本区内的
生僻字（如「谪」「滕」「属」）**不会**被挑出来。要覆盖它需要频率表，本管线没有；
此处不额外编造字表，也不假装已覆盖。

另有两个来自实测的版面残留错误（原设计的标记清单抓不到）：正文含 ``$``（``$^{②}$``
角标未被 normalize_body 删净）与含竖线 ``|``／``｜``（页码页脚混入，实测全书仅 2 行，
但必须响亮失败而非静默入库）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from dictation_locate import ci_pattern_of

# 注释体例标记：出现在正文里说明切多了（把注释切进正文）
_ANNOTATION_MARKS = ("注释", "其：", "〔", "〕", "题解", "【注释】")

# 各体裁正文长度下限（去标点后的字数）
CHECK_MIN_LEN: dict[str, int] = {"shi": 20, "ci": 20, "qu": 20, "wen": 30, "other": 20}

# 五言/七言绝句与律诗的常见字数：声明为诗但字数不在其中 → 提示复核
REGULATED_SHI_LENS: set[int] = {20, 28, 40, 56}

_PUNCT_RE = re.compile(r"[，。！？；：、（）《》〈〉“”‘’\s]")
#: 连续「非标点、非空白」的汉字串。中/文言文的句子再长也有句读断开，
#: 连续 30 字无标点即为异常（实测九上邹忌混入 ~260 字繁体无标点文字块）。
NO_PUNCT_RUN_MIN = 30
_NO_PUNCT_RUN_RE = re.compile(r"[^，。！？；：、（）《》〈〉“”‘’\s]{30,}")
# CJK 基本区；之外的汉字（扩展 A/B/C…）视为可疑生僻字
_HAN_IN_BASIC_RE = re.compile(r"[\u4e00-\u9fff]")
_HAN_ANY_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0003ffff]")


@dataclass
class CheckResult:
    errors: list[str] = field(default_factory=list)
    needs_review: bool = False
    review_reasons: list[str] = field(default_factory=list)


def _char_count(body: str) -> int:
    """去标点与空白后的字数。"""
    return len(_PUNCT_RE.sub("", body))


def check_body(body: str, work_title: str, genre: str, chrome: set[str]) -> CheckResult:
    """对一篇正文做自检。chrome 为该书运行页眉集合（来自 compute_book_chrome）。"""
    r = CheckResult()

    if not body.strip():
        r.errors.append("正文为空")
        return r

    if _char_count(body) < CHECK_MIN_LEN.get(genre, CHECK_MIN_LEN["other"]):
        r.errors.append(f"正文过短（{_char_count(body)} 字，低于 {genre} 的下限）")

    for mark in _ANNOTATION_MARKS:
        if mark in body:
            r.errors.append(f"正文含注释体例标记「{mark}」，疑似切多")

    # 版面／标记残留（实测新增，原清单抓不到）：$ 说明 `$^{①}$` 角标没删净；
    # 竖线说明页码页脚混了进来（实测全书仅 2 行，属兜底）。
    if "$" in body:
        r.errors.append("正文含 $（行内注释角标未删净）")
    if "|" in body or "｜" in body:
        r.errors.append("正文含竖线 |／｜（页码页脚残留）")

    # 图片语法：正文里绝不该有 markdown 图片（实测 page_061 的图片行会落进正文区间）
    if "![" in body or "](" in body:
        r.errors.append("正文含 markdown 图片语法（版面元素混入）")

    # 括号配平：文言/诗词正文里编辑性括号极少。配平不上说明有注释碎片混入——
    # 实测醉翁亭记的注释 ⑤ **起始行在 OCR 里丢失**，只剩续行「起）像鸟张开翅膀…」，
    # 带一个落单的 ）；浅切按设计抓不到它，靠这条兜住（判错 → 进人工复核，不静默）。
    for left, right, label in (("（", "）", "圆括号"), ("〔", "〕", "六角括号"), ("【", "】", "方头括号")):
        if body.count(left) != body.count(right):
            r.errors.append(
                f"正文{label}不配平（{left}×{body.count(left)} vs {right}×{body.count(right)}），疑似注释碎片混入"
            )

    # 篇名检查只看正文**开头**，且**只标复核、不判错**（两种真实情形都必须能入库）：
    # ①《湖心亭看雪》正文里本来就含篇名（末段「独往湖心亭看雪」）——substring 会误杀正确正文；
    # ②《十五从军征》的首行**就是篇名本身**（该诗题目为后人所加）——「开头出现篇名」对它是正常现象。
    # 故留作 needs_review：人工能看见「疑似把标题切进了正文」，但不阻断入库。
    if work_title and work_title in body[: len(work_title) + 6]:
        r.needs_review = True
        r.review_reasons.append(f"正文开头出现篇名「{work_title}」，疑似把标题切进了正文")

    for line in chrome:
        if line and line in body:
            r.errors.append(f"正文含页眉/版式残留「{line}」")
            break

    # —— 以下只提高复核优先级，不判错 ——
    for ch in _HAN_ANY_RE.findall(body):
        if not _HAN_IN_BASIC_RE.match(ch):
            r.needs_review = True
            r.review_reasons.append(f"含基本区外汉字「{ch}」（可能是 OCR 认错，也可能是真生僻字）")
            break

    if genre == "shi" and _char_count(body) not in REGULATED_SHI_LENS:
        r.needs_review = True
        r.review_reasons.append(
            f"声明为诗但字数 {_char_count(body)} 不在绝句/律诗常见字数 {sorted(REGULATED_SHI_LENS)} 内"
            "（古体诗属正常，请人工确认）"
        )

    # 词的格律**判错**（不是复核）：词牌字数是有定数的，对不上就是切错了。
    # 这条是「程序切不出来的篇目」的**确定性出口**——典型是《沁园春·雪》：
    # 教材把上半阙/写作背景/下半阙/课后题**逐行插花**，任何连续子串都取不到正确的词，
    # 表现为正文把编者说明与课后题一起吞进来（实测 376 字 vs 词牌 114 字）。
    # 判错 → 调用方转 `dictation_repair` 让模型重写（用户 2026-09-14 裁决的路径）+ 人工过目。
    if genre == "ci":
        pattern = ci_pattern_of(work_title)
        if pattern and _char_count(body) != pattern:
            r.errors.append(
                f"词牌正体 {pattern} 字，实际 {_char_count(body)} 字"
                "（正文可能混入了编者说明/课后题，或切多切少）"
            )

    # 连续长串无标点：实测《邹忌讽齐王纳谏》（九上）正文中间混进了一段**繁体、无标点**的文字
    # （`美於徐公今齊地方百二十城宮婦左右莫不私王…`，约 260 字，来自插图/书法页的 OCR），
    # 而它不含 `$`、不含括号、长度也在下限之上，原有检查全都放过了。
    # 中/文言文的句子再长也会有 `，。；：` 断开，连续 30 字无标点是极强的异常信号。
    match = _NO_PUNCT_RUN_RE.search(body)
    if match:
        r.errors.append(
            f"正文含连续 {len(match.group(0))} 字无标点（疑似混入插图/书法页的文字块）："
            "…" + match.group(0)[:20] + "…"
        )

    return r

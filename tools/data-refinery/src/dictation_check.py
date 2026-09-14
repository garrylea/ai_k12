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

# 注释体例标记：出现在正文里说明切多了（把注释切进正文）
_ANNOTATION_MARKS = ("注释", "其：", "〔", "〕", "题解", "【注释】")

# 各体裁正文长度下限（去标点后的字数）
CHECK_MIN_LEN: dict[str, int] = {"shi": 20, "ci": 20, "qu": 20, "wen": 30, "other": 20}

# 五言/七言绝句与律诗的常见字数：声明为诗但字数不在其中 → 提示复核
REGULATED_SHI_LENS: set[int] = {20, 28, 40, 56}

_PUNCT_RE = re.compile(r"[，。！？；：、（）《》〈〉“”‘’\s]")
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

    # 篇名检查只看正文**开头**：篇名出现在前 len(篇名)+6 字内，才说明「把标题切进了正文」。
    # 不能只做 substring 判断——实测《湖心亭看雪》正文里本来就含篇名（末段「独往湖心亭看雪」），
    # substring 会把一篇完全正确的正文误杀、让它永远进不了题库。+6 是给前导的
    # 「N 」编号/书名号/换行留余量。
    if work_title and work_title in body[: len(work_title) + 6]:
        r.errors.append(f"正文开头出现篇名「{work_title}」，疑似把标题切进了正文")

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

    return r

"""语文默写管线：按锚点从教材 MD 中切片出正文（纯函数，不碰网络与数据库）。

设计要点：起点用「正文首句」、终点用「正文末句」，两端都**包含**。
末句锚点必在正文之内，故取到它为止天然排除了其后可能出现的注释；
不依赖「注释」这个字面标记（并非每篇都有）。
"""

from __future__ import annotations

import re

_WS_RE = re.compile(r"\s+")


def join_pages(texts: list[str]) -> str:
    """把同一单元的页文本按页序拼成一整段，便于跨页篇目的锚点定位。"""
    return "\n".join(texts)


def slice_body(full_text: str, start_anchor: str, end_anchor: str) -> str | None:
    """取「start_anchor 起、到 end_anchor 止」的原始字符（含两端锚点）。

    任一锚点为空或找不到 → 返回 None。调用方据此判为「未定位」并送人工处理，
    **不做兜底猜测**（宁可漏一篇让人看，也不要把注释或下一篇课文混进正文）。
    """
    if not start_anchor or not end_anchor:
        return None
    start = full_text.find(start_anchor)
    if start < 0:
        return None
    tail = full_text[start:]
    # 末句锚点只在首句锚点之后搜索：避免正文内重复出现的句子（如标题重复）把区间截断
    end = tail.find(end_anchor, len(start_anchor))
    if end < 0:
        return None
    return tail[: end + len(end_anchor)]


#: 行内注释角标：实测九上 79/170 页的正文含 `$^{①}$` 这类指向注释的标记（如
#: 「崇祯五年 $^{②}$ 十二月」）。它不是正文，必须删掉，否则入库正文夹带 `$^{②}$` 垃圾。
_INLINE_MARKER_RE = re.compile(r"\$\^\{[^}]*\}\$")


def normalize_body(raw: str) -> str:
    """规范化正文：**先删行内注释角标，再收空白**；**保留全部标点与全角符号**。

    顺序不可颠倒：实测所有「汉字-空格-汉字」都由被删角标留下（`春和景 $^{⑰}$ 明`），
    若先收空白会把角标与正文粘在一起、更难清理。
    标点只在判题时被忽略（normalizeChineseAnswer），存储保留原文便于展示。
    """
    return _WS_RE.sub("", _INLINE_MARKER_RE.sub("", raw))

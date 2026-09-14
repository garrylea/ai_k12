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
    # tail 已保证不回退到首句之前；这里 offset 的**真正用途**是：当末句锚点恰好嵌在首句
    # 锚点内部时（嵌套），带 offset 才会判为「找不到」→ 返回 None（宁可送人工，也不切出
    # 一个被截断的正文）。不要因为「tail 已经限制了范围」就把 offset 删掉。
    end = tail.find(end_anchor, len(start_anchor))
    if end < 0:
        return None
    return tail[: end + len(end_anchor)]


#: 行内注释角标：实测九上 79/170 页的正文含 `$^{①}$` 这类指向注释的标记（如
#: 「崇祯五年 $^{②}$ 十二月」）。它不是正文，必须删掉，否则入库正文夹带 `$^{②}$` 垃圾。
_INLINE_MARKER_RE = re.compile(r"\$\^\{[^}]*\}\$")


def normalize_body(raw: str) -> str:
    """规范化正文：**先删行内注释角标，再收空白**；**保留全部标点与全角符号**。

    实测量到：「汉字-空格-汉字」都由被删角标留下（`春和景 $^{⑰}$ 明`）。
    就当前角标正则（不含空白）而言，两条操作**其实可交换**——实测 170 页里没有一页
    结果不同。保持「先删角标」次序是因为：一旦将来角标正则允许内部空白，这个次序
    就成为必需（先收空白会把角标与正文粘连）。**不要**据此认为次序无关紧要而调换。
    标点只在判题时被忽略（normalizeChineseAnswer），存储保留原文便于展示。
    """
    return _WS_RE.sub("", _INLINE_MARKER_RE.sub("", raw))


#: 注释式行：行首圈号（①-⑳ 及 ㉑+ 扩展），或含〔…〕（注释与图注都用它）。
#: 实测长文言文每一页是「上半页正文 + 下半页注释」，注释块必须按页切掉，
#: 否则跨页篇目按锚点取原始子串时会把中间各页的注释一起吃进来
#: （实测醉翁亭记 775 字含 〔〕与圈号；切后 584 字干净；对本来干净的篇目零影响）。
_PAGE_ANNOTATION_RE = re.compile(r"^\s*(?:[①-⑳㉑-㉟㊱-㊿]|〔)|〔[^〕]*〕")


def cut_page_annotations(page_text: str) -> str:
    """把**单页**文本从第一行注释式内容起截断（注释都在该页页尾）。

    逐页调用后再 `join_pages`。若某页整页都是注释，截断后为空——无妨，正文不在该页。
    若正文里恰好出现 〔（罕见，〔 多用于注释与图注），会截早、末句锚点找不到 →
    `slice_body` 返回 None → 该篇进人工复核（fail closed，安全方向）。
    """
    lines = page_text.splitlines()
    for i, line in enumerate(lines):
        if _PAGE_ANNOTATION_RE.search(line):
            return "\n".join(lines[:i])
    return page_text

"""英语策略：A–D 四项；阅读理解短文/完形语篇在题号之前，必须挂到题上。

2026-10-30 之前 `attach_material` 只对语文打开，英语阅读理解的短文
根本不会进入 material_text —— 题只剩「What is the passage mainly about?」。
打开后又发现语文的篇章标题判定不认 `A` / `B` 这种单字母标签，
同一大题的第二篇短文会被漏掉、学生拿到的仍是上一篇。

但单字母行有两义：篇章标签（「A」+ 短文）与竖排选项（「A」/ 选项正文 /
「B」/ 选项正文，内核 `_BARE_LINE_RE` 正是为后者写的）。区分办法**向后看**：
从该行往后数到下一个题号之前，若还有第二个裸单字母行，就是选项列表，不是分篇。
不能数整个题号区段——「A 篇 / 题1 竖排选项 / B 篇 / 题2」里 B 所在区段含 5 个
裸字母，会把合法的第二篇判死（题2 拿到 A 篇、B 篇正文被塞进题1）。

竖排选项还有第二个坑：内核跨行分支在 A/B/C 三段都不含图时，把 D 行之后的尾部
内容并进题干、D 变空（数学/语文共用的既有行为，不改内核）；错位选项随后被
`_python_options_complete` 当成「Python 已拆好」静默入库。所以英语在自己的
`split_options` 里先按「字母行 → 正文行」切，拆不成功再委托内核。
"""

import re
from pathlib import Path

from question_splitter import is_main_stem, split_options as split_options_kernel
from subject_strategies.generic import extract_generic_answers
from subject_strategies.types import ExtractedAnswer, MaterialPolicy

_PASSAGE_LABELS = {"A", "B", "C", "D", "E"}

# 竖排选项标记行：整行只有字母，可带 . 、 ． （与内核 `_BARE_LINE_RE` 同义）
_OPTION_LABEL_LINE_RE = re.compile(r"^\s*([A-D])\s*[.、．]?\s*$")


def _bare_label_run(lines, index: int) -> int:
    """从 index 行起（含本行）到下一个题号之前的裸单字母行数。

    只看向后：竖排选项的后一个字母就在下方 1–2 行内，而篇章标签后面是长长一段
    短文、接着才是下一个题号。往回数会把上一题的选项算进来，误杀合法的第二篇。
    """
    count = 0
    for j in range(index, len(lines)):
        text = lines[j].strip()
        if j > index and is_main_stem(text)[0]:
            break
        if text in _PASSAGE_LABELS:
            count += 1
    return count


def _continues_vertical_options(lines, index: int) -> bool:
    """该行是否紧接在一串竖排选项的后一个字母上（C → D）。

    只向后看救不了**最后一项**：D 后面没有第二个字母，下一行就是它的正文，
    看着和「篇章标签 + 短文」一模一样（竖排题的 D 会被当成篇章标签、正文被搬去材料）。
    这里只看最近的上一行裸字母，且必须正好是本题的前一个字母（D 前面是 C）；
    篇章标签 B 的上一行是题1 的 D，不是 A，因此不会被误判（竖排选项的字母
    必然递增一层，跨篇不会）。
    """
    label = lines[index].strip()
    for j in range(index - 1, -1, -1):
        text = lines[j].strip()
        if is_main_stem(text)[0]:
            return False
        if text in _PASSAGE_LABELS:
            return ord(text) == ord(label) - 1
    return False


def _split_vertical_options(content: str) -> tuple[str, list[dict]] | None:
    """竖排布局（「A」独占一行 + 正文行，正文在字母**下方**）按字母行切分。

    成功条件：找得到连续的 A/B/C/D 四个标记行，且四段正文都非空；题干为 A 之前
    的全部内容。内容写在字母**上方**的图选项排版（`内容\\nA\\n内容\\nB…`）里 D
    后面没有正文，D 为空 → 判定失败，交回内核处理。
    """
    lines = content.split("\n")
    marks = [i for i, line in enumerate(lines) if _OPTION_LABEL_LINE_RE.match(line)]
    for pos in range(len(marks) - 3):
        starts = marks[pos:pos + 4]
        labels = [_OPTION_LABEL_LINE_RE.match(lines[i]).group(1) for i in starts]
        if labels != ["A", "B", "C", "D"]:
            continue
        ends = starts[1:] + [len(lines)]
        bodies = ["\n".join(lines[s + 1:e]).strip() for s, e in zip(starts, ends)]
        if not all(bodies):
            continue
        stem = "\n".join(lines[:starts[0]]).strip()
        return stem, [{"label": lab, "text": body} for lab, body in zip(labels, bodies)]
    return None


def _split_options(content: str) -> tuple[str, list[dict] | None]:
    """先按竖排切，拆不出再委托内核（内核行为不动，数学/语文仍走原路径）。"""
    vertical = _split_vertical_options(content)
    return vertical if vertical is not None else split_options_kernel(content)


class EnglishMaterialPolicy(MaterialPolicy):
    def is_material_title(self, lines, index, line):
        """篇章标签（单独一行的 A/B/C/D 或「第一篇」）后紧跟长段落 → 换材料。

        单字母行往后到下一个题号之前还有别的裸字母行，说明是竖排选项列表，
        必须留给 `split_options`。
        """
        text = line.strip()
        if not text:
            return False
        is_label = text in _PASSAGE_LABELS or (
            2 <= len(text) <= 8 and text.startswith("第") and text.endswith("篇"))
        if not is_label:
            return False
        if text in _PASSAGE_LABELS and (
                _bare_label_run(lines, index) > 1
                or _continues_vertical_options(lines, index)):
            return False
        for j in range(index + 1, min(index + 4, len(lines))):
            nxt = lines[j].strip()
            if not nxt:
                continue
            return len(nxt) >= 30 and not is_main_stem(nxt)[0]
        return False

    def looks_like_between_material(self, current_content, line):
        """上一题 A–D 选项已完整时的长段落，归下一题。"""
        text = line.strip()
        if len(text) < 40 or text.startswith(("#", "![", "<table")):
            return False
        # 上一题最后一行是裸选项标记（竖排 D 的正文还没到）：这一句是 D 的正文，
        # 不是下一题材料。否则 D 正文会被搬走、题1 只剩三个选项。
        tail = [ln for ln in current_content.split("\n") if ln.strip()]
        if tail and _OPTION_LABEL_LINE_RE.match(tail[-1]):
            return False
        _, opts = _split_options(current_content)
        return bool(opts) and len(opts) >= 3 and all(o["text"].strip() for o in opts)


class EnglishStrategy:
    code = "english"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return _split_options(content)

    def split_bounds(self) -> tuple[int, int]:
        return (4, 4)

    def choice_bounds(self) -> tuple[int, int]:
        return (4, 4)

    def material_policy(self) -> MaterialPolicy:
        return EnglishMaterialPolicy(attach=True)

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        # 答案与其余学科同一份实现（整卷对齐）；英语目前没有答案段的特殊规则。
        # 仍然显式传 self：答案与题干必须按同一套材料/选项规则切。
        return extract_generic_answers(text, md_path, strategy=self)

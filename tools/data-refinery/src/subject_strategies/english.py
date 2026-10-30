"""英语策略：A–D 四项；阅读理解短文/完形语篇在题号之前，必须挂到题上。

2026-10-30 之前 `attach_material` 只对语文打开，英语阅读理解的短文
根本不会进入 material_text —— 题只剩「What is the passage mainly about?」。
打开后又发现语文的篇章标题判定不认 `A` / `B` 这种单字母标签，
同一大题的第二篇短文会被漏掉、学生拿到的仍是上一篇。

但单字母行有两义：篇章标签（「A」+ 短文）与竖排选项（「A」/ 选项正文 /
「B」/ 选项正文，内核 `_BARE_LINE_RE` 正是为后者写的）。区分办法：数该行
所在「两个题号之间」区段里的裸单字母行数——超过一个就是选项列表，不是分篇。
"""

from pathlib import Path

from question_splitter import is_main_stem, split_options
from subject_strategies.generic import extract_generic_answers
from subject_strategies.types import ExtractedAnswer, MaterialPolicy

_PASSAGE_LABELS = {"A", "B", "C", "D", "E"}


def _bare_label_count(lines, index: int) -> int:
    """index 所在「两个题号之间」的区段里有几个裸单字母行。

    区段 = 上一个题号之后 → 下一个题号之前（两端都不含）。一个区段里出现
    第二个裸字母行，说明这不是分篇，而是一串竖排选项标记（A/B/C/D 各占一行）。
    只看单向不够：竖排选项的**最后一项**后面不会再有第二个字母，必须整段数，
    否则 D 仍会被当成篇章标签、选项正文被搬去材料。
    """
    lo = 0
    for j in range(index - 1, -1, -1):
        if is_main_stem(lines[j].strip())[0]:
            lo = j + 1
            break
    hi = len(lines)
    for j in range(index + 1, len(lines)):
        if is_main_stem(lines[j].strip())[0]:
            hi = j
            break
    return sum(1 for line in lines[lo:hi] if line.strip() in _PASSAGE_LABELS)


class EnglishMaterialPolicy(MaterialPolicy):
    def is_material_title(self, lines, index, line):
        """篇章标签（单独一行的 A/B/C/D 或「第一篇」）后紧跟长段落 → 换材料。

        单字母行只有在整个题号区段里独一份时才算分篇；同段还有别的裸字母行，
        说明是竖排选项列表，必须留给 `split_options`。
        """
        text = line.strip()
        if not text:
            return False
        is_label = text in _PASSAGE_LABELS or (
            2 <= len(text) <= 8 and text.startswith("第") and text.endswith("篇"))
        if not is_label:
            return False
        if text in _PASSAGE_LABELS and _bare_label_count(lines, index) > 1:
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
        _, opts = split_options(current_content)
        return bool(opts) and len(opts) >= 3 and all(o["text"].strip() for o in opts)


class EnglishStrategy:
    code = "english"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content)

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

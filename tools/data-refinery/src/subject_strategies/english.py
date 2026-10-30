"""英语策略：A–D 四项；阅读理解短文/完形语篇在题号之前，必须挂到题上。

2026-10-30 之前 `attach_material` 只对语文打开，英语阅读理解的短文
根本不会进入 material_text —— 题只剩「What is the passage mainly about?」。
打开后又发现语文的篇章标题判定不认 `A` / `B` 这种单字母标签，
同一大题的第二篇短文会被漏掉、学生拿到的仍是上一篇。
"""

from pathlib import Path

from question_splitter import is_main_stem, split_options
from subject_cases.generic import english_answers
from subject_strategies.types import ExtractedAnswer, MaterialPolicy

_PASSAGE_LABELS = {"A", "B", "C", "D", "E"}


class EnglishMaterialPolicy(MaterialPolicy):
    def is_material_title(self, lines, index, line):
        """篇章标签（单独一行的 A/B/C/D 或「第一篇」）后紧跟长段落 → 换材料。"""
        text = line.strip()
        if not text:
            return False
        is_label = text in _PASSAGE_LABELS or (
            2 <= len(text) <= 8 and text.startswith("第") and text.endswith("篇"))
        if not is_label:
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
        return bool(opts) and len(opts) >= 3


class EnglishStrategy:
    code = "english"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content)

    def material_policy(self) -> MaterialPolicy:
        return EnglishMaterialPolicy(attach=True)

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        return english_answers(text, md_path)

"""答案合并/选择：根据内容（非文件名）判断每份文件是否含答案，决定合并或选择。

zgkao 命名反向：'试卷.pdf' 通常是有答案版，'答案.pdf' 通常是无答案版试卷。
文件名只用于配对（识别同一张卷子的两份文件），内容判断由 _has_answer_section/_is_pure_answer 做。
"""

import re
from pathlib import Path
from question_splitter import is_answer_keyword

_SOLUTION_RE = re.compile(r'解[：:]|证明[：:]')
# 选择题选项特征（题干标志）
_CHOICE_OPTION_RE = re.compile(r'\([A-D]\)|（[A-D]）')
# 题干常见词
_STEM_WORD_RE = re.compile(r'如图|下列|下面图形中|下列运算中')


def _has_answer_section(text: str) -> bool:
    """文件是否含答案部分。

    判定：末尾 500 字符内有答案关键字（参考答案/答案/评分参考），
    或全文 '解：/证明：' 出现 ≥5 次（展开格式答案）。
    """
    tail = text[-500:] if len(text) > 500 else text
    if any(is_answer_keyword(line) for line in tail.split('\n')):
        return True
    return len(_SOLUTION_RE.findall(text)) >= 5


def _is_pure_answer(text: str) -> bool:
    """文件是否为纯答案（无题干）。

    纯答案 = 有答案部分 且 无题干特征（无选择题选项、无'如图/下列'等题干词）。
    """
    if not _has_answer_section(text):
        return False
    if _CHOICE_OPTION_RE.search(text):
        return False
    if _STEM_WORD_RE.search(text):
        return False
    return True


def _derive_answer_path(md_path: Path) -> Path:
    """配对：文件名 '-试卷' 替换为 '-答案'（只用于配对，不判断内容）。"""
    return md_path.with_name(md_path.name.replace("-试卷", "-答案"))


def maybe_merge_answer_md(md_path: Path, text: str) -> str:
    """根据两份文件的内容组合，决定合并或选择。

    Args:
        md_path: 试卷 MD 路径（用于配对答案文件）
        text: 试卷 MD 全文

    Returns:
        最终用于 split_page 处理的文本（可能来自试卷文件、答案文件、或合并）
    """
    answer_path = _derive_answer_path(md_path)

    # case 1: 只有一份文件
    if not answer_path.exists():
        return text

    answer_text = answer_path.read_text(encoding="utf-8")
    paper_has = _has_answer_section(text)
    answer_has = _has_answer_section(answer_text)

    # case 2: 两份都有答案 → 留试卷文件，丢弃答案文件
    if paper_has and answer_has:
        return text

    # case 3: 试卷有答案 + 答案文件无答案（纯题干）→ 留试卷，丢弃答案
    if paper_has and not answer_has:
        return text

    # case 4: 试卷无答案 + 答案文件有答案
    if not paper_has and answer_has:
        if _is_pure_answer(answer_text):
            # case 4a: 答案是纯答案 → 合并到试卷末尾
            return text + "\n\n" + answer_text
        # case 4b: 答案是试卷+答案版本 → 用答案文件（它有完整题干+答案），丢弃试卷
        return answer_text

    # case 5: 两份都无答案 → 处理试卷文件（答案留空，做题时大模型补）
    return text

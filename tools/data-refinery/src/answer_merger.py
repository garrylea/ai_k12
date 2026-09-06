"""答案合并检测：试卷 MD 末尾无答案时，找同名"-答案.md"合并到末尾。

用户方案：试卷末尾自带答案就用；没有就找同名答案 MD 合并到末尾统一处理；
都没有则所有题答案留空（做题时大模型补）。
"""

from pathlib import Path
from question_splitter import is_answer_keyword


def maybe_merge_answer_md(md_path: Path, text: str) -> str:
    """若 text 末尾无答案关键字，找同名"-答案.md"合并到末尾。

    Args:
        md_path: 试卷 MD 路径，用于推导答案 MD 路径（文件名"-试卷"替换为"-答案"）
        text: 试卷 MD 全文

    Returns:
        text 本身（若已有答案 or 找不到答案 MD），或合并答案后的全文
    """
    # 若 text 末尾（最后 200 字符）已含答案关键字，无需合并
    tail = text[-200:] if len(text) > 200 else text
    if any(is_answer_keyword(line) for line in tail.split('\n')):
        return text

    # 推导答案 MD 路径：文件名里 "-试卷" 替换为 "-答案"
    answer_path = md_path.with_name(md_path.name.replace("-试卷", "-答案"))
    if not answer_path.exists():
        return text

    answer_text = answer_path.read_text(encoding="utf-8")
    return text + "\n\n" + answer_text

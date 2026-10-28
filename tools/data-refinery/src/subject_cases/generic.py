"""通用学科 case：复用 question_splitter 的整卷切分与答案对齐。

数学/英语/物理/化学/道法共用同一实现（与主管线 extract 行为一致）；
每个学科仍保留独立函数，便于将来单科定制时替换而不影响其他学科。
"""

from pathlib import Path

from question_splitter import split_page

from . import ExtractedAnswer


def extract_answers(text: str, md_path: Path) -> list[ExtractedAnswer]:
    """整卷切分 → 取每题已对齐的答案（空答案原样留空，不猜）。"""
    questions = split_page(text, md_path)
    return [
        ExtractedAnswer(no=q.group_order, answer=(q.answer or "").strip())
        for q in questions
    ]


def math_answers(text: str, md_path: Path) -> list[ExtractedAnswer]:
    return extract_answers(text, md_path)


def english_answers(text: str, md_path: Path) -> list[ExtractedAnswer]:
    return extract_answers(text, md_path)


def physics_answers(text: str, md_path: Path) -> list[ExtractedAnswer]:
    return extract_answers(text, md_path)


def chemistry_answers(text: str, md_path: Path) -> list[ExtractedAnswer]:
    return extract_answers(text, md_path)


def politics_answers(text: str, md_path: Path) -> list[ExtractedAnswer]:
    return extract_answers(text, md_path)

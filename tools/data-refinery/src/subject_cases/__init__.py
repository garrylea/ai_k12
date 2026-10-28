"""按学科分派的答案提取 case。

每个学科一个独立函数（``SUBJECT_CASES``），入口统一为 ``extract_answers(text, md_path)``，
返回 ``ExtractedAnswer`` 列表（按题号升序）。学科之间互不影响：

- ``chinese``：答案段分离 → 标点归一（仅解析用）→ 按题号对齐 → 评分说明拆到解析 → 校验
- ``math`` / ``english`` / ``physics`` / ``chemistry`` / ``politics``：委托 generic
  （复用 question_splitter 的整卷对齐，行为与主管线一致）

新增学科时在对应模块实现 case 函数并登记到 ``SUBJECT_CASES``；未登记学科会明确报错，
不会静默回退到别的学科流程。
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from subject_codes import SUBJECT_NAME_TO_CODE, subject_code_for_parts


@dataclass
class ExtractedAnswer:
    """一题的答案提取结果（no 为印刷题号）。"""
    no: int
    answer: str = ""
    approach: str = ""
    explanation: str = ""
    issues: list[str] = field(default_factory=list)


AnswerExtractor = Callable[[str, Path], list[ExtractedAnswer]]


class UnknownSubjectError(ValueError):
    """学科不在分派表里（明确报错，不猜测）。"""


def detect_subject(rel_path: Path | str) -> str:
    """从素材相对路径首段（中文学科名）识别 subject code。

    识别不了直接抛错——答案提取错学科比失败更危险。
    """
    path = Path(rel_path)
    code = subject_code_for_parts(path.parts, default="")
    if not code:
        raise UnknownSubjectError(
            f"无法从路径识别学科：{path}（支持：{'、'.join(SUBJECT_NAME_TO_CODE)}）"
        )
    return code


def get_case(subject_code: str) -> AnswerExtractor:
    """按 subject code 取提取函数；未支持学科抛 ``UnknownSubjectError``。"""
    from . import chinese, generic

    cases: dict[str, AnswerExtractor] = {
        "chinese": chinese.extract_answers,
        "math": generic.math_answers,
        "english": generic.english_answers,
        "physics": generic.physics_answers,
        "chemistry": generic.chemistry_answers,
        "politics": generic.politics_answers,
    }
    try:
        return cases[subject_code]
    except KeyError as e:
        raise UnknownSubjectError(
            f"学科 {subject_code!r} 暂无答案提取 case（已支持：{'、'.join(cases)}）"
        ) from e

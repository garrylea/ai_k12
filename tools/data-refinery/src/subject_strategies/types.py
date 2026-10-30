"""学科策略的公共类型。

零依赖：不 import question_splitter，避免与内核循环引用。
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class ExtractedAnswer:
    """一题的答案提取结果（no 为印刷题号）。"""
    no: int
    answer: str = ""
    approach: str = ""
    explanation: str = ""
    issues: list[str] = field(default_factory=list)


class UnknownStrategyError(ValueError):
    """学科未登记切题策略（明确报错，不猜测、不回退 generic）。"""


@dataclass(frozen=True)
class MaterialPolicy:
    """题号前 / 两题之间的短文是否归到题目上。

    attach=False 时两个谓词不会被调用；attach=True 时由各学科实现判定规则。
    """

    attach: bool = False

    def is_material_title(self, lines: list[str], index: int, line: str) -> bool:
        return False

    def looks_like_between_material(self, current_content: str, line: str) -> bool:
        return False


NO_MATERIAL = MaterialPolicy()


class QuestionStrategy(Protocol):
    """一个学科的切题策略：四件事各科自己实现。"""

    code: str

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        """该行是否是主题号，返回 (是, 题号)。"""
        ...

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        """题干/选项拆分；拆不出返回 (原 content, None)。"""
        ...

    def split_bounds(self) -> tuple[int, int]:
        """`split_options` 拆出几项才算「拆成功」的闭区间（语文 2–6，其余 4–4）。

        与 `choice_bounds` 是两件事，名字必须区分：这里管「能不能拆」，
        `choice_bounds` 管「拆出来的算不算一道完整的选择题」。
        """
        ...

    def choice_bounds(self) -> tuple[int, int]:
        """选项数落在哪个闭区间才算完整选择题（语文 3–6，其余 4–4）。"""
        ...

    def material_policy(self) -> MaterialPolicy:
        ...

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        """答案段 → 逐题答案；没有答案段返回空列表。"""
        ...

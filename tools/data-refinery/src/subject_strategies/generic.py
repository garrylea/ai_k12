"""通用策略：A–D 四项、无材料归属，仅供显式登记与显式继承。

禁止把它当「未登记学科的兜底」——get_strategy 不认未登记 code。
"""

from pathlib import Path

from question_splitter import is_main_stem, split_options
from subject_strategies.types import ExtractedAnswer, MaterialPolicy, NO_MATERIAL


class GenericStrategy:
    code = "generic"

    def is_stem(self, line: str) -> tuple[bool, int | None]:
        return is_main_stem(line)

    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        return split_options(content)

    def material_policy(self) -> MaterialPolicy:
        return NO_MATERIAL

    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        # Task 6 之前先委托 subject_cases，避免一次性动两处
        from subject_cases.generic import extract_answers as generic_answers
        return generic_answers(text, md_path)
